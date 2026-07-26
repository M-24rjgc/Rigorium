import {
  assertValidResearchDesignArtifact,
  createResearchBriefArtifact,
  reviseResearchBriefArtifact,
  validateComparisonAgainstPortfolio,
  type CandidatePortfolioArtifact,
  type ChallengeReportArtifact,
  type DecisionRecordArtifact,
  type EvidencePackLink,
  type ResearchBriefArtifact,
  type ResearchBriefBuildInput,
} from "../../research/design/index.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult } from "../protocol/schema.js";
import type { RigoriumToolDefinition, RigoriumToolExecutionOutput } from "../protocol/types.js";

export type ResearchBriefToolInput = Readonly<{
  portfolio: CandidatePortfolioArtifact;
  candidateId: string | null;
  question?: string;
  title?: ResearchBriefBuildInput["title"];
  challengeReport?: ChallengeReportArtifact;
  decisionRecord?: DecisionRecordArtifact;
  evidence?: EvidencePackLink;
  previousBrief?: ResearchBriefArtifact;
}>;

export type CreateResearchBriefToolOptions = Readonly<{
  maxResultBytes?: number;
}>;

export function createResearchBriefTool(
  options: CreateResearchBriefToolOptions = {},
): RigoriumToolDefinition<ResearchBriefToolInput, ResearchBriefArtifact> {
  return {
    name: "research_brief",
    title: "Create or Revise a Research Brief",
    description: `Create a versioned ResearchBrief from a CandidatePortfolio, or revise an existing brief without changing its artifact identity.

Use this after research_design when the question, selected mechanism, evidence references, constraints, or title metadata need to be materialized. A revision increments the envelope revision and links to the prior revision with supersedes. Titles remain mutable metadata and do not affect candidate comparison. Set title.status=confirmed only after the user explicitly confirms the exact title, with explicitConfirmation=true and confirmedBy. This tool does not rename the Project, advance a workflow stage, search literature, or execute experiments.`,
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["portfolio", "candidateId"],
      properties: {
        portfolio: { type: "object" },
        candidateId: { type: ["string", "null"] },
        question: { type: "string" },
        title: { type: "object" },
        challengeReport: { type: "object" },
        decisionRecord: { type: "object" },
        evidence: { type: "object" },
        previousBrief: { type: "object" },
      },
    },
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 1_000_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => false,
    validateInput: async (input): Promise<RigoriumToolValidationResult> => validateInput(input),
    execute: async (input, context) => {
      try {
        const artifact = buildBrief(input, context.now?.());
        return formatOutput(artifact);
      } catch (error) {
        throw new RigoriumToolRuntimeError("invalid_tool_input", `Invalid research brief: ${messageOf(error)}`);
      }
    },
  };
}

function buildBrief(input: ResearchBriefToolInput, now: Date | undefined): ResearchBriefArtifact {
  assertValidResearchDesignArtifact(input.portfolio);
  if (input.challengeReport) assertValidResearchDesignArtifact(input.challengeReport);
  if (input.decisionRecord) {
    assertValidResearchDesignArtifact(input.decisionRecord);
    validateComparisonAgainstPortfolio({ portfolio: input.portfolio, decision: input.decisionRecord });
  }
  if (input.previousBrief) assertValidResearchDesignArtifact(input.previousBrief);
  if (input.previousBrief) {
    return reviseResearchBriefArtifact({
      previous: input.previousBrief,
      portfolio: input.portfolio,
      candidateId: input.candidateId,
      question: input.question,
      title: input.title,
      challengeReport: input.challengeReport,
      decisionRecord: input.decisionRecord,
      evidence: input.evidence,
      producer: { kind: "tool", toolName: "research_brief" },
      now,
    });
  }
  return createResearchBriefArtifact({
    portfolio: input.portfolio,
    candidateId: input.candidateId,
    question: input.question,
    title: input.title,
    challengeReport: input.challengeReport,
    decisionRecord: input.decisionRecord,
    evidence: input.evidence,
    producer: { kind: "tool", toolName: "research_brief" },
    now,
  });
}

function validateInput(input: unknown): RigoriumToolValidationResult {
  try {
    if (!isRecord(input)) throw new TypeError("research_brief input must be an object.");
    buildBrief(input as unknown as ResearchBriefToolInput, new Date("2000-01-01T00:00:00.000Z"));
    return { ok: true, input };
  } catch (error) {
    const issue: RigoriumToolValidationIssue = { path: "$", code: "invalid_schema", message: messageOf(error) };
    return { ok: false, issues: [issue] };
  }
}

function formatOutput(artifact: ResearchBriefArtifact): RigoriumToolExecutionOutput<ResearchBriefArtifact> {
  return {
    content: [
      {
        type: "text",
        text: [
          "Research brief",
          `Artifact: ${artifact.artifactId}@${artifact.revision}`,
          `Candidate: ${artifact.payload.candidateId ?? "none"}`,
          `Status: ${artifact.payload.status}`,
          `Title: ${artifact.payload.title.status}; ${artifact.payload.title.text ?? "untitled"}`,
        ].join("\n"),
      },
      { type: "json", value: artifact },
    ],
    data: artifact,
    metadata: {
      artifactId: artifact.artifactId,
      revision: artifact.revision,
      candidateId: artifact.payload.candidateId,
      titleStatus: artifact.payload.title.status,
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
