import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiteratureNoveltyRescanArtifact,
  rescanCandidateDirections,
  type NoveltyRescanSource,
} from "../../src/research/literature/noveltyRescan.js";
import { validateResearchDesignArtifact } from "../../src/research/design/validators.js";
import type { LiteratureSearchResult, ResearchPaper } from "../../src/research/types.js";

const now = () => new Date("2026-07-25T00:00:00.000Z");

function paper(sourceId: string, id: string, doi = "10.1000/graph-calibration"): ResearchPaper {
  return {
    id,
    identity: { doi },
    title: "Graph neural network uncertainty calibration under shift",
    authors: ["A. Researcher"],
    year: 2025,
    doi,
    citedByCount: 42,
    isOpenAccess: true,
    topics: [{ id: "calibration", name: "uncertainty calibration" }],
    referencedWorkIds: [],
    sourceId,
    sourceIds: [sourceId],
    provenance: [{ sourceId, sourceRecordId: id, rank: 1, retrievedAt: now().toISOString() }],
  };
}

function source(id: string, result: LiteratureSearchResult): NoveltyRescanSource {
  return { id, name: id, search: async () => result };
}

test("candidate rescans merge strong identities across providers and retain partial coverage", async () => {
  const openalexPaper = paper("openalex", "https://openalex.org/W1");
  const crossrefPaper = paper("crossref", "doi:10.1000/graph-calibration");
  const result = await rescanCandidateDirections({
    candidates: [{ id: "direction-1", summary: "Graph neural network uncertainty calibration under shift" }],
    sources: [
      source("openalex", {
        papers: [openalexPaper],
        edges: [],
        source: { id: "openalex", name: "OpenAlex", status: "ok", retrievedAt: now().toISOString(), resultCount: 1, coverage: "Official metadata", queryUrl: "https://api.openalex.org/works?search=calibration" },
      }),
      source("crossref", {
        papers: [crossrefPaper],
        edges: [],
        source: { id: "crossref", name: "Crossref", status: "ok", retrievedAt: now().toISOString(), resultCount: 1, coverage: "Official DOI metadata", queryUrl: "https://api.crossref.org/works?query=calibration" },
      }),
      source("arxiv", {
        papers: [],
        edges: [],
        source: { id: "arxiv", name: "arXiv", status: "error", retrievedAt: now().toISOString(), resultCount: 0, coverage: "Unavailable", error: "offline" },
      }),
    ],
    now,
  });

  assert.equal(result.coverage.status, "partial");
  assert.deepEqual(result.coverage.successfulSourceIds, ["openalex", "crossref"]);
  assert.deepEqual(result.coverage.failedSourceIds, ["arxiv"]);
  assert.equal(result.candidates[0]!.matches.length, 1);
  assert.deepEqual(result.candidates[0]!.matches[0]!.sourceIds, ["crossref", "openalex"]);
  assert.equal(result.candidates[0]!.novelty.status, "not_established");

  const artifact = createLiteratureNoveltyRescanArtifact({
    artifactId: "candidate-portfolio-review",
    rescan: result,
    producer: { kind: "agent", id: "research-agent" },
    now: now(),
  });
  assert.equal(artifact.kind, "literature_novelty_rescan");
  assert.equal(artifact.payload.kind, "literature_novelty_rescan");
  assert.equal(artifact.payload.rescan.candidates[0]!.candidateId, "direction-1");
  const designValidation = validateResearchDesignArtifact(artifact);
  assert.equal(designValidation.ok, false);
  if (!designValidation.ok) assert.equal(designValidation.issues[0]?.code, "unsupported_kind");
});

test("a disconnected provider is an auditable failure instead of a novelty claim", async () => {
  const result = await rescanCandidateDirections({
    candidates: [{ id: "direction-offline", summary: "A candidate direction" }],
    sources: [source("arxiv", {
      papers: [],
      edges: [],
      source: { id: "arxiv", name: "arXiv", status: "error", retrievedAt: now().toISOString(), resultCount: 0, coverage: "offline", error: "timeout" },
    })],
    now,
  });

  assert.equal(result.coverage.status, "failed");
  assert.equal(result.candidates[0]!.novelty.status, "insufficient_coverage");
  assert.equal(result.candidates[0]!.value.status, "insufficient_coverage");
});
