import assert from "node:assert/strict";
import test from "node:test";
import { createEvidencePackArtifact } from "../../../src/research/literature/evidencePack.js";
import type { LiveLiteratureMap } from "../../../src/research/literature/mapMaintenance.js";
import { createCitationSet } from "../../../src/research/manuscript/citations.js";
import { deriveRelatedWorkMapGroups, organizeRelatedWork } from "../../../src/research/manuscript/relatedWork.js";
import { SYNTHETIC_NOW, syntheticPaper } from "./fixtures.js";

test("Related Work organization combines map groups, CitationSet, and EvidencePack without drafting claims", () => {
  const first = syntheticPaper("paper-a", "Synthetic paper A");
  const second = syntheticPaper("paper-b", "Synthetic paper B");
  const map: LiveLiteratureMap = {
    schemaVersion: 1,
    kind: "live",
    mapId: "synthetic-map",
    revision: 3,
    createdAt: SYNTHETIC_NOW.toISOString(),
    updatedAt: SYNTHETIC_NOW.toISOString(),
    nodes: [first, second].map((paper, index) => ({
      id: paper.id,
      paper,
      aliases: [],
      status: index === 0 ? "core" : "relevant",
      tombstone: false,
      position: { x: index, y: 0, pinned: false },
      origins: ["search"],
      firstSeenAt: SYNTHETIC_NOW.toISOString(),
      updatedAt: SYNTHETIC_NOW.toISOString(),
    })),
    edges: [{
      id: "edge-a-b",
      source: "paper-a",
      target: "paper-b",
      type: "citation",
      weight: 1,
      inferred: false,
      tombstone: false,
      firstSeenAt: SYNTHETIC_NOW.toISOString(),
      updatedAt: SYNTHETIC_NOW.toISOString(),
    }],
  };
  const citations = createCitationSet({
    bibtexEntries: [
      { citationKey: "syntheticA", entryType: "article", paperId: "paper-a", fields: { title: first.title } },
      { citationKey: "syntheticB", entryType: "article", paperId: "paper-b", fields: { title: second.title } },
    ],
    producer: { kind: "import" },
    now: SYNTHETIC_NOW,
  });
  const evidence = createEvidencePackArtifact({
    entries: [{
      id: "entry-a",
      paperId: "paper-a",
      locator: { sourceId: "synthetic", recordId: "record-a", page: 2 },
      snapshot: { content: "Synthetic evidence for grouping only." },
    }],
    producer: { kind: "import" },
    now: SYNTHETIC_NOW,
  });

  const groups = deriveRelatedWorkMapGroups(map);
  const plan = organizeRelatedWork({ map, citationSet: citations, evidencePacks: [evidence], groups });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]?.paperIds, ["paper-a", "paper-b"]);
  assert.deepEqual(plan.groups[0]?.citationKeys, ["syntheticA", "syntheticB"]);
  assert.equal(plan.groups[0]?.coverage.status, "partial");
  assert.equal(plan.groups[0]?.evidence[0]?.locatorLabel, "page 2");
});
