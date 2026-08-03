import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalUsage,
  ModelRuntime,
} from "../../model/index.js";
import type { RouterEventBus } from "../protocol/events.js";
import type { RouterExecuteContext } from "../protocol/decision.js";
import {
  canonicalizeModelRequestError,
  classifyNetworkErrorCode,
  isNetworkTransient,
  protocolForProvider,
} from "./errors.js";
import { throwAbortError } from "./abortable.js";
import {
  createZeroUsageState,
  observeEventForZeroUsage,
  shouldRetryZeroUsage,
} from "../retry/zeroUsageRetry.js";

export type AttemptOutcome = {
  buffered: CanonicalModelEvent[];
  error?: import("../../model/index.js").CanonicalModelError;
  usage?: CanonicalUsage;
  shouldRetryZeroUsage: boolean;
};

/**
 * Live attempt — yields each model event the moment it arrives, then yields
 * a final `{ outcome }` sentinel with retry/usage metadata. The previous
 * implementation `await`-ed the entire stream into `buffered[]` before
 * returning, which silently broke streaming UX (TUI/CLI saw the assistant
 * text appear in one burst at the end of the turn).
 *
 * Trade-off: zero-usage retry and provider fallback can only fire BEFORE we
 * yield any content. If a provider crashes mid-stream after we've already
 * surfaced text, we can't transparently fall back without leaking duplicate
 * text. This matches OpenAI's / Anthropic's own clients.
 */
export async function* streamAttempt(
  request: CanonicalModelRequest,
  modelRuntime: ModelRuntime,
  ctx: RouterExecuteContext,
  events: RouterEventBus,
): AsyncGenerator<
  | { kind: "event"; event: CanonicalModelEvent }
  | { kind: "outcome"; outcome: AttemptOutcome }
> {
  const buffered: CanonicalModelEvent[] = [];
  const state = createZeroUsageState();
  let providerError: import("../../model/index.js").CanonicalModelError | undefined;
  const abortSignal = ctx.abortSignal;

  try {
    for await (const event of modelRuntime.stream(request, {
      signal: abortSignal,
      onRetryProgress(progress) {
        events.emit({
          type: "rigorium_router_retry_progress",
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          attempt: progress.attempt,
          maxAttempts: progress.maxAttempts,
          delayMs: progress.delayMs,
          reason: progress.reason,
          provider: progress.provider,
          model: progress.model,
        });
      },
    })) {
      if (abortSignal?.aborted) {
        throwAbortError(abortSignal.reason);
      }
      observeEventForZeroUsage(state, event);
      buffered.push(event);
      if (event.type === "error") {
        providerError = event.error;
      }
      yield { kind: "event", event };
    }
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    const fromError = (error as { error?: import("../../model/index.js").CanonicalModelError })?.error;
    const protocol = protocolForProvider(modelRuntime, request.provider);
    providerError = fromError ?? canonicalizeModelRequestError(error, request, protocol) ?? {
      provider: request.provider,
      protocol,
      code: classifyNetworkErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
      retryable: isNetworkTransient(error),
    };
  }

  yield {
    kind: "outcome",
    outcome: {
      buffered,
      error: providerError,
      usage: state.observedUsage,
      shouldRetryZeroUsage: shouldRetryZeroUsage(state),
    },
  };
}
