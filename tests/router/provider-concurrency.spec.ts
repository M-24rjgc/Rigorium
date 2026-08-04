import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderConcurrencyGate,
  providerConcurrencyLimitError,
} from "../../src/router/execution/providerConcurrency.js";
import { streamAttempt } from "../../src/router/execution/streamAttempt.js";
import type { CanonicalModelEvent, CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";

function noopEvents() {
  return { emit: () => undefined };
}

function makeRequest(provider = "p1"): CanonicalModelRequest {
  return {
    provider,
    model: "m1",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    stream: true,
  };
}

/** ModelRuntime mock that tracks concurrent in-flight streams. */
function createTrackingRuntime(tracker: { maxConcurrent: number; current: number }) {
  return {
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      tracker.current += 1;
      tracker.maxConcurrent = Math.max(tracker.maxConcurrent, tracker.current);
      try {
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", finishReason: "stop" };
      } finally {
        tracker.current -= 1;
      }
    },
    async complete() {
      return { role: "assistant", content: [], finishReason: "stop" };
    },
    getCapabilities: () => ({ ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "http://127.0.0.1:1/v1",
  } satisfies ModelRuntime;
}

test("gate: disabled gate is a passthrough no-op", async () => {
  const gate = new ProviderConcurrencyGate({ enabled: false, maxPerProvider: 1 });
  const release = await gate.acquire("p1");
  assert.equal(gate.activeCount("p1"), 0, "disabled gate must not track slots");
  release();
  assert.equal(gate.waitingCount("p1"), 0);
});

test("gate: honors maxPerProvider and hands off FIFO", async () => {
  const gate = new ProviderConcurrencyGate({ enabled: true, maxPerProvider: 1 });
  const release1 = await gate.acquire("p1");
  assert.equal(gate.activeCount("p1"), 1);

  const order: string[] = [];
  const pending2 = gate.acquire("p1").then((release) => {
    order.push("second");
    return release;
  });
  const pending3 = gate.acquire("p1").then((release) => {
    order.push("third");
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gate.waitingCount("p1"), 2, "waiters queue up");

  release1();
  const release2 = await pending2;
  assert.deepEqual(order, ["second"], "FIFO: first waiter wins the freed slot");
  release2();
  const release3 = await pending3;
  assert.deepEqual(order, ["second", "third"]);
  release3();
  assert.equal(gate.activeCount("p1"), 0);
  assert.equal(gate.waitingCount("p1"), 0);
});

test("gate: queue timeout surfaces a retryable concurrency error", async () => {
  const gate = new ProviderConcurrencyGate({ enabled: true, maxPerProvider: 1, waitTimeoutMs: 40 });
  const release1 = await gate.acquire("p1");
  try {
    await gate.acquire("p1");
    assert.fail("second acquire must time out");
  } catch (caught) {
    const error = (caught as { error?: { code?: string; retryable?: boolean } }).error;
    assert.equal(error?.code, "provider_concurrency_limit");
    assert.equal(error?.retryable, true, "timeout must be retryable so the transient-retry loop can back off");
  } finally {
    release1();
  }
});

test("gate: abort during wait propagates and leaves no waiter behind", async () => {
  const gate = new ProviderConcurrencyGate({ enabled: true, maxPerProvider: 1, waitTimeoutMs: 5_000 });
  const release1 = await gate.acquire("p1");
  const controller = new AbortController();
  const pending = gate.acquire("p1", { abortSignal: controller.signal }).then(
    () => "resolved",
    (error) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new DOMException("canceled", "AbortError"));
  const result = await pending;
  assert.ok(result instanceof Error && result.name === "AbortError", "abort must reject the waiter");
  assert.equal(gate.waitingCount("p1"), 0, "aborted waiter must leave the queue");
  release1();
});

test("gate: per-provider isolation (p1 full does not block p2)", async () => {
  const gate = new ProviderConcurrencyGate({ enabled: true, maxPerProvider: 1 });
  const release1 = await gate.acquire("p1");
  const release2 = await gate.acquire("p2");
  assert.equal(gate.activeCount("p1"), 1);
  assert.equal(gate.activeCount("p2"), 1);
  release1();
  release2();
});

test("gate: providerConcurrencyLimitError carries the retryable contract", () => {
  const { error } = providerConcurrencyLimitError("p1", 30_000);
  assert.equal(error.code, "provider_concurrency_limit");
  assert.equal(error.retryable, true);
  assert.match(error.message, /p1/);
});

test("streamAttempt: gate is held for the full stream lifecycle", async () => {
  const gate = new ProviderConcurrencyGate({ enabled: true, maxPerProvider: 1 });
  const tracker = { maxConcurrent: 0, current: 0 };
  const runtime = createTrackingRuntime(tracker);
  const ctx = { sessionId: "s1", turnId: "t1", projectPath: "/tmp" };

  const run = () => {
    const items: unknown[] = [];
    return (async () => {
      for await (const item of streamAttempt(makeRequest(), runtime, ctx, noopEvents(), gate)) {
        items.push(item);
      }
      return items;
    })();
  };

  const first = run();
  const second = run();
  const [, secondItems] = await Promise.all([first, second]);
  const outcomes = secondItems.filter((item): item is { kind: "outcome"; outcome: { error?: unknown } } =>
    (item as { kind?: string }).kind === "outcome",
  );
  assert.equal(tracker.maxConcurrent, 1, "cap 1 must serialize concurrent streams");
  assert.equal(gate.activeCount("p1"), 0, "slot must be released after the stream ends");
  assert.ok(
    outcomes.every((outcome) => !(outcome.outcome as { error?: unknown }).error),
    "serialized streams must succeed",
  );
});

test("streamAttempt: gate timeout yields a concurrency error outcome (no provider call)", async () => {
  const gate = new ProviderConcurrencyGate({ enabled: true, maxPerProvider: 1, waitTimeoutMs: 30 });
  const tracker = { maxConcurrent: 0, current: 0 };
  const runtime = createTrackingRuntime(tracker);
  const ctx = { sessionId: "s1", turnId: "t1", projectPath: "/tmp" };
  // Hold the single slot from outside the router.
  const release = await gate.acquire("p1");

  let outcome: { error?: { code?: string; retryable?: boolean; protocol?: string } } | undefined;
  for await (const item of streamAttempt(makeRequest(), runtime, ctx, noopEvents(), gate)) {
    if (item.kind === "outcome") outcome = item.outcome as { error?: { code?: string } };
  }
  assert.equal(outcome?.error?.code, "provider_concurrency_limit");
  assert.equal(outcome.error?.retryable, true);
  assert.equal(tracker.maxConcurrent, 0, "provider must not be called when the slot cannot be acquired");
  release();
});

// ---------------------------------------------------------------------------
// RouterRuntime integration: the gate is process-wide across concurrent
// execute() calls on the same runtime (the gateway creates one runtime for
// all sessions).
// ---------------------------------------------------------------------------

import { createRouterRuntime } from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const M1 = { id: "p1/m1", provider: "p1", model: "m1" };
const M2 = { id: "p1/m2", provider: "p1", model: "m2" };

function createIntegrationConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    enabled: true,
    scenarios: { default: M2 },
    fallback: { default: [M2] },
    zeroUsageRetry: { enabled: false, maxAttempts: 2 },
    // Keep retries out of the way so the concurrency error surfaces fast.
    transientRetry: { enabled: false, maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 20 },
    concurrency: { enabled: true, maxPerProvider: 1, waitTimeoutMs: 40 },
    tokenSaver: {
      enabled: true,
      judge: M1,
      defaultTier: "medium",
      judgeTimeoutMs: 1_000,
      tiers: {
        simple: { model: M1 },
        medium: { model: M2 },
        complex: { model: M2 },
        reasoning: { model: M2 },
      },
    },
    sticky: { enabled: false },
    stats: { enabled: false },
    ...overrides,
  };
}

function integrationDecision() {
  return {
    provider: "p1",
    model: "m1",
    scenarioType: "default" as const,
    tokenSaverTier: "simple" as const,
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "tokenSaver" as const,
    mutations: {},
  };
}

/** Slow streaming runtime: holds each stream open `holdMs`, tracks concurrency. */
function createSlowRuntime(
  tracker: { maxConcurrent: number; current: number },
  holdMs = 30,
): ModelRuntime {
  return {
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      tracker.current += 1;
      tracker.maxConcurrent = Math.max(tracker.maxConcurrent, tracker.current);
      try {
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", finishReason: "stop" };
      } finally {
        tracker.current -= 1;
      }
    },
    async complete() {
      return { role: "assistant", content: [], finishReason: "stop" };
    },
    getCapabilities: () => ({ ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "http://127.0.0.1:1/v1",
  } satisfies ModelRuntime;
}

async function collectErrors(
  router: ReturnType<typeof createRouterRuntime>,
  sessionId: string,
  turnId: string,
): Promise<string[]> {
  const ctx = { sessionId, turnId, projectPath: "/tmp/test-project" };
  const codes: string[] = [];
  for await (const event of router.execute(integrationDecision(), makeRequest(), ctx)) {
    if (event.type === "error") {
      codes.push(event.error.code);
    }
  }
  return codes;
}

test("RouterRuntime: concurrency cap serializes concurrent executes", async () => {
  const tracker = { maxConcurrent: 0, current: 0 };
  const router = createRouterRuntime(createIntegrationConfig(), {
    modelRuntime: createSlowRuntime(tracker),
  });
  await Promise.all([
    collectErrors(router, "s1", "t1"),
    collectErrors(router, "s2", "t2"),
    collectErrors(router, "s3", "t3"),
  ]);
  assert.equal(tracker.maxConcurrent, 1, "cap 1 must serialize streams across sessions");
});

test("RouterRuntime: saturated provider surfaces provider_concurrency_limit (retryable)", async () => {
  const tracker = { maxConcurrent: 0, current: 0 };
  const router = createRouterRuntime(createIntegrationConfig(), {
    modelRuntime: createSlowRuntime(tracker, 150),
  });
  const first = collectErrors(router, "s1", "t1");
  // Give the first stream time to acquire the single slot.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const secondCodes = await collectErrors(router, "s2", "t2");
  const firstCodes = await first;
  assert.deepEqual(firstCodes, [], "the first turn succeeds");
  assert.deepEqual(secondCodes, ["provider_concurrency_limit"]);
});

test("RouterRuntime: disabled concurrency keeps unlimited concurrency", async () => {
  const tracker = { maxConcurrent: 0, current: 0 };
  const router = createRouterRuntime(
    createIntegrationConfig({ concurrency: { enabled: false, maxPerProvider: 1 } }),
    { modelRuntime: createSlowRuntime(tracker) },
  );
  await Promise.all([
    collectErrors(router, "s1", "t1"),
    collectErrors(router, "s2", "t2"),
    collectErrors(router, "s3", "t3"),
  ]);
  assert.ok(tracker.maxConcurrent >= 2, "no gate must allow concurrent streams");
});

test("gate: 429 feedback halves the effective cap until the window expires", async () => {
  const nowMs = { value: 1_000_000 };
  const gate = new ProviderConcurrencyGate({ enabled: true, maxPerProvider: 4, waitTimeoutMs: 5_000 });
  assert.equal(gate.effectiveCap("p1", nowMs.value), 4);

  gate.recordProviderFeedback("p1", { code: "rate_limit_error", retryAfterMs: 10_000 }, { nowMs: nowMs.value });
  assert.equal(gate.effectiveCap("p1", nowMs.value), 2, "cap halves during the suppression window");
  assert.equal(gate.effectiveCap("p2", nowMs.value), 4, "suppression is per-provider");

  nowMs.value += 5_000;
  assert.equal(gate.effectiveCap("p1", nowMs.value), 2, "still suppressed mid-window");
  nowMs.value += 5_000;
  assert.equal(gate.effectiveCap("p1", nowMs.value), 4, "cap recovers after the window");
});

test("gate: suppression window respects retry-after and caps it", async () => {
  const nowMs = { value: 1_000_000 };
  const gate = new ProviderConcurrencyGate({ enabled: true, maxPerProvider: 2 });
  gate.recordProviderFeedback(
    "p1",
    { code: "overloaded_error", retryAfterMs: 3600_000 },
    { nowMs: nowMs.value, maxSuppressionMs: 60_000 },
  );
  nowMs.value += 60_000;
  assert.equal(gate.effectiveCap("p1", nowMs.value), 2, "suppression is capped at maxSuppressionMs");

  gate.recordProviderFeedback("p1", { code: "server_error", retryAfterMs: 1_000 }, { nowMs: nowMs.value });
  assert.equal(gate.effectiveCap("p1", nowMs.value), 2, "non-429/overloaded codes do not suppress");
});

test("gate: 429 feedback is ignored when the gate is disabled", async () => {
  const gate = new ProviderConcurrencyGate({ enabled: false, maxPerProvider: 4 });
  gate.recordProviderFeedback("p1", { code: "rate_limit_error" });
  assert.equal(gate.effectiveCap("p1", 0), 4);
});
