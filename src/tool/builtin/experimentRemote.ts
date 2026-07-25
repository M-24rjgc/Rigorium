import {
  ExperimentRepositoryError,
  confirmExecutionJob,
  loadExperimentManifest,
  type ExecutionGrant,
  type ExperimentManifest,
} from "../../research/experimentation/index.js";
import {
  OpenSshRemoteTransport,
  RemoteExperimentController,
  RemoteExecutionControllerError,
  RemoteExecutionRepositoryError,
  RemoteExperimentBridgeError,
  RemoteTransportError,
  assertSubmissionWithinConnection,
  findRemoteConnection,
  loadRemoteExecutionManifest,
  prepareRemoteStageFiles,
  type PreparedRemoteStageFile,
  type RemoteConnectionRecord,
  type RemoteConnectionSpec,
  type RemoteExecutionTransport,
  type RemoteExecutionManifest,
  type RemoteExperimentOperationResult,
  type RemoteExperimentSubmission,
  type RemoteStageFileInput,
  type RemoteBackend,
  type SlurmResourceSpec,
} from "../../research/experimentation/remote/index.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolValidationIssue, PilotDeckToolValidationResult } from "../protocol/schema.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";

export const EXPERIMENT_REMOTE_OPERATIONS = [
  "register",
  "list",
  "stage",
  "confirm",
  "submit",
  "query",
  "recover",
  "cancel",
] as const;

export type ExperimentRemoteOperation = typeof EXPERIMENT_REMOTE_OPERATIONS[number];

export type ExperimentRemoteInput = Readonly<{
  operation: ExperimentRemoteOperation;
  connection?: RemoteConnectionSpec;
  connectionId?: string;
  backend?: RemoteBackend;
  experimentId?: string;
  grantId?: string;
  jobId?: string;
  automaticGrantConfirmed?: boolean;
  confirmed?: boolean;
  workdir?: string;
  argv?: readonly string[];
  stageFiles?: readonly RemoteStageFileInput[];
  slurm?: SlurmResourceSpec;
}>;

export type ExperimentRemoteOutput = Readonly<{
  operation: ExperimentRemoteOperation;
  projectRoot: string;
  experimentManifest: ExperimentManifest | null;
  remoteManifest: RemoteExecutionManifest | null;
  connection?: RemoteConnectionRecord;
  preparedFiles?: readonly PreparedRemoteStageFile[];
  grant?: ExecutionGrant;
  result?: RemoteExperimentOperationResult;
  duplicate?: boolean;
}>;

export type CreateExperimentRemoteToolOptions = Readonly<{
  maxResultBytes?: number;
  transport?: RemoteExecutionTransport;
  now?: () => Date;
}>;

export function createExperimentRemoteTool(
  options: CreateExperimentRemoteToolOptions = {},
): PilotDeckToolDefinition<ExperimentRemoteInput, ExperimentRemoteOutput> {
  const transport = options.transport ?? new OpenSshRemoteTransport();
  return {
    name: "experiment_remote",
    title: "Operate Remote Experiments",
    description: `Register and inspect Project-local remote experiment connections, locally hash-check stage-file preflights, explicitly confirm stable jobs, and submit/query/recover/cancel SSH or Slurm work through the auditable remote controller.

The current Project cwd is the only local storage root. OpenSSH uses strict known-host verification and sends experiment terms as JSON to a fixed remote agent. Slurm uses the remote agent's structured scheduler adapter. The stage operation is a local Project-file hash preflight only: it validates a registered connection's workspace boundary but never opens a network connection or writes a remote file. Remote staging happens only inside submit, after the execution grant and stable job identity are reserved. A stable jobId is never rebound, and a submission_uncertain job is recovered or queried rather than submitted again. Submit, query, recover, and cancel are open-world network actions.`,
    kind: "custom",
    inputSchema: experimentRemoteInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 4_000_000,
    isReadOnly: (input) => input.operation === "list" || input.operation === "stage",
    isConcurrencySafe: (input) => input.operation === "list" || input.operation === "stage",
    isDestructive: (input) => input.operation === "cancel",
    requiresUserInteraction: (input) => input.operation === "confirm" || input.operation === "cancel",
    isOpenWorld: (input) => input.operation === "submit"
      || input.operation === "query"
      || input.operation === "recover"
      || input.operation === "cancel",
    validateInput: async (input) => validateInput(input),
    execute: async (input, context) => {
      try {
        return await executeOperation(normalizeInput(input), context, transport, options.now);
      } catch (error) {
        throw mapRemoteError(error);
      }
    },
  };
}

async function executeOperation(
  input: ExperimentRemoteInput,
  context: PilotDeckToolRuntimeContext,
  transport: RemoteExecutionTransport,
  configuredNow: (() => Date) | undefined,
): Promise<PilotDeckToolExecutionOutput<ExperimentRemoteOutput>> {
  const projectRoot = context.cwd;
  const now = configuredNow ?? context.now ?? (() => new Date());
  const before = await loadRemoteExecutionManifest({ projectRoot });
  const experimentManifest = await loadExperimentManifest({ projectRoot });

  switch (input.operation) {
    case "register": {
      const controller = new RemoteExperimentController({ transport, now });
      const registered = await controller.registerConnection({ projectRoot, connection: input.connection! });
      const remoteManifest = await loadRemoteExecutionManifest({ projectRoot });
      return formatOutput({
        operation: input.operation,
        projectRoot,
        experimentManifest: experimentManifest ?? null,
        remoteManifest: remoteManifest ?? null,
        connection: registered.connection,
        duplicate: registered.duplicate,
      });
    }
    case "list": {
      return formatOutput({
        operation: input.operation,
        projectRoot,
        experimentManifest: experimentManifest ?? null,
        remoteManifest: before ?? null,
      });
    }
    case "stage": {
      const connection = findRemoteConnection(before, input.connectionId!);
      if (!connection) {
        throw new RemoteExecutionControllerError("not_found", `Remote connection not found: ${input.connectionId}.`);
      }
      assertSubmissionWithinConnection(connection, input.workdir!);
      const preparedFiles = await prepareRemoteStageFiles({
        projectRoot,
        workdir: input.workdir!,
        files: input.stageFiles ?? [],
      });
      return formatOutput({
        operation: input.operation,
        projectRoot,
        experimentManifest: experimentManifest ?? null,
        remoteManifest: before ?? null,
        connection,
        preparedFiles,
      });
    }
    case "confirm": {
      const confirmed = await confirmExecutionJob({
        projectRoot,
        grantId: input.grantId!,
        jobId: input.jobId!,
        now: now(),
      });
      return formatOutput({
        operation: input.operation,
        projectRoot,
        experimentManifest: confirmed.manifest,
        remoteManifest: before ?? null,
        grant: confirmed.value,
      });
    }
    case "submit": {
      const controller = new RemoteExperimentController({ transport, now });
      const result = await controller.submit(remoteSubmission(projectRoot, input), { signal: context.abortSignal });
      return formatOutput({
        operation: input.operation,
        projectRoot,
        experimentManifest: await loadExperimentManifest({ projectRoot }) ?? null,
        remoteManifest: await loadRemoteExecutionManifest({ projectRoot }) ?? null,
        result,
        duplicate: result.duplicate,
      });
    }
    case "query":
    case "recover":
    case "cancel": {
      const controller = new RemoteExperimentController({ transport, now });
      const result = await controller[input.operation]({ projectRoot, jobId: input.jobId! }, { signal: context.abortSignal });
      return formatOutput({
        operation: input.operation,
        projectRoot,
        experimentManifest: await loadExperimentManifest({ projectRoot }) ?? null,
        remoteManifest: await loadRemoteExecutionManifest({ projectRoot }) ?? null,
        result,
        duplicate: result.duplicate,
      });
    }
  }
}

function remoteSubmission(projectRoot: string, input: ExperimentRemoteInput): RemoteExperimentSubmission {
  return {
    projectRoot,
    connectionId: input.connectionId!,
    backend: input.backend!,
    experimentId: input.experimentId!,
    grantId: input.grantId!,
    jobId: input.jobId!,
    ...(input.automaticGrantConfirmed === undefined ? {} : { automaticGrantConfirmed: input.automaticGrantConfirmed }),
    workdir: input.workdir!,
    argv: input.argv!,
    ...(input.stageFiles === undefined ? {} : { stageFiles: input.stageFiles }),
    ...(input.slurm === undefined ? {} : { slurm: input.slurm }),
  };
}

function validateInput(input: unknown): PilotDeckToolValidationResult {
  try {
    normalizeInput(input);
    return { ok: true, input };
  } catch (error) {
    const issue: PilotDeckToolValidationIssue = {
      path: "$",
      code: "invalid_schema",
      message: messageOf(error),
    };
    return { ok: false, issues: [issue] };
  }
}

function normalizeInput(value: unknown): ExperimentRemoteInput {
  if (!isRecord(value)) throw new TypeError("experiment_remote input must be an object.");
  const allowedKeys = new Set([
    "operation", "connection", "connectionId", "backend", "experimentId", "grantId", "jobId",
    "automaticGrantConfirmed", "confirmed", "workdir", "argv", "stageFiles", "slurm",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new TypeError(`experiment_remote does not accept ${key}; project storage is fixed to the current cwd.`);
  }
  if (!(EXPERIMENT_REMOTE_OPERATIONS as readonly unknown[]).includes(value.operation)) {
    throw new TypeError("operation is invalid.");
  }
  const operation = value.operation as ExperimentRemoteOperation;
  const allowedForOperation: Record<ExperimentRemoteOperation, readonly string[]> = {
    register: ["operation", "connection"],
    list: ["operation"],
    stage: ["operation", "connectionId", "workdir", "stageFiles"],
    confirm: ["operation", "grantId", "jobId", "confirmed"],
    submit: ["operation", "connectionId", "backend", "experimentId", "grantId", "jobId", "automaticGrantConfirmed", "workdir", "argv", "stageFiles", "slurm"],
    query: ["operation", "jobId"],
    recover: ["operation", "jobId"],
    cancel: ["operation", "jobId"],
  };
  const operationKeys = new Set(allowedForOperation[operation]);
  for (const key of Object.keys(value)) {
    if (!operationKeys.has(key)) throw new TypeError(`operation=${operation} does not accept ${key}.`);
  }
  if (operation === "register" && !isRecord(value.connection)) throw new TypeError("operation=register requires connection.");
  if (operation === "stage") {
    requiredText(value.connectionId, "connectionId");
    requiredText(value.workdir, "workdir");
    if (!Array.isArray(value.stageFiles)) throw new TypeError("operation=stage requires stageFiles.");
  }
  if (["submit"].includes(operation)) {
    requiredText(value.connectionId, "connectionId");
    requiredText(value.backend, "backend");
    if (value.backend !== "ssh" && value.backend !== "slurm") throw new TypeError("backend must be ssh or slurm.");
    requiredText(value.experimentId, "experimentId");
    requiredText(value.grantId, "grantId");
    requiredText(value.jobId, "jobId");
    requiredText(value.workdir, "workdir");
    if (!Array.isArray(value.argv) || value.argv.length === 0) throw new TypeError("submit requires argv.");
    if (value.backend === "ssh" && value.slurm !== undefined) throw new TypeError("slurm resources require backend=slurm.");
  }
  if (["query", "recover", "cancel"].includes(operation)) requiredText(value.jobId, "jobId");
  if (operation === "confirm") {
    requiredText(value.grantId, "grantId");
    requiredText(value.jobId, "jobId");
    if (value.confirmed !== true) throw new TypeError("operation=confirm requires confirmed=true after explicit user approval.");
  }
  if (value.automaticGrantConfirmed !== undefined && typeof value.automaticGrantConfirmed !== "boolean") {
    throw new TypeError("automaticGrantConfirmed must be boolean.");
  }
  return value as unknown as ExperimentRemoteInput;
}

function formatOutput(data: ExperimentRemoteOutput): PilotDeckToolExecutionOutput<ExperimentRemoteOutput> {
  const lines = [
    `Remote experiment operation: ${data.operation}`,
    `Project: ${data.projectRoot}`,
    `Connections: ${data.remoteManifest?.connections.length ?? 0}`,
    `Jobs: ${data.remoteManifest?.jobs.length ?? 0}`,
    ...(data.connection ? [`Connection: ${data.connection.connectionId} ${data.connection.host}:${data.connection.port}`] : []),
    ...(data.result ? [`Job: ${data.result.job.jobId} ${data.result.job.phase}/${data.result.job.status}`, `Duplicate: ${data.result.duplicate}`] : []),
    ...(data.preparedFiles ? [`Prepared files: ${data.preparedFiles.length}`] : []),
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }, { type: "json", value: data }],
    data,
    metadata: {
      operation: data.operation,
      projectRoot: data.projectRoot,
      connectionCount: data.remoteManifest?.connections.length ?? 0,
      jobCount: data.remoteManifest?.jobs.length ?? 0,
      jobId: data.result?.job.jobId,
      jobPhase: data.result?.job.phase,
      jobStatus: data.result?.job.status,
      duplicate: data.duplicate ?? data.result?.duplicate,
      networkAction: ["submit", "query", "recover", "cancel"].includes(data.operation),
    },
  };
}

function mapRemoteError(error: unknown): PilotDeckToolRuntimeError {
  if (error instanceof PilotDeckToolRuntimeError) return error;
  if (error instanceof RemoteExperimentBridgeError) {
    if (error.code === "permission_denied") return new PilotDeckToolRuntimeError("permission_denied", error.message);
    if (error.code === "not_found") return new PilotDeckToolRuntimeError("file_not_found", error.message);
    return new PilotDeckToolRuntimeError("invalid_tool_input", error.message);
  }
  if (error instanceof RemoteExecutionControllerError) {
    if (error.code === "not_found") return new PilotDeckToolRuntimeError("file_not_found", error.message);
    if (error.code === "invalid_input") return new PilotDeckToolRuntimeError("invalid_tool_input", error.message);
    return new PilotDeckToolRuntimeError("tool_execution_failed", error.message);
  }
  if (error instanceof RemoteTransportError) {
    return new PilotDeckToolRuntimeError("tool_execution_failed", `Remote transport ${error.code}: ${error.message}`, {
      retryable: error.retryable,
      submissionUncertain: error.submissionUncertain,
    });
  }
  if (error instanceof RemoteExecutionRepositoryError) {
    if (error.code === "path_violation") return new PilotDeckToolRuntimeError("path_not_allowed", error.message);
    if (error.code === "repository_busy") return new PilotDeckToolRuntimeError("file_conflict", error.message);
    if (error.code === "invalid_input") return new PilotDeckToolRuntimeError("invalid_tool_input", error.message);
    return new PilotDeckToolRuntimeError("tool_execution_failed", error.message);
  }
  if (error instanceof ExperimentRepositoryError) {
    if (error.code === "path_violation") return new PilotDeckToolRuntimeError("path_not_allowed", error.message);
    if (error.code === "revision_conflict" || error.code === "repository_busy") {
      return new PilotDeckToolRuntimeError("file_conflict", error.message);
    }
    if (error.code === "invalid_input" || error.code === "invalid_project_root") return new PilotDeckToolRuntimeError("invalid_tool_input", error.message);
    return new PilotDeckToolRuntimeError("tool_execution_failed", error.message);
  }
  if (error instanceof TypeError) return new PilotDeckToolRuntimeError("invalid_tool_input", error.message);
  return new PilotDeckToolRuntimeError("tool_execution_failed", `Remote operation failed: ${messageOf(error)}`);
}

function experimentRemoteInputSchema() {
  return {
    type: "object" as const,
    additionalProperties: false,
    required: ["operation"],
    properties: {
      operation: { type: "string", enum: [...EXPERIMENT_REMOTE_OPERATIONS] },
      connection: { type: "object", description: "Strict SSH/remote-agent connection terms; knownHostsFile is required." },
      connectionId: { type: "string", description: "Registered immutable remote connection identity; required for stage and submit." },
      backend: { type: "string", enum: ["ssh", "slurm"] },
      experimentId: { type: "string" },
      grantId: { type: "string" },
      jobId: { type: "string", description: "Stable idempotency identity; never change it after an uncertain submit." },
      automaticGrantConfirmed: { type: "boolean", description: "Required true for a budget_auto remote submit after explicit approval." },
      confirmed: { type: "boolean", description: "Must be true for operation=confirm after explicit user approval." },
      workdir: { type: "string", description: "Absolute normalized POSIX path below the registered remote workspace root." },
      argv: { type: "array", items: { type: "string" }, description: "Executable plus arguments; never a shell command string." },
      stageFiles: { type: "array", items: { type: "object" }, description: "Project-local files mapped to remote-relative paths." },
      slurm: { type: "object", description: "Structured Slurm resource limits for backend=slurm." },
    },
  };
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
