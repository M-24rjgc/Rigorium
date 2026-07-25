import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { DEFAULT_RESEARCH_SETTINGS, writeResearchSettings } from "../../../src/research/settings.js";
import {
  createLiteratureCloseoutTool,
  type LiteratureCloseoutInput,
} from "../../../src/tool/builtin/literatureCloseout.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const NOW = new Date("2026-07-25T02:03:04.000Z");

function context(projectRoot: string, pilotHome: string): PilotDeckToolRuntimeContext {
  return {
    sessionId: "literature-closeout-test",
    turnId: "turn-1",
    cwd: projectRoot,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: projectRoot }),
    env: { PILOT_HOME: pilotHome },
    now: () => NOW,
  };
}

async function workspace(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  await mkdir(projectRoot, { recursive: true });
  return { root, projectRoot, pilotHome };
}

test("literature_closeout creates a hashed evidence-pack artifact without a formal write", async () => {
  const { projectRoot, pilotHome } = await workspace("rigorium-closeout-evidence-");
  const tool = createLiteratureCloseoutTool();
  const input: LiteratureCloseoutInput = {
    action: "evidence_pack",
    artifactId: "evidence-tool-test",
    entries: [{
      id: "entry-1",
      paperId: "doi:10.1000/evidence",
      locator: { sourceId: "openalex", recordId: "W1", page: 4, paragraph: 2 },
      snapshot: { content: "Exact source paragraph for a traceable claim." },
      quote: "source paragraph",
    }],
  };

  assert.equal(tool.isReadOnly(input), true);
  const output = await tool.execute(input, context(projectRoot, pilotHome));

  assert.equal(output.data?.action, "evidence_pack");
  if (output.data?.action !== "evidence_pack") assert.fail("expected evidence_pack result");
  assert.equal(output.data.artifact.kind, "evidence_pack");
  assert.equal(output.data.artifact.payload.entries[0]?.locator.page, 4);
  assert.match(output.data.artifact.payload.entries[0]?.snapshot.contentHash ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(output.data.safety, {
    candidateOnly: false,
    zoteroWritePerformed: false,
    literatureMapWritePerformed: false,
    formalPromotionPerformed: false,
  });
});

test("literature_closeout captures Zotero attachment evidence through read-only Local API calls", async () => {
  const { projectRoot, pilotHome } = await workspace("rigorium-closeout-zotero-evidence-");
  const calls: Array<{ url: string; method: string }> = [];
  const tool = createLiteratureCloseoutTool({
    zoteroFetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/items/ATTACH01?format=json")) {
        return new Response(JSON.stringify({
          key: "ATTACH01",
          data: {
            key: "ATTACH01",
            itemType: "attachment",
            title: "paper.pdf",
            parentItem: "ITEM0001",
            contentType: "application/pdf",
          },
        }), { headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/items/ATTACH01/fulltext")) {
        return new Response(JSON.stringify({
          content: "Indexed Zotero text with the exact quoted evidence.",
          indexedPages: 2,
          totalPages: 3,
        }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("missing", { status: 404 });
    },
  });

  const output = await tool.execute({
    action: "evidence_pack",
    artifactId: "zotero-evidence-tool-test",
    zoteroAttachment: {
      attachmentKey: "ATTACH01",
      paperId: "zotero:ITEM0001",
      entryId: "zotero-entry",
      locator: { page: 2, paragraph: 1 },
      quote: "exact quoted evidence",
    },
  }, context(projectRoot, pilotHome));

  if (output.data?.action !== "evidence_pack") assert.fail("expected evidence_pack result");
  assert.equal(output.data.artifact.payload.entries[0]?.locator.sourceId, "zotero");
  assert.equal(output.data.artifact.payload.entries[0]?.snapshot.indexedPages, 2);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
  assert.equal(calls.some((call) => call.url.includes("/connector/")), false);
});

test("literature_closeout rescans a candidate across enabled official sources and merges identity", async () => {
  const { projectRoot, pilotHome } = await workspace("rigorium-closeout-novelty-");
  await writeResearchSettings({
    scope: "global",
    pilotHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        sources: {
          openalex: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.openalex, enabled: true },
          crossref: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.crossref, enabled: true },
          arxiv: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.arxiv, enabled: false },
          openreview: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.openreview, enabled: false },
        },
      },
    },
  });
  const title = "Graph uncertainty calibration under distribution shift";
  const tool = createLiteratureCloseoutTool({
    search: {
      endpoint: "https://openalex.test/works",
      fetchImpl: async () => new Response(JSON.stringify({
        meta: { count: 1 },
        results: [{
          id: "https://openalex.org/W1",
          doi: "https://doi.org/10.1000/calibration",
          display_name: title,
          publication_year: 2025,
          cited_by_count: 9,
          authorships: [{ author: { display_name: "Ada Lovelace" } }],
          primary_location: { landing_page_url: "https://example.test/W1" },
          open_access: { is_oa: true },
          topics: [],
          referenced_works: [],
          ids: { openalex: "https://openalex.org/W1", doi: "https://doi.org/10.1000/calibration" },
        }],
      }), { headers: { "Content-Type": "application/json" } }),
      crossrefEndpoint: "https://crossref.test/works",
      crossrefFetchImpl: async () => new Response(JSON.stringify({
        message: {
          "total-results": 1,
          items: [{
            DOI: "10.1000/calibration",
            title: [title],
            author: [{ given: "Ada", family: "Lovelace" }],
            published: { "date-parts": [[2025, 1, 1]] },
            URL: "https://doi.org/10.1000/calibration",
            type: "journal-article",
            "is-referenced-by-count": 9,
          }],
        },
      }), { headers: { "Content-Type": "application/json" } }),
    },
  });

  const output = await tool.execute({
    action: "novelty_rescan",
    artifactId: "novelty-tool-test",
    candidates: [{ id: "direction-1", summary: title }],
    noveltySourceIds: ["openalex", "crossref"],
    limitPerSource: 3,
  }, context(projectRoot, pilotHome));

  if (output.data?.action !== "novelty_rescan") assert.fail("expected novelty_rescan result");
  const rescan = output.data.artifact.payload.rescan;
  assert.equal(rescan.coverage.status, "complete");
  assert.deepEqual(rescan.coverage.successfulSourceIds, ["openalex", "crossref"]);
  assert.equal(rescan.candidates[0]?.matches.length, 1);
  assert.deepEqual(rescan.candidates[0]?.matches[0]?.sourceIds, ["crossref", "openalex"]);
  assert.equal(rescan.candidates[0]?.novelty.status, "not_established");
  assert.equal(output.data.safety.formalPromotionPerformed, false);
});

test("literature_closeout polls and diffs a candidate-only Zotero ledger without connector or map writes", async () => {
  const { projectRoot, pilotHome } = await workspace("rigorium-closeout-monitor-");
  let title = "First candidate title";
  const calls: Array<{ url: string; method: string }> = [];
  const tool = createLiteratureCloseoutTool({
    zoteroFetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/api/users/0/items/top?")) {
        return new Response(JSON.stringify([{
          key: "ZOTERO01",
          data: {
            key: "ZOTERO01",
            itemType: "journalArticle",
            title,
            creators: [{ firstName: "Ada", lastName: "Lovelace" }],
            date: "2026-07-25",
            tags: [],
            collections: [],
          },
        }]), { headers: { "Content-Type": "application/json", "Total-Results": "1" } });
      }
      return new Response("missing", { status: 404 });
    },
  });
  const input: LiteratureCloseoutInput = {
    action: "candidate_monitor_poll",
    monitorSourceIds: ["zotero"],
    monitorLimit: 10,
  };

  assert.equal(tool.isReadOnly(input), false);
  assert.equal(tool.isConcurrencySafe(input), false);
  const first = await tool.execute(input, context(projectRoot, pilotHome));
  const second = await tool.execute(input, context(projectRoot, pilotHome));
  title = "Updated candidate title";
  const third = await tool.execute(input, context(projectRoot, pilotHome));

  if (first.data?.action !== "candidate_monitor_poll") assert.fail("expected monitor result");
  if (second.data?.action !== "candidate_monitor_poll") assert.fail("expected monitor result");
  if (third.data?.action !== "candidate_monitor_poll") assert.fail("expected monitor result");
  assert.equal(first.data.monitor.persisted, true);
  assert.equal(first.data.monitor.newCandidates.length, 1);
  assert.equal(second.data.monitor.persisted, false);
  assert.equal(second.data.monitor.changed, false);
  assert.equal(third.data.monitor.persisted, true);
  assert.equal(third.data.monitor.updatedCandidates.length, 1);
  assert.equal(third.data.monitor.state.revision, 2);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.equal(calls.some((call) => call.url.includes("/connector/")), false);

  const stored = JSON.parse(await readFile(third.data.monitor.path, "utf8")) as Record<string, unknown>;
  assert.equal(stored.kind, "literature_candidate_monitor");
  assert.equal("mapId" in stored, false);
  assert.equal("zoteroWrite" in stored, false);
  assert.deepEqual(third.data.safety, {
    candidateOnly: true,
    zoteroWritePerformed: false,
    literatureMapWritePerformed: false,
    formalPromotionPerformed: false,
  });
});

test("literature_closeout rejects action-specific input before execution", async () => {
  const { projectRoot, pilotHome } = await workspace("rigorium-closeout-validation-");
  const tool = createLiteratureCloseoutTool();
  const validation = await tool.validateInput!({
    action: "evidence_pack",
    entries: [],
    query: "must not be silently ignored",
  } as never, context(projectRoot, pilotHome));

  assert.equal(validation.ok, false);
  if (validation.ok) assert.fail("expected validation failure");
  assert.match(validation.issues[0]?.message ?? "", /query is not supported|entries must contain/u);
});
