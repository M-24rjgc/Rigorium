import assert from "node:assert/strict";
import test from "node:test";
import { replayTranscriptEntries } from "../../../src/session/transcript/TranscriptReplay.js";
import type { AgentTranscriptEntry } from "../../../src/session/transcript/TranscriptEntry.js";

function entry(partial: Partial<AgentTranscriptEntry> & { type: AgentTranscriptEntry["type"]; turnId: string }): AgentTranscriptEntry {
  return {
    sessionId: "s1",
    sequence: 0,
    createdAt: "2026-08-05T00:00:00.000Z",
    ...partial,
  } as AgentTranscriptEntry;
}

test("replay: a started turn without turn_result emits turn_interrupted with lastMessageAt", () => {
  const entries: AgentTranscriptEntry[] = [
    entry({ type: "turn_started", turnId: "t1" }),
    entry({
      type: "assistant_message",
      turnId: "t1",
      createdAt: "2026-08-05T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
    }),
    entry({
      type: "durable_message",
      turnId: "t1",
      createdAt: "2026-08-05T00:00:02.000Z",
      message: { role: "user", content: [{ type: "tool_result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }] },
    }),
  ];
  const replay = replayTranscriptEntries(entries);
  const interrupted = replay.events.filter((event) => event.type === "turn_interrupted");
  assert.equal(interrupted.length, 1);
  const notice = interrupted[0] as { type: "turn_interrupted"; turnId: string; lastMessageAt: string };
  assert.equal(notice.turnId, "t1");
  assert.equal(notice.lastMessageAt, "2026-08-05T00:00:02.000Z");
  // The durable messages of the interrupted turn are still skipped from the
  // message list (their pairing is unknown), but the user now sees why.
  assert.equal(replay.messages.length, 0);
});

test("replay: legacy transcripts (no turn_started marker) still detect interruptions", () => {
  const entries: AgentTranscriptEntry[] = [
    entry({
      type: "accepted_input",
      turnId: "t9",
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    }),
    entry({
      type: "assistant_message",
      turnId: "t9",
      message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
    }),
  ];
  const replay = replayTranscriptEntries(entries);
  assert.equal(replay.events.filter((event) => event.type === "turn_interrupted").length, 1);
});

test("replay: a crash before any durable message (turn_started only) is still detected", () => {
  const entries: AgentTranscriptEntry[] = [
    entry({ type: "turn_started", turnId: "t-crash" }),
  ];
  const replay = replayTranscriptEntries(entries);
  const notices = replay.events.filter((event) => event.type === "turn_interrupted");
  assert.equal(notices.length, 1);
  assert.equal((notices[0] as { turnId: string }).turnId, "t-crash");
  assert.equal("lastMessageAt" in notices[0]!, false, "no durable message — no timestamp");
});

test("replay: completed turns never produce turn_interrupted", () => {
  const entries: AgentTranscriptEntry[] = [
    entry({ type: "turn_started", turnId: "t-ok" }),
    entry({
      type: "assistant_message",
      turnId: "t-ok",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    }),
    entry({
      type: "turn_result",
      turnId: "t-ok",
      result: {
        type: "success",
        sessionId: "s1",
        turnId: "t-ok",
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: "2026-08-05T00:00:00.000Z",
        completedAt: "2026-08-05T00:00:01.000Z",
      },
    }),
  ];
  const replay = replayTranscriptEntries(entries);
  assert.equal(replay.events.filter((event) => event.type === "turn_interrupted").length, 0);
  assert.equal(replay.events.some((event) => event.type === "turn_completed"), true);
});

test("replay: multiple interrupted turns emit one notice each, sorted", () => {
  const entries: AgentTranscriptEntry[] = [
    entry({ type: "turn_started", turnId: "t-b" }),
    entry({ type: "turn_started", turnId: "t-a" }),
  ];
  const replay = replayTranscriptEntries(entries);
  const turnIds = replay.events
    .filter((event) => event.type === "turn_interrupted")
    .map((event) => (event as { turnId: string }).turnId);
  assert.deepEqual(turnIds, ["t-a", "t-b"]);
});
