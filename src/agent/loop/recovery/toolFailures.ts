import type {
  RigoriumToolErrorResult,
  RigoriumToolResult,
} from "../../../tool/index.js";
import type { AgentPermissionDenial } from "../../protocol/result.js";
import type { CanonicalMessage } from "../../../model/index.js";
import type { ContextSupplementalToolResultMessage } from "../../../context/index.js";
import { isRecord } from "./messages.js";

/**
 * Repeated-failure detection and annotation for tool results.
 *
 * The loop fingerprints failed tool calls (tool name + error code + recovery
 * class). When the same fingerprint repeats across consecutive turns, results
 * are annotated with an "avoid retry" hint so the model changes its approach
 * instead of hammering the same failing call.
 */

export function collectPermissionDenials(results: RigoriumToolResult[]): AgentPermissionDenial[] {
  return results.flatMap((result) => {
    if (
      result.type === "error" &&
      (result.error.code === "permission_denied" ||
        result.error.code === "permission_required" ||
        result.error.code === "permission_cancelled")
    ) {
      return [
        {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          errorCode: result.error.code,
        },
      ];
    }
    return [];
  });
}

/**
 * Bind each tool result's `supplementalMessages` to the corresponding
 * `toolCallId` in the order they appear, so context runtimes can attach
 * synthetic messages (e.g. permission prompts) to the right tool call.
 */
export function bindSupplementalMessagesToToolCalls(
  results: RigoriumToolResult[],
  supplementalMessages: CanonicalMessage[],
): ContextSupplementalToolResultMessage[] {
  const bound: ContextSupplementalToolResultMessage[] = [];
  let index = 0;
  for (const result of results) {
    const count = result.supplementalMessages?.length ?? 0;
    for (let offset = 0; offset < count && index < supplementalMessages.length; offset += 1) {
      bound.push({ toolCallId: result.toolCallId, message: supplementalMessages[index] });
      index += 1;
    }
  }
  return bound;
}

export function buildInvalidFingerprint(results: RigoriumToolResult[]): string {
  return results
    .filter(
      (result): result is RigoriumToolErrorResult =>
        result.type === "error" && result.error.code === "invalid_tool_input",
    )
    .map((result) => `${result.toolName}::${result.error.message}`)
    .sort()
    .join("\n");
}

export function detectRepeatedToolFailure(
  results: RigoriumToolResult[],
  lastFingerprint: string | undefined,
): {
  currentFingerprint?: string;
  repeatedKeys: Set<string>;
} {
  const keys = buildToolFailureKeys(results);
  const fingerprint = keys.length > 0 ? keys.join("\n") : undefined;
  const repeatedKeys = findRepeatedValues(keys);
  if (fingerprint && fingerprint === lastFingerprint) {
    for (const key of keys) {
      repeatedKeys.add(key);
    }
  }
  if (!fingerprint) {
    return { repeatedKeys };
  }
  return {
    currentFingerprint: fingerprint,
    repeatedKeys,
  };
}

export function buildToolFailureKeys(results: RigoriumToolResult[]): string[] {
  return results
    .filter((result): result is RigoriumToolErrorResult => result.type === "error")
    .map((result) => {
      const recovery = readRecoveryMetadata(result);
      return toolFailureKey(result, recovery);
    })
    .sort();
}

export function annotateRepeatedToolFailures(
  results: RigoriumToolResult[],
  repeatedKeys: Set<string>,
): RigoriumToolResult[] {
  if (repeatedKeys.size === 0) {
    return results;
  }

  return results.map((result) => {
    if (result.type !== "error") {
      return result;
    }
    const recovery = readRecoveryMetadata(result);
    if (!repeatedKeys.has(toolFailureKey(result, recovery))) {
      return result;
    }
    const avoidRetryReason = typeof recovery?.avoidRetryReason === "string"
      ? recovery.avoidRetryReason
      : "The same tool, error code, and recovery class repeated. Retrying unchanged is likely to fail again.";
    const repeatedText =
      `\n\nRepeated failure: ${avoidRetryReason}\n` +
      "Change at least one of the tool, parameters, path, scope, permission path, or explain the blocker in text.";
    return {
      ...result,
      content: appendTextToFirstContent(result.content, repeatedText),
      metadata: {
        ...(result.metadata ?? {}),
        recovery: recovery
          ? {
              ...recovery,
              avoidRetryReason,
              repeatedFailure: true,
            }
          : {
              avoidRetryReason,
              repeatedFailure: true,
            },
      },
    };
  });
}

export function toolFailureKey(
  result: RigoriumToolErrorResult,
  recovery: Record<string, unknown> | undefined,
): string {
  return `${result.toolName}::${result.error.code}::${recovery?.failureClass ?? "unknown"}`;
}

export function findRepeatedValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      repeated.add(value);
    } else {
      seen.add(value);
    }
  }
  return repeated;
}

export function appendTextToFirstContent(
  content: RigoriumToolErrorResult["content"],
  suffix: string,
): RigoriumToolErrorResult["content"] {
  const [first, ...rest] = content;
  if (!first) {
    return [{ type: "text", text: suffix.trimStart() }];
  }
  if (first.type !== "text") {
    return [{ type: "text", text: suffix.trimStart() }, first, ...rest];
  }
  return [{ ...first, text: `${first.text}${suffix}` }, ...rest];
}

export function readRecoveryMetadata(result: RigoriumToolErrorResult): Record<string, unknown> | undefined {
  const recovery = result.metadata?.recovery;
  return isRecord(recovery) ? recovery : undefined;
}
