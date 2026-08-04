import type {
  CanonicalMessage,
  PartialTextToolCallInfo,
} from "../../../model/index.js";
import { messageContent } from "../../../model/index.js";
import { PLAN_MODE_REMINDER_MESSAGE } from "./constants.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textFromMessage(message: CanonicalMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function appendPlanModeReminder(messages: CanonicalMessage[]): CanonicalMessage[] {
  return [
    ...messages,
    {
      role: "user",
      content: [{ type: "text", text: PLAN_MODE_REMINDER_MESSAGE }],
      metadata: { synthetic: true, purpose: "plan_mode_reminder" },
    },
  ];
}

export function buildPartialTextToolCallRecoveryPrompt(
  partial: PartialTextToolCallInfo | undefined,
): string {
  const evidence = partial
    ? `Detected partial text tool-call syntax (${partial.format}/${partial.reason}). Preview: ${partial.preview}`
    : "Detected partial text tool-call syntax.";
  return [
    "The previous response contained partial tool-call XML/text and could not be safely executed.",
    evidence,
    "Resend the complete intended tool call with all required parameters, or continue in visible text if no tool is needed.",
    "Do not repeat dangling XML/tool-call fragments.",
  ].join("\n");
}

/** Keep only the trailing `keepRatio` portion of the message history. */
export function truncateHeadKeepRatio(messages: CanonicalMessage[], keepRatio: number): CanonicalMessage[] {
  const ratio = Math.max(0.05, Math.min(1, keepRatio));
  const keep = Math.max(1, Math.floor(messages.length * ratio));
  return messages.slice(-keep);
}

/**
 * Drop the trailing `[assistant_message_with_partial_tool_call,
 * synthetic_tool_result]` pair the loop just appended on a model error so a
 * retry doesn't replay an unfinished tool call. Safe no-op if the trailing
 * shape doesn't match.
 */
export function stripTrailingErrorPair(messages: CanonicalMessage[]): CanonicalMessage[] {
  const out = [...messages];
  const last = out[out.length - 1];
  if (
    last &&
    last.role === "user" &&
    last.content.every((block) => block.type === "tool_result")
  ) {
    out.pop();
  }
  const newLast = out[out.length - 1];
  if (newLast && newLast.role === "assistant") {
    out.pop();
  }
  return out;
}

/**
 * Strip all image blocks from messages, replacing them with a text placeholder.
 * Used as a recovery strategy when a multimodal processor fails on corrupted images.
 */
export function stripImagesFromMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map((msg) => {
    const newContent = msg.content.map((block) => {
      if (block.type === "image") {
        return { type: "text" as const, text: "[Image removed: multimodal processor error recovery]" };
      }
      if (block.type === "tool_result" && block.content.some((c) => c.type === "image")) {
        return {
          ...block,
          content: block.content.map((c) =>
            c.type === "image"
              ? { type: "text" as const, text: "[Image removed: multimodal processor error recovery]" }
              : c,
          ),
        };
      }
      return block;
    });
    return { ...msg, content: newContent };
  });
}

export function removeTransientPromptsById(
  messages: CanonicalMessage[],
  transientIds: Set<string>,
): CanonicalMessage[] {
  return messages.filter((message) => {
    const transientId = message.metadata?.transientId;
    return !(
      message.role === "user" &&
      message.metadata?.transient === true &&
      typeof transientId === "string" &&
      transientIds.has(transientId)
    );
  });
}

/**
 * Strip tool_call blocks that have no matching tool_result in the following
 * message. They are orphans — e.g. a `max_output_reached` continuation cut
 * the reply off before any tool result arrived, leaving
 * `assistant(tool_calls) + assistant(continuation)` in the persisted
 * conversation. Sending that sequence to OpenAI-style APIs is a hard 400
 * ("messages with 'tool_calls' must be followed by a message with 'tool'"),
 * and replayed forks would see never-executed calls. Executed ids (paired
 * with a tool_result in the immediate next message) are preserved.
 */
export function stripOrphanToolCalls(messages: CanonicalMessage[]): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !hasToolCallBlock(message)) {
      out.push(message);
      continue;
    }
    const next = messages[index + 1];
    const executedIds = new Set<string>();
    if (next?.role === "user") {
      for (const block of next.content) {
        if (block.type === "tool_result") {
          executedIds.add(block.toolCallId);
        }
      }
    }
    const cleanedContent = messageContent(message).filter(
      (block) => block.type !== "tool_call" || executedIds.has(block.id),
    );
    if (cleanedContent.length === messageContent(message).length) {
      out.push(message);
      continue;
    }
    out.push({ ...message, content: cleanedContent });
  }
  return out;
}

export function normalizeMessagesForModelRequest(messages: CanonicalMessage[]): CanonicalMessage[] {
  // First pass: drop orphan tool_calls so the merge and the provider request
  // never see a call without its result.
  const cleaned = stripOrphanToolCalls(messages);
  const out: CanonicalMessage[] = [];
  for (const rawMessage of cleaned) {
    const message: CanonicalMessage = {
      ...rawMessage,
      content: messageContent(rawMessage),
    };
    const last = out[out.length - 1];
    if (
      last?.role === "assistant" &&
      message.role === "assistant" &&
      canMergeAssistantMessages(last, message)
    ) {
      out[out.length - 1] = {
        role: "assistant",
        content: [...messageContent(last), ...messageContent(message)],
        metadata: mergeMessageMetadata(last.metadata, message.metadata),
      };
      continue;
    }
    if (message.role === "assistant" && message.content.length === 0) {
      continue;
    }
    out.push(message);
  }
  return out;
}

export function canMergeAssistantMessages(first: CanonicalMessage, second: CanonicalMessage): boolean {
  return !hasToolCallBlock(first) && !hasToolCallBlock(second);
}

export function hasToolCallBlock(message: CanonicalMessage): boolean {
  return messageContent(message).some((block) => block.type === "tool_call");
}

export function mergeMessageMetadata(
  first: CanonicalMessage["metadata"],
  second: CanonicalMessage["metadata"],
): CanonicalMessage["metadata"] {
  if (!first && !second) {
    return undefined;
  }
  return {
    ...(first ?? {}),
    ...(second ?? {}),
  };
}
