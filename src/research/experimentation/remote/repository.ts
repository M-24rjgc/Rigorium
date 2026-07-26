import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { posix } from "node:path";
import {
  canonicalJson,
  hashResearchArtifactContent,
} from "../../artifacts/index.js";
import {
  EXECUTION_GRANT_MODES,
  EXPERIMENT_RUN_STATUSES,
} from "../contracts.js";
import {
  getProjectExperimentPaths,
  loadProjectExperimentManifest,
} from "../repository.js";
import type {
  RemoteBackend,
  RemoteConnectionRecord,
  RemoteExecutionManifest,
  RemoteJobEvent,
  RemoteJobRecord,
  RemoteStagedFileRecord,
} from "./contracts.js";
import {
  REMOTE_BACKENDS,
  REMOTE_SUBMISSION_PHASES,
} from "./contracts.js";
import {
  normalizeRemoteAbsolutePath,
  normalizeRemoteRelativePath,
  resolveRemoteChild,
} from "./paths.js";
import { validateRemoteExperimentFailure } from "./protocol.js";
import { normalizeSlurmResources } from "./slurm.js";
import {
  assertRemoteJobIdentity,
  identifier,
  isoDate,
  normalizeArgv,
  normalizeRemoteConnection,
  sameConnectionTerms,
} from "./validation.js";

const MAX_REMOTE_MANIFEST_BYTES = 16 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;

export type RemoteExecutionPaths = Readonly<{
  projectRoot: string;
  remoteDir: string;
  manifestPath: string;
  lockPath: string;
}>;

export class RemoteExecutionRepositoryError extends Error {
  readonly code: "invalid_input" | "invalid_schema" | "path_violation" | "repository_busy" | "storage_error";

  constructor(code: RemoteExecutionRepositoryError["code"], message: string) {
    super(message);
    this.name = "RemoteExecutionRepositoryError";
    this.code = code;
  }
}

export function getRemoteExecutionPaths(input: { projectRoot: string }): RemoteExecutionPaths {
  const base = getProjectExperimentPaths(input);
  const remoteDir = join(base.experimentationDir, "remote");
  const manifestPath = join(remoteDir, "manifest.json");
  const lockPath = join(remoteDir, ".manifest.lock");
  for (const candidate of [remoteDir, manifestPath, lockPath]) assertWithin(base.projectRoot, candidate);
  return Object.freeze({ projectRoot: base.projectRoot, remoteDir, manifestPath, lockPath });
}

export async function loadRemoteExecutionManifest(input: {
  projectRoot: string;
}): Promise<RemoteExecutionManifest | undefined> {
  const paths = getRemoteExecutionPaths(input);
  await loadProjectExperimentManifest({ projectRoot: paths.projectRoot });
  try {
    const stats = await lstat(paths.manifestPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_REMOTE_MANIFEST_BYTES) throw repositoryError("invalid_schema", "Remote manifest is not a bounded regular file.");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    if (error instanceof RemoteExecutionRepositoryError) throw error;
    throw storageError(error, "Unable to inspect remote manifest.");
  }
  try {
    return validateRemoteExecutionManifest(JSON.parse(await readFile(paths.manifestPath, "utf8")));
  } catch (error) {
    if (error instanceof RemoteExecutionRepositoryError) throw error;
    throw repositoryError("invalid_schema", `Remote manifest is invalid: ${messageOf(error)}`);
  }
}

export async function updateRemoteExecutionManifest<T>(input: {
  projectRoot: string;
  now?: Date;
  update: (
    existing: RemoteExecutionManifest | undefined,
    now: Date,
  ) => Readonly<{ manifest: RemoteExecutionManifest; value: T }>;
}): Promise<Readonly<{ path: string; manifest: RemoteExecutionManifest; value: T; persisted: boolean }>> {
  const paths = getRemoteExecutionPaths(input);
  const now = input.now ?? new Date();
  isoDate(now, "now");
  await ensureRemoteDirectory(paths);
  return withLock(paths, async () => {
    const existing = await readManifestIfPresent(paths.manifestPath);
    const result = input.update(existing, now);
    const manifest = finalizeManifest(result.manifest);
    const persisted = !existing || canonicalJson(existing) !== canonicalJson(manifest);
    if (persisted) await writeManifestAtomically(paths, manifest);
    return Object.freeze({ path: paths.manifestPath, manifest, value: result.value, persisted });
  });
}

export async function registerRemoteConnection(input: {
  projectRoot: string;
  connection: RemoteConnectionRecord;
  now?: Date;
}): Promise<Readonly<{ connection: RemoteConnectionRecord; manifest: RemoteExecutionManifest; duplicate: boolean }>> {
  const validatedConnection = validateConnectionRecord(input.connection);
  const result = await updateRemoteExecutionManifest({
    projectRoot: input.projectRoot,
    now: input.now,
    update: (existing, now) => {
      const manifest = existing ?? createEmptyRemoteManifest(now);
      const previous = manifest.connections.find((candidate) => candidate.connectionId === validatedConnection.connectionId);
      if (previous) {
        if (!sameConnectionTerms(previous, validatedConnection)) {
          throw repositoryError("invalid_input", `connectionId ${validatedConnection.connectionId} cannot be rebound to different terms.`);
        }
        return { manifest, value: { connection: previous, duplicate: true } };
      }
      const connection = Object.freeze({ ...validatedConnection, createdAt: now.toISOString(), updatedAt: now.toISOString() });
      return {
        manifest: nextManifest(manifest, now, {
          connections: [...manifest.connections, connection].sort((left, right) => left.connectionId.localeCompare(right.connectionId, "en")),
        }),
        value: { connection, duplicate: false },
      };
    },
  });
  return Object.freeze({ ...result.value, manifest: result.manifest });
}

export async function createRemoteJob(input: {
  projectRoot: string;
  job: RemoteJobRecord;
  now?: Date;
}): Promise<Readonly<{ job: RemoteJobRecord; manifest: RemoteExecutionManifest; duplicate: boolean }>> {
  const result = await updateRemoteExecutionManifest({
    projectRoot: input.projectRoot,
    now: input.now,
    update: (existing, now) => {
      const manifest = existing ?? createEmptyRemoteManifest(now);
      const previous = manifest.jobs.find((candidate) => candidate.jobId === input.job.jobId);
      if (previous) {
        if (previous.requestHash !== input.job.requestHash) {
          throw repositoryError("invalid_input", `jobId ${input.job.jobId} is already bound to another remote request.`);
        }
        assertRemoteJobIdentity(previous, { ...input.job, backendJobId: previous.backendJobId, schedulerJobId: previous.schedulerJobId });
        return { manifest, value: { job: previous, duplicate: true } };
      }
      const job = validateRemoteJob(input.job);
      return {
        manifest: nextManifest(manifest, now, { jobs: sortJobs([...manifest.jobs, job]) }),
        value: { job, duplicate: false },
      };
    },
  });
  return Object.freeze({ ...result.value, manifest: result.manifest });
}

export async function updateRemoteJob(input: {
  projectRoot: string;
  jobId: string;
  now?: Date;
  update: (job: RemoteJobRecord, now: Date) => RemoteJobRecord;
}): Promise<Readonly<{ job: RemoteJobRecord; manifest: RemoteExecutionManifest; persisted: boolean }>> {
  const jobId = identifier(input.jobId, "jobId");
  const result = await updateRemoteExecutionManifest({
    projectRoot: input.projectRoot,
    now: input.now,
    update: (existing, now) => {
      if (!existing) throw repositoryError("invalid_input", "Remote execution manifest does not exist.");
      const previous = existing.jobs.find((candidate) => candidate.jobId === jobId);
      if (!previous) throw repositoryError("invalid_input", `Remote job not found: ${jobId}.`);
      const next = validateRemoteJob(input.update(previous, now));
      assertRemoteJobIdentity(previous, next);
      return {
        manifest: canonicalJson(previous) === canonicalJson(next)
          ? existing
          : nextManifest(existing, now, { jobs: sortJobs(existing.jobs.map((candidate) => candidate.jobId === jobId ? next : candidate)) }),
        value: next,
      };
    },
  });
  return Object.freeze({ job: result.value, manifest: result.manifest, persisted: result.persisted });
}

export function findRemoteJob(manifest: RemoteExecutionManifest | undefined, jobId: string): RemoteJobRecord | undefined {
  return manifest?.jobs.find((job) => job.jobId === jobId);
}

export function findRemoteConnection(
  manifest: RemoteExecutionManifest | undefined,
  connectionId: string,
): RemoteConnectionRecord | undefined {
  return manifest?.connections.find((connection) => connection.connectionId === connectionId);
}

export function createEmptyRemoteManifest(now = new Date()): RemoteExecutionManifest {
  const timestamp = isoDate(now, "now");
  return finalizeManifest({
    schemaVersion: 1,
    kind: "remote_execution_manifest",
    manifestId: `remote-manifest-${randomUUID()}`,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    connections: [],
    jobs: [],
    integrityHash: "",
  });
}

export function validateRemoteExecutionManifest(value: unknown): RemoteExecutionManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "remote_execution_manifest") {
    throw repositoryError("invalid_schema", "Remote manifest header is invalid.");
  }
  const manifest = value as unknown as RemoteExecutionManifest;
  identifier(manifest.manifestId, "manifestId");
  if (!Number.isSafeInteger(manifest.revision) || manifest.revision < 1) throw repositoryError("invalid_schema", "Remote manifest revision is invalid.");
  parseIso(manifest.createdAt, "createdAt");
  parseIso(manifest.updatedAt, "updatedAt");
  if (!Array.isArray(manifest.connections) || !Array.isArray(manifest.jobs)) throw repositoryError("invalid_schema", "Remote manifest collections are invalid.");
  const connections = manifest.connections.map(validateConnectionRecord);
  const jobs = manifest.jobs.map(validateRemoteJob);
  unique(connections.map((entry) => entry.connectionId), "connectionId");
  unique(jobs.map((entry) => entry.jobId), "jobId");
  for (const job of jobs) {
    const connection = connections.find((candidate) => candidate.connectionId === job.connectionId);
    if (!connection) {
      throw repositoryError("invalid_schema", `Remote job ${job.jobId} references an unknown connection.`);
    }
    const rel = posix.relative(connection.workspaceRoot, job.workdir);
    if (!rel || rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) {
      throw repositoryError("invalid_schema", `Remote job ${job.jobId} workdir escapes its registered workspace.`);
    }
  }
  const normalized = Object.freeze({ ...manifest, connections: Object.freeze(connections), jobs: Object.freeze(jobs) });
  const expected = manifestHash(normalized);
  if (manifest.integrityHash !== expected) throw repositoryError("invalid_schema", "Remote manifest integrity hash does not match its content.");
  return normalized;
}

function nextManifest(
  existing: RemoteExecutionManifest,
  now: Date,
  changes: Partial<Pick<RemoteExecutionManifest, "connections" | "jobs">>,
): RemoteExecutionManifest {
  return finalizeManifest({
    ...existing,
    ...changes,
    revision: existing.revision + 1,
    updatedAt: now.toISOString(),
    integrityHash: "",
  });
}

function finalizeManifest(value: RemoteExecutionManifest): RemoteExecutionManifest {
  const normalized = Object.freeze({
    ...value,
    connections: Object.freeze([...value.connections]),
    jobs: Object.freeze([...value.jobs]),
    integrityHash: "",
  });
  return Object.freeze({ ...normalized, integrityHash: manifestHash(normalized) });
}

function manifestHash(value: RemoteExecutionManifest): string {
  const { integrityHash: _integrityHash, ...content } = value;
  return hashResearchArtifactContent(content);
}

function validateConnectionRecord(value: unknown): RemoteConnectionRecord {
  if (!isRecord(value)) throw repositoryError("invalid_schema", "Remote connection record is invalid.");
  const record = value as unknown as RemoteConnectionRecord;
  const createdAt = parseIso(record.createdAt, "connection.createdAt");
  const updatedAt = parseIso(record.updatedAt, "connection.updatedAt");
  let normalized: RemoteConnectionRecord;
  try {
    normalized = normalizeRemoteConnection(record, new Date(createdAt));
  } catch (error) {
    throw repositoryError("invalid_schema", `Remote connection record is invalid: ${messageOf(error)}`);
  }
  if (!sameConnectionTerms(record, normalized)) throw repositoryError("invalid_schema", "Remote connection terms are not normalized.");
  return Object.freeze({ ...normalized, createdAt, updatedAt });
}

function validateRemoteJob(value: unknown): RemoteJobRecord {
  if (!isRecord(value)) throw repositoryError("invalid_schema", "Remote job record is invalid.");
  const record = value as unknown as RemoteJobRecord;
  for (const [key, entry] of [["jobId", record.jobId], ["attemptId", record.attemptId], ["experimentId", record.experimentId], ["grantId", record.grantId], ["connectionId", record.connectionId]] as const) {
    identifier(entry, key);
  }
  if (!Array.isArray(record.argv) || !Array.isArray(record.stagedFiles) || !Array.isArray(record.events) || record.events.length === 0) {
    throw repositoryError("invalid_schema", `Remote job ${record.jobId} collections are invalid.`);
  }
  if (!EXECUTION_GRANT_MODES.includes(record.grantMode) || !REMOTE_BACKENDS.includes(record.backend)
    || !EXPERIMENT_RUN_STATUSES.includes(record.status) || !REMOTE_SUBMISSION_PHASES.includes(record.phase)) {
    throw repositoryError("invalid_schema", `Remote job ${record.jobId} has invalid enum fields.`);
  }
  const requestHash = storedHash(record.requestHash, "job.requestHash");
  const workdir = normalizeRemoteAbsolutePath(record.workdir, "job.workdir");
  const argv = Object.freeze(normalizeArgv(record.argv));
  const slurm = record.backend === "slurm" ? normalizeSlurmResources(record.slurm) : undefined;
  const maxWallTimeMs = record.maxWallTimeMs === undefined
    ? undefined
    : storedInteger(record.maxWallTimeMs, "job.maxWallTimeMs", 1, 86_400_000);
  if (record.backend === "ssh" && record.slurm !== undefined) throw repositoryError("invalid_schema", "SSH job contains Slurm resources.");
  const stagedFiles = Object.freeze(record.stagedFiles.map((file, index) => validateStagedFile(file, workdir, index)));
  const events = Object.freeze(record.events.map((event, index) => validateJobEvent(event, index, record.backend)));
  const latestEvent = events.at(-1)!;
  if (latestEvent.status !== record.status || latestEvent.phase !== record.phase) {
    throw repositoryError("invalid_schema", `Remote job ${record.jobId} latest event does not match its state.`);
  }
  const createdAt = parseIso(record.createdAt, "job.createdAt");
  const updatedAt = parseIso(record.updatedAt, "job.updatedAt");
  const backendJobId = record.backendJobId === undefined ? undefined : storedBackendJobId(record.backendJobId, record.backend);
  const schedulerJobId = record.schedulerJobId === undefined ? undefined : storedSchedulerJobId(record.schedulerJobId);
  if (record.backend === "ssh" && schedulerJobId !== undefined) throw repositoryError("invalid_schema", "SSH job contains a scheduler job id.");
  const failure = record.failure === undefined ? undefined : validateRemoteExperimentFailure(record.failure);
  for (const [key, entry] of [
    ["submittedAt", record.submittedAt],
    ["startedAt", record.startedAt],
    ["finishedAt", record.finishedAt],
    ["lastObservedAt", record.lastObservedAt],
  ] as const) {
    if (entry !== undefined) parseIso(entry, `job.${key}`);
  }
  return Object.freeze({
    ...record,
    requestHash,
    workdir,
    argv,
    ...(slurm === undefined ? {} : { slurm }),
    ...(maxWallTimeMs === undefined ? {} : { maxWallTimeMs }),
    stagedFiles,
    ...(backendJobId === undefined ? {} : { backendJobId }),
    ...(schedulerJobId === undefined ? {} : { schedulerJobId }),
    createdAt,
    updatedAt,
    ...(failure === undefined ? {} : { failure }),
    events,
  });
}

async function ensureRemoteDirectory(paths: RemoteExecutionPaths): Promise<void> {
  const base = await loadProjectExperimentManifest({ projectRoot: paths.projectRoot });
  if (!base) throw repositoryError("invalid_input", "Experiment manifest must exist before remote execution state is created.");
  try {
    await mkdir(paths.remoteDir, { recursive: true });
    const stats = await lstat(paths.remoteDir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw repositoryError("path_violation", "Remote execution storage is not a real directory.");
  } catch (error) {
    if (error instanceof RemoteExecutionRepositoryError) throw error;
    throw storageError(error, "Unable to create remote execution storage.");
  }
}

async function readManifestIfPresent(path: string): Promise<RemoteExecutionManifest | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_REMOTE_MANIFEST_BYTES) throw repositoryError("invalid_schema", "Remote manifest is not a bounded regular file.");
    return validateRemoteExecutionManifest(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    if (error instanceof RemoteExecutionRepositoryError) throw error;
    throw repositoryError("invalid_schema", `Remote manifest is invalid: ${messageOf(error)}`);
  }
}

async function withLock<T>(paths: RemoteExecutionPaths, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: FileHandle | undefined;
  while (!handle) {
    try {
      handle = await open(paths.lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw storageError(error, "Unable to acquire remote manifest lock.");
      await reclaimStaleLock(paths.lockPath);
      if (Date.now() >= deadline) throw repositoryError("repository_busy", "Remote execution manifest is busy.");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(paths.lockPath).catch(() => undefined);
  }
}

async function reclaimStaleLock(path: string): Promise<void> {
  try {
    const [content, stats] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (Date.now() - stats.mtimeMs < LOCK_STALE_MS) return;
    const pid = Number(content.split(/\r?\n/u)[0]);
    if (Number.isSafeInteger(pid) && pid > 0 && processExists(pid)) return;
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) return;
  }
}

async function writeManifestAtomically(paths: RemoteExecutionPaths, manifest: RemoteExecutionManifest): Promise<void> {
  const temporary = join(paths.remoteDir, `.manifest-${process.pid}-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, paths.manifestPath);
  } catch (error) {
    throw storageError(error, "Unable to write remote execution manifest.");
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function assertWithin(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel)) {
    throw repositoryError("path_violation", "Remote execution path must remain below the Project root.");
  }
}

function sortJobs(values: readonly RemoteJobRecord[]): RemoteJobRecord[] {
  return [...values].sort((left, right) => left.jobId.localeCompare(right.jobId, "en"));
}

function validateStagedFile(value: unknown, workdir: string, index: number): RemoteStagedFileRecord {
  if (!isRecord(value)) throw repositoryError("invalid_schema", `Remote staged file ${index} is invalid.`);
  const localRelativePath = storedLocalRelativePath(value.localRelativePath, `stagedFiles[${index}].localRelativePath`);
  const remoteRelativePath = normalizeRemoteRelativePath(value.remoteRelativePath, `stagedFiles[${index}].remoteRelativePath`);
  const remotePath = normalizeRemoteAbsolutePath(value.remotePath, `stagedFiles[${index}].remotePath`);
  if (remotePath !== resolveRemoteChild(workdir, remoteRelativePath, `stagedFiles[${index}].remoteRelativePath`)) {
    throw repositoryError("invalid_schema", `Remote staged file ${index} path does not match its workdir.`);
  }
  const bytes = storedInteger(value.bytes, `stagedFiles[${index}].bytes`, 0, 16 * 1024 * 1024);
  const digest = storedHash(value.sha256, `stagedFiles[${index}].sha256`);
  const stagedAt = parseIso(value.stagedAt, `stagedFiles[${index}].stagedAt`);
  return Object.freeze({ localRelativePath, remoteRelativePath, remotePath, bytes, sha256: digest, stagedAt });
}

function validateJobEvent(value: unknown, index: number, backend: RemoteBackend): RemoteJobEvent {
  if (!isRecord(value) || value.sequence !== index + 1 || !EXPERIMENT_RUN_STATUSES.includes(value.status as never)
    || !REMOTE_SUBMISSION_PHASES.includes(value.phase as never) || typeof value.message !== "string"
    || !value.message.trim() || value.message.length > 16_384) {
    throw repositoryError("invalid_schema", `Remote job event ${index} is invalid.`);
  }
  const at = parseIso(value.at, `events[${index}].at`);
  const backendJobId = value.backendJobId === undefined ? undefined : storedBackendJobId(value.backendJobId, backend);
  return Object.freeze({
    sequence: index + 1,
    at,
    status: value.status as RemoteJobEvent["status"],
    phase: value.phase as RemoteJobEvent["phase"],
    message: value.message,
    ...(backendJobId === undefined ? {} : { backendJobId }),
  });
}

function storedLocalRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\u0000") || posix.isAbsolute(value)
    || posix.normalize(value) !== value || value === "." || value === ".." || value.startsWith("../")) {
    throw repositoryError("invalid_schema", `${label} is invalid.`);
  }
  return value;
}

function storedBackendJobId(value: unknown, backend: RemoteBackend): string {
  if (typeof value !== "string" || !new RegExp(`^${backend}:[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$`, "u").test(value)) {
    throw repositoryError("invalid_schema", "Remote backend job id is invalid.");
  }
  return value;
}

function storedSchedulerJobId(value: unknown): string {
  if (typeof value !== "string" || !/^\d+(?:_[0-9]+)?$/u.test(value)) throw repositoryError("invalid_schema", "Slurm scheduler job id is invalid.");
  return value;
}

function storedHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw repositoryError("invalid_schema", `${label} is invalid.`);
  return value;
}

function storedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw repositoryError("invalid_schema", `${label} is invalid.`);
  }
  return value as number;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw repositoryError("invalid_schema", `Remote manifest contains duplicate ${label} values.`);
}

function parseIso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw repositoryError("invalid_schema", `${label} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function repositoryError(code: RemoteExecutionRepositoryError["code"], message: string): RemoteExecutionRepositoryError {
  return new RemoteExecutionRepositoryError(code, message);
}

function storageError(error: unknown, prefix: string): RemoteExecutionRepositoryError {
  return repositoryError("storage_error", `${prefix} ${messageOf(error)}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
