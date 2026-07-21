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
