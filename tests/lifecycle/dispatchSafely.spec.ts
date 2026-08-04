import assert from "node:assert/strict";
import test from "node:test";

import { dispatchLifecycleSafely } from "../../src/lifecycle/dispatchSafely.js";
import type { LifecycleDispatchInput, LifecycleDispatchResult } from "../../src/lifecycle/protocol/payloads.js";

const BASE_INPUT: LifecycleDispatchInput = {
  event: "PreModelRequest",
  baseInput: { sessionId: "s1", transcriptPath: "", cwd: "/tmp" },
  payload: { provider: "p1", model: "m1" },
  matchQuery: "PreModelRequest",
};

const EMPTY_RESULT: LifecycleDispatchResult = {
  effects: [],
  messages: [],
  events: [],
  blockingErrors: [],
  nonBlockingErrors: [],
};

test("dispatchSafely: absent lifecycle returns the empty result", async () => {
  const result = await dispatchLifecycleSafely(undefined, BASE_INPUT);
  assert.deepEqual(result, EMPTY_RESULT);
});

test("dispatchSafely: healthy dispatch passes the result through", async () => {
  const result = await dispatchLifecycleSafely(
    {
      dispatch: async () => ({
        ...EMPTY_RESULT,
        messages: [{ role: "user", content: [{ type: "text", text: "injected" }] }],
      }),
    },
    BASE_INPUT,
  );
  assert.equal(result.messages.length, 1, "hook effects must still flow through");
});

test("dispatchSafely: throwing dispatch degrades to the empty result", async () => {
  const result = await dispatchLifecycleSafely(
    {
      dispatch: async () => {
        throw new Error("hook backend down");
      },
    },
    BASE_INPUT,
  );
  assert.deepEqual(result, EMPTY_RESULT, "a hook crash must behave like a missing hook");
});

test("dispatchSafely: void-returning dispatch (narrow shape) degrades to empty", async () => {
  const result = await dispatchLifecycleSafely(
    {
      dispatch: () => undefined,
    },
    BASE_INPUT,
  );
  assert.deepEqual(result, EMPTY_RESULT);
});
