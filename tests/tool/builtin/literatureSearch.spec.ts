import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DEFAULT_RESEARCH_SETTINGS, writeResearchSettings } from "../../../src/research/settings.js";
import { createLiteratureSearchTool } from "../../../src/tool/builtin/literatureSearch.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const openAlexPayload = {
  meta: { count: 42 },
  results: [
    {
      id: "https://openalex.org/W1",
      doi: "https://doi.org/10.1000/first",
      display_name: "First research paper",
      publication_year: 2025,
      publication_date: "2025-02-01",
      type: "article",
      cited_by_count: 15,
      authorships: [{ author: { display_name: "Ada Lovelace" } }],
      primary_location: { landing_page_url: "https://example.test/first", source: { display_name: "Test Venue" } },
      open_access: { is_oa: true },
      topics: [{ id: "https://openalex.org/T1", display_name: "Research agents", score: 0.9 }],
      referenced_works: ["https://openalex.org/W2"],
      ids: {
        openalex: "https://openalex.org/W1",
        doi: "https://doi.org/10.1000/first",
        arxiv: "https://arxiv.org/abs/2401.12345v2",
      },
      abstract_inverted_index: { Useful: [0], evidence: [1] },
    },
    {
      id: "https://openalex.org/W2",
      display_name: "Second research paper",
      publication_year: 2024,
      cited_by_count: 7,
      authorships: [{ author: { display_name: "Grace Hopper" } }],
      primary_location: { landing_page_url: "https://example.test/second", source: { display_name: "Test Venue" } },
      topics: [{ id: "https://openalex.org/T1", display_name: "Research agents", score: 0.8 }],
      referenced_works: [],
      ids: { openalex: "https://openalex.org/W2" },
    },
  ],
};

const crossrefPayload = {
  message: {
    "total-results": 17,
    items: [{
      DOI: "doi:10.1000/first",
      title: ["First research paper"],
      author: [{ given: "Ada", family: "Lovelace" }],
      published: { "date-parts": [[2025, 2, 1]] },
      "container-title": ["Test Venue"],
      URL: "https://doi.org/10.1000/first",
      type: "journal-article",
      "is-referenced-by-count": 9,
    }],
  },
};

const arxivPayload = [
  "<feed xmlns=\"http://www.w3.org/2005/Atom\"",
  " xmlns:arxiv=\"http://arxiv.org/schemas/atom\"",
  " xmlns:opensearch=\"http://a9.com/-/spec/opensearch/1.1/\">",
  "<title>ArXiv Query</title>",
  "<opensearch:totalResults>1</opensearch:totalResults>",
  "<entry>",
  "<id>http://arxiv.org/abs/2401.12345v2</id>",
  "<updated>2025-02-02T00:00:00Z</updated>",
  "<published>2025-02-01T00:00:00Z</published>",
  "<title>First research paper</title>",
  "<summary>Useful evidence</summary>",
  "<author><name>Ada Lovelace</name></author>",
  "<arxiv:primary_category term=\"cs.AI\"/>",
  "<category term=\"cs.AI\"/>",
  "<arxiv:doi>10.1000/first</arxiv:doi>",
  "</entry>",
  "</feed>",
].join("");

const ARXIV_TEST_ENDPOINT = "https://arxiv.test/api/literature-search";

test("literature_search normalizes OpenAlex papers and real citation edges", async () => {
  const requestedUrls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("api.crossref.org")) return jsonResponse(crossrefPayload);
    if (url.includes("arxiv.test")) return new Response(arxivPayload);
    return jsonResponse(openAlexPayload);
  };
  const tool = createLiteratureSearchTool({ fetchImpl, arxivEndpoint: ARXIV_TEST_ENDPOINT, arxivMinimumIntervalMs: 1 });
  const result = await tool.execute(
    { query: "research agents", limit: 2, fromYear: 2023, toYear: 2025 },
    {
      cwd: join(tmpdir(), "rigorium-literature-project"),
      env: { PILOT_HOME: join(tmpdir(), "rigorium-literature-home") },
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    } as any,
  );

  assert.equal(result.data?.kind, "literature_search");
  assert.equal(result.data?.papers.length, 2);
  assert.equal(result.data?.papers[0]?.doi, "10.1000/first");
  assert.equal(result.data?.papers[0]?.abstract, "Useful evidence");
  assert.equal(result.data?.edges.some((edge) => edge.type === "citation" && !edge.inferred), true);
  assert.equal(result.data?.sources[0]?.totalMatches, 42);
  assert.equal(result.data?.sources.length, 3);
  assert.equal(result.data?.coverage.status, "complete");
  assert.deepEqual(result.data?.coverage.successfulSourceIds, ["openalex", "arxiv", "crossref"]);
  assert.deepEqual(result.data?.papers[0]?.sourceIds, ["openalex", "arxiv", "crossref"]);
  assert.equal(result.data?.papers[0]?.provenance.length, 3);
  assert.equal(result.data?.papers[0]?.identity.arxiv, "2401.12345");
  assert.equal(result.data?.papers[0]?.identity.arxivVersion, 2);
  const openAlexUrl = requestedUrls.find((url) => url.includes("api.openalex.org")) ?? "";
  const crossrefUrl = requestedUrls.find((url) => url.includes("api.crossref.org")) ?? "";
  const arxivUrl = requestedUrls.find((url) => url.includes("arxiv.test")) ?? "";
  assert.match(openAlexUrl, /from_publication_date%3A2023-01-01/);
  assert.match(openAlexUrl, /to_publication_date%3A2025-12-31/);
  assert.match(crossrefUrl, /from-pub-date%3A2023-01-01/);
  assert.match(crossrefUrl, /until-pub-date%3A2025-12-31/);
  assert.match(
    new URL(arxivUrl).searchParams.get("search_query") ?? "",
    /submittedDate:\[202301010000 TO 202512312359\]/,
  );
});

test("literature_search audits agent-selected query variants and merges their candidate records", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-literature-variants-"));
  const pilotHome = join(root, "pilot-home");
  await writeResearchSettings({
    scope: "global",
    pilotHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        sources: {
          openalex: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.openalex, enabled: true },
          arxiv: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.arxiv, enabled: false },
          crossref: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.crossref, enabled: false },
        },
      },
    },
  });
  const requestedUrls: URL[] = [];
  const tool = createLiteratureSearchTool({
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requestedUrls.push(url);
      const search = url.searchParams.get("search");
      if (search === "research agents") {
        return jsonResponse({ meta: { count: 1 }, results: [openAlexPayload.results[0]] });
      }
      if (search === "agentic systems") {
        return jsonResponse({ meta: { count: 2 }, results: [openAlexPayload.results[0], openAlexPayload.results[1]] });
      }
      throw new Error(`Unexpected query: ${search}`);
    },
  });

  const result = await tool.execute(
    {
      query: "research agents",
      limit: 5,
      queryVariants: [{ query: "agentic systems", rationale: "common adjacent terminology" }],
    },
    {
      cwd: join(root, "project"),
      env: { PILOT_HOME: pilotHome },
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    } as any,
  );

  assert.deepEqual(result.data?.plan.queryVariants, [
    { id: "primary", query: "research agents", requestLimit: 3 },
    {
      id: "alternative-1",
      query: "agentic systems",
      requestLimit: 2,
      rationale: "common adjacent terminology",
    },
  ]);
  assert.deepEqual(
    requestedUrls.map((url) => [url.searchParams.get("search"), url.searchParams.get("per-page")]),
    [["research agents", "3"], ["agentic systems", "2"]],
  );
  assert.deepEqual(result.data?.queryAudit?.map((source) => source.queryVariantId), ["primary", "alternative-1"]);
  assert.equal(result.data?.sources.length, 1);
  assert.equal(result.data?.sources[0]?.queryVariantId, undefined);
  assert.equal(result.data?.sources[0]?.resultCount, 3);
  const duplicated = result.data?.papers.find((paper) => paper.id === "https://openalex.org/W1");
  assert.deepEqual(
    duplicated?.provenance.map((provenance) => provenance.queryVariantId).sort(),
    ["alternative-1", "primary"],
  );
});

test("literature_search keeps successful variants when an alternate query fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-literature-variant-failure-"));
  const pilotHome = join(root, "pilot-home");
  await writeResearchSettings({
    scope: "global",
    pilotHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        sources: {
          openalex: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.openalex, enabled: true },
          arxiv: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.arxiv, enabled: false },
          crossref: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.crossref, enabled: false },
        },
      },
    },
  });
  const tool = createLiteratureSearchTool({
    fetchImpl: async (input) => {
      const search = new URL(String(input)).searchParams.get("search");
      return search === "research agents"
        ? jsonResponse({ meta: { count: 1 }, results: [openAlexPayload.results[0]] })
        : jsonResponse({ error: "alternate unavailable" }, 400);
    },
  });

  const result = await tool.execute(
    {
      query: "research agents",
      limit: 4,
      queryVariants: [{ query: "agentic systems" }],
    },
    {
      cwd: join(root, "project"),
      env: { PILOT_HOME: pilotHome },
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    } as any,
  );

  assert.equal(result.data?.coverage.status, "partial");
  assert.equal(result.data?.papers.length, 1);
  assert.equal(result.data?.sources[0]?.status, "ok");
  assert.deepEqual(result.data?.queryAudit?.map((source) => source.status), ["ok", "error"]);
  assert.match(result.data?.coverage.warnings.join(" ") ?? "", /alternative-1/i);
});

test("literature_search never allocates more query requests than the total result budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-literature-variant-budget-"));
  const pilotHome = join(root, "pilot-home");
  await writeResearchSettings({
    scope: "global",
    pilotHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        sources: {
          openalex: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.openalex, enabled: true },
          arxiv: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.arxiv, enabled: false },
          crossref: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.crossref, enabled: false },
        },
      },
    },
  });
  const requested: Array<[string | null, string | null]> = [];
  const tool = createLiteratureSearchTool({
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requested.push([url.searchParams.get("search"), url.searchParams.get("per-page")]);
      return jsonResponse({ meta: { count: 0 }, results: [] });
    },
  });

  const result = await tool.execute(
    {
      query: "primary formulation",
      limit: 2,
      queryVariants: [
        { query: "first alternative" },
        { query: "second alternative" },
        { query: "third alternative" },
      ],
    },
    {
      cwd: join(root, "project"),
      env: { PILOT_HOME: pilotHome },
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    } as any,
  );

  assert.deepEqual(requested, [["primary formulation", "1"], ["first alternative", "1"]]);
  assert.equal(result.data?.plan.queryVariants?.reduce((sum, variant) => sum + variant.requestLimit, 0), 2);
  assert.deepEqual(result.data?.plan.queryVariants?.map((variant) => variant.query), [
    "primary formulation",
    "first alternative",
  ]);
});

test("literature_search preserves a structured failed-source artifact", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse({ error: "rate limited" }, 429);
  const tool = createLiteratureSearchTool({ fetchImpl, arxivEndpoint: ARXIV_TEST_ENDPOINT, arxivMinimumIntervalMs: 1 });
  // networkFetch deliberately unrefs retry timers; keep the test process alive
  // while the 429 retry policy is exercised.
  const keepAlive = setInterval(() => undefined, 50);
  const result = await tool.execute(
    { query: "rate limited research" },
    {
      cwd: join(tmpdir(), "rigorium-literature-project-failed"),
      env: { PILOT_HOME: join(tmpdir(), "rigorium-literature-home-failed") },
    } as any,
  ).finally(() => clearInterval(keepAlive));

  assert.equal(result.data?.coverage.status, "failed");
  assert.equal(result.data?.papers.length, 0);
  assert.equal(result.data?.sources[0]?.status, "error");
  assert.match(result.data?.coverage.warnings[0] ?? "", /429/);
});

test("literature_search retains OpenAlex results when Crossref returns a malformed payload", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.crossref.org")) return jsonResponse({ message: {} });
    if (url.includes("arxiv.test")) return new Response(arxivPayload);
    return jsonResponse(openAlexPayload);
  };
  const tool = createLiteratureSearchTool({ fetchImpl, arxivEndpoint: ARXIV_TEST_ENDPOINT, arxivMinimumIntervalMs: 1 });
  const result = await tool.execute(
    { query: "partial source coverage" },
    {
      cwd: join(tmpdir(), "rigorium-literature-project-partial"),
      env: { PILOT_HOME: join(tmpdir(), "rigorium-literature-home-partial") },
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    } as any,
  );

  assert.equal(result.data?.coverage.status, "partial");
  assert.equal(result.data?.papers.length, 2);
  assert.deepEqual(result.data?.coverage.successfulSourceIds, ["openalex", "arxiv"]);
  assert.deepEqual(result.data?.coverage.failedSourceIds, ["crossref"]);
  assert.match(result.data?.coverage.warnings[0] ?? "", /Crossref/);
});

test("literature_search retains Crossref results when OpenAlex fails", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.openalex.org")) return jsonResponse({ error: "OpenAlex unavailable" }, 400);
    if (url.includes("arxiv.test")) return new Response(arxivPayload);
    return jsonResponse(crossrefPayload);
  };
  const tool = createLiteratureSearchTool({ fetchImpl, arxivEndpoint: ARXIV_TEST_ENDPOINT, arxivMinimumIntervalMs: 1 });
  const result = await tool.execute(
    { query: "symmetric partial source coverage" },
    {
      cwd: join(tmpdir(), "rigorium-literature-project-crossref-only"),
      env: { PILOT_HOME: join(tmpdir(), "rigorium-literature-home-crossref-only") },
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    } as any,
  );

  assert.equal(result.data?.coverage.status, "partial");
  assert.equal(result.data?.papers.length, 1);
  assert.equal(result.data?.papers[0]?.sourceId, "arxiv");
  assert.deepEqual(result.data?.coverage.successfulSourceIds, ["arxiv", "crossref"]);
  assert.deepEqual(result.data?.coverage.failedSourceIds, ["openalex"]);
  assert.match(result.data?.coverage.warnings[0] ?? "", /OpenAlex/);
});

test("literature_search rejects execution when every configured source is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-literature-disabled-"));
  const pilotHome = join(root, "pilot-home");
  await writeResearchSettings({
    scope: "global",
    pilotHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        sources: {
          openalex: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.openalex, enabled: false },
          arxiv: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.arxiv, enabled: false },
          crossref: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.crossref, enabled: false },
        },
      },
    },
  });
  const tool = createLiteratureSearchTool({
    arxivEndpoint: ARXIV_TEST_ENDPOINT,
    arxivMinimumIntervalMs: 1,
    fetchImpl: async () => {
      throw new Error("disabled source must not be called");
    },
  });

  await assert.rejects(
    tool.execute(
      { query: "disabled sources" },
      { cwd: join(root, "project"), env: { PILOT_HOME: pilotHome } } as any,
    ),
    /No academic metadata source is enabled/,
  );
});

test("literature_search records partial coverage when requested arXiv classifications cannot run", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-literature-classification-disabled-"));
  const pilotHome = join(root, "pilot-home");
  await writeResearchSettings({
    scope: "global",
    pilotHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        sources: {
          ...DEFAULT_RESEARCH_SETTINGS.literature.sources,
          arxiv: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.arxiv, enabled: false },
        },
      },
    },
  });
  const tool = createLiteratureSearchTool({
    arxivEndpoint: ARXIV_TEST_ENDPOINT,
    arxivMinimumIntervalMs: 1,
    fetchImpl: async (input) => String(input).includes("api.crossref.org")
      ? jsonResponse(crossrefPayload)
      : jsonResponse(openAlexPayload),
  });

  const result = await tool.execute(
    {
      query: "classification coverage",
      classifications: [{ scheme: "arxiv", include: ["cs.AI"] }],
    },
    {
      cwd: join(root, "project"),
      env: { PILOT_HOME: pilotHome },
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    } as any,
  );

  assert.equal(result.data?.coverage.status, "partial");
  assert.deepEqual(result.data?.plan.classifications, [{ scheme: "arxiv", include: ["cs.AI"] }]);
  assert.deepEqual(result.data?.coverage.successfulSourceIds, ["openalex", "crossref"]);
  assert.deepEqual(result.data?.coverage.failedSourceIds, ["arxiv"]);
  assert.equal(result.data?.sources.find((source) => source.id === "arxiv")?.status, "disabled");
  assert.match(result.data?.coverage.warnings.join(" ") ?? "", /classification constraints were not applied/i);
});

test("literature_search rejects malformed arXiv category query grammar", async () => {
  const tool = createLiteratureSearchTool({ arxivEndpoint: ARXIV_TEST_ENDPOINT, arxivMinimumIntervalMs: 1 });
  await assert.rejects(
    tool.execute(
      {
        query: "unsafe classification",
        classifications: [{ scheme: "arxiv", include: ["cs.AI OR all:*"] }],
      } as any,
      { cwd: join(tmpdir(), "rigorium-literature-invalid-classification") } as any,
    ),
    /Invalid arXiv classifications.*Invalid arXiv category token/i,
  );
});

test("literature_search bounds explicit year input to the Research Settings range", async () => {
  const currentMax = new Date().getUTCFullYear() + 2;
  const tool = createLiteratureSearchTool({
    arxivEndpoint: ARXIV_TEST_ENDPOINT,
    arxivMinimumIntervalMs: 1,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("api.crossref.org")) return jsonResponse(crossrefPayload);
      if (url.includes("arxiv.test")) return new Response(arxivPayload);
      return jsonResponse(openAlexPayload);
    },
  });
  const result = await tool.execute(
    { query: "bounded years", fromYear: 1400, toYear: currentMax + 100 },
    {
      cwd: join(tmpdir(), "rigorium-literature-bounded-years"),
      env: { PILOT_HOME: join(tmpdir(), "rigorium-literature-bounded-years-home") },
    } as any,
  );

  assert.equal(result.data?.plan.fromYear, 1800);
  assert.equal(result.data?.plan.toYear, currentMax);
});
