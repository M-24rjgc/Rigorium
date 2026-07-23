import { randomUUID } from "node:crypto";
import {
  assessResearchDirections,
  type DirectionAssessmentInput,
  type DirectionAssessmentResult,
} from "../../research/direction/directionAssessment.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolValidationIssue, PilotDeckToolValidationResult } from "../protocol/schema.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";

export type DirectionAssessInput = DirectionAssessmentInput;

export type DirectionAssessmentArtifact = {
  schemaVersion: 1;
  kind: "direction_assessment";
  artifactId: string;
  createdAt: string;
  /** Structured records supplied to the deterministic, side-effect-free assessor. */
  input: DirectionAssessmentInput;
  result: DirectionAssessmentResult;
};

export type CreateDirectionAssessToolOptions = {
  maxResultBytes?: number;
};

/**
 * Assess agent-selected research directions without persisting a workflow
 * decision. The assessment result preserves its evidence trace and always
 * treats proposed titles as provisional.
 */
export function createDirectionAssessTool(
  options: CreateDirectionAssessToolOptions = {},
): PilotDeckToolDefinition<DirectionAssessInput, DirectionAssessmentArtifact> {
  return {
    name: "direction_assess",
    title: "Assess Research Directions",
    description: `Assess structured candidate research directions against supplied evidence, feasibility constraints, hypotheses, caveats, and optional target conferences.

Use this when a natural-language research discussion needs a transparent comparison of possible directions. Convert the relevant candidate directions, evidence records, and constraints into the structured input; do not ask the user to type a slash command. This tool is read-only, has no required research workflow, does not persist a decision, and does not certify a direction as novel. Returned titles remain explicitly provisional, including downgraded or rejected title states.`,
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["candidates"],
      additionalProperties: false,
      properties: {
        candidates: {
          type: "array",
          minItems: 1,
          maxItems: 24,
          items: {
            type: "object",
            required: ["id", "summary"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              summary: { type: "string" },
              titleSeed: { type: "string" },
              evidenceIds: { type: "array", maxItems: 48, items: { type: "string" } },
              constraintIds: { type: "array", maxItems: 16, items: { type: "string" } },
              targetConferenceIds: { type: "array", maxItems: 8, items: { type: "string" } },
              caveats: {
                type: "array",
                maxItems: 12,
                items: {
                  type: "object",
                  required: ["id", "summary", "severity"],
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    summary: { type: "string" },
                    severity: { type: "string", enum: ["low", "medium", "high"] },
                    evidenceIds: { type: "array", maxItems: 12, items: { type: "string" } },
                  },
                },
              },
              hypotheses: {
                type: "array",
                maxItems: 8,
                items: {
                  type: "object",
                  required: ["id", "statement"],
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    statement: { type: "string" },
                    failureCriterion: { type: "string" },
                    evidenceIds: { type: "array", maxItems: 16, items: { type: "string" } },
                    evaluationConstraintId: { type: "string" },
                    baselineConstraintIds: { type: "array", maxItems: 8, items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
        evidence: {
          type: "array",
          maxItems: 320,
          items: {
            type: "object",
            required: ["id", "paperId", "role", "statement"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              paperId: { type: "string" },
              role: {
                type: "string",
                enum: ["prior_art", "gap", "method", "result", "limitation", "data", "baseline", "evaluation", "ethics", "venue"],
              },
              statement: { type: "string" },
              strength: { type: "string", enum: ["direct", "indirect"] },
            },
          },
        },
        constraints: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            required: ["id", "kind", "label", "status"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              kind: { type: "string", enum: ["venue", "time", "data", "compute", "ethics", "baseline", "evaluation"] },
              label: { type: "string" },
              status: { type: "string", enum: ["satisfied", "unknown", "blocked"] },
              required: { type: "boolean" },
              evidenceIds: { type: "array", maxItems: 12, items: { type: "string" } },
            },
          },
        },
        targetConferences: {
          type: "array",
          maxItems: 16,
          items: {
            type: "object",
            required: ["id", "name", "status"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              deadline: { type: "string" },
              status: { type: "string", enum: ["satisfied", "unknown", "blocked"] },
              evidenceIds: { type: "array", maxItems: 12, items: { type: "string" } },
            },
          },
        },
      },
    },
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 500_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => false,
    validateInput: async (input): Promise<PilotDeckToolValidationResult> => validateDirectionAssessInput(input),
    execute: async (input, context) => {
      const assessmentInput = normalizeInput(input);
      let result: DirectionAssessmentResult;
      try {
        result = assessResearchDirections(assessmentInput);
      } catch (error) {
        throw invalidInputError(error);
      }
      const artifact: DirectionAssessmentArtifact = {
        schemaVersion: 1,
        kind: "direction_assessment",
        artifactId: `direction-assessment-${randomUUID()}`,
        createdAt: (context.now?.() ?? new Date()).toISOString(),
        input: assessmentInput,
        result,
      };
      return formatToolOutput(artifact);
    },
  };
}

function validateDirectionAssessInput(input: DirectionAssessInput): PilotDeckToolValidationResult {
  try {
    const assessmentInput = normalizeInput(input);
    assessResearchDirections(assessmentInput);
    return { ok: true, input };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const issue: PilotDeckToolValidationIssue = {
      path: "$",
      code: "invalid_schema",
      message,
    };
    return { ok: false, issues: [issue] };
  }
}

function normalizeInput(input: unknown): DirectionAssessmentInput {
  if (!isRecord(input)) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", "direction_assess requires an input object.");
  }
  return {
    candidates: input.candidates as DirectionAssessmentInput["candidates"],
    ...(input.evidence === undefined ? {} : { evidence: input.evidence as DirectionAssessmentInput["evidence"] }),
    ...(input.constraints === undefined ? {} : { constraints: input.constraints as DirectionAssessmentInput["constraints"] }),
    ...(input.targetConferences === undefined
      ? {}
      : { targetConferences: input.targetConferences as DirectionAssessmentInput["targetConferences"] }),
  };
}

function invalidInputError(error: unknown): PilotDeckToolRuntimeError {
  if (error instanceof PilotDeckToolRuntimeError) return error;
  return new PilotDeckToolRuntimeError(
    "invalid_tool_input",
    `Invalid direction assessment input: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function formatToolOutput(
  artifact: DirectionAssessmentArtifact,
): PilotDeckToolExecutionOutput<DirectionAssessmentArtifact> {
  const lines = [
    "Research direction assessment",
    `Candidates: ${artifact.result.assessments.length}`,
    `Ranking: ${artifact.result.rankedDirectionIds.join(", ") || "none"}`,
  ];
  for (const assessment of artifact.result.assessments.slice(0, 12)) {
    const title = assessment.provisionalTitle.text
      ? `${assessment.provisionalTitle.status}: ${assessment.provisionalTitle.text}`
      : `${assessment.provisionalTitle.status}: no title proposed`;
    lines.push(
      `- #${assessment.rank} ${assessment.directionId}: score ${assessment.score.total}; ${assessment.minimumViability.status}; novelty ${assessment.novelty.status}; provisional title ${title}`,
    );
  }
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "json", value: artifact },
    ],
    data: artifact,
    metadata: {
      artifactId: artifact.artifactId,
      assessmentCount: artifact.result.assessments.length,
      rankedDirectionIds: artifact.result.rankedDirectionIds,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
