import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { posix } from "node:path";
import {
  canonicalJson,
  hashResearchArtifactContent,
} from "../../artifacts/index.js";
import type { ExperimentFailure } from "../contracts.js";
import type {
  RemoteAgentStageRequest,
  RemoteAgentSubmitRequest,
  RemoteBackendStatus,
  RemoteStagedFileRecord,
} from "./contracts.js";
import {
  assertRemotePathWithin,
  normalizeRemoteAbsolutePath,
  normalizeRemoteRelativePath,
  remoteJobKey,
  resolveRemoteChild,
  sha256,
} from "./paths.js";
import {
  validateRemoteAgentRequest,
  validateRemoteExperimentFailure,
} from "./protocol.js";
import { identifier } from "./validation.js";

const MAX_AGENT_STATE_BYTES = 4 * 1024 * 1024;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 120_000;

export type RemoteAgentJobState = Readonly<{
  schemaVersion: 1;
  kind: "remote_agent_job";
  request: RemoteAgentSubmitRequest;
  status: RemoteBackendStatus;
  backendJobId?: string;
  schedulerJobId?: string;
  slurmJobName?: string;
  runnerPid?: number;
  processPid?: number;
  exitCode?: number | null;
  signal?: string;
  failure?: ExperimentFailure;
  createdAt: string;
  updatedAt: string;
  observedAt: string;
  submittedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  integrityHash: string;
}>;

export type RemoteAgentStageReceipt = Readonly<{
  schemaVersion: 1;
  kind: "remote_agent_stage";
  connectionId: string;
  projectId: string;
  jobId: string;
  requestHash: string;
  workdir: string;
  files: readonly Pick<RemoteStagedFileRecord, "remoteRelativePath" | "remotePath" | "bytes" | "sha256">[];
  createdAt: string;
  integrityHash: string;
}>;

export type RemoteAgentJobPaths = Readonly<{
  key: string;
  actualDirectory: string;
  actualJobPath: string;
  actualStagePath: string;
  actualLockPath: string;
  actualStdoutPath: string;
  actualStderrPath: string;
  remoteJobPath: string;
  remoteStdoutPath: string;
  remoteStderrPath: string;
}>;

export class RemoteAgentStateError extends Error {
  readonly code: "path_violation" | "hash_mismatch" | "job_conflict" | "job_not_found" | "storage_error";

  constructor(code: RemoteAgentStateError["code"], message: string) {
    super(message);
    this.name = "RemoteAgentStateError";
    this.code = code;
  }
}

export class RemoteAgentStateRepository {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly actualWorkspaceRoot: string;
  readonly actualStateRoot: string;
  readonly #now: () => Date;

  constructor(options: Readonly<{
    workspaceRoot: string;
    stateRoot: string;
    actualWorkspaceRoot?: string;
    actualStateRoot?: string;
    now?: () => Date;
  }>) {
    this.workspaceRoot = normalizeRemoteAbsolutePath(options.workspaceRoot, "workspaceRoot");
    this.stateRoot = normalizeRemoteAbsolutePath(options.stateRoot, "stateRoot");
    this.actualWorkspaceRoot = absoluteLocalPath(options.actualWorkspaceRoot ?? this.workspaceRoot, "actualWorkspaceRoot");
    this.actualStateRoot = absoluteLocalPath(options.actualStateRoot ?? this.stateRoot, "actualStateRoot");
    this.#now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await assertSafeRoot(this.actualWorkspaceRoot);
    await assertSafeRoot(this.actualStateRoot);
  }

  assertRequestRoots(request: Readonly<{ workspaceRoot: string; stateRoot: string }>): void {
    if (request.workspaceRoot !== this.workspaceRoot || request.stateRoot !== this.stateRoot) {
      throw stateError("path_violation", "Request roots do not match the remote agent configuration.");
    }
  }

  pathsFor(request: Readonly<{ connectionId: string; projectId: string; jobId: string }>): RemoteAgentJobPaths {
    const key = remoteJobKey(`${request.connectionId}\u0000${request.projectId}\u0000${request.jobId}`);
    const actualDirectory = join(this.actualStateRoot, "jobs", key);
    const remoteDirectory = posix.join(this.stateRoot, "jobs", key);
    return Object.freeze({
      key,
      actualDirectory,
      actualJobPath: join(actualDirectory, "job.json"),
      actualStagePath: join(actualDirectory, "stage.json"),
      actualLockPath: join(actualDirectory, ".job.lock"),
      actualStdoutPath: join(actualDirectory, "stdout.log"),
      actualStderrPath: join(actualDirectory, "stderr.log"),
      remoteJobPath: posix.join(remoteDirectory, "job.json"),
      remoteStdoutPath: posix.join(remoteDirectory, "stdout.log"),
      remoteStderrPath: posix.join(remoteDirectory, "stderr.log"),
    });
  }

  pathsFromRemoteJobPath(remoteJobPath: string): RemoteAgentJobPaths {
    const normalized = normalizeRemoteAbsolutePath(remoteJobPath, "remote job state path");
    assertRemotePathWithin(this.stateRoot, normalized, "remote job state path");
    const rel = posix.relative(this.stateRoot, normalized);
    const parts = rel.split("/");
    if (parts.length !== 3 || parts[0] !== "jobs" || !/^[a-f0-9]{64}$/u.test(parts[1] ?? "") || parts[2] !== "job.json") {
      throw stateError("path_violation", "Worker state path is not a remote agent job record.");
    }
    const key = parts[1]!;
    const actualDirectory = join(this.actualStateRoot, "jobs", key);
    const remoteDirectory = posix.join(this.stateRoot, "jobs", key);
    return Object.freeze({
      key,
      actualDirectory,
      actualJobPath: join(actualDirectory, "job.json"),
      actualStagePath: join(actualDirectory, "stage.json"),
      actualLockPath: join(actualDirectory, ".job.lock"),
      actualStdoutPath: join(actualDirectory, "stdout.log"),
      actualStderrPath: join(actualDirectory, "stderr.log"),
      remoteJobPath: posix.join(remoteDirectory, "job.json"),
      remoteStdoutPath: posix.join(remoteDirectory, "stdout.log"),
      remoteStderrPath: posix.join(remoteDirectory, "stderr.log"),
    });
  }

  actualWorkdir(remoteWorkdir: string): string {
    const normalized = normalizeRemoteAbsolutePath(remoteWorkdir, "workdir");
    assertRemotePathWithin(this.workspaceRoot, normalized, "workdir");
    if (normalized === this.workspaceRoot) throw stateError("path_violation", "workdir must be below workspaceRoot.");
    return join(this.actualWorkspaceRoot, ...posix.relative(this.workspaceRoot, normalized).split("/"));
  }

  async withJobLock<T>(paths: RemoteAgentJobPaths, operation: () => Promise<T>): Promise<T> {
    await ensureSafeDirectoryBelow(this.actualStateRoot, paths.actualDirectory);
    const deadline = Date.now() + LOCK_WAIT_MS;
    let handle: FileHandle | undefined;
    while (!handle) {
      try {
        handle = await open(paths.actualLockPath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n${hostname()}\n${Date.now()}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw storageError(error, "Unable to acquire remote job lock.");
        await reclaimStaleLock(paths.actualLockPath);
        if (Date.now() >= deadline) throw stateError("storage_error", "Remote job state is busy.");
        await delay(20);
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(paths.actualLockPath).catch(() => undefined);
    }
  }

  async loadJob(paths: RemoteAgentJobPaths): Promise<RemoteAgentJobState | undefined> {
    return readBoundedJson(paths.actualJobPath, validateJobState);
  }

  async saveJob(paths: RemoteAgentJobPaths, state: RemoteAgentJobState): Promise<RemoteAgentJobState> {
    const finalized = finalizeJobState(state);
    await writeJsonAtomically(paths.actualDirectory, paths.actualJobPath, finalized);
    return finalized;
  }

  async loadStage(paths: RemoteAgentJobPaths): Promise<RemoteAgentStageReceipt | undefined> {
    return readBoundedJson(paths.actualStagePath, validateStageReceipt);
  }

  async verifyStage(receipt: RemoteAgentStageReceipt): Promise<void> {
    await this.#verifyStagedFiles(receipt.files);
  }

  async stage(request: RemoteAgentStageRequest): Promise<Readonly<{
    duplicate: boolean;
    files: RemoteAgentStageReceipt["files"];
  }>> {
    this.assertRequestRoots(request);
    const paths = this.pathsFor(request);
    return this.withJobLock(paths, async () => {
      const existingJob = await this.loadJob(paths);
      assertJobBinding(existingJob, request.requestHash, request.jobId);
      const existing = await this.loadStage(paths);
      if (existing) {
        assertStageBinding(existing, request);
        await this.#verifyStagedFiles(existing.files);
        return Object.freeze({ duplicate: true, files: existing.files });
      }
      if (existingJob) throw stateError("job_conflict", "Files cannot be staged after remote submission has started.");
      const workdir = this.actualWorkdir(request.workdir);
      await ensureSafeDirectoryBelow(this.actualWorkspaceRoot, workdir);
      const files: NonNullable<RemoteAgentStageReceipt["files"]>[number][] = [];
      for (const file of request.files) {
        const actualPath = this.#actualWorkspacePath(file.remotePath);
        const parent = dirname(actualPath);
        await ensureSafeDirectoryBelow(this.actualWorkspaceRoot, parent);
        const content = Buffer.from(file.contentBase64, "base64");
        if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
          throw stateError("hash_mismatch", `Staged content changed for ${file.remoteRelativePath}.`);
        }
        await installImmutableFile(parent, actualPath, content, file.sha256, file.bytes);
        files.push(Object.freeze({
          remoteRelativePath: file.remoteRelativePath,
          remotePath: file.remotePath,
          bytes: file.bytes,
          sha256: file.sha256,
        }));
      }
      const now = this.#now().toISOString();
      const receipt = finalizeStageReceipt({
        schemaVersion: 1,
        kind: "remote_agent_stage",
        connectionId: request.connectionId,
        projectId: request.projectId,
        jobId: request.jobId,
        requestHash: request.requestHash,
        workdir: request.workdir,
        files: Object.freeze(files),
        createdAt: now,
        integrityHash: "",
      });
      await writeJsonAtomically(paths.actualDirectory, paths.actualStagePath, receipt);
      return Object.freeze({ duplicate: false, files: receipt.files });
    });
  }

  now(): Date {
    return this.#now();
  }

  async ensureWorkdir(remoteWorkdir: string): Promise<string> {
    const actual = this.actualWorkdir(remoteWorkdir);
    await ensureSafeDirectoryBelow(this.actualWorkspaceRoot, actual);
    return actual;
  }

  #actualWorkspacePath(remotePath: string): string {
    const normalized = normalizeRemoteAbsolutePath(remotePath, "remotePath");
    assertRemotePathWithin(this.workspaceRoot, normalized, "remotePath");
    if (normalized === this.workspaceRoot) throw stateError("path_violation", "A staged file cannot replace workspaceRoot.");
    return join(this.actualWorkspaceRoot, ...posix.relative(this.workspaceRoot, normalized).split("/"));
  }

  async #verifyStagedFiles(files: RemoteAgentStageReceipt["files"]): Promise<void> {
    for (const file of files) {
      const actualPath = this.#actualWorkspacePath(file.remotePath);
      await assertSafeRegularFile(this.actualWorkspaceRoot, actualPath);
      const content = await readFile(actualPath);
      if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
        throw stateError("hash_mismatch", `Previously staged file no longer matches ${file.remoteRelativePath}.`);
      }
    }
  }
}

export function createRemoteAgentJobState(input: {
  request: RemoteAgentSubmitRequest;
  status: RemoteBackendStatus;
  backendJobId?: string;
  slurmJobName?: string;
  now: Date;
}): RemoteAgentJobState {
  const timestamp = input.now.toISOString();
  return finalizeJobState({
    schemaVersion: 1,
    kind: "remote_agent_job",
    request: input.request,
    status: input.status,
    ...(input.backendJobId === undefined ? {} : { backendJobId: input.backendJobId }),
    ...(input.slurmJobName === undefined ? {} : { slurmJobName: input.slurmJobName }),
    createdAt: timestamp,
    updatedAt: timestamp,
    observedAt: timestamp,
    integrityHash: "",
  });
}

export function updateRemoteAgentJobState(
  current: RemoteAgentJobState,
  changes: Partial<Omit<RemoteAgentJobState, "schemaVersion" | "kind" | "request" | "createdAt" | "integrityHash">>,
  now: Date,
): RemoteAgentJobState {
  return finalizeJobState({
    ...current,
    ...changes,
    updatedAt: now.toISOString(),
    observedAt: changes.observedAt ?? now.toISOString(),
    integrityHash: "",
  });
}

function finalizeJobState(value: RemoteAgentJobState): RemoteAgentJobState {
  const normalized = Object.freeze({ ...value, integrityHash: "" });
  return Object.freeze({ ...normalized, integrityHash: stateHash(normalized) });
}

function validateJobState(value: unknown): RemoteAgentJobState {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "remote_agent_job" || !isRecord(value.request)) {
    throw stateError("storage_error", "Remote agent job state header is invalid.");
  }
  const request = validateRemoteAgentRequest(value.request);
  if (request.action !== "submit") throw stateError("storage_error", "Remote agent job state does not contain a submission.");
  if (!["queued", "running", "succeeded", "failed", "cancelled", "unknown"].includes(String(value.status))) {
    throw stateError("storage_error", "Remote agent job status is invalid.");
  }
  for (const key of ["createdAt", "updatedAt", "observedAt"] as const) parseIso(value[key], key);
  for (const key of ["submittedAt", "startedAt", "finishedAt", "cancelRequestedAt"] as const) {
    if (value[key] !== undefined) parseIso(value[key], key);
  }
  const backendJobId = value.backendJobId === undefined ? undefined : storedBackendJobId(value.backendJobId, request.backend);
  const schedulerJobId = value.schedulerJobId === undefined ? undefined : storedSchedulerJobId(value.schedulerJobId);
  const slurmJobName = value.slurmJobName === undefined ? undefined : storedSlurmJobName(value.slurmJobName);
  if (request.backend === "ssh" && (schedulerJobId !== undefined || slurmJobName !== undefined)) {
    throw stateError("storage_error", "SSH job state contains Slurm identity fields.");
  }
  const runnerPid = value.runnerPid === undefined ? undefined : storedPid(value.runnerPid, "runnerPid");
  const processPid = value.processPid === undefined ? undefined : storedPid(value.processPid, "processPid");
  const exitCode = value.exitCode === undefined ? undefined : storedExitCode(value.exitCode);
  const signal = value.signal === undefined ? undefined : identifier(value.signal, "signal");
  const failure = value.failure === undefined ? undefined : validateRemoteExperimentFailure(value.failure);
  const candidate = Object.freeze({
    ...value,
    request,
    ...(backendJobId === undefined ? {} : { backendJobId }),
    ...(schedulerJobId === undefined ? {} : { schedulerJobId }),
    ...(slurmJobName === undefined ? {} : { slurmJobName }),
    ...(runnerPid === undefined ? {} : { runnerPid }),
    ...(processPid === undefined ? {} : { processPid }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    ...(failure === undefined ? {} : { failure }),
  }) as unknown as RemoteAgentJobState;
  if (candidate.integrityHash !== stateHash(candidate)) throw stateError("storage_error", "Remote agent job state integrity hash does not match.");
  return candidate;
}

function finalizeStageReceipt(value: RemoteAgentStageReceipt): RemoteAgentStageReceipt {
  const normalized = Object.freeze({ ...value, files: Object.freeze([...value.files]), integrityHash: "" });
  return Object.freeze({ ...normalized, integrityHash: stateHash(normalized) });
}

function validateStageReceipt(value: unknown): RemoteAgentStageReceipt {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "remote_agent_stage" || !Array.isArray(value.files)
    || typeof value.connectionId !== "string" || typeof value.projectId !== "string" || typeof value.jobId !== "string"
    || typeof value.requestHash !== "string" || typeof value.workdir !== "string" || typeof value.createdAt !== "string") {
    throw stateError("storage_error", "Remote stage receipt is invalid.");
  }
  identifier(value.connectionId, "stage.connectionId");
  identifier(value.projectId, "stage.projectId");
  identifier(value.jobId, "stage.jobId");
  storedHash(value.requestHash, "stage.requestHash");
  const workdir = normalizeRemoteAbsolutePath(value.workdir, "stage.workdir");
  parseIso(value.createdAt, "stage.createdAt");
  if (value.files.length > 128) throw stateError("storage_error", "Remote stage receipt contains too many files.");
  const seen = new Set<string>();
  const files = value.files.map((file, index) => {
    if (!isRecord(file)) throw stateError("storage_error", `Remote stage file ${index} is invalid.`);
    const remoteRelativePath = normalizeRemoteRelativePath(file.remoteRelativePath, `stage.files[${index}].remoteRelativePath`);
    const remotePath = normalizeRemoteAbsolutePath(file.remotePath, `stage.files[${index}].remotePath`);
    if (remotePath !== resolveRemoteChild(workdir, remoteRelativePath, `stage.files[${index}].remoteRelativePath`) || seen.has(remotePath)) {
      throw stateError("storage_error", `Remote stage file ${index} has an invalid or duplicate path.`);
    }
    seen.add(remotePath);
    const bytes = storedInteger(file.bytes, `stage.files[${index}].bytes`, 0, 16 * 1024 * 1024);
    const digest = storedHash(file.sha256, `stage.files[${index}].sha256`);
    return Object.freeze({ remoteRelativePath, remotePath, bytes, sha256: digest });
  });
  const receipt = Object.freeze({
    ...value,
    workdir,
    files: Object.freeze(files),
  }) as unknown as RemoteAgentStageReceipt;
  if (receipt.integrityHash !== stateHash(receipt)) throw stateError("storage_error", "Remote stage receipt integrity hash does not match.");
  return receipt;
}

function stateHash(value: Readonly<{ integrityHash: string }>): string {
  const { integrityHash: _integrityHash, ...content } = value;
  return hashResearchArtifactContent(content);
}

function assertJobBinding(state: RemoteAgentJobState | undefined, requestHash: string, jobId: string): void {
  if (!state) return;
  if (state.request.requestHash !== requestHash || state.request.jobId !== jobId) {
    throw stateError("job_conflict", `Remote job ${jobId} is already bound to another request.`);
  }
}

function assertStageBinding(receipt: RemoteAgentStageReceipt, request: RemoteAgentStageRequest): void {
  const expected = {
    connectionId: request.connectionId,
    projectId: request.projectId,
    jobId: request.jobId,
    requestHash: request.requestHash,
    workdir: request.workdir,
    files: request.files.map(({ remoteRelativePath, remotePath, bytes, sha256: digest }) => ({
      remoteRelativePath,
      remotePath,
      bytes,
      sha256: digest,
    })),
  };
  const actual = {
    connectionId: receipt.connectionId,
    projectId: receipt.projectId,
    jobId: receipt.jobId,
    requestHash: receipt.requestHash,
    workdir: receipt.workdir,
    files: receipt.files,
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw stateError("job_conflict", `Remote stage identity for ${request.jobId} changed.`);
  }
}

async function installImmutableFile(
  directory: string,
  destination: string,
  content: Buffer,
  expectedHash: string,
  expectedBytes: number,
): Promise<void> {
  try {
    await assertMatchingRegularFile(destination, expectedHash, expectedBytes);
    return;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const temporary = join(directory, `.stage-${process.pid}-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      await assertMatchingRegularFile(destination, expectedHash, expectedBytes);
    }
    await assertMatchingRegularFile(destination, expectedHash, expectedBytes);
  } catch (error) {
    if (error instanceof RemoteAgentStateError) throw error;
    throw storageError(error, `Unable to stage ${destination}.`);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function assertMatchingRegularFile(path: string, expectedHash: string, expectedBytes: number): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw stateError("path_violation", "Staging destination is not a regular file.");
  const content = await readFile(path);
  if (content.byteLength !== expectedBytes || sha256(content) !== expectedHash) {
    throw stateError("hash_mismatch", "Staging destination already exists with different content.");
  }
}

async function assertSafeRegularFile(root: string, path: string): Promise<void> {
  const parent = dirname(path);
  await verifySafeDirectoryBelow(root, parent);
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw stateError("path_violation", "Staged path is not a safe regular file.");
}

async function assertSafeRoot(path: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw stateError("path_violation", `Configured root does not exist: ${path}.`);
    throw storageError(error, `Unable to inspect configured root ${path}.`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw stateError("path_violation", `Configured root is not a real directory: ${path}.`);
  const resolved = resolve(path);
  const canonical = await realpath(path);
  if (relative(resolved, canonical) !== "") throw stateError("path_violation", `Configured root resolves through a symbolic link: ${path}.`);
}

async function ensureSafeDirectoryBelow(root: string, target: string): Promise<void> {
  const rel = assertLocalBelow(root, target);
  let current = root;
  for (const segment of rel.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw storageError(error, `Unable to create safe directory ${current}.`);
    }
    const stats = await lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw stateError("path_violation", `Path traverses a symbolic link or non-directory: ${current}.`);
  }
  await verifySafeDirectoryBelow(root, target);
}

async function verifySafeDirectoryBelow(root: string, target: string): Promise<void> {
  const rel = assertLocalBelow(root, target);
  let current = root;
  for (const segment of rel.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    const stats = await lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw stateError("path_violation", `Path traverses a symbolic link or non-directory: ${current}.`);
  }
  const canonicalRoot = await realpath(root);
  const canonicalTarget = await realpath(target);
  assertLocalBelow(canonicalRoot, canonicalTarget);
}

function assertLocalBelow(root: string, target: string): string {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "") return rel;
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw stateError("path_violation", `Path escapes configured root: ${target}.`);
  }
  return rel;
}

async function readBoundedJson<T>(path: string, validate: (value: unknown) => T): Promise<T | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_AGENT_STATE_BYTES) {
      throw stateError("storage_error", "Remote agent state file is invalid or too large.");
    }
    return validate(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    if (error instanceof RemoteAgentStateError) throw error;
    throw storageError(error, `Unable to read remote agent state ${path}.`);
  }
}

async function writeJsonAtomically(directory: string, destination: string, value: unknown): Promise<void> {
  const temporary = join(directory, `.state-${process.pid}-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch (error) {
    throw storageError(error, `Unable to persist remote agent state ${destination}.`);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function reclaimStaleLock(path: string): Promise<void> {
  try {
    const [content, stats] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (Date.now() - stats.mtimeMs < LOCK_STALE_MS) return;
    const [pidText, ownerHost] = content.split(/\r?\n/u);
    const pid = Number(pidText);
    if (ownerHost === hostname() && Number.isSafeInteger(pid) && pid > 0 && processExists(pid)) return;
    await unlink(path);
  } catch {
    // Another agent may have released or replaced the stale lock.
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

function absoluteLocalPath(value: string, label: string): string {
  if (!value || value.includes("\u0000") || !isAbsolute(value)) throw new TypeError(`${label} must be an absolute local path.`);
  return resolve(value);
}

function parseIso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw stateError("storage_error", `${label} is invalid.`);
  return value;
}

function storedBackendJobId(value: unknown, backend: "ssh" | "slurm"): string {
  if (typeof value !== "string" || !new RegExp(`^${backend}:[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$`, "u").test(value)) {
    throw stateError("storage_error", "Remote backend job id is invalid.");
  }
  return value;
}

function storedSchedulerJobId(value: unknown): string {
  if (typeof value !== "string" || !/^\d+(?:_[0-9]+)?$/u.test(value)) throw stateError("storage_error", "Slurm scheduler job id is invalid.");
  return value;
}

function storedSlurmJobName(value: unknown): string {
  if (typeof value !== "string" || !/^pd-[a-f0-9]{40}$/u.test(value)) throw stateError("storage_error", "Stable Slurm job name is invalid.");
  return value;
}

function storedPid(value: unknown, label: string): number {
  return storedInteger(value, label, 1, 2_147_483_647);
}

function storedExitCode(value: unknown): number | null {
  if (value === null) return null;
  return storedInteger(value, "exitCode", 0, 2_147_483_647);
}

function storedHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw stateError("storage_error", `${label} is invalid.`);
  return value;
}

function storedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw stateError("storage_error", `${label} is invalid.`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function stateError(code: RemoteAgentStateError["code"], message: string): RemoteAgentStateError {
  return new RemoteAgentStateError(code, message);
}

function storageError(error: unknown, prefix: string): RemoteAgentStateError {
  return stateError("storage_error", `${prefix} ${error instanceof Error ? error.message : String(error)}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
