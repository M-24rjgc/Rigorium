import {
  EXPERIMENT_FAILURE_CATEGORIES,
  type ExperimentFailure,
} from "../contracts.js";
import type {
  RemoteAgentRequest,
  RemoteAgentResponse,
  RemoteAgentSuccessResponse,
  RemoteBackendJobObservation,
} from "./contracts.js";
import {
  assertRemotePathWithin,
  normalizeRemoteAbsolutePath,
  normalizeRemoteRelativePath,
  resolveRemoteChild,
  sha256,
  MAX_REMOTE_STAGE_TOTAL_BYTES,
} from "./paths.js";
import { normalizeSlurmResources } from "./slurm.js";
import {
  identifier,
  normalizeArgv,
} from "./validation.js";

export function validateRemoteAgentRequest(value: unknown): RemoteAgentRequest {
  if (!isRecord(value) || value.protocolVersion !== 1 || !["stage", "submit", "query", "recover", "cancel"].includes(String(value.action))) {
    throw new TypeError("Remote agent request header is invalid.");
  }
  const requestId = identifier(value.requestId, "requestId");
  const connectionId = identifier(value.connectionId, "connectionId");
  const projectId = identifier(value.projectId, "projectId");
  const stateRoot = normalizeRemoteAbsolutePath(value.stateRoot, "stateRoot");
  const workspaceRoot = normalizeRemoteAbsolutePath(value.workspaceRoot, "workspaceRoot");
  const jobId = identifier(value.jobId, "jobId");
  const requestHash = hash(value.requestHash, "requestHash");
  const base = { protocolVersion: 1 as const, requestId, connectionId, projectId, stateRoot, workspaceRoot, jobId, requestHash };

  if (value.action === "stage") {
    const workdir = normalizeRemoteAbsolutePath(value.workdir, "workdir");
    assertRemotePathWithin(workspaceRoot, workdir, "workdir");
    if (!Array.isArray(value.files) || value.files.length > 128) throw new TypeError("stage files are invalid.");
    const seen = new Set<string>();
    let totalBytes = 0;
    const files = value.files.map((candidate, index) => {
      if (!isRecord(candidate)) throw new TypeError(`files[${index}] is invalid.`);
      const remoteRelativePath = normalizeRemoteRelativePath(candidate.remoteRelativePath, `files[${index}].remoteRelativePath`);
      const remotePath = normalizeRemoteAbsolutePath(candidate.remotePath, `files[${index}].remotePath`);
      if (remotePath !== resolveRemoteChild(workdir, remoteRelativePath, `files[${index}].remoteRelativePath`)) {
        throw new TypeError(`files[${index}].remotePath does not match its relative path.`);
      }
      if (seen.has(remotePath)) throw new TypeError(`files[${index}].remotePath is duplicated.`);
      seen.add(remotePath);
      const bytes = boundedInteger(candidate.bytes, `files[${index}].bytes`, 0, 16 * 1024 * 1024);
      totalBytes += bytes;
      if (totalBytes > MAX_REMOTE_STAGE_TOTAL_BYTES) throw new TypeError("stage files exceed the total byte limit.");
      const digest = hash(candidate.sha256, `files[${index}].sha256`);
      if (typeof candidate.contentBase64 !== "string" || candidate.contentBase64.length > 24 * 1024 * 1024) {
        throw new TypeError(`files[${index}].contentBase64 is invalid.`);
      }
      const content = strictBase64(candidate.contentBase64, `files[${index}].contentBase64`);
      if (content.byteLength !== bytes || sha256(content) !== digest) throw new TypeError(`files[${index}] content does not match its declared size and hash.`);
      return Object.freeze({ remoteRelativePath, remotePath, bytes, sha256: digest, contentBase64: candidate.contentBase64 });
    });
    return Object.freeze({ ...base, action: "stage" as const, workdir, files: Object.freeze(files) });
  }

  if (value.backend !== "ssh" && value.backend !== "slurm") throw new TypeError("Remote job backend is invalid.");
  const backend = value.backend;
  if (value.action === "submit") {
    const workdir = normalizeRemoteAbsolutePath(value.workdir, "workdir");
    assertRemotePathWithin(workspaceRoot, workdir, "workdir");
    const argv = Object.freeze(normalizeArgv(value.argv));
    const slurm = backend === "slurm" ? normalizeSlurmResources(value.slurm as never) : undefined;
    const maxWallTimeMs = value.maxWallTimeMs === undefined
      ? undefined
      : boundedInteger(value.maxWallTimeMs, "maxWallTimeMs", 1, 86_400_000);
    if (backend === "ssh" && value.slurm !== undefined) throw new TypeError("slurm resources require backend=slurm.");
    return Object.freeze({
      ...base,
      action: "submit" as const,
      backend,
      workdir,
      argv,
      ...(slurm === undefined ? {} : { slurm }),
      ...(maxWallTimeMs === undefined ? {} : { maxWallTimeMs }),
    });
  }
  const backendJobId = value.backendJobId === undefined ? undefined : backendId(value.backendJobId, "backendJobId", backend);
  return Object.freeze({
    ...base,
    action: value.action as "query" | "recover" | "cancel",
    backend,
    ...(backendJobId === undefined ? {} : { backendJobId }),
  });
}

export function validateRemoteAgentResponse(value: unknown, request: RemoteAgentRequest): RemoteAgentResponse {
  if (!isRecord(value) || value.protocolVersion !== 1 || value.requestId !== request.requestId || value.action !== request.action
    || typeof value.ok !== "boolean") {
    throw new TypeError("Remote agent response does not match its request.");
  }
  if (value.ok === false) {
    if (!["invalid_request", "path_violation", "hash_mismatch", "job_conflict", "job_not_found", "adapter_unavailable", "scheduler_error", "internal_error"].includes(String(value.code))) {
      throw new TypeError("Remote agent error code is invalid.");
    }
    if (typeof value.message !== "string" || !value.message.trim() || value.message.length > 16_384 || typeof value.retryable !== "boolean") {
      throw new TypeError("Remote agent error response is invalid.");
    }
    return Object.freeze({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: false,
      action: request.action,
      code: value.code as never,
      message: value.message,
      retryable: value.retryable,
    });
  }
  if (typeof value.duplicate !== "boolean") throw new TypeError("Remote agent success response requires duplicate.");
  const stagedFiles = value.stagedFiles === undefined ? undefined : validateStagedFiles(value.stagedFiles);
  const observation = value.observation === undefined ? undefined : validateObservation(value.observation, request);
  if (request.action === "stage" && stagedFiles === undefined) throw new TypeError("Stage response requires stagedFiles.");
  if (request.action === "stage" && stagedFiles && !sameStagedFiles(stagedFiles, request.files)) {
    throw new TypeError("Stage response does not match the requested file hashes and paths.");
  }
  if (request.action !== "stage" && observation === undefined) throw new TypeError("Job response requires an observation.");
  return Object.freeze({
    protocolVersion: 1,
    requestId: request.requestId,
    ok: true,
    action: request.action,
    duplicate: value.duplicate,
    ...(stagedFiles === undefined ? {} : { stagedFiles }),
    ...(observation === undefined ? {} : { observation }),
  } satisfies RemoteAgentSuccessResponse);
}

function validateStagedFiles(value: unknown): RemoteAgentSuccessResponse["stagedFiles"] {
  if (!Array.isArray(value) || value.length > 128) throw new TypeError("stagedFiles is invalid.");
  return Object.freeze(value.map((file, index) => {
    if (!isRecord(file)) throw new TypeError(`stagedFiles[${index}] is invalid.`);
    return Object.freeze({
      remoteRelativePath: normalizeRemoteRelativePath(file.remoteRelativePath, `stagedFiles[${index}].remoteRelativePath`),
      remotePath: normalizeRemoteAbsolutePath(file.remotePath, `stagedFiles[${index}].remotePath`),
      bytes: boundedInteger(file.bytes, `stagedFiles[${index}].bytes`, 0, 16 * 1024 * 1024),
      sha256: hash(file.sha256, `stagedFiles[${index}].sha256`),
    });
  }));
}

function sameStagedFiles(
  observed: NonNullable<RemoteAgentSuccessResponse["stagedFiles"]>,
  requested: Extract<RemoteAgentRequest, { action: "stage" }>["files"],
): boolean {
  if (observed.length !== requested.length) return false;
  return observed.every((file, index) => {
    const expected = requested[index];
    return expected !== undefined
      && file.remoteRelativePath === expected.remoteRelativePath
      && file.remotePath === expected.remotePath
      && file.bytes === expected.bytes
      && file.sha256 === expected.sha256;
  });
}

function validateObservation(value: unknown, request: RemoteAgentRequest): RemoteBackendJobObservation {
  if (!isRecord(value) || (value.backend !== "ssh" && value.backend !== "slurm") || value.jobId !== request.jobId
    || !["queued", "running", "succeeded", "failed", "cancelled", "unknown"].includes(String(value.status))
    || typeof value.duplicate !== "boolean" || typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))) {
    throw new TypeError("Remote backend observation is invalid.");
  }
  if (request.action !== "stage" && value.backend !== request.backend) throw new TypeError("Remote backend observation changed backend.");
  const failure = value.failure === undefined ? undefined : validateRemoteExperimentFailure(value.failure);
  const startedAt = value.startedAt === undefined ? undefined : isoTimestamp(value.startedAt, "observation.startedAt");
  const finishedAt = value.finishedAt === undefined ? undefined : isoTimestamp(value.finishedAt, "observation.finishedAt");
  if (startedAt !== undefined && finishedAt !== undefined && Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new TypeError("Remote backend observation finishedAt precedes startedAt.");
  }
  return Object.freeze({
    backend: value.backend,
    jobId: request.jobId,
    ...(value.backendJobId === undefined ? {} : { backendJobId: backendId(value.backendJobId, "backendJobId", value.backend) }),
    ...(value.schedulerJobId === undefined ? {} : { schedulerJobId: schedulerJobId(value.schedulerJobId, value.backend) }),
    status: value.status,
    duplicate: value.duplicate,
    observedAt: new Date(value.observedAt).toISOString(),
    ...(value.exitCode === undefined ? {} : { exitCode: nullableInteger(value.exitCode, "exitCode") }),
    ...(value.signal === undefined ? {} : { signal: identifier(value.signal, "signal") }),
    ...(failure === undefined ? {} : { failure }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  } as RemoteBackendJobObservation);
}

export function validateRemoteExperimentFailure(value: unknown): ExperimentFailure {
  if (!isRecord(value) || !EXPERIMENT_FAILURE_CATEGORIES.includes(value.category as never)
    || typeof value.message !== "string" || !value.message.trim() || value.message.length > 16_384
    || typeof value.retryable !== "boolean" || typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))) {
    throw new TypeError("Remote failure is invalid.");
  }
  const exitCode = value.exitCode === undefined ? undefined : nullableInteger(value.exitCode, "failure.exitCode");
  const signal = value.signal === undefined ? undefined : identifier(value.signal, "failure.signal");
  const retryAfterMs = value.retryAfterMs === undefined
    ? undefined
    : boundedInteger(value.retryAfterMs, "failure.retryAfterMs", 0, 86_400_000);
  return Object.freeze({
    category: value.category as ExperimentFailure["category"],
    message: value.message,
    retryable: value.retryable,
    observedAt: new Date(value.observedAt).toISOString(),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 digest.`);
  return value;
}

function backendId(value: unknown, label: string, backend?: "ssh" | "slurm"): string {
  const prefix = backend === undefined ? "(?:ssh|slurm)" : backend;
  if (typeof value !== "string" || !new RegExp(`^${prefix}:[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$`, "u").test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function schedulerJobId(value: unknown, backend: unknown): string {
  if (backend !== "slurm" || typeof value !== "string" || !/^\d+(?:_[0-9]+)?$/u.test(value)) {
    throw new TypeError("schedulerJobId is invalid for the remote backend.");
  }
  return value;
}

function strictBase64(value: string, label: string): Buffer {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError(`${label} is not canonical base64.`);
  }
  return Buffer.from(value, "base64");
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be an integer or null.`);
  return value as number;
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
