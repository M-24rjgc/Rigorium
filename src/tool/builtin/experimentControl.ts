import {
  ExperimentRepositoryError,
  ExperimentServiceError,
  confirmExecutionJob,
  issueExecutionGrant,
  listExperimentAdapters,
  loadExperimentManifest,
  prepareExperimentRun,
  recordExperimentRunCost,
  recordObservedBaseline,
  recordReportedBaseline,
  recoverExperimentJob,
  recoverProjectExperimentState,
  saveExperimentSpec,
  submitLocalExperimentRun,
  type BaselineObservation,
  type ActualCostRecord,
  type ExecutionGrant,
  type ExecutionGrantInput,
  type ExperimentAdapterDescriptor,
  type ExperimentManifest,
  type ExperimentOperationResult,
  type ExperimentSpec,
  type ExperimentSpecInput,
  type ObservedBaselineInput,
  type ReportedBaselineInput,
  type RunAttempt,
  type RunAttemptInput,
} from "../../research/experimentation/index.js";
import type { ResearchArtifactEnvelope } from "../../research/artifacts/index.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult } from "../protocol/schema.js";
import type { RigoriumToolDefinition, RigoriumToolExecutionOutput } from "../protocol/types.js";

export const EXPERIMENT_CONTROL_OPERATIONS = [
  "spec",
  "grant",
  "baseline",
  "record_cost",
  "prepare",
  "confirm",
  "submit",
  "recover",
  "list",
] as const;

export type ExperimentControlOperation = typeof EXPERIMENT_CONTROL_OPERATIONS[number];

export type ExperimentControlInput = Readonly<{
  operation: ExperimentControlOperation;
  spec?: ExperimentSpecInput;
  grant?: ExecutionGrantInput;
  baseline?: ({ kind: "reported" } & ReportedBaselineInput) | ({ kind: "observed" } & ObservedBaselineInput);
  actualCost?: Omit<ActualCostRecord, "recordedAt">;
  experimentId?: string;
  grantId?: string;
  jobId?: string;
  attemptId?: string;
  run?: RunAttemptInput;
  confirmed?: boolean;
  expectedManifestRevision?: number;
}>;

export type ExperimentControlOutput = Readonly<{
  operation: ExperimentControlOperation;
  projectRoot: string;
  manifest: ExperimentManifest | null;
  artifact?: ResearchArtifactEnvelope;
  adapters?: readonly ExperimentAdapterDescriptor[];
  duplicate?: boolean;
  manifestPath?: string;
}>;

export type CreateExperimentControlToolOptions = Readonly<{
  maxResultBytes?: number;
}>;

export function createExperimentControlTool(
  options: CreateExperimentControlToolOptions = {},
): RigoriumToolDefinition<ExperimentControlInput, ExperimentControlOutput> {
  return {
    name: "experiment_control",
    title: "Control Project Experiments",
    description: `Persist and operate one Project's auditable experiment manifest.

Use spec to save a versioned experiment definition and, when it depends on upstream research work, provide explicit parent references together with their complete immutable sourceArtifacts closure. The current Project manifest verifies and retains that closure before it accepts the spec. Grant creates one immutable plan_only, confirm_each, or budget_auto authorization; baseline distinguishes reported paper values from observed reruns; prepare allocates a stable job identity and immutable run facts; confirm follows user approval of that exact job; submit runs the implemented local adapter; record_cost stores one explicit terminal provider or user-confirmed cost; recover records interruption without resubmitting it; and list inspects state and adapter availability. Authorized SSH and Slurm execution is available through experiment_remote; MLflow, Optuna, and DVC remain reserved. All storage is fixed to the current Project cwd.`,
    kind: "custom",
    inputSchema: experimentControlInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 2_000_000,
    isReadOnly: (input) => input.operation === "list",
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    requiresUserInteraction: (input) => input.operation === "confirm"
      || input.operation === "record_cost"
      || (input.operation === "grant" && input.grant?.mode === "budget_auto"),
    isOpenWorld: (input) => input.operation === "submit",
    validateInput: async (input): Promise<RigoriumToolValidationResult> => validateInput(input),
    execute: async (input, context) => {
      let normalized: ExperimentControlInput;
      try {
        normalized = normalizeInput(input);
        return await executeOperation(normalized, context.cwd, context.now?.(), context.abortSignal);
      } catch (error) {
        throw mapExperimentError(error);
      }
    },
  };
}

async function executeOperation(
  input: ExperimentControlInput,
  projectRoot: string,
  now: Date | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<RigoriumToolExecutionOutput<ExperimentControlOutput>> {
  switch (input.operation) {
    case "list": {
      const manifest = await loadExperimentManifest({ projectRoot });
      return formatOutput({ operation: input.operation, projectRoot, manifest: manifest ?? null, adapters: listExperimentAdapters() });
    }
    case "spec":
      return formatOperationResult(input.operation, projectRoot, await saveExperimentSpec({
        projectRoot,
        spec: input.spec!,
        expectedManifestRevision: input.expectedManifestRevision,
        now,
      }));
    case "grant":
      return formatOperationResult(input.operation, projectRoot, await issueExecutionGrant({
        projectRoot,
        grant: input.grant!,
        expectedManifestRevision: input.expectedManifestRevision,
        now,
      }));
    case "baseline": {
      const { kind, ...baseline } = input.baseline!;
      const result = kind === "reported"
        ? await recordReportedBaseline({
            projectRoot,
            baseline: baseline as ReportedBaselineInput,
            expectedManifestRevision: input.expectedManifestRevision,
            now,
          })
        : await recordObservedBaseline({
            projectRoot,
            baseline: baseline as ObservedBaselineInput,
            expectedManifestRevision: input.expectedManifestRevision,
            now,
          });
      return formatOperationResult(input.operation, projectRoot, result);
    }
    case "record_cost":
      return formatOperationResult(input.operation, projectRoot, await recordExperimentRunCost({
        projectRoot,
        attemptId: input.attemptId!,
        actualCost: input.actualCost!,
        expectedManifestRevision: input.expectedManifestRevision,
        now,
      }));
    case "prepare":
      return formatOperationResult(input.operation, projectRoot, await prepareExperimentRun({
        projectRoot,
        experimentId: input.experimentId!,
        grantId: input.grantId!,
        jobId: input.jobId!,
        ...(input.run === undefined ? {} : { run: input.run }),
        expectedManifestRevision: input.expectedManifestRevision,
        now,
      }));
    case "confirm":
      return formatOperationResult(input.operation, projectRoot, await confirmExecutionJob({
        projectRoot,
        grantId: input.grantId!,
        jobId: input.jobId!,
        expectedManifestRevision: input.expectedManifestRevision,
        now,
      }));
    case "submit":
      return formatOperationResult(input.operation, projectRoot, await submitLocalExperimentRun({
        projectRoot,
        experimentId: input.experimentId!,
        grantId: input.grantId!,
        jobId: input.jobId!,
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        ...(input.run === undefined ? {} : { run: input.run }),
        expectedManifestRevision: input.expectedManifestRevision,
        now,
        ...(abortSignal === undefined ? {} : { abortSignal }),
      }));
    case "recover": {
      if (input.jobId) {
        const artifact = await recoverExperimentJob({ projectRoot, jobId: input.jobId, now });
        const manifest = await loadExperimentManifest({ projectRoot });
        return formatOutput({ operation: input.operation, projectRoot, manifest: manifest ?? null, artifact });
      }
      const manifest = await recoverProjectExperimentState({ projectRoot, now });
      return formatOutput({ operation: input.operation, projectRoot, manifest });
    }
  }
}

function formatOperationResult<T extends ExperimentSpec | ExecutionGrant | BaselineObservation | RunAttempt>(
  operation: ExperimentControlOperation,
  projectRoot: string,
  result: ExperimentOperationResult<T>,
): RigoriumToolExecutionOutput<ExperimentControlOutput> {
  return formatOutput({
    operation,
    projectRoot,
    manifest: result.manifest,
    artifact: result.value,
    manifestPath: result.path,
    ...(result.duplicate === undefined ? {} : { duplicate: result.duplicate }),
  });
}

function formatOutput(data: ExperimentControlOutput): RigoriumToolExecutionOutput<ExperimentControlOutput> {
  const latestRuns = latestArtifacts(data.manifest?.runAttempts ?? []);
  const lines = [
    `Experiment operation: ${data.operation}`,
    `Project: ${data.projectRoot}`,
    `Manifest revision: ${data.manifest?.revision ?? "none"}`,
    `Specs: ${latestArtifacts(data.manifest?.specs ?? []).length}`,
    `Runs: ${latestRuns.length}`,
    ...(data.artifact ? [`Artifact: ${data.artifact.kind} ${data.artifact.artifactId}@${data.artifact.revision}`] : []),
    ...(data.duplicate === undefined ? [] : [`Duplicate: ${data.duplicate}`]),
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }, { type: "json", value: data }],
    data,
    metadata: {
      operation: data.operation,
      projectRoot: data.projectRoot,
      manifestRevision: data.manifest?.revision,
      artifactId: data.artifact?.artifactId,
      artifactRevision: data.artifact?.revision,
      duplicate: data.duplicate,
    },
  };
}

function latestArtifacts<T extends ResearchArtifactEnvelope>(values: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const value of values) {
    const previous = latest.get(value.artifactId);
    if (!previous || previous.revision < value.revision) latest.set(value.artifactId, value);
  }
  return [...latest.values()];
}

function experimentControlInputSchema() {
  return {
    type: "object" as const,
    additionalProperties: false,
    required: ["operation"],
    properties: {
      operation: { type: "string", enum: [...EXPERIMENT_CONTROL_OPERATIONS] },
      spec: { type: "object", description: "ExperimentSpecInput for operation=spec, including explicit parents plus a complete sourceArtifacts envelope closure when it depends on upstream research artifacts." },
      grant: { type: "object", description: "ExecutionGrantInput with plan_only, confirm_each, or budget_auto mode." },
      baseline: { type: "object", description: "Reported or observed baseline input with kind=reported|observed." },
      actualCost: { type: "object", description: "Explicit terminal provider-reported or user-confirmed cost for operation=record_cost." },
      experimentId: { type: "string" },
      grantId: { type: "string" },
      jobId: { type: "string", description: "Stable idempotency identity chosen before submission." },
      attemptId: { type: "string" },
      run: { type: "object", description: "Immutable route, parameter, slice, baseline-rerun, and explicit budget-reservation facts for prepare or submit." },
      confirmed: {
        type: "boolean",
        description: "Must be true for operation=confirm, operation=record_cost, and for a budget_auto grant after explicit user approval.",
      },
      expectedManifestRevision: { type: "integer", minimum: 0 },
    },
  };
}

function validateInput(input: unknown): RigoriumToolValidationResult {
  try {
    normalizeInput(input);
    return { ok: true, input };
  } catch (error) {
    const issue: RigoriumToolValidationIssue = { path: "$", code: "invalid_schema", message: messageOf(error) };
    return { ok: false, issues: [issue] };
  }
}

function normalizeInput(value: unknown): ExperimentControlInput {
  if (!isRecord(value)) throw new TypeError("experiment_control input must be an object.");
  const allowedKeys = new Set([
    "operation", "spec", "grant", "baseline", "actualCost", "experimentId", "grantId", "jobId", "attemptId", "run", "confirmed", "expectedManifestRevision",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new TypeError(`experiment_control does not accept ${key}; project storage is fixed to the current cwd.`);
  }
  if (!(EXPERIMENT_CONTROL_OPERATIONS as readonly unknown[]).includes(value.operation)) {
    throw new TypeError("operation is invalid.");
  }
  const operation = value.operation as ExperimentControlOperation;
  if (value.expectedManifestRevision !== undefined
    && (!Number.isSafeInteger(value.expectedManifestRevision) || (value.expectedManifestRevision as number) < 0)) {
    throw new TypeError("expectedManifestRevision must be a non-negative integer.");
  }
  if (operation === "spec" && !isRecord(value.spec)) throw new TypeError("operation=spec requires spec.");
  if (operation === "grant") {
    if (!isRecord(value.grant)) throw new TypeError("operation=grant requires grant.");
    if (value.grant.mode === "budget_auto" && value.confirmed !== true) {
      throw new TypeError("operation=grant with mode=budget_auto requires confirmed=true after explicit user approval.");
    }
  }
  if (operation === "baseline") {
    if (!isRecord(value.baseline) || (value.baseline.kind !== "reported" && value.baseline.kind !== "observed")) {
      throw new TypeError("operation=baseline requires baseline.kind=reported or observed.");
    }
  }
  if (operation === "record_cost") {
    requiredText(value.attemptId, "attemptId");
    if (!isRecord(value.actualCost)) throw new TypeError("operation=record_cost requires actualCost.");
    if (value.confirmed !== true) throw new TypeError("operation=record_cost requires confirmed=true after explicit user approval.");
  }
  if (["prepare", "submit"].includes(operation)) {
    requiredText(value.experimentId, "experimentId");
    requiredText(value.grantId, "grantId");
    requiredText(value.jobId, "jobId");
    if (value.run !== undefined && !isRecord(value.run)) throw new TypeError(`operation=${operation} run must be an object.`);
  }
  if (operation === "confirm") {
    requiredText(value.grantId, "grantId");
    requiredText(value.jobId, "jobId");
    if (value.confirmed !== true) throw new TypeError("operation=confirm requires confirmed=true after explicit user approval.");
  }
  if (operation === "recover" && value.jobId !== undefined) requiredText(value.jobId, "jobId");
  if (value.attemptId !== undefined) requiredText(value.attemptId, "attemptId");
  return value as unknown as ExperimentControlInput;
}

function mapExperimentError(error: unknown): RigoriumToolRuntimeError {
  if (error instanceof RigoriumToolRuntimeError) return error;
  if (error instanceof ExperimentServiceError) {
    if (error.code === "permission_denied") return new RigoriumToolRuntimeError("permission_denied", error.message);
    if (error.code === "not_found" || error.code === "artifact_missing") return new RigoriumToolRuntimeError("file_not_found", error.message);
    if (error.code === "adapter_unavailable") return new RigoriumToolRuntimeError("unsupported_tool", error.message);
    if (error.code === "invalid_input" || error.code === "duplicate_submission") return new RigoriumToolRuntimeError("invalid_tool_input", error.message);
    return new RigoriumToolRuntimeError("tool_execution_failed", error.message);
  }
  if (error instanceof ExperimentRepositoryError) {
    if (error.code === "path_violation") return new RigoriumToolRuntimeError("path_not_allowed", error.message, { diagnostic: error.diagnostic });
    if (error.code === "revision_conflict" || error.code === "repository_busy") return new RigoriumToolRuntimeError("file_conflict", error.message, { diagnostic: error.diagnostic });
    if (error.code === "invalid_input" || error.code === "invalid_project_root") return new RigoriumToolRuntimeError("invalid_tool_input", error.message, { diagnostic: error.diagnostic });
    return new RigoriumToolRuntimeError("tool_execution_failed", error.message, { diagnostic: error.diagnostic });
  }
  return new RigoriumToolRuntimeError("tool_execution_failed", `Experiment operation failed: ${messageOf(error)}`);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\u0000") || value.length > 4_096) {
    throw new TypeError(`${label} must be bounded non-empty text.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
