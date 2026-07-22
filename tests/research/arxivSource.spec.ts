import assert from "node:assert/strict";
import test from "node:test";
import {
  createArxivSource,
  inspectArxivRequestGateForTests,
} from "../../src/research/literature/arxivSource.js";
import type { SearchPlan } from "../../src/research/types.js";

const atomNamespaces = [
  "xmlns=\"http://www.w3.org/2005/Atom\"",
  "xmlns:arxiv=\"http://arxiv.org/schemas/atom\"",
  "xmlns:opensearch=\"http://a9.com/-/spec/opensearch/1.1/\"",
].join(" ");

const plan: SearchPlan = {
  query: "research agents",
  limit: 3,
  fromYear: 2023,
  toYear: 2025,
  sort: "cited_by_count",
  classifications: [{ scheme: "arxiv", include: ["cs.AI", "stat.ML"] }],
  sourceIds: ["arxiv"],
};

function atomFeed(entries: string, total = 1, title = "ArXiv Query"): string {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<feed " + atomNamespaces + ">",
    "<title>" + title + "</title>",
    "<id>http://arxiv.org/api/query</id>",
    "<updated>2026-07-22T00:00:00Z</updated>",
    "<opensearch:totalResults>" + total + "</opensearch:totalResults>",
    entries,
    "</feed>",
  ].join("");
}

function paperEntry(id = "2401.12345v2"): string {
  return [
    "<entry>",
    "<id>http://arxiv.org/abs/" + id + "</id>",
    "<updated>2024-01-02T03:04:05Z</updated>",
    "<published>2024-01-01T02:03:04Z</published>",
    "<title> A reliable arXiv paper </title>",
    "<summary> Useful preprint evidence. </summary>",
    "<author><name>Ada Lovelace</name></author>",
    "<author><name>Grace Hopper</name></author>",
    "<arxiv:primary_category term=\"cs.AI\" scheme=\"http://arxiv.org/schemas/atom\"/>",
    "<category term=\"cs.AI\" scheme=\"http://arxiv.org/schemas/atom\"/>",
    "<category term=\"cs.LG\" scheme=\"http://arxiv.org/schemas/atom\"/>",
    "<arxiv:doi>https://doi.org/10.1000/Example</arxiv:doi>",
    "<arxiv:journal_ref>Journal of Reliable Systems</arxiv:journal_ref>",
    "</entry>",
  ].join("");
}

function atomResponse(entries = paperEntry(), total = 1, title?: string): Response {
  return new Response(atomFeed(entries, total, title), {
    headers: { "content-type": "application/atom+xml; charset=utf-8" },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("arXiv source normalizes Atom metadata, submission filters, categories, and citation-sort downgrade", async () => {
  let requested = new URL("https://example.test");
  const source = createArxivSource({
    endpoint: "https://arxiv.test/api/normalization",
    minimumIntervalMs: 1,
    fetchImpl: async (input) => {
      requested = new URL(String(input));
      return atomResponse();
    },
  });

  const result = await source.search(plan, { now: () => new Date("2026-07-22T00:00:00.000Z") });

  assert.equal(result.source.status, "ok");
  assert.equal(result.source.totalMatches, 1);
  assert.deepEqual(result.source.applied, {
    dateField: "submitted",
    sort: "relevance:descending",
    classifications: ["cs.AI", "stat.ML"],
  });
  assert.match(result.source.warnings?.[0] ?? "", /cited-by counts/);
  assert.equal(result.papers.length, 1);
  assert.deepEqual(result.edges, []);
  assert.deepEqual(result.papers[0]?.identity, {
    arxiv: "2401.12345",
    arxivVersion: 2,
    doi: "10.1000/example",
  });
  assert.equal(result.papers[0]?.updatedAt, "2024-01-02T03:04:05.000Z");
  assert.equal(result.papers[0]?.publicationDate, "2024-01-01T02:03:04.000Z");
  assert.equal(result.papers[0]?.venue, "Journal of Reliable Systems");
  assert.deepEqual(result.papers[0]?.topics.map((topic) => topic.name), ["cs.AI", "cs.LG"]);
  assert.equal(result.papers[0]?.provenance[0]?.sourceRecordId, "2401.12345v2");

  assert.equal(requested.searchParams.get("sortBy"), "relevance");
  assert.equal(requested.searchParams.get("sortOrder"), "descending");
  const query = requested.searchParams.get("search_query") ?? "";
  assert.match(query, /submittedDate:\[202301010000 TO 202512312359\]/);
  assert.match(query, /\(cat:cs\.AI OR cat:stat\.ML\)/);
});

test("arXiv source handles normal empty feeds and documented one-entry error feeds", async () => {
  const empty = createArxivSource({
    endpoint: "https://arxiv.test/api/empty",
    minimumIntervalMs: 1,
    fetchImpl: async () => atomResponse("", 0),
  });
  const emptyResult = await empty.search({ ...plan, sort: "relevance" });
  assert.equal(emptyResult.source.status, "ok");
  assert.equal(emptyResult.source.totalMatches, 0);
  assert.equal(emptyResult.papers.length, 0);

  const errorEntry = [
    "<entry>",
    "<id>http://arxiv.org/api/errors/1</id>",
    "<title>Error</title>",
    "<summary>Unsupported query field</summary>",
    "</entry>",
  ].join("");
  const error = createArxivSource({
    endpoint: "https://arxiv.test/api/error-feed",
    minimumIntervalMs: 1,
    fetchImpl: async () => atomResponse(errorEntry, 1),
  });
  const errorResult = await error.search(plan);
  assert.equal(errorResult.source.status, "error");
  assert.match(errorResult.source.error ?? "", /Unsupported query field/);

  const normalErrorTitle = createArxivSource({
    endpoint: "https://arxiv.test/api/normal-error-title",
    minimumIntervalMs: 1,
    fetchImpl: async () => atomResponse(
      paperEntry("2401.54321v1").replace("A reliable arXiv paper", "Error"),
      1,
    ),
  });
  const normalErrorTitleResult = await normalErrorTitle.search(plan);
  assert.equal(normalErrorTitleResult.source.status, "ok");
  assert.equal(normalErrorTitleResult.papers[0]?.title, "Error");
});

test("arXiv source does not misclassify a normal feed whose title contains error", async () => {
  const source = createArxivSource({
    endpoint: "https://arxiv.test/api/title-error",
    minimumIntervalMs: 1,
    fetchImpl: async () => atomResponse(paperEntry(), 1, "ArXiv Query: error correction"),
  });
  const result = await source.search(plan);
  assert.equal(result.source.status, "ok");
  assert.equal(result.papers.length, 1);
});

test("arXiv source rejects unsafe, malformed, invalid-namespace, and too-deep XML before normalizing papers", async () => {
  const cases: Array<{ name: string; body: string; expected: RegExp; options?: Parameters<typeof createArxivSource>[0] }> = [
    {
      name: "doctype",
      body: "<!DOCTYPE feed><feed " + atomNamespaces + "></feed>",
      expected: /forbidden DOCTYPE or ENTITY/i,
    },
    {
      name: "malformed",
      body: "<feed " + atomNamespaces + "><entry></feed>",
      expected: /Missing end tag|XML/i,
    },
    {
      name: "namespace",
      body: "<feed xmlns=\"http://example.test\"><title>ArXiv Query</title></feed>",
      expected: /Atom namespace/i,
    },
    {
      name: "depth",
      body: atomFeed("<entry><a><b><c><d><e><f><g><h><i></i></h></g></f></e></d></c></b></a></entry>"),
      expected: /depth limit/i,
      options: { maxXmlDepth: 5 },
    },
  ];

  for (const item of cases) {
    const source = createArxivSource({
      endpoint: "https://arxiv.test/api/security-" + item.name,
      minimumIntervalMs: 1,
      ...item.options,
      fetchImpl: async () => new Response(item.body),
    });
    const result = await source.search(plan);
    assert.equal(result.source.status, "error", item.name);
    assert.match(result.source.error ?? "", item.expected, item.name);
  }
});

test("arXiv XML lexical preflight skips inert markup and rejects deep or entry-flood documents before parsing", async () => {
  const inertMarkup = [
    "<!-- <entry><entry><entry> -->",
    "<?note <entry>?>",
    "<![CDATA[<entry><entry><entry>]]>",
    paperEntry(),
  ].join("");
  const inert = createArxivSource({
    endpoint: "https://arxiv.test/api/preflight-inert",
    minimumIntervalMs: 1,
    maxEntries: 1,
    fetchImpl: async () => atomResponse(inertMarkup),
  });
  const inertResult = await inert.search({ ...plan, sort: "relevance" });
  assert.equal(inertResult.source.status, "ok");
  assert.equal(inertResult.papers.length, 1);

  const deepMarkup = "<node>".repeat(512) + "</node>".repeat(512);
  const deep = createArxivSource({
    endpoint: "https://arxiv.test/api/preflight-depth",
    minimumIntervalMs: 1,
    maxXmlDepth: 8,
    fetchImpl: async () => atomResponse(deepMarkup),
  });
  const deepResult = await deep.search({ ...plan, sort: "relevance" });
  assert.equal(deepResult.source.status, "error");
  assert.match(deepResult.source.error ?? "", /depth limit before parsing/i);

  const entryFlood = createArxivSource({
    endpoint: "https://arxiv.test/api/preflight-entries",
    minimumIntervalMs: 1,
    maxEntries: 2,
    fetchImpl: async () => atomResponse(paperEntry("2401.11111v1") + paperEntry("2401.22222v1") + paperEntry("2401.33333v1"), 3),
  });
  const entryFloodResult = await entryFlood.search({ ...plan, sort: "relevance" });
  assert.equal(entryFloodResult.source.status, "error");
  assert.match(entryFloodResult.source.error ?? "", /2-entry limit before parsing/i);
});

test("arXiv reports that publication_date uses submittedDate", async () => {
  let requested = new URL("https://example.test");
  const source = createArxivSource({
    endpoint: "https://arxiv.test/api/submitted-date-sort",
    minimumIntervalMs: 1,
    fetchImpl: async (input) => {
      requested = new URL(String(input));
      return atomResponse();
    },
  });
  const result = await source.search({ ...plan, sort: "publication_date" });

  assert.equal(requested.searchParams.get("sortBy"), "submittedDate");
  assert.equal(result.source.applied?.sort, "submittedDate:descending");
  assert.match(result.source.warnings?.join(" ") ?? "", /uses submittedDate/i);
});

test("arXiv request gate serializes a same-endpoint FIFO queue at an injected interval", async () => {
  const endpoint = "https://arxiv.test/api/gate";
  const starts: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const source = createArxivSource({
    endpoint,
    minimumIntervalMs: 20,
    fetchImpl: async () => {
      starts.push(Date.now());
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await delay(5);
      active -= 1;
      return atomResponse();
    },
  });

  await Promise.all([source.search({ ...plan, sort: "relevance" }), source.search({ ...plan, sort: "relevance" })]);

  assert.equal(maximumActive, 1);
  assert.equal(starts.length, 2);
  assert.ok(starts[1]! - starts[0]! >= 16, "arXiv requests started too close together");
  assert.equal(inspectArxivRequestGateForTests(endpoint, 20)?.minimumIntervalMs, 20);
});

test("arXiv uses a three-second production request-start interval by default", async () => {
  const endpoint = "https://export.arxiv.org/api/query";
  const startedAt = Date.now();
  const source = createArxivSource({
    endpoint,
    // The public endpoint must not permit a test-only lower interval to
    // weaken arXiv's documented provider limit.
    minimumIntervalMs: 1,
    fetchImpl: async () => atomResponse(),
  });
  const result = await source.search({ ...plan, sort: "relevance" });
  const gate = inspectArxivRequestGateForTests(endpoint, 1);

  assert.equal(result.source.status, "ok");
  assert.equal(gate?.minimumIntervalMs, 3_000);
  assert.ok((gate?.nextRequestStartAt ?? 0) - startedAt >= 2_900);
});

test("arXiv shares a same-endpoint queue across interval options and only tightens its interval", async () => {
  const endpoint = "https://arxiv.test/api/gate-tightening";
  const starts: number[] = [];
  let active = 0;
  let maximumActive = 0;
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const fetchImpl: typeof fetch = async () => {
    starts.push(Date.now());
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (starts.length === 1) markFirstStarted?.();
    await delay(5);
    active -= 1;
    return atomResponse();
  };
  const permissive = createArxivSource({ endpoint, minimumIntervalMs: 1, fetchImpl });
  const first = permissive.search({ ...plan, sort: "relevance" });
  await firstStarted;

  const stricter = createArxivSource({ endpoint, minimumIntervalMs: 45, fetchImpl });
  const second = stricter.search({ ...plan, sort: "relevance" });
  await Promise.all([first, second]);

  assert.equal(maximumActive, 1);
  assert.equal(starts.length, 2);
  assert.ok(starts[1]! - starts[0]! >= 36, "a stricter same-endpoint interval was not retained");
  assert.equal(inspectArxivRequestGateForTests(endpoint)?.minimumIntervalMs, 45);
});

test("arXiv gate isolates endpoint test doubles while retaining per-endpoint single connection", async () => {
  let active = 0;
  let maximumActive = 0;
  const fetchImpl: typeof fetch = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await delay(20);
    active -= 1;
    return atomResponse();
  };
  const left = createArxivSource({
    endpoint: "https://arxiv.test/api/gate-left",
    minimumIntervalMs: 50,
    fetchImpl,
  });
  const right = createArxivSource({
    endpoint: "https://arxiv.test/api/gate-right",
    minimumIntervalMs: 50,
    fetchImpl,
  });

  await Promise.all([left.search({ ...plan, sort: "relevance" }), right.search({ ...plan, sort: "relevance" })]);
  assert.equal(maximumActive, 2);
});

test("arXiv gate aborts a queued request without issuing a second fetch", async () => {
  let calls = 0;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const source = createArxivSource({
    endpoint: "https://arxiv.test/api/gate-abort",
    minimumIntervalMs: 30,
    fetchImpl: async () => {
      calls += 1;
      markStarted?.();
      await delay(60);
      return atomResponse();
    },
  });

  const first = source.search({ ...plan, sort: "relevance" });
  await started;
  const controller = new AbortController();
  const second = source.search({ ...plan, sort: "relevance" }, { signal: controller.signal });
  controller.abort(new Error("test queue abort"));
  const aborted = await second;
  await first;

  assert.equal(calls, 1);
  assert.equal(aborted.source.status, "error");
  assert.match(aborted.source.error ?? "", /aborted/i);
});

test("arXiv waits for an aborting fetch implementation to settle before releasing its permit", async () => {
  let calls = 0;
  let firstTransportClosed = false;
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const source = createArxivSource({
    endpoint: "https://arxiv.test/api/delayed-fetch-abort",
    minimumIntervalMs: 1,
    timeoutMs: 1_000,
    fetchImpl: async (_input, init) => {
      calls += 1;
      if (calls > 1) {
        assert.equal(firstTransportClosed, true, "second request started before the first transport actually closed");
        return atomResponse();
      }
      markFirstStarted?.();
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const settleAfterTransportClose = () => {
          setTimeout(() => {
            firstTransportClosed = true;
            reject(new Error("test transport closed after abort"));
          }, 35);
        };
        if (signal?.aborted) settleAfterTransportClose();
        else signal?.addEventListener("abort", settleAfterTransportClose, { once: true });
      });
    },
  });

  const controller = new AbortController();
  const first = source.search({ ...plan, sort: "relevance" }, { signal: controller.signal });
  await firstStarted;
  controller.abort(new Error("test fetch abort"));
  const second = source.search({ ...plan, sort: "relevance" });
  const [aborted, recovered] = await Promise.all([first, second]);

  assert.equal(aborted.source.status, "error");
  assert.match(aborted.source.error ?? "", /abort/i);
  assert.equal(recovered.source.status, "ok");
  assert.equal(calls, 2);
});

test("arXiv waits for delayed reader cancellation to settle before starting the next request", async () => {
  let calls = 0;
  let cancellationSettled = false;
  let markReadStarted: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const source = createArxivSource({
    endpoint: "https://arxiv.test/api/delayed-reader-cancel",
    minimumIntervalMs: 1,
    timeoutMs: 25,
    fetchImpl: async () => {
      calls += 1;
      if (calls > 1) {
        assert.equal(cancellationSettled, true, "second request started before reader.cancel settled");
        return atomResponse();
      }
      return new Response(new ReadableStream<Uint8Array>({
        pull: () => {
          markReadStarted?.();
          return new Promise<void>(() => undefined);
        },
        cancel: () => new Promise<void>((resolve) => {
          setTimeout(() => {
            cancellationSettled = true;
            resolve();
          }, 35);
        }),
      }));
    },
  });

  const first = source.search({ ...plan, sort: "relevance" });
  await readStarted;
  const second = source.search({ ...plan, sort: "relevance" });
  const [timedOut, recovered] = await Promise.all([first, second]);

  assert.equal(timedOut.source.status, "error");
  assert.match(timedOut.source.error ?? "", /body timed out/);
  assert.equal(recovered.source.status, "ok");
  assert.equal(calls, 2);
});

test("arXiv poisons a gate when reader cancellation rejects and lets queued callers abort safely", async () => {
  const endpoint = "https://arxiv.test/api/reader-cancel-reject";
  let calls = 0;
  let markReadStarted: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const source = createArxivSource({
    endpoint,
    minimumIntervalMs: 1,
    timeoutMs: 20,
    fetchImpl: async () => {
      calls += 1;
      if (calls > 1) assert.fail("a poisoned arXiv gate must not issue a second fetch");
      return new Response(new ReadableStream<Uint8Array>({
        pull: () => {
          markReadStarted?.();
          return new Promise<void>(() => undefined);
        },
        cancel: () => Promise.reject(new Error("transport cancel was rejected")),
      }));
    },
  });

  const first = source.search({ ...plan, sort: "relevance" });
  await readStarted;
  const failed = await first;
  assert.equal(failed.source.status, "error");
  assert.match(failed.source.error ?? "", /cancellation could not be confirmed/i);
  assert.equal(inspectArxivRequestGateForTests(endpoint)?.poisoned, true);

  const controller = new AbortController();
  const queued = source.search({ ...plan, sort: "relevance" }, { signal: controller.signal });
  await delay(10);
  assert.equal(calls, 1);
  controller.abort(new Error("stop waiting on poisoned gate"));
  const aborted = await queued;
  assert.equal(aborted.source.status, "error");
  assert.match(aborted.source.error ?? "", /aborted/i);
  assert.equal(calls, 1);
});

test("arXiv poisons a gate when an oversized response body rejects cancellation", async () => {
  const endpoint = "https://arxiv.test/api/body-cancel-reject";
  let calls = 0;
  const source = createArxivSource({
    endpoint,
    minimumIntervalMs: 1,
    maxResponseBytes: 8,
    fetchImpl: async () => {
      calls += 1;
      if (calls > 1) assert.fail("a poisoned arXiv gate must not issue a second fetch");
      return new Response(new ReadableStream<Uint8Array>({
        cancel: () => Promise.reject(new Error("body cancellation was rejected")),
      }), { headers: { "content-length": "999" } });
    },
  });

  const failed = await source.search({ ...plan, sort: "relevance" });
  assert.equal(failed.source.status, "error");
  assert.match(failed.source.error ?? "", /response body cancellation could not be confirmed/i);
  assert.equal(inspectArxivRequestGateForTests(endpoint)?.poisoned, true);

  const controller = new AbortController();
  const queued = source.search({ ...plan, sort: "relevance" }, { signal: controller.signal });
  await delay(10);
  assert.equal(calls, 1);
  controller.abort(new Error("stop waiting on poisoned gate"));
  const aborted = await queued;
  assert.equal(aborted.source.status, "error");
  assert.match(aborted.source.error ?? "", /aborted/i);
  assert.equal(calls, 1);
});

test("arXiv does not retry HTTP 429 and bounds oversized or stalled response bodies", async () => {
  let rateCalls = 0;
  const rateLimited = createArxivSource({
    endpoint: "https://arxiv.test/api/rate-limited",
    minimumIntervalMs: 1,
    fetchImpl: async () => {
      rateCalls += 1;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
    },
  });
  const rateResult = await rateLimited.search(plan);
  assert.equal(rateCalls, 1);
  assert.equal(rateResult.source.status, "error");
  assert.match(rateResult.source.error ?? "", /429/);

  const oversized = createArxivSource({
    endpoint: "https://arxiv.test/api/oversized",
    minimumIntervalMs: 1,
    maxResponseBytes: 24,
    fetchImpl: async () => atomResponse(),
  });
  const oversizedResult = await oversized.search(plan);
  assert.equal(oversizedResult.source.status, "error");
  assert.match(oversizedResult.source.error ?? "", /24-byte limit/);

  let cancelled = false;
  let stalledCalls = 0;
  const stalled = createArxivSource({
    endpoint: "https://arxiv.test/api/stalled",
    minimumIntervalMs: 1,
    timeoutMs: 30,
    fetchImpl: async () => {
      stalledCalls += 1;
      if (stalledCalls > 1) return atomResponse();
      return new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel: () => {
          cancelled = true;
        },
      }));
    },
  });
  const stalledResult = await stalled.search(plan);
  const recovered = await stalled.search(plan);
  assert.equal(stalledResult.source.status, "error");
  assert.match(stalledResult.source.error ?? "", /body timed out/);
  assert.equal(cancelled, true);
  assert.equal(recovered.source.status, "ok");
  assert.equal(stalledCalls, 2);
});
