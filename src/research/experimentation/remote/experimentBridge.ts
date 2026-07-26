import {
  createResearchArtifact,
  toResearchArtifactRef,
  type ResearchArtifactEnvelope,
} from "../../artifacts/index.js";
import type {
  ExecutionGrant,
  ExecutionGrantPayload,
  ExperimentManifest,
  ExperimentSpec,
  RunAttempt,
  RunAttemptPayload,
  RunFacts,
  RemoteCancellationReconciliation,
} from "../contracts.js";
import {
  budgetReservationError,
  reserveExecutionGrantBudget,
  settleExecutionGrantWallTime,
} from "../budget.js";
import {
  updateProjectExperimentManifest,
} from "../repository.js";
import type {
  RemoteBackendJobObservation,
} from "./contracts.js";

export class RemoteExperimentBridgeError extends Error {
  readonly code: "not_found" | "permission_denied" | "invalid_state" | "adapter_mismatch";

  constructor(code: RemoteExperimentBridgeError["code"], message: string) {
    super(message);
    this.name = "RemoteExperimentBridgeError";
    this.code = code;
  }
}

export type RemoteCancellationReconciliationInput = Readonly<{
  actualWallTimeMs: number;
  source: "scheduler_audit" | "operator_confirmed";
  reference: string;
}>;

/**
 * Rejects unauthorized or over-budget work before the controller performs any
 * network staging. The later reservation repeats this check under the Project
 * manifest lock so concurrent submissions cannot overspend the grant.
 */
export function assertRemoteExperimentStagingAuthorized(input: {
  manifest: ExperimentManifest;
  attempt: RunAttempt;
  grantId: string;
  automaticGrantConfirmed: boolean;
  now: Date;
}): void {
  const spec = findSpecByRevision(
    input.manifest,
    input.attempt.payload.experimentId,
    input.attempt.payload.specRevision,
  );
  if (!spec) throw bridgeError("invalid_state", "The prepared remote run's pinned spec is missing.");
  if (spec.payload.adapterId !== "ssh" && spec.payload.adapterId !== "slurm") {
    throw bridgeError("adapter_mismatch", `Experiment adapter ${spec.payload.adapterId} is not a remote backend.`);
  }
  const grant = requireLatestGrant(input.manifest, input.grantId);
  assertRemoteGrantUsable({
    grant,
    spec,
    jobId: input.attempt.payload.jobId,
    automaticGrantConfirmed: input.automaticGrantConfirmed,
    now: input.now,
  });
  if (grant.payload.consumedAttemptIds.includes(input.attempt.payload.attemptId)) return;
  if (grant.payload.consumedAttemptIds.length >= grant.payload.budget.maxAttempts) {
    throw bridgeError("permission_denied", "Execution grant has no remaining remote attempts.");
  }
  const reservationError = budgetReservationError({
    budget: grant.payload.budget,
    usage: grant.payload.budgetUsage,
    reservation: input.attempt.payload.runFacts?.budgetReservation,
  });
  if (reservationError) throw bridgeError("permission_denied", reservationError);
}

export async function reserveRemoteExperimentRun(input: {
  projectRoot: string;
  attemptId: string;
  grantId: string;
  automaticGrantConfirmed: boolean;
  now?: Date;
}): Promise<Readonly<{ attempt: RunAttempt; manifest: ExperimentManifest; duplicate: boolean }>> {
  const result = await updateProjectExperimentManifest({
    projectRoot: input.projectRoot,
    now: input.now,
    update: (existing, now) => {
      const manifest = requireManifest(existing);
      const current = requireLatestRun(manifest, input.attemptId);
      if (current.payload.status !== "prepared") {
        return { manifest, value: { attempt: current, duplicate: true } };
      }
      assertRemoteExperimentStagingAuthorized({
        manifest,
        attempt: current,
        grantId: input.grantId,
        automaticGrantConfirmed: input.automaticGrantConfirmed,
        now,
      });
      const grant = requireLatestGrant(manifest, input.grantId);
      if (grant.payload.consumedAttemptIds.includes(current.payload.attemptId)) {
        return { manifest, value: { attempt: current, duplicate: true } };
      }
      const grantPayload: ExecutionGrantPayload = {
        ...grant.payload,
        consumedJobIds: unique([...grant.payload.consumedJobIds, current.payload.jobId]),
        consumedAttemptIds: unique([...grant.payload.consumedAttemptIds, current.payload.attemptId]),
        budgetUsage: reserveExecutionGrantBudget(grant.payload.budgetUsage, current.payload.runFacts?.budgetReservation),
      };
      const consumedGrant = makeEnvelope({
        kind: "execution_grant",
        artifactId: grant.artifactId,
        revision: grant.revision + 1,
        payload: grantPayload,
        parents: [{ relation: "supersedes", artifact: toResearchArtifactRef(grant) }],
        now,
        createdAt: grant.createdAt,
      }) as ExecutionGrant;
      const attemptPayload: RunAttemptPayload = {
        ...current.payload,
        grantId: consumedGrant.payload.grantId,
        grantMode: consumedGrant.payload.mode,
        status: "queued",
        queuedAt: now.toISOString(),
      };
      const attempt = makeEnvelope({
        kind: "run_attempt",
        artifactId: current.artifactId,
        revision: current.revision + 1,
        payload: attemptPayload,
        parents: [
          { relation: "supersedes", artifact: toResearchArtifactRef(current) },
          { relation: "uses", artifact: toResearchArtifactRef(consumedGrant) },
        ],
        now,
        createdAt: current.createdAt,
      }) as RunAttempt;
      return {
        manifest: nextManifest(manifest, now, {
          executionGrants: sortEnvelopes([...manifest.executionGrants, consumedGrant]),
          runAttempts: sortEnvelopes([...manifest.runAttempts, attempt]),
        }),
        value: { attempt, duplicate: false },
      };
    },
  });
  return Object.freeze({ ...result.value, manifest: result.manifest });
}

export async function applyRemoteExperimentObservation(input: {
  projectRoot: string;
  attemptId: string;
  observation: RemoteBackendJobObservation;
  now?: Date;
}): Promise<Readonly<{ attempt: RunAttempt; manifest: ExperimentManifest; persisted: boolean }>> {
  const result = await updateProjectExperimentManifest({
    projectRoot: input.projectRoot,
    now: input.now,
    update: (existing, now) => {
      const manifest = requireManifest(existing);
      const current = requireLatestRun(manifest, input.attemptId);
      if (current.payload.jobId !== input.observation.jobId) throw bridgeError("invalid_state", "Remote observation belongs to another jobId.");
      if (current.payload.adapterId !== input.observation.backend) throw bridgeError("adapter_mismatch", "Remote observation changed the run adapter.");
      if (current.payload.backendJobId && input.observation.backendJobId && current.payload.backendJobId !== input.observation.backendJobId) {
        throw bridgeError("invalid_state", "Remote backendJobId is immutable once recorded.");
      }
      const targetStatus = observationStatus(input.observation);
      const observedAt = normalizeObservationTime(input.observation.observedAt, now);
      if (isTerminal(current.payload.status)) {
        return enrichTerminalRemoteObservation({
          manifest,
          attempt: current,
          targetStatus,
          observation: input.observation,
          now,
        });
      }
      const failure = observationFailure(input.observation, observedAt);
      const observedStartedAt = input.observation.startedAt === undefined
        ? undefined
        : normalizeObservationTime(input.observation.startedAt, now);
      const observedFinishedAt = isTerminal(targetStatus) && input.observation.finishedAt !== undefined
        ? normalizeObservationTime(input.observation.finishedAt, now)
        : undefined;
      const startedAt = current.payload.startedAt
        ?? observedStartedAt;
      const finishedAt = isTerminal(targetStatus)
        ? observedFinishedAt ?? observedAt
        : undefined;
      const settlement = settleRemoteTerminalWallTime({
        manifest,
        attempt: current,
        targetStatus,
        observedStartedAt,
        observedFinishedAt,
        now,
      });
      const {
        failure: _previousFailure,
        finishedAt: _previousFinishedAt,
        ...currentWithoutTerminalState
      } = current.payload;
      const payload: RunAttemptPayload = {
        ...currentWithoutTerminalState,
        status: targetStatus,
        ...(current.payload.backendJobId || input.observation.backendJobId
          ? { backendJobId: current.payload.backendJobId ?? input.observation.backendJobId }
          : {}),
        ...(["queued", "running"].includes(targetStatus) && current.payload.queuedAt === undefined
          ? { queuedAt: observedAt }
          : {}),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(finishedAt === undefined ? {} : { finishedAt }),
        ...(targetStatus === "recovery_required" ? { finishedAt: observedAt } : {}),
        ...(settlement.runFacts === undefined ? {} : { runFacts: settlement.runFacts }),
        ...(failure === undefined ? {} : { failure }),
      };
      if (sameJson(payload, current.payload)) return { manifest, value: current };
      const attempt = makeEnvelope({
        kind: "run_attempt",
        artifactId: current.artifactId,
        revision: current.revision + 1,
        payload,
        parents: [
          { relation: "supersedes", artifact: toResearchArtifactRef(current) },
          ...(settlement.grant === undefined ? [] : [{ relation: "uses" as const, artifact: toResearchArtifactRef(settlement.grant) }]),
        ],
        now,
        createdAt: current.createdAt,
      }) as RunAttempt;
      return {
        manifest: nextManifest(manifest, now, {
          runAttempts: sortEnvelopes([...manifest.runAttempts, attempt]),
          ...(settlement.grant === undefined
            ? {}
            : { executionGrants: sortEnvelopes([...manifest.executionGrants, settlement.grant]) }),
        }),
        value: attempt,
      };
    },
  });
  return Object.freeze({ attempt: result.value, manifest: result.manifest, persisted: result.persisted });
}

/**
 * Closes a recovery-only remote attempt only after an operator has supplied
 * durable external cancellation evidence. The cost reservation remains held
 * until recordExperimentRunCost receives an explicit actual-cost record.
 */
export async function reconcileRemoteExperimentCancellation(input: {
  projectRoot: string;
  attemptId: string;
  reconciliation: RemoteCancellationReconciliationInput;
  now?: Date;
}): Promise<Readonly<{ attempt: RunAttempt; manifest: ExperimentManifest; duplicate: boolean }>> {
  const result = await updateProjectExperimentManifest<{ attempt: RunAttempt; duplicate: boolean }>({
    projectRoot: input.projectRoot,
    now: input.now,
    update: (existing, now) => {
      const manifest = requireManifest(existing);
      const current = requireLatestRun(manifest, input.attemptId);
      const normalized = normalizeRemoteCancellationReconciliation(input.reconciliation, now);
      if (current.payload.status === "cancelled") {
        const existingReconciliation = current.payload.remoteCancellationReconciliation;
        if (existingReconciliation
          && existingReconciliation.source === normalized.evidence.source
          && existingReconciliation.reference === normalized.evidence.reference
          && current.payload.runFacts?.actualWallTimeMs === normalized.actualWallTimeMs) {
          return { manifest, value: { attempt: current, duplicate: true } };
        }
        throw bridgeError("invalid_state", "A cancelled run cannot be reconciled with different remote evidence.");
      }
      if (current.payload.status !== "recovery_required") {
        throw bridgeError("invalid_state", "Only a recovery-required remote run can be manually reconciled as cancelled.");
      }
      if (current.payload.adapterId !== "ssh" && current.payload.adapterId !== "slurm") {
        throw bridgeError("adapter_mismatch", "Only an SSH or Slurm run can be manually reconciled as remote cancellation.");
      }
      if (!current.payload.runFacts || current.payload.runFacts.actualWallTimeMs !== undefined) {
        throw bridgeError("invalid_state", "The remote run has no unsettled immutable wall-time reservation.");
      }
      const grantId = current.payload.grantId;
      if (!grantId) throw bridgeError("invalid_state", "The remote run has no execution grant to settle.");
      const grant = requireLatestGrant(manifest, grantId);
      const runFacts: RunFacts = Object.freeze({
        ...current.payload.runFacts,
        actualWallTimeMs: normalized.actualWallTimeMs,
      });
      const settledGrant = makeEnvelope({
        kind: "execution_grant",
        artifactId: grant.artifactId,
        revision: grant.revision + 1,
        payload: {
          ...grant.payload,
          budgetUsage: settleExecutionGrantWallTime({
            current: grant.payload.budgetUsage,
            reservation: current.payload.runFacts.budgetReservation,
            actualWallTimeMs: normalized.actualWallTimeMs,
          }),
        },
        parents: [{ relation: "supersedes", artifact: toResearchArtifactRef(grant) }],
        now,
        createdAt: grant.createdAt,
      }) as ExecutionGrant;
      const failure = Object.freeze({
        category: "cancelled" as const,
        message: `Remote cancellation was explicitly reconciled from ${normalized.evidence.source}: ${normalized.evidence.reference}`,
        retryable: false,
        observedAt: now.toISOString(),
      });
      const attempt = makeEnvelope({
        kind: "run_attempt",
        artifactId: current.artifactId,
        revision: current.revision + 1,
        payload: {
          ...current.payload,
          status: "cancelled",
          finishedAt: now.toISOString(),
          runFacts,
          remoteCancellationReconciliation: normalized.evidence,
          failure,
        },
        parents: [
          { relation: "supersedes", artifact: toResearchArtifactRef(current) },
          { relation: "uses", artifact: toResearchArtifactRef(settledGrant) },
        ],
        now,
        createdAt: current.createdAt,
      }) as RunAttempt;
      return {
        manifest: nextManifest(manifest, now, {
          executionGrants: sortEnvelopes([...manifest.executionGrants, settledGrant]),
          runAttempts: sortEnvelopes([...manifest.runAttempts, attempt]),
        }),
        value: { attempt, duplicate: false },
      };
    },
  });
  return Object.freeze({ ...result.value, manifest: result.manifest });
}

/**
 * Scheduler accounting can lag behind a terminal state. Keep a terminal
 * attempt queryable until an observation supplies both actual timestamps;
 * only then may its wall-time reservation be released.
 */
function enrichTerminalRemoteObservation(input: {
  manifest: ExperimentManifest;
  attempt: RunAttempt;
  targetStatus: RunAttemptPayload["status"];
  observation: RemoteBackendJobObservation;
  now: Date;
}): Readonly<{ manifest: ExperimentManifest; value: RunAttempt }> {
  if (input.targetStatus !== input.attempt.payload.status
    || input.attempt.payload.runFacts?.actualWallTimeMs !== undefined) {
    return Object.freeze({ manifest: input.manifest, value: input.attempt });
  }
  const observedStartedAt = input.observation.startedAt === undefined
    ? undefined
    : normalizeObservationTime(input.observation.startedAt, input.now);
  const observedFinishedAt = input.observation.finishedAt === undefined
    ? undefined
    : normalizeObservationTime(input.observation.finishedAt, input.now);
  if (observedStartedAt === undefined || observedFinishedAt === undefined) {
    return Object.freeze({ manifest: input.manifest, value: input.attempt });
  }
  const settlement = settleRemoteTerminalWallTime({
    manifest: input.manifest,
    attempt: input.attempt,
    targetStatus: input.targetStatus,
    observedStartedAt,
    observedFinishedAt,
    now: input.now,
  });
  if (settlement.runFacts === undefined || settlement.grant === undefined) {
    return Object.freeze({ manifest: input.manifest, value: input.attempt });
  }
  const payload: RunAttemptPayload = {
    ...input.attempt.payload,
    startedAt: observedStartedAt,
    finishedAt: observedFinishedAt,
    runFacts: settlement.runFacts,
  };
  if (sameJson(payload, input.attempt.payload)) {
    return Object.freeze({ manifest: input.manifest, value: input.attempt });
  }
  const attempt = makeEnvelope({
    kind: "run_attempt",
    artifactId: input.attempt.artifactId,
    revision: input.attempt.revision + 1,
    payload,
    parents: [
      { relation: "supersedes", artifact: toResearchArtifactRef(input.attempt) },
      { relation: "uses", artifact: toResearchArtifactRef(settlement.grant) },
    ],
    now: input.now,
    createdAt: input.attempt.createdAt,
  }) as RunAttempt;
  return Object.freeze({
    manifest: nextManifest(input.manifest, input.now, {
      executionGrants: sortEnvelopes([...input.manifest.executionGrants, settlement.grant]),
      runAttempts: sortEnvelopes([...input.manifest.runAttempts, attempt]),
    }),
    value: attempt,
  });
}

function settleRemoteTerminalWallTime(input: {
  manifest: ExperimentManifest;
  attempt: RunAttempt;
  targetStatus: RunAttemptPayload["status"];
  observedStartedAt: string | undefined;
  observedFinishedAt: string | undefined;
  now: Date;
}): Readonly<{ runFacts?: RunFacts; grant?: ExecutionGrant }> {
  if (!isTerminal(input.targetStatus) || !input.attempt.payload.runFacts
    || input.attempt.payload.runFacts.actualWallTimeMs !== undefined) {
    return Object.freeze({ runFacts: input.attempt.payload.runFacts });
  }
  if (input.observedStartedAt === undefined || input.observedFinishedAt === undefined) {
    return Object.freeze({ runFacts: input.attempt.payload.runFacts });
  }
  const actualWallTimeMs = Math.max(0, Date.parse(input.observedFinishedAt) - Date.parse(input.observedStartedAt));
  const runFacts: RunFacts = Object.freeze({ ...input.attempt.payload.runFacts, actualWallTimeMs });
  const grantId = input.attempt.payload.grantId;
  if (!grantId) return Object.freeze({ runFacts });
  const grant = requireLatestGrant(input.manifest, grantId);
  const settledGrant = makeEnvelope({
    kind: "execution_grant",
    artifactId: grant.artifactId,
    revision: grant.revision + 1,
    payload: {
      ...grant.payload,
      budgetUsage: settleExecutionGrantWallTime({
        current: grant.payload.budgetUsage,
        reservation: input.attempt.payload.runFacts.budgetReservation,
        actualWallTimeMs,
      }),
    },
    parents: [{ relation: "supersedes", artifact: toResearchArtifactRef(grant) }],
    now: input.now,
    createdAt: grant.createdAt,
  }) as ExecutionGrant;
  return Object.freeze({ runFacts, grant: settledGrant });
}

function normalizeRemoteCancellationReconciliation(
  value: RemoteCancellationReconciliationInput,
  now: Date,
): Readonly<{ actualWallTimeMs: number; evidence: RemoteCancellationReconciliation }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw bridgeError("invalid_state", "Remote reconciliation evidence must be an object.");
  }
  if (!Number.isSafeInteger(value.actualWallTimeMs) || value.actualWallTimeMs < 0) {
    throw bridgeError("invalid_state", "Remote reconciliation actualWallTimeMs must be a non-negative integer.");
  }
  if (value.source !== "scheduler_audit" && value.source !== "operator_confirmed") {
    throw bridgeError("invalid_state", "Remote reconciliation source is invalid.");
  }
  if (typeof value.reference !== "string" || !value.reference.trim() || value.reference !== value.reference.trim()
    || value.reference.includes("\u0000") || value.reference.length > 16_000) {
    throw bridgeError("invalid_state", "Remote reconciliation reference must be bounded non-empty text.");
  }
  return Object.freeze({
    actualWallTimeMs: value.actualWallTimeMs,
    evidence: Object.freeze({
      source: value.source,
      reference: value.reference,
      confirmedAt: now.toISOString(),
    }),
  });
}

function assertRemoteGrantUsable(input: {
  grant: ExecutionGrant;
  spec: ExperimentSpec;
  jobId: string;
  automaticGrantConfirmed: boolean;
  now: Date;
}): void {
  const { grant, spec } = input;
  if (grant.payload.status !== "active") throw bridgeError("permission_denied", "Execution grant is not active.");
  if (grant.payload.expiresAt && Date.parse(grant.payload.expiresAt) <= input.now.valueOf()) {
    throw bridgeError("permission_denied", "Execution grant has expired.");
  }
  if (grant.payload.experimentId !== spec.payload.experimentId) throw bridgeError("permission_denied", "Execution grant belongs to another experiment.");
  if (!grant.payload.allowedAdapterIds.includes(spec.payload.adapterId)) throw bridgeError("permission_denied", "Execution grant does not allow this remote adapter.");
  if (grant.payload.mode === "plan_only") throw bridgeError("permission_denied", "plan_only grants cannot submit remote jobs.");
  if (grant.payload.mode === "confirm_each" && !grant.payload.confirmedJobIds.includes(input.jobId)) {
    throw bridgeError("permission_denied", `Job ${input.jobId} has not been explicitly confirmed.`);
  }
  if (grant.payload.mode === "budget_auto" && !input.automaticGrantConfirmed) {
    throw bridgeError("permission_denied", "budget_auto remote execution requires an explicitly confirmed automatic grant.");
  }
}

function observationStatus(value: RemoteBackendJobObservation): RunAttemptPayload["status"] {
  if (value.status === "unknown") return "recovery_required";
  return value.status;
}

function observationFailure(value: RemoteBackendJobObservation, observedAt: string): RunAttemptPayload["failure"] | undefined {
  if (value.failure) return Object.freeze({ ...value.failure, observedAt });
  if (value.status === "unknown") {
    return Object.freeze({
      category: "disconnected" as const,
      message: "Remote backend state is uncertain; recovery did not resubmit the job.",
      retryable: true,
      observedAt,
    });
  }
  if (value.status === "failed") {
    return Object.freeze({
      category: "unknown" as const,
      message: "Remote backend reported failure without a classified cause.",
      retryable: false,
      observedAt,
      ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
      ...(value.signal === undefined ? {} : { signal: value.signal }),
    });
  }
  return undefined;
}

function requireManifest(value: ExperimentManifest | undefined): ExperimentManifest {
  if (!value) throw bridgeError("not_found", "Experiment manifest does not exist.");
  return value;
}

function requireLatestRun(manifest: ExperimentManifest, attemptId: string): RunAttempt {
  const run = latestById(manifest.runAttempts, attemptId);
  if (!run) throw bridgeError("not_found", `Run attempt not found: ${attemptId}.`);
  return run;
}

function requireLatestGrant(manifest: ExperimentManifest, grantId: string): ExecutionGrant {
  const grant = latestById(manifest.executionGrants, grantId);
  if (!grant) throw bridgeError("not_found", `Execution grant not found: ${grantId}.`);
  return grant;
}

function findSpecByRevision(manifest: ExperimentManifest, experimentId: string, revision: number): ExperimentSpec | undefined {
  return manifest.specs.find((spec) => spec.artifactId === experimentId && spec.revision === revision);
}

function latestById<T extends ResearchArtifactEnvelope>(values: readonly T[], artifactId: string): T | undefined {
  return values.filter((value) => value.artifactId === artifactId).sort((left, right) => right.revision - left.revision)[0];
}

function sortEnvelopes<T extends ResearchArtifactEnvelope>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.artifactId.localeCompare(right.artifactId, "en") || left.revision - right.revision);
}

function nextManifest(existing: ExperimentManifest, now: Date, changes: Partial<ExperimentManifest>): ExperimentManifest {
  return { ...existing, ...changes, revision: existing.revision + 1, updatedAt: now.toISOString() };
}

function makeEnvelope(input: {
  kind: "execution_grant" | "run_attempt";
  artifactId: string;
  revision: number;
  payload: ExecutionGrantPayload | RunAttemptPayload;
  parents: Parameters<typeof createResearchArtifact>[0]["parents"];
  now: Date;
  createdAt: string;
}): ResearchArtifactEnvelope {
  const created = createResearchArtifact({
    kind: input.kind,
    artifactId: input.artifactId,
    revision: input.revision,
    payload: input.payload,
    producer: { kind: "tool", id: "experimentation-remote", toolName: "experiment_remote" },
    parents: input.parents,
    now: input.now,
  });
  return Object.freeze({ ...created, createdAt: input.createdAt });
}

function isTerminal(value: RunAttemptPayload["status"]): boolean {
  return ["succeeded", "failed", "cancelled"].includes(value);
}

function normalizeObservationTime(value: string, fallback: Date): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback.toISOString();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function bridgeError(code: RemoteExperimentBridgeError["code"], message: string): RemoteExperimentBridgeError {
  return new RemoteExperimentBridgeError(code, message);
}
