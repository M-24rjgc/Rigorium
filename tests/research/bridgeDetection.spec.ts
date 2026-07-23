import assert from "node:assert/strict";
import test from "node:test";
import { analyzeLiteratureMapBridges } from "../../src/research/literature/bridgeDetection.js";
import {
  createLiveLiteratureMap,
  updateLiveLiteratureMap,
} from "../../src/research/literature/mapMaintenance.js";
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

function relation(
  id: string,
  source: string,
  target: string,
  input: Partial<Pick<ResearchRelationEdge, "type" | "inferred" | "evidence">> = {},
): ResearchRelationEdge {
  return {
    id,
    source,
    target,
    type: input.type ?? "citation",
    weight: 1,
    inferred: input.inferred ?? false,
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
}

test("identifies a citation articulation paper with bounded, explicit relation provenance", () => {
  const papers = [paper("A1"), paper("A2"), paper("B", "10.1000/bridge"), paper("C1"), paper("C2"), paper("D")];
  const observed = [
    relation("left-a1-a2", "A1", "A2"),
    relation("left-a1-b", "A1", "B", { evidence: ["openalex:references"] }),
    relation("left-a2-b", "A2", "B"),
    relation("right-b-c1", "B", "C1", { evidence: ["crossref:is-referenced-by"] }),
    relation("right-b-c2", "B", "C2"),
    relation("right-c1-c2", "C1", "C2"),
  ];
  const inferredBypass = relation("topic-a1-c1", "A1", "C1", {
    type: "topic_similarity",
    inferred: true,
    evidence: ["topic:T1"],
  });
  const tombstonedBranch = relation("removed-b-d", "B", "D");
  const created = createLiveLiteratureMap({
    mapId: "bridge-map",
    papers,
    edges: [...observed, inferredBypass, tombstonedBranch],
    now: firstTime,
  });
  const aliased = updateLiveLiteratureMap(created.map, {
    origin: "zotero",
    papers: [paper("zotero-bridge", "https://doi.org/10.1000/BRIDGE")],
    tombstonePaperIds: ["D"],
  }, { now: secondTime });

  const analysis = analyzeLiteratureMapBridges(aliased.map);

  assert.equal(analysis.kind, "literature_bridge_analysis");
  assert.equal(analysis.sourceRevision, aliased.map.revision);
  assert.equal(analysis.relationPolicy, "observed_citations");
  assert.equal(analysis.graphProjection, "undirected");
  assert.equal(analysis.algorithm, "tarjan_articulation_points");
  assert.deepEqual(analysis.provenance, {
    source: "live_literature_map",
    evaluatedPaperCount: 5,
    evaluatedRelationCount: 6,
    evaluatedRelationIds: observed.map((edge) => `citation:${edge.source}:${edge.target}`).sort(),
    excludedTombstonePaperCount: 1,
    excludedTombstoneRelationCount: 1,
    excludedByRelationPolicyCount: 1,
    skippedInvalidRelationIds: [],
  });
  assert.equal(analysis.bridges.length, 1);
  assert.deepEqual(analysis.bridges[0], {
    paperId: "B",
    aliases: ["B", "zotero-bridge"],
    title: "Paper zotero-bridge",
    sourceComponentSize: 5,
    componentIncrease: 1,
    separatedPairCount: 4,
    possiblePairCount: 6,
    separatedPairFraction: 4 / 6,
    directNeighborPaperIds: ["A1", "A2", "C1", "C2"],
    separatedGroups: [
      { size: 2, representativePaperIds: ["A1", "A2"] },
      { size: 2, representativePaperIds: ["C1", "C2"] },
    ],
    supportingRelations: [
      {
        edgeId: "citation:A1:B",
        sourcePaperId: "A1",
        targetPaperId: "B",
        relationType: "citation",
        inferred: false,
        evidence: ["openalex:references"],
      },
      {
        edgeId: "citation:A2:B",
        sourcePaperId: "A2",
        targetPaperId: "B",
        relationType: "citation",
        inferred: false,
        evidence: [],
      },
      {
        edgeId: "citation:B:C1",
        sourcePaperId: "B",
        targetPaperId: "C1",
        relationType: "citation",
        inferred: false,
        evidence: ["crossref:is-referenced-by"],
      },
      {
        edgeId: "citation:B:C2",
        sourcePaperId: "B",
        targetPaperId: "C2",
        relationType: "citation",
        inferred: false,
        evidence: [],
      },
    ],
  });
});

test("an all-relation analysis labels inferred evidence and does not overstate a bypassed bridge", () => {
  const created = createLiveLiteratureMap({
    mapId: "inferred-bypass-map",
    papers: [paper("A1"), paper("A2"), paper("B"), paper("C1"), paper("C2")],
    edges: [
      relation("left-a1-a2", "A1", "A2"),
      relation("left-a1-b", "A1", "B"),
      relation("left-a2-b", "A2", "B"),
      relation("right-b-c1", "B", "C1"),
      relation("right-b-c2", "B", "C2"),
      relation("right-c1-c2", "C1", "C2"),
      relation("topic-a1-c1", "A1", "C1", {
        type: "topic_similarity",
        inferred: true,
        evidence: ["topic:T1"],
      }),
    ],
    now: firstTime,
  });

  const observedOnly = analyzeLiteratureMapBridges(created.map);
  const allRelations = analyzeLiteratureMapBridges(created.map, { relationPolicy: "all_active_relations" });

  assert.deepEqual(observedOnly.bridges.map((bridge) => bridge.paperId), ["B"]);
  assert.deepEqual(allRelations.bridges, []);
  assert.equal(allRelations.provenance.evaluatedRelationCount, 7);
  assert.equal(allRelations.provenance.excludedByRelationPolicyCount, 0);
  assert.equal(allRelations.provenance.evaluatedRelationIds.includes("topic_similarity:A1:C1"), true);
});

test("keeps disconnected components independent and rejects an unknown relation policy", () => {
  const created = createLiveLiteratureMap({
    mapId: "disconnected-map",
    papers: [paper("A"), paper("B"), paper("C"), paper("X"), paper("Y")],
    edges: [
      relation("a-b", "A", "B"),
      relation("b-c", "B", "C"),
      relation("x-y", "X", "Y"),
    ],
    now: firstTime,
  });

  const analysis = analyzeLiteratureMapBridges(created.map);
  assert.deepEqual(analysis.bridges.map((bridge) => bridge.paperId), ["B"]);
  assert.equal(analysis.bridges[0]?.sourceComponentSize, 3);
  assert.throws(
    () => analyzeLiteratureMapBridges(created.map, { relationPolicy: "centrality" as never }),
    /relationPolicy must be observed_citations or all_active_relations/u,
  );
});
