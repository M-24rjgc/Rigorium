import { randomUUID } from "node:crypto";
import {
  loadProjectResearchDirectionLifecycle,
  updateProjectResearchDirectionLifecycle,
  type ResearchDirectionLifecycleState,
  type ResearchDirectionLifecycleUpdate,
} from "../../research/direction/directionLifecycle.js";
import type { DirectionAssessmentInput } from "../../research/direction/directionAssessment.js";
import type { ResearchDirectionSeedInput } from "../../research/direction/directionSeed.js";
import type { TitleConfirmationInput } from "../../research/direction/titleConfirmation.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolValidationIssue, PilotDeckToolValidationResult } from "../protocol/schema.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";

export type ResearchDirectionLifecycleToolInput = Readonly<{
  operation: "load" | "save";
  projectRoot: string;
  expectedRevision?: number;
  seed?: ResearchDirectionSeedInput;
  assessment?: DirectionAssessmentInput;
  selectedDirectionId?: string | null;
  titleConfirmation?: TitleConfirmationInput;
}>;

export type ResearchDirectionLifecycleArtifact = Readonly<{
  schemaVersion: 1;
  kind: "research_direction_lifecycle";
  artifactId: string;
  createdAt: string;
  operation: "loaded" | "saved";
  path?: string;
  created?: boolean;
  persisted?: boolean;
  state?: ResearchDirectionLifecycleState;
}>;

export type CreateResearchDirectionLifecycleToolOptions = Readonly<{
  maxResultBytes?: number;
}>;

/**
 * Project-local research direction progress. This is intentionally the first
 * stateful direction tool: its only write target is the current project's
 * lifecycle JSON, and it never changes a Project name.
 */
export function createResearchDirectionLifecycleTool(
  options: CreateResearchDirectionLifecycleToolOptions = {},
): PilotDeckToolDefinition<ResearchDirectionLifecycleToolInput, ResearchDirectionLifecycleArtifact> {
  return {
    name: "research_direction_lifecycle",
    title: "Save Research Direction Lifecycle / 保存研究方向进度",
    description: `Save or load a project-local, evidence-traceable research-direction lifecycle.

Use this after a natural-language research discussion has produced cues, terminology, constraints, candidate comparisons, evidence/gap analysis, feasibility and ethics checks, hypotheses, contribution drafts, minimum viability, or a provisional title. The user does not need to type a slash command. Save only after the conversation calls for recording or progressing this Project's research state. It writes only .pilotdeck/research/direction-lifecycle.json inside the supplied Project root, never writes Zotero, never exports or snapshots research data, and never renames a Project. A titleConfirmation with confirmed=true is permitted only after the user explicitly confirms that title; even then, the result is merely a separate Project-name action intent.`,
    kind: "custom",
    inputSchema: inputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 1_000_000,
    isReadOnly: (input) => input.operation === "load",
    isConcurrencySafe: (input) => input.operation === "load",
    isDestructive: () => false,
    isOpenWorld: () => false,
    validateInput: async (input): Promise<PilotDeckToolValidationResult> => validateInput(input),
    execute: async (input, context) => {
      try {
        const normalized = normalizeInput(input as unknown as Record<string, unknown>);
        if (normalized.operation === "load" && hasLifecycleUpdateFields(normalized)) {
          throw new Error("load does not accept lifecycle update fields.");
        }
        if (normalized.operation === "save" && !hasLifecycleUpdateFields(normalized)) {
          throw new Error("save requires at least one lifecycle update field.");
        }
        const createdAt = (context.now?.() ?? new Date()).toISOString();
        if (normalized.operation === "load") {
          const state = await loadProjectResearchDirectionLifecycle({ projectRoot: normalized.projectRoot });
          const artifact: ResearchDirectionLifecycleArtifact = {
            schemaVersion: 1,
            kind: "research_direction_lifecycle",
            artifactId: `research-direction-lifecycle-${randomUUID()}`,
            createdAt,
            operation: "loaded",
            ...(state ? { state } : {}),
          };
          return formatOutput(artifact);
        }
        const result = await updateProjectResearchDirectionLifecycle({
          projectRoot: normalized.projectRoot,
          update: lifecycleUpdate(normalized),
          ...(normalized.expectedRevision === undefined ? {} : { expectedRevision: normalized.expectedRevision }),
          now: context.now?.(),
        });
        const artifact: ResearchDirectionLifecycleArtifact = {
          schemaVersion: 1,
          kind: "research_direction_lifecycle",
          artifactId: `research-direction-lifecycle-${randomUUID()}`,
          createdAt,
          operation: "saved",
          path: result.path,
          created: result.created,
          persisted: result.persisted,
          state: result.state,
        };
        return formatOutput(artifact);
      } catch (error) {
        throw new PilotDeckToolRuntimeError(
          isInputError(error) ? "invalid_tool_input" : "tool_execution_failed",
          `Research direction lifecycle ${isInputError(error) ? "input is invalid" : "storage failed"}: ${messageOf(error)}`,
          error instanceof Error && "diagnostic" in error
            ? { diagnostic: (error as { diagnostic?: unknown }).diagnostic }
            : undefined,
        );
      }
    },
  };
}

function inputSchema() {
  return {
    type: "object" as const,
    additionalProperties: false,
    required: ["operation", "projectRoot"],
    properties: {
      operation: { type: "string", enum: ["load", "save"] },
      projectRoot: { type: "string", description: "Existing root directory of the current Project." },
      expectedRevision: { type: "integer", description: "Optional optimistic-concurrency revision for save." },
      seed: { type: "object", description: "Cue, terminology, constraint, candidate, hypothesis, and contribution input." },
      assessment: { type: "object", description: "Evidence-backed candidate assessment input." },
      selectedDirectionId: { type: ["string", "null"], description: "Selected candidate ID; null explicitly clears selection." },
      titleConfirmation: { type: "object", description: "Evidence-backed title input; confirmed=true requires explicit user confirmation." },
    },
  };
}

function validateInput(input: unknown): PilotDeckToolValidationResult {
  try {
    const normalized = normalizeInput(input);
    if (normalized.operation === "load" && hasLifecycleUpdateFields(normalized)) {
      throw new Error("load does not accept lifecycle update fields.");
    }
    if (normalized.operation === "save" && !hasLifecycleUpdateFields(normalized)) {
      throw new Error("save requires at least one lifecycle update field.");
    }
    return { ok: true, input: normalized };
  } catch (error) {
    const issue: PilotDeckToolValidationIssue = {
      path: "$",
      code: "invalid_schema",
      message: messageOf(error),
    };
    return { ok: false, issues: [issue] };
  }
}

function normalizeInput(input: unknown): ResearchDirectionLifecycleToolInput {
  if (!isRecord(input)) throw new Error("input must be an object.");
  if (input.operation !== "load" && input.operation !== "save") throw new Error("operation must be load or save.");
  if (typeof input.projectRoot !== "string" || !input.projectRoot.trim()) throw new Error("projectRoot must be a non-empty string.");
  if (input.expectedRevision !== undefined
    && (typeof input.expectedRevision !== "number" || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)) {
    throw new Error("expectedRevision must be a non-negative integer.");
  }
  if (input.selectedDirectionId !== undefined && input.selectedDirectionId !== null && typeof input.selectedDirectionId !== "string") {
    throw new Error("selectedDirectionId must be a string or null.");
  }
  if (input.seed !== undefined && !isRecord(input.seed)) throw new Error("seed must be an object.");
  if (input.assessment !== undefined && !isRecord(input.assessment)) throw new Error("assessment must be an object.");
  if (input.titleConfirmation !== undefined && !isRecord(input.titleConfirmation)) throw new Error("titleConfirmation must be an object.");
  return {
    operation: input.operation,
    projectRoot: input.projectRoot,
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision as number }),
    ...(input.seed === undefined ? {} : { seed: input.seed as ResearchDirectionSeedInput }),
    ...(input.assessment === undefined ? {} : { assessment: input.assessment as DirectionAssessmentInput }),
    ...(input.selectedDirectionId === undefined ? {} : { selectedDirectionId: input.selectedDirectionId as string | null }),
    ...(input.titleConfirmation === undefined ? {} : { titleConfirmation: input.titleConfirmation as TitleConfirmationInput }),
  };
}

function lifecycleUpdate(input: ResearchDirectionLifecycleToolInput): ResearchDirectionLifecycleUpdate {
  return {
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.assessment === undefined ? {} : { assessment: input.assessment }),
    ...(input.selectedDirectionId === undefined ? {} : { selectedDirectionId: input.selectedDirectionId }),
    ...(input.titleConfirmation === undefined ? {} : { titleConfirmation: input.titleConfirmation }),
  };
}

function hasLifecycleUpdateFields(input: ResearchDirectionLifecycleToolInput): boolean {
  return input.seed !== undefined
    || input.assessment !== undefined
    || input.selectedDirectionId !== undefined
    || input.titleConfirmation !== undefined;
}

function formatOutput(
  artifact: ResearchDirectionLifecycleArtifact,
): PilotDeckToolExecutionOutput<ResearchDirectionLifecycleArtifact> {
  const state = artifact.state;
  const checklist = state?.checklist;
  const lines = [
    "Research direction lifecycle / 研究方向生命周期",
    artifact.operation === "loaded" ? "State loaded / 已加载项目状态" : "State saved / 已保存项目状态",
  ];
  if (!state || !checklist) {
    lines.push("No lifecycle saved for this Project / 当前项目尚未保存研究方向进度");
  } else {
    lines.push(`Revision / 版本: ${state.revision}`);
    lines.push(`Lifecycle / 生命周期: ${checklist.status}`);
    lines.push(`Completed / 已完成: ${checklist.completedStageIds.length}/${checklist.items.length}`);
    lines.push(`Selected direction / 已选方向: ${state.selectedDirectionId ?? "none / 未选择"}`);
    lines.push(`Next / 下一步: ${checklist.nextStageId ?? "none / 无"}`);
    lines.push(`Project name / 项目名称: ${checklist.projectNameAction.status}; explicit action required / 仍需单独明确操作`);
  }
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "json", value: artifact },
    ],
    data: artifact,
    metadata: {
      artifactId: artifact.artifactId,
      operation: artifact.operation,
      ...(state ? { revision: state.revision, lifecycleStatus: state.checklist.status } : {}),
      ...(artifact.persisted === undefined ? {} : { persisted: artifact.persisted }),
    },
  };
}

function isInputError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "invalid_input";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
