import type { CanonicalMessage, CanonicalToolCall } from "../../model/index.js";

/**
 * Collect tool-call blocks from an assistant message, deduplicating by id.
 *
 * Some local models repeat the same toolCallId within one reply. Executing a
 * duplicate is dangerous for side-effecting tools (write_file, apply_patch,
 * bash) — the first call wins and later duplicates are dropped.
 */
export function collectToolCalls(message: CanonicalMessage): CanonicalToolCall[] {
  const seen = new Set<string>();
  const calls: CanonicalToolCall[] = [];
  for (const block of message.content) {
    if (block.type !== "tool_call") {
      continue;
    }
    if (seen.has(block.id)) {
      continue;
    }
    seen.add(block.id);
    calls.push({
      id: block.id,
      name: block.name,
      input: block.input,
      raw: block.raw,
    });
  }
  return calls;
}

/** Count duplicate tool-call ids in a message (for diagnostics/telemetry). */
export function countDuplicateToolCalls(message: CanonicalMessage): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const block of message.content) {
    if (block.type !== "tool_call") {
      continue;
    }
    if (seen.has(block.id)) {
      duplicates += 1;
      continue;
    }
    seen.add(block.id);
  }
  return duplicates;
}
