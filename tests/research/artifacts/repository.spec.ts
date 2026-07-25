import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createResearchArtifact,
  hashResearchArtifactContent,
  toResearchArtifactRef,
  type ResearchArtifactEnvelope,
  type ResearchArtifactKind,
  type ResearchArtifactParent,
  type ResearchArtifactSource,
} from "../../../src/research/artifacts/types.js";
import {
  ResearchArtifactRepositoryError,
  appendProjectResearchArtifact,
  appendProjectResearchArtifacts,
  getLatestProjectResearchArtifact,
  getProjectResearchArtifactHistory,
  getProjectResearchArtifactPaths,
  invalidateProjectResearchArtifactDescendants,
  listLatestProjectResearchArtifacts,
  loadProjectResearchArtifactRepository,
} from "../../../src/research/artifacts/repository.js";

const T0 = new Date("2026-07-25T12:00:00.000Z");
const T1 = new Date("2026-07-25T12:01:00.000Z");
const T2 = new Date("2026-07-25T12:02:00.000Z");

test("repository persists append-only artifacts, restarts cleanly, and isolates Projects", async () => {
  const left = await projectRoot("basic-left");
  const right = await projectRoot("basic-right");
  const source: ResearchArtifactSource = {
    sourceId: "crossref",
    recordId: "10.1000/example",
    locator: "page:4",
    retrievedAt: T0.toISOString(),
    contentHash: hashResearchArtifactContent({ title: "Source record" }),
  };
  const evidence = artifact("evidence_pack", "evidence-basic", 1, [], {
    claim: "Measured result",
  }, [source]);

  assert.equal(await loadProjectResearchArtifactRepository({ projectRoot: left }), undefined);
  const first = await appendProjectResearchArtifact({ projectRoot: left, artifact: evidence, now: T0 });
  assert.equal(first.persisted, true);
  assert.equal(first.snapshot.revision, 1);
  assert.deepEqual(first.appendedRefs, [toResearchArtifactRef(evidence)]);

  const retry = await appendProjectResearchArtifact({ projectRoot: left, artifact: evidence, now: T0 });
  assert.equal(retry.persisted, false);
  assert.equal(retry.snapshot.revision, 1);
  assert.deepEqual(retry.idempotentRefs, [toResearchArtifactRef(evidence)]);

  const later = artifact("candidate_portfolio", "later-independent", 1, [], { value: "later" }, [], T1);
  await appendProjectResearchArtifact({ projectRoot: left, artifact: later, now: T1 });
  const lateRetry = await appendProjectResearchArtifact({ projectRoot: left, artifact: evidence, now: T0 });
  assert.equal(lateRetry.persisted, false);
  assert.equal(lateRetry.snapshot.revision, 2);

  const restarted = await loadProjectResearchArtifactRepository({ projectRoot: left });
  assert.equal(restarted?.repositoryId, first.snapshot.repositoryId);
  assert.equal(restarted?.artifacts.length, 2);
  assert.deepEqual(restarted?.artifacts[0]?.sources, [source]);
  assert.deepEqual(await getProjectResearchArtifactHistory({ projectRoot: left, artifactId: evidence.artifactId }), [evidence]);
  assert.equal((await getLatestProjectResearchArtifact({
    projectRoot: left,
    artifactId: evidence.artifactId,
  }))?.contentHash, evidence.contentHash);

  const paths = getProjectResearchArtifactPaths({ projectRoot: left });
  await writeFile(join(paths.artifactsDir, ".manifest.abandoned-probe.tmp"), "uncommitted", "utf8");
  assert.equal((await loadProjectResearchArtifactRepository({ projectRoot: left }))?.artifacts.length, 2);
  assert.equal(await loadProjectResearchArtifactRepository({ projectRoot: right }), undefined);
});

test("repository persists through a Windows Unicode project path", async () => {
  const unicodeLabel = String.fromCodePoint(0x9879, 0x76ee, 0x7a7a, 0x95f4);
  const root = await mkdtemp(join(tmpdir(), `rigorium-artifact-${unicodeLabel}-`));
  const evidence = artifact("evidence_pack", "unicode-project-evidence");
  const written = await appendProjectResearchArtifact({ projectRoot: root, artifact: evidence, now: T0 });
  const paths = getProjectResearchArtifactPaths({ projectRoot: root });

  assert.equal(written.path, paths.manifestPath);
  assert.equal((await loadProjectResearchArtifactRepository({ projectRoot: root }))?.artifacts[0]?.artifactId, evidence.artifactId);
});

test("repository rejects hash drift, missing parents, revision gaps, and immutable-envelope conflicts", async () => {
  const hashRoot = await projectRoot("invalid-hash");
  const valid = artifact("evidence_pack", "evidence-hash", 1, [], { value: 1 });
  const tampered = { ...valid, payload: { value: 2 } } as ResearchArtifactEnvelope;
  await assertRepositoryError(
    appendProjectResearchArtifact({ projectRoot: hashRoot, artifact: tampered, now: T0 }),
    "integrity_mismatch",
  );

  const parentRoot = await projectRoot("missing-parent");
  const absentParent = artifact("evidence_pack", "absent-parent");
  const orphan = artifact("research_brief", "orphan", 1, [{
    relation: "uses",
    artifact: toResearchArtifactRef(absentParent),
  }]);
  await assertRepositoryError(
    appendProjectResearchArtifact({ projectRoot: parentRoot, artifact: orphan, now: T0 }),
    "missing_parent",
  );

  const revisionRoot = await projectRoot("revision-gap");
  const revisionTwo = artifact("evidence_pack", "gap", 2);
  await assertRepositoryError(
    appendProjectResearchArtifact({ projectRoot: revisionRoot, artifact: revisionTwo, now: T0 }),
    "revision_conflict",
  );

  const conflictRoot = await projectRoot("immutable-conflict");
  await appendProjectResearchArtifact({ projectRoot: conflictRoot, artifact: valid, now: T0 });
  const conflictingProducer = {
    ...valid,
    producer: { kind: "user" as const, id: "different-producer" },
  };
  await assertRepositoryError(
    appendProjectResearchArtifact({ projectRoot: conflictRoot, artifact: conflictingProducer, now: T1 }),
    "artifact_conflict",
  );

  const futureRoot = await projectRoot("future-artifact");
  const future = artifact("evidence_pack", "future", 1, [], { value: 1 }, [], T2);
  await assertRepositoryError(
    appendProjectResearchArtifact({ projectRoot: futureRoot, artifact: future, now: T1 }),
    "revision_conflict",
  );

  const invalidationRoot = await projectRoot("embedded-invalidation");
  const missingRoot = artifact("evidence_pack", "missing-invalidation-root");
  const staleBase = artifact("research_brief", "stale-import");
  const staleImport = {
    ...staleBase,
    status: "stale" as const,
    updatedAt: T1.toISOString(),
    invalidation: {
      invalidatedAt: T1.toISOString(),
      reason: "manual" as const,
      roots: [toResearchArtifactRef(missingRoot)],
    },
  };
  await assertRepositoryError(
    appendProjectResearchArtifact({ projectRoot: invalidationRoot, artifact: staleImport, now: T1 }),
    "missing_parent",
  );

  const emptyInvalidationRoot = await projectRoot("empty-invalidation");
  const emptyInvalidation = {
    ...staleBase,
    status: "stale" as const,
    updatedAt: T1.toISOString(),
    invalidation: {
      invalidatedAt: T1.toISOString(),
      reason: "manual" as const,
      roots: [],
    },
  };
  await assertRepositoryError(
    appendProjectResearchArtifact({ projectRoot: emptyInvalidationRoot, artifact: emptyInvalidation, now: T1 }),
    "invalid_schema",
  );

  const unrelatedInvalidationRoot = await projectRoot("unrelated-invalidation-root");
  const validButUnrelatedRoot = artifact("evidence_pack", "valid-but-unrelated-root");
  const unrelatedInvalidation = {
    ...staleBase,
    status: "stale" as const,
    updatedAt: T1.toISOString(),
    invalidation: {
      invalidatedAt: T1.toISOString(),
      reason: "manual" as const,
      roots: [toResearchArtifactRef(validButUnrelatedRoot)],
    },
  };
  await assertRepositoryError(
    appendProjectResearchArtifacts({
      projectRoot: unrelatedInvalidationRoot,
      artifacts: [validButUnrelatedRoot, unrelatedInvalidation],
      now: T1,
    }),
    "invalid_schema",
  );
});

test("new upstream revision stales only precise descendants and a new derived revision recovers independently", async () => {
  const root = await projectRoot("precise-invalidation");
  const evidenceV1 = artifact("evidence_pack", "evidence-versioned", 1, [], { value: 1 }, [{
    sourceId: "dataset",
    recordId: "dataset-v1",
  }]);
  const briefV1 = artifact("research_brief", "brief-versioned", 1, [{
    relation: "uses",
    artifact: toResearchArtifactRef(evidenceV1),
  }], { conclusion: "Based on v1" });
  const methodV1 = artifact("method_spec", "method-versioned", 1, [{
    relation: "derived_from",
    artifact: toResearchArtifactRef(briefV1),
  }]);
  const unrelated = artifact("candidate_portfolio", "unrelated-active");
  const unrelatedChild = artifact("challenge_report", "unrelated-child", 1, [{
    relation: "uses",
    artifact: toResearchArtifactRef(unrelated),
  }]);
  await appendProjectResearchArtifacts({
    projectRoot: root,
    artifacts: [evidenceV1, briefV1, methodV1, unrelated, unrelatedChild],
    now: T0,
  });

  const evidenceV2 = artifact("evidence_pack", "evidence-versioned", 2, [], { value: 2 }, [{
    sourceId: "dataset",
    recordId: "dataset-v2",
  }], T1);
  const updated = await appendProjectResearchArtifact({ projectRoot: root, artifact: evidenceV2, now: T1 });
  assert.deepEqual(updated.supersededRefs, [toResearchArtifactRef(evidenceV1)]);
  assert.deepEqual(updated.staleRefs.map((ref) => ref.artifactId).sort(), ["brief-versioned", "method-versioned"]);
  assert.equal(status(updated.snapshot.artifacts, evidenceV1), "superseded");
  assert.equal(status(updated.snapshot.artifacts, evidenceV2), "active");
  assert.equal(status(updated.snapshot.artifacts, briefV1), "stale");
  assert.equal(status(updated.snapshot.artifacts, methodV1), "stale");
  assert.equal(status(updated.snapshot.artifacts, unrelated), "active");
  assert.equal(status(updated.snapshot.artifacts, unrelatedChild), "active");

  const paths = getProjectResearchArtifactPaths({ projectRoot: root });
  const raw = JSON.parse(await readFile(paths.manifestPath, "utf8")) as {
    artifacts: ResearchArtifactEnvelope[];
    statusEvents: { to: string }[];
  };
  assert.equal(raw.artifacts.find((entry) => entry.artifactId === evidenceV1.artifactId && entry.revision === 1)?.status, "active");
  assert.equal(raw.artifacts.find((entry) => entry.artifactId === briefV1.artifactId)?.status, "active");
  assert.deepEqual(raw.statusEvents.map((event) => event.to).sort(), ["stale", "stale", "superseded"]);

  const briefV2 = artifact("research_brief", "brief-versioned", 2, [{
    relation: "uses",
    artifact: toResearchArtifactRef(evidenceV2),
  }], { conclusion: "Recovered on v2" }, [], T2);
  const recovered = await appendProjectResearchArtifact({ projectRoot: root, artifact: briefV2, now: T2 });
  assert.equal(status(recovered.snapshot.artifacts, briefV1), "superseded");
  assert.equal(status(recovered.snapshot.artifacts, briefV2), "active");
  assert.equal(status(recovered.snapshot.artifacts, methodV1), "stale");
  const history = await getProjectResearchArtifactHistory({ projectRoot: root, artifactId: briefV1.artifactId });
  assert.deepEqual(history.map((entry) => [entry.revision, entry.status]), [[1, "superseded"], [2, "active"]]);
});

test("new descendants of non-active ancestors are immediately materialized as stale", async () => {
  const root = await projectRoot("inherited-stale");
  const evidenceV1 = artifact("evidence_pack", "inherited-evidence", 1, [], { value: 1 });
  const briefV1 = artifact("research_brief", "inherited-brief", 1, [{
    relation: "uses",
    artifact: toResearchArtifactRef(evidenceV1),
  }]);
  await appendProjectResearchArtifacts({ projectRoot: root, artifacts: [evidenceV1, briefV1], now: T0 });

  const evidenceV2 = artifact("evidence_pack", "inherited-evidence", 2, [], { value: 2 }, [], T1);
  await appendProjectResearchArtifact({ projectRoot: root, artifact: evidenceV2, now: T1 });
  const lateDescendant = artifact("method_spec", "inherited-late-method", 1, [{
    relation: "derived_from",
    artifact: toResearchArtifactRef(briefV1),
  }], { value: "depends on stale brief" }, [], T2);
  const appended = await appendProjectResearchArtifact({ projectRoot: root, artifact: lateDescendant, now: T2 });

  assert.deepEqual(appended.staleRefs, [toResearchArtifactRef(lateDescendant)]);
  assert.equal(status(appended.snapshot.artifacts, lateDescendant), "stale");
  assert.equal(status((await loadProjectResearchArtifactRepository({ projectRoot: root }))?.artifacts ?? [], lateDescendant), "stale");
});

test("manual invalidation is precise and idempotent", async () => {
  const root = await projectRoot("manual-invalidation");
  const source = artifact("evidence_pack", "manual-root");
  const child = artifact("research_brief", "manual-child", 1, [{
    relation: "uses",
    artifact: toResearchArtifactRef(source),
  }]);
  const grandchild = artifact("method_spec", "manual-grandchild", 1, [{
    relation: "derived_from",
    artifact: toResearchArtifactRef(child),
  }]);
  const unrelated = artifact("decision_record", "manual-unrelated");
  await appendProjectResearchArtifacts({ projectRoot: root, artifacts: [source, child, grandchild, unrelated], now: T0 });

  const invalidated = await invalidateProjectResearchArtifactDescendants({
    projectRoot: root,
    roots: [toResearchArtifactRef(source)],
    reason: "manual",
    now: T1,
  });
  assert.equal(invalidated.persisted, true);
  assert.deepEqual(invalidated.staleRefs.map((ref) => ref.artifactId).sort(), ["manual-child", "manual-grandchild"]);
  assert.equal(status(invalidated.snapshot.artifacts, source), "active");
  assert.equal(status(invalidated.snapshot.artifacts, unrelated), "active");
  const revision = invalidated.snapshot.revision;

  const retry = await invalidateProjectResearchArtifactDescendants({
    projectRoot: root,
    roots: [toResearchArtifactRef(source)],
    reason: "manual",
    now: T2,
  });
  assert.equal(retry.persisted, false);
  assert.equal(retry.snapshot.revision, revision);
  assert.deepEqual(retry.staleRefs, []);
});

test("concurrent transactions serialize atomically and optimistic revision checks fail closed", async () => {
  const root = await projectRoot("concurrent");
  const left = artifact("evidence_pack", "concurrent-left");
  const right = artifact("candidate_portfolio", "concurrent-right");
  await Promise.all([
    appendProjectResearchArtifact({ projectRoot: root, artifact: left, now: T0 }),
    appendProjectResearchArtifact({ projectRoot: root, artifact: right, now: T0 }),
  ]);
  const snapshot = await loadProjectResearchArtifactRepository({ projectRoot: root });
  assert.equal(snapshot?.revision, 2);
  assert.deepEqual(snapshot?.artifacts.map((entry) => entry.artifactId).sort(), ["concurrent-left", "concurrent-right"]);

  const third = artifact("challenge_report", "concurrent-third");
  await assertRepositoryError(appendProjectResearchArtifact({
    projectRoot: root,
    artifact: third,
    expectedRepositoryRevision: 1,
    now: T1,
  }), "revision_conflict");
});

test("repository detects corrupt JSON, manifest drift, and Artifact drift after restart", async () => {
  const jsonRoot = await projectRoot("corrupt-json");
  const jsonArtifact = artifact("evidence_pack", "json-artifact");
  await appendProjectResearchArtifact({ projectRoot: jsonRoot, artifact: jsonArtifact, now: T0 });
  const jsonPaths = getProjectResearchArtifactPaths({ projectRoot: jsonRoot });
  await writeFile(jsonPaths.manifestPath, "{not-json\n", "utf8");
  await assertRepositoryError(loadProjectResearchArtifactRepository({ projectRoot: jsonRoot }), "corrupt_json");

  const manifestRoot = await projectRoot("manifest-drift");
  const manifestArtifact = artifact("evidence_pack", "manifest-artifact");
  await appendProjectResearchArtifact({ projectRoot: manifestRoot, artifact: manifestArtifact, now: T0 });
  const manifestPaths = getProjectResearchArtifactPaths({ projectRoot: manifestRoot });
  const manifest = JSON.parse(await readFile(manifestPaths.manifestPath, "utf8")) as Record<string, unknown>;
  manifest.updatedAt = T1.toISOString();
  await writeFile(manifestPaths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await assertRepositoryError(loadProjectResearchArtifactRepository({ projectRoot: manifestRoot }), "integrity_mismatch");

  const shapeRoot = await projectRoot("manifest-shape");
  const shapeArtifact = artifact("evidence_pack", "shape-artifact");
  await appendProjectResearchArtifact({ projectRoot: shapeRoot, artifact: shapeArtifact, now: T0 });
  const shapePaths = getProjectResearchArtifactPaths({ projectRoot: shapeRoot });
  const shapeManifest = JSON.parse(await readFile(shapePaths.manifestPath, "utf8")) as Record<string, unknown>;
  shapeManifest.unexpected = "not covered by schema version 1";
  await writeFile(shapePaths.manifestPath, `${JSON.stringify(shapeManifest, null, 2)}\n`, "utf8");
  await assertRepositoryError(loadProjectResearchArtifactRepository({ projectRoot: shapeRoot }), "invalid_schema");

  const artifactRoot = await projectRoot("artifact-drift");
  const driftArtifact = artifact("evidence_pack", "drift-artifact", 1, [], { value: 1 });
  await appendProjectResearchArtifact({ projectRoot: artifactRoot, artifact: driftArtifact, now: T0 });
  const artifactPaths = getProjectResearchArtifactPaths({ projectRoot: artifactRoot });
  const driftManifest = JSON.parse(await readFile(artifactPaths.manifestPath, "utf8")) as {
    contentHash: string;
    artifacts: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  driftManifest.artifacts[0]!.payload = { value: 999 };
  const { contentHash: _oldHash, ...body } = driftManifest;
  driftManifest.contentHash = hashResearchArtifactContent(body);
  await writeFile(artifactPaths.manifestPath, `${JSON.stringify(driftManifest, null, 2)}\n`, "utf8");
  await assertRepositoryError(loadProjectResearchArtifactRepository({ projectRoot: artifactRoot }), "integrity_mismatch");
});

test("repository rejects status-event identity drift and unrelated invalidation roots after restart", async () => {
  const root = await projectRoot("status-event-integrity");
  const source = artifact("evidence_pack", "status-event-source");
  const child = artifact("research_brief", "status-event-child", 1, [{
    relation: "uses",
    artifact: toResearchArtifactRef(source),
  }]);
  const unrelated = artifact("candidate_portfolio", "status-event-unrelated");
  await appendProjectResearchArtifacts({ projectRoot: root, artifacts: [source, child, unrelated], now: T0 });
  await invalidateProjectResearchArtifactDescendants({
    projectRoot: root,
    roots: [toResearchArtifactRef(source)],
    reason: "manual",
    now: T1,
  });

  const paths = getProjectResearchArtifactPaths({ projectRoot: root });
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8")) as {
    contentHash: string;
    statusEvents: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  const event = manifest.statusEvents[0]!;
  event.roots = [toResearchArtifactRef(unrelated)];
  resealManifest(manifest);
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await assertRepositoryError(loadProjectResearchArtifactRepository({ projectRoot: root }), "integrity_mismatch");

  event.eventId = statusEventIdForTest(event);
  resealManifest(manifest);
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await assertRepositoryError(loadProjectResearchArtifactRepository({ projectRoot: root }), "invalid_schema");
});

test("latest query filters materialized kind and status without stage fields", async () => {
  const root = await projectRoot("latest-query");
  const evidence = artifact("evidence_pack", "latest-evidence");
  const brief = artifact("research_brief", "latest-brief", 1, [{
    relation: "uses",
    artifact: toResearchArtifactRef(evidence),
  }]);
  await appendProjectResearchArtifacts({ projectRoot: root, artifacts: [evidence, brief], now: T0 });
  await invalidateProjectResearchArtifactDescendants({
    projectRoot: root,
    roots: [toResearchArtifactRef(evidence)],
    reason: "evidence_withdrawn",
    now: T1,
  });
  const stale = await listLatestProjectResearchArtifacts({ projectRoot: root, status: "stale" });
  assert.deepEqual(stale.map((entry) => entry.artifactId), ["latest-brief"]);
  const evidenceOnly = await listLatestProjectResearchArtifacts({ projectRoot: root, kind: "evidence_pack" });
  assert.deepEqual(evidenceOnly.map((entry) => entry.artifactId), ["latest-evidence"]);
  const snapshot = await loadProjectResearchArtifactRepository({ projectRoot: root });
  assert.equal(hasForbiddenStageKey(snapshot), false);
});

async function projectRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `rigorium-artifact-${label}-`));
}

function artifact<TKind extends ResearchArtifactKind>(
  kind: TKind,
  artifactId: string,
  revision = 1,
  parents: readonly ResearchArtifactParent[] = [],
  payload: unknown = { kind },
  sources: readonly ResearchArtifactSource[] = [],
  now = T0,
): ResearchArtifactEnvelope<TKind, unknown> {
  return createResearchArtifact({
    kind,
    artifactId,
    revision,
    parents,
    sources,
    payload,
    producer: { kind: "tool", toolName: "repository_fixture" },
    now,
  });
}

function status(
  artifacts: readonly ResearchArtifactEnvelope[],
  target: ResearchArtifactEnvelope,
): ResearchArtifactEnvelope["status"] | undefined {
  return artifacts.find((entry) => entry.artifactId === target.artifactId && entry.revision === target.revision)?.status;
}

async function assertRepositoryError(
  promise: Promise<unknown>,
  code: ResearchArtifactRepositoryError["code"],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(error instanceof ResearchArtifactRepositoryError, true);
    assert.equal((error as ResearchArtifactRepositoryError).code, code);
    return true;
  });
}

function resealManifest(manifest: Record<string, unknown>): void {
  const { contentHash: _previousHash, ...body } = manifest;
  manifest.contentHash = hashResearchArtifactContent(body);
}

function statusEventIdForTest(event: Record<string, unknown>): string {
  const { eventId: _previousId, ...body } = event;
  const sequence = body.sequence;
  assert.equal(typeof sequence, "number");
  return `artifact-status-${sequence}-${hashResearchArtifactContent(body).slice("sha256:".length, 23)}`;
}

function hasForbiddenStageKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenStageKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) =>
    key === "currentStage" || key === "nextStageId" || hasForbiddenStageKey(entry));
}
