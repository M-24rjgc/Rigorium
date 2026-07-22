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
      ids: { openalex: "https://openalex.org/W1", doi: "https://doi.org/10.1000/first" },
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

test("literature_search normalizes OpenAlex papers and real citation edges", async () => {
  const requestedUrls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    return url.includes("api.crossref.org")
      ? jsonResponse(crossrefPayload)
      : jsonResponse(openAlexPayload);
  };
  const tool = createLiteratureSearchTool({ fetchImpl });
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
  assert.equal(result.data?.sources.length, 2);
  assert.equal(result.data?.coverage.status, "complete");
  assert.deepEqual(result.data?.coverage.successfulSourceIds, ["openalex", "crossref"]);
  assert.deepEqual(result.data?.papers[0]?.sourceIds, ["openalex", "crossref"]);
  assert.equal(result.data?.papers[0]?.provenance.length, 2);
  const openAlexUrl = requestedUrls.find((url) => url.includes("api.openalex.org")) ?? "";
  const crossrefUrl = requestedUrls.find((url) => url.includes("api.crossref.org")) ?? "";
  assert.match(openAlexUrl, /from_publication_date%3A2023-01-01/);
  assert.match(openAlexUrl, /to_publication_date%3A2025-12-31/);
  assert.match(crossrefUrl, /from-pub-date%3A2023-01-01/);
  assert.match(crossrefUrl, /until-pub-date%3A2025-12-31/);
});

test("literature_search preserves a structured failed-source artifact", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse({ error: "rate limited" }, 429);
  const tool = createLiteratureSearchTool({ fetchImpl });
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
  const fetchImpl: typeof fetch = async (input) => String(input).includes("api.crossref.org")
    ? jsonResponse({ message: {} })
    : jsonResponse(openAlexPayload);
  const tool = createLiteratureSearchTool({ fetchImpl });
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
  assert.deepEqual(result.data?.coverage.successfulSourceIds, ["openalex"]);
  assert.deepEqual(result.data?.coverage.failedSourceIds, ["crossref"]);
  assert.match(result.data?.coverage.warnings[0] ?? "", /Crossref/);
});

test("literature_search retains Crossref results when OpenAlex fails", async () => {
  const fetchImpl: typeof fetch = async (input) => String(input).includes("api.openalex.org")
    ? jsonResponse({ error: "OpenAlex unavailable" }, 400)
    : jsonResponse(crossrefPayload);
  const tool = createLiteratureSearchTool({ fetchImpl });
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
  assert.equal(result.data?.papers[0]?.sourceId, "crossref");
  assert.deepEqual(result.data?.coverage.successfulSourceIds, ["crossref"]);
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
          crossref: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.crossref, enabled: false },
        },
      },
    },
  });
  const tool = createLiteratureSearchTool({
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
