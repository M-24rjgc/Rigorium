import { randomUUID } from "node:crypto";
import {
  confirmProvisionalTitle,
  type TitleConfirmationInput,
  type TitleConfirmationResult,
} from "../../research/direction/titleConfirmation.js";
import type { DirectionEvidence } from "../../research/direction/directionAssessment.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolValidationIssue, PilotDeckToolValidationResult } from "../protocol/schema.js";
import type { PilotDeckToolDefinition, PilotDeckToolExecutionOutput } from "../protocol/types.js";

export type ResearchTitleConfirmationArtifact = Readonly<{
  schemaVersion: 1;
  kind: "research_title_confirmation";
  artifactId: string;
  createdAt: string;
  input: TitleConfirmationInput;
  result: TitleConfirmationResult;
}>;

export type CreateResearchTitleConfirmationToolOptions = Readonly<{
  maxResultBytes?: number;
}>;

/**
 * Converts an explicit title decision into a traceable, side-effect-free
 * intent. The caller must perform any Project rename as a separate operation.
 */
export function createResearchTitleConfirmationTool(
  options: CreateResearchTitleConfirmationToolOptions = {},
): PilotDeckToolDefinition<TitleConfirmationInput, ResearchTitleConfirmationArtifact> {
  return {
    name: "research_title_confirm",
    title: "Confirm Research Title",
    description: `Validate a candidate research title against its cited evidence and record whether the user explicitly confirmed it.

Use this only after the conversation has supplied the candidate direction, evidence references, and the user's explicit confirmation when confirmed=true. It never renames a Project, writes Zotero, persists a workflow, or certifies novelty; a ready Project name remains a separate explicit action.`,
    kind: "custom",
    inputSchema: inputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 250_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => false,
    validateInput: async (input): Promise<PilotDeckToolValidationResult> => validateInput(input),
    execute: async (input, context) => {
      let result: TitleConfirmationResult;
      try {
        result = confirmProvisionalTitle(input);
      } catch (error) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `Invalid research title confirmation input: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const artifact: ResearchTitleConfirmationArtifact = {
        schemaVersion: 1,
        kind: "research_title_confirmation",
        artifactId: `research-title-confirmation-${randomUUID()}`,
        createdAt: (context.now?.() ?? new Date()).toISOString(),
        input,
        result,
      };
      return formatOutput(artifact);
    },
  };
}

function inputSchema() {
  return {
    type: "object" as const,
    additionalProperties: false,
    required: ["directionId", "candidateTitle", "evidence"],
    properties: {
      directionId: { type: "string", minLength: 1, maxLength: 180 },
      candidateTitle: { type: "string", minLength: 1, maxLength: 180 },
      neutralTitle: { type: "string", maxLength: 180 },
      confirmed: { type: "boolean" },
      evidence: {
        type: "array",
        maxItems: 48,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "paperId", "role", "statement"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 180 },
            paperId: { type: "string", minLength: 1, maxLength: 180 },
            role: {
              type: "string",
              enum: ["prior_art", "gap", "method", "result", "limitation", "data", "baseline", "evaluation", "ethics", "venue"],
            },
            statement: { type: "string", minLength: 1, maxLength: 1_000 },
            strength: { type: "string", enum: ["direct", "indirect"] },
          },
        },
      },
    },
  };
}

function validateInput(input: unknown): PilotDeckToolValidationResult {
  try {
    if (!isRecord(input)) throw new Error("input must be an object.");
    const normalized = normalizeInput(input);
    confirmProvisionalTitle(normalized);
    return { ok: true, input: normalized };
  } catch (error) {
    const issue: PilotDeckToolValidationIssue = {
      path: "$",
      code: "invalid_schema",
      message: error instanceof Error ? error.message : String(error),
    };
    return { ok: false, issues: [issue] };
  }
}

function normalizeInput(input: Record<string, unknown>): TitleConfirmationInput {
  return {
    directionId: input.directionId as string,
    candidateTitle: input.candidateTitle as string,
    evidence: input.evidence as DirectionEvidence[],
    ...(input.neutralTitle === undefined ? {} : { neutralTitle: input.neutralTitle as string }),
    ...(input.confirmed === undefined ? {} : { confirmed: input.confirmed as boolean }),
  };
}

function formatOutput(
  artifact: ResearchTitleConfirmationArtifact,
): PilotDeckToolExecutionOutput<ResearchTitleConfirmationArtifact> {
  const title = artifact.result.title.text ?? "no title accepted";
  return {
    content: [
      {
        type: "text",
        text: [
          "Research title confirmation",
          `Direction: ${artifact.result.directionId}`,
          `Title status: ${artifact.result.title.status}; ${title}`,
          `Confirmation: ${artifact.result.confirmation.status}`,
          "Project rename: separate explicit action required",
        ].join("\n"),
      },
      { type: "json", value: artifact },
    ],
    data: artifact,
    metadata: {
      artifactId: artifact.artifactId,
      directionId: artifact.result.directionId,
      titleStatus: artifact.result.title.status,
      confirmationStatus: artifact.result.confirmation.status,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
