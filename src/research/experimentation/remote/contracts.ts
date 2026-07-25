import type {
  ExecutionGrantMode,
  ExperimentFailure,
  ExperimentRunStatus,
} from "../contracts.js";

export const REMOTE_EXECUTION_SCHEMA_VERSION = 1 as const;
export const REMOTE_PROTOCOL_VERSION = 1 as const;

export const REMOTE_BACKENDS = ["ssh", "slurm"] as const;
export type RemoteBackend = typeof REMOTE_BACKENDS[number];

export const REMOTE_SUBMISSION_PHASES = [
  "prepared",
  "staging",
  "submitting",
  "submitted",
  "submission_uncertain",
  "terminal",
] as const;
export type RemoteSubmissionPhase = typeof REMOTE_SUBMISSION_PHASES[number];

export type RemoteConnectionSpec = Readonly<{
  connectionId: string;
  host: string;
  port?: number;
  username?: string;
  /** Local OpenSSH executable. Defaults to the executable resolved as `ssh`. */
  sshExecutable?: string;
  /** Local path only. Key material is never copied into the experiment manifest. */
  identityFile?: string;
  /** Required local OpenSSH known-hosts file; permissive host-key modes are unsupported. */
  knownHostsFile: string;
  /** Fixed remote agent invocation. User workdir and argv are sent as JSON on stdin. */
  agentCommand: readonly string[];
  /** Absolute POSIX root containing this connection's project workspaces. */
  workspaceRoot: string;
  /** Absolute POSIX root containing remote idempotency and scheduler records. */
  stateRoot: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}>;

export type RemoteConnectionRecord = Readonly<{
  connectionId: string;
  host: string;
  port: number;
  username?: string;
  sshExecutable: string;
  identityFile?: string;
  knownHostsFile: string;
  agentCommand: readonly string[];
  workspaceRoot: string;
  stateRoot: string;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  createdAt: string;
  updatedAt: string;
}>;

export type RemoteStageFileInput = Readonly<{
  /** Absolute path or Project-relative path on the local controller. */
  localPath: string;
  /** POSIX relative path below the remote job workdir. */
  remoteRelativePath: string;
}>;

export type PreparedRemoteStageFile = Readonly<{
  localRelativePath: string;
  remoteRelativePath: string;
  remotePath: string;
  bytes: number;
  sha256: string;
  contentBase64: string;
}>;

export type RemoteStagedFileRecord = Readonly<{
  localRelativePath: string;
  remoteRelativePath: string;
  remotePath: string;
  bytes: number;
  sha256: string;
  stagedAt: string;
}>;

export type SlurmResourceSpec = Readonly<{
  partition?: string;
  account?: string;
  qos?: string;
  constraint?: string;
  nodes?: number;
  tasks?: number;
  cpusPerTask?: number;
  memoryMiB?: number;
  gpus?: number;
  timeLimitMinutes?: number;
}>;

export type RemoteExperimentSubmission = Readonly<{
  projectRoot: string;
  connectionId: string;
  backend: RemoteBackend;
  experimentId: string;
  grantId: string;
  jobId: string;
  /** Required again at execution time for an unattended grant. */
  automaticGrantConfirmed?: boolean;
  /** Absolute POSIX directory below the registered connection workspace root. */
  workdir: string;
  /** Executable first, followed by arguments. Never converted into a shell command. */
  argv: readonly string[];
  stageFiles?: readonly RemoteStageFileInput[];
  slurm?: SlurmResourceSpec;
}>;

export type RemoteJobEvent = Readonly<{
  sequence: number;
  at: string;
  status: ExperimentRunStatus;
  phase: RemoteSubmissionPhase;
  message: string;
  backendJobId?: string;
}>;

export type RemoteJobRecord = Readonly<{
  jobId: string;
  attemptId: string;
  experimentId: string;
  grantId: string;
  grantMode: ExecutionGrantMode;
  connectionId: string;
  backend: RemoteBackend;
  requestHash: string;
  workdir: string;
  argv: readonly string[];
  slurm?: SlurmResourceSpec;
  stagedFiles: readonly RemoteStagedFileRecord[];
  status: ExperimentRunStatus;
  phase: RemoteSubmissionPhase;
  backendJobId?: string;
  schedulerJobId?: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  lastObservedAt?: string;
  failure?: ExperimentFailure;
  events: readonly RemoteJobEvent[];
}>;

export type RemoteExecutionManifest = Readonly<{
  schemaVersion: 1;
  kind: "remote_execution_manifest";
  manifestId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  connections: readonly RemoteConnectionRecord[];
  jobs: readonly RemoteJobRecord[];
  integrityHash: string;
}>;

export type RemoteBackendStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export type RemoteBackendJobObservation = Readonly<{
  backend: RemoteBackend;
  jobId: string;
  backendJobId?: string;
  schedulerJobId?: string;
  status: RemoteBackendStatus;
  duplicate: boolean;
  observedAt: string;
  exitCode?: number | null;
  signal?: string;
  failure?: ExperimentFailure;
}>;

type RemoteAgentRequestBase = Readonly<{
  protocolVersion: 1;
  requestId: string;
  connectionId: string;
  projectId: string;
  stateRoot: string;
  workspaceRoot: string;
  jobId: string;
  requestHash: string;
}>;

export type RemoteAgentStageRequest = RemoteAgentRequestBase & Readonly<{
  action: "stage";
  workdir: string;
  files: readonly Pick<PreparedRemoteStageFile, "remoteRelativePath" | "remotePath" | "bytes" | "sha256" | "contentBase64">[];
}>;

export type RemoteAgentSubmitRequest = RemoteAgentRequestBase & Readonly<{
  action: "submit";
  backend: RemoteBackend;
  workdir: string;
  argv: readonly string[];
  slurm?: SlurmResourceSpec;
}>;

export type RemoteAgentJobRequest = RemoteAgentRequestBase & Readonly<{
  action: "query" | "recover" | "cancel";
  backend: RemoteBackend;
  backendJobId?: string;
}>;

export type RemoteAgentRequest = RemoteAgentStageRequest | RemoteAgentSubmitRequest | RemoteAgentJobRequest;

export type RemoteAgentSuccessResponse = Readonly<{
  protocolVersion: 1;
  requestId: string;
  ok: true;
  action: RemoteAgentRequest["action"];
  duplicate: boolean;
  stagedFiles?: readonly Pick<RemoteStagedFileRecord, "remoteRelativePath" | "remotePath" | "bytes" | "sha256">[];
  observation?: RemoteBackendJobObservation;
}>;

export type RemoteAgentErrorCode =
  | "invalid_request"
  | "path_violation"
  | "hash_mismatch"
  | "job_conflict"
  | "job_not_found"
  | "adapter_unavailable"
  | "scheduler_error"
  | "internal_error";

export type RemoteAgentErrorResponse = Readonly<{
  protocolVersion: 1;
  requestId: string;
  ok: false;
  action: RemoteAgentRequest["action"];
  code: RemoteAgentErrorCode;
  message: string;
  retryable: boolean;
}>;

export type RemoteAgentResponse = RemoteAgentSuccessResponse | RemoteAgentErrorResponse;

export interface RemoteExecutionTransport {
  request(
    connection: RemoteConnectionRecord,
    request: RemoteAgentRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<RemoteAgentResponse>;
}
