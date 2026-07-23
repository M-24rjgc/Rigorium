import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  refreshProjectLiteratureMap,
} from "../../src/research/literature/mapRefresh.js";
import {
  LiteratureMapRepositoryError,
  loadProjectLiveLiteratureMap,
  setProjectLiveLiteratureMapNodeState,
  updateProjectLiveLiteratureMap,
} from "../../src/research/literature/mapRepository.js";
import type { LiteratureMapRefreshProvider } from "../../src/research/literature/mapRefresh.js";
import type { ResearchPaper } from "../../src/research/types.js";

const firstTime = new Date("2026-07-23T00:00:00.000Z");
const secondTime = new Date("2026-07-23T01:00:00.000Z");

function paper(input: { id: string; sourceId?: string; doi?: string; title?: string }): ResearchPaper {
  const sourceId = input.sourceId ?? "openalex";
  return {
    id: input.id,
    identity: input.doi ? { doi: input.doi } : {},
    title: input.title ?? `Paper ${input.id}`,
    authors: ["Ada Lovelace"],
    year: 2025,
    ...(input.doi ? { doi: input.doi } : {}),
    citedByCount: 0,
    topics: [],
    referencedWorkIds: [],
    sourceId,
    sourceIds: [sourceId],
    provenance: [{
      sourceId,
      sourceRecordId: input.id,
      rank: 1,
      retrievedAt: firstTime.toISOString(),
    }],
  };
}

async function projectRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `rigorium-map-refresh-${label}-`));
}

test("refresh keeps successful providers, audits a failure, obeys call budget, and preserves pinned layout", async () => {
  const root = await projectRoot("partial");
  const original = paper({ id: "seed", doi: "10.1000/seed" });
  const created = await updateProjectLiveLiteratureMap({
    projectRoot: root,
    mapId: "map-partial",
    update: { origin: "search", papers: [original] },
    now: firstTime,
  });
  const pinned = await setProjectLiveLiteratureMapNodeState({
    projectRoot: root,
    mapId: "map-partial",
    paperId: original.id,
    expectedRevision: created.map.revision,
    state: { status: "core", position: { x: 320, y: -120, pinned: true } },
    now: secondTime,
  });

  let active = 0;
  let maxActive = 0;
  let skippedCalls = 0;
  const providers: LiteratureMapRefreshProvider[] = [
    {
      id: "openalex",
      coverage: "OpenAlex monitor metadata and citation relationships.",
      refresh: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(15);
        active -= 1;
        return {
          papers: [paper({ id: "crossref-seed", sourceId: "crossref", doi: "10.1000/seed", title: "Richer refreshed metadata" })],
          coverage: "OpenAlex monitor results for the configured topic.",
        };
      },
    },
    {
      id: "crossref",
      coverage: "Crossref DOI metadata.",
      refresh: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(15);
        active -= 1;
        throw new Error("Crossref is temporarily unavailable.");
      },
    },
    {
      id: "arxiv",
      coverage: "arXiv preprint metadata.",
      refresh: async () => {
        skippedCalls += 1;
        return { papers: [paper({ id: "should-not-run" })] };
      },
    },
  ];

  const result = await refreshProjectLiteratureMap({
    projectRoot: root,
    mapId: "map-partial",
    expectedRevision: pinned.map.revision,
    providers,
    maxConcurrency: 2,
    budget: { maxProviderCalls: 2, maxCost: 2 },
    now: () => secondTime,
  });

  assert.equal(maxActive, 2);
  assert.equal(skippedCalls, 0);
  assert.equal(result.map?.persisted, true);
  assert.deepEqual(result.sources.map((source) => source.state), ["succeeded", "failed", "skipped"]);
  assert.equal(result.sources[1]?.sourceId, "crossref");
  assert.equal(result.sources[1]?.coverage, "Crossref DOI metadata.");
  assert.match(result.sources[1]?.completedAt ?? "", /^2026-07-23T01:00:00.000Z$/u);
  assert.match(result.sources[1]?.error ?? "", /temporarily unavailable/u);
  assert.equal(result.sources[2]?.reason, "budget_exhausted");

  const refreshed = result.map?.map.nodes.find((node) => node.id === original.id);
  assert.ok(refreshed);
  assert.equal(refreshed.status, "core");
  assert.deepEqual(refreshed.position, { x: 320, y: -120, pinned: true });
  assert.equal(refreshed.paper.title, "Richer refreshed metadata");
  assert.deepEqual(refreshed.origins, ["search", "monitor"]);
});

test("cancellation stops queued providers while committing a completed successful result", async () => {
  const root = await projectRoot("cancelled");
  const controller = new AbortController();
  let secondProviderCalls = 0;
  let receivedSignal: AbortSignal | undefined;
  const result = await refreshProjectLiteratureMap({
    projectRoot: root,
    mapId: "map-cancelled",
    signal: controller.signal,
    maxConcurrency: 1,
    providers: [
      {
        id: "openalex",
        coverage: "OpenAlex monitor metadata.",
        refresh: async (context) => {
          receivedSignal = context.signal;
          controller.abort("user cancelled refresh");
          return { papers: [paper({ id: "completed-before-cancel" })] };
        },
      },
      {
        id: "crossref",
        coverage: "Crossref DOI metadata.",
        refresh: async () => {
          secondProviderCalls += 1;
          return { papers: [paper({ id: "must-not-run" })] };
        },
      },
    ],
    now: () => firstTime,
  });

  assert.equal(receivedSignal, controller.signal);
  assert.equal(secondProviderCalls, 0);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.sources.map((source) => source.state), ["succeeded", "cancelled"]);
  assert.equal(result.map?.map.nodes.some((node) => node.id === "completed-before-cancel"), true);
});

test("replaying the same refresh is idempotent and does not advance the map revision", async () => {
  const root = await projectRoot("idempotent");
  const providers: LiteratureMapRefreshProvider[] = [{
    id: "openalex",
    coverage: "OpenAlex monitor metadata.",
    refresh: async () => ({ papers: [paper({ id: "same-paper", doi: "10.1000/same" })] }),
  }];

  const first = await refreshProjectLiteratureMap({
    projectRoot: root,
    mapId: "map-idempotent",
    providers,
    now: () => firstTime,
  });
  const replay = await refreshProjectLiteratureMap({
    projectRoot: root,
    mapId: "map-idempotent",
    expectedRevision: first.map?.map.revision,
    providers,
    now: () => secondTime,
  });

  assert.equal(first.map?.persisted, true);
  assert.equal(replay.map?.persisted, false);
  assert.equal(replay.map?.map.revision, first.map?.map.revision);
  assert.deepEqual(replay.map?.diff.nodes.added, []);
});

test("a stale refresh revision is rejected without overwriting the current map", async () => {
  const root = await projectRoot("conflict");
  const created = await updateProjectLiveLiteratureMap({
    projectRoot: root,
    mapId: "map-conflict",
    update: { origin: "search", papers: [paper({ id: "existing" })] },
    now: firstTime,
  });

  await assert.rejects(
    refreshProjectLiteratureMap({
      projectRoot: root,
      mapId: "map-conflict",
      expectedRevision: created.map.revision - 1,
      providers: [{
        id: "openalex",
        coverage: "OpenAlex monitor metadata.",
        refresh: async () => ({ papers: [paper({ id: "must-not-persist" })] }),
      }],
      now: () => secondTime,
    }),
    (error: unknown) => {
      assert.ok(error instanceof LiteratureMapRepositoryError);
      assert.equal(error.code, "revision_conflict");
      return true;
    },
  );

  const loaded = await loadProjectLiveLiteratureMap({ projectRoot: root });
  assert.equal(loaded?.map.revision, created.map.revision);
  assert.equal(loaded?.map.nodes.some((node) => node.id === "must-not-persist"), false);
});

test("monitor refresh adds review-only candidates, preserves user state, and returns bridge provenance", async () => {
  const root = await projectRoot("candidate-review");
  const center = paper({ id: "B", title: "User-reviewed center paper" });
  const created = await updateProjectLiveLiteratureMap({
    projectRoot: root,
    mapId: "map-candidate-review",
    update: { origin: "search", papers: [center] },
    now: firstTime,
  });
  const reviewed = await setProjectLiveLiteratureMapNodeState({
    projectRoot: root,
    mapId: "map-candidate-review",
    paperId: center.id,
    expectedRevision: created.map.revision,
    state: { status: "core", position: { x: 240, y: 80, pinned: true } },
    now: firstTime,
  });

  const result = await refreshProjectLiteratureMap({
    projectRoot: root,
    mapId: "map-candidate-review",
    expectedRevision: reviewed.map.revision,
    providers: [{
      id: "agent-monitor",
      coverage: "New citation candidates for the active research project.",
      refresh: async () => ({
        papers: [paper({ id: "A" }), paper({ id: "C" })],
        edges: [
          { id: "a-b", source: "A", target: "B", type: "citation", weight: 1, inferred: false },
          { id: "b-c", source: "B", target: "C", type: "citation", weight: 1, inferred: false },
        ],
      }),
    }],
    now: () => secondTime,
  });

  assert.deepEqual(result.candidateReview, {
    reviewRequired: true,
    newCandidatePaperIds: ["A", "C"],
    pendingCandidatePaperIds: ["A", "C"],
    updatedExistingPaperIds: [],
    classificationPolicy: "new_nodes_candidate_existing_state_preserved",
    zoteroWritePerformed: false,
    snapshotCreated: false,
    destructiveMapChangePerformed: false,
  });
  const centerAfterRefresh = result.map?.map.nodes.find((node) => node.id === center.id);
  assert.ok(centerAfterRefresh);
  assert.equal(centerAfterRefresh.status, "core");
  assert.deepEqual(centerAfterRefresh.position, { x: 240, y: 80, pinned: true });
  assert.deepEqual(result.bridgeAnalysis?.bridges.map((bridge) => bridge.paperId), ["B"]);
  assert.deepEqual(
    result.bridgeAnalysis?.bridges[0]?.supportingRelations.map((relation) => relation.edgeId),
    ["citation:A:B", "citation:B:C"],
  );
});

test("read-only monitor payloads reject write intents and successful empty polls do not create a map", async () => {
  const rejectedRoot = await projectRoot("write-intent");
  const rejected = await refreshProjectLiteratureMap({
    projectRoot: rejectedRoot,
    mapId: "map-write-intent",
    providers: [{
      id: "unsafe-provider",
      coverage: "A provider that returned an out-of-contract write request.",
      refresh: async () => ({
        papers: [paper({ id: "must-not-persist" })],
        zoteroWrite: { collection: "silent-write" },
      } as never),
    }],
    now: () => firstTime,
  });

  assert.deepEqual(rejected.sources.map((source) => source.state), ["failed"]);
  assert.match(rejected.sources[0]?.error ?? "", /does not allow zoteroWrite/u);
  assert.equal(rejected.map, undefined);
  assert.equal(await loadProjectLiveLiteratureMap({ projectRoot: rejectedRoot }), undefined);
  assert.deepEqual(rejected.candidateReview.newCandidatePaperIds, []);
  assert.equal(rejected.candidateReview.zoteroWritePerformed, false);

  const emptyRoot = await projectRoot("empty-poll");
  const empty = await refreshProjectLiteratureMap({
    projectRoot: emptyRoot,
    mapId: "map-empty-poll",
    providers: [{
      id: "empty-provider",
      coverage: "No new papers in this polling interval.",
      refresh: async () => ({ papers: [], edges: [] }),
    }],
    now: () => secondTime,
  });

  assert.deepEqual(empty.sources.map((source) => source.state), ["succeeded"]);
  assert.equal(empty.map, undefined);
  assert.equal(empty.candidateReview.reviewRequired, false);
  assert.equal(await loadProjectLiveLiteratureMap({ projectRoot: emptyRoot }), undefined);
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
