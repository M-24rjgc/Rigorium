import assert from "node:assert/strict";
import test from "node:test";
import { createCitationSet } from "../../../src/research/manuscript/citations.js";
import { SYNTHETIC_NOW, syntheticZoteroItem } from "./fixtures.js";

test("CitationSet normalizes synthetic Zotero and structured BibTeX entry data deterministically", () => {
  const artifact = createCitationSet({
    zoteroItems: [{ item: syntheticZoteroItem(), paperId: "paper-zotero" }],
    bibtexEntries: [{
      citationKey: "syntheticBib2025",
      entryType: "inproceedings",
      paperId: "paper-bibtex",
      fields: {
        title: "Synthetic BibTeX fixture",
        author: "Grace Hopper",
        year: "2025",
        booktitle: "Synthetic Proceedings",
      },
    }],
    producer: { kind: "tool", toolName: "manuscript_latex" },
    artifactId: "synthetic-citations",
    now: SYNTHETIC_NOW,
  });

  assert.equal(artifact.kind, "citation_set");
  assert.deepEqual(artifact.payload.citationKeys, ["lovelace2026synthetic", "syntheticBib2025"]);
  assert.equal(artifact.payload.entries[0]?.source.kind, "zotero");
  assert.equal(artifact.payload.entries[0]?.paperId, "paper-zotero");
  assert.match(artifact.payload.bibtex, /@article\{lovelace2026synthetic,/u);
  assert.match(artifact.payload.bibtex, /@inproceedings\{syntheticBib2025,/u);
  assert.equal(artifact.payload.diagnostics.some((entry) => entry.code === "generated_key"), true);
});

test("CitationSet rejects duplicate explicit keys instead of silently changing identity", () => {
  assert.throws(() => createCitationSet({
    bibtexEntries: [
      { citationKey: "duplicate", entryType: "article", fields: { title: "Synthetic A" } },
      { citationKey: "duplicate", entryType: "article", fields: { title: "Synthetic B" } },
    ],
    producer: { kind: "user" },
  }), /duplicated/u);
});

