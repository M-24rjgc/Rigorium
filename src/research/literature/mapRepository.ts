import { randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createLiveLiteratureMap,
  freezeLiteratureMap,
  setLiteratureMapNodeState,
  updateLiveLiteratureMap,
} from "./mapMaintenance.js";
import type {
  FrozenLiteratureMapSnapshot,
  LiteratureMapDiff,
  LiteratureMapEdge,
  LiteratureMapNode,
  LiteratureMapNodeStatus,
  LiteratureMapPosition,
  LiteratureMapUpdate,
  LiteratureMapUpdateResult,
  LiveLiteratureMap,
} from "./mapMaintenance.js";

/** The on-disk envelope version. It is separate from the map-maintenance schema. */
export const LITERATURE_MAP_REPOSITORY_SCHEMA_VERSION = 1 as const;
export const MAX_LITERATURE_MAP_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_LITERATURE_MAP_NODES = 2_000;
export const MAX_LITERATURE_MAP_EDGES = 10_000;

const MAX_IDENTIFIER_LENGTH = 4_096;
const MAX_STRING_LENGTH = 256 * 1024;
const MAX_METADATA_ITEMS = 10_000;

export type LiteratureMapRepositoryErrorCode =
  | "invalid_input"
  | "invalid_project_root"
  | "path_violation"
  | "io_error"
  | "file_too_large"
  | "corrupt_json"
  | "invalid_schema"
  | "node_limit_exceeded"
  | "edge_limit_exceeded"
  | "live_map_exists"
  | "map_id_mismatch"
  | "revision_conflict"
  | "live_map_not_found"
  | "node_not_found"
  | "snapshot_confirmation_required"
  | "snapshot_exists";

export type LiteratureMapRepositoryDiagnostic = Readonly<{
  code: LiteratureMapRepositoryErrorCode;
  message: string;
  path?: string;
  operation?: string;
}>;

/**
 * All persisted-map failures retain a stable code and a machine-readable
 * diagnostic. Callers must surface or handle these failures; invalid files are
 * never treated as an empty map.
 */
export class LiteratureMapRepositoryError extends Error {
  readonly code: LiteratureMapRepositoryErrorCode;
  readonly diagnostic: LiteratureMapRepositoryDiagnostic;

  constructor(
    code: LiteratureMapRepositoryErrorCode,
    message: string,
    context: Omit<LiteratureMapRepositoryDiagnostic, "code" | "message"> = {},
  ) {
    super(message);
    this.name = "LiteratureMapRepositoryError";
    this.code = code;
    this.diagnostic = Object.freeze({ code, message, ...context });
  }
}

export type ProjectLiteratureMapPaths = Readonly<{
  projectRoot: string;
  pilotDeckDir: string;
  researchDir: string;
  snapshotsDir: string;
  liveMapPath: string;
}>;

export type PersistedLiveLiteratureMap = Readonly<{
  schemaVersion: 1;
  kind: "live_literature_map";
  map: LiveLiteratureMap;
  lastDiff: LiteratureMapDiff;
}>;

export type PersistedFrozenLiteratureMapSnapshot = Readonly<{
  schemaVersion: 1;
  kind: "frozen_literature_map_snapshot";
  confirmed: true;
  snapshot: FrozenLiteratureMapSnapshot;
}>;

export type ProjectLiveLiteratureMapResult = LiteratureMapUpdateResult & Readonly<{
  path: string;
  created: boolean;
  /** False when an idempotent update required no write. */
  persisted: boolean;
}>;

export type ProjectFrozenLiteratureMapSnapshotResult = Readonly<{
  path: string;
  snapshot: FrozenLiteratureMapSnapshot;
}>;

export type ProjectLiteratureMapNodeStateInput = Readonly<{
  status?: LiteratureMapNodeStatus;
  position?: Omit<LiteratureMapPosition, "pinned"> & { pinned?: boolean };
}>;

export function getProjectLiteratureMapPaths(input: { projectRoot: string }): ProjectLiteratureMapPaths {
  const projectRoot = resolveProjectRoot(input.projectRoot);
  const pilotDeckDir = join(projectRoot, ".pilotdeck");
  const researchDir = join(pilotDeckDir, "research");
  const snapshotsDir = join(researchDir, "snapshots");
  const liveMapPath = join(researchDir, "live-map.json");

  for (const candidate of [pilotDeckDir, researchDir, snapshotsDir, liveMapPath]) {
    assertWithinProject(projectRoot, candidate);
  }

  return Object.freeze({ projectRoot, pilotDeckDir, researchDir, snapshotsDir, liveMapPath });
}

export function getProjectLiteratureMapSnapshotPath(input: {
  projectRoot: string;
  snapshotId: string;
}): string {
  const paths = getProjectLiteratureMapPaths({ projectRoot: input.projectRoot });
  const snapshotId = requireSnapshotId(input.snapshotId);
  const snapshotPath = join(paths.snapshotsDir, `${snapshotId}.json`);
  assertWithinProject(paths.projectRoot, snapshotPath);
  return snapshotPath;
}

/** Loads the one live map owned by a project. A missing file is the only empty result. */
export async function loadProjectLiveLiteratureMap(input: {
  projectRoot: string;
}): Promise<PersistedLiveLiteratureMap | undefined> {
  const paths = getProjectLiteratureMapPaths(input);
  const repositoryExists = await assertReadableRepository(paths, false);
  if (!repositoryExists) return undefined;

  const raw = await readBoundedJson(paths.liveMapPath, "load_live_map");
  return raw === undefined ? undefined : validatePersistedLiveLiteratureMap(raw, paths.liveMapPath);
}

/** Loads a named immutable snapshot without manufacturing any missing state. */
export async function loadProjectLiteratureMapSnapshot(input: {
  projectRoot: string;
  snapshotId: string;
}): Promise<PersistedFrozenLiteratureMapSnapshot | undefined> {
  const paths = getProjectLiteratureMapPaths({ projectRoot: input.projectRoot });
  const snapshotPath = getProjectLiteratureMapSnapshotPath(input);
  const repositoryExists = await assertReadableRepository(paths, true);
  if (!repositoryExists) return undefined;

  const raw = await readBoundedJson(snapshotPath, "load_snapshot");
  if (raw === undefined) return undefined;
  const document = validatePersistedFrozenLiteratureMapSnapshot(raw, snapshotPath);
  if (document.snapshot.snapshotId !== input.snapshotId) {
    throw repositoryError(
      "invalid_schema",
      "Snapshot file identity does not match its requested snapshot ID.",
      { path: snapshotPath, operation: "load_snapshot" },
    );
  }
  return document;
}

/** Creates a live map only when the project does not already own one. */
export async function createProjectLiveLiteratureMap(input: {
  projectRoot: string;
  mapId: string;
  update?: LiteratureMapUpdate;
  now?: Date;
}): Promise<ProjectLiveLiteratureMapResult> {
  const paths = getProjectLiteratureMapPaths({ projectRoot: input.projectRoot });
  const mapId = requireMapId(input.mapId);
  const existing = await loadProjectLiveLiteratureMap({ projectRoot: paths.projectRoot });
  if (existing) {
    throw repositoryError("live_map_exists", "This project already has a live literature map.", {
      path: paths.liveMapPath,
      operation: "create_live_map",
    });
  }

  const empty = createLiveLiteratureMap({ mapId, now: input.now });
  const result = input.update
    ? updateLiveLiteratureMap(empty.map, input.update, { now: input.now })
    : empty;
  const document: PersistedLiveLiteratureMap = {
    schemaVersion: LITERATURE_MAP_REPOSITORY_SCHEMA_VERSION,
    kind: "live_literature_map",
    map: result.map,
    lastDiff: result.diff,
  };
  validatePersistedLiveLiteratureMap(document, paths.liveMapPath);
  await persistLiveMap(paths, document, false);

  return { ...result, path: paths.liveMapPath, created: true, persisted: true };
}

/** Returns the existing map or creates an empty one. It does not apply an update. */
export async function loadOrCreateProjectLiveLiteratureMap(input: {
  projectRoot: string;
  mapId: string;
  now?: Date;
}): Promise<ProjectLiveLiteratureMapResult> {
  const paths = getProjectLiteratureMapPaths({ projectRoot: input.projectRoot });
  const mapId = requireMapId(input.mapId);
  const existing = await loadProjectLiveLiteratureMap({ projectRoot: paths.projectRoot });
  if (!existing) {
    return createProjectLiveLiteratureMap({ projectRoot: paths.projectRoot, mapId, now: input.now });
  }
  assertMapId(existing.map, mapId, paths.liveMapPath, "load_or_create_live_map");
  return {
    map: existing.map,
    diff: existing.lastDiff,
    path: paths.liveMapPath,
    created: false,
    persisted: false,
  };
}

/**
 * Merges a provider result into a project's map. The first update creates the
 * map; replaying an identical update preserves its revision and does not write.
 */
export async function updateProjectLiveLiteratureMap(input: {
  projectRoot: string;
  mapId: string;
  update: LiteratureMapUpdate;
  expectedRevision?: number;
  now?: Date;
}): Promise<ProjectLiveLiteratureMapResult> {
  const paths = getProjectLiteratureMapPaths({ projectRoot: input.projectRoot });
  const mapId = requireMapId(input.mapId);
  const existing = await loadProjectLiveLiteratureMap({ projectRoot: paths.projectRoot });
  if (!existing) {
    return createProjectLiveLiteratureMap({
      projectRoot: paths.projectRoot,
      mapId,
      update: input.update,
      now: input.now,
    });
  }

  assertMapId(existing.map, mapId, paths.liveMapPath, "update_live_map");
  assertExpectedRevision(existing.map.revision, input.expectedRevision, paths.liveMapPath);
  const result = updateLiveLiteratureMap(existing.map, input.update, { now: input.now });
  if (result.map === existing.map) {
    return { ...result, path: paths.liveMapPath, created: false, persisted: false };
  }

  const document: PersistedLiveLiteratureMap = {
    schemaVersion: LITERATURE_MAP_REPOSITORY_SCHEMA_VERSION,
    kind: "live_literature_map",
    map: result.map,
    lastDiff: result.diff,
  };
  validatePersistedLiveLiteratureMap(document, paths.liveMapPath);
  await persistLiveMap(paths, document, true);
  return { ...result, path: paths.liveMapPath, created: false, persisted: true };
}

/**
 * Persists a user-controlled node classification or position through the same
 * project boundary checks and atomic write path as provider updates.
 */
export async function setProjectLiveLiteratureMapNodeState(input: {
  projectRoot: string;
  mapId: string;
  paperId: string;
  state: ProjectLiteratureMapNodeStateInput;
  expectedRevision?: number;
  now?: Date;
}): Promise<ProjectLiveLiteratureMapResult> {
  const paths = getProjectLiteratureMapPaths({ projectRoot: input.projectRoot });
  const mapId = requireMapId(input.mapId);
  const paperId = requirePaperId(input.paperId);
  const state = requireNodeStateInput(input.state);
  const existing = await loadProjectLiveLiteratureMap({ projectRoot: paths.projectRoot });
  if (!existing) {
    throw repositoryError("live_map_not_found", "Cannot update a literature map that has not been created.", {
      path: paths.liveMapPath,
      operation: "set_node_state",
    });
  }

  assertMapId(existing.map, mapId, paths.liveMapPath, "set_node_state");
  assertExpectedRevision(existing.map.revision, input.expectedRevision, paths.liveMapPath);
  let map: LiveLiteratureMap;
  try {
    map = setLiteratureMapNodeState(existing.map, paperId, state, { now: input.now });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown literature map paper:")) {
      throw repositoryError("node_not_found", "The requested literature-map node does not exist.", {
        path: paths.liveMapPath,
        operation: "set_node_state",
      });
    }
    throw error;
  }

  const diff = nodeStateDiff(existing.map, map);
  if (map === existing.map) {
    return { map, diff, path: paths.liveMapPath, created: false, persisted: false };
  }

  const document: PersistedLiveLiteratureMap = {
    schemaVersion: LITERATURE_MAP_REPOSITORY_SCHEMA_VERSION,
    kind: "live_literature_map",
    map,
    lastDiff: diff,
  };
  validatePersistedLiveLiteratureMap(document, paths.liveMapPath);
  await persistLiveMap(paths, document, true);
  return { map, diff, path: paths.liveMapPath, created: false, persisted: true };
}

/**
 * Freezes the current map only after the caller supplies an explicit true
 * confirmation. Snapshots are atomically created and are never replaced.
 */
export async function freezeProjectLiveLiteratureMap(input: {
  projectRoot: string;
  snapshotId: string;
  confirmed: boolean;
  now?: Date;
}): Promise<ProjectFrozenLiteratureMapSnapshotResult> {
  if (input.confirmed !== true) {
    throw repositoryError(
      "snapshot_confirmation_required",
      "A frozen literature-map snapshot requires confirmed: true.",
      { operation: "freeze_snapshot" },
    );
  }

  const paths = getProjectLiteratureMapPaths({ projectRoot: input.projectRoot });
  const snapshotId = requireSnapshotId(input.snapshotId);
  const mapDocument = await loadProjectLiveLiteratureMap({ projectRoot: paths.projectRoot });
  if (!mapDocument) {
    throw repositoryError("live_map_not_found", "Cannot freeze a literature map that has not been created.", {
      path: paths.liveMapPath,
      operation: "freeze_snapshot",
    });
  }

  const snapshot = freezeLiteratureMap(mapDocument.map, { snapshotId, now: input.now });
  const document: PersistedFrozenLiteratureMapSnapshot = {
    schemaVersion: LITERATURE_MAP_REPOSITORY_SCHEMA_VERSION,
    kind: "frozen_literature_map_snapshot",
    confirmed: true,
    snapshot,
  };
  const snapshotPath = getProjectLiteratureMapSnapshotPath({ projectRoot: paths.projectRoot, snapshotId });
  validatePersistedFrozenLiteratureMapSnapshot(document, snapshotPath);
  await persistSnapshot(paths, snapshotPath, document);
  return { path: snapshotPath, snapshot };
}

async function persistLiveMap(
  paths: ProjectLiteratureMapPaths,
  document: PersistedLiveLiteratureMap,
  overwrite: boolean,
): Promise<void> {
  await ensureRepositoryDirectories(paths, false);
  await writeJsonAtomically(paths.liveMapPath, document, {
    overwrite,
    existsCode: "live_map_exists",
    operation: overwrite ? "update_live_map" : "create_live_map",
  });
}

async function persistSnapshot(
  paths: ProjectLiteratureMapPaths,
  snapshotPath: string,
  document: PersistedFrozenLiteratureMapSnapshot,
): Promise<void> {
  await ensureRepositoryDirectories(paths, true);
  await writeJsonAtomically(snapshotPath, document, {
    overwrite: false,
    existsCode: "snapshot_exists",
    operation: "freeze_snapshot",
  });
}

function resolveProjectRoot(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw repositoryError("invalid_project_root", "A non-empty project root is required.", {
      operation: "resolve_paths",
    });
  }
  return resolve(value.trim());
}

function requireMapId(value: unknown): string {
  if (typeof value !== "string") {
    throw repositoryError("invalid_input", "A valid literature map ID is required.", { operation: "validate_input" });
  }
  const mapId = value.trim();
  if (!mapId || mapId.length > MAX_IDENTIFIER_LENGTH || mapId.includes("\u0000")) {
    throw repositoryError("invalid_input", "A valid literature map ID is required.", { operation: "validate_input" });
  }
  return mapId;
}

function requirePaperId(value: unknown): string {
  if (typeof value !== "string") {
    throw repositoryError("invalid_input", "A valid literature-map paper ID is required.", { operation: "validate_input" });
  }
  const paperId = value.trim();
  if (!paperId || paperId.length > MAX_IDENTIFIER_LENGTH || paperId.includes("\u0000")) {
    throw repositoryError("invalid_input", "A valid literature-map paper ID is required.", { operation: "validate_input" });
  }
  return paperId;
}

function requireNodeStateInput(value: unknown): ProjectLiteratureMapNodeStateInput {
  if (!isRecord(value)) {
    throw repositoryError("invalid_input", "A literature-map node state update is required.", { operation: "validate_input" });
  }
  const status = value.status;
  if (status !== undefined && !isOneOf(status, ["candidate", "relevant", "core", "excluded"] as const)) {
    throw repositoryError("invalid_input", "The requested literature-map node status is invalid.", { operation: "validate_input" });
  }
  let position: ProjectLiteratureMapNodeStateInput["position"];
  if (value.position !== undefined) {
    if (!isRecord(value.position)
      || typeof value.position.x !== "number"
      || !Number.isFinite(value.position.x)
      || typeof value.position.y !== "number"
      || !Number.isFinite(value.position.y)
      || (value.position.pinned !== undefined && typeof value.position.pinned !== "boolean")) {
      throw repositoryError("invalid_input", "The requested literature-map node position is invalid.", { operation: "validate_input" });
    }
    position = {
      x: value.position.x,
      y: value.position.y,
      ...(value.position.pinned !== undefined ? { pinned: value.position.pinned } : {}),
    };
  }
  if (status === undefined && position === undefined) {
    throw repositoryError("invalid_input", "A node status or position update is required.", { operation: "validate_input" });
  }
  return {
    ...(status !== undefined ? { status } : {}),
    ...(position ? { position } : {}),
  };
}

function nodeStateDiff(previous: LiveLiteratureMap, next: LiveLiteratureMap): LiteratureMapDiff {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  const updated = next.nodes
    .filter((node) => {
      const before = previousById.get(node.id);
      return Boolean(before && (before.status !== node.status
        || before.position.x !== node.position.x
        || before.position.y !== node.position.y
        || before.position.pinned !== node.position.pinned));
    })
    .map((node) => node.id)
    .sort();
  return {
    fromRevision: previous.revision,
    toRevision: next.revision,
    nodes: { added: [], updated, tombstoned: [], restored: [] },
    edges: { added: [], updated: [], tombstoned: [], restored: [] },
    aliasesAdded: [],
    warnings: [],
  };
}

function requireSnapshotId(value: unknown): string {
  if (typeof value !== "string") {
    throw repositoryError("path_violation", "A safe snapshot ID is required.", { operation: "validate_snapshot_id" });
  }
  const snapshotId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(snapshotId)
    || snapshotId === "."
    || snapshotId === "..") {
    throw repositoryError("path_violation", "Snapshot IDs cannot contain path traversal or separators.", {
      operation: "validate_snapshot_id",
    });
  }
  return snapshotId;
}

function assertWithinProject(projectRoot: string, candidate: string): void {
  const rel = relative(projectRoot, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw repositoryError("path_violation", "Literature-map storage must remain inside the project root.", {
      path: candidate,
      operation: "validate_paths",
    });
  }
}

function assertMapId(map: LiveLiteratureMap, expectedMapId: string, path: string, operation: string): void {
  if (map.mapId !== expectedMapId) {
    throw repositoryError("map_id_mismatch", "The requested map ID does not match the project live map.", {
      path,
      operation,
    });
  }
}

function assertExpectedRevision(actualRevision: number, expectedRevision: number | undefined, path: string): void {
  if (expectedRevision === undefined) return;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw repositoryError("invalid_input", "expectedRevision must be a non-negative integer.", {
      path,
      operation: "update_live_map",
    });
  }
  if (expectedRevision !== actualRevision) {
    throw repositoryError("revision_conflict", "The live literature map has changed since the requested revision.", {
      path,
      operation: "update_live_map",
    });
  }
}

async function assertReadableRepository(paths: ProjectLiteratureMapPaths, needSnapshotsDirectory: boolean): Promise<boolean> {
  await assertProjectRootDirectory(paths.projectRoot);
  if (!await assertExistingSafeDirectory(paths.projectRoot, paths.pilotDeckDir)) return false;
  if (!await assertExistingSafeDirectory(paths.projectRoot, paths.researchDir)) return false;
  if (needSnapshotsDirectory && !await assertExistingSafeDirectory(paths.projectRoot, paths.snapshotsDir)) return false;
  return true;
}

async function ensureRepositoryDirectories(paths: ProjectLiteratureMapPaths, needSnapshotsDirectory: boolean): Promise<void> {
  await assertProjectRootDirectory(paths.projectRoot);
  await ensureSafeDirectory(paths.projectRoot, paths.pilotDeckDir);
  await ensureSafeDirectory(paths.projectRoot, paths.researchDir);
  if (needSnapshotsDirectory) await ensureSafeDirectory(paths.projectRoot, paths.snapshotsDir);
}

async function assertProjectRootDirectory(projectRoot: string): Promise<void> {
  const stats = await lstatIfExists(projectRoot, "validate_project_root");
  if (!stats) {
    throw repositoryError("invalid_project_root", "The project root does not exist.", {
      path: projectRoot,
      operation: "validate_project_root",
    });
  }
  assertSafeDirectory(stats, projectRoot, "validate_project_root");
}

async function assertExistingSafeDirectory(projectRoot: string, directory: string): Promise<boolean> {
  assertWithinProject(projectRoot, directory);
  const stats = await lstatIfExists(directory, "inspect_repository");
  if (!stats) return false;
  assertSafeDirectory(stats, directory, "inspect_repository");
  return true;
}

async function ensureSafeDirectory(projectRoot: string, directory: string): Promise<void> {
  assertWithinProject(projectRoot, directory);
  const segments = relative(projectRoot, directory).split(sep).filter(Boolean);
  let current = projectRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const existing = await lstatIfExists(current, "ensure_repository");
    if (!existing) {
      try {
        await mkdir(current);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw asIoError(error, current, "ensure_repository");
      }
    }
    const verified = await lstatIfExists(current, "ensure_repository");
    if (!verified) {
      throw repositoryError("io_error", "Repository directory creation did not produce the expected directory.", {
        path: current,
        operation: "ensure_repository",
      });
    }
    assertSafeDirectory(verified, current, "ensure_repository");
  }
}

function assertSafeDirectory(stats: Stats, path: string, operation: string): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw repositoryError("path_violation", "Literature-map storage paths must be real directories inside the project.", {
      path,
      operation,
    });
  }
}

async function readBoundedJson(path: string, operation: string): Promise<unknown | undefined> {
  const stats = await lstatIfExists(path, operation);
  if (!stats) return undefined;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw repositoryError("path_violation", "Literature-map data must be stored in a regular project-local file.", {
      path,
      operation,
    });
  }
  if (stats.size > MAX_LITERATURE_MAP_FILE_BYTES) {
    throw repositoryError("file_too_large", "Literature-map data exceeds the configured file-size limit.", {
      path,
      operation,
    });
  }

  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    throw asIoError(error, path, operation);
  }
  if (raw.byteLength > MAX_LITERATURE_MAP_FILE_BYTES) {
    throw repositoryError("file_too_large", "Literature-map data exceeds the configured file-size limit.", {
      path,
      operation,
    });
  }
  try {
    return JSON.parse(raw.toString("utf8").replace(/^\uFEFF/u, "")) as unknown;
  } catch (error) {
    throw repositoryError("corrupt_json", "Literature-map data is not valid JSON.", {
      path,
      operation,
    });
  }
}

async function writeJsonAtomically(
  targetPath: string,
  value: unknown,
  options: { overwrite: boolean; existsCode: "live_map_exists" | "snapshot_exists"; operation: string },
): Promise<void> {
  const serialized = serializeJson(value, targetPath, options.operation);
  const existing = await lstatIfExists(targetPath, options.operation);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw repositoryError("path_violation", "Literature-map data must be stored in a regular project-local file.", {
        path: targetPath,
        operation: options.operation,
      });
    }
    if (!options.overwrite) {
      throw repositoryError(options.existsCode, "A literature-map file already exists at the requested immutable path.", {
        path: targetPath,
        operation: options.operation,
      });
    }
  }

  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let committed = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (options.overwrite) {
      await rename(temporaryPath, targetPath);
      committed = true;
      return;
    }

    // Hard-link creation fails with EEXIST and never replaces a pre-existing
    // snapshot. It also keeps creation atomic on the same filesystem.
    try {
      await link(temporaryPath, targetPath);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw repositoryError(options.existsCode, "A literature-map file already exists at the requested immutable path.", {
          path: targetPath,
          operation: options.operation,
        });
      }
      throw error;
    }
    committed = true;
    await removeTemporaryFile(temporaryPath);
  } catch (error) {
    if (error instanceof LiteratureMapRepositoryError) throw error;
    throw asIoError(error, targetPath, options.operation);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The original write error is more useful than a best-effort close error.
      }
    }
    if (!committed) await removeTemporaryFile(temporaryPath);
  }
}

function serializeJson(value: unknown, path: string, operation: string): Buffer {
  let text: string;
  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    throw repositoryError("invalid_schema", "Literature-map data cannot be serialized as JSON.", {
      path,
      operation,
    });
  }
  const serialized = Buffer.from(text, "utf8");
  if (serialized.byteLength > MAX_LITERATURE_MAP_FILE_BYTES) {
    throw repositoryError("file_too_large", "Literature-map data exceeds the configured file-size limit.", {
      path,
      operation,
    });
  }
  return serialized;
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      // The target has already been atomically committed in the only path where
      // cleanup failures are ignored. A leftover randomized temp file cannot
      // replace user data and is safer than deleting any non-temp path.
    }
  }
}

function validatePersistedLiveLiteratureMap(value: unknown, path: string): PersistedLiveLiteratureMap {
  const document = expectRecord(value, "live-map document", path);
  if (document.schemaVersion !== LITERATURE_MAP_REPOSITORY_SCHEMA_VERSION
    || document.kind !== "live_literature_map") {
    invalidSchema(path, "Unsupported live literature-map document schema.");
  }
  const map = validateLiveMap(document.map, path);
  validateDiff(document.lastDiff, map.revision, path);
  return document as unknown as PersistedLiveLiteratureMap;
}

function validatePersistedFrozenLiteratureMapSnapshot(
  value: unknown,
  path: string,
): PersistedFrozenLiteratureMapSnapshot {
  const document = expectRecord(value, "frozen-snapshot document", path);
  if (document.schemaVersion !== LITERATURE_MAP_REPOSITORY_SCHEMA_VERSION
    || document.kind !== "frozen_literature_map_snapshot"
    || document.confirmed !== true) {
    invalidSchema(path, "Unsupported frozen literature-map snapshot schema.");
  }
  validateFrozenSnapshot(document.snapshot, path);
  return document as unknown as PersistedFrozenLiteratureMapSnapshot;
}

function validateLiveMap(value: unknown, path: string): LiveLiteratureMap {
  const map = expectRecord(value, "live map", path);
  if (map.schemaVersion !== 1 || map.kind !== "live") {
    invalidSchema(path, "Unsupported live literature-map state schema.");
  }
  expectIdentifier(map.mapId, "map.mapId", path);
  expectNonNegativeInteger(map.revision, "map.revision", path);
  expectTimestamp(map.createdAt, "map.createdAt", path);
  expectTimestamp(map.updatedAt, "map.updatedAt", path);
  validateGraph(map.nodes, map.edges, path);
  return map as unknown as LiveLiteratureMap;
}

function validateFrozenSnapshot(value: unknown, path: string): FrozenLiteratureMapSnapshot {
  const snapshot = expectRecord(value, "frozen snapshot", path);
  if (snapshot.schemaVersion !== 1 || snapshot.kind !== "snapshot") {
    invalidSchema(path, "Unsupported frozen literature-map state schema.");
  }
  expectIdentifier(snapshot.snapshotId, "snapshot.snapshotId", path);
  expectIdentifier(snapshot.sourceMapId, "snapshot.sourceMapId", path);
  expectNonNegativeInteger(snapshot.sourceRevision, "snapshot.sourceRevision", path);
  expectTimestamp(snapshot.frozenAt, "snapshot.frozenAt", path);
  validateGraph(snapshot.nodes, snapshot.edges, path);
  return snapshot as unknown as FrozenLiteratureMapSnapshot;
}

function validateGraph(nodesValue: unknown, edgesValue: unknown, path: string): void {
  if (!Array.isArray(nodesValue)) invalidSchema(path, "map.nodes must be an array.");
  if (nodesValue.length > MAX_LITERATURE_MAP_NODES) {
    throw repositoryError("node_limit_exceeded", "Literature-map node count exceeds the configured limit.", { path, operation: "validate" });
  }
  const nodeById = new Map<string, LiteratureMapNode>();
  for (const [index, node] of nodesValue.entries()) {
    const checked = validateNode(node, `nodes[${index}]`, path);
    if (nodeById.has(checked.id)) invalidSchema(path, `Duplicate node ID: ${checked.id}.`);
    nodeById.set(checked.id, checked);
  }

  if (!Array.isArray(edgesValue)) invalidSchema(path, "map.edges must be an array.");
  if (edgesValue.length > MAX_LITERATURE_MAP_EDGES) {
    throw repositoryError("edge_limit_exceeded", "Literature-map edge count exceeds the configured limit.", { path, operation: "validate" });
  }
  const edgeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  for (const [index, edge] of edgesValue.entries()) {
    const checked = validateEdge(edge, `edges[${index}]`, path);
    if (edgeIds.has(checked.id)) invalidSchema(path, `Duplicate edge ID: ${checked.id}.`);
    const source = nodeById.get(checked.source);
    const target = nodeById.get(checked.target);
    if (!source || !target) invalidSchema(path, `Edge ${checked.id} references a missing node.`);
    if (checked.tombstone !== Boolean(source.tombstone || target.tombstone)) {
      invalidSchema(path, `Edge ${checked.id} tombstone state does not match its endpoint state.`);
    }
    const edgeKey = `${checked.type}\u0000${checked.source}\u0000${checked.target}`;
    if (edgeKeys.has(edgeKey)) invalidSchema(path, `Duplicate logical edge: ${checked.id}.`);
    edgeIds.add(checked.id);
    edgeKeys.add(edgeKey);
  }
}

function validateNode(value: unknown, location: string, path: string): LiteratureMapNode {
  const node = expectRecord(value, location, path);
  const id = expectIdentifier(node.id, `${location}.id`, path);
  const paper = validatePaper(node.paper, `${location}.paper`, path);
  if (paper.id !== id) invalidSchema(path, `${location}.paper.id must equal ${location}.id.`);
  expectStringArray(node.aliases, `${location}.aliases`, path, MAX_METADATA_ITEMS);
  if (!isOneOf(node.status, ["candidate", "relevant", "core", "excluded"] as const)) {
    invalidSchema(path, `${location}.status is invalid.`);
  }
  expectBoolean(node.tombstone, `${location}.tombstone`, path);
  const position = expectRecord(node.position, `${location}.position`, path);
  expectFiniteNumber(position.x, `${location}.position.x`, path);
  expectFiniteNumber(position.y, `${location}.position.y`, path);
  expectBoolean(position.pinned, `${location}.position.pinned`, path);
  const origins = expectStringArray(node.origins, `${location}.origins`, path, 3);
  if (origins.some((origin) => !isOneOf(origin, ["search", "zotero", "monitor"] as const))) {
    invalidSchema(path, `${location}.origins contains an unsupported origin.`);
  }
  expectTimestamp(node.firstSeenAt, `${location}.firstSeenAt`, path);
  expectTimestamp(node.updatedAt, `${location}.updatedAt`, path);
  return node as unknown as LiteratureMapNode;
}

function validateEdge(value: unknown, location: string, path: string): LiteratureMapEdge {
  const edge = expectRecord(value, location, path);
  expectIdentifier(edge.id, `${location}.id`, path);
  expectIdentifier(edge.source, `${location}.source`, path);
  expectIdentifier(edge.target, `${location}.target`, path);
  if (!isOneOf(edge.type, ["citation", "shared_topic"] as const)) {
    invalidSchema(path, `${location}.type is invalid.`);
  }
  const weight = expectFiniteNumber(edge.weight, `${location}.weight`, path);
  if (weight < 0) invalidSchema(path, `${location}.weight must not be negative.`);
  expectBoolean(edge.inferred, `${location}.inferred`, path);
  if (edge.evidence !== undefined) expectStringArray(edge.evidence, `${location}.evidence`, path, MAX_METADATA_ITEMS);
  expectBoolean(edge.tombstone, `${location}.tombstone`, path);
  expectTimestamp(edge.firstSeenAt, `${location}.firstSeenAt`, path);
  expectTimestamp(edge.updatedAt, `${location}.updatedAt`, path);
  return edge as unknown as LiteratureMapEdge;
}

function validatePaper(value: unknown, location: string, path: string): { id: string } {
  const paper = expectRecord(value, location, path);
  const id = expectIdentifier(paper.id, `${location}.id`, path);
  const identity = expectRecord(paper.identity, `${location}.identity`, path);
  for (const key of ["openAlexId", "doi", "arxiv", "openReview", "pmid", "pmcid", "zoteroKey"] as const) {
    expectOptionalString(identity[key], `${location}.identity.${key}`, path);
  }
  if (identity.arxivVersion !== undefined) expectNonNegativeInteger(identity.arxivVersion, `${location}.identity.arxivVersion`, path);
  if (identity.other !== undefined) {
    const other = expectRecord(identity.other, `${location}.identity.other`, path);
    for (const [key, entry] of Object.entries(other)) {
      expectString(key, `${location}.identity.other key`, path, MAX_IDENTIFIER_LENGTH);
      expectString(entry, `${location}.identity.other.${key}`, path);
    }
  }
  expectString(paper.title, `${location}.title`, path);
  expectStringArray(paper.authors, `${location}.authors`, path, MAX_METADATA_ITEMS);
  if (paper.year !== undefined) expectFiniteInteger(paper.year, `${location}.year`, path);
  for (const key of ["publicationDate", "updatedAt", "type", "venue", "doi", "url", "abstract"] as const) {
    expectOptionalString(paper[key], `${location}.${key}`, path);
  }
  const citedByCount = expectFiniteNumber(paper.citedByCount, `${location}.citedByCount`, path);
  if (citedByCount < 0) invalidSchema(path, `${location}.citedByCount must not be negative.`);
  if (paper.isOpenAccess !== undefined) expectBoolean(paper.isOpenAccess, `${location}.isOpenAccess`, path);
  if (!Array.isArray(paper.topics)) invalidSchema(path, `${location}.topics must be an array.`);
  if (paper.topics.length > MAX_METADATA_ITEMS) invalidSchema(path, `${location}.topics exceeds its item limit.`);
  for (const [index, topic] of paper.topics.entries()) {
    const entry = expectRecord(topic, `${location}.topics[${index}]`, path);
    expectIdentifier(entry.id, `${location}.topics[${index}].id`, path);
    expectString(entry.name, `${location}.topics[${index}].name`, path);
    if (entry.score !== undefined) expectFiniteNumber(entry.score, `${location}.topics[${index}].score`, path);
  }
  expectStringArray(paper.referencedWorkIds, `${location}.referencedWorkIds`, path, MAX_METADATA_ITEMS);
  expectIdentifier(paper.sourceId, `${location}.sourceId`, path);
  expectStringArray(paper.sourceIds, `${location}.sourceIds`, path, MAX_METADATA_ITEMS);
  validateProvenance(paper.provenance, `${location}.provenance`, path);
  if (paper.venueEvidence !== undefined) validateVenueEvidence(paper.venueEvidence, `${location}.venueEvidence`, path);
  return { id };
}

function validateProvenance(value: unknown, location: string, path: string): void {
  if (!Array.isArray(value)) invalidSchema(path, `${location} must be an array.`);
  if (value.length > MAX_METADATA_ITEMS) invalidSchema(path, `${location} exceeds its item limit.`);
  for (const [index, provenance] of value.entries()) {
    const entry = expectRecord(provenance, `${location}[${index}]`, path);
    expectIdentifier(entry.sourceId, `${location}[${index}].sourceId`, path);
    expectOptionalString(entry.sourceRecordId, `${location}[${index}].sourceRecordId`, path);
    expectOptionalString(entry.queryVariantId, `${location}[${index}].queryVariantId`, path);
    const rank = expectNonNegativeInteger(entry.rank, `${location}[${index}].rank`, path);
    if (rank < 1) invalidSchema(path, `${location}[${index}].rank must be positive.`);
    expectTimestamp(entry.retrievedAt, `${location}[${index}].retrievedAt`, path);
    expectOptionalString(entry.queryUrl, `${location}[${index}].queryUrl`, path);
  }
}

function validateVenueEvidence(value: unknown, location: string, path: string): void {
  if (!Array.isArray(value)) invalidSchema(path, `${location} must be an array.`);
  if (value.length > MAX_METADATA_ITEMS) invalidSchema(path, `${location} exceeds its item limit.`);
  for (const [index, evidence] of value.entries()) {
    const entry = expectRecord(evidence, `${location}[${index}]`, path);
    expectIdentifier(entry.sourceId, `${location}[${index}].sourceId`, path);
    if (!isOneOf(entry.evidence, ["official", "metadata"] as const)) {
      invalidSchema(path, `${location}[${index}].evidence is invalid.`);
    }
    expectString(entry.venue, `${location}[${index}].venue`, path);
    if (entry.year !== undefined) expectFiniteInteger(entry.year, `${location}[${index}].year`, path);
    expectOptionalString(entry.track, `${location}[${index}].track`, path);
    if (!isOneOf(entry.status, ["accepted", "submission", "unknown"] as const)) {
      invalidSchema(path, `${location}[${index}].status is invalid.`);
    }
    expectOptionalString(entry.officialVenueId, `${location}[${index}].officialVenueId`, path);
  }
}

function validateDiff(value: unknown, revision: number, path: string): void {
  const diff = expectRecord(value, "lastDiff", path);
  const fromRevision = expectNonNegativeInteger(diff.fromRevision, "lastDiff.fromRevision", path);
  const toRevision = expectNonNegativeInteger(diff.toRevision, "lastDiff.toRevision", path);
  if (fromRevision > toRevision || toRevision !== revision) {
    invalidSchema(path, "lastDiff revision bounds do not match the live map revision.");
  }
  const nodes = expectRecord(diff.nodes, "lastDiff.nodes", path);
  const edges = expectRecord(diff.edges, "lastDiff.edges", path);
  for (const key of ["added", "updated", "tombstoned", "restored"] as const) {
    expectStringArray(nodes[key], `lastDiff.nodes.${key}`, path, MAX_LITERATURE_MAP_NODES);
    expectStringArray(edges[key], `lastDiff.edges.${key}`, path, MAX_LITERATURE_MAP_EDGES);
  }
  if (!Array.isArray(diff.aliasesAdded) || diff.aliasesAdded.length > MAX_LITERATURE_MAP_NODES * 4) {
    invalidSchema(path, "lastDiff.aliasesAdded has an invalid length.");
  }
  for (const [index, alias] of diff.aliasesAdded.entries()) {
    const entry = expectRecord(alias, `lastDiff.aliasesAdded[${index}]`, path);
    expectIdentifier(entry.alias, `lastDiff.aliasesAdded[${index}].alias`, path);
    expectIdentifier(entry.canonicalId, `lastDiff.aliasesAdded[${index}].canonicalId`, path);
  }
  expectStringArray(diff.warnings, "lastDiff.warnings", path, MAX_METADATA_ITEMS);
}

function expectRecord(value: unknown, location: string, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalidSchema(path, `${location} must be an object.`);
  return value;
}

function expectIdentifier(value: unknown, location: string, path: string): string {
  const result = expectString(value, location, path, MAX_IDENTIFIER_LENGTH);
  if (!result.trim() || result.includes("\u0000")) invalidSchema(path, `${location} must be a non-empty identifier.`);
  return result;
}

function expectString(value: unknown, location: string, path: string, maxLength = MAX_STRING_LENGTH): string {
  if (typeof value !== "string" || value.length > maxLength) {
    invalidSchema(path, `${location} must be a string within its size limit.`);
  }
  return value;
}

function expectOptionalString(value: unknown, location: string, path: string): void {
  if (value !== undefined) expectString(value, location, path);
}

function expectStringArray(value: unknown, location: string, path: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    invalidSchema(path, `${location} must be an array within its item limit.`);
  }
  return value.map((item, index) => expectString(item, `${location}[${index}]`, path));
}

function expectBoolean(value: unknown, location: string, path: string): boolean {
  if (typeof value !== "boolean") invalidSchema(path, `${location} must be a boolean.`);
  return value;
}

function expectFiniteNumber(value: unknown, location: string, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidSchema(path, `${location} must be a finite number.`);
  return value;
}

function expectFiniteInteger(value: unknown, location: string, path: string): number {
  const number = expectFiniteNumber(value, location, path);
  if (!Number.isSafeInteger(number)) invalidSchema(path, `${location} must be an integer.`);
  return number;
}

function expectNonNegativeInteger(value: unknown, location: string, path: string): number {
  const number = expectFiniteInteger(value, location, path);
  if (number < 0) invalidSchema(path, `${location} must not be negative.`);
  return number;
}

function expectTimestamp(value: unknown, location: string, path: string): string {
  const timestamp = expectString(value, location, path, 128);
  if (!Number.isFinite(Date.parse(timestamp))) invalidSchema(path, `${location} must be an ISO-compatible timestamp.`);
  return timestamp;
}

function invalidSchema(path: string, message: string): never {
  throw repositoryError("invalid_schema", message, { path, operation: "validate" });
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function lstatIfExists(path: string, operation: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw asIoError(error, path, operation);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function asIoError(error: unknown, path: string, operation: string): LiteratureMapRepositoryError {
  const detail = error instanceof Error ? error.message : String(error);
  return repositoryError("io_error", `Literature-map storage operation failed: ${detail}`, { path, operation });
}

function repositoryError(
  code: LiteratureMapRepositoryErrorCode,
  message: string,
  context: Omit<LiteratureMapRepositoryDiagnostic, "code" | "message"> = {},
): LiteratureMapRepositoryError {
  return new LiteratureMapRepositoryError(code, message, context);
}
