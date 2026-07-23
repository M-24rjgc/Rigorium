import assert from "node:assert/strict";
import test from "node:test";
import {
  runLiteratureSearchSession,
  type LiteratureSearchSessionExpansionTask,
  type LiteratureSearchSessionPlan,
  type LiteratureSearchSessionSearchTask,
} from "../../src/research/literature/searchSession.js";
import { buildLiteratureSearchCoverageAudit } from "../../src/research/literature/coverageAudit.js";
import type {
  LiteratureExpansionArtifact,
  LiteratureExpansionPlan,
  LiteratureSearchArtifact,
  ResearchPaper,
  ResearchSourceStatus,
  SearchPlan,
} from "../../src/research/types.js";

const retrievedAt = "2026-07-23T00:00:00.000Z";
const now = () => new Date(retrievedAt);

function paper(id: string, sourceId = "openalex"): ResearchPaper {
  return {
    id,
    identity: { openAlexId: id },
    title: `Paper ${id}`,
    authors: ["Ada Lovelace"],
    year: 2025,
    citedByCount: 1,
    topics: [],
    referencedWorkIds: [],
    sourceId,
    sourceIds: [sourceId],
    provenance: [{ sourceId, sourceRecordId: id, rank: 1, retrievedAt }],
  };
}

function source(input: {
  id?: string;
  name?: string;
  queryVariantId?: string;
  status?: ResearchSourceStatus["status"];
  resultCount?: number;
  coverage?: string;
  error?: string;
} = {}): ResearchSourceStatus {
  const id = input.id ?? "openalex";
  const status = input.status ?? "ok";
  return {
    id,
    name: input.name ?? id,
    ...(input.queryVariantId ? { queryVariantId: input.queryVariantId } : {}),
    status,
    retrievedAt,
    queryUrl: `https://example.test/${id}`,
    resultCount: input.resultCount ?? (status === "ok" ? 1 : 0),
    coverage: input.coverage ?? `${id} coverage`,
    ...(input.error ? { error: input.error } : {}),
  };
}

function searchPlan(input: {
  query: string;
  limit: number;
  queryVariants?: SearchPlan["queryVariants"];
  fromYear?: number;
  toYear?: number;
  venueSet?: SearchPlan["venueSet"];
}): SearchPlan {
  return {
    query: input.query,
    limit: input.limit,
    ...(input.fromYear ? { fromYear: input.fromYear } : {}),
    ...(input.toYear ? { toYear: input.toYear } : {}),
    sort: "relevance",
    sourceIds: ["openalex"],
    ...(input.queryVariants ? { queryVariants: input.queryVariants } : {}),
    ...(input.venueSet ? { venueSet: input.venueSet } : {}),
  };
}

function searchTask(
  id: string,
  plan: SearchPlan,
  options: Partial<Pick<LiteratureSearchSessionSearchTask, "queryKind" | "stageId" | "dependsOn">> = {},
): LiteratureSearchSessionSearchTask {
  return {
    id,
    kind: "search",
    queryKind: options.queryKind ?? "broad",
    intent: { text: `Intent for ${id}` },
    ...(options.stageId ? { stageId: options.stageId } : {}),
    ...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
    plan,
  };
}

function expansionTask(
  id: string,
  plan: LiteratureExpansionPlan,
  options: Partial<Pick<LiteratureSearchSessionExpansionTask, "stageId" | "dependsOn">> = {},
): LiteratureSearchSessionExpansionTask {
  return {
    id,
    kind: "expansion",
    intent: { text: `Intent for ${id}` },
    ...(options.stageId ? { stageId: options.stageId } : {}),
    ...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
    plan,
  };
}

function sessionPlan(tasks: LiteratureSearchSessionPlan["tasks"], totalResultBudget: number, maxConcurrentTasks: number): LiteratureSearchSessionPlan {
  return {
    sessionId: "session-test",
    intent: { text: "Find evidence for a research question" },
    totalResultBudget,
    maxConcurrentTasks,
    tasks,
  };
}

function searchArtifact(
  taskId: string,
  plan: SearchPlan,
  queryAudit: ResearchSourceStatus[] = [source({ queryVariantId: "primary" })],
): LiteratureSearchArtifact {
  const sources = queryAudit.map(({ queryVariantId: _queryVariantId, ...item }) => item);
  return {
    schemaVersion: 1,
    kind: "literature_search",
    artifactId: `search-${taskId}`,
    createdAt: retrievedAt,
    intent: { text: `artifact ${taskId}` },
    plan,
    papers: [paper(`https://openalex.org/${taskId}`)],
    edges: [],
    sources,
    queryAudit,
    coverageAudit: buildLiteratureSearchCoverageAudit({ plan, queryAudit }),
    coverage: {
      status: "complete",
      resultCount: 1,
      warnings: [],
      requestedSourceIds: ["openalex"],
      successfulSourceIds: ["openalex"],
      failedSourceIds: [],
    },
    presentation: { autoOpen: false },
  };
}

function expansionArtifact(taskId: string, plan: LiteratureExpansionPlan): LiteratureExpansionArtifact {
  const seed = paper("https://openalex.org/seed");
  return {
    schemaVersion: 1,
    kind: "literature_expansion",
    artifactId: `expansion-${taskId}`,
    createdAt: retrievedAt,
    intent: { text: `artifact ${taskId}` },
    plan,
    seedPaperId: seed.id,
    papers: [seed],
    edges: [],
    sources: [source()],
    directions: plan.directions.map((direction) => ({
      direction,
      status: "ok",
      resultCount: 0,
      truncated: false,
    })),
    coverage: {
      status: "complete",
      resultCount: 1,
      warnings: [],
      requestedSourceIds: ["openalex"],
      successfulSourceIds: ["openalex"],
      failedSourceIds: [],
    },
    presentation: { autoOpen: false },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for controlled task state.");
}

test("search session never exceeds its task concurrency cap", async () => {
  const tasks = ["one", "two", "three"].map((id) => searchTask(id, searchPlan({ query: id, limit: 2 })));
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const started: string[] = [];
  let active = 0;
  let peak = 0;
  const running = runLiteratureSearchSession(sessionPlan(tasks, 6, 2), {
    search: async (task, effectivePlan) => {
      started.push(task.id);
      active += 1;
      peak = Math.max(peak, active);
      const gate = deferred<void>();
      gates.set(task.id, gate);
      await gate.promise;
      active -= 1;
      return searchArtifact(task.id, effectivePlan);
    },
  }, { now });

  await waitFor(() => started.length === 2);
  assert.equal(peak, 2);
  assert.equal(active, 2);

  const first = started[0];
  assert.ok(first);
  gates.get(first)?.resolve();
  await waitFor(() => started.length === 3);
  assert.ok(peak <= 2);

  for (const taskId of started) gates.get(taskId)?.resolve();
  const result = await running;
  assert.deepEqual(result.tasks.map((task) => task.taskId), ["one", "two", "three"]);
  assert.equal(result.status, "complete");
  assert.equal(result.budget.allocatedResultSlots, 6);
});

test("search session reserves a strict shared result budget and preserves venue/year constraints", async () => {
  const broad = searchTask("broad", searchPlan({
    query: "foundation models",
    limit: 4,
    queryVariants: [
      { id: "primary", query: "foundation models", requestLimit: 2, category: "primary" },
      { id: "alternative-1", query: "large language models", requestLimit: 2, category: "synonym" },
    ],
  }));
  const citationPlan: LiteratureExpansionPlan = {
    seed: { openAlexId: "https://openalex.org/W123" },
    directions: ["references", "citations"],
    limitPerDirection: 3,
    sourceIds: ["openalex"],
  };
  const expansion = expansionTask("seed-neighborhood", citationPlan, { dependsOn: ["broad"] });
  const constrained = searchTask("venue-question", searchPlan({
    query: "Which retrieval method was accepted at NeurIPS?",
    limit: 5,
    queryVariants: [
      { id: "primary", query: "retrieval NeurIPS", requestLimit: 3, category: "primary" },
      { id: "alternative-1", query: "retrieval augmented generation NeurIPS", requestLimit: 2, category: "adjacent_field" },
    ],
    fromYear: 2023,
    toYear: 2025,
    venueSet: {
      id: "neurips-2025",
      name: "NeurIPS 2025",
      venues: [{ id: "neurips", name: "NeurIPS", year: 2025, status: "accepted" }],
    },
  }), { queryKind: "question", dependsOn: ["broad"] });
  const seenSearchPlans = new Map<string, SearchPlan>();
  let seenExpansionPlan: LiteratureExpansionPlan | undefined;

  const result = await runLiteratureSearchSession(sessionPlan([broad, expansion, constrained], 7, 3), {
    search: async (task, effectivePlan) => {
      seenSearchPlans.set(task.id, effectivePlan);
      return searchArtifact(task.id, effectivePlan);
    },
    expansion: async (_task, effectivePlan) => {
      seenExpansionPlan = effectivePlan;
      return expansionArtifact("seed-neighborhood", effectivePlan);
    },
  }, { now });

  assert.equal(result.budget.allocatedResultSlots, 7);
  assert.equal(result.budget.remainingResultSlots, 0);
  assert.equal(seenSearchPlans.get("broad")?.limit, 4);
  assert.equal(seenExpansionPlan?.limitPerDirection, 1);
  assert.equal(seenSearchPlans.get("venue-question")?.limit, 1);
  assert.deepEqual(seenSearchPlans.get("venue-question")?.queryVariants, [{
    id: "primary",
    query: "retrieval NeurIPS",
    requestLimit: 1,
    category: "primary",
  }]);
  assert.equal(seenSearchPlans.get("venue-question")?.fromYear, 2023);
  assert.equal(seenSearchPlans.get("venue-question")?.toYear, 2025);
  assert.equal(seenSearchPlans.get("venue-question")?.venueSet?.id, "neurips-2025");
  const constrainedAudit = result.tasks.find((task) => task.taskId === "venue-question");
  assert.equal(constrainedAudit?.state, "succeeded");
  assert.deepEqual(constrainedAudit?.requests.map((request) => [
    request.kind,
    request.status,
    request.kind === "search" ? request.queryVariantId : "expansion",
  ]), [
    ["search", "scheduled", "primary"],
    ["search", "excluded", "alternative-1"],
  ]);
  assert.equal(result.status, "partial");
  assert.equal(result.stopReason, "budget_exhausted");
});

test("a failed task records its reason without losing successful artifacts and source audit", async () => {
  const successful = searchTask("successful", searchPlan({ query: "successful query", limit: 2 }));
  const failing = searchTask("failing", searchPlan({ query: "failing query", limit: 2 }));

  const result = await runLiteratureSearchSession(sessionPlan([successful, failing], 4, 2), {
    search: async (task, effectivePlan) => {
      if (task.id === "failing") throw new Error("provider was unavailable");
      return searchArtifact(task.id, effectivePlan, [source({ id: "openalex", queryVariantId: "primary" })]);
    },
  }, { now });

  assert.equal(result.status, "partial");
  assert.equal(result.stopReason, "all_tasks_settled");
  assert.deepEqual(result.artifacts.map((artifact) => artifact.taskId), ["successful"]);
  assert.deepEqual(result.coverage.successfulTaskIds, ["successful"]);
  assert.deepEqual(result.coverage.failedTaskIds, ["failing"]);
  const failed = result.tasks.find((task) => task.taskId === "failing");
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.reason?.code, "executor_failed");
  assert.match(failed?.reason?.message ?? "", /provider was unavailable/u);
  assert.deepEqual(result.sourceAudit.map((entry) => [entry.taskId, entry.source.id, entry.source.retrievedAt]), [
    ["successful", "openalex", retrievedAt],
  ]);
});

test("search session accepts a schema-v1 search artifact created before coverage audit was added", async () => {
  const task = searchTask("legacy", searchPlan({ query: "legacy query", limit: 2 }));
  const result = await runLiteratureSearchSession(sessionPlan([task], 2, 1), {
    search: async (_task, effectivePlan) => {
      const { coverageAudit: _coverageAudit, ...legacyArtifact } = searchArtifact("legacy", effectivePlan);
      return legacyArtifact;
    },
  }, { now });

  assert.equal(result.status, "complete");
  const artifact = result.artifacts[0]?.artifact;
  assert.ok(artifact && artifact.kind === "literature_search");
  assert.equal(artifact.coverageAudit, undefined);
  assert.deepEqual(result.sourceAudit.map((entry) => entry.source.queryVariantId), ["primary"]);
});

test("AbortSignal stops unscheduled work, reaches running executors, and returns an auditable partial session", async () => {
  const controller = new AbortController();
  const first = searchTask("first", searchPlan({ query: "first", limit: 2 }));
  const second = searchTask("second", searchPlan({ query: "second", limit: 2 }));
  const started: string[] = [];
  let signalReachedExecutor = false;

  const running = runLiteratureSearchSession(sessionPlan([first, second], 4, 1), {
    search: async (task, _effectivePlan, context) => {
      started.push(task.id);
      return new Promise<LiteratureSearchArtifact>((_resolve, reject) => {
        context.signal?.addEventListener("abort", () => {
          signalReachedExecutor = true;
          reject(new Error("executor observed cancellation"));
        }, { once: true });
      });
    },
  }, { now, signal: controller.signal });

  await waitFor(() => started.length === 1);
  controller.abort();
  const result = await running;

  assert.equal(signalReachedExecutor, true);
  assert.deepEqual(started, ["first"]);
  assert.equal(result.status, "cancelled");
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.tasks[0]?.state, "cancelled");
  assert.equal(result.tasks[1]?.state, "cancelled");
  assert.equal(result.tasks[1]?.reason?.code, "cancelled");
  assert.equal(result.budget.allocatedResultSlots, 2);
});

test("session output keeps planner task order and sorts source audit independently of completion order", async () => {
  const first = searchTask("first", searchPlan({ query: "first query", limit: 2 }));
  const second = searchTask("second", searchPlan({ query: "second query", limit: 2 }));
  const firstGate = deferred<void>();
  let firstStarted = false;
  let secondStarted = false;

  const running = runLiteratureSearchSession(sessionPlan([first, second], 4, 2), {
    search: async (task, effectivePlan) => {
      if (task.id === "first") {
        firstStarted = true;
        await firstGate.promise;
        return searchArtifact(task.id, effectivePlan, [
          source({ id: "zeta", name: "Zeta", queryVariantId: "primary", coverage: "zeta coverage" }),
          source({ id: "alpha", name: "Alpha", queryVariantId: "primary", coverage: "alpha coverage" }),
        ]);
      }
      secondStarted = true;
      return searchArtifact(task.id, effectivePlan, [source({ id: "middle", queryVariantId: "primary" })]);
    },
  }, { now });

  await waitFor(() => firstStarted && secondStarted);
  firstGate.resolve();
  const result = await running;

  assert.deepEqual(result.tasks.map((task) => task.taskId), ["first", "second"]);
  assert.deepEqual(result.artifacts.map((artifact) => artifact.taskId), ["first", "second"]);
  assert.deepEqual(result.sourceAudit.map((entry) => [
    entry.taskId,
    entry.source.id,
    entry.query,
    entry.source.retrievedAt,
    entry.source.coverage,
  ]), [
    ["first", "alpha", "first query", retrievedAt, "alpha coverage"],
    ["first", "zeta", "first query", retrievedAt, "zeta coverage"],
    ["second", "middle", "second query", retrievedAt, "middle coverage"],
  ]);
});
