import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import { LifecycleRuntime } from "../../../src/lifecycle/runtime/LifecycleRuntime.js";
import { HookRuntime } from "../../../src/extension/hooks/execution/HookRuntime.js";
import type { LifecycleDispatchInput, LifecycleDispatchResult } from "../../../src/lifecycle/protocol/payloads.js";
import type { AgentRuntimeDependencies, AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { AgentContextRuntime } from "../../../src/context/ContextRuntime.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

/**
 * PreCompact/PostCompact dispatch coverage. The loop calls the lifecycle
 * dispatcher around compaction attempts; a capturing dispatcher records the
 * event order and payloads without running any real hooks.
 */
class CapturingLifecycle extends LifecycleRuntime {
  readonly calls: Array<{ event: string; payload: Record<string, unknown> }> = [];
  constructor() {
    super(new HookRuntime({}));
  }
  override async dispatch(input: LifecycleDispatchInput): Promise<LifecycleDispatchResult> {
    this.calls.push({ event: input.event, payload: input.payload ?? {} });
    return { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] };
  }
}

function textMessage(role: "user" | "assistant", text: string): CanonicalMessage {
  return { role, content: [{ type: "text", text }] };
}

function createRouter(): AgentRouterRuntime {
  return {
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default" as const,
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "fallback" as const,
      mutations: {},
    }),
    execute: async function* () {
      yield { type: "text_delta", text: "answer" };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } };
    },
    stream: async function* () {
      yield { type: "text_delta", text: "answer" };
    },
  } as AgentRouterRuntime;
}

/** Context stub whose tryAutoCompact always compacts (tier: "snip"). */
function createCompactingContext(): AgentContextRuntime {
  return {
    prepareForModel: async (input) => ({ messages: input.messages }),
    tryAutoCompact: async ({ messages }) => ({
      type: "compacted",
      tier: "snip",
      messages: [...messages.slice(0, 1), textMessage("assistant", "compacted summary")],
      snapshot: {
        tokens: 10,
        maxContextTokens: 128_000,
        warningRatio: 0,
        blockingRatio: 0,
        state: "ok",
        ratio: 0.5,
      },
    }),
  } as AgentContextRuntime;
}

function createDependencies(context: AgentContextRuntime, lifecycle: CapturingLifecycle): AgentRuntimeDependencies {
  const registry = new ToolRegistry();
  return {
    router: createRouter(),
    tools: {
      registry,
      scheduler: {
        executeAll: async () => [],
      },
    },
    context,
    lifecycle,
    getModelMaxContextTokens: () => undefined,
    now: () => new Date("2026-08-05T00:00:00.000Z"),
    uuid: () => "u1",
  } as unknown as AgentRuntimeDependencies;
}

async function runTurn(loop: AgentLoop): Promise<void> {
  for await (const _event of loop.run({
    sessionId: "s1",
    turnId: "t1",
    messages: [textMessage("user", "do it")],
    permissionMode: "bypassPermissions",
    abortSignal: new AbortController().signal,
  })) {
    // drain
  }
}

test("compact hooks: PreCompact before and PostCompact after a compaction tier", async () => {
  const lifecycle = new CapturingLifecycle();
  const loop = new AgentLoop(
    {
      provider: "p1",
      model: "m1",
      cwd: "/tmp",
      permissionMode: "bypassPermissions",
      permissionContext: {} as never,
    },
    createDependencies(createCompactingContext(), lifecycle),
  );
  await runTurn(loop);

  const events = lifecycle.calls.map((call) => call.event);
  const preIndex = events.indexOf("PreCompact");
  const postIndex = events.indexOf("PostCompact");
  assert.ok(preIndex >= 0, "PreCompact must be dispatched before a compaction attempt");
  assert.ok(postIndex >= 0, "PostCompact must be dispatched when a tier rewrote the conversation");
  assert.ok(preIndex < postIndex, "PreCompact must precede PostCompact");

  const pre = lifecycle.calls[preIndex]!;
  assert.equal(pre.payload.reason, "auto_compact");
  assert.equal(pre.payload.trigger, "budget_threshold");
  assert.equal(pre.payload.messageCountBefore, 1);
  const post = lifecycle.calls[postIndex]!;
  assert.equal(post.payload.reason, "auto_compact");
  assert.equal(post.payload.tier, "snip");
  assert.equal(post.payload.messageCountAfter, 2);
});

test("compact hooks: a skipped compaction dispatches PreCompact only", async () => {
  const lifecycle = new CapturingLifecycle();
  const context: AgentContextRuntime = {
    prepareForModel: async (input) => ({ messages: input.messages }),
    tryAutoCompact: async ({ messages }) => ({
      type: "skipped",
      snapshot: {
        tokens: 10,
        maxContextTokens: 128_000,
        warningRatio: 0,
        blockingRatio: 0,
        state: "ok",
        ratio: 0.01,
      },
    }),
  } as AgentContextRuntime;
  const loop = new AgentLoop(
    {
      provider: "p1",
      model: "m1",
      cwd: "/tmp",
      permissionMode: "bypassPermissions",
      permissionContext: {} as never,
    },
    createDependencies(context, lifecycle),
  );
  await runTurn(loop);

  const events = lifecycle.calls.map((call) => call.event);
  assert.ok(events.includes("PreCompact"), "PreCompact fires per compaction attempt");
  assert.ok(!events.includes("PostCompact"), "PostCompact must not fire when nothing was rewritten");
});

test("compact hooks: failing hook dispatch never breaks the turn (central guard)", async () => {
  const failing = new LifecycleRuntime(new HookRuntime({})) as CapturingLifecycle;
  // Fail on EVERY lifecycle event — the loop boundary must swallow all of
  // them (Stop/StopFailure/SubagentStart/PreCompact/...), not just compact.
  failing.dispatch = async () => {
    throw new Error("hook backend down");
  };
  const loop = new AgentLoop(
    {
      provider: "p1",
      model: "m1",
      cwd: "/tmp",
      permissionMode: "bypassPermissions",
      permissionContext: {} as never,
    },
    createDependencies(createCompactingContext(), failing as unknown as CapturingLifecycle),
  );
  await runTurn(loop); // must not throw
  assert.ok(true, "a failing lifecycle dispatch is fire-and-forget at the loop boundary");
});
