import type {
  ExperimentFailure,
  RunAttempt,
} from "../contracts.js";
import {
  loadProjectExperimentManifest,
} from "../repository.js";
import {
  prepareExperimentRun,
} from "../service.js";
import type {
  PreparedRemoteStageFile,
  RemoteAgentJobRequest,
  RemoteAgentRequest,
  RemoteAgentResponse,
  RemoteBackendJobObservation,
  RemoteConnectionRecord,
  RemoteConnectionSpec,
  RemoteExecutionTransport,
  RemoteExperimentSubmission,
  RemoteJobEvent,
  RemoteJobRecord,
  RemoteStagedFileRecord,
} from "./contracts.js";
import {
  applyRemoteExperimentObservation,
  assertRemoteExperimentStagingAuthorized,
  reconcileRemoteExperimentCancellation,
  reserveRemoteExperimentRun,
  type RemoteCancellationReconciliationInput,
} from "./experimentBridge.js";
import {
  prepareRemoteStageFiles,
} from "./paths.js";
import {
  createRemoteJob,
  findRemoteConnection,
  findRemoteJob,
  loadRemoteExecutionManifest,
  registerRemoteConnection,
  updateRemoteJob,
} from "./repository.js";
import {
  RemoteTransportError,
} from "./openSshTransport.js";
import { validateRemoteAgentResponse } from "./protocol.js";
import {
  assertSubmissionWithinConnection,
  normalizeRemoteConnection,
  normalizeRemoteSubmission,
  remoteSubmissionHash,
} from "./validation.js";

export class RemoteExecutionControllerError extends Error {
  readonly code: "not_found" | "invalid_input" | "remote_error";

  constructor(code: RemoteExecutionControllerError["code"], message: string) {
    super(message);
    this.name = "RemoteExecutionControllerError";
    this.code = code;
  }
}

export type RemoteExperimentOperationResult = Readonly<{
  job: RemoteJobRecord;
  attempt: RunAttempt;
  duplicate: boolean;
}>;

export class RemoteExperimentController {
  readonly #transport: RemoteExecutionTransport;
  readonly #now: () => Date;

  constructor(options: Readonly<{
    transport: RemoteExecutionTransport;
    now?: () => Date;
  }>) {
    if (!options?.transport || typeof options.transport.request !== "function") throw new TypeError("RemoteExperimentController requires a transport.");
    this.#transport = options.transport;
    this.#now = options.now ?? (() => new Date());
  }

  async registerConnection(input: {
    projectRoot: string;
    connection: RemoteConnectionSpec;
  }): Promise<Readonly<{ connection: RemoteConnectionRecord; duplicate: boolean }>> {
    const now = this.#now();
    const connection = normalizeRemoteConnection(input.connection, now);
    const result = await registerRemoteConnection({ projectRoot: input.projectRoot, connection, now });
    return Object.freeze({ connection: result.connection, duplicate: result.duplicate });
  }

  async submit(
    input: RemoteExperimentSubmission,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<RemoteExperimentOperationResult> {
    const normalized = normalizeRemoteSubmission(input);
    const remoteManifest = await loadRemoteExecutionManifest({ projectRoot: input.projectRoot });
    const connection = requireConnection(remoteManifest, normalized.connectionId);
    assertSubmissionWithinConnection(connection, normalized.workdir);
    const staged = await prepareRemoteStageFiles({
      projectRoot: input.projectRoot,
      workdir: normalized.workdir,
      files: input.stageFiles ?? [],
    });
    const requestHash = remoteSubmissionHash({
      ...normalized,
      stagedFiles: staged,
    });
    const existing = findRemoteJob(remoteManifest, normalized.jobId);
    if (existing) {
      if (existing.requestHash !== requestHash) throw controllerError("invalid_input", `jobId ${normalized.jobId} cannot be rebound to another request.`);
      if (existing.phase === "submitting" || existing.phase === "submission_uncertain") {
        return this.#observe(input.projectRoot, existing, connection, "recover", options.signal);
      }
      if (existing.phase === "submitted") return this.#observe(input.projectRoot, existing, connection, "query", options.signal);
      if (existing.phase === "terminal") return this.#resultFromExisting(input.projectRoot, existing, true);
    }

    const prepared = await prepareExperimentRun({
      projectRoot: input.projectRoot,
      experimentId: normalized.experimentId,
      grantId: normalized.grantId,
      jobId: normalized.jobId,
      ...(normalized.run === undefined ? {} : { run: normalized.run }),
      now: this.#now(),
    });
    if (prepared.value.payload.adapterId !== normalized.backend) {
      throw controllerError(
        "invalid_input",
        `Remote backend ${normalized.backend} does not match experiment adapter ${prepared.value.payload.adapterId}.`,
      );
    }
    const mainManifest = prepared.manifest;
    const latestGrant = latestById(mainManifest.executionGrants, normalized.grantId);
    if (!latestGrant) throw controllerError("not_found", `Execution grant not found: ${normalized.grantId}.`);
    const now = this.#now();
    assertRemoteExperimentStagingAuthorized({
      manifest: mainManifest,
      attempt: prepared.value,
      grantId: normalized.grantId,
      automaticGrantConfirmed: normalized.automaticGrantConfirmed,
      now,
    });
    const initial = remoteJobRecord({
      normalized,
      attemptId: prepared.value.payload.attemptId,
      grantMode: latestGrant.payload.mode,
      requestHash,
      maxWallTimeMs: prepared.value.payload.runFacts?.budgetReservation?.wallTimeMs,
      now,
    });
    const created = await createRemoteJob({ projectRoot: input.projectRoot, job: initial, now });
    let job = created.job;

    if (staged.length > 0 && job.stagedFiles.length === 0) {
      job = (await updateRemoteJob({
        projectRoot: input.projectRoot,
        jobId: job.jobId,
        now: this.#now(),
        update: (current, updateNow) => appendJobEvent(current, updateNow, {
          status: current.status,
          phase: "staging",
          message: "Staging hash-checked Project files through the remote agent.",
        }),
      })).job;
      try {
        const request = stageRequest({
          connection,
          projectId: mainManifest.manifestId,
          job,
          files: staged,
        });
        const response = validateRemoteAgentResponse(
          await this.#transport.request(connection, request, signalOptions(options.signal)),
          request,
        );
        if (!response.ok) throw agentResponseError(response);
        assertStageAcknowledgement(response.stagedFiles, staged);
        const stagedAt = this.#now().toISOString();
        const stagedRecords = staged.map((file) => Object.freeze({
          localRelativePath: file.localRelativePath,
          remoteRelativePath: file.remoteRelativePath,
          remotePath: file.remotePath,
          bytes: file.bytes,
          sha256: file.sha256,
          stagedAt,
        }));
        job = (await updateRemoteJob({
          projectRoot: input.projectRoot,
          jobId: job.jobId,
          now: this.#now(),
          update: (current, updateNow) => {
            const { failure: _failure, ...withoutFailure } = current;
            return appendJobEvent({ ...withoutFailure, stagedFiles: Object.freeze(stagedRecords) } as RemoteJobRecord, updateNow, {
              status: "prepared",
              phase: "prepared",
              message: `Staged ${stagedRecords.length} file(s) with verified SHA-256 hashes.`,
            });
          },
        })).job;
      } catch (error) {
        await this.#recordPreSubmissionFailure(input.projectRoot, job, error);
        throw error;
      }
    }

    const reserved = await reserveRemoteExperimentRun({
      projectRoot: input.projectRoot,
      attemptId: job.attemptId,
      grantId: job.grantId,
      automaticGrantConfirmed: normalized.automaticGrantConfirmed,
      now: this.#now(),
    });
    job = (await updateRemoteJob({
      projectRoot: input.projectRoot,
      jobId: job.jobId,
      now: this.#now(),
      update: (current, updateNow) => appendJobEvent(current, updateNow, {
        status: "queued",
        phase: "submitting",
        message: "Execution grant reserved; submitting the stable remote job identity once.",
      }),
    })).job;

    const request = submitRequest({ connection, projectId: mainManifest.manifestId, job });
    let response: RemoteAgentResponse;
    try {
      response = validateRemoteAgentResponse(
        await this.#transport.request(connection, request, signalOptions(options.signal)),
        request,
      );
    } catch (error) {
      const failure = transportFailure(error, this.#now());
      const uncertain = error instanceof RemoteTransportError ? error.submissionUncertain : true;
      const observation = uncertainObservation(job, failure, this.#now());
      job = (await this.#persistObservation(input.projectRoot, job, observation, uncertain ? "submission_uncertain" : "terminal")).job;
      const applied = await applyRemoteExperimentObservation({ projectRoot: input.projectRoot, attemptId: job.attemptId, observation, now: this.#now() });
      return Object.freeze({ job, attempt: applied.attempt, duplicate: false });
    }
    if (!response.ok) {
      const failure = agentFailure(response, this.#now());
      const observation = failedObservation(job, failure, this.#now());
      job = (await this.#persistObservation(input.projectRoot, job, observation, "terminal")).job;
      const applied = await applyRemoteExperimentObservation({ projectRoot: input.projectRoot, attemptId: job.attemptId, observation, now: this.#now() });
      return Object.freeze({ job, attempt: applied.attempt, duplicate: false });
    }
    const observation = requireObservation(response);
    job = (await this.#persistObservation(input.projectRoot, job, observation, phaseForObservation(observation))).job;
    const applied = await applyRemoteExperimentObservation({ projectRoot: input.projectRoot, attemptId: job.attemptId, observation, now: this.#now() });
    return Object.freeze({ job, attempt: applied.attempt, duplicate: created.duplicate || response.duplicate || reserved.duplicate });
  }

  async query(input: {
    projectRoot: string;
    jobId: string;
  }, options: Readonly<{ signal?: AbortSignal }> = {}): Promise<RemoteExperimentOperationResult> {
    const { job, connection } = await this.#loadJob(input.projectRoot, input.jobId);
    return this.#observe(input.projectRoot, job, connection, "query", options.signal);
  }

  async recover(input: {
    projectRoot: string;
    jobId: string;
  }, options: Readonly<{ signal?: AbortSignal }> = {}): Promise<RemoteExperimentOperationResult> {
    const { job, connection } = await this.#loadJob(input.projectRoot, input.jobId);
    return this.#observe(input.projectRoot, job, connection, "recover", options.signal);
  }

  async cancel(input: {
    projectRoot: string;
    jobId: string;
  }, options: Readonly<{ signal?: AbortSignal }> = {}): Promise<RemoteExperimentOperationResult> {
    const { job, connection } = await this.#loadJob(input.projectRoot, input.jobId);
    if (job.phase === "terminal") return this.#resultFromExisting(input.projectRoot, job, true);
    return this.#observe(input.projectRoot, job, connection, "cancel", options.signal);
  }

  /**
   * Applies explicit external cancellation evidence after remote recovery can
   * no longer determine whether the stable job is still running.
   */
  async reconcile(input: {
    projectRoot: string;
    jobId: string;
    reconciliation: RemoteCancellationReconciliationInput;
  }): Promise<RemoteExperimentOperationResult> {
    const { job } = await this.#loadJob(input.projectRoot, input.jobId);
    const reconciled = await reconcileRemoteExperimentCancellation({
      projectRoot: input.projectRoot,
      attemptId: job.attemptId,
      reconciliation: input.reconciliation,
      now: this.#now(),
    });
    if (reconciled.duplicate) return this.#resultFromExisting(input.projectRoot, job, true);
    const observation: RemoteBackendJobObservation = Object.freeze({
      backend: job.backend,
      jobId: job.jobId,
      ...(job.backendJobId === undefined ? {} : { backendJobId: job.backendJobId }),
      ...(job.schedulerJobId === undefined ? {} : { schedulerJobId: job.schedulerJobId }),
      status: "cancelled",
      duplicate: false,
      observedAt: reconciled.attempt.payload.finishedAt ?? this.#now().toISOString(),
      ...(reconciled.attempt.payload.startedAt === undefined ? {} : { startedAt: reconciled.attempt.payload.startedAt }),
      ...(reconciled.attempt.payload.finishedAt === undefined ? {} : { finishedAt: reconciled.attempt.payload.finishedAt }),
      ...(reconciled.attempt.payload.failure === undefined ? {} : { failure: reconciled.attempt.payload.failure }),
    });
    const persisted = await this.#persistObservation(input.projectRoot, job, observation, "terminal");
    return Object.freeze({ job: persisted.job, attempt: reconciled.attempt, duplicate: false });
  }

  async #observe(
    projectRoot: string,
    job: RemoteJobRecord,
    connection: RemoteConnectionRecord,
    action: RemoteAgentJobRequest["action"],
    signal: AbortSignal | undefined,
  ): Promise<RemoteExperimentOperationResult> {
    const main = await loadProjectExperimentManifest({ projectRoot });
    if (!main) throw controllerError("not_found", "Experiment manifest does not exist.");
    const request: RemoteAgentJobRequest = {
      protocolVersion: 1,
      requestId: requestId(action, job.requestHash),
      connectionId: connection.connectionId,
      projectId: main.manifestId,
      stateRoot: connection.stateRoot,
      workspaceRoot: connection.workspaceRoot,
      action,
      backend: job.backend,
      jobId: job.jobId,
      requestHash: job.requestHash,
      ...(job.backendJobId === undefined ? {} : { backendJobId: job.backendJobId }),
    };
    let response: RemoteAgentResponse;
    try {
      response = validateRemoteAgentResponse(
        await this.#transport.request(connection, request, signalOptions(signal)),
        request,
      );
    } catch (error) {
      const failure = transportFailure(error, this.#now());
      const observation = uncertainObservation(job, failure, this.#now());
      const persisted = await this.#persistObservation(projectRoot, job, observation, "submission_uncertain");
      const applied = await applyRemoteExperimentObservation({ projectRoot, attemptId: job.attemptId, observation, now: this.#now() });
      return Object.freeze({ job: persisted.job, attempt: applied.attempt, duplicate: true });
    }
    if (!response.ok) {
      const failure = agentFailure(response, this.#now());
      const observation = action === "recover" && response.code === "job_not_found"
        ? uncertainObservation(job, failure, this.#now())
        : failedObservation(job, failure, this.#now());
      const phase = observation.status === "unknown" ? "submission_uncertain" : "terminal";
      const persisted = await this.#persistObservation(projectRoot, job, observation, phase);
      const applied = await applyRemoteExperimentObservation({ projectRoot, attemptId: job.attemptId, observation, now: this.#now() });
      return Object.freeze({ job: persisted.job, attempt: applied.attempt, duplicate: true });
    }
    const observation = requireObservation(response);
    const persisted = await this.#persistObservation(projectRoot, job, observation, phaseForObservation(observation));
    const applied = await applyRemoteExperimentObservation({ projectRoot, attemptId: job.attemptId, observation, now: this.#now() });
    return Object.freeze({ job: persisted.job, attempt: applied.attempt, duplicate: true });
  }

  async #persistObservation(
    projectRoot: string,
    previous: RemoteJobRecord,
    observation: RemoteBackendJobObservation,
    phase: RemoteJobRecord["phase"],
  ) {
    return updateRemoteJob({
      projectRoot,
      jobId: previous.jobId,
      now: this.#now(),
      update: (current, now) => jobFromObservation(current, observation, phase, now),
    });
  }

  async #recordPreSubmissionFailure(projectRoot: string, job: RemoteJobRecord, error: unknown): Promise<void> {
    const failure = transportFailure(error, this.#now());
    await updateRemoteJob({
      projectRoot,
      jobId: job.jobId,
      now: this.#now(),
      update: (current, now) => appendJobEvent({ ...current, failure } as RemoteJobRecord, now, {
        status: "prepared",
        phase: "prepared",
        message: `Remote staging failed before submission: ${failure.message}`,
      }),
    });
  }

  async #loadJob(projectRoot: string, jobId: string): Promise<Readonly<{ job: RemoteJobRecord; connection: RemoteConnectionRecord }>> {
    const manifest = await loadRemoteExecutionManifest({ projectRoot });
    const job = findRemoteJob(manifest, jobId);
    if (!job) throw controllerError("not_found", `Remote job not found: ${jobId}.`);
    return Object.freeze({ job, connection: requireConnection(manifest, job.connectionId) });
  }

  async #resultFromExisting(projectRoot: string, job: RemoteJobRecord, duplicate: boolean): Promise<RemoteExperimentOperationResult> {
    const manifest = await loadProjectExperimentManifest({ projectRoot });
    const attempt = latestById(manifest?.runAttempts ?? [], job.attemptId);
    if (!attempt) throw controllerError("not_found", `Run attempt not found: ${job.attemptId}.`);
    return Object.freeze({ job, attempt, duplicate });
  }
}

function remoteJobRecord(input: {
  normalized: ReturnType<typeof normalizeRemoteSubmission>;
  attemptId: string;
  grantMode: RemoteJobRecord["grantMode"];
  requestHash: string;
  maxWallTimeMs?: number;
  now: Date;
}): RemoteJobRecord {
  const timestamp = input.now.toISOString();
  const initialEvent: RemoteJobEvent = Object.freeze({
    sequence: 1,
    at: timestamp,
    status: "prepared",
    phase: "prepared",
    message: "Remote job identity prepared without backend submission.",
  });
  return Object.freeze({
    jobId: input.normalized.jobId,
    attemptId: input.attemptId,
    experimentId: input.normalized.experimentId,
    grantId: input.normalized.grantId,
    grantMode: input.grantMode,
    connectionId: input.normalized.connectionId,
    backend: input.normalized.backend,
    requestHash: input.requestHash,
    workdir: input.normalized.workdir,
    argv: input.normalized.argv,
    ...(input.normalized.slurm === undefined ? {} : { slurm: input.normalized.slurm }),
    ...(input.maxWallTimeMs === undefined ? {} : { maxWallTimeMs: input.maxWallTimeMs }),
    stagedFiles: Object.freeze([]),
    status: "prepared",
    phase: "prepared",
    createdAt: timestamp,
    updatedAt: timestamp,
    events: Object.freeze([initialEvent]),
  });
}

function stageRequest(input: {
  connection: RemoteConnectionRecord;
  projectId: string;
  job: RemoteJobRecord;
  files: readonly PreparedRemoteStageFile[];
}): RemoteAgentRequest {
  return Object.freeze({
    protocolVersion: 1,
    requestId: requestId("stage", input.job.requestHash),
    connectionId: input.connection.connectionId,
    projectId: input.projectId,
    stateRoot: input.connection.stateRoot,
    workspaceRoot: input.connection.workspaceRoot,
    action: "stage",
    jobId: input.job.jobId,
    requestHash: input.job.requestHash,
    workdir: input.job.workdir,
    files: input.files.map((file) => ({
      remoteRelativePath: file.remoteRelativePath,
      remotePath: file.remotePath,
      bytes: file.bytes,
      sha256: file.sha256,
      contentBase64: file.contentBase64,
    })),
  });
}

function submitRequest(input: {
  connection: RemoteConnectionRecord;
  projectId: string;
  job: RemoteJobRecord;
}): RemoteAgentRequest {
  return Object.freeze({
    protocolVersion: 1,
    requestId: requestId("submit", input.job.requestHash),
    connectionId: input.connection.connectionId,
    projectId: input.projectId,
    stateRoot: input.connection.stateRoot,
    workspaceRoot: input.connection.workspaceRoot,
    action: "submit",
    backend: input.job.backend,
    jobId: input.job.jobId,
    requestHash: input.job.requestHash,
    workdir: input.job.workdir,
    argv: input.job.argv,
    ...(input.job.slurm === undefined ? {} : { slurm: input.job.slurm }),
    ...(input.job.maxWallTimeMs === undefined ? {} : { maxWallTimeMs: input.job.maxWallTimeMs }),
  });
}

function jobFromObservation(
  current: RemoteJobRecord,
  observation: RemoteBackendJobObservation,
  phase: RemoteJobRecord["phase"],
  now: Date,
): RemoteJobRecord {
  const status = observation.status === "unknown" ? "recovery_required" : observation.status;
  const timestamp = now.toISOString();
  const {
    failure: _previousFailure,
    finishedAt: _previousFinishedAt,
    ...currentWithoutTerminalState
  } = current;
  const next: RemoteJobRecord = {
    ...currentWithoutTerminalState,
    status,
    phase,
    updatedAt: timestamp,
    lastObservedAt: observation.observedAt,
    ...(current.backendJobId || observation.backendJobId ? { backendJobId: current.backendJobId ?? observation.backendJobId } : {}),
    ...(current.schedulerJobId || observation.schedulerJobId ? { schedulerJobId: current.schedulerJobId ?? observation.schedulerJobId } : {}),
    ...(current.submittedAt || observation.backendJobId ? { submittedAt: current.submittedAt ?? timestamp } : {}),
    ...(current.startedAt || observation.startedAt || status === "running"
      ? { startedAt: current.startedAt ?? observation.startedAt ?? timestamp }
      : {}),
    ...(["succeeded", "failed", "cancelled", "recovery_required"].includes(status)
      ? { finishedAt: observation.finishedAt ?? timestamp }
      : {}),
    ...(observation.failure === undefined ? {} : { failure: observation.failure }),
    events: current.events,
  };
  return appendJobEvent(next, now, {
    status,
    phase,
    message: `Remote ${current.backend} observation: ${observation.status}.`,
    ...(observation.backendJobId === undefined ? {} : { backendJobId: observation.backendJobId }),
  });
}

function appendJobEvent(
  job: RemoteJobRecord,
  now: Date,
  event: Omit<RemoteJobRecord["events"][number], "sequence" | "at">,
): RemoteJobRecord {
  const timestamp = now.toISOString();
  return Object.freeze({
    ...job,
    status: event.status,
    phase: event.phase,
    updatedAt: timestamp,
    events: Object.freeze([...job.events, Object.freeze({
      sequence: job.events.length + 1,
      at: timestamp,
      ...event,
    })]),
  });
}

function phaseForObservation(observation: RemoteBackendJobObservation): RemoteJobRecord["phase"] {
  return ["succeeded", "failed", "cancelled"].includes(observation.status)
    ? "terminal"
    : observation.status === "unknown"
      ? "submission_uncertain"
      : "submitted";
}

function uncertainObservation(job: RemoteJobRecord, failure: ExperimentFailure, now: Date): RemoteBackendJobObservation {
  return Object.freeze({
    backend: job.backend,
    jobId: job.jobId,
    ...(job.backendJobId === undefined ? {} : { backendJobId: job.backendJobId }),
    ...(job.schedulerJobId === undefined ? {} : { schedulerJobId: job.schedulerJobId }),
    status: "unknown",
    duplicate: true,
    observedAt: now.toISOString(),
    failure,
  });
}

function failedObservation(job: RemoteJobRecord, failure: ExperimentFailure, now: Date): RemoteBackendJobObservation {
  return Object.freeze({
    backend: job.backend,
    jobId: job.jobId,
    ...(job.backendJobId === undefined ? {} : { backendJobId: job.backendJobId }),
    ...(job.schedulerJobId === undefined ? {} : { schedulerJobId: job.schedulerJobId }),
    status: "failed",
    duplicate: false,
    observedAt: now.toISOString(),
    failure,
  });
}

function transportFailure(error: unknown, now: Date): ExperimentFailure {
  if (error instanceof RemoteTransportError) {
    const category = error.code === "timeout"
      ? "timeout"
      : error.code === "cancelled"
        ? "cancelled"
        : error.code === "authentication" || error.code === "host_key"
          ? "permission_denied"
          : error.code === "spawn_failed"
            ? "adapter_unavailable"
            : error.code === "disconnected"
              ? "disconnected"
              : "unknown";
    return Object.freeze({ category, message: error.message, retryable: error.retryable, observedAt: now.toISOString() });
  }
  return Object.freeze({ category: "unknown", message: messageOf(error), retryable: false, observedAt: now.toISOString() });
}

function agentFailure(response: Extract<RemoteAgentResponse, { ok: false }>, now: Date): ExperimentFailure {
  const category = response.code === "adapter_unavailable"
    ? "adapter_unavailable"
    : response.code === "path_violation" || response.code === "hash_mismatch"
      ? "artifact_missing"
      : response.code === "invalid_request" || response.code === "job_conflict"
        ? "invalid_worker_result"
        : "unknown";
  return Object.freeze({ category, message: response.message, retryable: response.retryable, observedAt: now.toISOString() });
}

function requireObservation(response: Extract<RemoteAgentResponse, { ok: true }>): RemoteBackendJobObservation {
  if (!response.observation) throw controllerError("remote_error", "Remote agent omitted its job observation.");
  return response.observation;
}

function requireConnection(
  manifest: Awaited<ReturnType<typeof loadRemoteExecutionManifest>>,
  connectionId: string,
): RemoteConnectionRecord {
  const connection = findRemoteConnection(manifest, connectionId);
  if (!connection) throw controllerError("not_found", `Remote connection not found: ${connectionId}.`);
  return connection;
}

function latestById<T extends { artifactId: string; revision: number }>(values: readonly T[], artifactId: string): T | undefined {
  return values.filter((value) => value.artifactId === artifactId).sort((left, right) => right.revision - left.revision)[0];
}

function requestId(action: RemoteAgentRequest["action"], requestHash: string): string {
  return `${action}:${requestHash.slice("sha256:".length, "sha256:".length + 32)}`;
}

function signalOptions(signal: AbortSignal | undefined): Readonly<{ signal?: AbortSignal }> {
  return signal === undefined ? {} : { signal };
}

function agentResponseError(response: Extract<RemoteAgentResponse, { ok: false }>): RemoteExecutionControllerError {
  return controllerError("remote_error", `Remote agent rejected staging: ${response.message}`);
}

function assertStageAcknowledgement(
  acknowledged: Extract<RemoteAgentResponse, { ok: true }>["stagedFiles"],
  requested: readonly PreparedRemoteStageFile[],
): void {
  if (!acknowledged || acknowledged.length !== requested.length || acknowledged.some((file, index) => {
    const expected = requested[index];
    return expected === undefined
      || file.remoteRelativePath !== expected.remoteRelativePath
      || file.remotePath !== expected.remotePath
      || file.bytes !== expected.bytes
      || file.sha256 !== expected.sha256;
  })) {
    throw controllerError("remote_error", "Remote agent staging acknowledgement does not match the requested files.");
  }
}

function controllerError(code: RemoteExecutionControllerError["code"], message: string): RemoteExecutionControllerError {
  return new RemoteExecutionControllerError(code, message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
