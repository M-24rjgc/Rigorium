import type {
  ResearchArtifactEnvelope,
  ResearchArtifactParent,
  ResearchArtifactRef,
} from "../artifacts/index.js";

/**
 * Project-local experimentation contracts. They intentionally do not reuse
 * Always-On workspaces: experimental input and output are recorded through an
 * immutable run manifest and a dedicated run directory instead.
 */
export const EXPERIMENTATION_SCHEMA_VERSION = 1 as const;

export const EXECUTION_GRANT_MODES = [
  "plan_only",
  "confirm_each",
  "budget_auto",
] as const;

export type ExecutionGrantMode = typeof EXECUTION_GRANT_MODES[number];
/** Compatibility name for callers that model the grant as an execution boundary. */
export type ExecutionPermissionBoundary = ExecutionGrantMode;
export const EXECUTION_PERMISSION_BOUNDARIES = EXECUTION_GRANT_MODES;

export const EXPERIMENT_ADAPTER_IDS = [
  "local",
  "ssh",
  "slurm",
  "mlflow",
  "optuna",
  "dvc",
] as const;

export type ExperimentAdapterId = typeof EXPERIMENT_ADAPTER_IDS[number];

export type ExperimentAdapterDescriptor = Readonly<{
  id: ExperimentAdapterId;
  status: "implemented" | "reserved";
  license: string;
  platforms: readonly ("win32" | "linux" | "darwin" | "remote-linux")[];
  purpose: string;
  executionNotes: string;
}>;

/**
 * Adapter metadata is deliberately descriptive. Only `local` has an
 * implementation in this increment; callers must not infer that a reserved
 * adapter can submit work or install a third-party dependency.
 */
export const EXPERIMENT_ADAPTERS: readonly ExperimentAdapterDescriptor[] = Object.freeze([
  {
    id: "local",
    status: "implemented",
    license: "Node.js built-in runtime",
    platforms: ["win32", "linux", "darwin"],
    purpose: "Dedicated local mock and worker execution.",
    executionNotes: "Uses a run-local working directory and never invokes Always-On GitWorktreeProvider.",
  },
  {
    id: "ssh",
    status: "reserved",
    license: "OpenSSH client integration (future adapter)",
    platforms: ["win32", "linux", "darwin", "remote-linux"],
    purpose: "Explicit remote-worker dispatch.",
    executionNotes: "Requires a separately configured host, credential boundary, and remote manifest handshake.",
  },
  {
    id: "slurm",
    status: "reserved",
    license: "Scheduler integration (future adapter)",
    platforms: ["remote-linux"],
    purpose: "Submit to a Slurm-managed remote cluster.",
    executionNotes: "Requires SSH or a scheduler API plus explicit job-id recovery semantics.",
  },
  {
    id: "mlflow",
    status: "reserved",
    license: "Apache-2.0",
    platforms: ["win32", "linux", "darwin", "remote-linux"],
    purpose: "Optional external tracking-store bridge.",
    executionNotes: "No Python dependency is bundled or auto-installed by this module.",
  },
  {
    id: "optuna",
    status: "reserved",
    license: "MIT",
    platforms: ["win32", "linux", "darwin", "remote-linux"],
    purpose: "Optional study and trial optimizer bridge.",
    executionNotes: "A future bridge must map trials to immutable RunAttempt records rather than bypass the manifest.",
  },
  {
    id: "dvc",
    status: "reserved",
    license: "Apache-2.0",
    platforms: ["win32", "linux", "darwin", "remote-linux"],
    purpose: "Optional data/version provenance bridge.",
    executionNotes: "It is not an execution queue and must not replace run-level artifact hashes.",
  },
]);

export const EXPERIMENT_RUN_STATUSES = [
  "prepared",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "recovery_required",
] as const;

export type ExperimentRunStatus = typeof EXPERIMENT_RUN_STATUSES[number];

export const EXPERIMENT_FAILURE_CATEGORIES = [
  "permission_denied",
  "adapter_unavailable",
  "invalid_worker_result",
  "worker_spawn_failed",
  "worker_exit_nonzero",
  "worker_signalled",
  "timeout",
  "cancelled",
  "artifact_missing",
  "storage_error",
  "host_interrupted",
  "disconnected",
  "preempted",
  "out_of_memory",
  "rate_limited",
  "unknown",
] as const;

export type ExperimentFailureCategory = typeof EXPERIMENT_FAILURE_CATEGORIES[number];

export type ExperimentFailure = Readonly<{
  category: ExperimentFailureCategory;
  message: string;
  retryable: boolean;
  observedAt: string;
  exitCode?: number | null;
  signal?: string;
  retryAfterMs?: number;
}>;

export type MetricDirection = "minimize" | "maximize" | "neutral";

export type WorkerMetricInput = Readonly<{
  name: string;
  value: number;
  unit?: string;
  split?: string;
  direction?: MetricDirection;
}>;

export type WorkerArtifactInput = Readonly<{
  /** Relative path inside the attempt's dedicated run directory. */
  path: string;
  mediaType?: string;
  role?: "output" | "log" | "checkpoint" | "figure" | "table";
}>;

export type MockWorkerArtifactInput = WorkerArtifactInput & Readonly<{
  /** UTF-8 fixture content written only inside the dedicated mock run directory. */
  content?: string;
}>;

export type WorkerResultInput = Readonly<{
  metrics?: readonly WorkerMetricInput[];
  artifacts?: readonly WorkerArtifactInput[];
}>;

export type MockWorkerResultInput = Readonly<{
  metrics?: readonly WorkerMetricInput[];
  artifacts?: readonly MockWorkerArtifactInput[];
}>;

export type LocalMockWorker = Readonly<{
  kind: "mock";
  outcome?: "succeed" | "fail";
  delayMs?: number;
  result?: MockWorkerResultInput;
  failureMessage?: string;
  failureCategory?: Extract<
    ExperimentFailureCategory,
    | "invalid_worker_result"
    | "worker_exit_nonzero"
    | "disconnected"
    | "preempted"
    | "out_of_memory"
    | "rate_limited"
    | "unknown"
  >;
}>;

export type LocalProcessWorker = Readonly<{
  kind: "process";
  /** Executed without a shell from the dedicated run directory. */
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
}>;

export type LocalWorkerDefinition = LocalMockWorker | LocalProcessWorker;

export type ExperimentSpecPayload = Readonly<{
  experimentId: string;
  title: string;
  description?: string;
  hypothesisId?: string;
  adapterId: ExperimentAdapterId;
  defaultGrantMode: ExecutionGrantMode;
  expectedMetrics: readonly string[];
  tags: readonly string[];
  /** Only local workers are executable in this increment. */
  localWorker?: LocalWorkerDefinition;
}>;

export type ExperimentSpec = ResearchArtifactEnvelope<"experiment_spec", ExperimentSpecPayload>;

export type ExecutionGrantPayload = Readonly<{
  grantId: string;
  experimentId: string;
  mode: ExecutionGrantMode;
  allowedAdapterIds: readonly ExperimentAdapterId[];
  issuedAt: string;
  reason: string;
  expiresAt?: string;
  budget: Readonly<{
    maxAttempts: number;
    maxWallTimeMs?: number;
    maxCostUsd?: number;
  }>;
  confirmedJobIds: readonly string[];
  consumedJobIds: readonly string[];
  consumedAttemptIds: readonly string[];
  status: "active" | "revoked" | "expired";
}>;

export type ExecutionGrant = ResearchArtifactEnvelope<"execution_grant", ExecutionGrantPayload>;

/** Shared research-artifact identity; file metadata lives in the manifest's
 * `artifactFiles` projection so graph consumers can use the common ref shape. */
export type ArtifactRef = ResearchArtifactRef;

export type ExperimentArtifactFile = Readonly<{
  ref: ArtifactRef;
  experimentId: string;
  runAttemptId: string;
  relativePath: string;
  bytes: number;
  mediaType?: string;
  role: "output" | "log" | "checkpoint" | "figure" | "table";
  createdAt: string;
}>;

export type MetricObservationPayload = Readonly<{
  observationId: string;
  experimentId: string;
  runAttemptId: string;
  name: string;
  value: number;
  unit?: string;
  split?: string;
  direction: MetricDirection;
  observedAt: string;
  source: "local_mock" | "local_worker" | "manual";
}>;

export type MetricObservation = ResearchArtifactEnvelope<"metric_observation", MetricObservationPayload>;

/**
 * A reported paper baseline is evidence, not a claimed rerun. The default
 * workflow records this object and intentionally creates no RunAttempt.
 */
export type ReportedBaselineProvenance = Readonly<{
  kind: "reported";
  citation: Readonly<{
    text: string;
    doi?: string;
    url?: string;
  }>;
  reportedAt?: string;
  rerunStatus: "not_rerun";
}>;

export type ObservedBaselineProvenance = Readonly<{
  kind: "observed";
  runAttemptId: string;
  metricObservationId: string;
}>;

export type BaselineObservationPayload = Readonly<{
  baselineId: string;
  experimentId: string;
  metricName: string;
  value: number;
  unit?: string;
  split?: string;
  direction: MetricDirection;
  recordedAt: string;
  provenance: ReportedBaselineProvenance | ObservedBaselineProvenance;
}>;

export type BaselineObservation = ResearchArtifactEnvelope<"baseline_observation", BaselineObservationPayload>;

export type RunAttemptPayload = Readonly<{
  attemptId: string;
  experimentId: string;
  specRevision: number;
  specDigest: string;
  adapterId: ExperimentAdapterId;
  /** Stable idempotency identity supplied before any backend submission. */
  jobId: string;
  backendJobId?: string;
  status: ExperimentRunStatus;
  grantMode: ExecutionGrantMode;
  preparedAt: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  grantId?: string;
  workspaceRelativePath?: string;
  artifactIds: readonly string[];
  metricObservationIds: readonly string[];
  failure?: ExperimentFailure;
}>;

export type RunAttempt = ResearchArtifactEnvelope<"run_attempt", RunAttemptPayload>;

export type ExperimentManifest = Readonly<{
  schemaVersion: 1;
  kind: "experiment_manifest";
  manifestId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  specs: readonly ExperimentSpec[];
  executionGrants: readonly ExecutionGrant[];
  runAttempts: readonly RunAttempt[];
  metricObservations: readonly MetricObservation[];
  baselineObservations: readonly BaselineObservation[];
  /** Envelopes are the authoritative graph nodes for produced files. */
  artifactEnvelopes: readonly ResearchArtifactEnvelope[];
  artifactFiles: readonly ExperimentArtifactFile[];
  artifactRefs: readonly ArtifactRef[];
}>;

export type ExperimentSpecInput = Readonly<{
  experimentId?: string;
  title: string;
  description?: string;
  hypothesisId?: string;
  adapterId?: ExperimentAdapterId;
  defaultGrantMode?: ExecutionGrantMode;
  expectedMetrics?: readonly string[];
  tags?: readonly string[];
  localWorker?: LocalWorkerDefinition;
  /** Direct upstream relationships retained on the ExperimentSpec envelope. */
  parents?: readonly ResearchArtifactParent[];
  /**
   * Immutable envelope closure that resolves every explicit upstream parent.
   * It is projected into the Project experiment manifest so its DAG remains
   * self-contained and verifiable after a restart.
   */
  sourceArtifacts?: readonly ResearchArtifactEnvelope[];
}>;

export type ExecutionGrantInput = Readonly<{
  grantId?: string;
  experimentId: string;
  mode: ExecutionGrantMode;
  allowedAdapterIds?: readonly ExperimentAdapterId[];
  reason: string;
  expiresAt?: string;
  budget?: Readonly<{
    maxAttempts?: number;
    maxWallTimeMs?: number;
    maxCostUsd?: number;
  }>;
}>;

export type ReportedBaselineInput = Readonly<{
  baselineId?: string;
  experimentId: string;
  metricName: string;
  reportedValue: number;
  unit?: string;
  split?: string;
  direction?: MetricDirection;
  citation: Readonly<{ text: string; doi?: string; url?: string }>;
  reportedAt?: string;
}>;

export type ObservedBaselineInput = Readonly<{
  baselineId?: string;
  experimentId: string;
  runAttemptId: string;
  metricObservationId: string;
}>;

export function getExperimentAdapter(id: ExperimentAdapterId): ExperimentAdapterDescriptor {
  const adapter = EXPERIMENT_ADAPTERS.find((candidate) => candidate.id === id);
  if (!adapter) throw new Error(`Unknown experiment adapter: ${id}.`);
  return adapter;
}
