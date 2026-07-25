import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createZoteroCandidateMonitorSource,
  pollLiteratureCandidateMonitor,
  syncProjectLiteratureCandidateMonitor,
  type LiteratureCandidateMonitorSource,
} from "../../src/research/literature/candidateMonitor.js";
import type { ResearchPaper } from "../../src/research/types.js";

const times = [
  new Date("2026-07-25T00:00:00.000Z"),
  new Date("2026-07-25T00:01:00.000Z"),
  new Date("2026-07-25T00:02:00.000Z"),
];

function candidate(retrievedAt: string, citedByCount = 1): ResearchPaper {
  return {
    id: "arxiv:2607.12345",
    identity: { arxiv: "2607.12345" },
    title: "A monitored preprint",
    authors: ["A. Author"],
    year: 2026,
    citedByCount,
    topics: [],
    referencedWorkIds: [],
    sourceId: "arxiv",
    sourceIds: ["arxiv"],
    provenance: [{ sourceId: "arxiv", sourceRecordId: "2607.12345", rank: 1, retrievedAt }],
  };
}

function source(paperFactory: (now: Date) => ResearchPaper): LiteratureCandidateMonitorSource {
  return {
    id: "arxiv",
    name: "arXiv",
    poll: async ({ now }) => {
      const checkedAt = now();
      return {
        papers: [paperFactory(checkedAt)],
        source: { id: "arxiv", name: "arXiv", status: "ok", retrievedAt: checkedAt.toISOString(), coverage: "Official preprint metadata" },
      };
    },
  };
}

test("candidate monitoring is candidate-only and ignores volatile retrieval timestamps", async () => {
  const first = await pollLiteratureCandidateMonitor({
    sources: [source((date) => candidate(date.toISOString()))],
    now: () => times[0]!,
  });
  assert.equal(first.candidateOnly, true);
  assert.equal(first.changed, true);
  assert.equal(first.state.revision, 1);
  assert.equal(first.newCandidates.length, 1);

  const second = await pollLiteratureCandidateMonitor({
    state: first.state,
    sources: [source((date) => candidate(date.toISOString()))],
    now: () => times[1]!,
  });
  assert.equal(second.changed, false);
  assert.deepEqual(second.state, first.state);
  assert.equal(second.updatedCandidates.length, 0);

  const third = await pollLiteratureCandidateMonitor({
    state: second.state,
    sources: [source((date) => candidate(date.toISOString(), 2))],
    now: () => times[2]!,
  });
  assert.equal(third.changed, true);
  assert.equal(third.state.revision, 2);
  assert.equal(third.updatedCandidates.length, 1);
});

test("project monitor persistence writes only the candidate ledger", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rigorium-candidate-monitor-"));
  const result = await syncProjectLiteratureCandidateMonitor({
    projectRoot,
    sources: [source((date) => candidate(date.toISOString()))],
    now: () => times[0]!,
  });
  assert.equal(result.persisted, true);
  assert.match(result.path, /\.pilotdeck[\\/]research[\\/]candidate-monitor\.json$/u);
  const stored = JSON.parse(await readFile(result.path, "utf8")) as Record<string, unknown>;
  assert.equal(stored.kind, "literature_candidate_monitor");
  assert.equal("mapId" in stored, false);
  assert.equal("zoteroWrite" in stored, false);
});

test("the Zotero monitor reads listItems and never enters an import path", async () => {
  let listCalls = 0;
  let importCalls = 0;
  const provider = {
    listItems: async () => {
      listCalls += 1;
      return {
        items: [{
          key: "ZOTERO01",
          itemType: "journalArticle",
          title: "Candidate from Zotero",
          creators: ["Z. Author"],
          year: 2026,
          tags: [],
          collectionKeys: [],
          identity: { zoteroKey: "ZOTERO01" },
        }],
        total: 1,
        start: 0,
        truncated: false,
      };
    },
    importPapers: async () => {
      importCalls += 1;
      throw new Error("must not be called");
    },
  };
  const zotero = createZoteroCandidateMonitorSource({ provider: provider as never, now: () => times[0]! });
  const result = await pollLiteratureCandidateMonitor({ sources: [zotero], now: () => times[0]! });

  assert.equal(listCalls, 1);
  assert.equal(importCalls, 0);
  assert.equal(result.newCandidates[0]!.identity.zoteroKey, "ZOTERO01");
  assert.equal(result.candidateOnly, true);
});
