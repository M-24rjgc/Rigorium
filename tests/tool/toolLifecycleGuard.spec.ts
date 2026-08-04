import assert from "node:assert/strict";
import test from "node:test";

import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { LifecycleRuntime } from "../../src/lifecycle/runtime/LifecycleRuntime.js";
import { HookRuntime } from "../../src/extension/hooks/execution/HookRuntime.js";
import { PermissionRuntime } from "../../src/permission/index.js";
import {
  ToolRegistry,
  type RigoriumToolDefinition,
} from "../../src/tool/index.js";
import type { LifecycleDispatchInput } from "../../src/lifecycle/protocol/payloads.js";

function createTool(name = "echo"): RigoriumToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input) => ({
      content: [{ type: "text", text: `ran:${(input as { text?: string }).text ?? ""}` }],
      data: {},
    }),
  };
}

function failingLifecycle(): LifecycleRuntime {
  const lifecycle = new LifecycleRuntime(new HookRuntime({})) as LifecycleRuntime & {
    dispatch: (input: LifecycleDispatchInput) => Promise<never>;
  };
  lifecycle.dispatch = async () => {
    throw new Error("hook backend down");
  };
  return lifecycle;
}

function makeContext() {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions" as const,
    permissionContext: {
      mode: "bypassPermissions" as const,
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    env: {},
    now: () => new Date("2026-08-05T00:00:00.000Z"),
  };
}

test("tool lifecycle: failing PreToolUse hook cannot break the tool call", async () => {
  const registry = new ToolRegistry();
  registry.register(createTool());
  const runtime = new ToolRuntime(registry, new PermissionRuntime(), failingLifecycle());

  const result = await runtime.execute(
    { id: "call-1", name: "echo", input: { text: "hello" } },
    makeContext(),
  );
  assert.equal(result.type, "success", "hook failure must degrade to allow, not deny");
  const text = result.content.find((part) => part.type === "text");
  assert.equal((text as { text: string }).text, "ran:hello");
});

test("tool lifecycle: failing PostToolUse hook cannot break tool-result delivery", async () => {
  const registry = new ToolRegistry();
  registry.register(createTool());
  const runtime = new ToolRuntime(registry, new PermissionRuntime(), failingLifecycle());

  const result = await runtime.execute(
    { id: "call-1", name: "echo", input: { text: "hello" } },
    makeContext(),
  );
  assert.equal(result.type, "success");
  // PostToolUse runs inside the same execute path — reaching here proves the
  // failure was swallowed (empty result), not thrown.
  assert.ok(result.content.length >= 1);
});
