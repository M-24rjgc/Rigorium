import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PermissionRuntime } from "../../../src/permission/index.js";
import { DEFAULT_RESEARCH_SETTINGS, writeResearchSettings } from "../../../src/research/settings.js";
import {
  createLiteratureDeepSearchTool,
  type LiteratureDeepSearchInput,
} from "../../../src/tool/builtin/literatureDeepSearch.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

const OPENALEX_ENDPOINT = "https://openalex.test/works";
const retrievedAt = "2026-07-23T00:00:00.000Z";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function openAlexWork(id: string, title: string, referencedWorks: string[] = []) {
  const canonicalId = `https://openalex.org/${id}`;
  return {
    id: canonicalId,
    display_name: title,
    publication_year: 2025,
    cited_by_count: 4,
    authorships: [{ author: { display_name: "Ada Lovelace" } }],
    primary_location: { landing_page_url: `https://example.test/${id}`, source: { display_name: "Test Journal" } },
    topics: [],
    referenced_works: referencedWorks,
    ids: { openalex: canonicalId },
  };
}

async function configureOpenAlexOnly(pilotHome: string): Promise<void> {
  await writeResearchSettings({
    scope: "global",
    pilotHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        sources: {
          openalex: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.openalex, enabled: true },
          arxiv: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.arxiv, enabled: false },
          crossref: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.crossref, enabled: false },
          openreview: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.openreview, enabled: false },
        },
      },
    },
  });
}

function context(root: string, pilotHome: string, abortSignal?: AbortSignal) {
  return {
    cwd: join(root, "project"),
    env: { PILOT_HOME: pilotHome },
    now: () => new Date(retrievedAt),
    ...(abortSignal ? { abortSignal } : {}),
  } as any;
}

function runtimeContext(root: string, pilotHome: string) {
  return {
    ...context(root, pilotHome),
    sessionId: "deep-search-test-session",
    turnId: "deep-search-test-turn",
    permissionMode: "bypassPermissions" as const,
    permissionContext: {
      mode: "bypassPermissions" as const,
      cwd: join(root, "project"),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function validationContext() {
  return context(tmpdir(), join(tmpdir(), "rigorium-deep-search-validation-home"));
}

function validDeepSearchInput(overrides: Partial<LiteratureDeepSearchInput> = {}): LiteratureDeepSearchInput {
  return {
    intent: "Validate a bounded deep-search session.",
    tasks: [{
      id: "search",
      kind: "search",
      intent: "Collect literature for validation.",
      query: "validation query",
      limit: 1,
    }],
    ...overrides,
  };
}

async function assertValidationIssue(
  tool: ReturnType<typeof createLiteratureDeepSearchTool>,
  input: LiteratureDeepSearchInput,
  expectedPath: string,
  expectedMessage: string,
): Promise<void> {
  const validation = await tool.validateInput!(input, validationContext());
  assert.deepEqual(validation, {
    ok: false,
    issues: [{ path: expectedPath, code: "invalid_schema", message: expectedMessage }],
  });
}

test("literature_deep_search prevalidates an instance result-budget limit", async () => {
  await assertValidationIssue(
    createLiteratureDeepSearchTool({ maxTotalResultBudget: 2 }),
    validDeepSearchInput({ totalResultBudget: 3 }),
    "$.totalResultBudget",
    "must be an integer between 0 and 2.",
  );
});

test("literature_deep_search prevalidates an instance concurrency limit", async () => {
  await assertValidationIssue(
    createLiteratureDeepSearchTool({ maxConcurrentTasks: 1 }),
    validDeepSearchInput({ maxConcurrentTasks: 2 }),
    "$.maxConcurrentTasks",
    "must be an integer between 1 and 1.",
  );
});

test("literature_deep_search prevalidates an instance timeout limit", async () => {
  await assertValidationIssue(
    createLiteratureDeepSearchTool({ maxTimeoutMs: 100 }),
    validDeepSearchInput({ timeoutMs: 101 }),
    "$.timeoutMs",
    "must be an integer between 1 and 100.",
  );
});

test("literature_deep_search rejects an unknown task dependency during prevalidation", async () => {
  await assertValidationIssue(
    createLiteratureDeepSearchTool(),
    validDeepSearchInput({
      tasks: [{
        id: "search",
        kind: "search",
        intent: "Collect literature for validation.",
        query: "validation query",
        dependsOn: ["missing"],
      }],
    }),
    "$.tasks[0].dependsOn[0]",
    "references unknown task ID 'missing'.",
  );
});

test("literature_deep_search rejects a task that depends on itself during prevalidation", async () => {
  await assertValidationIssue(
    createLiteratureDeepSearchTool(),
    validDeepSearchInput({
      tasks: [{
        id: "root",
        kind: "search",
        intent: "Collect literature for validation.",
        query: "validation query",
        dependsOn: ["root"],
      }],
    }),
    "$.tasks[0].dependsOn[0]",
    "cannot depend on its own task ID.",
  );
});

test("literature_deep_search rejects duplicate task dependencies during prevalidation", async () => {
  await assertValidationIssue(
    createLiteratureDeepSearchTool(),
    validDeepSearchInput({
      tasks: [
        {
          id: "root",
          kind: "search",
          intent: "Collect the root literature set.",
          query: "root query",
        },
        {
          id: "dependent",
          kind: "search",
          intent: "Collect literature after the root set.",
          query: "dependent query",
          dependsOn: ["root", "root"],
        },
      ],
    }),
    "$.tasks[1].dependsOn[1]",
    "repeats dependency 'root'.",
  );
});

test("literature_deep_search rejects dependency cycles during prevalidation", async () => {
  await assertValidationIssue(
    createLiteratureDeepSearchTool(),
    validDeepSearchInput({
      tasks: [
        {
          id: "first",
          kind: "search",
          intent: "Collect the first literature set.",
          query: "first query",
          dependsOn: ["second"],
        },
        {
          id: "second",
          kind: "search",
          intent: "Collect the second literature set.",
          query: "second query",
          dependsOn: ["first"],
        },
      ],
    }),
    "$.tasks[1].dependsOn[0]",
    "creates a dependency cycle through 'first'.",
  );
});

test("literature_deep_search rejects duplicate expansion directions during prevalidation", async () => {
  await assertValidationIssue(
    createLiteratureDeepSearchTool(),
    validDeepSearchInput({
      tasks: [{
        id: "expand",
        kind: "expansion",
        intent: "Expand a validation seed.",
        seed: { openAlexId: "W1" },
        directions: ["references", "references"],
      }],
    }),
    "$.tasks[0].directions",
    "must not repeat expansion directions.",
  );
});

test("literature_deep_search uses ToolRuntime validation before issuing network requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-deep-search-runtime-"));
  const pilotHome = join(root, "pilot-home");
  let fetchCalls = 0;
  const registry = new ToolRegistry();
  registry.register(createLiteratureDeepSearchTool({
    search: {
      endpoint: OPENALEX_ENDPOINT,
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse({});
      },
    },
  }));
  const runtime = new ToolRuntime(registry, new PermissionRuntime());

  const result = await runtime.execute({
    id: "invalid-deep-search",
    name: "literature_deep_search",
    input: {
      intent: "Reject the malformed session before its network phase.",
      tasks: [],
      timeoutMs: 0,
    },
  }, runtimeContext(root, pilotHome));

  assert.equal(result.type, "error");
  assert.equal(result.error.code, "invalid_tool_input");
  assert.equal(fetchCalls, 0);
});

test("literature_deep_search runs an explicit task graph with bounded concurrency and a traceable session artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-deep-search-graph-"));
  const pilotHome = join(root, "pilot-home");
  await configureOpenAlexOnly(pilotHome);
  const startedQueries: string[] = [];
  let activeRequests = 0;
  let peakRequests = 0;
  let releaseParallelFetches!: () => void;
  const parallelFetches = new Promise<void>((resolve) => {
    releaseParallelFetches = resolve;
  });
  const tool = createLiteratureDeepSearchTool({
    search: {
      endpoint: OPENALEX_ENDPOINT,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        const query = url.searchParams.get("search") ?? "";
        startedQueries.push(query);
        activeRequests += 1;
        peakRequests = Math.max(peakRequests, activeRequests);
        if (query === "foundation models" || query === "agentic systems") {
          if (startedQueries.filter((item) => item === "foundation models" || item === "agentic systems").length === 2) {
            releaseParallelFetches();
          }
          await parallelFetches;
        }
        activeRequests -= 1;
        return jsonResponse({ meta: { count: 1 }, results: [openAlexWork(`W${startedQueries.length}`, query)] });
      },
    },
  });

  const result = await tool.execute({
    intent: "Compare foundation-model and agentic-system terminology before a focused follow-up.",
    totalResultBudget: 3,
    maxConcurrentTasks: 2,
    timeoutMs: 1_000,
    tasks: [
      {
        id: "foundation",
        kind: "search",
        intent: "Find the foundation-model literature.",
        query: "foundation models",
        limit: 1,
      },
      {
        id: "agents",
        kind: "search",
        intent: "Find the agentic-system literature.",
        query: "agentic systems",
        limit: 1,
      },
      {
        id: "follow-up",
        kind: "search",
        intent: "Run the answer-oriented comparison after the two recall searches complete.",
        queryKind: "question",
        dependsOn: ["foundation", "agents"],
        query: "foundation model agent comparison",
        limit: 1,
      },
    ],
  }, context(root, pilotHome));

  assert.equal(result.data?.kind, "literature_search_session");
  assert.equal(result.data?.status, "complete");
  assert.equal(result.data?.budget.maxConcurrentTasks, 2);
  assert.equal(result.data?.budget.allocatedResultSlots, 3);
  assert.equal(result.data?.coverage.resultCount, 3);
  assert.equal(peakRequests, 2);
  assert.deepEqual(result.data?.tasks.map((task) => [task.taskId, task.state]), [
    ["foundation", "succeeded"],
    ["agents", "succeeded"],
    ["follow-up", "succeeded"],
  ]);
  assert.equal(startedQueries.at(-1), "foundation model agent comparison");
  assert.deepEqual(result.data?.sourceAudit.map((entry) => entry.taskId), ["foundation", "agents", "follow-up"]);
  assert.equal(result.data?.execution.timeoutMs, 1_000);
  assert.equal(result.data?.execution.timedOut, false);
  assert.equal(result.metadata?.timedOut, false);
  assert.match(String(result.content[0] && "text" in result.content[0] ? result.content[0].text : ""), /Status: complete/);
});

test("literature_deep_search keeps successful artifacts when a citation expansion fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-deep-search-partial-"));
  const pilotHome = join(root, "pilot-home");
  await configureOpenAlexOnly(pilotHome);
  const tool = createLiteratureDeepSearchTool({
    search: {
      endpoint: OPENALEX_ENDPOINT,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.searchParams.get("search") === "reliable search") {
          return jsonResponse({ meta: { count: 1 }, results: [openAlexWork("W1", "Reliable paper")] });
        }
        throw new Error(`Unexpected search request: ${url}`);
      },
    },
    expansion: {
      endpoint: OPENALEX_ENDPOINT,
      fetchImpl: async () => jsonResponse(null),
    },
  });

  const result = await tool.execute({
    intent: "Retain a useful search even if a citation branch cannot resolve its seed.",
    totalResultBudget: 2,
    maxConcurrentTasks: 2,
    timeoutMs: 1_000,
    tasks: [
      {
        id: "reliable-search",
        kind: "search",
        intent: "Collect a reliable initial result.",
        query: "reliable search",
        limit: 1,
      },
      {
        id: "unavailable-expansion",
        kind: "expansion",
        intent: "Expand a selected seed when the provider is available.",
        seed: { openAlexId: "W99" },
        directions: ["citations"],
        limitPerDirection: 1,
      },
    ],
  }, context(root, pilotHome));

  assert.equal(result.data?.status, "partial");
  assert.deepEqual(result.data?.coverage.successfulTaskIds, ["reliable-search"]);
  assert.deepEqual(result.data?.coverage.failedTaskIds, ["unavailable-expansion"]);
  assert.deepEqual(result.data?.artifacts.map((artifact) => artifact.taskId), ["reliable-search"]);
  assert.equal(result.data?.tasks.find((task) => task.taskId === "unavailable-expansion")?.reason?.code, "executor_failed");
  assert.deepEqual(result.data?.sourceAudit.map((entry) => entry.taskId), ["reliable-search"]);
});

test("literature_deep_search returns an auditable cancelled session when its whole-session timeout expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-deep-search-timeout-"));
  const pilotHome = join(root, "pilot-home");
  await configureOpenAlexOnly(pilotHome);
  const tool = createLiteratureDeepSearchTool({
    search: {
      endpoint: OPENALEX_ENDPOINT,
      fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(new DOMException("Request aborted", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
    },
  });

  const result = await tool.execute({
    intent: "Stop a slow retrieval pass without losing its scheduler audit.",
    timeoutMs: 20,
    tasks: [{
      id: "slow-search",
      kind: "search",
      intent: "Attempt a retrieval that will exceed the session deadline.",
      query: "slow search",
      limit: 1,
    }],
  }, context(root, pilotHome));

  assert.equal(result.data?.status, "cancelled");
  assert.equal(result.data?.stopReason, "cancelled");
  assert.equal(result.data?.tasks[0]?.state, "cancelled");
  assert.equal(result.data?.execution.timedOut, true);
  assert.equal(result.metadata?.timedOut, true);
  assert.match(String(result.content[0] && "text" in result.content[0] ? result.content[0].text : ""), /Timeout: 20ms \(reached\)/);
});
