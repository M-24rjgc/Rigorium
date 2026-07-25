import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  buildResearchArtifactGraph,
  canonicalJson,
  createResearchArtifact,
  researchArtifactKey,
  toResearchArtifactRef,
  type ResearchArtifactEnvelope,
  type ResearchArtifactInvalidation,
  type ResearchArtifactParent,
  type ResearchArtifactRef,
} from "../artifacts/index.js";
import {
  EXECUTION_PERMISSION_BOUNDARIES,
  EXPERIMENT_ADAPTER_IDS,
  EXPERIMENT_ADAPTERS,
  getExperimentAdapter,
  type BaselineObservation,
  type BaselineObservationPayload,
  type ExecutionGrant,
  type ExecutionGrantInput,
  type ExecutionGrantPayload,
  type ExecutionGrantMode,
  type ExperimentAdapterId,
  type ExperimentArtifactFile,
  type ExperimentManifest,
  type ExperimentSpec,
  type ExperimentSpecInput,
  type ExperimentSpecPayload,
  type ExperimentFailure,
  type LocalWorkerDefinition,
  type MetricObservation,
  type MetricObservationPayload,
  type ObservedBaselineInput,
  type ReportedBaselineInput,
  type RunAttempt,
  type RunAttemptPayload,
  type WorkerArtifactInput,
  type WorkerMetricInput,
} from "./contracts.js";
import {
  getExperimentRunWorkspacePath,
  getProjectExperimentPaths,
  loadProjectExperimentManifest,
  updateProjectExperimentManifest,
} from "./repository.js";
import { executeLocalWorker, LocalWorkerFailure, type LocalWorkerExecution } from "./worker.js";

export type ExperimentServiceErrorCode =
  | "invalid_input"
  | "not_found"
  | "permission_denied"
  | "adapter_unavailable"
  | "invalid_state"
  | "duplicate_submission"
  | "artifact_missing";

export class ExperimentServiceError extends Error {
  constructor(readonly code: ExperimentServiceErrorCode, message: string) {
    super(message);
    this.name = "ExperimentServiceError";
  }
}

export type ExperimentOperationResult<T> = Readonly<{
  value: T;
  manifest: ExperimentManifest;
  path: string;
  created: boolean;
  persisted: boolean;
  duplicate?: boolean;
}>;

type NormalizedExperimentSpecInput = Readonly<{
  payload: ExperimentSpecPayload;
  parents: readonly ResearchArtifactParent[];
  sourceArtifacts: readonly ResearchArtifactEnvelope[];
}>;

export async function loadExperimentManifest(input: {
  projectRoot: string;
  recoverActive?: boolean;
  now?: Date;
}): Promise<ExperimentManifest | undefined> {
  const manifest = await loadProjectExperimentManifest({ projectRoot: input.projectRoot });
  if (!input.recoverActive || !manifest) return manifest;
  return recoverProjectExperimentState({ projectRoot: input.projectRoot, now: input.now });
}

export function listExperimentAdapters() {
  return EXPERIMENT_ADAPTERS;
}

export async function saveExperimentSpec(input: {
  projectRoot: string;
  spec: ExperimentSpecInput;
  expectedManifestRevision?: number;
  now?: Date;
}): Promise<ExperimentOperationResult<ExperimentSpec>> {
  const normalized = normalizeSpecInput(input.spec);
  const result = await updateProjectExperimentManifest({
    projectRoot: input.projectRoot,
    expectedRevision: input.expectedManifestRevision,
    now: input.now,
    update: (existing, now) => {
      const base = existing;
      const projectedArtifacts = projectSpecSourceArtifacts(base, normalized.sourceArtifacts);
      assertSpecSourceDependencies({
        manifest: base,
        projectedArtifacts,
        parents: normalized.parents,
        sourceArtifacts: normalized.sourceArtifacts,
      });
      const previous = base ? latestById(base.specs, normalized.payload.experimentId) : undefined;
      if (previous && sameSpecTerms(previous, normalized)) {
        return { manifest: previousManifest(base!), value: previous };
      }
      const parents = mergeArtifactParents([
        ...normalized.parents,
        ...(previous ? [{ relation: "supersedes" as const, artifact: toResearchArtifactRef(previous) }] : []),
      ]);
      const spec = makeEnvelope<"experiment_spec", ExperimentSpecPayload>({
        kind: "experiment_spec",
        artifactId: normalized.payload.experimentId,
        revision: (previous?.revision ?? 0) + 1,
        payload: normalized.payload,
        parents,
        now,
        toolName: "experiment_spec",
        createdAt: previous?.createdAt,
      }) as ExperimentSpec;
      const manifest = nextManifest(base, now, {
        specs: sortEnvelopes([...(base?.specs ?? []), spec]),
        artifactEnvelopes: projectedArtifacts,
      });
      return { manifest, value: spec };
    },
  });
  return result;
}

export async function issueExecutionGrant(input: {
  projectRoot: string;
  grant: ExecutionGrantInput;
  expectedManifestRevision?: number;
  now?: Date;
}): Promise<ExperimentOperationResult<ExecutionGrant>> {
  const normalized = normalizeGrantInput(input.grant);
  const result = await updateProjectExperimentManifest({
    projectRoot: input.projectRoot,
    expectedRevision: input.expectedManifestRevision,
    now: input.now,
    update: (existing, now) => {
      const manifest = requireManifest(existing);
      const spec = requireLatestSpec(manifest, normalized.experimentId);
      const allowed = normalized.allowedAdapterIds ?? [spec.payload.adapterId];
      if (!allowed.includes(spec.payload.adapterId)) {
        throw new ExperimentServiceError("invalid_input", "Execution grant must allow the experiment's adapter.");
      }
      if (normalized.mode !== "plan_only" && spec.payload.adapterId === "local" && !allowed.includes("local")) {
        throw new ExperimentServiceError("invalid_input", "Executable local grants must allow the local adapter.");
      }
      const grantId = normalized.grantId ?? `grant-${randomUUID()}`;
      const previous = latestById(manifest.executionGrants, grantId);
      const terms = {
        experimentId: normalized.experimentId,
        mode: normalized.mode,
        allowedAdapterIds: allowed,
        reason: normalized.reason,
        ...(normalized.expiresAt === undefined ? {} : { expiresAt: normalized.expiresAt }),
        budget: normalized.budget,
      };
      if (previous) {
        if (sameGrantTerms(previous.payload, terms)) {
          return { manifest: previousManifest(manifest), value: previous };
        }
        throw new ExperimentServiceError(
          "duplicate_submission",
          `Execution grant ${grantId} already exists with different authorization terms; issue a new grant ID.`,
        );
      }
      const payload: ExecutionGrantPayload = {
        grantId,
        ...terms,
        issuedAt: now.toISOString(),
        confirmedJobIds: [],
        consumedJobIds: [],
        consumedAttemptIds: [],
        status: "active",
      };
      const grant = makeEnvelope<"execution_grant", ExecutionGrantPayload>({
        kind: "execution_grant",
        artifactId: grantId,
        revision: 1,
        payload,
        parents: [{ relation: "uses" as const, artifact: toResearchArtifactRef(spec) }],
        now,
        toolName: "experiment_grant",
      }) as ExecutionGrant;
      return {
        manifest: nextManifest(manifest, now, { executionGrants: sortEnvelopes([...manifest.executionGrants, grant]) }),
        value: grant,
      };
    },
  });
  return result;
}

/** Records one explicit confirmation before a `confirm_each` job can submit. */
export async function confirmExecutionJob(input: {
  projectRoot: string;
  grantId: string;
  jobId: string;
  expectedManifestRevision?: number;
  now?: Date;
}): Promise<ExperimentOperationResult<ExecutionGrant>> {
  const grantId = requireInputIdentifier(input.grantId, "grantId");
  const jobId = requireJobId(input.jobId);
  const result = await updateProjectExperimentManifest({
    projectRoot: input.projectRoot,
    expectedRevision: input.expectedManifestRevision,
    now: input.now,
    update: (existing, now) => {
      const manifest = requireManifest(existing);
      const grant = requireLatestGrant(manifest, grantId);
      if (grant.payload.mode !== "confirm_each") {
        throw new ExperimentServiceError("invalid_state", "Only confirm_each grants accept per-job confirmation.");
      }
      if (grant.payload.status !== "active" || (grant.payload.expiresAt && Date.parse(grant.payload.expiresAt) <= now.valueOf())) {
        throw new ExperimentServiceError("permission_denied", "Expired or inactive execution grants cannot confirm jobs.");
      }
      if (grant.payload.confirmedJobIds.includes(jobId)) return { manifest: previousManifest(manifest), value: grant };
      const confirmed = makeEnvelope<"execution_grant", ExecutionGrantPayload>({
        kind: "execution_grant",
        artifactId: grant.artifactId,
        revision: grant.revision + 1,
        payload: { ...grant.payload, confirmedJobIds: [...grant.payload.confirmedJobIds, jobId] },
        parents: [{ relation: "supersedes", artifact: toResearchArtifactRef(grant) }],
        now,
        toolName: "experiment_grant",
        createdAt: grant.createdAt,
      }) as ExecutionGrant;
      return {
        manifest: nextManifest(manifest, now, { executionGrants: sortEnvelopes([...manifest.executionGrants, confirmed]) }),
        value: confirmed,
      };
    },
  });
  return result;
}

export async function recordReportedBaseline(input: {
  projectRoot: string;
  baseline: ReportedBaselineInput;
  expectedManifestRevision?: number;
  now?: Date;
}): Promise<ExperimentOperationResult<BaselineObservation>> {
  const normalized = normalizeBaselineInput(input.baseline);
  const result = await updateProjectExperimentManifest({
    projectRoot: input.projectRoot,
    expectedRevision: input.expectedManifestRevision,
    now: input.now,
    update: (existing, now) => {
      const manifest = requireManifest(existing);
      const spec = requireLatestSpec(manifest, normalized.experimentId);
      const baselineId = normalized.baselineId ?? `baseline-${randomUUID()}`;
      const previous = latestById(manifest.baselineObservations, baselineId);
      const payload: BaselineObservationPayload = {
        baselineId,
        experimentId: normalized.experimentId,
        metricName: normalized.metricName,
        value: normalized.reportedValue,
        ...(normalized.unit === undefined ? {} : { unit: normalized.unit }),
        ...(normalized.split === undefined ? {} : { split: normalized.split }),
        direction: normalized.direction,
        recordedAt: now.toISOString(),
        provenance: {
          kind: "reported",
          citation: normalized.citation,
          ...(normalized.reportedAt === undefined ? {} : { reportedAt: normalized.reportedAt }),
          rerunStatus: "not_rerun",
        },
      };
      if (previous && sameBaselineWithoutRecordedAt(previous.payload, payload)) {
        return { manifest: previousManifest(manifest), value: previous };
      }
      const baseline = makeEnvelope<"baseline_observation", BaselineObservationPayload>({
        kind: "baseline_observation",
        artifactId: baselineId,
        revision: (previous?.revision ?? 0) + 1,
        payload,
        parents: [
          { relation: "derived_from" as const, artifact: toResearchArtifactRef(spec) },
          ...(previous ? [{ relation: "supersedes" as const, artifact: toResearchArtifactRef(previous) }] : []),
        ],
        now,
        toolName: "experiment_baseline",
        createdAt: previous?.createdAt,
      }) as BaselineObservation;
      return {
        manifest: nextManifest(manifest, now, { baselineObservations: sortEnvelopes([...manifest.baselineObservations, baseline]) }),
        value: baseline,
      };
    },
  });
  return result;
}

export async function recordObservedBaseline(input: {
  projectRoot: string;
  baseline: ObservedBaselineInput;
  expectedManifestRevision?: number;
  now?: Date;
}): Promise<ExperimentOperationResult<BaselineObservation>> {
  const experimentId = requireInputIdentifier(input.baseline.experimentId, "experimentId");
  const runAttemptId = requireInputIdentifier(input.baseline.runAttemptId, "runAttemptId");
  const metricObservationId = requireInputIdentifier(input.baseline.metricObservationId, "metricObservationId");
  const baselineId = input.baseline.baselineId === undefined
    ? `baseline-${randomUUID()}`
    : requireInputIdentifier(input.baseline.baselineId, "baselineId");
  const result = await updateProjectExperimentManifest({
    projectRoot: input.projectRoot,
    expectedRevision: input.expectedManifestRevision,
    now: input.now,
    update: (existing, now) => {
      const manifest = requireManifest(existing);
      const spec = requireLatestSpec(manifest, experimentId);
      const run = requireLatestRun(manifest, runAttemptId);
      const metric = latestById(manifest.metricObservations, metricObservationId);
      if (!metric) throw new ExperimentServiceError("not_found", `Metric observation not found: ${metricObservationId}.`);
      if (run.payload.experimentId !== experimentId || metric.payload.experimentId !== experimentId
        || metric.payload.runAttemptId !== runAttemptId) {
        throw new ExperimentServiceError("invalid_input", "Observed baseline provenance does not belong to the requested experiment/run.");
      }
      const previous = latestById(manifest.baselineObservations, baselineId);
      const payload: BaselineObservationPayload = {
        baselineId,
        experimentId,
        metricName: metric.payload.name,
        value: metric.payload.value,
        ...(metric.payload.unit === undefined ? {} : { unit: metric.payload.unit }),
        ...(metric.payload.split === undefined ? {} : { split: metric.payload.split }),
        direction: metric.payload.direction,
        recordedAt: now.toISOString(),
        provenance: { kind: "observed", runAttemptId, metricObservationId },
      };
      if (previous && sameBaselineWithoutRecordedAt(previous.payload, payload)) {
        return { manifest: previousManifest(manifest), value: previous };
      }
      const baseline = makeEnvelope<"baseline_observation", BaselineObservationPayload>({
        kind: "baseline_observation",
        artifactId: baselineId,
        revision: (previous?.revision ?? 0) + 1,
        payload,
        parents: [
          { relation: "uses", artifact: toResearchArtifactRef(spec) },
          { relation: "derived_from", artifact: toResearchArtifactRef(metric) },
          ...(previous ? [{ relation: "supersedes" as const, artifact: toResearchArtifactRef(previous) }] : []),
        ],
        now,
        toolName: "experiment_baseline",
        createdAt: previous?.createdAt,
      }) as BaselineObservation;
      return {
        manifest: nextManifest(manifest, now, { baselineObservations: sortEnvelopes([...manifest.baselineObservations, baseline]) }),
        value: baseline,
      };
    },
  });
  return result;
}

export async function prepareExperimentRun(input: {
  projectRoot: string;
  experimentId: string;
  grantId: string;
  jobId: string;
  expectedManifestRevision?: number;
  now?: Date;
}): Promise<ExperimentOperationResult<RunAttempt>> {
  const experimentId = requireInputIdentifier(input.experimentId, "experimentId");
  const grantId = requireInputIdentifier(input.grantId, "grantId");
  const jobId = requireJobId(input.jobId);
  const result = await updateProjectExperimentManifest<{ attempt: RunAttempt; duplicate: boolean }>({
    projectRoot: input.projectRoot,
    expectedRevision: input.expectedManifestRevision,
    now: input.now,
    update: (existing, now) => {
      const manifest = requireManifest(existing);
      const spec = requireLatestSpec(manifest, experimentId);
      const grant = requireLatestGrant(manifest, grantId);
      assertGrantUsable(grant, spec, "prepare", jobId, now);
      const duplicate = findLatestRunByJobId(manifest, jobId);
      if (duplicate) {
        if (duplicate.payload.experimentId !== experimentId) {
          throw new ExperimentServiceError("invalid_input", `jobId ${jobId} is already bound to another experiment.`);
        }
        return { manifest: previousManifest(manifest), value: { attempt: duplicate, duplicate: true } };
      }
      const attemptId = `run-${randomUUID()}`;
      const payload: RunAttemptPayload = {
        attemptId,
        experimentId,
        specRevision: spec.revision,
        specDigest: spec.contentHash,
        adapterId: spec.payload.adapterId,
        jobId,
        status: "prepared",
        grantMode: grant.payload.mode,
        preparedAt: now.toISOString(),
        grantId,
        workspaceRelativePath: `runs/${attemptId}`,
        artifactIds: [],
        metricObservationIds: [],
      };
      const attempt = makeEnvelope<"run_attempt", RunAttemptPayload>({
        kind: "run_attempt",
        artifactId: attemptId,
        revision: 1,
        payload,
        parents: [
          { relation: "derived_from", artifact: toResearchArtifactRef(spec) },
          { relation: "uses", artifact: toResearchArtifactRef(grant) },
        ],
        now,
        toolName: "experiment_run",
      }) as RunAttempt;
      return {
        manifest: nextManifest(manifest, now, { runAttempts: sortEnvelopes([...manifest.runAttempts, attempt]) }),
        value: { attempt, duplicate: false },
      };
    },
  });
  return { ...result, value: result.value.attempt, duplicate: result.value.duplicate };
}

export async function submitLocalExperimentRun(input: {
  projectRoot: string;
  experimentId: string;
  grantId: string;
  jobId: string;
  attemptId?: string;
  expectedManifestRevision?: number;
  now?: Date;
  abortSignal?: AbortSignal;
}): Promise<ExperimentOperationResult<RunAttempt>> {
  const prepared = input.attemptId
    ? await loadPreparedAttempt(input)
    : await prepareExperimentRun({
      projectRoot: input.projectRoot,
      experimentId: input.experimentId,
      grantId: input.grantId,
      jobId: input.jobId,
      expectedManifestRevision: input.expectedManifestRevision,
      now: input.now,
    });
  const attempt = prepared.value;
  const manifest = prepared.manifest;
  if (attempt.payload.status !== "prepared") return { ...prepared, duplicate: true };
  const queued = await queueAttempt({
    projectRoot: input.projectRoot,
    experimentId: input.experimentId,
    grantId: input.grantId,
    attemptId: attempt.payload.attemptId,
    now: input.now,
  });
  if (queued.value.payload.status !== "queued") return { ...queued, duplicate: true };
  const running = await markAttemptRunning({
    projectRoot: input.projectRoot,
    attemptId: queued.value.payload.attemptId,
    now: input.now,
  });
  if (running.value.payload.status !== "running" || !running.claimed) return { ...running, duplicate: true };
  const specManifest = requireManifest(running.manifest);
  const spec = findSpecByRevision(specManifest, running.value.payload.experimentId, running.value.payload.specRevision);
  if (!spec) throw new ExperimentServiceError("invalid_state", "The run's pinned experiment spec is missing.");
  let execution: LocalWorkerExecution;
  try {
    execution = await executeLocalWorker({ projectRoot: input.projectRoot, attempt: running.value, spec, abortSignal: input.abortSignal });
  } catch (error) {
    const failure = classifyWorkerFailure(error, input.now ?? new Date());
    const failed = await finalizeAttemptFailure({
      projectRoot: input.projectRoot,
      attemptId: running.value.payload.attemptId,
      failure,
      now: input.now,
    });
    return { ...failed, duplicate: false };
  }
  let collected: CollectedArtifact[];
  try {
    collected = await collectArtifacts({
      projectRoot: input.projectRoot,
      attempt: running.value,
      artifacts: execution.artifacts,
    });
  } catch (error) {
    const failure = classifyWorkerFailure(error, input.now ?? new Date(), "artifact_missing");
    const failed = await finalizeAttemptFailure({
      projectRoot: input.projectRoot,
      attemptId: running.value.payload.attemptId,
      failure,
      now: input.now,
    });
    return { ...failed, duplicate: false };
  }
  const finished = await finalizeAttemptSuccess({
    projectRoot: input.projectRoot,
    attempt: running.value,
    metrics: execution.metrics,
    metricSource: spec.payload.localWorker?.kind === "mock" ? "local_mock" : "local_worker",
    artifacts: collected,
    now: input.now,
  });
  return { ...finished, duplicate: false };
}

export async function recoverProjectExperimentState(input: {
  projectRoot: string;
  jobId?: string;
  now?: Date;
}): Promise<ExperimentManifest> {
  const jobId = input.jobId === undefined ? undefined : requireJobId(input.jobId);
  const result = await updateProjectExperimentManifest({
    projectRoot: input.projectRoot,
    now: input.now,
    update: (existing, now) => {
      const manifest = requireManifest(existing);
      const active = latestEnvelopes(manifest.runAttempts).filter((attempt) =>
        ["queued", "running"].includes(attempt.payload.status)
        && (jobId === undefined || attempt.payload.jobId === jobId));
      if (active.length === 0) return { manifest: previousManifest(manifest), value: manifest };
      const attempts = [...manifest.runAttempts];
      for (const attempt of active) {
        const payload: RunAttemptPayload = {
          ...attempt.payload,
          status: "recovery_required",
          finishedAt: now.toISOString(),
          failure: {
            category: "disconnected",
            message: "The host disconnected while this run was queued or running; recovery did not resubmit the job.",
            retryable: true,
            observedAt: now.toISOString(),
          },
        };
        attempts.push(makeEnvelope<"run_attempt", RunAttemptPayload>({
          kind: "run_attempt",
          artifactId: attempt.artifactId,
          revision: attempt.revision + 1,
          payload,
          parents: [{ relation: "supersedes", artifact: toResearchArtifactRef(attempt) }],
          now,
          toolName: "experiment_recovery",
          createdAt: attempt.createdAt,
        }) as RunAttempt);
      }
      return { manifest: nextManifest(manifest, now, { runAttempts: sortEnvelopes(attempts) }), value: manifest };
    },
  });
  return result.manifest;
}

/** Recovers one stable job identity without ever creating or resubmitting it. */
export async function recoverExperimentJob(input: {
  projectRoot: string;
  jobId: string;
  now?: Date;
}): Promise<RunAttempt> {
  const jobId = requireJobId(input.jobId);
  const manifest = await recoverProjectExperimentState({ projectRoot: input.projectRoot, jobId, now: input.now });
  const run = findLatestRunByJobId(manifest, jobId);
  if (!run) throw new ExperimentServiceError("not_found", `Run job not found: ${jobId}.`);
  return run;
}

async function queueAttempt(input: {
  projectRoot: string;
  experimentId: string;
  grantId: string;
  attemptId: string;
  now?: Date;
}): Promise<ExperimentOperationResult<RunAttempt>> {
  const result = await updateProjectExperimentManifest({
    projectRoot: input.projectRoot,
    now: input.now,
    update: (existing, now) => {
      const manifest = requireManifest(existing);
      const current = requireLatestRun(manifest, input.attemptId);
      if (current.payload.status !== "prepared") return { manifest: previousManifest(manifest), value: current };
      const spec = findSpecByRevision(manifest, current.payload.experimentId, current.payload.specRevision);
      if (!spec) throw new ExperimentServiceError("invalid_state", "The prepared run's experiment spec is missing.");
      const grant = requireLatestGrant(manifest, input.grantId);
      assertGrantUsable(grant, spec, "execute", current.payload.jobId, now);
      if (grant.payload.consumedAttemptIds.includes(current.payload.attemptId)) {
        return { manifest: previousManifest(manifest), value: current };
      }
      if (grant.payload.consumedAttemptIds.length >= grant.payload.budget.maxAttempts) {
        throw new ExperimentServiceError("permission_denied", "Execution grant has no remaining attempts.");
      }
      const grantPayload: ExecutionGrantPayload = {
        ...grant.payload,
        consumedJobIds: [...grant.payload.consumedJobIds, current.payload.jobId],
        consumedAttemptIds: [...grant.payload.consumedAttemptIds, current.payload.attemptId],
      };
      const consumedGrant = makeEnvelope<"execution_grant", ExecutionGrantPayload>({
        kind: "execution_grant",
        artifactId: grant.artifactId,
        revision: grant.revision + 1,
        payload: grantPayload,
        parents: [{ relation: "supersedes", artifact: toResearchArtifactRef(grant) }],
        now,
        toolName: "experiment_run",
        createdAt: grant.createdAt,
      }) as ExecutionGrant;
      const queuedPayload: RunAttemptPayload = {
        ...current.payload,
        grantId: consumedGrant.payload.grantId,
        status: "queued",
        queuedAt: now.toISOString(),
        grantMode: grant.payload.mode,
      };
      const queued = makeEnvelope<"run_attempt", RunAttemptPayload>({
        kind: "run_attempt",
        artifactId: current.artifactId,
        revision: current.revision + 1,
        payload: queuedPayload,
        parents: [
          { relation: "supersedes", artifact: toResearchArtifactRef(current) },
          { relation: "uses", artifact: toResearchArtifactRef(consumedGrant) },
        ],
        now,
        toolName: "experiment_run",
        createdAt: current.createdAt,
      }) as RunAttempt;
      return {
        manifest: nextManifest(manifest, now, {
          executionGrants: sortEnvelopes([...manifest.executionGrants, consumedGrant]),
          runAttempts: sortEnvelopes([...manifest.runAttempts, queued]),
        }),
        value: queued,
      };
    },
  });
  return result;
}

async function markAttemptRunning(input: {
  projectRoot: string;
  attemptId: string;
  now?: Date;
}): Promise<ExperimentOperationResult<RunAttempt> & { claimed: boolean }> {
  const result = await updateProjectExperimentManifest<{ attempt: RunAttempt; claimed: boolean }>({
    projectRoot: input.projectRoot,
    now: input.now,
    update: (existing, now) => {
      const manifest = requireManifest(existing);
      const current = requireLatestRun(manifest, input.attemptId);
      if (current.payload.status !== "queued") {
        return { manifest: previousManifest(manifest), value: { attempt: current, claimed: false } };
      }
      const running = makeEnvelope<"run_attempt", RunAttemptPayload>({
        kind: "run_attempt",
        artifactId: current.artifactId,
        revision: current.revision + 1,
        payload: { ...current.payload, status: "running", startedAt: now.toISOString() },
        parents: [{ relation: "supersedes", artifact: toResearchArtifactRef(current) }],
        now,
        toolName: "experiment_run",
        createdAt: current.createdAt,
      }) as RunAttempt;
      return {
        manifest: nextManifest(manifest, now, { runAttempts: sortEnvelopes([...manifest.runAttempts, running]) }),
        value: { attempt: running, claimed: true },
      };
    },
  });
  return { ...result, value: result.value.attempt, claimed: result.value.claimed };
}

async function finalizeAttemptSuccess(input: {
  projectRoot: string;
  attempt: RunAttempt;
  metrics: readonly WorkerMetricInput[];
  metricSource: MetricObservationPayload["source"];
  artifacts: readonly CollectedArtifact[];
  now?: Date;
}): Promise<ExperimentOperationResult<RunAttempt>> {
  const result = await updateProjectExperimentManifest({
    projectRoot: input.projectRoot,
    now: input.now,
    update: (existing, now) => {
      const manifest = requireManifest(existing);
      const current = requireLatestRun(manifest, input.attempt.payload.attemptId);
      if (current.payload.status !== "running") return { manifest: previousManifest(manifest), value: current };
      const metrics: MetricObservation[] = [];
      const artifacts: ResearchArtifactEnvelope[] = [];
      const files: ExperimentArtifactFile[] = [];
      for (const [index, metric] of input.metrics.entries()) {
        const metricId = `metric-${input.attempt.payload.attemptId}-${index}-${randomUUID()}`;
        const payload: MetricObservationPayload = {
          observationId: metricId,
          experimentId: current.payload.experimentId,
          runAttemptId: current.payload.attemptId,
          name: metric.name,
          value: metric.value,
          ...(metric.unit === undefined ? {} : { unit: metric.unit }),
          ...(metric.split === undefined ? {} : { split: metric.split }),
          direction: metric.direction ?? "neutral",
          observedAt: now.toISOString(),
          source: input.metricSource,
        };
        metrics.push(makeEnvelope<"metric_observation", MetricObservationPayload>({
          kind: "metric_observation",
          artifactId: metricId,
          revision: 1,
          payload,
          parents: [{ relation: "derived_from", artifact: toResearchArtifactRef(current) }],
          now,
          toolName: "experiment_run",
        }) as MetricObservation);
      }
      for (const [index, artifact] of input.artifacts.entries()) {
        const artifactId = `artifact-${input.attempt.payload.attemptId}-${index}-${randomUUID()}`;
        const kind = artifact.role === "figure" || artifact.role === "table" ? "figure_table" as const : "implementation_snapshot" as const;
        const payload = {
          experimentId: current.payload.experimentId,
          runAttemptId: current.payload.attemptId,
          relativePath: artifact.relativePath,
          sha256: `sha256:${artifact.sha256}`,
          bytes: artifact.bytes,
          ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
          role: artifact.role,
        };
        const envelope = createResearchArtifact({
          kind,
          artifactId,
          revision: 1,
          payload,
          producer: { kind: "tool", id: "experimentation", toolName: "experiment_run" },
          parents: [{ relation: "derived_from", artifact: toResearchArtifactRef(current) }],
          now,
        });
        artifacts.push(envelope);
        files.push({
          ref: toResearchArtifactRef(envelope),
          experimentId: current.payload.experimentId,
          runAttemptId: current.payload.attemptId,
          relativePath: artifact.relativePath,
          bytes: artifact.bytes,
          ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
          role: artifact.role,
          createdAt: now.toISOString(),
        });
      }
      const finishedPayload: RunAttemptPayload = {
        ...current.payload,
        status: "succeeded",
        finishedAt: now.toISOString(),
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
        metricObservationIds: metrics.map((metric) => metric.artifactId),
      };
      const finished = makeEnvelope<"run_attempt", RunAttemptPayload>({
        kind: "run_attempt",
        artifactId: current.artifactId,
        revision: current.revision + 1,
        payload: finishedPayload,
        parents: [{ relation: "supersedes", artifact: toResearchArtifactRef(current) }],
        now,
        toolName: "experiment_run",
        createdAt: current.createdAt,
      }) as RunAttempt;
      return {
        manifest: nextManifest(manifest, now, {
          runAttempts: sortEnvelopes([...manifest.runAttempts, finished]),
          metricObservations: sortEnvelopes([...manifest.metricObservations, ...metrics]),
          artifactEnvelopes: sortEnvelopes([...manifest.artifactEnvelopes, ...artifacts]),
          artifactFiles: [...manifest.artifactFiles, ...files],
          artifactRefs: [...manifest.artifactRefs, ...files.map((file) => file.ref)],
        }),
        value: finished,
      };
    },
  });
  return result;
}

async function finalizeAttemptFailure(input: {
  projectRoot: string;
  attemptId: string;
  failure: ExperimentFailure;
  now?: Date;
}): Promise<ExperimentOperationResult<RunAttempt>> {
  const result = await updateProjectExperimentManifest({
    projectRoot: input.projectRoot,
    now: input.now,
    update: (existing, now) => {
      const manifest = requireManifest(existing);
      const current = requireLatestRun(manifest, input.attemptId);
      if (current.payload.status !== "running") return { manifest: previousManifest(manifest), value: current };
      const failed = makeEnvelope<"run_attempt", RunAttemptPayload>({
        kind: "run_attempt",
        artifactId: current.artifactId,
        revision: current.revision + 1,
        payload: { ...current.payload, status: "failed", finishedAt: now.toISOString(), failure: input.failure },
        parents: [{ relation: "supersedes", artifact: toResearchArtifactRef(current) }],
        now,
        toolName: "experiment_run",
        createdAt: current.createdAt,
      }) as RunAttempt;
      return { manifest: nextManifest(manifest, now, { runAttempts: sortEnvelopes([...manifest.runAttempts, failed]) }), value: failed };
    },
  });
  return result;
}

async function loadPreparedAttempt(input: {
  projectRoot: string;
  experimentId: string;
  grantId: string;
  jobId: string;
  attemptId?: string;
  expectedManifestRevision?: number;
  now?: Date;
}): Promise<ExperimentOperationResult<RunAttempt>> {
  const manifest = await loadProjectExperimentManifest({ projectRoot: input.projectRoot });
  if (!manifest) throw new ExperimentServiceError("not_found", "No experiment manifest exists.");
  const attempt = input.attemptId
    ? latestById(manifest.runAttempts, input.attemptId)
    : findLatestRunByJobId(manifest, input.jobId);
  if (!attempt) throw new ExperimentServiceError("not_found", "Prepared run attempt was not found.");
  if (attempt.payload.experimentId !== input.experimentId || attempt.payload.jobId !== input.jobId) {
    throw new ExperimentServiceError("invalid_input", "attemptId does not match experimentId/jobId.");
  }
  return { value: attempt, manifest, path: getProjectExperimentPaths({ projectRoot: input.projectRoot }).manifestPath, created: false, persisted: false };
}

type CollectedArtifact = Readonly<{
  relativePath: string;
  sha256: string;
  bytes: number;
  mediaType?: string;
  role: ExperimentArtifactFile["role"];
}>;

async function collectArtifacts(input: {
  projectRoot: string;
  attempt: RunAttempt;
  artifacts: readonly WorkerArtifactInput[];
}): Promise<CollectedArtifact[]> {
  const workspace = getExperimentRunWorkspacePath({ projectRoot: input.projectRoot, attemptId: input.attempt.payload.attemptId });
  let workspaceRealPath: string;
  try {
    workspaceRealPath = await realpath(workspace);
  } catch (error) {
    throw new LocalWorkerFailure("artifact_missing", `Run workspace is unavailable: ${messageOf(error)}.`);
  }
  const seen = new Set<string>();
  const result: CollectedArtifact[] = [];
  for (const artifact of input.artifacts) {
    const relativePath = normalizeRelativeArtifactPath(artifact.path);
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    const fullPath = resolve(workspace, relativePath);
    const relativeCheck = relative(workspace, fullPath);
    if (relativeCheck === "" || relativeCheck.startsWith("..") || resolve(workspace, relativeCheck) !== fullPath) {
      throw new LocalWorkerFailure("artifact_missing", `Artifact path escapes the run directory: ${relativePath}.`);
    }
    let stats;
    try { stats = await lstat(fullPath); } catch (error) {
      throw new LocalWorkerFailure("artifact_missing", `Artifact ${relativePath} is missing: ${messageOf(error)}.`);
    }
    if (!stats.isFile() || stats.isSymbolicLink()) throw new LocalWorkerFailure("artifact_missing", `Artifact ${relativePath} is not a regular file.`);
    let realArtifactPath: string;
    try {
      realArtifactPath = await realpath(fullPath);
    } catch (error) {
      throw new LocalWorkerFailure("artifact_missing", `Artifact ${relativePath} cannot be resolved: ${messageOf(error)}.`);
    }
    const realRelativeCheck = relative(workspaceRealPath, realArtifactPath);
    if (realRelativeCheck === "" || realRelativeCheck.startsWith("..") || resolve(workspaceRealPath, realRelativeCheck) !== realArtifactPath) {
      throw new LocalWorkerFailure("artifact_missing", `Artifact path resolves outside the run directory: ${relativePath}.`);
    }
    const hash = await hashFile(realArtifactPath);
    result.push({
      relativePath,
      sha256: hash.sha256,
      bytes: hash.bytes,
      ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
      role: artifact.role ?? "output",
    });
  }
  return result;
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; hash.update(chunk); });
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return { sha256: hash.digest("hex"), bytes };
}

function classifyWorkerFailure(error: unknown, now: Date, override?: "artifact_missing"): ExperimentFailure {
  const category = override ?? (error instanceof LocalWorkerFailure ? error.category : "unknown");
  const message = error instanceof Error ? error.message : String(error);
  const failure: ExperimentFailure = {
    category,
    message,
    retryable: [
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
      "rate_limited",
      "unknown",
    ].includes(category),
    observedAt: now.toISOString(),
    ...(error instanceof LocalWorkerFailure && error.exitCode !== undefined ? { exitCode: error.exitCode } : {}),
    ...(error instanceof LocalWorkerFailure && error.signal !== undefined ? { signal: error.signal } : {}),
  };
  return failure;
}

function normalizeSpecInput(input: ExperimentSpecInput): NormalizedExperimentSpecInput {
  if (!isRecord(input) || typeof input.title !== "string" || !input.title.trim()) {
    throw new ExperimentServiceError("invalid_input", "Experiment spec title must be non-empty text.");
  }
  const allowedKeys = new Set([
    "experimentId", "title", "description", "hypothesisId", "adapterId", "defaultGrantMode",
    "expectedMetrics", "tags", "localWorker", "parents", "sourceArtifacts",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw new ExperimentServiceError("invalid_input", `Experiment spec does not accept ${key}.`);
  }
  const experimentId = input.experimentId ?? `experiment-${randomUUID()}`;
  requireInputIdentifier(experimentId, "experimentId");
  const adapterId = input.adapterId ?? "local";
  assertAdapterId(adapterId);
  const mode = input.defaultGrantMode ?? "plan_only";
  assertGrantMode(mode);
  const expectedMetrics = uniqueTextArray(input.expectedMetrics ?? [], "expectedMetrics");
  const tags = uniqueTextArray(input.tags ?? [], "tags");
  const localWorker = input.localWorker === undefined ? undefined : normalizeLocalWorkerDefinition(input.localWorker);
  if (adapterId !== "local" && input.localWorker !== undefined) {
    throw new ExperimentServiceError("invalid_input", "Only the local adapter accepts a local worker definition.");
  }
  const parents = normalizeSpecSourceParents(input.parents);
  const sourceArtifacts = normalizeSpecSourceArtifacts(input.sourceArtifacts);
  if (sourceArtifacts.length > 0 && parents.length === 0) {
    throw new ExperimentServiceError("invalid_input", "sourceArtifacts require at least one explicit ExperimentSpec parent.");
  }
  return Object.freeze({
    payload: {
      experimentId,
      title: requireText(input.title.trim(), "title"),
      ...(input.description === undefined ? {} : { description: requireText(input.description, "description") }),
      ...(input.hypothesisId === undefined ? {} : { hypothesisId: requireInputIdentifier(input.hypothesisId, "hypothesisId") }),
      adapterId,
      defaultGrantMode: mode,
      expectedMetrics,
      tags,
      ...(localWorker === undefined ? {} : { localWorker }),
    },
    parents,
    sourceArtifacts,
  });
}

function normalizeSpecSourceParents(value: unknown): readonly ResearchArtifactParent[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new ExperimentServiceError("invalid_input", "Experiment spec parents must be an array.");
  const parents = mergeArtifactParents(value.map((parent, index) => normalizeArtifactParent(parent, `parents[${index}]`)));
  if (parents.some((parent) => parent.relation === "supersedes")) {
    throw new ExperimentServiceError("invalid_input", "Experiment spec source parents cannot use supersedes; revisions add it automatically.");
  }
  return parents;
}

function normalizeSpecSourceArtifacts(value: unknown): readonly ResearchArtifactEnvelope[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new ExperimentServiceError("invalid_input", "sourceArtifacts must be an array of complete artifact envelopes.");
  const artifacts = new Map<string, ResearchArtifactEnvelope>();
  for (const [index, entry] of value.entries()) {
    const artifact = normalizeSourceArtifactEnvelope(entry, `sourceArtifacts[${index}]`);
    const key = researchArtifactKey(artifact);
    const previous = artifacts.get(key);
    if (previous && !sameCanonicalJson(previous, artifact)) {
      throw new ExperimentServiceError("invalid_input", `sourceArtifacts contains conflicting envelopes for ${key}.`);
    }
    artifacts.set(key, artifact);
  }
  return Object.freeze(sortEnvelopes([...artifacts.values()]));
}

function normalizeArtifactParent(value: unknown, label: string): ResearchArtifactParent {
  try {
    const probe = createResearchArtifact({
      kind: "experiment_spec",
      artifactId: "experiment-spec-parent-validation",
      revision: 1,
      payload: { label },
      producer: { kind: "tool", id: "experimentation", toolName: "experiment_spec" },
      parents: [value as ResearchArtifactParent],
      now: new Date(0),
    });
    return probe.parents[0]!;
  } catch (error) {
    throw new ExperimentServiceError("invalid_input", `${label} must contain a valid research artifact relation and reference: ${messageOf(error)}`);
  }
}

function mergeArtifactParents(values: readonly ResearchArtifactParent[]): readonly ResearchArtifactParent[] {
  const parents = new Map<string, ResearchArtifactParent>();
  const refs = new Map<string, ResearchArtifactRef>();
  for (const value of values) {
    const parent = normalizeArtifactParent(value, "artifact parent");
    const refKey = researchArtifactKey(parent.artifact);
    const knownRef = refs.get(refKey);
    if (knownRef && (knownRef.kind !== parent.artifact.kind || knownRef.contentHash !== parent.artifact.contentHash)) {
      throw new ExperimentServiceError("invalid_input", `Artifact parent ${refKey} has conflicting kind or content hash.`);
    }
    refs.set(refKey, parent.artifact);
    parents.set(artifactParentKey(parent), parent);
  }
  return Object.freeze([...parents.values()].sort(compareArtifactParents));
}

function normalizeSourceArtifactEnvelope(value: unknown, label: string): ResearchArtifactEnvelope {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.kind !== "string"
    || typeof value.artifactId !== "string" || !Number.isSafeInteger(value.revision)
    || typeof value.status !== "string" || typeof value.contentHash !== "string"
    || !Array.isArray(value.parents) || !Array.isArray(value.sources) || !isRecord(value.producer)
    || !("payload" in value)) {
    throw new ExperimentServiceError("invalid_input", `${label} must be a complete research artifact envelope.`);
  }
  const createdAt = requireArtifactTimestamp(value.createdAt, `${label}.createdAt`);
  const updatedAt = requireArtifactTimestamp(value.updatedAt, `${label}.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new ExperimentServiceError("invalid_input", `${label}.updatedAt cannot precede createdAt.`);
  }
  let rebuilt: ResearchArtifactEnvelope;
  try {
    rebuilt = createResearchArtifact({
      kind: value.kind as ResearchArtifactEnvelope["kind"],
      artifactId: value.artifactId,
      revision: value.revision,
      status: value.status as ResearchArtifactEnvelope["status"],
      payload: value.payload,
      producer: value.producer as ResearchArtifactEnvelope["producer"],
      parents: value.parents as ResearchArtifactParent[],
      sources: value.sources,
      now: new Date(createdAt),
    });
  } catch (error) {
    throw new ExperimentServiceError("invalid_input", `${label} is not a valid research artifact envelope: ${messageOf(error)}`);
  }
  if (rebuilt.contentHash !== value.contentHash) {
    throw new ExperimentServiceError("invalid_input", `${label}.contentHash does not match its immutable content.`);
  }
  const invalidation = value.invalidation === undefined
    ? undefined
    : normalizeArtifactInvalidation(value.invalidation, `${label}.invalidation`);
  return Object.freeze({
    ...rebuilt,
    createdAt,
    updatedAt,
    ...(invalidation === undefined ? {} : { invalidation }),
  });
}

function normalizeArtifactInvalidation(value: unknown, label: string): ResearchArtifactInvalidation {
  if (!isRecord(value) || !Array.isArray(value.roots) || value.roots.length === 0) {
    throw new ExperimentServiceError("invalid_input", `${label} must contain one or more root references.`);
  }
  if (![
    "upstream_changed", "evidence_withdrawn", "run_failed", "review_finding", "manual",
  ].includes(value.reason)) {
    throw new ExperimentServiceError("invalid_input", `${label}.reason is invalid.`);
  }
  const roots = new Map<string, ResearchArtifactRef>();
  for (const [index, root] of value.roots.entries()) {
    const reference = normalizeArtifactParent({ relation: "uses", artifact: root }, `${label}.roots[${index}]`).artifact;
    roots.set(artifactReferenceKey(reference), reference);
  }
  return Object.freeze({
    invalidatedAt: requireArtifactTimestamp(value.invalidatedAt, `${label}.invalidatedAt`),
    reason: value.reason as ResearchArtifactInvalidation["reason"],
    roots: [...roots.values()].sort(compareArtifactRefs),
  });
}

function projectSpecSourceArtifacts(
  manifest: ExperimentManifest | undefined,
  sourceArtifacts: readonly ResearchArtifactEnvelope[],
): readonly ResearchArtifactEnvelope[] {
  const projected = [...(manifest?.artifactEnvelopes ?? [])];
  const occupied = new Map<string, ResearchArtifactEnvelope>();
  for (const artifact of allManifestArtifacts(manifest, projected)) occupied.set(researchArtifactKey(artifact), artifact);
  for (const artifact of sourceArtifacts) {
    const key = researchArtifactKey(artifact);
    const previous = occupied.get(key);
    if (previous) {
      if (!sameCanonicalJson(previous, artifact)) {
        throw new ExperimentServiceError("invalid_input", `Source artifact ${key} conflicts with an existing Project artifact.`);
      }
      continue;
    }
    projected.push(artifact);
    occupied.set(key, artifact);
  }
  return sortEnvelopes(projected);
}

function assertSpecSourceDependencies(input: {
  manifest: ExperimentManifest | undefined;
  projectedArtifacts: readonly ResearchArtifactEnvelope[];
  parents: readonly ResearchArtifactParent[];
  sourceArtifacts: readonly ResearchArtifactEnvelope[];
}): void {
  const artifacts = allManifestArtifacts(input.manifest, input.projectedArtifacts);
  let byKey: Map<string, ResearchArtifactEnvelope>;
  try {
    const graph = buildResearchArtifactGraph(artifacts);
    if (graph.missingParents.length > 0) {
      throw new TypeError(`Artifact graph has ${graph.missingParents.length} missing parent reference(s).`);
    }
    byKey = new Map(artifacts.map((artifact) => [researchArtifactKey(artifact), artifact]));
  } catch (error) {
    throw new ExperimentServiceError("invalid_input", `sourceArtifacts must form a complete, valid Artifact DAG closure: ${messageOf(error)}`);
  }
  const roots: string[] = [];
  for (const parent of input.parents) {
    const key = researchArtifactKey(parent.artifact);
    const target = byKey.get(key);
    if (!target || target.kind !== parent.artifact.kind || target.contentHash !== parent.artifact.contentHash) {
      throw new ExperimentServiceError("invalid_input", `Experiment spec parent ${artifactReferenceKey(parent.artifact)} is not resolved by sourceArtifacts or this Project manifest.`);
    }
    roots.push(key);
  }
  const reachable = ancestorArtifactKeys(roots, byKey);
  for (const artifact of input.sourceArtifacts) {
    const key = researchArtifactKey(artifact);
    if (!reachable.has(key)) {
      throw new ExperimentServiceError("invalid_input", `sourceArtifact ${key} is not a declared ExperimentSpec parent or its ancestor.`);
    }
    for (const root of artifact.invalidation?.roots ?? []) {
      const target = byKey.get(researchArtifactKey(root));
      if (!target || target.kind !== root.kind || target.contentHash !== root.contentHash) {
        throw new ExperimentServiceError("invalid_input", `sourceArtifact invalidation root ${artifactReferenceKey(root)} is not resolved by the supplied closure.`);
      }
    }
  }
}

function allManifestArtifacts(
  manifest: ExperimentManifest | undefined,
  artifactEnvelopes: readonly ResearchArtifactEnvelope[],
): readonly ResearchArtifactEnvelope[] {
  return [
    ...(manifest?.specs ?? []),
    ...(manifest?.executionGrants ?? []),
    ...(manifest?.runAttempts ?? []),
    ...(manifest?.metricObservations ?? []),
    ...(manifest?.baselineObservations ?? []),
    ...artifactEnvelopes,
  ];
}

function ancestorArtifactKeys(
  roots: readonly string[],
  artifacts: ReadonlyMap<string, ResearchArtifactEnvelope>,
): ReadonlySet<string> {
  const reachable = new Set<string>();
  const queue = [...roots];
  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index];
    if (!key || reachable.has(key)) continue;
    const artifact = artifacts.get(key);
    if (!artifact) continue;
    reachable.add(key);
    for (const parent of artifact.parents) queue.push(researchArtifactKey(parent.artifact));
  }
  return reachable;
}

function sameSpecTerms(previous: ExperimentSpec, next: NormalizedExperimentSpecInput): boolean {
  const sourceParents = previous.parents.filter((parent) => parent.relation !== "supersedes");
  return sameCanonicalJson(previous.payload, next.payload)
    && sameCanonicalJson(mergeArtifactParents(sourceParents), next.parents);
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function artifactReferenceKey(ref: ResearchArtifactRef): string {
  return `${ref.kind}:${researchArtifactKey(ref)}:${ref.contentHash}`;
}

function artifactParentKey(parent: ResearchArtifactParent): string {
  return `${parent.relation}:${artifactReferenceKey(parent.artifact)}`;
}

function compareArtifactParents(left: ResearchArtifactParent, right: ResearchArtifactParent): number {
  return artifactParentKey(left).localeCompare(artifactParentKey(right), "en");
}

function compareArtifactRefs(left: ResearchArtifactRef, right: ResearchArtifactRef): number {
  return artifactReferenceKey(left).localeCompare(artifactReferenceKey(right), "en");
}

function requireArtifactTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ExperimentServiceError("invalid_input", `${label} must be an ISO date.`);
  }
  return value;
}

function normalizeGrantInput(input: ExecutionGrantInput): ExecutionGrantInput & {
  budget: { maxAttempts: number; maxWallTimeMs?: number; maxCostUsd?: number };
} {
  if (!input || typeof input.experimentId !== "string" || !input.experimentId.trim() || typeof input.reason !== "string" || !input.reason.trim()) {
    throw new ExperimentServiceError("invalid_input", "Execution grant requires experimentId and reason.");
  }
  requireInputIdentifier(input.experimentId, "experimentId");
  const grantId = input.grantId === undefined ? undefined : requireInputIdentifier(input.grantId, "grantId");
  assertGrantMode(input.mode);
  const allowed = input.allowedAdapterIds ?? [];
  for (const adapter of allowed) assertAdapterId(adapter);
  if (input.expiresAt !== undefined && (typeof input.expiresAt !== "string" || Number.isNaN(Date.parse(input.expiresAt)))) {
    throw new ExperimentServiceError("invalid_input", "expiresAt must be an ISO date.");
  }
  const maxAttempts = input.budget?.maxAttempts ?? 1;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10_000) throw new ExperimentServiceError("invalid_input", "maxAttempts must be between 1 and 10000.");
  const maxWallTimeMs = input.budget?.maxWallTimeMs;
  if (maxWallTimeMs !== undefined && (!Number.isSafeInteger(maxWallTimeMs) || maxWallTimeMs < 1)) {
    throw new ExperimentServiceError("invalid_input", "maxWallTimeMs must be a positive integer.");
  }
  const maxCostUsd = input.budget?.maxCostUsd;
  if (maxCostUsd !== undefined && (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd < 0)) {
    throw new ExperimentServiceError("invalid_input", "maxCostUsd must be a finite non-negative number.");
  }
  return {
    experimentId: input.experimentId,
    mode: input.mode,
    reason: requireText(input.reason, "reason"),
    ...(grantId === undefined ? {} : { grantId }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    budget: {
      maxAttempts,
      ...(maxWallTimeMs === undefined ? {} : { maxWallTimeMs }),
      ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    },
    allowedAdapterIds: allowed.length > 0
      ? [...new Set(allowed)].sort((left, right) => left.localeCompare(right, "en"))
      : undefined,
  };
}

function normalizeLocalWorkerDefinition(value: LocalWorkerDefinition): LocalWorkerDefinition {
  if (!isRecord(value)) throw new ExperimentServiceError("invalid_input", "localWorker must be an object.");
  if (value.kind === "process") {
    const command = requireText(value.command, "localWorker.command");
    const args = value.args ?? [];
    if (!Array.isArray(args) || args.length > 256 || args.some((arg) => typeof arg !== "string" || arg.includes("\u0000") || arg.length > 4_096)) {
      throw new ExperimentServiceError("invalid_input", "localWorker.args must contain at most 256 bounded strings without NUL bytes.");
    }
    const timeoutMs = value.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)) {
      throw new ExperimentServiceError("invalid_input", "localWorker.timeoutMs must be between 1 and 300000.");
    }
    return {
      kind: "process",
      command,
      ...(args.length === 0 ? {} : { args: [...args] }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  if (value.kind !== "mock") throw new ExperimentServiceError("invalid_input", "localWorker.kind must be mock or process.");
  if (value.outcome !== undefined && value.outcome !== "succeed" && value.outcome !== "fail") {
    throw new ExperimentServiceError("invalid_input", "localWorker.outcome is invalid.");
  }
  if (value.delayMs !== undefined && (!Number.isSafeInteger(value.delayMs) || value.delayMs < 0 || value.delayMs > 300_000)) {
    throw new ExperimentServiceError("invalid_input", "localWorker.delayMs must be between 0 and 300000.");
  }
  const failureCategories = [
    "invalid_worker_result",
    "worker_exit_nonzero",
    "disconnected",
    "preempted",
    "out_of_memory",
    "rate_limited",
    "unknown",
  ] as const;
  if (value.failureCategory !== undefined && !(failureCategories as readonly string[]).includes(value.failureCategory)) {
    throw new ExperimentServiceError("invalid_input", "localWorker.failureCategory is invalid.");
  }
  if (value.failureMessage !== undefined) requireText(value.failureMessage, "localWorker.failureMessage");
  if (value.result !== undefined) validateMockWorkerResult(value.result);
  return {
    kind: "mock",
    ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
    ...(value.delayMs === undefined ? {} : { delayMs: value.delayMs }),
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(value.failureMessage === undefined ? {} : { failureMessage: value.failureMessage }),
    ...(value.failureCategory === undefined ? {} : { failureCategory: value.failureCategory }),
  };
}

function validateMockWorkerResult(value: NonNullable<Extract<LocalWorkerDefinition, { kind: "mock" }>["result"]>): void {
  if (!isRecord(value)) throw new ExperimentServiceError("invalid_input", "localWorker.result must be an object.");
  if (value.metrics !== undefined) {
    if (!Array.isArray(value.metrics) || value.metrics.length > 1_024) {
      throw new ExperimentServiceError("invalid_input", "localWorker.result.metrics must contain at most 1024 entries.");
    }
    for (const [index, metric] of value.metrics.entries()) {
      if (!isRecord(metric) || typeof metric.name !== "string" || !metric.name.trim()
        || typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
        throw new ExperimentServiceError("invalid_input", `localWorker.result.metrics[${index}] is invalid.`);
      }
      if (metric.direction !== undefined && !["minimize", "maximize", "neutral"].includes(String(metric.direction))) {
        throw new ExperimentServiceError("invalid_input", `localWorker.result.metrics[${index}].direction is invalid.`);
      }
      if (metric.unit !== undefined) requireText(metric.unit, `localWorker.result.metrics[${index}].unit`);
      if (metric.split !== undefined) requireText(metric.split, `localWorker.result.metrics[${index}].split`);
    }
  }
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts) || value.artifacts.length > 1_024) {
      throw new ExperimentServiceError("invalid_input", "localWorker.result.artifacts must contain at most 1024 entries.");
    }
    for (const [index, artifact] of value.artifacts.entries()) {
      if (!isRecord(artifact) || typeof artifact.path !== "string") {
        throw new ExperimentServiceError("invalid_input", `localWorker.result.artifacts[${index}] is invalid.`);
      }
      normalizeWorkerSpecArtifactPath(artifact.path, `localWorker.result.artifacts[${index}].path`);
      if (artifact.content !== undefined && (typeof artifact.content !== "string" || Buffer.byteLength(artifact.content, "utf8") > 1_048_576)) {
        throw new ExperimentServiceError("invalid_input", `localWorker.result.artifacts[${index}].content exceeds 1 MiB.`);
      }
      if (artifact.mediaType !== undefined) requireText(artifact.mediaType, `localWorker.result.artifacts[${index}].mediaType`);
      if (artifact.role !== undefined && !["output", "log", "checkpoint", "figure", "table"].includes(String(artifact.role))) {
        throw new ExperimentServiceError("invalid_input", `localWorker.result.artifacts[${index}].role is invalid.`);
      }
    }
  }
}

function normalizeBaselineInput(input: ReportedBaselineInput): Required<Pick<ReportedBaselineInput, "experimentId" | "metricName" | "reportedValue" | "citation">> & Omit<ReportedBaselineInput, "experimentId" | "metricName" | "reportedValue" | "citation"> & { direction: NonNullable<ReportedBaselineInput["direction"]> } {
  if (!input || typeof input.experimentId !== "string" || typeof input.metricName !== "string" || !input.metricName.trim()
    || typeof input.reportedValue !== "number" || !Number.isFinite(input.reportedValue) || !input.citation || typeof input.citation.text !== "string" || !input.citation.text.trim()) {
    throw new ExperimentServiceError("invalid_input", "Reported baseline requires an experiment, metric, finite value, and citation text.");
  }
  requireInputIdentifier(input.experimentId, "experimentId");
  return {
    ...input,
    direction: input.direction ?? "neutral",
    metricName: input.metricName.trim(),
    citation: { ...input.citation },
  };
}

function assertGrantUsable(
  grant: ExecutionGrant,
  spec: ExperimentSpec,
  operation: "prepare" | "execute",
  jobId: string,
  now: Date,
): void {
  if (grant.payload.status !== "active") throw new ExperimentServiceError("permission_denied", "Execution grant is not active.");
  if (grant.payload.expiresAt && Date.parse(grant.payload.expiresAt) <= now.valueOf()) throw new ExperimentServiceError("permission_denied", "Execution grant has expired.");
  if (grant.payload.experimentId !== spec.payload.experimentId) throw new ExperimentServiceError("permission_denied", "Execution grant belongs to another experiment.");
  if (!grant.payload.allowedAdapterIds.includes(spec.payload.adapterId)) throw new ExperimentServiceError("permission_denied", "Execution grant does not allow this adapter.");
  if (operation === "execute") {
    if (grant.payload.mode === "plan_only") {
      throw new ExperimentServiceError("permission_denied", "plan_only grants cannot submit jobs.");
    }
    if (grant.payload.mode === "confirm_each" && !grant.payload.confirmedJobIds.includes(jobId)) {
      throw new ExperimentServiceError("permission_denied", `Job ${jobId} has not been explicitly confirmed.`);
    }
    if (grant.payload.consumedAttemptIds.length >= grant.payload.budget.maxAttempts) {
      throw new ExperimentServiceError("permission_denied", "Execution grant budget is exhausted.");
    }
    if (spec.payload.adapterId !== "local") throw new ExperimentServiceError("adapter_unavailable", `Adapter ${spec.payload.adapterId} is reserved and cannot execute locally.`);
    if (!spec.payload.localWorker) throw new ExperimentServiceError("invalid_state", "Local execution requires a local worker definition.");
  }
}

function requireManifest(value: ExperimentManifest | undefined): ExperimentManifest {
  if (!value) throw new ExperimentServiceError("not_found", "No experiment manifest exists for this project.");
  return value;
}

function requireLatestSpec(manifest: ExperimentManifest, experimentId: string): ExperimentSpec {
  const spec = latestById(manifest.specs, experimentId);
  if (!spec) throw new ExperimentServiceError("not_found", `Experiment spec not found: ${experimentId}.`);
  return spec;
}

function requireLatestGrant(manifest: ExperimentManifest, grantId: string): ExecutionGrant {
  const grant = latestById(manifest.executionGrants, grantId);
  if (!grant) throw new ExperimentServiceError("not_found", `Execution grant not found: ${grantId}.`);
  return grant;
}

function requireLatestRun(manifest: ExperimentManifest, attemptId: string): RunAttempt {
  const run = latestById(manifest.runAttempts, attemptId);
  if (!run) throw new ExperimentServiceError("not_found", `Run attempt not found: ${attemptId}.`);
  return run;
}

function findSpecByRevision(manifest: ExperimentManifest, experimentId: string, revision: number): ExperimentSpec | undefined {
  return manifest.specs.find((spec) => spec.artifactId === experimentId && spec.revision === revision);
}

function findLatestRunByJobId(manifest: ExperimentManifest, jobId: string): RunAttempt | undefined {
  return latestEnvelopes(manifest.runAttempts).find((run) => run.payload.jobId === jobId);
}

function latestById<T extends ResearchArtifactEnvelope>(values: readonly T[], artifactId: string): T | undefined {
  return values.filter((value) => value.artifactId === artifactId).sort((left, right) => right.revision - left.revision)[0];
}

function latestEnvelopes<T extends ResearchArtifactEnvelope>(values: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const value of values) {
    const previous = latest.get(value.artifactId);
    if (!previous || value.revision > previous.revision) latest.set(value.artifactId, value);
  }
  return [...latest.values()];
}

function sortEnvelopes<T extends ResearchArtifactEnvelope>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.artifactId.localeCompare(right.artifactId, "en") || left.revision - right.revision);
}

function nextManifest(existing: ExperimentManifest | undefined, now: Date, changes: Partial<ExperimentManifest>): ExperimentManifest {
  if (!existing) return { ...createManifestForUpdate(now), ...changes };
  return { ...existing, ...changes, revision: existing.revision + 1, updatedAt: now.toISOString() };
}

function createManifestForUpdate(now: Date): ExperimentManifest {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    kind: "experiment_manifest",
    manifestId: `experiment-manifest-${randomUUID()}`,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    specs: [],
    executionGrants: [],
    runAttempts: [],
    metricObservations: [],
    baselineObservations: [],
    artifactEnvelopes: [],
    artifactFiles: [],
    artifactRefs: [],
  };
}

function previousManifest(manifest: ExperimentManifest): ExperimentManifest {
  return manifest;
}

function makeEnvelope<K extends ResearchArtifactEnvelope["kind"], P>(input: {
  kind: K;
  artifactId: string;
  revision: number;
  payload: P;
  parents: readonly ResearchArtifactParent[];
  now: Date;
  toolName: string;
  createdAt?: string;
}): ResearchArtifactEnvelope<K, P> {
  const created = createResearchArtifact({
    kind: input.kind,
    artifactId: input.artifactId,
    revision: input.revision,
    payload: input.payload,
    producer: { kind: "tool", id: "experimentation", toolName: input.toolName },
    parents: input.parents,
    now: input.now,
  });
  return input.createdAt === undefined ? created : Object.freeze({ ...created, createdAt: input.createdAt });
}

function sameBaselineWithoutRecordedAt(left: BaselineObservationPayload, right: BaselineObservationPayload): boolean {
  const { recordedAt: _left, ...leftRest } = left;
  const { recordedAt: _right, ...rightRest } = right;
  return sameJson(leftRest, rightRest);
}

function sameGrantTerms(
  grant: ExecutionGrantPayload,
  terms: Pick<ExecutionGrantPayload, "experimentId" | "mode" | "allowedAdapterIds" | "reason" | "expiresAt" | "budget">,
): boolean {
  const {
    grantId: _grantId,
    issuedAt: _issuedAt,
    confirmedJobIds: _confirmedJobIds,
    consumedJobIds: _consumedJobIds,
    consumedAttemptIds: _consumedAttemptIds,
    status: _status,
    ...storedTerms
  } = grant;
  return sameJson(storedTerms, terms);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uniqueTextArray(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) throw new ExperimentServiceError("invalid_input", `${label} must be an array.`);
  const normalized = values.map((value) => requireText(value, `${label} entry`));
  return [...new Set(normalized)];
}

function requireInputIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256 || value.includes("\u0000") || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new ExperimentServiceError("invalid_input", `${label} must be a safe identifier.`);
  }
  return value;
}

function requireJobId(value: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256 || value.includes("\u0000")) {
    throw new ExperimentServiceError("invalid_input", "jobId must be non-empty trimmed text.");
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\u0000") || value.length > 16_000) {
    throw new ExperimentServiceError("invalid_input", `${label} must be non-empty trimmed text.`);
  }
  return value;
}

function assertAdapterId(value: string): asserts value is ExperimentAdapterId {
  if (!(EXPERIMENT_ADAPTER_IDS as readonly string[]).includes(value)) throw new ExperimentServiceError("invalid_input", `Unknown experiment adapter: ${value}.`);
  getExperimentAdapter(value as ExperimentAdapterId);
}

function assertGrantMode(value: string): asserts value is ExecutionGrantMode {
  if (!(EXECUTION_PERMISSION_BOUNDARIES as readonly string[]).includes(value)) throw new ExperimentServiceError("invalid_input", `Unknown execution boundary: ${value}.`);
}

function normalizeRelativeArtifactPath(value: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\u0000") || /^[A-Za-z]:/u.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    throw new LocalWorkerFailure("artifact_missing", `Artifact path must be relative: ${value}.`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized === "." || normalized.split("/").some((part) => part === "" || part === ".." || part.includes(":") || /[. ]$/u.test(part))) {
    throw new LocalWorkerFailure("artifact_missing", `Artifact path escapes the run directory: ${value}.`);
  }
  return normalized;
}

function normalizeWorkerSpecArtifactPath(value: string, label: string): string {
  if (!value.trim() || value !== value.trim() || value.includes("\u0000") || /^[A-Za-z]:/u.test(value)
    || value.startsWith("/") || value.startsWith("\\")) {
    throw new ExperimentServiceError("invalid_input", `${label} must be a safe relative path.`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized === "." || normalized.split("/").some((part) => part === "" || part === ".." || part.includes(":") || /[. ]$/u.test(part))) {
    throw new ExperimentServiceError("invalid_input", `${label} must stay inside the run directory.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
