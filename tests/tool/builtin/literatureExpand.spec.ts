import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_RESEARCH_SETTINGS, writeResearchSettings } from "../../../src/research/settings.js";
import { createLiteratureExpandTool } from "../../../src/tool/builtin/literatureExpand.js";
import { RigoriumToolRuntimeError } from "../../../src/tool/protocol/errors.js";

const OPENALEX_TEST_ENDPOINT = "https://openalex.test/works";

function jsonResponse(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function work(id: string, title: string, references: string[] = [], doi?: string) {
  return {
    id: `https://openalex.org/${id}`,
    ...(doi ? { doi: `https://doi.org/${doi}` } : {}),
    display_name: title,
    publication_year: 2024,
    publication_date: "2024-01-01",
    type: "article",
    cited_by_count: 10,
    authorships: [{ author: { display_name: "Ada Lovelace" } }],
    primary_location: { landing_page_url: `https://example.test/${id}`, source: { display_name: "Test Venue" } },
    open_access: { is_oa: true },
    topics: [],
    referenced_works: references.map((reference) => `https://openalex.org/${reference}`),
    ids: {
      openalex: `https://openalex.org/${id}`,
      ...(doi ? { doi: `https://doi.org/${doi}` } : {}),
    },
  };
}

const seed = work("W1", "Seed paper", ["W2", "W3"], "10.1000/seed");
const referenceTwo = work("W2", "Reference two");
const referenceThree = work("W3", "Reference three");
const citing = work("W4", "Citing paper", ["W1"]);

function testContext(name: string, rigoriumHome = join(tmpdir(), `${name}-home`), abortSignal?: AbortSignal) {
  return {
    cwd: join(tmpdir(), `${name}-project`),
    env: { RIGORIUM_HOME: rigoriumHome },
    now: () => new Date("2026-07-22T00:00:00.000Z"),
    ...(abortSignal ? { abortSignal } : {}),
  } as any;
}

test("literature_expand rejects missing or malformed strong seed identities before any fetch", async () => {
  let calls = 0;
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(seed);
    },
  });

  for (const invalidSeed of [
    { title: "Display text alone is not an identity" },
    { openAlexId: "https://untrusted.example/W1", doi: "not-a-doi" },
    { openAlexId: "https://untrusted.example/W1", doi: "10.1000/seed" },
    { openAlexId: "W1", doi: "not-a-doi" },
  ]) {
    await assert.rejects(
      () => tool.execute({ seed: invalidSeed }, testContext("rigorium-expand-invalid-seed")),
      (error: unknown) => error instanceof RigoriumToolRuntimeError && error.code === "invalid_tool_input",
    );
  }
  assert.equal(calls, 0);
});

test("literature_expand rejects conflicting strong identities without producing an expansion artifact", async () => {
  const requested: string[] = [];
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input) => {
      const url = String(input);
      requested.push(url);
      if (!new URL(url).searchParams.get("filter")) return jsonResponse(seed);
      throw new Error("Directions must not run after a seed identity conflict.");
    },
  });

  await assert.rejects(
    () => tool.execute(
      { seed: { openAlexId: "W1", doi: "10.1000/conflicting-doi" } },
      testContext("rigorium-expand-conflicting-seed"),
    ),
    (error: unknown) => error instanceof RigoriumToolRuntimeError && error.code === "tool_execution_failed",
  );
  assert.equal(requested.length, 1);
  assert.equal(new URL(requested[0]).searchParams.get("filter"), null);
});

test("literature_expand rejects malicious or noncanonical OpenAlex seed responses before expanding directions", async () => {
  for (const [index, invalidId] of ["https://untrusted.example/W1", "W1"].entries()) {
    let calls = 0;
    const tool = createLiteratureExpandTool({
      endpoint: OPENALEX_TEST_ENDPOINT,
      fetchImpl: async () => {
        calls += 1;
        if (calls > 1) throw new Error("Directions must not run for a noncanonical seed response.");
        return jsonResponse({ ...seed, id: invalidId, ids: { ...seed.ids, openalex: invalidId } });
      },
    });

    await assert.rejects(
      () => tool.execute(
        { seed: { doi: "10.1000/seed" } },
        testContext(`rigorium-expand-invalid-provider-seed-${index}`),
      ),
      (error: unknown) => error instanceof RigoriumToolRuntimeError
        && error.code === "tool_execution_failed"
        && /canonical OpenAlex W identifier/i.test(error.message),
    );
    assert.equal(calls, 1);
  }
});

test("literature_expand reports a null seed payload as a controlled provider failure", async () => {
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async () => jsonResponse(null),
  });

  await assert.rejects(
    () => tool.execute({ seed: { openAlexId: "W1" } }, testContext("rigorium-expand-null-seed")),
    (error: unknown) => error instanceof RigoriumToolRuntimeError
      && error.code === "tool_execution_failed"
      && /malformed seed response/i.test(error.message),
  );
});

test("literature_expand resolves a DOI seed, hydrates references in order, and preserves citation orientation", async () => {
  const requested: string[] = [];
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input) => {
      const url = String(input);
      requested.push(url);
      const parsed = new URL(url);
      const filter = parsed.searchParams.get("filter");
      if (!filter) return jsonResponse(seed);
      if (filter.startsWith("openalex_id:")) return jsonResponse({ meta: { count: 2 }, results: [referenceThree, referenceTwo] });
      if (filter === "cites:W1") return jsonResponse({ meta: { count: 1 }, results: [citing] });
      throw new Error(`Unexpected OpenAlex filter: ${filter}`);
    },
  });

  const result = await tool.execute(
    { seed: { doi: "doi:10.1000/seed", title: "Seed paper" }, limitPerDirection: 2 },
    testContext("rigorium-expand-happy"),
  );

  assert.equal(result.data?.kind, "literature_expansion");
  assert.equal(result.data?.seedPaperId, "https://openalex.org/W1");
  assert.deepEqual(result.data?.papers.map((paper) => paper.id), [
    "https://openalex.org/W1",
    "https://openalex.org/W2",
    "https://openalex.org/W3",
    "https://openalex.org/W4",
  ]);
  assert.equal(result.data?.coverage.status, "complete");
  assert.equal(result.data?.directions.find((direction) => direction.direction === "references")?.status, "ok");
  assert.equal(result.data?.directions.find((direction) => direction.direction === "citations")?.status, "ok");
  assert.deepEqual(result.data?.edges.map((edge) => [edge.source, edge.target]), [
    ["https://openalex.org/W1", "https://openalex.org/W2"],
    ["https://openalex.org/W1", "https://openalex.org/W3"],
    ["https://openalex.org/W4", "https://openalex.org/W1"],
  ]);
  assert.equal(result.data?.edges.every((edge) => edge.type === "citation" && !edge.inferred), true);
  assert.match(requested[0] ?? "", /https%3A%2F%2Fdoi.org%2F10.1000%2Fseed/);
  const referenceRequest = requested.find((url) => new URL(url).searchParams.get("filter")?.startsWith("openalex_id:")) ?? "";
  assert.equal(new URL(referenceRequest).searchParams.get("filter"), "openalex_id:W2|W3");
});

test("literature_expand uses no more than OpenAlex's 100-ID OR filter and reports reference truncation", async () => {
  const references = Array.from({ length: 101 }, (_, index) => `W${index + 2}`);
  const largeSeed = work("W1", "Large seed", references);
  const root = await mkdtemp(join(tmpdir(), "rigorium-expand-or-limit-"));
  const rigoriumHome = join(root, "rigorium-home");
  await writeResearchSettings({
    scope: "global",
    rigoriumHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        budget: { ...DEFAULT_RESEARCH_SETTINGS.literature.budget, maxResultsPerSearch: 100 },
      },
    },
  });
  let referenceFilter = "";
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input) => {
      const filter = new URL(String(input)).searchParams.get("filter");
      if (!filter) return jsonResponse(largeSeed);
      if (filter.startsWith("openalex_id:")) {
        referenceFilter = filter;
        return jsonResponse({ meta: { count: 1 }, results: [work("W2", "Only hydrated reference")] });
      }
      throw new Error(`Unexpected filter: ${filter}`);
    },
  });

  const result = await tool.execute(
    { seed: { openAlexId: "W1" }, directions: ["references"], limitPerDirection: 100 },
    testContext("rigorium-expand-batch", rigoriumHome),
  );

  const direction = result.data?.directions[0];
  assert.equal(referenceFilter.replace("openalex_id:", "").split("|").length, 100);
  assert.equal(direction?.requestedCount, 101);
  assert.equal(direction?.resolvedCount, 1);
  assert.equal(direction?.truncated, true);
  assert.equal(direction?.status, "partial");
  assert.equal(result.data?.coverage.status, "partial");
  assert.match(direction?.warnings?.join(" ") ?? "", /maximum 100 identifiers/i);
});

test("literature_expand retains citing papers when references response is malformed", async () => {
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input) => {
      const filter = new URL(String(input)).searchParams.get("filter");
      if (!filter) return jsonResponse(seed);
      if (filter.startsWith("openalex_id:")) return jsonResponse({ meta: { count: 2 } });
      if (filter === "cites:W1") return jsonResponse({ meta: { count: 1 }, results: [citing] });
      throw new Error(`Unexpected filter: ${filter}`);
    },
  });

  const result = await tool.execute({ seed: { openAlexId: "W1" }, limitPerDirection: 2 }, testContext("rigorium-expand-partial"));
  const references = result.data?.directions.find((direction) => direction.direction === "references");
  const citations = result.data?.directions.find((direction) => direction.direction === "citations");
  assert.equal(result.data?.coverage.status, "partial");
  assert.equal(references?.status, "error");
  assert.match(references?.error ?? "", /malformed/i);
  assert.equal(citations?.status, "ok");
  assert.equal(result.data?.papers.some((paper) => paper.id === "https://openalex.org/W4"), true);
  assert.deepEqual(result.data?.edges.map((edge) => [edge.source, edge.target]), [["https://openalex.org/W4", "https://openalex.org/W1"]]);
});

test("literature_expand retains the successful direction when the other response is null", async () => {
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input) => {
      const filter = new URL(String(input)).searchParams.get("filter");
      if (!filter) return jsonResponse(seed);
      if (filter.startsWith("openalex_id:")) return jsonResponse(null);
      if (filter === "cites:W1") return jsonResponse({ meta: { count: 1 }, results: [citing] });
      throw new Error(`Unexpected filter: ${filter}`);
    },
  });

  const result = await tool.execute({ seed: { openAlexId: "W1" } }, testContext("rigorium-expand-null-direction"));
  const references = result.data?.directions.find((direction) => direction.direction === "references");
  const citations = result.data?.directions.find((direction) => direction.direction === "citations");
  assert.equal(references?.status, "error");
  assert.match(references?.error ?? "", /malformed/i);
  assert.equal(citations?.status, "ok");
  assert.equal(result.data?.coverage.status, "partial");
  assert.equal(result.data?.papers.some((paper) => paper.id === "https://openalex.org/W4"), true);
  assert.deepEqual(result.data?.edges.map((edge) => [edge.source, edge.target]), [["https://openalex.org/W4", "https://openalex.org/W1"]]);
});

test("literature_expand marks a full citation page partial when meta.count is missing", async () => {
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input) => {
      const filter = new URL(String(input)).searchParams.get("filter");
      if (!filter) return jsonResponse(seed);
      if (filter === "cites:W1") return jsonResponse({ results: [citing] });
      throw new Error(`Unexpected filter: ${filter}`);
    },
  });

  const result = await tool.execute(
    { seed: { openAlexId: "W1" }, directions: ["citations"], limitPerDirection: 1 },
    testContext("rigorium-expand-missing-count"),
  );
  const citations = result.data?.directions[0];
  assert.equal(citations?.status, "partial");
  assert.equal(citations?.truncated, true);
  assert.equal(citations?.totalMatches, undefined);
  assert.match(citations?.warnings?.join(" ") ?? "", /meta\.count/i);
  assert.equal(result.data?.coverage.status, "partial");
});

test("literature_expand creates real citation edges only from canonical records that cite the seed", async () => {
  const missingEvidence = work("W5", "Missing citation evidence");
  const noncanonical = {
    ...work("W6", "Noncanonical citing record", ["W1"]),
    id: "W6",
    ids: { openalex: "W6" },
  };
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input) => {
      const filter = new URL(String(input)).searchParams.get("filter");
      if (!filter) return jsonResponse(seed);
      if (filter === "cites:W1") return jsonResponse({
        meta: { count: 4 },
        results: [null, missingEvidence, noncanonical, citing],
      });
      throw new Error(`Unexpected filter: ${filter}`);
    },
  });

  const result = await tool.execute(
    { seed: { openAlexId: "W1" }, directions: ["citations"], limitPerDirection: 4 },
    testContext("rigorium-expand-real-citation-evidence"),
  );
  const citations = result.data?.directions[0];
  assert.equal(citations?.status, "partial");
  assert.equal(citations?.resultCount, 1);
  assert.match(citations?.warnings?.join(" ") ?? "", /3 citing records/i);
  assert.deepEqual(result.data?.papers.map((paper) => paper.id), ["https://openalex.org/W1", "https://openalex.org/W4"]);
  assert.deepEqual(result.data?.edges.map((edge) => [edge.source, edge.target]), [["https://openalex.org/W4", "https://openalex.org/W1"]]);
});

test("literature_expand treats invalid citation counts as unknown coverage", async () => {
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input) => {
      const filter = new URL(String(input)).searchParams.get("filter");
      if (!filter) return jsonResponse(seed);
      if (filter === "cites:W1") return jsonResponse({ meta: { count: -1 }, results: [citing] });
      throw new Error(`Unexpected filter: ${filter}`);
    },
  });

  const result = await tool.execute(
    { seed: { openAlexId: "W1" }, directions: ["citations"], limitPerDirection: 1 },
    testContext("rigorium-expand-invalid-count"),
  );
  const citations = result.data?.directions[0];
  assert.equal(citations?.status, "partial");
  assert.equal(citations?.totalMatches, undefined);
  assert.match(citations?.warnings?.join(" ") ?? "", /invalid meta\.count/i);
  assert.equal(result.data?.coverage.status, "partial");
});

test("literature_expand marks a citation count smaller than the returned page as inconsistent", async () => {
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input) => {
      const filter = new URL(String(input)).searchParams.get("filter");
      if (!filter) return jsonResponse(seed);
      if (filter === "cites:W1") return jsonResponse({ meta: { count: 0 }, results: [citing] });
      throw new Error(`Unexpected filter: ${filter}`);
    },
  });

  const result = await tool.execute(
    { seed: { openAlexId: "W1" }, directions: ["citations"], limitPerDirection: 1 },
    testContext("rigorium-expand-count-underflow"),
  );
  const citations = result.data?.directions[0];
  assert.equal(citations?.status, "partial");
  assert.equal(citations?.truncated, false);
  assert.equal(citations?.totalMatches, 0);
  assert.match(citations?.warnings?.join(" ") ?? "", /meta\.count=0.*returned 1/i);
  assert.equal(result.data?.coverage.status, "partial");
});

test("literature_expand normalizes a negative cited-by count before building the artifact", async () => {
  const negativeSeed = { ...seed, cited_by_count: -1 };
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input) => {
      const filter = new URL(String(input)).searchParams.get("filter");
      if (!filter) return jsonResponse(negativeSeed);
      if (filter === "cites:W1") return jsonResponse({ meta: { count: 1 }, results: [citing] });
      throw new Error(`Unexpected filter: ${filter}`);
    },
  });

  const result = await tool.execute(
    { seed: { openAlexId: "W1" }, directions: ["citations"], limitPerDirection: 1 },
    testContext("rigorium-expand-negative-cited-by"),
  );
  assert.equal(result.data?.papers[0]?.citedByCount, 0);
});

test("literature_expand enforces the per-direction budget when a provider over-returns", async () => {
  const secondCiting = work("W7", "Second citing paper", ["W1"]);
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input) => {
      const filter = new URL(String(input)).searchParams.get("filter");
      if (!filter) return jsonResponse(seed);
      if (filter === "cites:W1") return jsonResponse({ meta: { count: 2 }, results: [citing, secondCiting] });
      throw new Error(`Unexpected filter: ${filter}`);
    },
  });

  const result = await tool.execute(
    { seed: { openAlexId: "W1" }, directions: ["citations"], limitPerDirection: 1 },
    testContext("rigorium-expand-over-page"),
  );
  const citations = result.data?.directions[0];
  assert.equal(citations?.status, "partial");
  assert.equal(citations?.truncated, true);
  assert.equal(citations?.resultCount, 1);
  assert.deepEqual(result.data?.papers.map((paper) => paper.id), ["https://openalex.org/W1", "https://openalex.org/W4"]);
  assert.match(citations?.warnings?.join(" ") ?? "", /only the first 1 were retained/i);
});

test("literature_expand bounds each direction by the Research Settings budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-expand-budget-"));
  const rigoriumHome = join(root, "rigorium-home");
  await writeResearchSettings({
    scope: "global",
    rigoriumHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        search: { ...DEFAULT_RESEARCH_SETTINGS.literature.search, defaultLimit: 1 },
        budget: { ...DEFAULT_RESEARCH_SETTINGS.literature.budget, maxResultsPerSearch: 1 },
      },
    },
  });
  const perPageValues: string[] = [];
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input) => {
      const parsed = new URL(String(input));
      const filter = parsed.searchParams.get("filter");
      if (!filter) return jsonResponse(seed);
      perPageValues.push(parsed.searchParams.get("per-page") ?? "");
      if (filter.startsWith("openalex_id:")) return jsonResponse({ meta: { count: 1 }, results: [referenceTwo] });
      if (filter === "cites:W1") return jsonResponse({ meta: { count: 1 }, results: [citing] });
      throw new Error(`Unexpected filter: ${filter}`);
    },
  });

  const result = await tool.execute(
    { seed: { openAlexId: "W1" }, limitPerDirection: 99 },
    testContext("rigorium-expand-budget", rigoriumHome),
  );
  assert.equal(result.data?.plan.limitPerDirection, 1);
  assert.deepEqual(perPageValues, ["1", "1"]);
});

test("literature_expand preserves a partial artifact when OpenAlex rate limits one direction", async () => {
  let referenceCalls = 0;
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input) => {
      const filter = new URL(String(input)).searchParams.get("filter");
      if (!filter) return jsonResponse(seed);
      if (filter.startsWith("openalex_id:")) {
        referenceCalls += 1;
        return jsonResponse({ error: "rate limited" }, 429, { "retry-after": "60" });
      }
      if (filter === "cites:W1") return jsonResponse({ meta: { count: 1 }, results: [citing] });
      throw new Error(`Unexpected filter: ${filter}`);
    },
  });
  const keepAlive = setInterval(() => undefined, 10);
  const result = await tool.execute({ seed: { openAlexId: "W1" } }, testContext("rigorium-expand-rate"))
    .finally(() => clearInterval(keepAlive));

  assert.equal(referenceCalls, 1);
  assert.equal(result.data?.coverage.status, "partial");
  assert.equal(result.data?.directions.find((direction) => direction.direction === "references")?.status, "error");
  assert.match(result.data?.coverage.warnings.join(" ") ?? "", /429/);
  assert.equal(result.data?.papers.some((paper) => paper.id === "https://openalex.org/W4"), true);
});

test("literature_expand does not retry a seed 429 with a nonzero Retry-After", async () => {
  let calls = 0;
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: "daily credits exhausted" }, 429, { "retry-after": "60" });
    },
  });

  await assert.rejects(
    () => tool.execute({ seed: { openAlexId: "W1" } }, testContext("rigorium-expand-seed-rate")),
    (error: unknown) => error instanceof RigoriumToolRuntimeError
      && error.code === "tool_execution_failed"
      && /429/.test(error.message),
  );
  assert.equal(calls, 1);
});

test("literature_expand records all-direction aborts as a failed artifact while retaining the resolved seed", async () => {
  const controller = new AbortController();
  const tool = createLiteratureExpandTool({
    endpoint: OPENALEX_TEST_ENDPOINT,
    fetchImpl: async (input, init) => {
      const filter = new URL(String(input)).searchParams.get("filter");
      if (!filter) return jsonResponse(seed);
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Request aborted", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    },
  });
  const pending = tool.execute({ seed: { openAlexId: "W1" } }, testContext("rigorium-expand-abort", undefined, controller.signal));
  setTimeout(() => controller.abort(), 5);
  const result = await pending;

  assert.equal(result.data?.coverage.status, "failed");
  assert.equal(result.data?.papers.length, 1);
  assert.equal(result.data?.seedPaperId, "https://openalex.org/W1");
  assert.equal(result.data?.directions.every((direction) => direction.status === "error"), true);
  assert.match(result.data?.coverage.warnings.join(" ") ?? "", /abort/i);
});
