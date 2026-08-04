import type {
  CanonicalModelError,
  ModelProtocol,
} from "../../model/index.js";
import type { ModelRuntime } from "../../model/index.js";
import { ModelRequestError } from "../../model/index.js";
import { exponentialBackoffDelay } from "../../model/streaming/backoff.js";
import type { RouterModelRef } from "../config/schema.js";

/**
 * Build a canonical model error for a provider that cannot accept the
 * request's required input modalities.
 */
export function createUnsupportedMediaError(
  attempt: RouterModelRef,
  required: readonly string[],
  missing: readonly string[],
  protocol: ModelProtocol,
): CanonicalModelError {
  const missingText = (missing.length > 0 ? missing : required).join(", ");
  const requiredText = required.join(", ");
  return {
    provider: attempt.provider,
    protocol,
    code: "unsupported_modality",
    message:
      `Router could not find a configured fallback model for ${attempt.provider}/${attempt.model} ` +
      `that supports required input modalities: ${requiredText}. Missing: ${missingText}.`,
    retryable: false,
  };
}

/**
 * Recovery metadata for local request-validation errors (ModelRequestError).
 * These are not HTTP-retryable (resending the identical request fails the
 * same way), but they carry semantics the router must not lose: an
 * `image_too_large` / `too_many_images` request can be retried after the
 * media downgrade path strips images, and `provider_not_found` should fall
 * back to another provider instead of terminating the attempt chain.
 */
const MODEL_REQUEST_ERROR_META: Readonly<Record<string, { recoverableViaImageStrip?: boolean }>> = {
  image_too_large: { recoverableViaImageStrip: true },
  too_many_images: { recoverableViaImageStrip: true },
  pdf_too_large: {},
  audio_too_long: {},
  unsupported_modality: {},
  unsupported_streaming: {},
  unsupported_tool_use: {},
  unsupported_thinking: {},
  provider_not_found: {},
};

export function canonicalizeModelRequestError(
  error: unknown,
  request: { provider: string },
  protocol: ModelProtocol,
): CanonicalModelError | undefined {
  if (!(error instanceof ModelRequestError)) {
    return undefined;
  }

  const meta = MODEL_REQUEST_ERROR_META[error.code];
  return {
    provider: request.provider,
    protocol,
    code: error.code,
    message: error.message,
    retryable: false,
    ...(meta?.recoverableViaImageStrip ? { recoverableViaImageStrip: true } : {}),
    raw: error.details,
  };
}

export function protocolForProvider(modelRuntime: ModelRuntime, providerId: string): ModelProtocol {
  try {
    return modelRuntime.getProviderProtocol(providerId) ?? "openai";
  } catch {
    return "openai";
  }
}

export function isNetworkTransient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("epipe") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("dns") ||
    msg.includes("fetch failed") ||
    msg.includes("abort") ||
    error.name === "TimeoutError" ||
    error.name === "AbortError"
  );
}

export function classifyNetworkErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const msg = error.message.toLowerCase();
  if (msg.includes("timeout") || error.name === "TimeoutError") return "timeout";
  if (msg.includes("abort") || error.name === "AbortError") return "aborted";
  return "network_error";
}

export function isMidStreamRateLimitError(error: CanonicalModelError): boolean {
  return error.code === "rate_limit_error" || error.code === "overloaded_error";
}

export function classifyRetryReason(
  errorCode: string,
): "rate_limit" | "server_error" | "network_error" | "zero_usage" | "overloaded" {
  if (errorCode === "rate_limit_error") return "rate_limit";
  if (errorCode === "overloaded_error") return "overloaded";
  if (errorCode === "server_error") return "server_error";
  if (errorCode === "network_error" || errorCode === "timeout") return "network_error";
  return "server_error";
}

/**
 * Deterministic exponential backoff with full jitter, capped at `maxDelayMs`
 * (see src/model/streaming/backoff.ts — single shared implementation).
 */
export function calculateLiteLLMRetryDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  return exponentialBackoffDelay(attempt, baseDelayMs, maxDelayMs);
}

/** True when the buffered stream already emitted a tool-call block. */
export function bufferedHasToolCall(buffered: readonly { type: string }[]): boolean {
  return buffered.some((event) => event.type === "tool_call");
}

/**
 * Error codes that indicate the *provider itself* is at fault (connectivity,
 * server-side failure, overload). These are the only codes that count toward
 * sticky quality-failure release — switching providers can fix them. Account-
 * level codes (rate limit, auth, billing) or request-shape codes (context
 * overflow, invalid request) would fail identically on any provider, so
 * counting them would evict a sticky for no benefit (Claude Code's
 * fallbackModel whitelist/blacklist semantics).
 */
const PROVIDER_FAULT_CODES = new Set([
  "timeout",
  "server_error",
  "overloaded_error",
  "connection_reset",
  "connection_refused",
  "dns_error",
  "tls_error",
  "proxy_error",
  "unknown",
]);

export function isProviderFaultCode(code: string): boolean {
  return PROVIDER_FAULT_CODES.has(code);
}

export function extractPartialText(buffered: readonly { type: string }[]): string {
  let text = "";
  for (const ev of buffered) {
    if ((ev as { type: string; text?: string }).type === "text_delta") {
      text += (ev as { type: string; text: string }).text;
    }
  }
  return text;
}
