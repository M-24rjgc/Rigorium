import assert from "node:assert/strict";
import test from "node:test";
import { createZoteroCloudProvider } from "../../src/research/library/zoteroCloudProvider.js";
import type {
  ZoteroCloudSettings,
  ZoteroCloudTransport,
  ZoteroCloudTransportRequest,
  ZoteroCloudTransportResponse,
} from "../../src/research/types.js";

const writableAccess = {
  user: { library: true, write: true },
  groups: { all: { library: true, write: true } },
};

const cloudConfig: ZoteroCloudSettings = {
  enabled: true,
  libraryType: "user",
  libraryId: null,
};

function response(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): ZoteroCloudTransportResponse {
  return { status, body, headers };
}

function item(input: {
  key: string;
  version: number;
  itemType?: string;
  tags?: string[];
  note?: string;
}) {
  return {
    key: input.key,
    version: input.version,
    data: {
      key: input.key,
      itemType: input.itemType ?? "journalArticle",
      tags: (input.tags ?? []).map((tag) => ({ tag })),
      ...(input.note === undefined ? {} : { note: input.note }),
    },
  };
}

function createMockProvider(
  handler: (input: ZoteroCloudTransportRequest, calls: ZoteroCloudTransportRequest[]) => ZoteroCloudTransportResponse | Promise<ZoteroCloudTransportResponse>,
  options: {
    config?: ZoteroCloudSettings;
    now?: () => Date;
    planTtlMs?: number;
    createPlanId?: () => string;
  } = {},
) {
  const calls: ZoteroCloudTransportRequest[] = [];
  const transport: ZoteroCloudTransport = {
    async request(input) {
      calls.push(input);
      return handler(input, calls);
    },
  };
  return {
    provider: createZoteroCloudProvider({
      transport,
      config: options.config ?? cloudConfig,
      now: options.now ?? (() => new Date("2026-07-22T00:00:00.000Z")),
      planTtlMs: options.planTtlMs,
      createPlanId: options.createPlanId ?? (() => "plan-1"),
    }),
    calls,
  };
}

function statusRoutes(input: ZoteroCloudTransportRequest): ZoteroCloudTransportResponse | undefined {
  if (input.path === "/keys/current") {
    return response(200, { userID: 42, access: writableAccess });
  }
  if (input.path === "/users/42/items?format=versions&limit=1") {
    return response(200, { ITEM1: 7 }, { "Last-Modified-Version": "17" });
  }
  return undefined;
}

test("cloud provider verifies a user library and sends only relative, credential-free requests", async () => {
  const secret = "never-put-this-in-a-domain-request";
  const { provider, calls } = createMockProvider((input) => {
    const routed = statusRoutes(input);
    if (routed) return routed;
    throw new Error(`Zotero-API-Key: ${secret}`);
  });

  const status = await provider.getStatus();
  assert.equal(status.status, "ready");
  assert.equal(status.library?.path, "/users/42");
  assert.equal(status.libraryVersion, 17);
  assert.equal(status.writable, true);
  assert.ok(calls.every((call) => call.path.startsWith("/") && !call.path.includes("://")));
  assert.ok(calls.every((call) => JSON.stringify(call).includes(secret) === false));
  assert.ok(JSON.stringify(status).includes(secret) === false);
});

test("cloud provider resolves configured group paths and read-only credentials", async () => {
  const config: ZoteroCloudSettings = { enabled: true, libraryType: "group", libraryId: "99" };
  const { provider, calls } = createMockProvider((input) => {
    if (input.path === "/keys/current") {
      return response(200, {
        userID: 42,
        access: { user: { library: true, write: true }, groups: { "99": { library: true, write: false } } },
      });
    }
    if (input.path === "/groups/99/items?format=versions&limit=1") {
      return response(200, {}, { "Last-Modified-Version": "8" });
    }
    return response(404);
  }, { config });

  const status = await provider.getStatus();
  assert.equal(status.status, "read_only");
  assert.equal(status.library?.path, "/groups/99");
  assert.equal(status.writable, false);
  assert.equal(calls[1]?.path, "/groups/99/items?format=versions&limit=1");
});

test("cloud provider classifies 403 and 429 plus Backoff without exposing response bodies", async () => {
  const forbidden = createMockProvider(() => response(403, "credential data must not leak"));
  const forbiddenStatus = await forbidden.provider.getStatus();
  assert.equal(forbiddenStatus.status, "error");
  assert.equal(forbiddenStatus.error?.includes("credential data"), false);

  const limited = createMockProvider((input) => {
    if (input.path === "/keys/current") return response(200, { userID: 42, access: writableAccess });
    return response(429, "sensitive", { "Retry-After": "12", Backoff: "30" });
  });
  const limitedStatus = await limited.provider.getStatus();
  assert.equal(limitedStatus.status, "rate_limited");
  assert.equal(limitedStatus.retryAfterSeconds, 12);
  assert.equal(limitedStatus.backoffSeconds, 30);
  assert.equal(limitedStatus.error?.includes("sensitive"), false);
});

test("tag plans are preview-only until confirmed, use an item version, and normalize partial batch outcomes", async () => {
  let writes = 0;
  const { provider, calls } = createMockProvider((input) => {
    const routed = statusRoutes(input);
    if (routed) return routed;
    if (input.path === "/users/42/items/ITEM1" && input.method === "GET") {
      return response(200, item({ key: "ITEM1", version: 9, tags: ["Core"] }));
    }
    if (input.path === "/users/42/items/ITEM1" && input.method === "PATCH") {
      writes += 1;
      assert.equal(input.headers?.["If-Unmodified-Since-Version"], "9");
      assert.deepEqual(input.body, { tags: [{ tag: "Core" }, { tag: "New" }] });
      return response(200, {
        successful: { "0": { key: "ITEM1", version: 10 } },
        failed: { "1": { code: 400, message: "one item was malformed" } },
      }, { "Last-Modified-Version": "10" });
    }
    return response(404);
  });

  const plan = await provider.createWritePlan({ kind: "tags", itemKey: "item1", operation: "add", tags: ["New", "new"] });
  assert.equal(plan.kind, "tags");
  if (plan.kind !== "tags") assert.fail("Expected a tag write plan.");
  assert.deepEqual(plan.beforeTags, ["Core"]);
  assert.deepEqual(plan.afterTags, ["Core", "New"]);
  assert.equal(writes, 0);

  const waiting = await provider.executeWritePlan({ plan, confirmed: false });
  assert.equal(waiting.status, "confirmation_required");
  assert.equal(writes, 0);

  const result = await provider.executeWritePlan({ plan, confirmed: true });
  assert.equal(writes, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.successful[0]?.key, "ITEM1");
  assert.equal(result.failed[0]?.code, 400);
  assert.equal(result.libraryVersion, 10);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
});

test("a 412 tag write rereads, merges set semantics, and retries exactly once", async () => {
  let itemReads = 0;
  let patches = 0;
  const { provider } = createMockProvider((input) => {
    const routed = statusRoutes(input);
    if (routed) return routed;
    if (input.path === "/users/42/items/ITEM1" && input.method === "GET") {
      itemReads += 1;
      return response(200, item(itemReads === 1
        ? { key: "ITEM1", version: 9, tags: ["Base"] }
        : { key: "ITEM1", version: 10, tags: ["Base", "Remote"] }));
    }
    if (input.path === "/users/42/items/ITEM1" && input.method === "PATCH") {
      patches += 1;
      if (patches === 1) {
        assert.equal(input.headers?.["If-Unmodified-Since-Version"], "9");
        return response(412);
      }
      assert.equal(input.headers?.["If-Unmodified-Since-Version"], "10");
      assert.deepEqual(input.body, { tags: [{ tag: "Base" }, { tag: "Remote" }, { tag: "Local" }] });
      return response(204, undefined, { "Last-Modified-Version": "11" });
    }
    return response(404);
  });

  const plan = await provider.createWritePlan({ kind: "tags", itemKey: "ITEM1", operation: "add", tags: ["Local"] });
  const result = await provider.executeWritePlan({ plan, confirmed: true });
  assert.equal(result.status, "succeeded");
  assert.equal(result.retryCount, 1);
  assert.equal(patches, 2);
  assert.equal(itemReads, 2);
});

test("cloud write results preserve Zotero concurrency and availability statuses", async () => {
  const cases: Array<{
    httpStatus: number;
    expected: "forbidden" | "not_found" | "locked" | "precondition_required" | "rate_limited";
  }> = [
    { httpStatus: 403, expected: "forbidden" },
    { httpStatus: 404, expected: "not_found" },
    { httpStatus: 409, expected: "locked" },
    { httpStatus: 428, expected: "precondition_required" },
    { httpStatus: 429, expected: "rate_limited" },
  ];

  for (const entry of cases) {
    const { provider } = createMockProvider((input) => {
      const routed = statusRoutes(input);
      if (routed) return routed;
      if (input.path === "/users/42/items/ITEM1" && input.method === "GET") {
        return response(200, item({ key: "ITEM1", version: 9, tags: ["Base"] }));
      }
      if (input.path === "/users/42/items/ITEM1" && input.method === "PATCH") {
        return response(entry.httpStatus, undefined, entry.httpStatus === 429
          ? { "Retry-After": "7", Backoff: "13" }
          : {});
      }
      return response(404);
    }, { createPlanId: () => `plan-${entry.httpStatus}` });

    const plan = await provider.createWritePlan({ kind: "tags", itemKey: "ITEM1", operation: "add", tags: ["Local"] });
    const result = await provider.executeWritePlan({ plan, confirmed: true });
    assert.equal(result.status, entry.expected, `HTTP ${entry.httpStatus}`);
    if (entry.httpStatus === 429) {
      assert.equal(result.retryAfterSeconds, 7);
      assert.equal(result.backoffSeconds, 13);
    }
  }
});

test("note text conflicts never overwrite remote text after a 412", async () => {
  let noteReads = 0;
  let patches = 0;
  const { provider } = createMockProvider((input) => {
    const routed = statusRoutes(input);
    if (routed) return routed;
    if (input.path === "/users/42/items/NOTE1" && input.method === "GET") {
      noteReads += 1;
      return response(200, item(noteReads === 1
        ? { key: "NOTE1", version: 4, itemType: "note", note: "<p>base</p>" }
        : { key: "NOTE1", version: 5, itemType: "note", note: "<p>remote</p>" }));
    }
    if (input.path === "/users/42/items/NOTE1" && input.method === "PATCH") {
      patches += 1;
      assert.equal(input.headers?.["If-Unmodified-Since-Version"], "4");
      assert.deepEqual(input.body, { note: "<p>local</p>" });
      return response(412);
    }
    return response(404);
  });

  const plan = await provider.createWritePlan({ kind: "note", operation: "update", noteKey: "note1", html: "<p>local</p>" });
  const result = await provider.executeWritePlan({ plan, confirmed: true });
  assert.equal(result.status, "conflict");
  assert.equal(result.conflict?.kind, "note");
  assert.equal(result.conflict?.remoteHtml, "<p>remote</p>");
  assert.equal(result.conflict?.localHtml, "<p>local</p>");
  assert.equal(patches, 1);
  assert.equal(noteReads, 2);
});

test("create note plans use a library version precondition and expired plans cannot write", async () => {
  let now = 0;
  let writes = 0;
  const { provider } = createMockProvider((input) => {
    const routed = statusRoutes(input);
    if (routed) return routed;
    if (input.path === "/users/42/items/PARENT1" && input.method === "GET") {
      return response(200, item({ key: "PARENT1", version: 3 }));
    }
    if (input.method === "POST") {
      writes += 1;
      assert.equal(input.headers?.["If-Unmodified-Since-Version"], "17");
      assert.equal(input.headers?.["Zotero-Write-Token"], undefined);
      assert.deepEqual(input.body, [{ itemType: "note", parentItem: "PARENT1", note: "<p>new</p>" }]);
      return response(200, { successful: { "0": { key: "NOTE1", version: 18 } } }, { "Last-Modified-Version": "18" });
    }
    return response(404);
  }, {
    now: () => new Date(now),
    planTtlMs: 10,
  });

  const plan = await provider.createWritePlan({ kind: "note", operation: "create", parentItemKey: "parent1", html: "<p>new</p>" });
  assert.equal(plan.kind, "note");
  assert.equal(plan.operation, "create");
  assert.equal("writeToken" in plan, false);
  const succeeded = await provider.executeWritePlan({ plan, confirmed: true });
  assert.equal(succeeded.status, "succeeded");
  assert.equal(writes, 1);

  const expiringPlan = await provider.createWritePlan({ kind: "note", operation: "create", parentItemKey: "parent1", html: "<p>new</p>" });
  now = 10;
  const result = await provider.executeWritePlan({ plan: expiringPlan, confirmed: true });
  assert.equal(result.status, "error");
  assert.equal(writes, 1);
});

test("incremental sync sends versions and conditional reads, preserving a 304 as unchanged", async () => {
  const { provider, calls } = createMockProvider((input) => {
    const routed = statusRoutes(input);
    if (routed) return routed;
    if (input.path === "/users/42/items?format=versions&since=7") return response(304);
    if (input.path === "/users/42/collections?format=versions&since=7") return response(304);
    if (input.path === "/users/42/deleted?since=7") return response(304);
    return response(404);
  });

  const result = await provider.probeIncrementalSync({ sinceVersion: 7 });
  assert.equal(result.status, "unchanged");
  assert.deepEqual(result.itemVersions, {});
  assert.deepEqual(result.collectionVersions, {});
  assert.deepEqual(result.deleted, { items: [], collections: [], searches: [] });
  const syncCalls = calls.filter((call) => call.path.includes("since=7"));
  assert.equal(syncCalls.length, 3);
  assert.ok(syncCalls.every((call) => call.headers?.["If-Modified-Since-Version"] === "7"));
});

test("incremental sync retains versions and deleted records from successful responses", async () => {
  const { provider } = createMockProvider((input) => {
    const routed = statusRoutes(input);
    if (routed) return routed;
    if (input.path === "/users/42/items?format=versions&since=7") {
      return response(200, { ITEM1: 8 }, { "Last-Modified-Version": "9", Backoff: "4" });
    }
    if (input.path === "/users/42/collections?format=versions&since=7") {
      return response(200, { COLL1: 9 }, { "Last-Modified-Version": "9" });
    }
    if (input.path === "/users/42/deleted?since=7") {
      return response(200, { items: ["OLD1"], collections: ["OLD-C"], searches: ["OLD-S"] }, { "Last-Modified-Version": "9" });
    }
    return response(404);
  });

  const result = await provider.probeIncrementalSync({ sinceVersion: 7 });
  assert.equal(result.status, "updated");
  assert.deepEqual(result.itemVersions, { ITEM1: 8 });
  assert.deepEqual(result.collectionVersions, { COLL1: 9 });
  assert.deepEqual(result.deleted.items, ["OLD1"]);
  assert.equal(result.libraryVersion, 17);
  assert.equal(result.backoffSeconds, 4);
});
