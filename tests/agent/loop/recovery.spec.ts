import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalMessage } from "../../../src/model/index.js";
import {
  appendPlanModeReminder,
  normalizeMessagesForModelRequest,
  removeTransientPromptsById,
  stripImagesFromMessages,
  stripTrailingErrorPair,
  truncateHeadKeepRatio,
} from "../../../src/agent/loop/recovery/messages.js";
import {
  annotateRepeatedToolFailures,
  buildInvalidFingerprint,
  detectRepeatedToolFailure,
} from "../../../src/agent/loop/recovery/toolFailures.js";
import {
  clampOutputToModelCap,
  composeAbortSignal,
  mergeUsage,
  tokensFromUsage,
} from "../../../src/agent/loop/recovery/usage.js";
import {
  classifyModelError,
  defaultModelFailureHint,
  isPromptTooLong,
} from "../../../src/agent/loop/recovery/status.js";
import { createStickyGuard } from "../../../src/router/policy/stickyGuard.js";
import type { RigoriumToolResult } from "../../../src/tool/index.js";

function textMessage(role: "user" | "assistant", text: string, metadata?: Record<string, unknown>): CanonicalMessage {
  return { role, content: [{ type: "text", text }], metadata };
}

// ---------------------------------------------------------------------------
// recovery/messages
// ---------------------------------------------------------------------------

test("messages: plan-mode reminder appends a synthetic user message", () => {
  const messages = [textMessage("user", "hi")];
  const out = appendPlanModeReminder(messages);
  assert.equal(out.length, 2);
  assert.equal(out[1]!.role, "user");
  assert.deepEqual(out[1]!.metadata, { synthetic: true, purpose: "plan_mode_reminder" });
  assert.equal(messages.length, 1, "input must not be mutated");
});

test("messages: truncateHeadKeepRatio keeps the trailing ratio", () => {
  const messages = Array.from({ length: 10 }, (_, i) => textMessage("user", `m${i}`));
  assert.equal(truncateHeadKeepRatio(messages, 0.5).length, 5);
  assert.equal(truncateHeadKeepRatio(messages, 0.05).length, 1);
  assert.equal(truncateHeadKeepRatio(messages, 1).length, 10);
  const kept = truncateHeadKeepRatio(messages, 0.3);
  assert.equal(kept[0]!.content[0]!.type === "text" && (kept[0]!.content[0] as { text: string }).text, "m7");
});

test("messages: stripTrailingErrorPair removes the synthetic error pair", () => {
  const messages: CanonicalMessage[] = [
    textMessage("user", "hello"),
    textMessage("assistant", "partial call"),
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "t1", content: [{ type: "text", text: "synthetic" }] }],
    },
  ];
  const out = stripTrailingErrorPair(messages);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.role, "user");
});

test("messages: stripImagesFromMessages replaces image blocks with placeholders", () => {
  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", mimeType: "image/png", bytes: 10, data: "base64" },
      ],
    },
  ] as CanonicalMessage[];
  const out = stripImagesFromMessages(messages);
  const content = out[0]!.content;
  assert.equal(content.length, 2);
  assert.equal(content[1]!.type, "text");
  assert.match((content[1] as { text: string }).text, /Image removed/);
});

test("messages: removeTransientPromptsById filters synthetic prompts", () => {
  const messages = [
    textMessage("user", "real"),
    textMessage("user", "transient", { transient: true, transientId: "abc" }),
    textMessage("user", "transient2", { transient: true, transientId: "def" }),
  ];
  const out = removeTransientPromptsById(messages, new Set(["abc"]));
  assert.equal(out.length, 2);
  assert.equal(out[1]!.metadata?.transientId, "def");
});

test("messages: normalizeMessagesForModelRequest merges adjacent assistant text", () => {
  const messages = [
    textMessage("user", "q"),
    textMessage("assistant", "one"),
    textMessage("assistant", "two"),
    textMessage("user", "next"),
  ];
  const out = normalizeMessagesForModelRequest(messages);
  assert.equal(out.length, 3);
  const assistant = out[1]!;
  assert.equal(assistant.role, "assistant");
  const text = assistant.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("");
  assert.equal(text, "onetwo");
});

test("messages: normalizeMessagesForModelRequest drops empty assistant messages", () => {
  const messages: CanonicalMessage[] = [
    textMessage("user", "q"),
    { role: "assistant", content: [] },
    textMessage("user", "a"),
  ];
  const out = normalizeMessagesForModelRequest(messages);
  assert.equal(out.length, 2);
});

test("messages: orphan tool_calls (no matching tool_result) are stripped before the request", () => {
  // A max_output continuation cut the reply before results arrived: the
  // persisted conversation carries assistant(tool_calls) + assistant(text).
  // OpenAI-style APIs reject that sequence with a 400.
  const messages: CanonicalMessage[] = [
    textMessage("user", "q"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "plan" },
        { type: "tool_call", id: "call-1", name: "read_file", input: { file_path: "a.ts" }, raw: {} },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "continuing…" }] },
    textMessage("user", "next"),
  ];
  const out = normalizeMessagesForModelRequest(messages);
  const assistant = out.find((m) => m.role === "assistant");
  assert.ok(assistant);
  assert.equal(
    assistant.content.some((block) => block.type === "tool_call"),
    false,
    "orphan tool_call must be stripped",
  );
  assert.ok(assistant.content.some((block) => block.type === "text" && block.text === "plan"));
});

test("messages: executed tool_calls (paired with tool_result) are preserved", () => {
  const messages: CanonicalMessage[] = [
    textMessage("user", "q"),
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "call-1", name: "read_file", input: { file_path: "a.ts" }, raw: {} },
        { type: "tool_call", id: "call-2", name: "bash", input: { command: "ls" }, raw: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] },
        // call-2 has no result — it is an orphan even inside a paired message.
      ],
    },
  ];
  const out = normalizeMessagesForModelRequest(messages);
  const assistant = out.find((m) => m.role === "assistant")!;
  const calls = assistant.content.filter((block) => block.type === "tool_call");
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { id: string }).id, "call-1");
});

// ---------------------------------------------------------------------------
// recovery/toolFailures
// ---------------------------------------------------------------------------

function errorResult(toolName: string, code: string, message: string): RigoriumToolResult {
  return {
    toolCallId: `call-${toolName}-${code}`,
    toolName,
    type: "error",
    error: { code, message },
    content: [{ type: "text", text: `failed: ${message}` }],
    metadata: {},
  } as RigoriumToolResult;
}

test("toolFailures: fingerprint only counts invalid_tool_input", () => {
  const results = [
    errorResult("write_file", "invalid_tool_input", "bad path"),
    errorResult("read_file", "file_not_found", "nope"),
  ];
  const fingerprint = buildInvalidFingerprint(results);
  assert.equal(fingerprint, "write_file::bad path");
});

test("toolFailures: repeated fingerprints across turns are detected", () => {
  const results = [errorResult("bash", "server_error", "boom"), errorResult("bash", "server_error", "boom")];
  const first = detectRepeatedToolFailure(results, undefined);
  assert.ok(first.currentFingerprint);
  assert.equal(first.repeatedKeys.size, 1);
  assert.ok(first.repeatedKeys.has("bash::server_error::unknown"));

  // Same fingerprint on the next turn marks every key as repeated.
  const second = detectRepeatedToolFailure(results, first.currentFingerprint);
  assert.equal(second.repeatedKeys.size, 1);
});

test("toolFailures: annotation appends avoid-retry guidance", () => {
  const results = [errorResult("bash", "server_error", "boom")];
  const annotated = annotateRepeatedToolFailures(results, new Set(["bash::server_error::unknown"]));
  assert.equal(annotated.length, 1);
  const first = annotated[0] as Extract<RigoriumToolResult, { type: "error" }>;
  const text = first.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("");
  assert.match(text, /Repeated failure/);
  assert.equal((first.metadata?.recovery as { repeatedFailure?: boolean }).repeatedFailure, true);
});

// ---------------------------------------------------------------------------
// recovery/usage
// ---------------------------------------------------------------------------

test("usage: mergeUsage sums fields, undefined behaves as zero", () => {
  const merged = mergeUsage(
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, totalTokens: 5 },
  );
  assert.deepEqual(merged, {
    inputTokens: 13,
    outputTokens: 7,
    cacheReadTokens: 1,
    cacheWriteTokens: undefined,
    totalTokens: 20,
  });
  const onlyFirst = mergeUsage({ inputTokens: 1, totalTokens: 1 }, undefined);
  assert.equal(onlyFirst.inputTokens, 1);
});

test("usage: tokensFromUsage and clampOutputToModelCap", () => {
  assert.equal(tokensFromUsage({ inputTokens: 100, outputTokens: 50 }), 150);
  assert.equal(tokensFromUsage(undefined), undefined);
  assert.equal(tokensFromUsage({ inputTokens: 0 }), undefined);
  assert.equal(clampOutputToModelCap(10_000, 4_096), 4_096);
  assert.equal(clampOutputToModelCap(2_000, 4_096), 2_000);
  assert.equal(clampOutputToModelCap(2_000, undefined), 2_000);
});

test("usage: composeAbortSignal wires parent abort and timeout", async () => {
  const { signal, cleanup, timedOut } = composeAbortSignal({ timeoutMs: 10 });
  assert.ok(signal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timedOut(), true);
  assert.equal(signal?.aborted, true);
  cleanup();
});

// ---------------------------------------------------------------------------
// recovery/status
// ---------------------------------------------------------------------------

test("status: classifyModelError distinguishes prompt-too-long", () => {
  const compact = classifyModelError({
    provider: "p",
    protocol: "openai",
    code: "prompt_too_long",
    message: "too long",
    retryable: false,
    recoverableViaCompact: true,
  });
  assert.equal(compact.stopReason, "prompt_too_long");
  const other = classifyModelError({
    provider: "p",
    protocol: "openai",
    code: "server_error",
    message: "boom",
    retryable: false,
  });
  assert.equal(other.stopReason, "model_error");
});

test("status: isPromptTooLong matches message patterns", () => {
  assert.equal(isPromptTooLong({ provider: "p", protocol: "openai", code: "unknown", message: "prompt is too long and must be shortened", retryable: false }), true);
  assert.equal(isPromptTooLong({ provider: "p", protocol: "openai", code: "unknown", message: "request too large", retryable: false }), true);
  assert.equal(isPromptTooLong({ provider: "p", protocol: "openai", code: "server_error", message: "boom", retryable: false }), false);
});

test("status: defaultModelFailureHint is action-oriented", () => {
  assert.match(defaultModelFailureHint(undefined) ?? "", /Check/);
  const auth = defaultModelFailureHint({
    provider: "p",
    protocol: "openai",
    code: "auth_error",
    message: "bad key",
    status: 401,
    retryable: false,
  });
  assert.match(auth, /API key/);
});

// ---------------------------------------------------------------------------
// sanity: router sticky guard still shares behavior with loop helpers
// ---------------------------------------------------------------------------

test("cross-module: sticky guard does not conflict with recovery helpers", () => {
  const guard = createStickyGuard({ ttlMs: 1_000 }, () => 1_000);
  const usable = guard({ sessionId: "s", isSubagent: false, orchestrating: false, stickyProvider: "p", stickyModel: "m", updatedAt: 500 });
  assert.equal(usable, true);
});
