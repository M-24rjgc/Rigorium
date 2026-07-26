import { randomUUID } from "node:crypto";
import {
  normalizeResearchDirectionSeed,
  type ResearchDirectionSeed,
  type ResearchDirectionSeedInput,
} from "../../research/direction/directionSeed.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
} from "../protocol/types.js";

export type ResearchDirectionSeedToolInput = ResearchDirectionSeedInput;

export type ResearchDirectionSeedArtifact = Readonly<{
  schemaVersion: 1;
  kind: "research_direction_seed";
  artifactId: string;
  createdAt: string;
  input: ResearchDirectionSeedInput;
  result: ResearchDirectionSeed;
}>;

export type CreateResearchDirectionSeedToolOptions = Readonly<{
  maxResultBytes?: number;
}>;

/**
 * Captures an agent's interpretation of a fuzzy research lead without
 * inventing a workflow, searching the network, or mutating a Project.
 */
export function createResearchDirectionSeedTool(
  options: CreateResearchDirectionSeedToolOptions = {},
): RigoriumToolDefinition<ResearchDirectionSeedToolInput, ResearchDirectionSeedArtifact> {
  return {
    name: "research_direction_seed",
    title: "Prepare Research Direction Candidates",
    description: `Turn a natural-language research lead into a traceable candidate-direction artifact.

Use this when the user starts from an interest, question, paper, algorithm, dataset, or experimental observation and needs candidate directions or preliminary titles. Structure the cues, terminology, constraints, hypotheses, contribution drafts, and candidates from the conversation; the user does not need to type a slash command. Every derived record must cite its source cue IDs. This tool is read-only, does not infer missing feasibility constraints, does not search literature, does not certify novelty, and never renames a Project. A returned title is only provisional and remains pending until a later explicit user confirmation.`,
    kind: "custom",
    inputSchema: inputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 500_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => false,
    validateInput: async (input): Promise<RigoriumToolValidationResult> => validateInput(input),
    execute: async (input, context) => {
      let result: ResearchDirectionSeed;
      try {
        result = normalizeResearchDirectionSeed(input);
      } catch (error) {
        throw invalidInput(error);
      }
      const artifact: ResearchDirectionSeedArtifact = {
        schemaVersion: 1,
        kind: "research_direction_seed",
        artifactId: `research-direction-seed-${randomUUID()}`,
        createdAt: (context.now?.() ?? new Date()).toISOString(),
        input,
        result,
      };
      return formatOutput(artifact);
    },
  };
}

function inputSchema() {
  const cue = {
    type: "object",
    additionalProperties: false,
    required: ["id", "kind", "text"],
    properties: {
      id: { type: "string", maxLength: 180 },
      kind: { type: "string", enum: ["interest", "question", "paper", "algorithm", "data", "experiment_observation"] },
      text: { type: "string", maxLength: 1_000 },
      sourceReference: { type: "string", maxLength: 2_000 },
    },
  };
  const references = { type: "array", minItems: 1, maxItems: 24, items: { type: "string", maxLength: 180 } };
  const draft = {
    type: "object",
    additionalProperties: false,
    required: ["id", "statement", "cueIds"],
    properties: {
      id: { type: "string", maxLength: 180 },
      statement: { type: "string", maxLength: 1_000 },
      cueIds: references,
      terminologyIds: { type: "array", maxItems: 16, items: { type: "string", maxLength: 180 } },
      constraintIds: { type: "array", maxItems: 16, items: { type: "string", maxLength: 180 } },
    },
  };
  return {
    type: "object" as const,
    additionalProperties: false,
    required: ["cues", "candidates"],
    properties: {
      cues: { type: "array", minItems: 1, maxItems: 24, items: cue },
      terminology: {
        type: "array",
        maxItems: 48,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "text", "cueIds"],
          properties: {
            id: { type: "string", maxLength: 180 },
            text: { type: "string", maxLength: 1_000 },
            cueIds: references,
            status: { type: "string", enum: ["observed", "inferred"] },
          },
        },
      },
      constraints: {
        type: "array",
        maxItems: 32,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "label", "status", "cueIds"],
          properties: {
            id: { type: "string", maxLength: 180 },
            kind: { type: "string", enum: ["venue", "time", "data", "compute", "ethics", "baseline", "evaluation"] },
            label: { type: "string", maxLength: 1_000 },
            status: { type: "string", enum: ["satisfied", "unknown", "blocked"] },
            required: { type: "boolean" },
            cueIds: references,
          },
        },
      },
      candidates: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "summary", "cueIds"],
          properties: {
            id: { type: "string", maxLength: 180 },
            summary: { type: "string", maxLength: 1_000 },
            cueIds: references,
            terminologyIds: { type: "array", maxItems: 16, items: { type: "string", maxLength: 180 } },
            constraintIds: { type: "array", maxItems: 16, items: { type: "string", maxLength: 180 } },
            hypotheses: { type: "array", maxItems: 8, items: draft },
            contributions: { type: "array", maxItems: 8, items: draft },
            titleSeed: { type: "string", maxLength: 167 },
            neutralTitle: { type: "string", maxLength: 167 },
          },
        },
      },
    },
  };
}

function validateInput(input: unknown): RigoriumToolValidationResult {
  try {
    normalizeResearchDirectionSeed(input as ResearchDirectionSeedInput);
    return { ok: true, input };
  } catch (error) {
    const issue: RigoriumToolValidationIssue = {
      path: "$",
      code: "invalid_schema",
      message: error instanceof Error ? error.message : String(error),
    };
    return { ok: false, issues: [issue] };
  }
}

function invalidInput(error: unknown): RigoriumToolRuntimeError {
  return new RigoriumToolRuntimeError(
    "invalid_tool_input",
    `Invalid research direction seed input: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function formatOutput(
  artifact: ResearchDirectionSeedArtifact,
): RigoriumToolExecutionOutput<ResearchDirectionSeedArtifact> {
  const lines = [
    "Research direction seed",
    `Cues: ${artifact.result.cues.length}`,
    `Terminology: ${artifact.result.terminology.length}`,
    `Constraint coverage: ${artifact.result.constraintCoverage.status}`,
    `Candidates: ${artifact.result.candidateDirections.length}`,
  ];
  for (const candidate of artifact.result.candidateDirections) {
    const title = candidate.provisionalTitle.text ?? "no title proposed";
    lines.push(`- ${candidate.id}: ${candidate.provisionalTitle.status}; ${title}`);
  }
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "json", value: artifact },
    ],
    data: artifact,
    metadata: {
      artifactId: artifact.artifactId,
      candidateCount: artifact.result.candidateDirections.length,
      constraintCoverage: artifact.result.constraintCoverage.status,
    },
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
