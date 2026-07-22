import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveLiteratureMap,
  freezeLiteratureMap,
  setLiteratureMapNodeState,
  updateLiveLiteratureMap,
} from "../../src/research/literature/mapMaintenance.js";
import type { ResearchPaper, ResearchRelationEdge } from "../../src/research/types.js";

const firstTime = new Date("2026-07-23T00:00:00.000Z");
const secondTime = new Date("2026-07-23T01:00:00.000Z");

function paper(input: {
  id: string;
  sourceId?: string;
  doi?: string;
  openAlexId?: string;
  title?: string;
  citedByCount?: number;
  aliases?: Record<string, string>;
}): ResearchPaper {
  const sourceId = input.sourceId ?? "openalex";
  return {
    id: input.id,
    identity: {
      ...(input.openAlexId ? { openAlexId: input.openAlexId } : {}),
      ...(input.doi ? { doi: input.doi } : {}),
      ...(input.aliases ? { other: input.aliases } : {}),
    },
    title: input.title ?? `Paper ${input.id}`,
    authors: ["Ada Lovelace"],
    year: 2025,
    ...(input.doi ? { doi: input.doi } : {}),
    citedByCount: input.citedByCount ?? 0,
    topics: [],
    referencedWorkIds: [],
    sourceId,
    sourceIds: [sourceId],
    provenance: [{
      sourceId,
      sourceRecordId: input.id,
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

test("incremental updates merge aliases and preserve existing layout and classification", () => {
  const first = paper({ id: "https://openalex.org/W1", openAlexId: "https://openalex.org/W1", doi: "10.1000/ABC" });
  const second = paper({ id: "https://openalex.org/W2", openAlexId: "https://openalex.org/W2" });
  const created = createLiveLiteratureMap({
    mapId: "map-1",
    papers: [first, second],
    edges: [citation(first.id, second.id)],
    now: firstTime,
  });
  const classified = setLiteratureMapNodeState(created.map, first.id, {
    status: "core",
    position: { x: 420, y: -75 },
  }, { now: firstTime });
  const duplicate = paper({
    id: "https://doi.org/10.1000/abc",
    sourceId: "crossref",
    doi: "doi:10.1000/abc",
    title: "A richer title supplied by a second metadata provider",
    citedByCount: 12,
  });
  duplicate.venueEvidence = [{
    sourceId: "crossref",
    evidence: "metadata",
    venue: "ICLR",
    status: "unknown",
  }];
  const third = paper({ id: "https://openalex.org/W3", openAlexId: "https://openalex.org/W3" });

  const result = updateLiveLiteratureMap(classified, {
    origin: "monitor",
    papers: [duplicate, third],
    edges: [citation(duplicate.id, third.id)],
  }, { now: secondTime });

  assert.equal(result.map.nodes.length, 3);
  const merged = result.map.nodes.find((node) => node.id === first.id);
  assert.ok(merged);
  assert.equal(merged.status, "core");
  assert.deepEqual(merged.position, { x: 420, y: -75, pinned: true });
  assert.equal(merged.paper.citedByCount, 12);
  assert.deepEqual(merged.paper.venueEvidence, duplicate.venueEvidence);
  assert.deepEqual(merged.paper.sourceIds, ["openalex", "crossref"]);
  assert.ok(merged.aliases.includes(duplicate.id));
  assert.deepEqual(merged.origins, ["search", "monitor"]);
  assert.deepEqual(result.diff.aliasesAdded, [{ alias: duplicate.id, canonicalId: first.id }]);
  assert.equal(result.map.edges.some((edge) => edge.source === first.id && edge.target === third.id), true);
  const added = result.map.nodes.find((node) => node.id === third.id);
  assert.ok(added);
  assert.equal(added.status, "candidate");
  assert.equal(Number.isFinite(added.position.x) && Number.isFinite(added.position.y), true);
});

test("partial refreshes never delete records and tombstones require an explicit operation", () => {
  const first = paper({ id: "paper-1", doi: "10.1000/one" });
  const second = paper({ id: "paper-2", doi: "10.1000/two" });
  const created = createLiveLiteratureMap({
    mapId: "map-2",
    papers: [first, second],
    edges: [citation(first.id, second.id)],
    now: firstTime,
  });

  const partial = updateLiveLiteratureMap(created.map, {
    origin: "search",
    papers: [first],
    edges: [],
  }, { now: secondTime });
  assert.equal(partial.map.nodes.length, 2);
  assert.equal(partial.map.nodes.every((node) => !node.tombstone), true);

  const removed = updateLiveLiteratureMap(partial.map, {
    origin: "zotero",
    tombstonePaperIds: ["https://doi.org/10.1000/two"],
  }, { now: secondTime });
  assert.deepEqual(removed.diff.nodes.tombstoned, [second.id]);
  assert.equal(removed.map.nodes.find((node) => node.id === second.id)?.tombstone, true);
  assert.equal(removed.map.edges[0]?.tombstone, true);

  const rediscovered = updateLiveLiteratureMap(removed.map, {
    origin: "monitor",
    papers: [second],
  }, { now: secondTime });
  assert.equal(rediscovered.map.nodes.find((node) => node.id === second.id)?.tombstone, true);
  assert.deepEqual(rediscovered.diff.nodes.restored, []);

  const restored = updateLiveLiteratureMap(rediscovered.map, {
    origin: "zotero",
    restorePaperIds: [second.id],
  }, { now: new Date("2026-07-23T02:00:00.000Z") });
  assert.deepEqual(restored.diff.nodes.restored, [second.id]);
  assert.deepEqual(restored.diff.edges.restored, [restored.map.edges[0]?.id]);
  assert.equal(restored.map.edges[0]?.tombstone, false);
});

test("identical updates are idempotent and do not advance the live revision", () => {
  const first = paper({ id: "paper-1", doi: "10.1000/one" });
  const second = paper({ id: "paper-2", doi: "10.1000/two" });
  const edge = citation(first.id, second.id);
  const created = createLiveLiteratureMap({ mapId: "map-3", papers: [first, second], edges: [edge], now: firstTime });
  const replay = updateLiveLiteratureMap(created.map, {
    origin: "search",
    papers: [first, second],
    edges: [edge],
  }, { now: secondTime });

  assert.equal(replay.map, created.map);
  assert.equal(replay.diff.fromRevision, created.map.revision);
  assert.equal(replay.diff.toRevision, created.map.revision);
  assert.deepEqual(replay.diff.nodes.updated, []);
  assert.deepEqual(replay.diff.edges.updated, []);
});

test("identity values resolve as aliases for edges and explicit node state", () => {
  const openAlexId = "https://openalex.org/W123";
  const first = paper({ id: "crossref:record-1", openAlexId });
  const second = paper({ id: "paper-2" });
  const created = createLiveLiteratureMap({
    mapId: "map-identity-aliases",
    papers: [first, second],
    edges: [citation(openAlexId, second.id)],
    now: firstTime,
  });

  assert.equal(created.map.edges.length, 1);
  assert.equal(created.map.edges[0]?.source, first.id);

  const classified = setLiteratureMapNodeState(created.map, openAlexId, { status: "core" }, { now: secondTime });
  assert.equal(classified.nodes.find((node) => node.id === first.id)?.status, "core");

  const removed = updateLiveLiteratureMap(classified, {
    origin: "monitor",
    tombstonePaperIds: [openAlexId],
  }, { now: secondTime });
  assert.deepEqual(removed.diff.nodes.tombstoned, [first.id]);
  assert.equal(removed.map.edges[0]?.tombstone, true);
});

test("frozen snapshots are detached, deeply immutable, and retain their source revision", () => {
  const first = paper({ id: "paper-1", doi: "10.1000/one" });
  first.venueEvidence = [{
    sourceId: "openreview",
    evidence: "metadata",
    venue: "ICLR",
    status: "unknown",
  }];
  const created = createLiveLiteratureMap({ mapId: "map-4", papers: [first], now: firstTime });
  const snapshot = freezeLiteratureMap(created.map, { snapshotId: "snapshot-1", now: secondTime });

  assert.equal(snapshot.kind, "snapshot");
  assert.equal(snapshot.sourceMapId, created.map.mapId);
  assert.equal(snapshot.sourceRevision, created.map.revision);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.nodes), true);
  assert.equal(Object.isFrozen(snapshot.nodes[0]?.paper), true);
  assert.notEqual(snapshot.nodes[0]?.paper.venueEvidence, created.map.nodes[0]?.paper.venueEvidence);
  assert.equal(Object.isFrozen(snapshot.nodes[0]?.paper.venueEvidence), true);
  assert.equal(Object.isFrozen(snapshot.nodes[0]?.paper.venueEvidence?.[0]), true);

  const updated = updateLiveLiteratureMap(created.map, {
    origin: "monitor",
    papers: [paper({ id: "paper-2", doi: "10.1000/two" })],
  }, { now: new Date("2026-07-23T03:00:00.000Z") });
  assert.equal(updated.map.nodes.length, 2);
  assert.equal(snapshot.nodes.length, 1);
});

test("unknown edge endpoints are retained as an auditable warning, not a broken edge", () => {
  const first = paper({ id: "paper-1" });
  const created = createLiveLiteratureMap({
    mapId: "map-5",
    papers: [first],
    edges: [citation(first.id, "missing-paper")],
    now: firstTime,
  });

  assert.equal(created.map.edges.length, 0);
  assert.match(created.diff.warnings[0] ?? "", /not present/u);
});
