import assert from "node:assert/strict";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import {
  LITERATURE_MAP_REPOSITORY_SCHEMA_VERSION,
  MAX_LITERATURE_MAP_EDGES,
  MAX_LITERATURE_MAP_FILE_BYTES,
  MAX_LITERATURE_MAP_NODES,
  LiteratureMapRepositoryError,
  freezeProjectLiveLiteratureMap,
  getProjectLiteratureMapPaths,
  getProjectLiteratureMapSnapshotPath,
  loadProjectLiteratureMapSnapshot,
  loadProjectLiveLiteratureMap,
  setProjectLiveLiteratureMapNodeState,
  updateProjectLiveLiteratureMap,
} from "../../src/research/literature/mapRepository.js";
import type { ResearchPaper, ResearchRelationEdge } from "../../src/research/types.js";

const firstTime = new Date("2026-07-23T00:00:00.000Z");
const secondTime = new Date("2026-07-23T01:00:00.000Z");

function paper(id: string, doi?: string): ResearchPaper {
  return {
    id,
    identity: doi ? { doi } : {},
    title: `Paper ${id}`,
    authors: ["Ada Lovelace"],
    year: 2025,
    ...(doi ? { doi } : {}),
    citedByCount: 0,
    topics: [],
    referencedWorkIds: [],
    sourceId: "openalex",
    sourceIds: ["openalex"],
    provenance: [{
      sourceId: "openalex",
      sourceRecordId: id,
      rank: 1,
      retrievedAt: firstTime.toISOString(),
    }],
  };
}

function citation(source: string, target: string): ResearchRelationEdge {
  return {
    id: `upstream:${source}:${target}`,
    source,
    target,
    type: "citation",
    weight: 1,
    inferred: false,
  };
}

async function projectRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `rigorium-map-repository-${label}-`));
}

async function expectRepositoryError(action: Promise<unknown>, code: LiteratureMapRepositoryError["code"]): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof LiteratureMapRepositoryError);
    assert.equal(error.code, code);
    assert.equal(error.diagnostic.code, code);
    return true;
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

test("project live maps are isolated beneath each project's .pilotdeck research directory", async () => {
  const firstProject = await projectRoot("first");
  const secondProject = await projectRoot("second");

  const first = await updateProjectLiveLiteratureMap({
    projectRoot: firstProject,
    mapId: "map-first",
    update: { origin: "search", papers: [paper("first-paper", "10.1000/first")] },
    now: firstTime,
  });
  const second = await updateProjectLiveLiteratureMap({
    projectRoot: secondProject,
    mapId: "map-second",
    update: { origin: "search", papers: [paper("second-paper", "10.1000/second")] },
    now: firstTime,
  });

  const firstPaths = getProjectLiteratureMapPaths({ projectRoot: firstProject });
  const secondPaths = getProjectLiteratureMapPaths({ projectRoot: secondProject });
  assert.notEqual(first.path, second.path);
  assert.equal(first.path, firstPaths.liveMapPath);
  assert.equal(second.path, secondPaths.liveMapPath);
  assert.match(first.path, /\.pilotdeck[\\/]research[\\/]live-map\.json$/u);
  assert.match(second.path, /\.pilotdeck[\\/]research[\\/]live-map\.json$/u);

  const loadedFirst = await loadProjectLiveLiteratureMap({ projectRoot: firstProject });
  const loadedSecond = await loadProjectLiveLiteratureMap({ projectRoot: secondProject });
  assert.equal(loadedFirst?.map.mapId, "map-first");
  assert.deepEqual(loadedFirst?.map.nodes.map((node) => node.id), ["first-paper"]);
  assert.equal(loadedSecond?.map.mapId, "map-second");
  assert.deepEqual(loadedSecond?.map.nodes.map((node) => node.id), ["second-paper"]);
});

test("incremental replay is idempotent and retains the last persisted diff and revision", async () => {
  const root = await projectRoot("idempotent");
  const firstPaper = paper("paper-1", "10.1000/one");
  const secondPaper = paper("paper-2", "10.1000/two");
  const update = {
    origin: "search" as const,
    papers: [firstPaper, secondPaper],
    edges: [citation(firstPaper.id, secondPaper.id)],
  };

  const initial = await updateProjectLiveLiteratureMap({
    projectRoot: root,
    mapId: "map-idempotent",
    update,
    now: firstTime,
  });
  const before = await readFile(initial.path, "utf8");
  const replay = await updateProjectLiveLiteratureMap({
    projectRoot: root,
    mapId: "map-idempotent",
    update,
    now: secondTime,
  });

  assert.equal(initial.created, true);
  assert.equal(initial.persisted, true);
  assert.equal(replay.created, false);
  assert.equal(replay.persisted, false);
  assert.equal(replay.map.revision, initial.map.revision);
  assert.equal(replay.diff.fromRevision, initial.map.revision);
  assert.equal(replay.diff.toRevision, initial.map.revision);
  assert.deepEqual(replay.diff.nodes.added, []);
  assert.deepEqual(replay.diff.edges.added, []);
  assert.equal(await readFile(initial.path, "utf8"), before);

  const loaded = await loadProjectLiveLiteratureMap({ projectRoot: root });
  assert.equal(loaded?.map.revision, initial.map.revision);
  assert.deepEqual(loaded?.lastDiff, initial.diff);
});

test("freezing requires explicit confirmation and never overwrites a confirmed snapshot", async () => {
  const root = await projectRoot("confirmation");
  const live = await updateProjectLiveLiteratureMap({
    projectRoot: root,
    mapId: "map-confirmation",
    update: { origin: "search", papers: [paper("paper-1")] },
    now: firstTime,
  });
  const paths = getProjectLiteratureMapPaths({ projectRoot: root });
  const expectedSnapshotPath = getProjectLiteratureMapSnapshotPath({ projectRoot: root, snapshotId: "reviewed-v1" });

  await expectRepositoryError(
    freezeProjectLiveLiteratureMap({
      projectRoot: root,
      snapshotId: "reviewed-v1",
      confirmed: false,
      now: secondTime,
    }),
    "snapshot_confirmation_required",
  );
  assert.equal(await exists(paths.snapshotsDir), false);
  assert.equal(await loadProjectLiteratureMapSnapshot({ projectRoot: root, snapshotId: "reviewed-v1" }), undefined);

  const frozen = await freezeProjectLiveLiteratureMap({
    projectRoot: root,
    snapshotId: "reviewed-v1",
    confirmed: true,
    now: secondTime,
  });
  assert.equal(frozen.path, expectedSnapshotPath);
  assert.equal(frozen.snapshot.sourceMapId, live.map.mapId);
  assert.equal(frozen.snapshot.sourceRevision, live.map.revision);
  const snapshotBeforeRetry = await readFile(frozen.path, "utf8");
  assert.match(snapshotBeforeRetry, /"confirmed": true/u);

  await expectRepositoryError(
    freezeProjectLiveLiteratureMap({
      projectRoot: root,
      snapshotId: "reviewed-v1",
      confirmed: true,
      now: new Date("2026-07-23T02:00:00.000Z"),
    }),
    "snapshot_exists",
  );
  assert.equal(await readFile(frozen.path, "utf8"), snapshotBeforeRetry);
});

test("snapshot IDs cannot escape the project boundary", async () => {
  const root = await projectRoot("path-boundary");
  const paths = getProjectLiteratureMapPaths({ projectRoot: root });

  await expectRepositoryError(
    freezeProjectLiveLiteratureMap({
      projectRoot: root,
      snapshotId: "../outside",
      confirmed: true,
      now: firstTime,
    }),
    "path_violation",
  );
  assert.equal(await exists(paths.pilotDeckDir), false);
});

test("corrupt, oversized, and over-limit map files return diagnostic errors without reset", async () => {
  const root = await projectRoot("validation");
  const live = await updateProjectLiveLiteratureMap({
    projectRoot: root,
    mapId: "map-validation",
    update: { origin: "search", papers: [paper("paper-1")] },
    now: firstTime,
  });

  await writeFile(live.path, "{not valid json", "utf8");
  await expectRepositoryError(loadProjectLiveLiteratureMap({ projectRoot: root }), "corrupt_json");
  assert.equal(await readFile(live.path, "utf8"), "{not valid json");

  await writeFile(live.path, Buffer.alloc(MAX_LITERATURE_MAP_FILE_BYTES + 1, 0x20));
  await expectRepositoryError(loadProjectLiveLiteratureMap({ projectRoot: root }), "file_too_large");

  await writeFile(live.path, JSON.stringify(overLimitDocument("nodes")), "utf8");
  await expectRepositoryError(loadProjectLiveLiteratureMap({ projectRoot: root }), "node_limit_exceeded");

  await writeFile(live.path, JSON.stringify(overLimitDocument("edges")), "utf8");
  await expectRepositoryError(loadProjectLiveLiteratureMap({ projectRoot: root }), "edge_limit_exceeded");
});

test("successful writes leave a complete JSON document and no temporary result file", async () => {
  const root = await projectRoot("atomic");
  const first = await updateProjectLiveLiteratureMap({
    projectRoot: root,
    mapId: "map-atomic",
    update: { origin: "search", papers: [paper("paper-1")] },
    now: firstTime,
  });
  const second = await updateProjectLiveLiteratureMap({
    projectRoot: root,
    mapId: "map-atomic",
    expectedRevision: first.map.revision,
    update: { origin: "monitor", papers: [paper("paper-2")] },
    now: secondTime,
  });
  const parsed = JSON.parse(await readFile(second.path, "utf8")) as { map: { revision: number; nodes: unknown[] } };
  const paths = getProjectLiteratureMapPaths({ projectRoot: root });

  assert.equal(second.persisted, true);
  assert.equal(parsed.map.revision, second.map.revision);
  assert.equal(parsed.map.nodes.length, 2);
  assert.equal((await readdir(paths.researchDir)).some((entry) => entry.includes(".tmp")), false);
});

test("persists irrelevant node status and rejects stale revisions without overwriting", async () => {
  const root = await projectRoot("node-state");
  const created = await updateProjectLiveLiteratureMap({
    projectRoot: root,
    mapId: "map-node-state",
    update: { origin: "search", papers: [paper("paper-1")] },
    now: firstTime,
  });
  const changed = await setProjectLiveLiteratureMapNodeState({
    projectRoot: root,
    mapId: "map-node-state",
    paperId: "paper-1",
    expectedRevision: created.map.revision,
    state: { status: "irrelevant" },
    now: secondTime,
  });
  assert.equal(changed.map.nodes[0].status, "irrelevant");
  assert.equal(changed.map.revision, created.map.revision + 1);
  const paths = getProjectLiteratureMapPaths({ projectRoot: root });
  const beforeStale = await readFile(paths.liveMapPath, "utf8");

  await expectRepositoryError(setProjectLiveLiteratureMapNodeState({
    projectRoot: root,
    mapId: "map-node-state",
    paperId: "paper-1",
    expectedRevision: created.map.revision,
    state: { status: "core" },
    now: secondTime,
  }), "revision_conflict");

  assert.equal(await readFile(paths.liveMapPath, "utf8"), beforeStale);
  const reloaded = await loadProjectLiveLiteratureMap({ projectRoot: root });
  assert.equal(reloaded?.map.nodes[0].status, "irrelevant");
});

function overLimitDocument(kind: "nodes" | "edges"): unknown {
  const timestamp = firstTime.toISOString();
  return {
    schemaVersion: LITERATURE_MAP_REPOSITORY_SCHEMA_VERSION,
    kind: "live_literature_map",
    map: {
      schemaVersion: 1,
      kind: "live",
      mapId: "map-over-limit",
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      nodes: kind === "nodes" ? Array.from({ length: MAX_LITERATURE_MAP_NODES + 1 }, () => null) : [],
      edges: kind === "edges" ? Array.from({ length: MAX_LITERATURE_MAP_EDGES + 1 }, () => null) : [],
    },
    lastDiff: {
      fromRevision: 0,
      toRevision: 0,
      nodes: { added: [], updated: [], tombstoned: [], restored: [] },
      edges: { added: [], updated: [], tombstoned: [], restored: [] },
      aliasesAdded: [],
      warnings: [],
    },
  };
}
