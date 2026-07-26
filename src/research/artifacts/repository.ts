import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildResearchArtifactGraph, latestResearchArtifactRevisions } from "./graph.js";
import {
  canonicalJson,
  createResearchArtifact,
  hashResearchArtifactContent,
  LITERATURE_NOVELTY_RESCAN_ARTIFACT_KIND,
  RESEARCH_ARTIFACT_KINDS,
  researchArtifactKey,
  toResearchArtifactRef,
  type ResearchArtifactEnvelope,
  type ResearchArtifactInvalidation,
  type ResearchArtifactKind,
  type ResearchArtifactRef,
  type ResearchArtifactStatus,
} from "./types.js";

export const RESEARCH_ARTIFACT_REPOSITORY_SCHEMA_VERSION = 1 as const;
export const MAX_RESEARCH_ARTIFACT_REPOSITORY_BYTES = 64 * 1024 * 1024;

const LOCK_RETRIES = 120;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 60_000;
const ARTIFACT_KINDS = new Set<string>(RESEARCH_ARTIFACT_KINDS);
const ARTIFACT_STATUSES = new Set<string>(["active", "stale", "superseded", "rejected", "archived"]);
const INVALIDATION_REASONS = new Set<string>([
  "upstream_changed",
  "evidence_withdrawn",
  "run_failed",
  "review_finding",
  "manual",
]);

export type ProjectResearchArtifactPaths = Readonly<{
  projectRoot: string;
  rigoriumDir: string;
  researchDir: string;
  artifactsDir: string;
  manifestPath: string;
  lockPath: string;
}>;

export type ResearchArtifactStatusEvent = Readonly<{
  sequence: number;
  eventId: string;
  artifact: ResearchArtifactRef;
  from: ResearchArtifactStatus;
  to: ResearchArtifactStatus;
  cause: "new_revision" | "invalidation";
  roots: readonly ResearchArtifactRef[];
  reason?: ResearchArtifactInvalidation["reason"];
  changedAt: string;
}>;

export type ResearchArtifactRepositoryManifest = Readonly<{
  schemaVersion: 1;
  kind: "research_artifact_repository";
  repositoryId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  artifacts: readonly ResearchArtifactEnvelope[];
  statusEvents: readonly ResearchArtifactStatusEvent[];
  contentHash: string;
}>;

export type ProjectResearchArtifactSnapshot = Readonly<{
  path: string;
  repositoryId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  artifacts: readonly ResearchArtifactEnvelope[];
}>;

export type AppendProjectResearchArtifactsResult = Readonly<{
  path: string;
  snapshot: ProjectResearchArtifactSnapshot;
  appendedRefs: readonly ResearchArtifactRef[];
  idempotentRefs: readonly ResearchArtifactRef[];
  supersededRefs: readonly ResearchArtifactRef[];
  staleRefs: readonly ResearchArtifactRef[];
  persisted: boolean;
}>;

export type InvalidateProjectResearchArtifactResult = Readonly<{
  path: string;
  snapshot: ProjectResearchArtifactSnapshot;
  roots: readonly ResearchArtifactRef[];
  staleRefs: readonly ResearchArtifactRef[];
  persisted: boolean;
}>;

export type ResearchArtifactRepositoryErrorCode =
  | "invalid_input"
  | "invalid_project_root"
  | "path_violation"
  | "io_error"
  | "file_too_large"
  | "corrupt_json"
  | "invalid_schema"
  | "integrity_mismatch"
  | "migration_required"
  | "revision_conflict"
  | "artifact_conflict"
  | "missing_parent"
  | "repository_busy";

export type ResearchArtifactRepositoryDiagnostic = Readonly<{
  code: ResearchArtifactRepositoryErrorCode;
  message: string;
  path?: string;
  operation?: string;
}>;

export class ResearchArtifactRepositoryError extends Error {
  readonly code: ResearchArtifactRepositoryErrorCode;
  readonly diagnostic: ResearchArtifactRepositoryDiagnostic;

  constructor(
    code: ResearchArtifactRepositoryErrorCode,
    message: string,
    context: Omit<ResearchArtifactRepositoryDiagnostic, "code" | "message"> = {},
  ) {
    super(message);
    this.name = "ResearchArtifactRepositoryError";
    this.code = code;
    this.diagnostic = Object.freeze({ code, message, ...context });
  }
}

export function getProjectResearchArtifactPaths(input: {
  projectRoot: string;
}): ProjectResearchArtifactPaths {
  if (!input || typeof input.projectRoot !== "string" || !input.projectRoot.trim()) {
    throw repositoryError("invalid_input", "projectRoot must be a non-empty path.", { operation: "resolve_paths" });
  }
  const projectRoot = resolve(input.projectRoot);
  const rigoriumDir = join(projectRoot, ".rigorium");
  const researchDir = join(rigoriumDir, "research");
  const artifactsDir = join(researchDir, "artifacts");
  const manifestPath = join(artifactsDir, "manifest.json");
  const lockPath = join(artifactsDir, ".manifest.lock");
  for (const candidate of [rigoriumDir, researchDir, artifactsDir, manifestPath, lockPath]) {
    assertWithinProject(projectRoot, candidate);
  }
  return Object.freeze({ projectRoot, rigoriumDir, researchDir, artifactsDir, manifestPath, lockPath });
}

export async function loadProjectResearchArtifactRepository(input: {
  projectRoot: string;
}): Promise<ProjectResearchArtifactSnapshot | undefined> {
  const paths = getProjectResearchArtifactPaths(input);
  await assertExistingDirectoryChain(paths, "load_repository");
  const manifest = await readManifest(paths, "load_repository");
  return manifest === undefined ? undefined : snapshotOf(paths, manifest);
}

export async function appendProjectResearchArtifact(input: {
  projectRoot: string;
  artifact: ResearchArtifactEnvelope;
  expectedRepositoryRevision?: number;
  now?: Date;
}): Promise<AppendProjectResearchArtifactsResult> {
  return appendProjectResearchArtifacts({
    projectRoot: input.projectRoot,
    artifacts: [input.artifact],
    expectedRepositoryRevision: input.expectedRepositoryRevision,
    now: input.now,
  });
}

export async function appendProjectResearchArtifacts(input: {
  projectRoot: string;
  artifacts: readonly ResearchArtifactEnvelope[];
  expectedRepositoryRevision?: number;
  now?: Date;
}): Promise<AppendProjectResearchArtifactsResult> {
  if (!input || !Array.isArray(input.artifacts) || input.artifacts.length === 0) {
    throw repositoryError("invalid_input", "artifacts must be a non-empty array.", { operation: "append_artifacts" });
  }
  const paths = getProjectResearchArtifactPaths(input);
  const now = requireDate(input.now ?? new Date(), "now", paths.manifestPath);
  const expectedRevision = normalizeExpectedRevision(input.expectedRepositoryRevision, paths.manifestPath);
  const supplied = normalizeSuppliedArtifacts(input.artifacts, paths.manifestPath);
  await ensureDirectories(paths);

  return withRepositoryLock(paths, async () => {
    const existing = await readManifest(paths, "append_artifacts");
    assertExpectedRevision(existing?.revision ?? 0, expectedRevision, paths.manifestPath, "append_artifacts");
    const base = existing ?? createEmptyManifest(now);
    const existingByKey = new Map(base.artifacts.map((artifact) => [researchArtifactKey(artifact), artifact]));
    const appended: ResearchArtifactEnvelope[] = [];
    const idempotentRefs: ResearchArtifactRef[] = [];

    for (const artifact of supplied) {
      const key = researchArtifactKey(artifact);
      const persisted = existingByKey.get(key);
      if (!persisted) {
        appended.push(artifact);
        existingByKey.set(key, artifact);
        continue;
      }
      if (canonicalJson(persisted) !== canonicalJson(artifact)) {
        throw repositoryError(
          "artifact_conflict",
          `Artifact ${key} already exists with different immutable envelope content.`,
          { path: paths.manifestPath, operation: "append_artifacts" },
        );
      }
      idempotentRefs.push(toResearchArtifactRef(persisted));
    }

    if (appended.length === 0) {
      return Object.freeze({
        path: paths.manifestPath,
        snapshot: snapshotOf(paths, base),
        appendedRefs: Object.freeze([]),
        idempotentRefs: Object.freeze(idempotentRefs.sort(compareRefs)),
        supersededRefs: Object.freeze([]),
        staleRefs: Object.freeze([]),
        persisted: false,
      });
    }

    assertTransactionTime(base, now, paths.manifestPath);
    for (const artifact of appended) {
      if (Date.parse(artifact.updatedAt) > Date.parse(now)) {
        throw repositoryError(
          "revision_conflict",
          `Artifact ${researchArtifactKey(artifact)} is dated after the transaction time.`,
          { path: paths.manifestPath, operation: "append_artifacts" },
        );
      }
    }
    assertAppendOnlyRevisionSequence(base.artifacts, appended, paths.manifestPath);
    const artifacts = Object.freeze([...base.artifacts, ...appended]);
    const graph = validateCompleteArtifactGraph(artifacts, paths.manifestPath);
    validateEmbeddedInvalidationRefs(artifacts, paths.manifestPath, graph);
    const events = [...base.statusEvents];
    const states = replayStatusEvents(artifacts, events, paths.manifestPath, graph);
    const supersededRefs: ResearchArtifactRef[] = [];
    const updatedRootRefs: ResearchArtifactRef[] = [];
    const allById = groupArtifactsById(artifacts);
    const appendedKeys = new Set(appended.map(researchArtifactKey));

    for (const history of allById.values()) {
      for (let index = 1; index < history.length; index += 1) {
        const current = history[index]!;
        if (!appendedKeys.has(researchArtifactKey(current))) continue;
        const previous = history[index - 1]!;
        const previousKey = researchArtifactKey(previous);
        updatedRootRefs.push(toResearchArtifactRef(previous));
        if (states.get(previousKey)?.status === "active" || states.get(previousKey)?.status === "stale") {
          appendStatusEvent({
            events,
            states,
            artifact: previous,
            to: "superseded",
            cause: "new_revision",
            roots: [toResearchArtifactRef(current)],
            changedAt: now,
          });
          supersededRefs.push(toResearchArtifactRef(previous));
        }
      }
    }

    const inheritedInvalidationRoots = artifacts
      .filter((artifact) => states.get(researchArtifactKey(artifact))?.status !== "active")
      .map(toResearchArtifactRef);
    const staleRefs = appendPreciseInvalidationEvents({
      graph,
      artifacts,
      events,
      states,
      roots: uniqueRefs([...updatedRootRefs, ...inheritedInvalidationRoots]),
      reason: "upstream_changed",
      changedAt: now,
    });
    const manifest = sealManifest({
      schemaVersion: RESEARCH_ARTIFACT_REPOSITORY_SCHEMA_VERSION,
      kind: "research_artifact_repository",
      repositoryId: base.repositoryId,
      revision: existing === undefined ? 1 : existing.revision + 1,
      createdAt: base.createdAt,
      updatedAt: now,
      artifacts,
      statusEvents: Object.freeze(events),
    });
    await writeManifestAtomically(paths, manifest, "append_artifacts");
    return Object.freeze({
      path: paths.manifestPath,
      snapshot: snapshotOf(paths, manifest),
      appendedRefs: Object.freeze(appended.map(toResearchArtifactRef).sort(compareRefs)),
      idempotentRefs: Object.freeze(idempotentRefs.sort(compareRefs)),
      supersededRefs: Object.freeze(uniqueRefs(supersededRefs)),
      staleRefs: Object.freeze(staleRefs),
      persisted: true,
    });
  });
}

export async function invalidateProjectResearchArtifactDescendants(input: {
  projectRoot: string;
  roots: readonly ResearchArtifactRef[];
  reason: ResearchArtifactInvalidation["reason"];
  expectedRepositoryRevision?: number;
  now?: Date;
}): Promise<InvalidateProjectResearchArtifactResult> {
  if (!input || !Array.isArray(input.roots) || input.roots.length === 0) {
    throw repositoryError("invalid_input", "roots must be a non-empty array.", { operation: "invalidate_descendants" });
  }
  if (!INVALIDATION_REASONS.has(String(input.reason))) {
    throw repositoryError("invalid_input", "reason must be a supported artifact invalidation reason.", {
      operation: "invalidate_descendants",
    });
  }
  const paths = getProjectResearchArtifactPaths(input);
  const roots = uniqueRefs(input.roots.map((root, index) => normalizeRef(root, `roots[${index}]`, paths.manifestPath)));
  const now = requireDate(input.now ?? new Date(), "now", paths.manifestPath);
  const expectedRevision = normalizeExpectedRevision(input.expectedRepositoryRevision, paths.manifestPath);
  await ensureDirectories(paths);

  return withRepositoryLock(paths, async () => {
    const existing = await readManifest(paths, "invalidate_descendants");
    if (!existing) {
      throw repositoryError("missing_parent", "Cannot invalidate artifacts before the repository exists.", {
        path: paths.manifestPath,
        operation: "invalidate_descendants",
      });
    }
    assertExpectedRevision(existing.revision, expectedRevision, paths.manifestPath, "invalidate_descendants");
    const graph = validateCompleteArtifactGraph(existing.artifacts, paths.manifestPath);
    for (const root of roots) resolveRef(existing.artifacts, root, paths.manifestPath, "invalidation root");
    const events = [...existing.statusEvents];
    const states = replayStatusEvents(existing.artifacts, events, paths.manifestPath);
    const staleRefs = appendPreciseInvalidationEvents({
      graph,
      artifacts: existing.artifacts,
      events,
      states,
      roots,
      reason: input.reason,
      changedAt: now,
    });
    if (staleRefs.length === 0) {
      return Object.freeze({
        path: paths.manifestPath,
        snapshot: snapshotOf(paths, existing),
        roots: Object.freeze(roots),
        staleRefs: Object.freeze([]),
        persisted: false,
      });
    }
    assertTransactionTime(existing, now, paths.manifestPath);
    const manifest = sealManifest({
      schemaVersion: RESEARCH_ARTIFACT_REPOSITORY_SCHEMA_VERSION,
      kind: "research_artifact_repository",
      repositoryId: existing.repositoryId,
      revision: existing.revision + 1,
      createdAt: existing.createdAt,
      updatedAt: now,
      artifacts: existing.artifacts,
      statusEvents: Object.freeze(events),
    });
    await writeManifestAtomically(paths, manifest, "invalidate_descendants");
    return Object.freeze({
      path: paths.manifestPath,
      snapshot: snapshotOf(paths, manifest),
      roots: Object.freeze(roots),
      staleRefs: Object.freeze(staleRefs),
      persisted: true,
    });
  });
}

export async function getProjectResearchArtifact(input: {
  projectRoot: string;
  artifactId: string;
  revision: number;
}): Promise<ResearchArtifactEnvelope | undefined> {
  const artifactId = requireIdentifier(input.artifactId, "artifactId", "query");
  const revision = requirePositiveInteger(input.revision, "revision", "query");
  const snapshot = await loadProjectResearchArtifactRepository({ projectRoot: input.projectRoot });
  return snapshot?.artifacts.find((artifact) => artifact.artifactId === artifactId && artifact.revision === revision);
}

export async function getLatestProjectResearchArtifact(input: {
  projectRoot: string;
  artifactId: string;
}): Promise<ResearchArtifactEnvelope | undefined> {
  const artifactId = requireIdentifier(input.artifactId, "artifactId", "query");
  const history = await getProjectResearchArtifactHistory({ projectRoot: input.projectRoot, artifactId });
  return history.at(-1);
}

export async function getProjectResearchArtifactHistory(input: {
  projectRoot: string;
  artifactId: string;
}): Promise<readonly ResearchArtifactEnvelope[]> {
  const artifactId = requireIdentifier(input.artifactId, "artifactId", "query");
  const snapshot = await loadProjectResearchArtifactRepository({ projectRoot: input.projectRoot });
  return Object.freeze((snapshot?.artifacts ?? [])
    .filter((artifact) => artifact.artifactId === artifactId)
    .sort((left, right) => left.revision - right.revision));
}

export async function listLatestProjectResearchArtifacts(input: {
  projectRoot: string;
  kind?: ResearchArtifactKind;
  status?: ResearchArtifactStatus;
}): Promise<readonly ResearchArtifactEnvelope[]> {
  if (input.kind !== undefined && !ARTIFACT_KINDS.has(input.kind)) {
    throw repositoryError("invalid_input", `Unsupported artifact kind ${input.kind}.`, { operation: "list_latest" });
  }
  if (input.status !== undefined && !ARTIFACT_STATUSES.has(input.status)) {
    throw repositoryError("invalid_input", `Unsupported artifact status ${input.status}.`, { operation: "list_latest" });
  }
  const snapshot = await loadProjectResearchArtifactRepository({ projectRoot: input.projectRoot });
  const latest = latestResearchArtifactRevisions(snapshot?.artifacts ?? []);
  return Object.freeze(latest.filter((artifact) =>
    (input.kind === undefined || artifact.kind === input.kind)
    && (input.status === undefined || artifact.status === input.status)));
}

export function validateResearchArtifactRepositoryManifest(
  value: unknown,
  path = "manifest.json",
): ResearchArtifactRepositoryManifest {
  const record = expectRecord(value, "repository manifest", path);
  if (record.schemaVersion !== RESEARCH_ARTIFACT_REPOSITORY_SCHEMA_VERSION
    || record.kind !== "research_artifact_repository") {
    invalidSchema(path, "Unsupported research artifact repository schema.");
  }
  const artifactsRaw = record.artifacts;
  const eventsRaw = record.statusEvents;
  if (!Array.isArray(artifactsRaw) || !Array.isArray(eventsRaw)) {
    invalidSchema(path, "Repository artifacts and statusEvents must be arrays.");
  }
  const artifacts = Object.freeze(artifactsRaw.map((artifact, index) =>
    normalizeEnvelope(artifact, `${path}.artifacts[${index}]`)));
  const statusEvents = Object.freeze(eventsRaw.map((event, index) =>
    normalizeStatusEvent(event, index + 1, `${path}.statusEvents[${index}]`)));
  const manifestWithoutHash = {
    schemaVersion: RESEARCH_ARTIFACT_REPOSITORY_SCHEMA_VERSION,
    kind: "research_artifact_repository" as const,
    repositoryId: requireIdentifier(record.repositoryId, "repositoryId", path),
    revision: requirePositiveInteger(record.revision, "revision", path),
    createdAt: requireDate(record.createdAt, "createdAt", path),
    updatedAt: requireDate(record.updatedAt, "updatedAt", path),
    artifacts,
    statusEvents,
  };
  if (Date.parse(manifestWithoutHash.updatedAt) < Date.parse(manifestWithoutHash.createdAt)) {
    invalidSchema(path, "Repository updatedAt must not precede createdAt.");
  }
  const contentHash = requireHash(record.contentHash, "contentHash", path);
  if (hashResearchArtifactContent(manifestWithoutHash) !== contentHash) {
    throw repositoryError("integrity_mismatch", "Repository contentHash does not match its canonical content.", {
      path,
      operation: "validate_manifest",
    });
  }
  const graph = validateCompleteArtifactGraph(artifacts, path);
  assertAppendOnlyRevisionSequence([], artifacts, path);
  validateEmbeddedInvalidationRefs(artifacts, path, graph);
  replayStatusEvents(artifacts, statusEvents, path, graph);
  for (const artifact of artifacts) {
    if (Date.parse(artifact.updatedAt) > Date.parse(manifestWithoutHash.updatedAt)) {
      invalidSchema(path, `Artifact ${researchArtifactKey(artifact)} is newer than the repository commit.`);
    }
  }
  for (const event of statusEvents) {
    if (Date.parse(event.changedAt) > Date.parse(manifestWithoutHash.updatedAt)) {
      invalidSchema(path, `Status event ${event.eventId} is newer than the repository commit.`);
    }
  }
  const normalized = deepFreeze({ ...manifestWithoutHash, contentHash });
  assertCanonicalShape(value, normalized, path, "Repository manifest contains unknown or non-canonical fields.");
  return normalized;
}

function createEmptyManifest(now: string): ResearchArtifactRepositoryManifest {
  return sealManifest({
    schemaVersion: RESEARCH_ARTIFACT_REPOSITORY_SCHEMA_VERSION,
    kind: "research_artifact_repository",
    repositoryId: `artifact-repository-${randomUUID()}`,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    artifacts: Object.freeze([]),
    statusEvents: Object.freeze([]),
  });
}

function sealManifest(
  value: Omit<ResearchArtifactRepositoryManifest, "contentHash">,
): ResearchArtifactRepositoryManifest {
  const body = deepFreeze(value);
  return deepFreeze({ ...body, contentHash: hashResearchArtifactContent(body) });
}

function snapshotOf(
  paths: ProjectResearchArtifactPaths,
  manifest: ResearchArtifactRepositoryManifest,
): ProjectResearchArtifactSnapshot {
  return Object.freeze({
    path: paths.manifestPath,
    repositoryId: manifest.repositoryId,
    revision: manifest.revision,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    contentHash: manifest.contentHash,
    artifacts: Object.freeze(materializeArtifacts(manifest.artifacts, manifest.statusEvents, paths.manifestPath)),
  });
}

function normalizeSuppliedArtifacts(
  artifacts: readonly ResearchArtifactEnvelope[],
  path: string,
): ResearchArtifactEnvelope[] {
  const byKey = new Map<string, ResearchArtifactEnvelope>();
  for (const [index, value] of artifacts.entries()) {
    const artifact = normalizeEnvelope(value, `${path}.inputArtifacts[${index}]`);
    const key = researchArtifactKey(artifact);
    const existing = byKey.get(key);
    if (existing && canonicalJson(existing) !== canonicalJson(artifact)) {
      throw repositoryError("artifact_conflict", `Input contains conflicting artifact ${key}.`, {
        path,
        operation: "append_artifacts",
      });
    }
    byKey.set(key, artifact);
  }
  return [...byKey.values()];
}

function normalizeEnvelope(value: unknown, path: string): ResearchArtifactEnvelope {
  const envelope = expectRecord(value, "artifact envelope", path) as unknown as ResearchArtifactEnvelope;
  if (envelope.schemaVersion !== 1 || !Array.isArray(envelope.parents) || !Array.isArray(envelope.sources)) {
    invalidSchema(path, "Artifact envelope is incomplete.");
  }
  if (!ARTIFACT_KINDS.has(String(envelope.kind))) invalidSchema(path, `Unsupported artifact kind ${String(envelope.kind)}.`);
  const createdAt = requireDate(envelope.createdAt, "createdAt", path);
  const updatedAt = requireDate(envelope.updatedAt, "updatedAt", path);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) invalidSchema(path, "Artifact updatedAt must not precede createdAt.");
  const payload = cloneCanonical(envelope.payload, `${path}.payload`);
  if (isLegacyLiteratureNoveltyRescanEnvelope(envelope.kind, payload)) {
    throw repositoryError(
      "migration_required",
      "Legacy candidate_portfolio novelty-rescan artifacts must be migrated to literature_novelty_rescan and have their hashes and references regenerated.",
      { path, operation: "migrate_legacy_artifact" },
    );
  }
  validateArtifactPayloadContract(envelope.kind, payload, path);
  let rebuilt: ResearchArtifactEnvelope;
  try {
    rebuilt = createResearchArtifact({
      kind: envelope.kind,
      artifactId: envelope.artifactId,
      revision: envelope.revision,
      status: envelope.status,
      producer: envelope.producer,
      parents: envelope.parents,
      sources: envelope.sources,
      payload,
      now: new Date(createdAt),
    });
  } catch (error) {
    invalidSchema(path, `Artifact envelope is invalid: ${messageOf(error)}.`);
  }
  const contentHash = requireHash(envelope.contentHash, "contentHash", path);
  if (rebuilt.contentHash !== contentHash) {
    throw repositoryError(
      "integrity_mismatch",
      `Artifact ${rebuilt.artifactId}@${rebuilt.revision} contentHash does not match its canonical content.`,
      { path, operation: "validate_artifact" },
    );
  }
  const invalidation = envelope.invalidation === undefined
    ? undefined
    : normalizeInvalidation(envelope.invalidation, `${path}.invalidation`);
  if (invalidation !== undefined && rebuilt.status !== "stale") {
    invalidSchema(path, "Only a stale artifact may carry invalidation metadata.");
  }
  if (invalidation !== undefined
    && (Date.parse(invalidation.invalidatedAt) < Date.parse(createdAt)
      || Date.parse(invalidation.invalidatedAt) > Date.parse(updatedAt))) {
    invalidSchema(path, "Artifact invalidation time must fall between createdAt and updatedAt.");
  }
  const normalized = deepFreeze({
    ...rebuilt,
    createdAt,
    updatedAt,
    contentHash,
    payload,
    ...(invalidation === undefined ? {} : { invalidation }),
  });
  assertCanonicalShape(value, normalized, path, "Artifact envelope contains unknown or non-canonical fields.");
  return normalized;
}

function isLegacyLiteratureNoveltyRescanEnvelope(kind: ResearchArtifactKind, payload: unknown): boolean {
  return kind === "candidate_portfolio"
    && isRecord(payload)
    && payload.schemaVersion === 1
    && payload.kind === "candidate_portfolio"
    && Object.prototype.hasOwnProperty.call(payload, "rescan");
}

function validateArtifactPayloadContract(kind: ResearchArtifactKind, payload: unknown, path: string): void {
  if (kind === "candidate_portfolio") {
    const candidatePortfolio = expectRecord(payload, "candidate_portfolio payload", path);
    if (candidatePortfolio.schemaVersion !== 1 || candidatePortfolio.kind !== "candidate_portfolio") {
      invalidSchema(path, "candidate_portfolio payload kind or schemaVersion does not match its envelope.");
    }
    if (Object.prototype.hasOwnProperty.call(candidatePortfolio, "rescan")) {
      invalidSchema(path, "candidate_portfolio payloads must not carry literature novelty rescan data.");
    }
    return;
  }
  if (kind !== LITERATURE_NOVELTY_RESCAN_ARTIFACT_KIND) return;
  const literatureRescan = expectRecord(payload, "literature_novelty_rescan payload", path);
  if (literatureRescan.schemaVersion !== 1 || literatureRescan.kind !== LITERATURE_NOVELTY_RESCAN_ARTIFACT_KIND) {
    invalidSchema(path, "literature_novelty_rescan payload kind or schemaVersion does not match its envelope.");
  }
  const rescan = expectRecord(literatureRescan.rescan, "literature_novelty_rescan result", path);
  if (rescan.schemaVersion !== 1 || rescan.kind !== "candidate_novelty_value_rescan") {
    invalidSchema(path, "literature_novelty_rescan payload must contain a versioned novelty rescan result.");
  }
}

function normalizeInvalidation(value: unknown, path: string): ResearchArtifactInvalidation {
  const invalidation = expectRecord(value, "artifact invalidation", path);
  if (!INVALIDATION_REASONS.has(String(invalidation.reason))
    || !Array.isArray(invalidation.roots)
    || invalidation.roots.length === 0) {
    invalidSchema(path, "Artifact invalidation is invalid.");
  }
  return Object.freeze({
    invalidatedAt: requireDate(invalidation.invalidatedAt, "invalidatedAt", path),
    reason: invalidation.reason as ResearchArtifactInvalidation["reason"],
    roots: uniqueRefs(invalidation.roots.map((root, index) => normalizeRef(root, `roots[${index}]`, path))),
  });
}

function normalizeStatusEvent(value: unknown, sequence: number, path: string): ResearchArtifactStatusEvent {
  const event = expectRecord(value, "status event", path);
  if (event.sequence !== sequence) invalidSchema(path, `Status event sequence must be ${sequence}.`);
  if (event.cause !== "new_revision" && event.cause !== "invalidation") {
    invalidSchema(path, "Status event cause is invalid.");
  }
  const from = requireStatus(event.from, "from", path);
  const to = requireStatus(event.to, "to", path);
  if (from === to) invalidSchema(path, "Status event must change status.");
  const rootsRaw = event.roots;
  if (!Array.isArray(rootsRaw) || rootsRaw.length === 0) invalidSchema(path, "Status event roots must be non-empty.");
  const roots = uniqueRefs(rootsRaw.map((root, index) => normalizeRef(root, `roots[${index}]`, path)));
  const reason = event.reason === undefined ? undefined : requireInvalidationReason(event.reason, "reason", path);
  if (event.cause === "new_revision" && (to !== "superseded" || reason !== undefined)) {
    invalidSchema(path, "A new_revision event must transition to superseded without an invalidation reason.");
  }
  if (event.cause === "invalidation" && (to !== "stale" || reason === undefined)) {
    invalidSchema(path, "An invalidation event must transition to stale with a reason.");
  }
  const normalized = Object.freeze({
    sequence,
    eventId: requireIdentifier(event.eventId, "eventId", path),
    artifact: normalizeRef(event.artifact, "artifact", path),
    from,
    to,
    cause: event.cause,
    roots: Object.freeze(roots),
    ...(reason === undefined ? {} : { reason }),
    changedAt: requireDate(event.changedAt, "changedAt", path),
  });
  assertCanonicalShape(value, normalized, path, "Status event contains unknown or non-canonical fields.");
  assertStatusEventId(normalized, path);
  return normalized;
}

function assertStatusEventId(event: ResearchArtifactStatusEvent, path: string): void {
  const { eventId, ...body } = event;
  if (eventId !== statusEventId(body)) {
    throw repositoryError("integrity_mismatch", `Status event ${eventId} does not match its canonical body.`, {
      path,
      operation: "validate_status_event",
    });
  }
}

function statusEventId(value: Omit<ResearchArtifactStatusEvent, "eventId">): string {
  return `artifact-status-${value.sequence}-${hashResearchArtifactContent(value).slice("sha256:".length, 23)}`;
}

function materializeArtifacts(
  artifacts: readonly ResearchArtifactEnvelope[],
  events: readonly ResearchArtifactStatusEvent[],
  path: string,
): ResearchArtifactEnvelope[] {
  const states = replayStatusEvents(artifacts, events, path);
  return artifacts.map((artifact) => {
    const state = states.get(researchArtifactKey(artifact));
    if (!state) invalidSchema(path, `Artifact ${researchArtifactKey(artifact)} has no materialized state.`);
    return deepFreeze({
      ...artifact,
      status: state.status,
      updatedAt: state.updatedAt,
      ...(state.invalidation === undefined ? { invalidation: undefined } : { invalidation: state.invalidation }),
    }) as ResearchArtifactEnvelope;
  }).map((artifact) => {
    if (artifact.invalidation !== undefined) return artifact;
    const { invalidation: _ignored, ...withoutInvalidation } = artifact;
    return deepFreeze(withoutInvalidation) as ResearchArtifactEnvelope;
  });
}

type MaterializedState = {
  status: ResearchArtifactStatus;
  updatedAt: string;
  invalidation?: ResearchArtifactInvalidation;
};

function replayStatusEvents(
  artifacts: readonly ResearchArtifactEnvelope[],
  events: readonly ResearchArtifactStatusEvent[],
  path: string,
  graph = validateCompleteArtifactGraph(artifacts, path),
): Map<string, MaterializedState> {
  const states = new Map<string, MaterializedState>(artifacts.map((artifact) => [
    researchArtifactKey(artifact),
    {
      status: artifact.status,
      updatedAt: artifact.updatedAt,
      ...(artifact.invalidation === undefined ? {} : { invalidation: artifact.invalidation }),
    },
  ]));
  const eventIds = new Set<string>();
  const descendantsByRoot = new Map<string, ReadonlySet<string>>();
  const descendantsOf = (rootKey: string): ReadonlySet<string> =>
    descendantKeys(graph, descendantsByRoot, rootKey);
  let previousEventTime = Number.NEGATIVE_INFINITY;
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) invalidSchema(path, `Status event sequence ${event.sequence} is not contiguous.`);
    if (eventIds.has(event.eventId)) invalidSchema(path, `Status event ${event.eventId} is duplicated.`);
    eventIds.add(event.eventId);
    const artifact = resolveRef(artifacts, event.artifact, path, "status event artifact");
    const roots = event.roots.map((root) => resolveRef(artifacts, root, path, "status event root"));
    const key = researchArtifactKey(artifact);
    const state = states.get(key)!;
    const eventTime = Date.parse(event.changedAt);
    if (eventTime < previousEventTime) {
      invalidSchema(path, `Status event ${event.eventId} is out of chronological order.`);
    }
    if (state.status !== event.from) {
      invalidSchema(path, `Status event ${event.eventId} expected ${event.from}, found ${state.status}.`);
    }
    if (eventTime < Date.parse(state.updatedAt)) {
      invalidSchema(path, `Status event ${event.eventId} predates the artifact state it changes.`);
    }
    if (event.cause === "new_revision") {
      const replacement = roots[0];
      if ((event.from !== "active" && event.from !== "stale")
        || roots.length !== 1
        || !replacement
        || replacement.artifactId !== artifact.artifactId
        || replacement.kind !== artifact.kind
        || replacement.revision !== artifact.revision + 1
        || eventTime < Date.parse(replacement.updatedAt)) {
        invalidSchema(path, `Status event ${event.eventId} is not a valid adjacent replacement transition.`);
      }
    } else {
      if (event.from !== "active"
        || roots.some((root) => !descendantsOf(researchArtifactKey(root)).has(key))) {
        invalidSchema(path, `Status event ${event.eventId} does not stale a strict descendant of every root.`);
      }
    }
    states.set(key, {
      status: event.to,
      updatedAt: event.changedAt,
      ...(event.cause === "invalidation"
        ? {
            invalidation: Object.freeze({
              invalidatedAt: event.changedAt,
              reason: event.reason!,
              roots: [...event.roots],
            }),
          }
        : {}),
    });
    previousEventTime = eventTime;
  }
  return states;
}

function appendStatusEvent(input: {
  events: ResearchArtifactStatusEvent[];
  states: Map<string, MaterializedState>;
  artifact: ResearchArtifactEnvelope;
  to: ResearchArtifactStatus;
  cause: ResearchArtifactStatusEvent["cause"];
  roots: readonly ResearchArtifactRef[];
  reason?: ResearchArtifactInvalidation["reason"];
  changedAt: string;
}): void {
  const key = researchArtifactKey(input.artifact);
  const state = input.states.get(key);
  if (!state) throw new TypeError(`Missing status state for ${key}.`);
  if (state.status === input.to) return;
  if (Date.parse(input.changedAt) < Date.parse(state.updatedAt)) {
    throw repositoryError("revision_conflict", `Status transition for ${key} predates its current state.`, {
      operation: "append_status_event",
    });
  }
  const sequence = input.events.length + 1;
  const eventBody: Omit<ResearchArtifactStatusEvent, "eventId"> = {
    sequence,
    artifact: toResearchArtifactRef(input.artifact),
    from: state.status,
    to: input.to,
    cause: input.cause,
    roots: uniqueRefs(input.roots),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    changedAt: input.changedAt,
  };
  const eventId = statusEventId(eventBody);
  const event = Object.freeze({ ...eventBody, eventId });
  input.events.push(event);
  input.states.set(key, {
    status: input.to,
    updatedAt: input.changedAt,
    ...(input.cause === "invalidation"
      ? {
          invalidation: Object.freeze({
            invalidatedAt: input.changedAt,
            reason: input.reason!,
            roots: [...event.roots],
          }),
        }
      : {}),
  });
}

function appendPreciseInvalidationEvents(input: {
  graph: ReturnType<typeof buildResearchArtifactGraph>;
  artifacts: readonly ResearchArtifactEnvelope[];
  events: ResearchArtifactStatusEvent[];
  states: Map<string, MaterializedState>;
  roots: readonly ResearchArtifactRef[];
  reason: ResearchArtifactInvalidation["reason"];
  changedAt: string;
}): ResearchArtifactRef[] {
  if (input.roots.length === 0) return [];
  const explicitRootKeys = new Set(input.roots.map(researchArtifactKey));
  const rootsByDescendant = new Map<string, Map<string, ResearchArtifactRef>>();
  for (const root of input.roots) {
    const rootKey = researchArtifactKey(root);
    const queue = [rootKey];
    const visited = new Set<string>([rootKey]);
    for (let index = 0; index < queue.length; index += 1) {
      const key = queue[index]!;
      for (const childKey of input.graph.invalidationChildren.get(key) ?? []) {
        if (!visited.has(childKey)) {
          visited.add(childKey);
          queue.push(childKey);
        }
        if (explicitRootKeys.has(childKey)) continue;
        const roots = rootsByDescendant.get(childKey) ?? new Map<string, ResearchArtifactRef>();
        roots.set(fullRefKey(root), root);
        rootsByDescendant.set(childKey, roots);
      }
    }
  }
  const artifactsByKey = new Map(input.artifacts.map((artifact) => [researchArtifactKey(artifact), artifact]));
  const staleRefs: ResearchArtifactRef[] = [];
  for (const key of [...rootsByDescendant.keys()].sort(compareText)) {
    const artifact = artifactsByKey.get(key);
    if (!artifact || input.states.get(key)?.status !== "active") continue;
    appendStatusEvent({
      events: input.events,
      states: input.states,
      artifact,
      to: "stale",
      cause: "invalidation",
      roots: [...rootsByDescendant.get(key)!.values()],
      reason: input.reason,
      changedAt: input.changedAt,
    });
    staleRefs.push(toResearchArtifactRef(artifact));
  }
  return staleRefs.sort(compareRefs);
}

function validateCompleteArtifactGraph(
  artifacts: readonly ResearchArtifactEnvelope[],
  path: string,
): ReturnType<typeof buildResearchArtifactGraph> {
  try {
    const graph = buildResearchArtifactGraph(artifacts);
    if (graph.missingParents.length > 0) {
      throw repositoryError(
        "missing_parent",
        `Artifact graph has missing parent ${fullRefKey(graph.missingParents[0]!)}.`,
        { path, operation: "validate_graph" },
      );
    }
    return graph;
  } catch (error) {
    if (error instanceof ResearchArtifactRepositoryError) throw error;
    invalidSchema(path, `Artifact graph is invalid: ${messageOf(error)}.`);
  }
}

function assertAppendOnlyRevisionSequence(
  existing: readonly ResearchArtifactEnvelope[],
  appended: readonly ResearchArtifactEnvelope[],
  path: string,
): void {
  const grouped = groupArtifactsById([...existing, ...appended]);
  for (const [artifactId, history] of grouped) {
    let expectedRevision = 1;
    const kind = history[0]!.kind;
    let previousCreatedAt = Number.NEGATIVE_INFINITY;
    for (const artifact of history) {
      if (artifact.revision !== expectedRevision) {
        throw repositoryError(
          "revision_conflict",
          `Artifact ${artifactId} expected revision ${expectedRevision}, found ${artifact.revision}.`,
          { path, operation: "validate_revisions" },
        );
      }
      if (artifact.kind !== kind) {
        throw repositoryError(
          "artifact_conflict",
          `Artifact ${artifactId} changes kind from ${kind} to ${artifact.kind}.`,
          { path, operation: "validate_revisions" },
        );
      }
      if (Date.parse(artifact.createdAt) < previousCreatedAt) {
        throw repositoryError(
          "revision_conflict",
          `Artifact ${artifactId} revision ${artifact.revision} predates its previous revision.`,
          { path, operation: "validate_revisions" },
        );
      }
      previousCreatedAt = Date.parse(artifact.createdAt);
      expectedRevision += 1;
    }
  }
}

function groupArtifactsById(
  artifacts: readonly ResearchArtifactEnvelope[],
): Map<string, ResearchArtifactEnvelope[]> {
  const result = new Map<string, ResearchArtifactEnvelope[]>();
  for (const artifact of artifacts) {
    const history = result.get(artifact.artifactId) ?? [];
    history.push(artifact);
    result.set(artifact.artifactId, history);
  }
  for (const history of result.values()) history.sort((left, right) => left.revision - right.revision);
  return result;
}

function validateEmbeddedInvalidationRefs(
  artifacts: readonly ResearchArtifactEnvelope[],
  path: string,
  graph = validateCompleteArtifactGraph(artifacts, path),
): void {
  const descendantsByRoot = new Map<string, ReadonlySet<string>>();
  for (const artifact of artifacts) {
    const artifactKey = researchArtifactKey(artifact);
    artifact.invalidation?.roots.forEach((root) => {
      resolveRef(artifacts, root, path, "artifact invalidation root");
      if (!descendantKeys(graph, descendantsByRoot, researchArtifactKey(root)).has(artifactKey)) {
        invalidSchema(path, `Artifact invalidation root ${fullRefKey(root)} is not an ancestor of ${artifactKey}.`);
      }
    });
  }
}

function descendantKeys(
  graph: ReturnType<typeof buildResearchArtifactGraph>,
  cache: Map<string, ReadonlySet<string>>,
  rootKey: string,
): ReadonlySet<string> {
  const cached = cache.get(rootKey);
  if (cached) return cached;
  const descendants = new Set<string>();
  const queue = [rootKey];
  for (let offset = 0; offset < queue.length; offset += 1) {
    const key = queue[offset]!;
    for (const childKey of graph.invalidationChildren.get(key) ?? []) {
      if (descendants.has(childKey)) continue;
      descendants.add(childKey);
      queue.push(childKey);
    }
  }
  cache.set(rootKey, descendants);
  return descendants;
}

function resolveRef(
  artifacts: readonly ResearchArtifactEnvelope[],
  ref: ResearchArtifactRef,
  path: string,
  label: string,
): ResearchArtifactEnvelope {
  const artifact = artifacts.find((candidate) => researchArtifactKey(candidate) === researchArtifactKey(ref));
  if (!artifact || artifact.kind !== ref.kind || artifact.contentHash !== ref.contentHash) {
    throw repositoryError("missing_parent", `${label} ${fullRefKey(ref)} does not resolve exactly.`, {
      path,
      operation: "resolve_ref",
    });
  }
  return artifact;
}

async function readManifest(
  paths: ProjectResearchArtifactPaths,
  operation: string,
): Promise<ResearchArtifactRepositoryManifest | undefined> {
  const value = await readBoundedJson(paths.manifestPath, operation);
  return value === undefined ? undefined : validateResearchArtifactRepositoryManifest(value, paths.manifestPath);
}

async function readBoundedJson(path: string, operation: string): Promise<unknown | undefined> {
  const stats = await lstatIfExists(path, operation);
  if (!stats) return undefined;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw repositoryError("path_violation", "Artifact repository manifest must be a regular file.", { path, operation });
  }
  if (stats.size > MAX_RESEARCH_ARTIFACT_REPOSITORY_BYTES) {
    throw repositoryError("file_too_large", "Artifact repository manifest exceeds its size limit.", { path, operation });
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
    throw repositoryError("corrupt_json", "Artifact repository manifest is not valid JSON.", { path, operation });
  }
}

async function writeManifestAtomically(
  paths: ProjectResearchArtifactPaths,
  manifest: ResearchArtifactRepositoryManifest,
  operation: string,
): Promise<void> {
  const serialized = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (serialized.byteLength > MAX_RESEARCH_ARTIFACT_REPOSITORY_BYTES) {
    throw repositoryError("file_too_large", "Artifact repository manifest exceeds its size limit.", {
      path: paths.manifestPath,
      operation,
    });
  }
  const existing = await lstatIfExists(paths.manifestPath, operation);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw repositoryError("path_violation", "Artifact repository manifest must be a regular file.", {
      path: paths.manifestPath,
      operation,
    });
  }
  const temporaryPath = join(
    paths.artifactsDir,
    `.${basename(paths.manifestPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let committed = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, paths.manifestPath);
    committed = true;
    await syncDirectoryBestEffort(paths.artifactsDir);
  } catch (error) {
    throw error instanceof ResearchArtifactRepositoryError
      ? error
      : asIoError(error, paths.manifestPath, operation);
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* preserve the original failure */ }
    }
    if (!committed) {
      try { await unlink(temporaryPath); } catch { /* randomized transaction temp never aliases user data */ }
    }
  }
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // File fsync plus rename is the portable guarantee; directory fsync is not available on every Windows filesystem.
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* best effort only */ }
    }
  }
}

async function withRepositoryLock<T>(
  paths: ProjectResearchArtifactPaths,
  operation: () => Promise<T>,
): Promise<T> {
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
          try { await handle.close(); } catch { /* preserve acquisition failure */ }
          handle = undefined;
          try { await unlink(paths.lockPath); } catch { /* remove only the lock this attempt created */ }
        }
        throw asIoError(error, paths.lockPath, "acquire_repository_lock");
      }
      if (await reclaimStaleRepositoryLock(paths)) continue;
      if (attempt === LOCK_RETRIES - 1) {
        throw repositoryError("repository_busy", "Another process is updating the artifact repository.", {
          path: paths.lockPath,
          operation: "acquire_repository_lock",
        });
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* preserve operation result */ }
      try { await unlink(paths.lockPath); } catch { /* stale-lock recovery handles a later cleanup */ }
    }
  }
}

async function reclaimStaleRepositoryLock(paths: ProjectResearchArtifactPaths): Promise<boolean> {
  const stats = await lstatIfExists(paths.lockPath, "inspect_repository_lock");
  if (!stats) return true;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw repositoryError("path_violation", "Artifact repository lock must be a regular file.", {
      path: paths.lockPath,
      operation: "inspect_repository_lock",
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
      throw asIoError(error, paths.lockPath, "inspect_repository_lock");
    }
  }
  if (ownerPid !== undefined && isProcessAlive(ownerPid)) return false;
  const stalePath = join(paths.artifactsDir, `.manifest.lock.stale.${process.pid}.${randomUUID()}`);
  try {
    await rename(paths.lockPath, stalePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw asIoError(error, paths.lockPath, "reclaim_repository_lock");
  }
  try { await unlink(stalePath); } catch { /* randomized stale lock cannot block future writes */ }
  return true;
}

async function assertExistingDirectoryChain(
  paths: ProjectResearchArtifactPaths,
  operation: string,
): Promise<void> {
  await assertProjectRoot(paths, operation);
  for (const directory of [paths.rigoriumDir, paths.researchDir, paths.artifactsDir]) {
    const stats = await lstatIfExists(directory, operation);
    if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) {
      throw repositoryError("path_violation", "Artifact repository directories must not be files or symbolic links.", {
        path: directory,
        operation,
      });
    }
  }
}

async function ensureDirectories(paths: ProjectResearchArtifactPaths): Promise<void> {
  await assertProjectRoot(paths, "ensure_directories");
  for (const directory of [paths.rigoriumDir, paths.researchDir, paths.artifactsDir]) {
    try {
      await mkdir(directory);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw asIoError(error, directory, "ensure_directories");
    }
    const stats = await lstatIfExists(directory, "ensure_directories");
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw repositoryError("path_violation", "Artifact repository directories must be regular project-local directories.", {
        path: directory,
        operation: "ensure_directories",
      });
    }
  }
}

async function assertProjectRoot(paths: ProjectResearchArtifactPaths, operation: string): Promise<void> {
  const root = await lstatIfExists(paths.projectRoot, operation);
  if (!root || !root.isDirectory() || root.isSymbolicLink()) {
    throw repositoryError("invalid_project_root", "projectRoot must be an existing regular directory.", {
      path: paths.projectRoot,
      operation,
    });
  }
}

function assertWithinProject(projectRoot: string, candidate: string): void {
  const relation = relative(projectRoot, candidate);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) return;
  throw repositoryError("path_violation", "Artifact repository path escapes the project root.", {
    path: candidate,
    operation: "resolve_paths",
  });
}

function assertTransactionTime(
  manifest: ResearchArtifactRepositoryManifest,
  now: string,
  path: string,
): void {
  if (Date.parse(now) < Date.parse(manifest.updatedAt)) {
    throw repositoryError("revision_conflict", "Transaction time predates the repository's latest committed update.", {
      path,
      operation: "validate_transaction_time",
    });
  }
}

function normalizeExpectedRevision(value: number | undefined, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw repositoryError("invalid_input", "expectedRepositoryRevision must be a non-negative integer.", {
      path,
      operation: "validate_expected_revision",
    });
  }
  return value;
}

function assertExpectedRevision(
  actual: number,
  expected: number | undefined,
  path: string,
  operation: string,
): void {
  if (expected !== undefined && expected !== actual) {
    throw repositoryError("revision_conflict", `Expected repository revision ${expected}, found ${actual}.`, {
      path,
      operation,
    });
  }
}

function normalizeRef(value: unknown, label: string, path: string): ResearchArtifactRef {
  const ref = expectRecord(value, label, path);
  if (!ARTIFACT_KINDS.has(String(ref.kind))) invalidSchema(path, `${label}.kind is unsupported.`);
  return Object.freeze({
    artifactId: requireIdentifier(ref.artifactId, `${label}.artifactId`, path),
    revision: requirePositiveInteger(ref.revision, `${label}.revision`, path),
    kind: ref.kind as ResearchArtifactKind,
    contentHash: requireHash(ref.contentHash, `${label}.contentHash`, path),
  });
}

function uniqueRefs(refs: readonly ResearchArtifactRef[]): ResearchArtifactRef[] {
  const byKey = new Map<string, ResearchArtifactRef>();
  for (const ref of refs) byKey.set(fullRefKey(ref), ref);
  return [...byKey.values()].sort(compareRefs);
}

function fullRefKey(ref: ResearchArtifactRef): string {
  return `${ref.kind}:${ref.artifactId}@${ref.revision}:${ref.contentHash}`;
}

function compareRefs(left: ResearchArtifactRef, right: ResearchArtifactRef): number {
  return compareText(fullRefKey(left), fullRefKey(right));
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function cloneCanonical(value: unknown, path: string): unknown {
  try {
    return JSON.parse(canonicalJson(value)) as unknown;
  } catch (error) {
    invalidSchema(path, `Value is not canonical JSON: ${messageOf(error)}.`);
  }
}

function assertCanonicalShape(value: unknown, normalized: unknown, path: string, message: string): void {
  try {
    if (canonicalJson(value) !== canonicalJson(normalized)) invalidSchema(path, message);
  } catch (error) {
    if (error instanceof ResearchArtifactRepositoryError) throw error;
    invalidSchema(path, `${message} ${messageOf(error)}`);
  }
}

function expectRecord(value: unknown, label: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidSchema(path, `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireIdentifier(value: unknown, label: string, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    invalidSchema(path, `${label} must be a safe identifier.`);
  }
  return value as string;
}

function requirePositiveInteger(value: unknown, label: string, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalidSchema(path, `${label} must be a positive integer.`);
  return value as number;
}

function requireDate(value: unknown, label: string, path: string): string {
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(timestamp)) invalidSchema(path, `${label} must be a valid date.`);
  return new Date(timestamp).toISOString();
}

function requireHash(value: unknown, label: string, path: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    invalidSchema(path, `${label} must be a SHA-256 hash.`);
  }
  return value as string;
}

function requireStatus(value: unknown, label: string, path: string): ResearchArtifactStatus {
  if (typeof value !== "string" || !ARTIFACT_STATUSES.has(value)) invalidSchema(path, `${label} is invalid.`);
  return value as ResearchArtifactStatus;
}

function requireInvalidationReason(
  value: unknown,
  label: string,
  path: string,
): ResearchArtifactInvalidation["reason"] {
  if (typeof value !== "string" || !INVALIDATION_REASONS.has(value)) invalidSchema(path, `${label} is invalid.`);
  return value as ResearchArtifactInvalidation["reason"];
}

function invalidSchema(path: string, message: string): never {
  throw repositoryError("invalid_schema", message, { path, operation: "validate_schema" });
}

async function lstatIfExists(path: string, operation: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw asIoError(error, path, operation);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function asIoError(error: unknown, path: string, operation: string): ResearchArtifactRepositoryError {
  if (error instanceof ResearchArtifactRepositoryError) return error;
  return repositoryError("io_error", `${operation} failed: ${messageOf(error)}`, { path, operation });
}

function repositoryError(
  code: ResearchArtifactRepositoryErrorCode,
  message: string,
  context: Omit<ResearchArtifactRepositoryDiagnostic, "code" | "message"> = {},
): ResearchArtifactRepositoryError {
  return new ResearchArtifactRepositoryError(code, message, context);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}
