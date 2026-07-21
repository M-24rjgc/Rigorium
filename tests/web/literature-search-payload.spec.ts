import assert from "node:assert/strict";
import test from "node:test";
import { flattenCanonicalMessage } from "../../src/web/server/readSessionMessages.js";

test("historical literature_search data is projected into the WebMessage payload", () => {
  const artifact = {
    schemaVersion: 1,
    kind: "literature_search",
    artifactId: "literature-test",
    papers: [],
    edges: [],
    sources: [],
  };
  const messages = flattenCanonicalMessage({
    role: "user",
    content: [{
      type: "tool_result",
      toolCallId: "call-literature",
      content: [{ type: "text", text: "done" }],
      raw: { toolName: "literature_search", data: artifact },
    }],
  } as any, {
    index: 0,
    sessionKey: "session",
    now: () => new Date("2026-07-22T00:00:00.000Z"),
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.payload, artifact);
});
