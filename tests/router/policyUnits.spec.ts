import assert from "node:assert/strict";
import test from "node:test";

import { maybePreserveStickyForCache } from "../../src/router/policy/cacheAwareSwitching.js";
import { createStickyGuard } from "../../src/router/policy/stickyGuard.js";
import {
  buildAttemptPlans,
  clampMaxOutputTokensToModelCap,
} from "../../src/router/execution/attemptPlanning.js";
import { createMediaCapabilityChecks } from "../../src/router/policy/mediaCapability.js";
import {
  calculateLiteLLMRetryDelay,
  classifyRetryReason,
  isMidStreamRateLimitError,
} from "../../src/router/execution/errors.js";
import type { ModelRuntime } from "../../src/model/index.js";

const M1 = { id: "p1/m1", provider: "p1", model: "m1" };
const M2 = { id: "p1/m2", provider: "p1", model: "m2" };

function textMessages(count: number) {
  return Array.from({ length: count }, () => ({
    role: "user" as const,
    content: [{ type: "text" as const, text: "hello world" }],
  }));
}

// ---------------------------------------------------------------------------
// stickyGuard
// ---------------------------------------------------------------------------

test("stickyGuard: fresh healthy sticky is usable; expired or degraded is not", () => {
  let now = 1_000;
  const guard = createStickyGuard({ enabled: true, ttlMs: 1_000, maxQualityFailures: 2 }, () => now);
  const base = {
    sessionId: "s",
    isSubagent: false,
    orchestrating: false,
    updatedAt: 500,
  };

  assert.equal(guard({ ...base, stickyProvider: "p1", stickyModel: "m1" }), true);
  now = 2_000; // 1500ms since updatedAt > 1000ms TTL
  assert.equal(guard({ ...base, stickyProvider: "p1", stickyModel: "m1" }), false);

  now = 1_000;
  assert.equal(
    guard({ ...base, stickyProvider: "p1", stickyModel: "m1", qualityFailures: 2 }),
    false,
    "quality failures at the threshold must release the sticky",
  );
  assert.equal(
    guard({ ...base, stickyProvider: "p1", stickyModel: "m1", qualityFailures: 1 }),
    true,
    "below-threshold failures keep the sticky",
  );
});

test("stickyGuard: guard type-predicate narrows provider/model", () => {
  const guard = createStickyGuard(undefined, () => 1_000);
  const state = {
    sessionId: "s",
    isSubagent: false,
    orchestrating: false,
    stickyProvider: "p1",
    stickyModel: "m1",
    updatedAt: 1_000,
  };
  if (guard(state)) {
    // Inside the branch, provider/model are guaranteed non-undefined strings.
    assert.equal(typeof state.stickyProvider, "string");
    assert.equal(typeof state.stickyModel, "string");
  } else {
    assert.fail("expected sticky to be usable");
  }
});

// ---------------------------------------------------------------------------
// cacheAwareSwitching
// ---------------------------------------------------------------------------

test("cacheAwareSwitching: disabled config or same model passes through", () => {
  const messages = textMessages(2);
  const result = maybePreserveStickyForCache(
    M1,
    M2,
    messages,
    { inputTokens: 100, cacheReadTokens: 90 },
    { enabled: false, minSavingsRatio: 0.1 },
    undefined,
  );
  assert.equal(result.selection, M2);
  assert.equal(result.mutation, undefined);

  const same = maybePreserveStickyForCache(
    M1,
    M1,
    messages,
    { inputTokens: 100, cacheReadTokens: 90 },
    { enabled: true, minSavingsRatio: 0.1 },
    undefined,
  );
  assert.equal(same.selection, M1);
});

test("cacheAwareSwitching: no observed cache hit never keeps sticky", () => {
  const result = maybePreserveStickyForCache(
    M1,
    M2,
    textMessages(2),
    { inputTokens: 100, cacheReadTokens: 0 },
    { enabled: true, minSavingsRatio: 0.1 },
    undefined,
  );
  assert.equal(result.selection, M2);
});

test("cacheAwareSwitching: keeps sticky when cached cost is cheaper than re-prefill", () => {
  // Prices are passed via modelPricing; without pricing info the cached-cost
  // calculation falls back to defaults. Use pricing that makes staying cheap:
  // current model priced by cache-read, next model expensive per input token.
  const modelPricing = {
    "p1/m1": { input: 1, output: 1, cacheRead: 0.1 },
    "p1/m2": { input: 10, output: 1 },
  };
  const messages = textMessages(4);
  const result = maybePreserveStickyForCache(
    M1,
    M2,
    messages,
    { inputTokens: 200, cacheReadTokens: 180 },
    { enabled: true, minSavingsRatio: 0.1 },
    modelPricing,
  );
  assert.equal(result.selection.provider, "p1");
  assert.equal(result.selection.model, "m1");
  assert.equal(result.mutation?.action, "kept_sticky");
});

// ---------------------------------------------------------------------------
// attemptPlanning
// ---------------------------------------------------------------------------

function textOnlyRuntime(): ModelRuntime {
  return {
    async *stream() {},
    async complete() {
      return { role: "assistant", content: [], finishReason: "stop" };
    },
    getCapabilities: () => ({
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: false,
      supportsThinking: false,
      supportsJsonSchema: false,
      supportsSystemPrompt: true,
      supportsPromptCache: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
    }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "http://127.0.0.1:1/v1",
  };
}

function multimodalRuntime(): ModelRuntime {
  const base = textOnlyRuntime();
  return {
    ...base,
    getMultimodal: (provider) =>
      provider === "p2" ? { input: ["text", "image"] } : { input: ["text"] },
  };
}

test("attemptPlanning: media-capable attempts come first, downgraded last", () => {
  const checks = createMediaCapabilityChecks(multimodalRuntime());
  const plans = buildAttemptPlans(
    [M1, { id: "p2/m9", provider: "p2", model: "m9" }],
    ["image"],
    checks,
  );
  assert.equal(plans.length, 2);
  assert.equal(plans[0]!.attempt.provider, "p2");
  assert.equal(plans[0]!.downgradeUnsupportedMedia, false);
  assert.equal(plans[1]!.attempt.provider, "p1");
  assert.equal(plans[1]!.downgradeUnsupportedMedia, true);
});

test("attemptPlanning: text-only request keeps native order", () => {
  const checks = createMediaCapabilityChecks(multimodalRuntime());
  const plans = buildAttemptPlans([M1, { id: "p2/m9", provider: "p2", model: "m9" }], [], checks);
  assert.equal(plans.length, 2);
  assert.equal(plans.every((plan) => plan.downgradeUnsupportedMedia === false), true);
});

test("attemptPlanning: clamps maxOutputTokens to model cap", () => {
  const runtime = textOnlyRuntime();
  const clamped = clampMaxOutputTokensToModelCap(
    { provider: "p1", model: "m1", messages: [], maxOutputTokens: 100_000 },
    runtime,
  );
  assert.equal(clamped.maxOutputTokens, 8_192);
  const untouched = clampMaxOutputTokensToModelCap(
    { provider: "p1", model: "m1", messages: [], maxOutputTokens: 4_000 },
    runtime,
  );
  assert.equal(untouched.maxOutputTokens, 4_000);
});

// ---------------------------------------------------------------------------
// execution/errors
// ---------------------------------------------------------------------------

test("errors: retry delay grows deterministically and respects the cap", () => {
  const d0 = calculateLiteLLMRetryDelay(0, 500, 8_000);
  const d1 = calculateLiteLLMRetryDelay(1, 500, 8_000);
  assert.ok(d0 >= 500 && d0 <= 500 * (1 + 0.75));
  assert.ok(d1 >= 1_000 && d1 <= 1_000 * (1 + 0.75));
  assert.ok(calculateLiteLLMRetryDelay(100, 500, 8_000) <= 8_000);
});

test("errors: retry reason and mid-stream classification", () => {
  assert.equal(classifyRetryReason("rate_limit_error"), "rate_limit");
  assert.equal(classifyRetryReason("server_error"), "server_error");
  assert.equal(classifyRetryReason("timeout"), "network_error");
  assert.equal(classifyRetryReason("weird_code"), "server_error");
  assert.equal(
    isMidStreamRateLimitError({ provider: "p", protocol: "openai", code: "rate_limit_error", message: "slow down", retryable: true }),
    true,
  );
  assert.equal(
    isMidStreamRateLimitError({ provider: "p", protocol: "openai", code: "auth_error", message: "nope", retryable: false }),
    false,
  );
});
