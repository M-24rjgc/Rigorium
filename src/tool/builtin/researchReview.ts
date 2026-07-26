import {
  createReviewRound,
  createRevisionDecision,
  type AppliedRevisionDecision,
  type ReviewRoundInput,
  type ReviewRoundPackage,
  type RevisionDecisionInput,
} from "../../research/review/index.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";

export type ResearchReviewToolInput =
  | (Readonly<{ action: "run_review" }> & Omit<ReviewRoundInput, "now" | "producer">)
  | (Readonly<{ action: "decide_revision" }> & Omit<RevisionDecisionInput, "now" | "producer">);

export type ResearchReviewToolResult =
  | Readonly<{ action: "run_review"; review: ReviewRoundPackage }>
  | Readonly<{ action: "decide_revision"; revision: AppliedRevisionDecision }>;

export type CreateResearchReviewToolOptions = Readonly<{
  maxResultBytes?: number;
}>;

export function createResearchReviewTool(
  options: CreateResearchReviewToolOptions = {},
): RigoriumToolDefinition<ResearchReviewToolInput, ResearchReviewToolResult> {
  return {
    name: "research_review",
    title: "Run Independent Research Reviews",
    description: `Run deterministic manuscript preflight checks and exactly seven independent review lanes, merge only compatible anchored findings, preserve opposing assessments for adjudication, or record a RevisionDecision that invalidates descendants of explicitly revised artifact roots.

Use action=run_review with the manuscript module's versioned manuscript, render, citation, figure/table, and run artifacts plus one independent report for each method, theory, statistics, evidence, novelty, writing, and target-fit lane. Use action=decide_revision only after the round, resolving every finding as revise, dismiss, or defer. Revise targets must come from that finding's affected artifact references. The tool creates in-memory research artifacts; it does not edit manuscript files, advance a fixed stage machine, contact reviewers, submit papers, or wire itself into the shared tool registry.`,
    kind: "custom",
    inputSchema: researchReviewInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 4_000_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => false,
    validateInput: async (input) => validateInput(input),
    execute: async (input, context) => {
      try {
        return formatOutput(executeAction(input, context));
      } catch (error) {
        throw new RigoriumToolRuntimeError("invalid_tool_input", `Invalid research review action: ${messageOf(error)}`);
      }
    },
  };
}

function executeAction(
  input: ResearchReviewToolInput,
  context: RigoriumToolRuntimeContext,
): ResearchReviewToolResult {
  requireActionInput(input);
  const now = context.now?.();
  const producer = { kind: "tool" as const, toolName: "research_review" };
  if (input.action === "run_review") {
    const { action: _action, ...reviewInput } = input;
    return Object.freeze({
      action: "run_review" as const,
      review: createReviewRound({ ...reviewInput, producer, ...(now === undefined ? {} : { now }) }),
    });
  }
  const { action: _action, ...decisionInput } = input;
  return Object.freeze({
    action: "decide_revision" as const,
    revision: createRevisionDecision({ ...decisionInput, producer, ...(now === undefined ? {} : { now }) }),
  });
}

async function validateInput(input: ResearchReviewToolInput): Promise<RigoriumToolValidationResult> {
  try {
    requireActionInput(input);
    const validationDate = new Date("2000-01-01T00:00:00.000Z");
    const producer = { kind: "tool" as const, toolName: "research_review" };
    if (input.action === "run_review") {
      const { action: _action, ...reviewInput } = input;
      createReviewRound({ ...reviewInput, producer, now: validationDate });
    } else {
      const { action: _action, ...decisionInput } = input;
      createRevisionDecision({ ...decisionInput, producer, now: validationDate });
    }
    return { ok: true, input };
  } catch (error) {
    const issue: RigoriumToolValidationIssue = { path: "$", code: "invalid_schema", message: messageOf(error) };
    return { ok: false, issues: [issue] };
  }
}

function requireActionInput(value: unknown): asserts value is ResearchReviewToolInput {
  if (!isRecord(value) || !["run_review", "decide_revision"].includes(String(value.action))) {
    throw new TypeError("research_review requires a supported action.");
  }
  if (value.action === "run_review"
    && (!value.manuscript || !Array.isArray(value.laneReports))) {
    throw new TypeError("run_review requires manuscript and laneReports.");
  }
  if (value.action === "decide_revision"
    && (!value.reviewRound || !Array.isArray(value.findings)
      || !Array.isArray(value.resolutions) || !Array.isArray(value.artifacts))) {
    throw new TypeError("decide_revision requires reviewRound, findings, resolutions, and artifacts.");
  }
}

function researchReviewInputSchema() {
  return {
    type: "object" as const,
    additionalProperties: true,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["run_review", "decide_revision"] },
      manuscript: { type: "object" },
      renderRun: { type: "object" },
      citationSet: { type: "object" },
      figureTableArtifacts: { type: "array", items: { type: "object" } },
      runAttempts: { type: "array", items: { type: "object" } },
      laneReports: { type: "array", items: { type: "object" } },
      reviewRound: { type: "object" },
      findings: { type: "array", items: { type: "object" } },
      resolutions: { type: "array", items: { type: "object" } },
      artifacts: { type: "array", items: { type: "object" } },
      artifactId: { type: "string" },
    },
  };
}

function formatOutput(result: ResearchReviewToolResult): RigoriumToolExecutionOutput<ResearchReviewToolResult> {
  if (result.action === "run_review") {
    const round = result.review.reviewRound;
    return {
      content: [
        { type: "text", text: [
          "Research review round",
          `Artifact: ${round.artifactId}@${round.revision}`,
          `Status: ${round.payload.status}`,
          `Findings: ${result.review.findings.length}`,
          `Contradictions: ${round.payload.contradictions.length}`,
        ].join("\n") },
        { type: "json", value: result },
      ],
      data: result,
      metadata: {
        action: result.action,
        artifactId: round.artifactId,
        status: round.payload.status,
        findingCount: result.review.findings.length,
      },
    };
  }
  return {
    content: [
      { type: "text", text: [
        "Research revision decision",
        `Artifact: ${result.revision.decision.artifactId}@${result.revision.decision.revision}`,
        `Status: ${result.revision.decision.payload.status}`,
        `Invalidated descendants: ${result.revision.invalidatedArtifactRefs.length}`,
      ].join("\n") },
      { type: "json", value: result },
    ],
    data: result,
    metadata: {
      action: result.action,
      artifactId: result.revision.decision.artifactId,
      status: result.revision.decision.payload.status,
      invalidatedCount: result.revision.invalidatedArtifactRefs.length,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
