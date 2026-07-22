import assert from "node:assert/strict";
import test from "node:test";
import {
  createCrossrefSource,
  inspectCrossrefEndpointGateForTests,
} from "../../src/research/literature/crossrefSource.js";
import type { SearchPlan } from "../../src/research/types.js";

const plan: SearchPlan = {
  query: "research agents",
  limit: 3,
  fromYear: 2023,
  toYear: 2025,
  sort: "cited_by_count",
  sourceIds: ["crossref"],
};

test("Crossref source normalizes DOI metadata and keeps the response surface bounded", async () => {
  let requested = new URL("https://example.test");
  let userAgent = "";
  const source = createCrossrefSource({
    endpoint: "https://api.crossref.test/works",
    mailto: "researcher@example.test",
    fetchImpl: async (input, init) => {
      requested = new URL(String(input));
      userAgent = new Headers(init?.headers).get("user-agent") ?? "";
      return new Response(JSON.stringify({
        message: {
          "total-results": 15,
          items: [{
            DOI: "HTTPS://DOI.ORG/10.1000/ABC",
            title: ["A Crossref metadata paper"],
            author: [{ given: "Ada", family: "Lovelace" }],
            published: { "date-parts": [[2025, 3, 2]] },
            "container-title": ["Metadata Journal"],
            URL: "https://doi.org/10.1000/ABC",
            type: "journal-article",
            "is-referenced-by-count": 9,
            // The adapter must ignore accidental high-cardinality payload
            // fields even when a mocked server sends them.
            abstract: "<jats:p>not consumed</jats:p>",
            reference: [{ DOI: "10.1000/other" }],
            license: [{ URL: "https://example.test/license" }],
          }],
        },
      }), { headers: { "content-type": "application/json" } });
    },
  });

  const result = await source.search(plan, { now: () => new Date("2026-07-22T00:00:00.000Z") });

  assert.equal(result.source.status, "ok");
  assert.equal(result.source.totalMatches, 15);
  assert.equal(result.papers.length, 1);
  assert.equal(result.papers[0]?.id, "https://doi.org/10.1000/abc");
  assert.equal(result.papers[0]?.doi, "10.1000/abc");
  assert.equal(result.papers[0]?.abstract, undefined);
  assert.deepEqual(result.papers[0]?.referencedWorkIds, []);
  assert.deepEqual(result.edges, []);
  assert.deepEqual(result.papers[0]?.provenance, [{
    sourceId: "crossref",
    sourceRecordId: "10.1000/abc",
    rank: 1,
    retrievedAt: "2026-07-22T00:00:00.000Z",
    queryUrl: requested.toString(),
  }]);

  assert.equal(requested.searchParams.get("query.bibliographic"), "research agents");
  assert.equal(requested.searchParams.get("filter"), "from-pub-date:2023-01-01,until-pub-date:2025-12-31");
  assert.equal(requested.searchParams.get("sort"), "is-referenced-by-count");
  assert.equal(requested.searchParams.get("order"), "desc");
  assert.equal(requested.searchParams.get("mailto"), "researcher@example.test");
  const selectedFields = new Set((requested.searchParams.get("select") ?? "").split(","));
  assert.equal(selectedFields.has("abstract"), false);
  assert.equal(selectedFields.has("reference"), false);
  assert.equal(selectedFields.has("license"), false);
  assert.match(userAgent, /mailto:researcher@example\.test/);
});

test("Crossref source returns a structured failed result for malformed API payloads", async () => {
  const source = createCrossrefSource({
    endpoint: "https://api.crossref.test/works",
    fetchImpl: async () => new Response(JSON.stringify({ message: {} })),
  });
  const result = await source.search(plan, { now: () => new Date("2026-07-22T00:00:00.000Z") });

  assert.equal(result.source.status, "error");
  assert.equal(result.papers.length, 0);
  assert.match(result.source.error ?? "", /message\.items/);
});

test("Crossref endpoint gate serializes concurrent searches and dynamically honors provider headers", async () => {
  const starts: number[] = [];
  let active = 0;
  let maximumActive = 0;
  let call = 0;
  const source = createCrossrefSource({
    endpoint: "https://api.crossref.test/rate-gate-dynamic",
    fetchImpl: async () => {
      const index = call++;
      starts.push(Date.now());
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 6));
      active -= 1;
      const headers: Record<string, string> = index === 0
        ? {
            // Synthetic values: the production code derives its interval from
            // headers, rather than embedding a measured Crossref rate.
            "x-rate-limit-limit": "1000",
            "x-rate-limit-interval": "10ms",
            "retry-after": "0.05",
            backoff: "0.04",
          }
        : index === 1
          ? {
              "x-rate-limit-limit": "1",
              "x-rate-limit-interval": "80ms",
            }
          : {
              "x-rate-limit-limit": "1000",
              "x-rate-limit-interval": "10ms",
            };
      return new Response(JSON.stringify({
        message: {
          items: [{
            DOI: `10.1000/rate-gate-${index}`,
            title: [`Rate gate test ${index}`],
            published: { "date-parts": [[2025]] },
          }],
        },
      }), { headers });
    },
  });

  await Promise.all([
    source.search(plan),
    source.search(plan),
    source.search(plan),
  ]);

  assert.equal(maximumActive, 1);
  assert.equal(starts.length, 3);
  // The first response's Retry-After is longer than its Backoff and must
  // defer the second start; the second response then changes the dynamic
  // X-Rate-Limit interval for the third start.
  assert.ok(starts[1]! - starts[0]! >= 40, `expected Retry-After delay, got ${starts[1]! - starts[0]!}ms`);
  assert.ok(starts[2]! - starts[1]! >= 65, `expected updated rate interval, got ${starts[2]! - starts[1]!}ms`);
});

test("Crossref endpoint gate aborts a queued request without issuing another fetch", async () => {
  let calls = 0;
  const source = createCrossrefSource({
    endpoint: "https://api.crossref.test/rate-gate-abort",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        message: {
          items: [{ DOI: "10.1000/rate-gate-abort", title: ["Rate gate abort"] }],
        },
      }), {
        headers: { backoff: "0.3" },
      });
    },
  });
  await source.search(plan);
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 10);
  const result = await source.search(plan, { signal: controller.signal });
  clearTimeout(abortTimer);

  assert.equal(calls, 1);
  assert.equal(result.source.status, "error");
  assert.match(result.source.error ?? "", /aborted while waiting/);
});

test("Crossref records an untruncated Retry-After response without waiting or retrying it", async () => {
  const endpoint = "https://api.crossref.test/rate-gate-retry-after-sixty";
  let calls = 0;
  const source = createCrossrefSource({
    endpoint,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ status: "rate limited" }), {
        status: 429,
        headers: { "retry-after": "60", backoff: "60" },
      });
    },
  });

  const startedAt = Date.now();
  const result = await source.search(plan);
  const elapsedMs = Date.now() - startedAt;
  const state = inspectCrossrefEndpointGateForTests(endpoint);

  assert.equal(calls, 1);
  assert.equal(result.source.status, "error");
  assert.match(result.source.error ?? "", /429/);
  assert.ok(elapsedMs < 1_000, `429 should return to the gate promptly, took ${elapsedMs}ms`);
  assert.ok((state?.nextAllowedAt ?? 0) - Date.now() >= 59_000, "full 60-second provider backoff was not retained");
});

test("Crossref bounds a never-ending response body and releases the endpoint gate", async () => {
  let calls = 0;
  let cancelled = false;
  const source = createCrossrefSource({
    endpoint: "https://api.crossref.test/body-timeout-release",
    timeoutMs: 30,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
          cancel: () => {
            cancelled = true;
          },
        }));
      }
      return validCrossrefResponse("after-timeout");
    },
  });

  const startedAt = Date.now();
  const timedOut = await source.search(plan);
  const elapsedMs = Date.now() - startedAt;
  const recovered = await source.search(plan);

  assert.equal(timedOut.source.status, "error");
  assert.match(timedOut.source.error ?? "", /body timed out/);
  assert.equal(cancelled, true);
  assert.ok(elapsedMs < 500, `body timeout did not complete promptly: ${elapsedMs}ms`);
  assert.equal(recovered.source.status, "ok");
  assert.equal(calls, 2);
});

test("Crossref cancels a response body when the caller aborts and does not strand later requests", async () => {
  let calls = 0;
  let cancelled = false;
  let markReadStarted: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const source = createCrossrefSource({
    endpoint: "https://api.crossref.test/body-abort-release",
    timeoutMs: 1_000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          pull: () => {
            markReadStarted?.();
            return new Promise<void>(() => undefined);
          },
          cancel: () => {
            cancelled = true;
          },
        }));
      }
      return validCrossrefResponse("after-abort");
    },
  });
  const controller = new AbortController();
  const pending = source.search(plan, { signal: controller.signal });
  await readStarted;
  controller.abort(new Error("test abort"));
  const aborted = await pending;
  const recovered = await source.search(plan);

  assert.equal(aborted.source.status, "error");
  assert.match(aborted.source.error ?? "", /body read was aborted/);
  assert.equal(cancelled, true);
  assert.equal(recovered.source.status, "ok");
  assert.equal(calls, 2);
});

test("Crossref rejects oversized response bodies before JSON parsing", async () => {
  const source = createCrossrefSource({
    endpoint: "https://api.crossref.test/body-size-limit",
    maxResponseBytes: 24,
    fetchImpl: async () => validCrossrefResponse("too-large"),
  });
  const result = await source.search(plan);

  assert.equal(result.source.status, "error");
  assert.match(result.source.error ?? "", /24-byte limit/);
});

function validCrossrefResponse(suffix: string): Response {
  return new Response(JSON.stringify({
    message: {
      items: [{
        DOI: `10.1000/${suffix}`,
        title: [`Crossref ${suffix}`],
      }],
    },
  }));
}
