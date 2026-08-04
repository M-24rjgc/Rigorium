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
import { SessionRouterStore } from "../../src/router/session/SessionRouterStore.js";

const M1 = { id: "p1/m1", provider: "p1", model: "m1" };
const M2 = { id: "p1/m2", provider: "p1", model: "m2" };

function createConfig(): RouterConfig {
  return {
    enabled: true,
    scenarios: { default: M2 },
    fallback: { default: [M2] },
    zeroUsageRetry: { enabled: false, maxAttempts: 2 },
    transientRetry: { enabled: true, maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
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

function makeDecision() {
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

function scriptedClassifier() {
  return {
    classify: async () => ({
      tier: "simple",
      selection: M1,
      resolvedFrom: "judge" as const,
    }),
  };
}

/** Scripted runtime: first stream fails mid-way after text + tool call. */
function createPartialToolCallRuntime(tracker: { calls: number }): ModelRuntime {
  return {
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      tracker.calls += 1;
      if (tracker.calls === 1) {
        // Mid-stream failure AFTER a partial tool-call block was emitted.
        yield { type: "text_delta", text: "Let me check" };
        yield {
          type: "tool_call",
          id: "call-partial",
          name: "read_file",
          input: { path: "/tmp/untru" },
        } as unknown as CanonicalModelEvent;
        yield {
          type: "error",
          error: {
            provider: "p1",
            protocol: "openai",
            code: "connection_reset",
            message: "reset",
            retryable: true,
          } as CanonicalModelError,
        };
        return;
      }
      // Continuation stream: completes cleanly.
      yield { type: "text_delta", text: " the file contents" };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete(): Promise<CanonicalModelResponse> {
      return { role: "assistant", content: [{ type: "text", text: "ok" }], finishReason: "stop" };
    },
    getCapabilities: () => ({ ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "http://127.0.0.1:1/v1",
  };
}

async function drain(router: ReturnType<typeof createRouterRuntime>, sessionId: string): Promise<{ text: string; errors: string[] }> {
  const ctx = { sessionId, turnId: "t1", projectPath: "/tmp/test-project" };
  let text = "";
  const errors: string[] = [];
  for await (const event of router.execute(makeDecision(), makeRequest(), ctx)) {
    if (event.type === "text_delta") text += (event as { text: string }).text;
    if (event.type === "error") errors.push((event as { error: { code: string } }).error.code);
  }
  return { text, errors };
}

test("mid-stream: a partial tool-call block is dropped and text continues (R3 recovery)", async () => {
  const tracker = { calls: 0 };
  const store = new SessionRouterStore({ now: () => 1_000 });
  const router = createRouterRuntime(createConfig(), {
    modelRuntime: createPartialToolCallRuntime(tracker),
    tierClassifier: scriptedClassifier(),
    sessionStore: store,
    now: () => new Date(1_000),
  });

  const { text, errors } = await drain(router, "s1");
  assert.equal(tracker.calls, 2, "the stream must be retried once for continuation");
  assert.equal(text, "Let me check the file contents", "text before the tool call must be continued, tool call dropped");
  assert.ok(errors.includes("connection_reset"), "the mid-stream error is surfaced, but recovery follows");
});

test("mid-stream: a failed continuation surfaces the error instead of hanging", async () => {
  const tracker = { calls: 0 };
  const runtime: ModelRuntime = {
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      tracker.calls += 1;
      yield { type: "text_delta", text: "hello" };
      yield { type: "error", error: { provider: "p1", protocol: "openai", code: "connection_reset", message: "reset", retryable: true } as CanonicalModelError };
    },
    async complete() {
      return { role: "assistant", content: [], finishReason: "stop" };
    },
    getCapabilities: () => ({ ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "http://127.0.0.1:1/v1",
  };
  const store = new SessionRouterStore({ now: () => 1_000 });
  const router = createRouterRuntime(createConfig(), {
    modelRuntime: runtime,
    tierClassifier: scriptedClassifier(),
    sessionStore: store,
    now: () => new Date(1_000),
  });

  const ctx = { sessionId: "s2", turnId: "t1", projectPath: "/tmp" };
  let sawError = false;
  for await (const event of router.execute(makeDecision(), makeRequest(), ctx)) {
    if (event.type === "error") sawError = true;
  }
  assert.equal(tracker.calls, 3, "two transient retries then the error surfaces");
  assert.ok(sawError, "exhausted retries must surface the error, not hang");
});
