import assert from "node:assert/strict";
import test from "node:test";
import { createZoteroLibraryProvider, papersToBibtex } from "../../src/research/library/zoteroProvider.js";
import type { ResearchPaper } from "../../src/research/types.js";

const paper: ResearchPaper = {
  id: "https://openalex.org/W1",
  identity: { openAlexId: "https://openalex.org/W1", doi: "10.1000/test" },
  title: "A useful research paper",
  authors: ["Ada Lovelace"],
  year: 2025,
  venue: "Test Venue",
  doi: "10.1000/test",
  url: "https://doi.org/10.1000/test",
  citedByCount: 4,
  topics: [],
  referencedWorkIds: [],
  sourceId: "openalex",
};

test("Zotero provider reports API, connector, and selected collection readiness", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/")) return new Response("ok");
    if (url.endsWith("/connector/ping")) return new Response("ok");
    if (url.endsWith("/connector/getSelectedCollection")) {
      return new Response(JSON.stringify({ libraryID: 1, libraryName: "My Library", collection: { id: "C1", name: "Rigorium" }, editable: true }));
    }
    return new Response("missing", { status: 404 });
  };
  const provider = createZoteroLibraryProvider({ fetchImpl, now: () => new Date("2026-07-22T00:00:00.000Z") });
  const status = await provider.getStatus();
  assert.equal(status.available, true);
  assert.equal(status.apiReady, true);
  assert.equal(status.connectorReady, true);
  assert.equal(status.selectedCollection?.name, "Rigorium");
});

test("Zotero provider reports an unavailable desktop without throwing", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const provider = createZoteroLibraryProvider({
    fetchImpl,
    now: () => new Date("2026-07-22T00:00:00.000Z"),
  });
  const status = await provider.getStatus();

  assert.equal(status.available, false);
  assert.equal(status.apiReady, false);
  assert.equal(status.connectorReady, false);
  assert.match(status.error ?? "", /Local API unavailable/);
  assert.match(status.error ?? "", /Connector unavailable/);
});

test("Zotero writes require explicit confirmation and import BibTeX through the connector", async () => {
  let importBody = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/connector/getSelectedCollection")) {
      return new Response(JSON.stringify({ collection: { id: "C1", name: "Rigorium" } }));
    }
    if (url.includes("/connector/import?session=")) {
      importBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ imported: 1 }));
    }
    return new Response("ok");
  };
  const provider = createZoteroLibraryProvider({ fetchImpl });
  await assert.rejects(provider.importPapers({ papers: [paper], confirmed: false }), /explicit confirmation/);
  const result = await provider.importPapers({ papers: [paper], confirmed: true });
  assert.equal(result.importedCount, 1);
  assert.match(importBody, /@article\{/);
  assert.match(importBody, /doi = \{10\.1000\/test\}/);
  assert.match(papersToBibtex([paper]), /Ada Lovelace/);
});

test("Zotero lists collections and top-level items through Web API v3", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    if (url.includes("/collections?")) {
      return new Response(JSON.stringify([{
        key: "COLL1234",
        library: { id: 1, name: "My Library" },
        meta: { numItems: 1 },
        data: { key: "COLL1234", name: "Project Evidence", parentCollection: false },
      }]), { headers: { "Total-Results": "1", "Content-Type": "application/json" } });
    }
    if (url.includes("/collections/COLL1234/items/top?")) {
      return new Response(JSON.stringify([{
        key: "ITEM1234",
        data: {
          key: "ITEM1234",
          itemType: "journalArticle",
          title: "A useful research paper",
          creators: [{ firstName: "Ada", lastName: "Lovelace" }],
          date: "2025-01-10",
          DOI: "10.1000/test",
          tags: [{ tag: "core" }],
          collections: ["COLL1234"],
        },
      }]), { headers: { "Total-Results": "1", "Content-Type": "application/json" } });
    }
    return new Response("missing", { status: 404 });
  };
  const provider = createZoteroLibraryProvider({ fetchImpl });
  const collections = await provider.listCollections();
  const items = await provider.listItems({ collectionKey: "COLL1234", limit: 25 });

  assert.equal(collections.collections[0]?.name, "Project Evidence");
  assert.equal(collections.collections[0]?.itemCount, 1);
  assert.equal(items.items[0]?.key, "ITEM1234");
  assert.equal(items.items[0]?.doi, "10.1000/test");
  assert.equal(items.items[0]?.creators[0], "Ada Lovelace");
  assert.ok(calls.every((call) => call.headers.get("Zotero-API-Version") === "3"));
});

test("Zotero matches papers by identifiers and reports collection membership", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/items?") && url.includes("10.1000%2Ftest")) {
      return new Response(JSON.stringify([{
        key: "ITEM1234",
        data: {
          key: "ITEM1234",
          itemType: "journalArticle",
          title: paper.title,
          date: "2025",
          DOI: "https://doi.org/10.1000/test",
          creators: [],
          tags: [],
          collections: ["COLL1234"],
        },
      }]), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  };
  const provider = createZoteroLibraryProvider({ fetchImpl });
  const [match] = await provider.matchPapers({ papers: [paper], collectionKey: "COLL1234" });

  assert.equal(match?.matched, true);
  assert.equal(match?.confidence, "exact");
  assert.equal(match?.inCollection, true);
  assert.deepEqual(match?.reasons, ["doi"]);
});

test("Zotero matches a single item response by Zotero item key", async () => {
  const keyedPaper: ResearchPaper = { ...paper, identity: { zoteroKey: "ITEM1234" } };
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/items/ITEM1234?")) {
      return new Response(JSON.stringify({
        key: "ITEM1234",
        data: {
          key: "ITEM1234",
          itemType: "conferencePaper",
          title: keyedPaper.title,
          creators: [],
          tags: [],
          collections: [],
        },
      }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("missing", { status: 404 });
  };
  const provider = createZoteroLibraryProvider({ fetchImpl });
  const [match] = await provider.matchPapers({ papers: [keyedPaper] });

  assert.equal(match?.matched, true);
  assert.deepEqual(match?.reasons, ["zotero_key"]);
});
