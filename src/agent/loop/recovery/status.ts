import type { CanonicalModelError } from "../../../model/index.js";
import {
  PROMPT_TOO_LONG_ANTHROPIC_PATTERN,
  PROMPT_TOO_LONG_OPENAI_PATTERN,
  REQUEST_TOO_LARGE_PATTERN,
} from "../../../model/index.js";
import { agentError } from "../../protocol/errors.js";
import type { AgentTurnResult } from "../../protocol/result.js";
import {
  createAgentStatusDetail,
  createVisibleErrorStatusDetail,
  type AgentStatusI18nDescriptor,
} from "../../../status/agentStatus.js";

export type AgentStatusMessage = {
  event: string;
  kind: "status" | "error";
  text: string;
  detail?: Record<string, unknown>;
};

export function classifyModelError(error: CanonicalModelError): {
  stopReason: AgentTurnResult["stopReason"];
  error: ReturnType<typeof agentError>;
} {
  if (isPromptTooLong(error)) {
    return {
      stopReason: "prompt_too_long",
      error: agentError(
        "agent_prompt_too_long",
        error.message,
        error,
        error.userHint ?? "Input exceeds the model context window. Try /compact to compress history or /new for a fresh session.",
      ),
    };
  }
  return {
    stopReason: "model_error",
    error: agentError("agent_model_error", error.message, error, error.userHint),
  };
}

export function createModelRequestFailedStatus(args: {
  error: ReturnType<typeof agentError>;
  modelError?: CanonicalModelError;
}): AgentStatusMessage {
  const providerMessage = args.error.message || args.modelError?.message || "The model request failed, so this turn has stopped.";
  const text = formatModelRequestFailureMessage(providerMessage, args.modelError);
  const action = modelFailureAction(args.modelError);
  return {
    event: "model_request_failed",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: {
        key: "chat:agentStatus.modelRequestFailed.message",
        params: { providerMessage },
      },
      code: args.error.code,
      userHint: action.userHint,
      userHintI18n: action.userHintI18n,
      detail: {
        provider: args.modelError?.provider,
        protocol: args.modelError?.protocol,
        status: args.modelError?.status,
        modelErrorCode: args.modelError?.code,
        retryable: args.modelError?.retryable,
        providerMessage,
        settingsFix: args.modelError?.settingsFix,
        fixTarget: action.fixTarget,
      },
    }),
  };
}

export function formatModelRequestFailureMessage(providerMessage: string, error: CanonicalModelError | undefined): string {
  const cleanMessage = providerMessage.trim() || "The model request failed.";
  const action = modelFailureAction(error);
  return `${cleanMessage}\n\n${action.shortAction}`;
}

export function modelFailureAction(error: CanonicalModelError | undefined): {
  shortAction: string;
  userHint: string;
  userHintI18n: AgentStatusI18nDescriptor;
  fixTarget: "settings" | "provider" | "network" | "prompt" | "retry";
} {
  if (!error) {
    const hint = "Check Settings → Model Provider and verify the selected provider, base URL, API key, model name, and timeoutMs. If the provider is slow or the network is unstable, increase timeoutMs or check provider status.";
    return modelFailureActionResult(hint, "settings", "settingsDefault");
  }

  const providerLabel = error.provider ? ` provider "${error.provider}"` : " provider";
  const modelLabel = error.model ? ` model "${error.model}"` : " selected model";

  if (error.status === 401 || error.status === 403 || error.code === "auth_error") {
    const hint = `Update the API key or access permissions for${providerLabel} in Settings → Model Provider, or run rigorium setup.`;
    return modelFailureActionResult(hint, "settings", "auth", { provider: error.provider ?? "the provider" });
  }
  if (error.code === "model_not_found") {
    const hint = `Choose a valid${modelLabel} for${providerLabel} in Settings → Model Provider, or add it under model.providers.<id>.models in rigorium.yaml.`;
    return modelFailureActionResult(hint, "settings", "modelNotFound", { provider: error.provider ?? "the provider", model: error.model });
  }
  if (error.code === "timeout") {
    const hint = `Increase timeoutMs for${providerLabel} in Settings → Model Provider → Advanced, or check local network/proxy and provider status.`;
    return modelFailureActionResult(hint, "network", "timeout", { provider: error.provider ?? "the provider" });
  }
  if (error.status === 429 || error.code === "rate_limit_error") {
    const hint = `Wait for the provider rate limit to reset, reduce concurrency, or switch to another provider/model in Settings.`;
    return modelFailureActionResult(hint, "provider", "rateLimit");
  }
  if (error.code === "billing") {
    const hint = `Top up billing/quota on the provider API side, or switch to another provider/model in Settings.`;
    return modelFailureActionResult(hint, "provider", "billing");
  }
  if (error.code === "prompt_too_long" || error.code === "context_overflow") {
    const hint = "Run /compact, start a new session, remove large attachments, or switch to a larger-context model in Settings.";
    return modelFailureActionResult(hint, "prompt", "contextOverflow");
  }
  if (error.code === "payload_too_large" || error.code === "request_too_large") {
    const hint = "Reduce attachments/context size, run /compact, or start a new session before retrying.";
    return modelFailureActionResult(hint, "prompt", "payloadTooLarge");
  }
  if (error.code === "max_output_reached") {
    const hint = "Increase max output tokens in Settings → Model Provider, or ask the agent to split the answer into smaller parts.";
    return modelFailureActionResult(hint, "settings", "maxOutput");
  }
  if (error.code === "image_too_large") {
    const hint = "Resize or remove large images, then retry.";
    return modelFailureActionResult(hint, "prompt", "imageTooLarge");
  }
  if (error.retryable || error.code === "server_error" || error.code === "overloaded_error") {
    const hint = `Retry later, check provider API status, or switch to another provider/model in Settings if it repeats.`;
    return modelFailureActionResult(hint, "provider", "providerRetry");
  }

  const hint = `Check Settings → Model Provider for base URL/API key/model and timeoutMs. If settings look correct, check local network/proxy and provider API status/logs.`;
  return modelFailureActionResult(hint, "settings", "settingsDefault");
}

function modelFailureActionResult(
  hint: string,
  fixTarget: "settings" | "provider" | "network" | "prompt" | "retry",
  key: string,
  params: Record<string, unknown> = {},
): {
  shortAction: string;
  userHint: string;
  userHintI18n: AgentStatusI18nDescriptor;
  fixTarget: "settings" | "provider" | "network" | "prompt" | "retry";
} {
  return {
    shortAction: `Action: ${hint}`,
    userHint: hint,
    userHintI18n: { key: `chat:agentStatus.modelRequestFailed.actions.${key}`, params },
    fixTarget,
  };
}

export function createToolCallRecoveryExhaustedStatus(args: {
  error: ReturnType<typeof agentError>;
  attempts?: number;
  reason?: string;
}): AgentStatusMessage {
  const text = args.error.message || "Tool-call recovery was exhausted, so this turn has stopped.";
  return {
    event: "tool_call_recovery_exhausted",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.toolCallRecoveryExhausted.message", params: { message: text } },
      code: args.error.code,
      userHint: args.error.userHint ?? "Retry with a shorter prompt, ask the agent to split large tool inputs into smaller steps, or switch to a model with stronger tool-calling support in Settings → Model Provider.",
      userHintI18n: { key: "chat:agentStatus.toolCallRecoveryExhausted.hint" },
      detail: {
        attempts: args.attempts,
        reason: args.reason,
      },
    }),
  };
}

export function createToolErrorLoopStatus(args: {
  error: ReturnType<typeof agentError>;
  repeatedFailures?: number;
}): AgentStatusMessage {
  const text = args.error.message || "The agent repeatedly hit the same tool error, so this turn has stopped.";
  return {
    event: "tool_error_loop",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      code: args.error.code,
      userHint: args.error.userHint ?? "Change the request to avoid repeating the same failing tool call, grant any required permission, or switch to a model with stronger tool-calling support in Settings → Model Provider.",
      detail: {
        repeatedFailures: args.repeatedFailures,
      },
    }),
  };
}

export function createLifecycleBlockedStatus(args: {
  error: ReturnType<typeof agentError>;
  stage: string;
}): AgentStatusMessage {
  const text = args.error.message || "A lifecycle hook blocked this turn.";
  return {
    event: "lifecycle_blocked",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      code: args.error.code,
      userHint: args.error.userHint ?? "Review the blocking lifecycle hook output or disable the hook, then retry.",
      detail: {
        stage: args.stage,
      },
    }),
  };
}

export function defaultModelFailureHint(error: CanonicalModelError | undefined): string {
  if (!error) {
    return "Check the model provider settings and retry.";
  }
  if (error.retryable) {
    return "The provider marked this error as retryable. Retry the turn; if it repeats, check provider status and rate limits.";
  }
  if (error.status === 401 || error.status === 403 || error.code === "auth_error") {
    return "Check the provider API key and model access settings.";
  }
  if (error.status === 429 || error.code === "rate_limit_error") {
    return "Wait for the rate limit to reset or switch to another provider/model.";
  }
  if (error.code === "billing") {
    return "Check the provider billing or quota settings.";
  }
  return "Check the provider/model settings and retry.";
}

export function createEmptyResponseStatus(args: {
  provider?: string;
  model?: string;
  attempts: number;
}): AgentStatusMessage {
  const text = "The model returned empty content repeatedly, so this turn has stopped. Try again later or increase max output tokens.";
  return {
    event: "model_empty_response_exhausted",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.emptyResponse.message" },
      code: "model_empty_response_exhausted",
      userHint: "Increase max output tokens in Settings → Model Provider, retry with a shorter prompt, or check whether this provider/model supports the requested output format.",
      userHintI18n: { key: "chat:agentStatus.emptyResponse.hint" },
      detail: {
        provider: args.provider,
        model: args.model,
        attempts: args.attempts,
      },
    }),
  };
}

export function createMaxTurnsStatus(args: {
  maxTurns: number;
  error: ReturnType<typeof agentError>;
}): AgentStatusMessage {
  const text = `Reached the maximum number of turns (${args.maxTurns}), so this turn has stopped. Increase maxTurns or split the task into smaller steps and try again.`;
  return {
    event: "max_turns_reached",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.maxTurns.message", params: { maxTurns: args.maxTurns } },
      code: args.error.code,
      userHint: args.error.userHint ?? "Increase maxTurns in local config if this task legitimately needs more agent steps, or split the task into smaller prompts and try again.",
      userHintI18n: { key: "chat:agentStatus.maxTurns.hint" },
      detail: {
        maxTurns: args.maxTurns,
      },
    }),
  };
}

export function createMaxOutputRecoveryExhaustedStatus(args: {
  attempts: number;
}): AgentStatusMessage {
  const text = "Output token recovery was exhausted, so the visible response may be incomplete. Increase max output tokens or split the task into smaller steps and try again.";
  return {
    event: "max_output_recovery_exhausted",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.maxOutputRecoveryExhausted.message" },
      severity: "warning",
      code: "max_output_recovery_exhausted",
      userHint: "Increase max output tokens in Settings → Model Provider, or ask the agent to split the answer into smaller parts.",
      userHintI18n: { key: "chat:agentStatus.maxOutputRecoveryExhausted.hint" },
      detail: {
        attempts: args.attempts,
      },
    }),
  };
}

export function createStructuredOutputCompletedStatus(): AgentStatusMessage {
  const text = "Structured output was returned, so this turn has completed.";
  return {
    event: "structured_output_completed",
    kind: "status",
    text,
    detail: createAgentTurnStatusDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.structuredOutputCompleted.message" },
      code: "structured_output_completed",
    }),
  };
}

export function createContentFilterStopStatus(): AgentStatusMessage {
  const text = "The response may be incomplete because the model stopped due to content filtering.";
  return {
    event: "content_filter_stop",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.contentFilter.message" },
      severity: "warning",
      code: "content_filter_stop",
      userHint: "Retry with a narrower request or adjust the prompt to avoid filtered content; if this seems wrong, check the provider API policy/status for the selected model.",
      userHintI18n: { key: "chat:agentStatus.contentFilter.hint" },
    }),
  };
}

export function createUnknownFinishReasonStatus(): AgentStatusMessage {
  const text = "The model stream ended without a normal finish reason, so the response may be incomplete.";
  return {
    event: "unknown_finish_reason",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.unknownFinishReason.message" },
      severity: "warning",
      code: "unknown_finish_reason",
      userHint: "Retry the turn; if it repeats, check provider API status/logs for stream finish reasons and verify the selected provider/model in Settings → Model Provider.",
      userHintI18n: { key: "chat:agentStatus.unknownFinishReason.hint" },
    }),
  };
}

export function createTurnAbortedStatus(args: { reason?: string }): AgentStatusMessage {
  const text = "This turn was aborted before completion.";
  return {
    event: "turn_aborted",
    kind: "status",
    text,
    detail: createAgentTurnStatusDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.turnAborted.message" },
      code: "turn_aborted",
      userHint: "Retry when you are ready to continue. If this was unexpected, check whether you clicked Stop, switched sessions during a run, or lost the gateway connection.",
      userHintI18n: { key: "chat:agentStatus.turnAborted.hint" },
      detail: {
        reason: args.reason,
      },
    }),
  };
}

export function createFinishReasonStatus(finishReason: string | undefined, assistantText: string): AgentStatusMessage | undefined {
  if (assistantText.trim().length === 0) return undefined;
  if (finishReason === "content_filter") return createContentFilterStopStatus();
  if (finishReason === "unknown") return createUnknownFinishReasonStatus();
  return undefined;
}

function createAgentTurnErrorDetail(input: {
  message: string;
  messageI18n?: AgentStatusI18nDescriptor;
  code: string;
  userHint: string;
  userHintI18n?: AgentStatusI18nDescriptor;
  severity?: "error" | "warning";
  detail?: Record<string, unknown>;
}): Record<string, unknown> {
  return createVisibleErrorStatusDetail({
    ...input,
    scope: "turn",
    source: "agent",
  });
}

function createAgentTurnStatusDetail(input: {
  message: string;
  messageI18n?: AgentStatusI18nDescriptor;
  code: string;
  userHint?: string;
  userHintI18n?: AgentStatusI18nDescriptor;
  detail?: Record<string, unknown>;
}): Record<string, unknown> {
  return createAgentStatusDetail({
    ...input,
    visible: true,
    scope: "turn",
    source: "agent",
  });
}

export function shouldSurfaceAbortStatus(reason: unknown): boolean {
  if (reason === undefined || reason === null) return false;
  const text = (stringifyAbortReason(reason) ?? "").toLowerCase();
  return text.includes("timeout") || text.includes("cancel") || text.includes("abort");
}

export function stringifyAbortReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined;
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

export function isPromptTooLong(error: CanonicalModelError): boolean {
  if (error.code === "prompt_too_long" || error.recoverableViaCompact) {
    return true;
  }
  if (PROMPT_TOO_LONG_ANTHROPIC_PATTERN.test(error.message)) {
    return true;
  }
  if (PROMPT_TOO_LONG_OPENAI_PATTERN.test(error.message)) {
    return true;
  }
  if (REQUEST_TOO_LARGE_PATTERN.test(error.message)) {
    return true;
  }
  return false;
}
