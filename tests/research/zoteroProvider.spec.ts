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
  sourceIds: ["openalex"],
  provenance: [{
    sourceId: "openalex",
    sourceRecordId: "https://openalex.org/W1",
    rank: 1,
    retrievedAt: "2026-07-22T00:00:00.000Z",
  }],
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
  assert.equal(status.writeMode, "connector_import");
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
  assert.equal(status.writeMode, "read_only");
  assert.match(status.error ?? "", /Local API unavailable/);
  assert.match(status.error ?? "", /Connector unavailable/);
});

test("Zotero provider reports read-only when only the Local API is available", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/")) return new Response("ok");
    if (url.endsWith("/connector/ping")) return new Response("connector unavailable", { status: 503 });
    return new Response("missing", { status: 404 });
  };
  const provider = createZoteroLibraryProvider({ fetchImpl });
  const status = await provider.getStatus();

  assert.equal(status.available, true);
  assert.equal(status.apiReady, true);
  assert.equal(status.connectorReady, false);
  assert.equal(status.writeMode, "read_only");
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

test("Zotero pages top-level item reads with a read-only continuation", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const itemAt = (index: number) => ({
    key: `ITEM${index}`,
    data: {
      key: `ITEM${index}`,
      itemType: "journalArticle",
      title: `Research item ${index}`,
    },
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method });
    if (url.includes("start=100")) {
      return new Response(JSON.stringify(Array.from({ length: 25 }, (_, index) => itemAt(index + 100))), {
        headers: { "Total-Results": "132", "Content-Type": "application/json" },
      });
    }
    if (url.includes("start=125")) {
      return new Response(JSON.stringify(Array.from({ length: 7 }, (_, index) => itemAt(index + 125))), {
        headers: { "Total-Results": "132", "Content-Type": "application/json" },
      });
    }
    return new Response("missing", { status: 404 });
  };
  const provider = createZoteroLibraryProvider({ fetchImpl });

  const firstPage = await provider.listItems({ collectionKey: "COLL1234", limit: 25, start: 100 });
  const lastPage = await provider.listItems({
    collectionKey: "COLL1234",
    limit: 25,
    start: firstPage.nextStart,
  });

  assert.equal(firstPage.start, 100);
  assert.equal(firstPage.nextStart, 125);
  assert.equal(firstPage.truncated, true);
  assert.equal(lastPage.start, 125);
  assert.equal(lastPage.nextStart, undefined);
  assert.equal(lastPage.truncated, false);
  assert.equal(lastPage.items.length, 7);
  assert.ok(calls.every((call) => call.method === undefined || call.method === "GET"));
  assert.ok(calls.every((call) => call.url.includes("/items/top?")));
});

test("Zotero rejects invalid item pagination starts before calling the Local API", async () => {
  let calls = 0;
  const provider = createZoteroLibraryProvider({
    fetchImpl: async () => {
      calls += 1;
      return new Response("unexpected");
    },
  });

  await assert.rejects(
    provider.listItems({ start: -1 }),
    /Zotero item pagination start must be a non-negative integer/,
  );
  assert.equal(calls, 0);
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

test("Zotero matches legacy identity.other.arxiv records", async () => {
  const legacyArxivPaper: ResearchPaper = {
    ...paper,
    id: "https://arxiv.org/abs/2401.12345",
    identity: { other: { arxiv: "https://arxiv.org/abs/2401.12345v2" } },
    doi: undefined,
    url: "https://arxiv.org/abs/2401.12345",
    sourceId: "arxiv",
    sourceIds: ["arxiv"],
    provenance: [{
      sourceId: "arxiv",
      sourceRecordId: "2401.12345v2",
      rank: 1,
      retrievedAt: "2026-07-22T00:00:00.000Z",
    }],
  };
  const searched: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    searched.push(url);
    if (url.includes("2401.12345")) {
      return new Response(JSON.stringify([{
        key: "ARXIV001",
        data: {
          key: "ARXIV001",
          itemType: "preprint",
          title: legacyArxivPaper.title,
          archiveID: "arXiv:2401.12345v2",
          creators: [],
          tags: [],
          collections: [],
        },
      }]), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  };
  const provider = createZoteroLibraryProvider({ fetchImpl });
  const [match] = await provider.matchPapers({ papers: [legacyArxivPaper] });

  assert.equal(match?.matched, true);
  assert.deepEqual(match?.reasons, ["arxiv"]);
  assert.ok(searched.some((url) => url.includes("2401.12345")));
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

test("Zotero item details return children, notes, and attachment metadata without local paths", async () => {
  const calls: string[] = [];
  const localPath = "C:\\Users\\Ada\\Zotero\\storage\\ATTACH01\\paper.pdf";
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/items/ITEM1234?format=json")) {
      return new Response(JSON.stringify({
        key: "ITEM1234",
        data: {
          key: "ITEM1234",
          itemType: "journalArticle",
          title: paper.title,
          creators: [{ firstName: "Ada", lastName: "Lovelace" }],
          date: "2025",
          DOI: paper.doi,
          url: "https://doi.org/10.1000/test",
          tags: [{ tag: "core" }],
          collections: ["COLL1234"],
          abstractNote: "A stored abstract.",
          path: localPath,
          file: localPath,
          view: "http://127.0.0.1:23119/api/users/0/items/ATTACH01/file/view/url",
        },
      }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/items/ITEM1234/children?format=json")) {
      return new Response(JSON.stringify([
        {
          key: "ATTACH01",
          data: {
            key: "ATTACH01",
            itemType: "attachment",
            title: "paper.pdf",
            parentItem: "ITEM1234",
            contentType: "application/pdf",
            linkMode: "imported_file",
            filename: "paper.pdf",
            path: localPath,
            url: "http://127.0.0.1:23119/api/users/0/items/ATTACH01/file/view/url",
          },
        },
        {
          key: "NOTE0001",
          data: {
            key: "NOTE0001",
            itemType: "note",
            parentItem: "ITEM1234",
            note: "<p>Research <strong>note</strong></p>",
          },
        },
        {
          key: "ANNOT001",
          data: {
            key: "ANNOT001",
            itemType: "annotation",
            parentItem: "ITEM1234",
            annotationText: "Important result",
          },
        },
      ]), { headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/fulltext")) throw new Error("Item details must not request attachment full text.");
    return new Response("missing", { status: 404 });
  };
  const provider = createZoteroLibraryProvider({ fetchImpl });
  const detail = await provider.getItemDetails("item1234");
  const serialized = JSON.stringify(detail);

  assert.equal(detail.item.url, "https://doi.org/10.1000/test");
  assert.deepEqual(detail.tags, ["core"]);
  assert.equal(detail.attachments[0]?.key, "ATTACH01");
  assert.equal(detail.attachments[0]?.contentType, "application/pdf");
  assert.equal(detail.notes[0]?.text, "Research note");
  assert.equal(detail.children.length, 3);
  assert.equal(Object.hasOwn(detail.data, "path"), false);
  assert.equal(Object.hasOwn(detail.data, "file"), false);
  assert.equal(Object.hasOwn(detail.data, "view"), false);
  assert.equal(serialized.includes(localPath), false);
  assert.equal(serialized.includes("/file/view/"), false);
  assert.equal(calls.some((url) => url.includes("/fulltext")), false);
});

test("Zotero attachment full text is explicit, capped, and reports original size", async () => {
  const calls: string[] = [];
  const sourceContent = "x".repeat(1_000_001);
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/items/ATTACH01?format=json")) {
      return new Response(JSON.stringify({
        key: "ATTACH01",
        data: {
          key: "ATTACH01",
          itemType: "attachment",
          title: "paper.pdf",
          parentItem: "ITEM1234",
          contentType: "application/pdf",
          path: "C:\\Users\\Ada\\Zotero\\storage\\ATTACH01\\paper.pdf",
        },
      }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/items/ATTACH01/fulltext")) {
      return new Response(JSON.stringify({
        content: sourceContent,
        indexedPages: 12,
        totalPages: 12,
        indexedChars: sourceContent.length,
      }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("missing", { status: 404 });
  };
  const provider = createZoteroLibraryProvider({ fetchImpl });
  const result = await provider.getAttachmentFullText("attach01");

  assert.equal(result.attachmentKey, "ATTACH01");
  assert.equal(result.content.length, 1_000_000);
  assert.equal(result.truncated, true);
  assert.equal(result.totalChars, 1_000_001);
  assert.equal(result.indexedPages, 12);
  assert.equal(calls.filter((url) => url.includes("/fulltext")).length, 1);
  assert.equal(calls.some((url) => url.includes("/file/view") || url.includes("/file/view/url")), false);
});

test("Zotero item export uses official BibTeX and CSL JSON formats with rendered CSL output", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("format=bibtex")) {
      return new Response("@article{lovelace2025, title = {A useful research paper}}");
    }
    if (url.includes("format=csljson")) {
      return new Response(JSON.stringify([{ id: "ITEM1234", title: paper.title }]), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("include=data%2Ccitation%2Cbib")) {
      return new Response(JSON.stringify([{
        key: "ITEM1234",
        citation: "(Lovelace, 2025)",
        bib: "<div class=\"csl-entry\">Lovelace (2025).</div>",
      }]), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("missing", { status: 404 });
  };
  const provider = createZoteroLibraryProvider({ fetchImpl });
  const bibtex = await provider.exportItem({ itemKey: "item1234", format: "bibtex", style: "ieee" });
  const csl = await provider.exportItem({ itemKey: "ITEM1234", format: "csl-json", style: "ieee" });

  assert.match(bibtex.content, /@article/);
  assert.equal(bibtex.citation, "(Lovelace, 2025)");
  assert.match(bibtex.bibliography ?? "", /csl-entry/);
  assert.match(csl.content, /"title": "A useful research paper"/);
  assert.equal(csl.format, "csl-json");
  assert.ok(calls.some((url) => url.includes("format=bibtex") && url.includes("itemKey=ITEM1234")));
  assert.ok(calls.some((url) => url.includes("format=csljson") && url.includes("itemKey=ITEM1234")));
  assert.ok(calls.some((url) => url.includes("include=data%2Ccitation%2Cbib") && url.includes("style=ieee")));
});
