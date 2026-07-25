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
} from "../contracts.js";
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
      const spec = findSpecByRevision(manifest, current.payload.experimentId, current.payload.specRevision);
      if (!spec) throw bridgeError("invalid_state", "The prepared remote run's pinned spec is missing.");
      if (spec.payload.adapterId !== "ssh" && spec.payload.adapterId !== "slurm") {
        throw bridgeError("adapter_mismatch", `Experiment adapter ${spec.payload.adapterId} is not a remote backend.`);
      }
      const grant = requireLatestGrant(manifest, input.grantId);
      assertRemoteGrantUsable({ grant, spec, jobId: current.payload.jobId, automaticGrantConfirmed: input.automaticGrantConfirmed, now });
      if (grant.payload.consumedAttemptIds.includes(current.payload.attemptId)) {
        return { manifest, value: { attempt: current, duplicate: true } };
      }
      if (grant.payload.consumedAttemptIds.length >= grant.payload.budget.maxAttempts) {
        throw bridgeError("permission_denied", "Execution grant has no remaining remote attempts.");
      }
      const grantPayload: ExecutionGrantPayload = {
        ...grant.payload,
        consumedJobIds: unique([...grant.payload.consumedJobIds, current.payload.jobId]),
        consumedAttemptIds: unique([...grant.payload.consumedAttemptIds, current.payload.attemptId]),
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
      if (isTerminal(current.payload.status)) {
        return { manifest, value: current };
      }
      const observedAt = normalizeObservationTime(input.observation.observedAt, now);
      const failure = observationFailure(input.observation, observedAt);
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
        ...(targetStatus === "running" && current.payload.startedAt === undefined ? { startedAt: observedAt } : {}),
        ...(isTerminal(targetStatus) || targetStatus === "recovery_required" ? { finishedAt: observedAt } : {}),
        ...(failure === undefined ? {} : { failure }),
      };
      if (sameJson(payload, current.payload)) return { manifest, value: current };
      const attempt = makeEnvelope({
        kind: "run_attempt",
        artifactId: current.artifactId,
        revision: current.revision + 1,
        payload,
        parents: [{ relation: "supersedes", artifact: toResearchArtifactRef(current) }],
        now,
        createdAt: current.createdAt,
      }) as RunAttempt;
      return {
        manifest: nextManifest(manifest, now, { runAttempts: sortEnvelopes([...manifest.runAttempts, attempt]) }),
        value: attempt,
      };
    },
  });
  return Object.freeze({ attempt: result.value, manifest: result.manifest, persisted: result.persisted });
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
