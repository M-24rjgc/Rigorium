import assert from "node:assert/strict";
import test from "node:test";
import { mergeLiteratureSearchResults } from "../../src/research/literature/candidatePool.js";
import type {
  LiteratureSearchResult,
  ResearchPaper,
  ResearchSourceStatus,
} from "../../src/research/types.js";

const retrievedAt = "2026-07-22T00:00:00.000Z";

function source(id: string, status: ResearchSourceStatus["status"] = "ok"): ResearchSourceStatus {
  return {
    id,
    name: id === "openalex" ? "OpenAlex" : "Crossref",
    status,
    retrievedAt,
    queryUrl: `https://example.test/${id}`,
    resultCount: status === "ok" ? 1 : 0,
    coverage: `${id} test coverage`,
    ...(status === "error" ? { error: `${id} test failure` } : {}),
  };
}

function paper(input: {
  id: string;
  sourceId: string;
  rank: number;
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  identity?: ResearchPaper["identity"];
  citedByCount?: number;
  referencedWorkIds?: string[];
}): ResearchPaper {
  const doi = input.doi;
  return {
    id: input.id,
    identity: input.identity ?? (doi ? { doi } : {}),
    title: input.title ?? "A precise title for duplicate handling",
    authors: input.authors ?? ["Ada Lovelace"],
    year: input.year ?? 2025,
    ...(doi ? { doi } : {}),
    citedByCount: input.citedByCount ?? 0,
    topics: [],
    referencedWorkIds: input.referencedWorkIds ?? [],
    sourceId: input.sourceId,
    sourceIds: [input.sourceId],
    provenance: [{
      sourceId: input.sourceId,
      sourceRecordId: input.id,
      rank: input.rank,
      retrievedAt,
      queryUrl: `https://example.test/${input.sourceId}`,
    }],
  };
}

function result(
  sourceStatus: ResearchSourceStatus,
  papers: ResearchPaper[],
  edges: LiteratureSearchResult["edges"] = [],
): LiteratureSearchResult {
  return { source: sourceStatus, papers, edges };
}

test("candidate pool merges DOI variants, keeps OpenAlex primary IDs, and preserves citation edges", () => {
  const openAlexFirst = paper({
    id: "https://openalex.org/W1",
    sourceId: "openalex",
    rank: 1,
    doi: "HTTPS://DOI.ORG/10.1000/ABC",
    identity: { openAlexId: "https://openalex.org/W1", doi: "HTTPS://DOI.ORG/10.1000/ABC" },
    referencedWorkIds: ["https://openalex.org/W2"],
    citedByCount: 11,
  });
  const openAlexSecond = paper({
    id: "https://openalex.org/W2",
    sourceId: "openalex",
    rank: 2,
    identity: { openAlexId: "https://openalex.org/W2" },
  });
  const crossrefDuplicate = paper({
    id: "https://doi.org/10.1000/abc",
    sourceId: "crossref",
    rank: 1,
    doi: "doi:10.1000/abc",
    identity: { doi: "doi:10.1000/abc" },
    citedByCount: 3,
  });
  const edge = {
    id: "citation:https://openalex.org/W1:https://openalex.org/W2",
    source: "https://openalex.org/W1",
    target: "https://openalex.org/W2",
    type: "citation" as const,
    weight: 1,
    inferred: false,
  };

  const pool = mergeLiteratureSearchResults({
    requestedSourceIds: ["openalex", "crossref"],
    sourcePriority: ["openalex", "crossref"],
    limit: 10,
    results: [
      result(source("openalex"), [openAlexFirst, openAlexSecond], [edge]),
      result(source("crossref"), [crossrefDuplicate]),
    ],
  });

  assert.equal(pool.papers.length, 2);
  const merged = pool.papers.find((item) => item.id === "https://openalex.org/W1");
  assert.ok(merged);
  assert.equal(merged.sourceId, "openalex");
  assert.deepEqual(merged.sourceIds, ["openalex", "crossref"]);
  assert.equal(merged.doi, "10.1000/abc");
  assert.equal(merged.identity.doi, "10.1000/abc");
  assert.deepEqual(merged.provenance.map((item) => item.sourceId), ["openalex", "crossref"]);
  assert.deepEqual(pool.edges, [edge]);
  assert.equal(pool.coverage.status, "complete");
});

test("candidate pool rejects an otherwise exact weak match when strong identifiers conflict", () => {
  const first = paper({
    id: "https://openalex.org/W-conflict",
    sourceId: "openalex",
    rank: 1,
    doi: "10.5555/first",
    identity: { doi: "10.5555/first" },
    title: "A deliberately long title that could otherwise be mistaken for a duplicate",
    authors: ["Grace Hopper"],
    year: 2024,
  });
  const second = paper({
    id: "https://doi.org/10.5555/second",
    sourceId: "crossref",
    rank: 1,
    doi: "10.5555/second",
    identity: { doi: "10.5555/second" },
    title: "A deliberately long title that could otherwise be mistaken for a duplicate",
    authors: ["Grace Hopper"],
    year: 2024,
  });

  const pool = mergeLiteratureSearchResults({
    requestedSourceIds: ["openalex", "crossref"],
    limit: 10,
    results: [result(source("openalex"), [first]), result(source("crossref"), [second])],
  });

  assert.equal(pool.papers.length, 2);
});

test("reciprocal-rank fusion keeps a Crossref-only candidate inside a finite result limit", () => {
  const openAlexPapers = [1, 2, 3].map((rank) => paper({
    id: `https://openalex.org/W${rank}`,
    sourceId: "openalex",
    rank,
    identity: { openAlexId: `https://openalex.org/W${rank}` },
    title: `OpenAlex only result number ${rank} with a long enough title`,
  }));
  const crossrefOnly = paper({
    id: "https://doi.org/10.5555/crossref-only",
    sourceId: "crossref",
    rank: 1,
    doi: "10.5555/crossref-only",
    title: "Crossref only result with a long enough title for ranked fusion",
  });

  const pool = mergeLiteratureSearchResults({
    requestedSourceIds: ["openalex", "crossref"],
    sourcePriority: ["openalex", "crossref"],
    limit: 2,
    results: [result(source("openalex"), openAlexPapers), result(source("crossref"), [crossrefOnly])],
  });

  assert.equal(pool.papers.length, 2);
  assert.equal(pool.papers.some((item) => item.id === crossrefOnly.id), true);
});

test("reciprocal-rank fusion treats each source and query variant as an audited channel", () => {
  const primarySource = { ...source("openalex"), queryVariantId: "primary" };
  const alternateSource = { ...source("openalex"), queryVariantId: "alternative-1" };
  const primaryOnly = paper({
    id: "https://openalex.org/W-primary-only",
    sourceId: "openalex",
    rank: 1,
    identity: { openAlexId: "https://openalex.org/W-primary-only" },
    title: "Primary query only paper with a sufficiently long title",
  });
  const sharedPrimary = paper({
    id: "https://openalex.org/W-shared",
    sourceId: "openalex",
    rank: 2,
    identity: { openAlexId: "https://openalex.org/W-shared" },
    title: "Paper found by both query formulations with a long title",
  });
  const sharedAlternate = paper({
    id: "https://openalex.org/W-shared",
    sourceId: "openalex",
    rank: 1,
    identity: { openAlexId: "https://openalex.org/W-shared" },
    title: "Paper found by both query formulations with a long title",
  });

  const pool = mergeLiteratureSearchResults({
    requestedSourceIds: ["openalex"],
    limit: 1,
    results: [
      result(primarySource, [primaryOnly, sharedPrimary]),
      result(alternateSource, [sharedAlternate]),
    ],
  });

  assert.equal(pool.papers[0]?.id, "https://openalex.org/W-shared");
  assert.deepEqual(
    pool.papers[0]?.provenance.map((item) => item.queryVariantId).sort(),
    ["alternative-1", "primary"],
  );
});

test("candidate pool reports partial coverage without discarding the successful source", () => {
  const successful = paper({
    id: "https://openalex.org/W-success",
    sourceId: "openalex",
    rank: 1,
    identity: { openAlexId: "https://openalex.org/W-success" },
  });
  const pool = mergeLiteratureSearchResults({
    requestedSourceIds: ["openalex", "crossref"],
    limit: 10,
    results: [result(source("openalex"), [successful]), result(source("crossref", "error"), [])],
  });

  assert.equal(pool.coverage.status, "partial");
  assert.deepEqual(pool.coverage.successfulSourceIds, ["openalex"]);
  assert.deepEqual(pool.coverage.failedSourceIds, ["crossref"]);
  assert.equal(pool.papers.length, 1);
  assert.match(pool.coverage.warnings[0] ?? "", /Crossref/);
});

test("candidate pool promotes legacy identity.other.arxiv and keeps the highest numeric arXiv version", () => {
  const legacyOpenAlex = paper({
    id: "https://openalex.org/W-arxiv-legacy",
    sourceId: "openalex",
    rank: 1,
    identity: {
      openAlexId: "https://openalex.org/W-arxiv-legacy",
      other: { arxiv: "https://arxiv.org/abs/2401.12345v1" },
    },
  });
  const arxivRecord = paper({
    id: "https://arxiv.org/abs/2401.12345",
    sourceId: "arxiv",
    rank: 1,
    identity: { arxiv: "2401.12345", arxivVersion: 3 },
  });

  const pool = mergeLiteratureSearchResults({
    requestedSourceIds: ["openalex", "arxiv"],
    sourcePriority: ["openalex", "arxiv"],
    limit: 10,
    results: [
      result(source("openalex"), [legacyOpenAlex]),
      result(source("arxiv"), [arxivRecord]),
    ],
  });

  assert.equal(pool.papers.length, 1);
  assert.equal(pool.papers[0]?.id, "https://openalex.org/W-arxiv-legacy");
  assert.equal(pool.papers[0]?.identity.arxiv, "2401.12345");
  assert.equal(pool.papers[0]?.identity.arxivVersion, 3);
  assert.equal(pool.papers[0]?.identity.other?.arxiv, undefined);
});
