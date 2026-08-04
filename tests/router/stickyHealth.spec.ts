import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalModelError,
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelRuntime,
} from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { createRouterRuntime, type RouterRuntime } from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import { ProviderHealthTracker } from "../../src/router/health/ProviderHealthTracker.js";
import { SessionRouterStore } from "../../src/router/session/SessionRouterStore.js";
import type {
  TierClassifier,
  TokenSaverDecision,
} from "../../src/router/tokenSaver/tierClassifier.js";

const M1 = { id: "p1/m1", provider: "p1", model: "m1" };
const M2 = { id: "p1/m2", provider: "p1", model: "m2" };

function createConfig(overrides: { stickyTtlMs?: number; maxQualityFailures?: number } = {}): RouterConfig {
  return {
    enabled: true,
    scenarios: { default: M2 },
    fallback: { default: [M2] },
    tokenSaver: {
      enabled: true,
      judge: M1,
      defaultTier: "medium",
      judgeTimeoutMs: 1_000,
      tiers: {
        simple: { model: M1, description: "Simple work" },
        medium: { model: M2, description: "Medium work" },
        complex: { model: M2, description: "Complex orchestration" },
        reasoning: { model: M2, description: "Deep reasoning" },
      },
    },
    sticky: {
      enabled: true,
      ttlMs: overrides.stickyTtlMs ?? 1_000,
      maxQualityFailures: overrides.maxQualityFailures ?? 2,
    },
    stats: { enabled: false },
  };
}

function makeRequest(): CanonicalModelRequest {
  return {
    provider: "p1",
    model: "m1",
    messages: [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ],
    stream: true,
  };
}

function makeDecision(provider = "p1", model = "m1", tier = "simple") {
  return {
    provider,
    model,
    scenarioType: "default" as const,
    tokenSaverTier: tier,
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "tokenSaver" as const,
    mutations: {},
  };
}

/** Scripted tier classifier — counts invocations, serves a queue of tiers. */
function createScriptedClassifier(tiers: string[]): {
  classifier: TierClassifier;
  getCalls: () => number;
} {
  const counter = { calls: 0 };
  let index = 0;
  return {
    // Function reference (not a getter snapshot) so tests read the live count.
    getCalls: () => counter.calls,
    classifier: {
      async classify(): Promise<TokenSaverDecision> {
        counter.calls += 1;
        const tier = tiers[Math.min(index, tiers.length - 1)];
        index += 1;
        const model = tier === "simple" ? M1 : M2;
        return { tier, selection: model, resolvedFrom: "judge" };
      },
    },
  };
}

type ScriptedRuntimeOptions = {
  /** Provider -> stream behavior; when a provider is missing, defaults to success. */
  failProviders?: Map<string, CanonicalModelError>;
  /** Records providers that stream() was actually invoked for. */
  streamedProviders?: string[];
};

function createScriptedModelRuntime(options: ScriptedRuntimeOptions = {}): ModelRuntime {
  const failProviders = options.failProviders ?? new Map();
  const streamedProviders = options.streamedProviders ?? [];
  return {
    async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      streamedProviders.push(request.provider);
      const failure = failProviders.get(request.provider);
      if (failure) {
        yield { type: "error", error: failure };
        return;
      }
      yield { type: "text_delta", text: "ok" };
      yield {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete(): Promise<CanonicalModelResponse> {
      return { role: "assistant", content: [{ type: "text", text: "ok" }], finishReason: "stop" };
    },
    getCapabilities: () => ({
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsToolUse: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 4_096,
    }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "http://127.0.0.1:1/v1",
  };
}

function hardError(provider: string, code: string): CanonicalModelError {
  return {
    provider,
    protocol: "openai",
    code,
    message: `${code} for ${provider}`,
    retryable: false,
  };
}

async function drainExecute(
  router: ReturnType<typeof createRouterRuntime>,
  sessionId: string,
  turnId: string,
): Promise<void> {
  const ctx = { sessionId, turnId, projectPath: "/tmp/test-project" };
  for await (const _event of router.execute(makeDecision(), makeRequest(), ctx)) {
    // drain
  }
}

test("sticky: fresh sticky is reused without re-judging", async () => {
  const now = { value: 1_000 };
  const { classifier, getCalls } = createScriptedClassifier(["simple"]);
  const router = createRouterRuntime(createConfig(), {
    modelRuntime: createScriptedModelRuntime(),
    tierClassifier: classifier,
    now: () => new Date(now.value),
  });

  const sessionId = "s1";
  const first = await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
  assert.equal(first.model, "m1");
  assert.equal(getCalls(), 1);

  now.value = 1_400; // within 1000ms TTL
  const second = await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
  assert.equal(second.model, "m1");
  assert.equal(second.resolvedFrom, "tokenSaver");
  assert.equal(getCalls(), 1, "sticky hit must not re-invoke the classifier");
});

test("sticky: expired sticky is released and re-judged", async () => {
  const now = { value: 1_000 };
  const { classifier, getCalls } = createScriptedClassifier(["simple", "medium"]);
  const router = createRouterRuntime(createConfig({ stickyTtlMs: 1_000 }), {
    modelRuntime: createScriptedModelRuntime(),
    tierClassifier: classifier,
    now: () => new Date(now.value),
  });

  const sessionId = "s2";
  const first = await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
  assert.equal(first.model, "m1");

  now.value = 2_500; // past the 1000ms TTL
  const second = await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
  assert.equal(getCalls(), 2, "expired sticky must trigger a fresh classification");
  assert.equal(second.model, "m2", "re-judged selection must win over the expired sticky");
});

test("sticky: quality failures release the pin after maxQualityFailures", async () => {
  const now = { value: 1_000 };
  const store = new SessionRouterStore({ now: () => now.value });
  const failProviders = new Map<string, CanonicalModelError>([
    ["p1", hardError("p1", "server_error")],
  ]);
  const { classifier, getCalls } = createScriptedClassifier(["simple", "medium"]);
  const router = createRouterRuntime(createConfig({ maxQualityFailures: 2 }), {
    modelRuntime: createScriptedModelRuntime({ failProviders }),
    tierClassifier: classifier,
    sessionStore: store,
    now: () => new Date(now.value),
  });

  const sessionId = "s3";

  // Turn 1: judge selects simple (m1); execute fails entirely -> failure #1.
  const d1 = await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
  assert.equal(d1.model, "m1");
  await drainExecute(router, sessionId, "t1");
  assert.equal(store.get(sessionId, false)?.qualityFailures, 1);

  // Turn 2: sticky still usable (1 < 2) -> no re-judge, same broken model, failure #2.
  const d2 = await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
  assert.equal(d2.model, "m1");
  assert.equal(getCalls(), 1, "sticky within the quality budget must not re-judge");
  await drainExecute(router, sessionId, "t2");
  assert.equal(store.get(sessionId, false)?.qualityFailures, 2);

  // Turn 3: sticky released (2 >= 2) -> classifier re-invoked, picks medium (m2).
  const d3 = await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
  assert.equal(getCalls(), 2, "quality-failure limit must release the sticky");
  assert.equal(d3.model, "m2");
});

test("sticky: successful turn resets the quality-failure counter", async () => {
  const now = { value: 1_000 };
  const store = new SessionRouterStore({ now: () => now.value });
  const failProviders = new Map<string, CanonicalModelError>([
    ["p1", hardError("p1", "server_error")],
  ]);
  const router = createRouterRuntime(createConfig(), {
    modelRuntime: createScriptedModelRuntime({ failProviders }),
    tierClassifier: createScriptedClassifier(["simple"]).classifier,
    sessionStore: store,
    now: () => new Date(now.value),
  });

  const sessionId = "s4";
  await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
  await drainExecute(router, sessionId, "t1");
  assert.equal(store.get(sessionId, false)?.qualityFailures, 1);

  // Make p1 healthy again; the next executed turn succeeds and resets the counter.
  failProviders.delete("p1");
  await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
  await drainExecute(router, sessionId, "t2");
  const state = store.get(sessionId, false);
  assert.equal(state?.qualityFailures, 0, "successful turn must reset the counter");
});

test("health: shared tracker propagates provider outage across router instances", async () => {
  const shared = new ProviderHealthTracker({ openThreshold: 3, openDurationMs: 60_000 });
  const now = () => new Date(1_000);
  const streamedProviders: string[] = [];
  const failProviders = new Map<string, CanonicalModelError>([
    ["p1", hardError("p1", "model_not_found")],
    ["p3", hardError("p3", "model_not_found")],
  ]);
  const modelRuntime = createScriptedModelRuntime({ failProviders, streamedProviders });

  const P2 = { id: "p2/m9", provider: "p2", model: "m9" };
  const P3 = { id: "p3/m9", provider: "p3", model: "m9" };

  // Router A: requested p1, fallback p3 — both fail, so after three turns
  // the shared tracker has opened both providers.
  const routerA = createRouterRuntime(
    {
      ...createConfig(),
      scenarios: { default: M1 },
      fallback: { default: [P3] },
    },
    {
      modelRuntime,
      healthTracker: shared,
      tierClassifier: createScriptedClassifier(["simple"]).classifier,
      now,
    },
  );
  for (let i = 0; i < 3; i += 1) {
    await routerA.decide({ request: makeRequest(), sessionId: "a", isMainAgent: true });
    await drainExecute(routerA, "a", `ta-${i}`);
  }
  assert.equal(shared.getState("p1"), "open");
  assert.equal(shared.getState("p3"), "open");

  // Router B (a *different* runtime instance) must inherit the outage from
  // the shared tracker: the p3 fallback is skipped without a single stream
  // call, and only p1 (the requested attempt) + p2 (the healthy fallback)
  // are streamed.
  const routerB = createRouterRuntime(
    {
      ...createConfig(),
      scenarios: { default: M1 },
      fallback: { default: [P3, P2] },
    },
    {
      modelRuntime,
      healthTracker: shared,
      tierClassifier: createScriptedClassifier(["simple"]).classifier,
      now,
    },
  );
  streamedProviders.length = 0;
  await routerB.decide({ request: makeRequest(), sessionId: "b", isMainAgent: true });
  await drainExecute(routerB, "b", "tb-0");
  assert.ok(
    !streamedProviders.includes("p3"),
    "open fallback provider must be skipped in another router instance",
  );
  assert.deepEqual(streamedProviders, ["p1", "p2"]);
});

test("sticky: sliding TTL — active sessions never expire mid-conversation", async () => {
  const now = { value: 1_000 };
  const store = new SessionRouterStore({ now: () => now.value });
  const { classifier, getCalls } = createScriptedClassifier(["simple"]);
  const router = createRouterRuntime(createConfig({ stickyTtlMs: 30_000 }), {
    modelRuntime: createScriptedModelRuntime(),
    tierClassifier: classifier,
    sessionStore: store,
    now: () => new Date(now.value),
  });
  const sessionId = "s-slide";

  // Turn 1 at t=0: judge pins m1.
  const d1 = await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
  assert.equal(d1.model, "m1");
  await drainExecute(router, sessionId, "t1");

  // Turn 2 at t=20s: sticky hit refreshes the pin (sliding window).
  now.value += 20_000;
  const d2 = await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
  assert.equal(d2.model, "m1");
  assert.equal(getCalls(), 1);

  // Turn 3 at t=40s: 40s > 30s TTL, but the pin was refreshed at t=20s —
  // an active session must not be re-classified mid-conversation.
  now.value += 20_000;
  const d3 = await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
  assert.equal(d3.model, "m1", "sliding TTL keeps the pin while turns keep coming");
  assert.equal(getCalls(), 1, "no re-judge while the session is active");

  // Idle for 35s: the pin now expires and the next turn re-judges.
  now.value += 35_000;
  const d4 = await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
  assert.equal(getCalls(), 2, "an idle session's pin expires");
});

test("sticky: request-shape errors (invalid_request) do not count toward release", async () => {
  const now = { value: 1_000 };
  const store = new SessionRouterStore({ now: () => now.value });
  // invalid_request would fail identically on any provider — evicting the
  // pin would only re-judge into the same wall (Claude Code semantics).
  // (Not auth_error/rate_limit_error: auth is fallback-eligible and 429 is a
  // health STRESS_CODE — both degrade the provider, and the degraded pin is
  // bypassed by the health check, which is tested separately.)
  const failProviders = new Map<string, CanonicalModelError>([
    ["p1", hardError("p1", "invalid_request")],
  ]);
  const { classifier, getCalls } = createScriptedClassifier(["simple"]);
  const router = createRouterRuntime(createConfig({ maxQualityFailures: 2 }), {
    modelRuntime: createScriptedModelRuntime({ failProviders }),
    tierClassifier: classifier,
    sessionStore: store,
    now: () => new Date(now.value),
  });
  const sessionId = "s-rl";

  for (let i = 0; i < 3; i += 1) {
    await router.decide({ request: makeRequest(), sessionId, isMainAgent: true });
    await drainExecute(router, sessionId, `t${i}`);
  }
  assert.equal(store.get(sessionId, false)?.qualityFailures ?? 0, 0, "request-shape failures must not accumulate");
  assert.equal(getCalls(), 1, "the pin survives request-shape failures without re-judging");
});

test("sticky: degraded provider bypasses the pin without deleting it", async () => {
  const now = { value: 1_000 };
  const store = new SessionRouterStore({ now: () => now.value });
  // Seed a pin to p1, then degrade p1 in the shared tracker.
  store.set({
    sessionId: "s-deg",
    isSubagent: false,
    stickyProvider: "p1",
    stickyModel: "m1",
    tokenSaverTier: "simple",
    orchestrating: false,
    qualityFailures: 0,
    updatedAt: now.value,
  });
  const shared = new ProviderHealthTracker();
  for (let i = 0; i < 3; i += 1) {
    shared.recordFailure("p1", "server_error");
  }
  assert.equal(shared.getState("p1"), "degraded");

  const { classifier, getCalls } = createScriptedClassifier(["simple"]);
  const router = createRouterRuntime(createConfig(), {
    modelRuntime: createScriptedModelRuntime(),
    tierClassifier: classifier,
    sessionStore: store,
    healthTracker: shared,
    now: () => new Date(now.value),
  });

  const decision = await router.decide({ request: makeRequest(), sessionId: "s-deg", isMainAgent: true });
  assert.equal(getCalls(), 1, "a degraded provider's pin must not bypass the judge");
  assert.equal(decision.resolvedFrom, "judge");
  const pin = store.get("s-deg", false);
  assert.equal(pin?.stickyProvider, "p1", "the pin is preserved for reuse after recovery");
});
