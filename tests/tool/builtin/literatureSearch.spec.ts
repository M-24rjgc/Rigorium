import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
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

test("literature_search normalizes OpenAlex papers and real citation edges", async () => {
  let requestedUrl = "";
  const fetchImpl: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return jsonResponse(openAlexPayload);
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
  assert.match(requestedUrl, /from_publication_date%3A2023-01-01/);
  assert.match(requestedUrl, /to_publication_date%3A2025-12-31/);
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
