import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergeLiteratureSearchResults } from "../../src/research/literature/candidatePool.js";
import {
  createOpenAlexSource,
  observeOpenAlexTerminology,
  OPENALEX_SEARCH_FIELDS,
  OPENALEX_WORK_FIELDS,
} from "../../src/research/literature/openAlexSource.js";
import {
  buildLiteratureTerminology,
  LITERATURE_TERMINOLOGY_CANDIDATES_PER_KIND_LIMIT,
  LITERATURE_TERMINOLOGY_EVIDENCE_PER_CANDIDATE_LIMIT,
  LITERATURE_TERMINOLOGY_SUMMARY_MAX_UTF8_BYTES,
  sanitizeRetrievalUrl,
} from "../../src/research/literature/terminology.js";
import { DEFAULT_RESEARCH_SETTINGS, writeResearchSettings } from "../../src/research/settings.js";
import { createLiteratureSearchTool } from "../../src/tool/builtin/literatureSearch.js";
import type {
  LiteratureSearchResult,
  LiteratureTerminologyObservation,
  LiteratureTerminologySourceObservation,
  LiteratureTerminologySourceRecord,
  ResearchPaper,
  ResearchSourceStatus,
  SearchPlan,
} from "../../src/research/types.js";

const RETRIEVED_AT = "2026-07-23T00:00:00.000Z";
const OPENALEX_ENDPOINT = "https://openalex.test/works?api_key=secret";

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function searchPlan(limit = 2): SearchPlan {
  return { query: "terminology evidence", limit, sort: "relevance", sourceIds: ["openalex"] };
}

function term(
  recordId: string,
  text: string,
  score: number,
  taxonomy: Partial<Pick<LiteratureTerminologySourceRecord, "subfield" | "field">> = {},
): LiteratureTerminologySourceRecord {
  return {
    providerRecordId: `https://openalex.org/${recordId}`,
    providerUrl: `https://openalex.org/${recordId}`,
    text,
    score,
    ...taxonomy,
  };
}

function taxonomy(recordId: string, text: string) {
  return {
    providerRecordId: `https://openalex.org/${recordId}`,
    providerUrl: `https://openalex.org/${recordId}`,
    text,
  };
}

function observation(
  supportingPaperId: string,
  input: {
    keywords?: LiteratureTerminologySourceRecord[];
    topics?: LiteratureTerminologySourceRecord[];
    primaryTopic?: LiteratureTerminologySourceRecord;
    queryVariantId?: string;
    retrievalUrl?: string;
    keywordSourceRecordCount?: number;
    keywordInvalidRecordCount?: number;
    topicSourceRecordCount?: number;
    topicInvalidRecordCount?: number;
    isParatext?: boolean;
  } = {},
): LiteratureTerminologyObservation {
  const keywords = input.keywords ?? [];
  const topics = input.topics ?? [];
  return {
    providerId: "openalex",
    supportingPaperId,
    ...(input.queryVariantId ? { queryVariantId: input.queryVariantId } : {}),
    retrievalUrl: input.retrievalUrl ?? `https://openalex.test/works?search=${encodeURIComponent(supportingPaperId)}`,
    retrievedAt: RETRIEVED_AT,
    isParatext: input.isParatext ?? false,
    keywords,
    topics,
    fieldCounts: {
      keywords: {
        sourceRecordCount: input.keywordSourceRecordCount ?? keywords.length,
        invalidRecordCount: input.keywordInvalidRecordCount ?? 0,
      },
      topics: {
        sourceRecordCount: input.topicSourceRecordCount ?? topics.length,
        invalidRecordCount: input.topicInvalidRecordCount ?? 0,
      },
    },
    ...(input.primaryTopic ? { primaryTopic: input.primaryTopic } : {}),
  };
}

function sourceObservation(
  sourcePaperId: string,
  input: Parameters<typeof observation>[1] = {},
): LiteratureTerminologySourceObservation {
  const { supportingPaperId: _supportingPaperId, ...rest } = observation(sourcePaperId, input);
  return { ...rest, sourcePaperId };
}

function sourceStatus(): ResearchSourceStatus {
  return {
    id: "openalex",
    name: "OpenAlex",
    status: "ok",
    retrievedAt: RETRIEVED_AT,
    queryUrl: "https://openalex.test/works?search=terminology",
    resultCount: 2,
    coverage: "test",
  };
}

function paper(id: string, rank: number): ResearchPaper {
  return {
    id,
    identity: { openAlexId: id },
    title: `Paper ${rank}`,
    authors: [],
    citedByCount: 0,
    topics: [],
    referencedWorkIds: [],
    sourceId: "openalex",
    sourceIds: ["openalex"],
    provenance: [{
      sourceId: "openalex",
      sourceRecordId: id,
      rank,
      retrievedAt: RETRIEVED_AT,
      queryUrl: "https://openalex.test/works?search=terminology",
    }],
  };
}

test("OpenAlex search requests terminology fields but persists only safe retrieval URLs", async () => {
  const requested: string[] = [];
  const source = createOpenAlexSource({
    endpoint: OPENALEX_ENDPOINT,
    mailto: "private@example.test",
    fetchImpl: async (input) => {
      requested.push(String(input));
      return jsonResponse({
        meta: { count: 1 },
        results: [{
          id: "https://openalex.org/W1",
          display_name: "Terminology paper",
          keywords: [
            { id: "https://openalex.org/keywords/K1", display_name: "Evidence term", score: 0.9 },
            null,
            { id: "https://openalex.org/keywords/K-low", display_name: "Low term", score: 0.2 },
            { id: "https://openalex.org/keywords/K-bad", display_name: "Bad score", score: 2 },
          ],
          topics: [
            { id: "https://openalex.org/T1", display_name: "Evidence topic", score: 0.8 },
            { id: "https://openalex.org/T-bad", display_name: "Bad topic", score: -0.1 },
          ],
          primary_topic: null,
        }],
      });
    },
  });

  const result = await source.search(searchPlan(), { now: () => new Date(RETRIEVED_AT) });
  const actualUrl = new URL(requested[0] ?? "");
  assert.equal(actualUrl.searchParams.get("api_key"), "secret");
  assert.equal(actualUrl.searchParams.get("mailto"), "private@example.test");
  assert.equal(actualUrl.searchParams.get("select"), OPENALEX_SEARCH_FIELDS);
  assert.equal(OPENALEX_WORK_FIELDS.includes("keywords"), false);
  assert.equal(OPENALEX_WORK_FIELDS.includes("primary_topic"), false);
  assert.equal(OPENALEX_WORK_FIELDS.includes("is_paratext"), false);
  assert.equal(result.source.queryUrl?.includes("private@example.test"), false);
  assert.equal(result.source.queryUrl?.includes("api_key"), false);
  assert.equal(result.terminologyObservations?.[0]?.retrievalUrl.includes("private@example.test"), false);
  assert.deepEqual(result.terminologyObservations?.[0]?.fieldCounts, {
    keywords: { sourceRecordCount: 4, invalidRecordCount: 2 },
    topics: { sourceRecordCount: 2, invalidRecordCount: 1 },
  });
  assert.deepEqual(result.terminologyObservations?.[0]?.keywords.map((item) => item.text), ["Evidence term", "Low term"]);
});

test("OpenAlex paratext and null terminology fields produce no usable terminology observation", () => {
  const context = {
    sourcePaperId: "https://openalex.org/W1",
    retrievedAt: RETRIEVED_AT,
    retrievalUrl: "https://openalex.test/works?search=paratest",
  };
  assert.equal(observeOpenAlexTerminology({
    id: "https://openalex.org/W1",
    display_name: "Paratext",
    is_paratext: true,
  }, context), undefined);
  const nullFields = observeOpenAlexTerminology({
    id: "https://openalex.org/W2",
    display_name: "Null fields",
    keywords: null,
    topics: null,
    primary_topic: null,
  }, { ...context, sourcePaperId: "https://openalex.org/W2" });
  assert.deepEqual(nullFields?.keywords, []);
  assert.deepEqual(nullFields?.topics, []);
  assert.deepEqual(nullFields?.fieldCounts, {
    keywords: { sourceRecordCount: 0, invalidRecordCount: 0 },
    topics: { sourceRecordCount: 0, invalidRecordCount: 0 },
  });
});

test("OpenAlex 429 is not retried and retains readable quota state", async () => {
  let calls = 0;
  const source = createOpenAlexSource({
    endpoint: OPENALEX_ENDPOINT,
    mailto: "private@example.test",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: "quota" }, 429, {
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "61",
        "retry-after": "60",
        "x-ratelimit-cost-usd": "0.003",
        "x-ratelimit-remaining-usd": "1.25",
      });
    },
  });

  const result = await source.search(searchPlan(), { now: () => new Date(RETRIEVED_AT) });
  assert.equal(calls, 1);
  assert.equal(result.source.status, "error");
  assert.deepEqual(result.source.rateLimit, {
    limit: 100,
    remaining: 0,
    resetSeconds: 61,
    retryAfterSeconds: 60,
    costUsd: 0.003,
    remainingUsd: 1.25,
  });
  assert.match(result.source.coverage, /retry after 60s/i);
  assert.equal(result.source.queryUrl?.includes("private@example.test"), false);
  assert.equal(result.source.queryUrl?.includes("api_key"), false);
});

test("terminology filters noise, retains provider scores and derives taxonomy-only adjacent fields", () => {
  const coreSubfield = taxonomy("subfields/S-core", "Core systems");
  const adjacentSubfield = taxonomy("subfields/S-adjacent", "Adjacent systems");
  const coreField = taxonomy("fields/F-core", "Core field");
  const adjacentField = taxonomy("fields/F-adjacent", "Adjacent field");
  const coreTopic = term("T-core", "Core topic", 0.9, { subfield: coreSubfield, field: coreField });
  const adjacentTopic = term("T-adjacent", "Adjacent topic", 0.8, { subfield: adjacentSubfield, field: adjacentField });
  const lowTopic = term("T-low", "Low topic", 0.49);
  const domainNoise = {
    ...term("T-domain", "Domain-only topic", 0.9),
    domain: taxonomy("domains/D1", "Excluded domain"),
  } as LiteratureTerminologySourceRecord;
  const highKeywords = Array.from({ length: 9 }, (_, index) => term(
    `keywords/K${index + 1}`,
    `Keyword ${index + 1}`,
    0.99 - index * 0.01,
  ));
  const lowKeyword = term("keywords/K-low", "Low keyword", 0.29);

  const terminology = buildLiteratureTerminology([
    observation("https://openalex.org/W1", {
      keywords: [...highKeywords, lowKeyword],
      topics: [coreTopic, adjacentTopic, lowTopic, domainNoise],
      keywordSourceRecordCount: 12,
      keywordInvalidRecordCount: 2,
      topicSourceRecordCount: 5,
      topicInvalidRecordCount: 1,
    }),
    observation("https://openalex.org/W2", { topics: [coreTopic, adjacentTopic] }),
    observation("https://openalex.org/W3", { topics: [coreTopic], primaryTopic: coreTopic }),
  ]);

  assert.ok(terminology);
  const keyword = terminology.candidates.find((candidate) => candidate.id === "openalex:observed_keyword:https://openalex.org/keywords/K1");
  assert.equal(keyword?.evidence[0]?.providerScore, 0.99);
  assert.equal(keyword?.evidence[0]?.providerUrl, "https://openalex.org/keywords/K1");
  assert.equal(keyword?.observationTruncation?.[0]?.perPaperLimit, 8);
  assert.equal(keyword?.observationTruncation?.[0]?.eligibleCount, 9);
  assert.equal(keyword?.observationTruncation?.[0]?.retainedCount, 8);
  assert.equal(keyword?.observationTruncation?.[0]?.filteredByScoreCount, 1);
  assert.equal(keyword?.observationTruncation?.[0]?.invalidRecordCount, 2);
  assert.equal(keyword?.observationTruncation?.[0]?.truncatedByLimit, true);
  assert.equal(terminology.candidates.some((candidate) => candidate.text === "Keyword 9"), false);
  assert.equal(terminology.candidates.some((candidate) => candidate.text === "Low keyword"), false);
  assert.equal(terminology.candidates.some((candidate) => candidate.text === "Low topic"), false);
  assert.equal(terminology.candidates.some((candidate) => candidate.id.includes("domains/D1")), false);

  const adjacentSubfieldCandidate = terminology.candidates.find((candidate) =>
    candidate.id === "openalex:adjacent_field:https://openalex.org/subfields/S-adjacent",
  );
  assert.deepEqual(adjacentSubfieldCandidate?.supportingPaperIds, [
    "https://openalex.org/W1",
    "https://openalex.org/W2",
  ]);
  assert.deepEqual(adjacentSubfieldCandidate?.inference, {
    basis: "multi_paper_taxonomy_contrast",
    level: "subfield",
    coreRecordId: "https://openalex.org/subfields/S-core",
    coreText: "Core systems",
    minimumSupportingPapers: 2,
  });
  const adjacentFieldCandidate = terminology.candidates.find((candidate) =>
    candidate.id === "openalex:adjacent_field:https://openalex.org/fields/F-adjacent",
  );
  assert.equal(adjacentFieldCandidate?.inference?.level, "field");
  assert.equal(adjacentFieldCandidate?.evidence.every((item) => item.providerField.endsWith(".field")), true);
});

test("one final paper reached by multiple query variants counts once while retaining URL evidence", () => {
  const shared = term("keywords/K-shared", "Shared keyword", 0.9);
  const terminology = buildLiteratureTerminology([
    observation("https://openalex.org/W1", {
      keywords: [shared],
      queryVariantId: "primary",
      retrievalUrl: "https://openalex.test/works?search=primary&mailto=private@example.test",
    }),
    observation("https://openalex.org/W1", {
      keywords: [shared],
      queryVariantId: "alternative-1",
      retrievalUrl: "https://openalex.test/works?search=alternative&api-key=secret",
    }),
  ]);
  const candidate = terminology?.candidates.find((item) => item.text === "Shared keyword");
  assert.deepEqual(candidate?.supportingPaperIds, ["https://openalex.org/W1"]);
  assert.equal(candidate?.evidence.length, 2);
  assert.deepEqual(candidate?.evidence.map((item) => item.retrievalUrl), [
    "https://openalex.test/works?search=alternative",
    "https://openalex.test/works?search=primary",
  ]);
  assert.equal(candidate?.totalEvidenceCount, 2);
});

test("terminology artifact budgets cap a 100-paper long-URL summary without leaking discarded support", () => {
  const coreSubfield = taxonomy("subfields/S-core", "Core terminology taxonomy");
  const longQueryFragment = "x".repeat(4_000);
  const observations = Array.from({ length: 100 }, (_, paperIndex) => {
    const paddedPaperIndex = String(paperIndex).padStart(3, "0");
    const supportingPaperId = `https://openalex.org/W-budget-${paddedPaperIndex}`;
    const retrievalUrl = `https://openalex.test/works?search=${longQueryFragment}&paper=${paddedPaperIndex}`;
    const keywords = Array.from({ length: 8 }, (_, recordIndex) => term(
      `keywords/K-${paddedPaperIndex}-${recordIndex}`,
      `Keyword ${paddedPaperIndex}-${recordIndex}`,
      0.9,
    ));
    const topics = Array.from({ length: 8 }, (_, recordIndex) => {
      const subfieldIndex = (paperIndex + recordIndex) % 10;
      return term(
        `topics/T-${paddedPaperIndex}-${recordIndex}`,
        `Topic ${paddedPaperIndex}-${recordIndex}`,
        0.8,
        { subfield: taxonomy(`subfields/S-${subfieldIndex}`, `Subfield ${subfieldIndex}`) },
      );
    });
    return observation(supportingPaperId, {
      queryVariantId: `variant-${paddedPaperIndex}`,
      retrievalUrl,
      keywords,
      topics,
      primaryTopic: term("topics/T-core", "Core terminology topic", 0.99, { subfield: coreSubfield }),
    });
  });

  const terminology = buildLiteratureTerminology(observations);
  assert.ok(terminology);
  // 100 * 8 observed keywords, 100 * 8 observed topics, and ten supported
  // adjacent taxonomy candidates all exist before artifact-level caps apply.
  assert.equal(terminology.totalCandidateCount, 1_610);
  assert.equal(terminology.truncated, true);
  assert.equal(terminology.candidates.length <= LITERATURE_TERMINOLOGY_CANDIDATES_PER_KIND_LIMIT * 3, true);
  assert.equal(
    Buffer.byteLength(JSON.stringify(terminology), "utf8") <= LITERATURE_TERMINOLOGY_SUMMARY_MAX_UTF8_BYTES,
    true,
  );

  for (const kind of ["observed_keyword", "observed_topic", "adjacent_field"] as const) {
    assert.equal(
      terminology.candidates.filter((candidate) => candidate.kind === kind).length
        <= LITERATURE_TERMINOLOGY_CANDIDATES_PER_KIND_LIMIT,
      true,
    );
  }
  assert.equal(
    terminology.candidates.some((candidate) => candidate.totalEvidenceCount > candidate.evidence.length),
    true,
  );

  for (const candidate of terminology.candidates) {
    assert.equal(candidate.evidence.length <= LITERATURE_TERMINOLOGY_EVIDENCE_PER_CANDIDATE_LIMIT, true);
    assert.equal(candidate.evidenceTruncated, candidate.totalEvidenceCount > candidate.evidence.length);
    assert.deepEqual(
      candidate.supportingPaperIds,
      [...new Set(candidate.evidence.map((evidence) => evidence.supportingPaperId))].sort(),
    );
    assert.equal(
      (candidate.observationTruncation?.length ?? 0) <= LITERATURE_TERMINOLOGY_EVIDENCE_PER_CANDIDATE_LIMIT,
      true,
    );
    for (const truncation of candidate.observationTruncation ?? []) {
      assert.equal(candidate.evidence.some((evidence) => (
        evidence.supportingPaperId === truncation.supportingPaperId
        && (evidence.queryVariantId ?? "") === (truncation.queryVariantId ?? "")
        && evidence.providerField === truncation.providerField
      )), true);
    }
  }
  assert.deepEqual(
    terminology.sourcePaperIds,
    [...new Set(terminology.candidates.flatMap((candidate) =>
      candidate.evidence.map((evidence) => evidence.supportingPaperId),
    ))].sort(),
  );
});

test("candidate-pool identity mapping excludes terminology observations from papers outside the final limit", () => {
  const first = paper("https://openalex.org/W1", 1);
  const second = paper("https://openalex.org/W2", 2);
  const result: LiteratureSearchResult = {
    source: sourceStatus(),
    papers: [first, second],
    edges: [],
    terminologyObservations: [
      sourceObservation(first.id, { keywords: [term("keywords/K1", "Final keyword", 0.9)] }),
      sourceObservation(second.id, { keywords: [term("keywords/K2", "Rejected keyword", 0.9)] }),
    ],
  };
  const pool = mergeLiteratureSearchResults({
    requestedSourceIds: ["openalex"],
    sourcePriority: ["openalex"],
    results: [result],
    limit: 1,
  });
  assert.deepEqual(pool.papers.map((item) => item.id), [first.id]);
  assert.deepEqual(pool.terminologyObservations.map((item) => item.supportingPaperId), [first.id]);
  const terminology = buildLiteratureTerminology(pool.terminologyObservations);
  assert.equal(terminology?.candidates.some((candidate) => candidate.text === "Final keyword"), true);
  assert.equal(terminology?.candidates.some((candidate) => candidate.text === "Rejected keyword"), false);
});

test("candidate-pool maps DOI-merged OpenAlex observations to the primary final paper without losing variant evidence", () => {
  const first = {
    ...paper("https://openalex.org/W-doi-primary", 1),
    identity: { openAlexId: "https://openalex.org/W-doi-primary", doi: "10.1000/shared-term" },
    doi: "10.1000/shared-term",
  };
  const second = {
    ...paper("https://openalex.org/W-doi-alternate", 1),
    identity: { openAlexId: "https://openalex.org/W-doi-alternate", doi: "10.1000/shared-term" },
    doi: "10.1000/shared-term",
  };
  const primarySource: ResearchSourceStatus = {
    ...sourceStatus(),
    queryVariantId: "primary",
    queryUrl: "https://openalex.test/works?search=primary",
    resultCount: 1,
  };
  const alternateSource: ResearchSourceStatus = {
    ...sourceStatus(),
    queryVariantId: "alternative-1",
    queryUrl: "https://openalex.test/works?search=alternate",
    resultCount: 1,
  };
  const sharedTerm = term("keywords/K-doi-shared", "DOI merged term", 0.9);
  const pool = mergeLiteratureSearchResults({
    requestedSourceIds: ["openalex"],
    sourcePriority: ["openalex"],
    limit: 1,
    results: [
      {
        source: primarySource,
        papers: [first],
        edges: [],
        terminologyObservations: [sourceObservation(first.id, {
          keywords: [sharedTerm],
          queryVariantId: "primary",
          retrievalUrl: "https://openalex.test/works?search=primary",
        })],
      },
      {
        source: alternateSource,
        papers: [second],
        edges: [],
        terminologyObservations: [sourceObservation(second.id, {
          keywords: [sharedTerm],
          queryVariantId: "alternative-1",
          retrievalUrl: "https://openalex.test/works?search=alternate",
        })],
      },
    ],
  });

  assert.deepEqual(pool.papers.map((item) => item.id), [first.id]);
  assert.deepEqual(pool.terminologyObservations.map((item) => item.supportingPaperId), [first.id, first.id]);
  const terminology = buildLiteratureTerminology(pool.terminologyObservations);
  const candidate = terminology?.candidates.find((item) => item.text === "DOI merged term");
  assert.deepEqual(candidate?.supportingPaperIds, [first.id]);
  assert.equal(candidate?.evidence.length, 2);
  assert.deepEqual(candidate?.evidence.map((item) => item.queryVariantId), ["alternative-1", "primary"]);
});

test("literature_search persists terminology only for its final candidate pool", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-terminology-artifact-"));
  const pilotHome = join(root, "pilot-home");
  await writeResearchSettings({
    scope: "global",
    pilotHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        sources: {
          openalex: {
            ...DEFAULT_RESEARCH_SETTINGS.literature.sources.openalex,
            enabled: true,
            mailto: "private@example.test",
          },
          arxiv: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.arxiv, enabled: false },
          crossref: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.crossref, enabled: false },
        },
      },
    },
  });
  const requested: string[] = [];
  const tool = createLiteratureSearchTool({
    endpoint: OPENALEX_ENDPOINT,
    fetchImpl: async (input) => {
      requested.push(String(input));
      return jsonResponse({
        meta: { count: 2 },
        results: [
          {
            id: "https://openalex.org/W1",
            display_name: "Final paper",
            keywords: [{ id: "https://openalex.org/keywords/K-final", display_name: "Final term", score: 0.9 }],
            topics: [],
          },
          {
            id: "https://openalex.org/W2",
            display_name: "Rejected paper",
            keywords: [{ id: "https://openalex.org/keywords/K-rejected", display_name: "Rejected term", score: 0.9 }],
            topics: [],
          },
        ],
      });
    },
  });
  const result = await tool.execute(
    { query: "final terminology", limit: 1 },
    { cwd: join(root, "project"), env: { PILOT_HOME: pilotHome }, now: () => new Date(RETRIEVED_AT) } as any,
  );

  assert.equal(new URL(requested[0] ?? "").searchParams.get("api_key"), "secret");
  assert.equal(new URL(requested[0] ?? "").searchParams.get("mailto"), "private@example.test");
  assert.equal(result.data?.terminology?.candidates.some((candidate) => candidate.text === "Final term"), true);
  assert.equal(result.data?.terminology?.candidates.some((candidate) => candidate.text === "Rejected term"), false);
  const persistedUrls = [
    result.data?.sources[0]?.queryUrl,
    result.data?.queryAudit?.[0]?.queryUrl,
    result.data?.terminology?.candidates[0]?.evidence[0]?.retrievalUrl,
  ];
  assert.equal(persistedUrls.some((url) => url?.includes("private@example.test") || url?.includes("api_key")), false);
});

test("retrieval URL sanitizer only permits public HTTP(S) URLs", () => {
  assert.equal(sanitizeRetrievalUrl("file:///C:/private.txt"), undefined);
  assert.equal(sanitizeRetrievalUrl("javascript:alert(1)"), undefined);
  assert.equal(
    sanitizeRetrievalUrl("https://user:password@openalex.test/works?search=ok"),
    "https://openalex.test/works?search=ok",
  );
  assert.equal(
    sanitizeRetrievalUrl("https://openalex.test/works?api_key=one&api-key=two&apiKey=three&x-api-key=four&access_token=five&token=six&client_secret=seven&mailto=private@example.test&search=ok"),
    "https://openalex.test/works?search=ok",
  );
});
