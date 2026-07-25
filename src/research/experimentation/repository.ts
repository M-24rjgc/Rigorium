import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  buildResearchArtifactGraph,
  createResearchArtifact,
  RESEARCH_ARTIFACT_KINDS,
  toResearchArtifactRef,
  type ResearchArtifactEnvelope,
  type ResearchArtifactKind,
  type ResearchArtifactRef,
} from "../artifacts/index.js";
import {
  EXPERIMENTATION_SCHEMA_VERSION,
  type ArtifactRef,
  type BaselineObservation,
  type ExecutionGrant,
  type ExperimentArtifactFile,
  type ExperimentManifest,
  type ExperimentSpec,
  type MetricObservation,
  type RunAttempt,
} from "./contracts.js";

export const MAX_EXPERIMENT_MANIFEST_FILE_BYTES = 16 * 1024 * 1024;
const LOCK_RETRIES = 80;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 60_000;

export type ProjectExperimentPaths = Readonly<{
  projectRoot: string;
  pilotDeckDir: string;
  researchDir: string;
  experimentationDir: string;
  manifestPath: string;
  lockPath: string;
  runsDir: string;
}>;

export type ExperimentRepositoryErrorCode =
  | "invalid_input"
  | "invalid_project_root"
  | "path_violation"
  | "io_error"
  | "file_too_large"
  | "corrupt_json"
  | "invalid_schema"
  | "revision_conflict"
  | "repository_busy";

export type ExperimentRepositoryDiagnostic = Readonly<{
  code: ExperimentRepositoryErrorCode;
  message: string;
  path?: string;
  operation?: string;
}>;

export class ExperimentRepositoryError extends Error {
  readonly code: ExperimentRepositoryErrorCode;
  readonly diagnostic: ExperimentRepositoryDiagnostic;

  constructor(
    code: ExperimentRepositoryErrorCode,
    message: string,
    context: Omit<ExperimentRepositoryDiagnostic, "code" | "message"> = {},
  ) {
    super(message);
    this.name = "ExperimentRepositoryError";
    this.code = code;
    this.diagnostic = Object.freeze({ code, message, ...context });
  }
}

export type ExperimentManifestUpdateResult<T> = Readonly<{
  path: string;
  manifest: ExperimentManifest;
  value: T;
  created: boolean;
  persisted: boolean;
}>;

export function getProjectExperimentPaths(input: { projectRoot: string }): ProjectExperimentPaths {
  if (!input || typeof input.projectRoot !== "string" || !input.projectRoot.trim()) {
    throw repositoryError("invalid_input", "projectRoot must be a non-empty path.", { operation: "resolve_paths" });
  }
  const projectRoot = resolve(input.projectRoot);
  const pilotDeckDir = join(projectRoot, ".pilotdeck");
  const researchDir = join(pilotDeckDir, "research");
  const experimentationDir = join(researchDir, "experimentation");
  const manifestPath = join(experimentationDir, "manifest.json");
  const lockPath = join(experimentationDir, ".manifest.lock");
  const runsDir = join(experimentationDir, "runs");
  for (const candidate of [pilotDeckDir, researchDir, experimentationDir, manifestPath, lockPath, runsDir]) {
    assertWithinProject(projectRoot, candidate);
  }
  return Object.freeze({ projectRoot, pilotDeckDir, researchDir, experimentationDir, manifestPath, lockPath, runsDir });
}

export function createEmptyExperimentManifest(now = new Date()): ExperimentManifest {
  const timestamp = nowIso(now);
  return {
    schemaVersion: EXPERIMENTATION_SCHEMA_VERSION,
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

export async function loadProjectExperimentManifest(input: {
  projectRoot: string;
}): Promise<ExperimentManifest | undefined> {
  const paths = getProjectExperimentPaths({ projectRoot: input.projectRoot });
  await assertExistingDirectoryChain(paths, "load_manifest");
  const value = await readBoundedJson(paths.manifestPath, "load_manifest");
  return value === undefined ? undefined : validateManifestDocument(value, paths.manifestPath);
}

/**
 * Executes one manifest mutation under a short-lived exclusive lock. The lock
 * covers only read/validate/write, never the worker process itself; this is
 * what prevents two callers from submitting the same idempotency key.
 */
export async function updateProjectExperimentManifest<T>(input: {
  projectRoot: string;
  expectedRevision?: number;
  now?: Date;
  update: (existing: ExperimentManifest | undefined, now: Date) => { manifest: ExperimentManifest; value: T };
}): Promise<ExperimentManifestUpdateResult<T>> {
  const paths = getProjectExperimentPaths({ projectRoot: input.projectRoot });
  const now = input.now ?? new Date();
  nowIso(now);
  await ensureDirectories(paths);
  return withManifestLock(paths, async () => {
    const existingValue = await readBoundedJson(paths.manifestPath, "update_manifest");
    const existing = existingValue === undefined ? undefined : validateManifestDocument(existingValue, paths.manifestPath);
    const actualRevision = existing?.revision ?? 0;
    if (input.expectedRevision !== undefined) {
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw repositoryError("invalid_input", "expectedRevision must be a non-negative integer.", {
          path: paths.manifestPath,
          operation: "update_manifest",
        });
      }
      if (input.expectedRevision !== actualRevision) {
        throw repositoryError("revision_conflict", `Expected manifest revision ${input.expectedRevision}, found ${actualRevision}.`, {
          path: paths.manifestPath,
          operation: "update_manifest",
        });
      }
    }
    const result = input.update(existing, now);
    const manifest = validateManifestDocument(result.manifest, paths.manifestPath);
    const persisted = !existing || JSON.stringify(existing) !== JSON.stringify(manifest);
    if (persisted) await writeJsonAtomically(paths.manifestPath, manifest, "update_manifest");
    return {
      path: paths.manifestPath,
      manifest,
      value: result.value,
      created: !existing,
      persisted,
    };
  });
}

export function getExperimentRunWorkspacePath(input: { projectRoot: string; attemptId: string }): string {
  const paths = getProjectExperimentPaths({ projectRoot: input.projectRoot });
  const attemptId = requireIdentifier(input.attemptId, "attemptId");
  const workspace = join(paths.runsDir, attemptId);
  assertWithinProject(paths.projectRoot, workspace);
  return workspace;
}

export async function createExperimentRunWorkspace(input: {
  projectRoot: string;
  attemptId: string;
}): Promise<string> {
  const paths = getProjectExperimentPaths({ projectRoot: input.projectRoot });
  await ensureDirectories(paths);
  const workspace = getExperimentRunWorkspacePath(input);
  try {
    await mkdir(workspace);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw repositoryError("path_violation", "Experiment run workspace already exists and cannot be reused.", {
        path: workspace,
        operation: "create_run_workspace",
      });
    }
    throw asIoError(error, workspace, "create_run_workspace");
  }
  const stats = await lstatIfExists(workspace, "create_run_workspace");
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw repositoryError("path_violation", "Experiment run workspace must be a regular project-local directory.", {
      path: workspace,
      operation: "create_run_workspace",
    });
  }
  return workspace;
}

export function validateExperimentManifest(value: unknown, path = "manifest.json"): ExperimentManifest {
  return validateManifestDocument(value, path);
}

function validateManifestDocument(value: unknown, path: string): ExperimentManifest {
  const manifest = expectRecord(value, "experiment manifest", path);
  if (manifest.schemaVersion !== EXPERIMENTATION_SCHEMA_VERSION || manifest.kind !== "experiment_manifest") {
    invalidSchema(path, "Unsupported experiment manifest schema.");
  }
  const result: ExperimentManifest = {
    schemaVersion: EXPERIMENTATION_SCHEMA_VERSION,
    kind: "experiment_manifest",
    manifestId: requireIdentifier(manifest.manifestId, "manifestId", path),
    revision: requirePositiveInteger(manifest.revision, "revision", path),
    createdAt: requireIsoDate(manifest.createdAt, "createdAt", path),
    updatedAt: requireIsoDate(manifest.updatedAt, "updatedAt", path),
    specs: parseEnvelopeArray(manifest.specs, "specs", "experiment_spec", path) as ExperimentSpec[],
    executionGrants: parseEnvelopeArray(manifest.executionGrants, "executionGrants", "execution_grant", path) as ExecutionGrant[],
    runAttempts: parseEnvelopeArray(manifest.runAttempts, "runAttempts", "run_attempt", path) as RunAttempt[],
    metricObservations: parseEnvelopeArray(manifest.metricObservations, "metricObservations", "metric_observation", path) as MetricObservation[],
    baselineObservations: parseEnvelopeArray(manifest.baselineObservations, "baselineObservations", "baseline_observation", path) as BaselineObservation[],
    artifactEnvelopes: parseEnvelopeArray(manifest.artifactEnvelopes, "artifactEnvelopes", undefined, path),
    artifactFiles: parseArtifactFiles(manifest.artifactFiles, path),
    artifactRefs: parseArtifactRefs(manifest.artifactRefs, path),
  };
  const allArtifacts = [
    ...result.specs,
    ...result.executionGrants,
    ...result.runAttempts,
    ...result.metricObservations,
    ...result.baselineObservations,
    ...result.artifactEnvelopes,
  ];
  try {
    const graph = buildResearchArtifactGraph(allArtifacts);
    if (graph.missingParents.length > 0) {
      invalidSchema(path, `Artifact graph has ${graph.missingParents.length} missing parent reference(s).`);
    }
  } catch (error) {
    if (error instanceof ExperimentRepositoryError) throw error;
    invalidSchema(path, `Artifact graph is invalid: ${messageOf(error)}.`);
  }
  const envelopeByKey = new Map(allArtifacts.map((artifact) => [`${artifact.artifactId}@${artifact.revision}`, artifact]));
  for (const ref of result.artifactRefs) {
    const target = envelopeByKey.get(`${ref.artifactId}@${ref.revision}`);
    if (!target || target.kind !== ref.kind || target.contentHash !== ref.contentHash) {
      invalidSchema(path, `Artifact ref ${ref.artifactId}@${ref.revision} does not resolve to an envelope.`);
    }
  }
  for (const file of result.artifactFiles) {
    const target = envelopeByKey.get(`${file.ref.artifactId}@${file.ref.revision}`);
    if (!target || target.kind !== file.ref.kind || target.contentHash !== file.ref.contentHash) {
      invalidSchema(path, `Artifact file ${file.relativePath} references a missing envelope.`);
    }
  }
  return result;
}

async function withManifestLock<T>(paths: ProjectExperimentPaths, operation: () => Promise<T>): Promise<T> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      handle = await open(paths.lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
      await handle.sync();
      break;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        if (handle) {
          try { await handle.close(); } catch { /* preserve the acquisition failure */ }
          handle = undefined;
          try { await unlink(paths.lockPath); } catch { /* best-effort cleanup */ }
        }
        throw asIoError(error, paths.lockPath, "acquire_manifest_lock");
      }
      if (await reclaimStaleManifestLock(paths)) continue;
      if (attempt === LOCK_RETRIES - 1) {
        throw repositoryError("repository_busy", "Another process is updating the experiment manifest.", {
          path: paths.lockPath,
          operation: "acquire_manifest_lock",
        });
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the operation result/error; cleanup below is best effort.
      }
      try {
        await unlink(paths.lockPath);
      } catch {
        // A failed cleanup is recoverable on the next explicit operation.
      }
    }
  }
}

async function reclaimStaleManifestLock(paths: ProjectExperimentPaths): Promise<boolean> {
  const stats = await lstatIfExists(paths.lockPath, "inspect_manifest_lock");
  if (!stats) return true;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw repositoryError("path_violation", "Experiment manifest lock must be a regular project-local file.", {
      path: paths.lockPath,
      operation: "inspect_manifest_lock",
    });
  }
  if (Date.now() - stats.mtimeMs < LOCK_STALE_MS) return false;

  let ownerPid: number | undefined;
  if (stats.size <= 1_024) {
    try {
      const [pidLine] = (await readFile(paths.lockPath, "utf8")).split(/\r?\n/u);
      const parsed = Number(pidLine);
      if (Number.isSafeInteger(parsed) && parsed > 0) ownerPid = parsed;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return true;
      throw asIoError(error, paths.lockPath, "inspect_manifest_lock");
    }
  }
  if (ownerPid !== undefined && isProcessAlive(ownerPid)) return false;

  const stalePath = join(paths.experimentationDir, `.manifest.lock.stale.${process.pid}.${randomUUID()}`);
  try {
    await rename(paths.lockPath, stalePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw asIoError(error, paths.lockPath, "reclaim_manifest_lock");
  }
  try { await unlink(stalePath); } catch { /* a randomized stale lock never blocks future updates */ }
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

async function assertProjectRoot(paths: ProjectExperimentPaths, operation: string): Promise<void> {
  const root = await lstatIfExists(paths.projectRoot, operation);
  if (!root || !root.isDirectory() || root.isSymbolicLink()) {
    throw repositoryError("invalid_project_root", "projectRoot must be an existing regular directory.", {
      path: paths.projectRoot,
      operation,
    });
  }
}

async function assertExistingDirectoryChain(paths: ProjectExperimentPaths, operation: string): Promise<void> {
  await assertProjectRoot(paths, operation);
  for (const directory of [paths.pilotDeckDir, paths.researchDir, paths.experimentationDir, paths.runsDir]) {
    const stats = await lstatIfExists(directory, operation);
    if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) {
      throw repositoryError("path_violation", "Experiment storage directories must not be files or symbolic links.", {
        path: directory,
        operation,
      });
    }
  }
}

async function ensureDirectories(paths: ProjectExperimentPaths): Promise<void> {
  try {
    await assertProjectRoot(paths, "ensure_directories");
    for (const directory of [paths.pilotDeckDir, paths.researchDir, paths.experimentationDir, paths.runsDir]) {
      try {
        await mkdir(directory);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
      const stats = await lstat(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw repositoryError("path_violation", "Experiment storage directories must not be files or symbolic links.", {
          path: directory,
          operation: "ensure_directories",
        });
      }
    }
  } catch (error) {
    if (error instanceof ExperimentRepositoryError) throw error;
    throw asIoError(error, paths.experimentationDir, "ensure_directories");
  }
}

async function readBoundedJson(path: string, operation: string): Promise<unknown | undefined> {
  const stats = await lstatIfExists(path, operation);
  if (!stats) return undefined;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw repositoryError("path_violation", "Experiment manifest must be a regular project-local file.", { path, operation });
  }
  if (stats.size > MAX_EXPERIMENT_MANIFEST_FILE_BYTES) {
    throw repositoryError("file_too_large", "Experiment manifest exceeds its size limit.", { path, operation });
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw asIoError(error, path, operation);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw repositoryError("corrupt_json", "Experiment manifest is not valid JSON.", { path, operation });
  }
}

async function writeJsonAtomically(path: string, value: unknown, operation: string): Promise<void> {
  let serialized: Buffer;
  try {
    serialized = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch (error) {
    throw repositoryError("invalid_schema", `Experiment manifest cannot be serialized: ${messageOf(error)}.`, { path, operation });
  }
  if (serialized.byteLength > MAX_EXPERIMENT_MANIFEST_FILE_BYTES) {
    throw repositoryError("file_too_large", "Experiment manifest exceeds its size limit.", { path, operation });
  }
  const existing = await lstatIfExists(path, operation);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw repositoryError("path_violation", "Experiment manifest must be a regular project-local file.", { path, operation });
  }
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let committed = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    committed = true;
  } catch (error) {
    throw error instanceof ExperimentRepositoryError ? error : asIoError(error, path, operation);
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* preserve original failure */ }
    }
    if (!committed) {
      try { await unlink(temporaryPath); } catch { /* randomized temp path is safe to leave on cleanup failure */ }
    }
  }
}

function parseEnvelopeArray(value: unknown, label: string, expectedKind: string | undefined, path: string): ResearchArtifactEnvelope[] {
  if (!Array.isArray(value)) invalidSchema(path, `${label} must be an array.`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const itemPath = `${path}.${label}[${index}]`;
    const envelope = expectRecord(entry, label, itemPath) as unknown as ResearchArtifactEnvelope;
    if (envelope.schemaVersion !== 1 || typeof envelope.artifactId !== "string" || typeof envelope.revision !== "number"
      || typeof envelope.kind !== "string" || typeof envelope.contentHash !== "string" || typeof envelope.payload !== "object"
      || !Array.isArray(envelope.parents) || !Array.isArray(envelope.sources) || !envelope.producer) {
      invalidSchema(itemPath, "Artifact envelope is incomplete.");
    }
    if (expectedKind && envelope.kind !== expectedKind) invalidSchema(itemPath, `Expected ${expectedKind} envelope.`);
    validateEnvelopeIntegrity(envelope, itemPath);
    const key = `${envelope.artifactId}@${envelope.revision}`;
    if (seen.has(key)) invalidSchema(itemPath, `Duplicate artifact envelope ${key}.`);
    seen.add(key);
    return envelope;
  });
}

function validateEnvelopeIntegrity(envelope: ResearchArtifactEnvelope, path: string): void {
  if (!(RESEARCH_ARTIFACT_KINDS as readonly string[]).includes(envelope.kind)) {
    invalidSchema(path, `Artifact kind ${envelope.kind} is unsupported.`);
  }
  requireIdentifier(envelope.artifactId, "artifactId", path);
  requirePositiveInteger(envelope.revision, "revision", path);
  requireIsoDate(envelope.createdAt, "createdAt", path);
  requireIsoDate(envelope.updatedAt, "updatedAt", path);
  if (!/^sha256:[a-f0-9]{64}$/u.test(envelope.contentHash)) {
    invalidSchema(path, "Artifact contentHash is invalid.");
  }
  let rebuilt: ResearchArtifactEnvelope;
  try {
    rebuilt = createResearchArtifact({
      kind: envelope.kind as ResearchArtifactKind,
      artifactId: envelope.artifactId,
      revision: envelope.revision,
      status: envelope.status,
      producer: envelope.producer,
      parents: envelope.parents,
      sources: envelope.sources,
      payload: envelope.payload,
      now: new Date(envelope.createdAt),
    });
  } catch (error) {
    invalidSchema(path, `Artifact envelope is invalid: ${messageOf(error)}.`);
  }
  if (rebuilt.contentHash !== envelope.contentHash) {
    invalidSchema(path, `Artifact ${envelope.artifactId}@${envelope.revision} contentHash does not match its content.`);
  }
}

function parseArtifactRefs(value: unknown, path: string): ArtifactRef[] {
  if (!Array.isArray(value)) invalidSchema(path, "artifactRefs must be an array.");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const itemPath = `${path}.artifactRefs[${index}]`;
    const ref = expectRecord(entry, "artifact ref", itemPath) as unknown as ResearchArtifactRef;
    if (typeof ref.artifactId !== "string" || !Number.isSafeInteger(ref.revision) || ref.revision < 1
      || typeof ref.kind !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(ref.contentHash)) {
      invalidSchema(itemPath, "Artifact ref is invalid.");
    }
    const key = `${ref.artifactId}@${ref.revision}`;
    if (seen.has(key)) invalidSchema(itemPath, `Duplicate artifact ref ${key}.`);
    seen.add(key);
    return ref;
  });
}

function parseArtifactFiles(value: unknown, path: string): ExperimentArtifactFile[] {
  if (!Array.isArray(value)) invalidSchema(path, "artifactFiles must be an array.");
  return value.map((entry, index) => {
    const itemPath = `${path}.artifactFiles[${index}]`;
    const file = expectRecord(entry, "artifact file", itemPath);
    const ref = parseArtifactRefs([file.ref], itemPath)[0]!;
    const relativePath = requireRelativePath(file.relativePath, "relativePath", itemPath);
    if (typeof file.experimentId !== "string" || typeof file.runAttemptId !== "string" || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || typeof file.role !== "string" || !["output", "log", "checkpoint", "figure", "table"].includes(file.role)
      || typeof file.createdAt !== "string") {
      invalidSchema(itemPath, "Artifact file metadata is invalid.");
    }
    return {
      ref,
      experimentId: file.experimentId,
      runAttemptId: file.runAttemptId,
      relativePath,
      bytes: file.bytes,
      ...(file.mediaType === undefined ? {} : { mediaType: requireText(file.mediaType, "mediaType", itemPath) }),
      role: file.role as ExperimentArtifactFile["role"],
      createdAt: requireIsoDate(file.createdAt, "createdAt", itemPath),
    };
  });
}

async function lstatIfExists(path: string, operation: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw asIoError(error, path, operation);
  }
}

function assertWithinProject(projectRoot: string, candidate: string): void {
  const path = relative(projectRoot, candidate);
  if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) return;
  throw repositoryError("path_violation", "Experiment paths must stay inside the project root.", {
    path: candidate,
    operation: "resolve_paths",
  });
}

function requireIdentifier(value: unknown, label: string, path?: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256 || value.includes("\u0000")
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    invalidSchema(path ?? label, `${label} must be a safe identifier.`);
  }
  return value;
}

function requireRelativePath(value: unknown, label: string, path: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\u0000") || isAbsolute(value)) {
    invalidSchema(path, `${label} must be a relative path.`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized === "." || normalized.split("/").some((part) => part === ".." || part === "")) {
    invalidSchema(path, `${label} must not escape the run directory.`);
  }
  return value;
}

function requireText(value: unknown, label: string, path: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\u0000") || value.length > 16_000) {
    invalidSchema(path, `${label} must be non-empty text.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalidSchema(path, `${label} must be a positive integer.`);
  return value as number;
}

function requireIsoDate(value: unknown, label: string, path: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) invalidSchema(path, `${label} must be an ISO date.`);
  return value;
}

function expectRecord(value: unknown, label: string, path: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidSchema(path, `${label} must be an object.`);
  return value as Record<string, any>;
}

function invalidSchema(path: string, message: string): never {
  throw repositoryError("invalid_schema", message, { path, operation: "validate_manifest" });
}

function repositoryError(
  code: ExperimentRepositoryErrorCode,
  message: string,
  context: Omit<ExperimentRepositoryDiagnostic, "code" | "message"> = {},
): ExperimentRepositoryError {
  return new ExperimentRepositoryError(code, message, context);
}

function asIoError(error: unknown, path: string, operation: string): ExperimentRepositoryError {
  return repositoryError("io_error", `Experiment manifest storage failed: ${messageOf(error)}.`, { path, operation });
}

function nowIso(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw repositoryError("invalid_input", "now must be a valid Date.", { operation: "manifest_update" });
  }
  return value.toISOString();
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && (value as NodeJS.ErrnoException).code === code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
