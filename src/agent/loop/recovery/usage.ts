import type { CanonicalUsage } from "../../../model/index.js";

/** Sum two usages field-wise; undefined fields behave as zero. */
export function mergeUsage(first: CanonicalUsage, second: CanonicalUsage | undefined): CanonicalUsage {
  if (!second) {
    return first;
  }
  return {
    inputTokens: add(first.inputTokens, second.inputTokens),
    outputTokens: add(first.outputTokens, second.outputTokens),
    cacheReadTokens: add(first.cacheReadTokens, second.cacheReadTokens),
    cacheWriteTokens: add(first.cacheWriteTokens, second.cacheWriteTokens),
    totalTokens: add(first.totalTokens, second.totalTokens),
  };
}

function add(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined && second === undefined) {
    return undefined;
  }
  return (first ?? 0) + (second ?? 0);
}

export function tokensFromUsage(usage: CanonicalUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens;
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens <= 0) {
    return undefined;
  }
  const outputTokens = typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens) && usage.outputTokens > 0
    ? usage.outputTokens
    : 0;
  return Math.ceil(inputTokens + outputTokens);
}

export function clampOutputToModelCap(requested: number, modelMaxOutputTokens: number | undefined): number | undefined {
  if (!Number.isFinite(requested) || requested <= 0) return undefined;
  const next = Math.floor(requested);
  if (modelMaxOutputTokens !== undefined && Number.isFinite(modelMaxOutputTokens) && modelMaxOutputTokens > 0) {
    return Math.min(next, Math.floor(modelMaxOutputTokens));
  }
  return next;
}

export function modelErrorTarget(error: { provider?: string; model?: string }, fallbackProvider: string, fallbackModel: string): {
  provider: string;
  model: string;
} {
  return {
    provider: error.provider || fallbackProvider,
    model: error.model || fallbackModel,
  };
}

/**
 * Compose an AbortSignal from an optional parent signal and an optional
 * timeout. Returns a cleanup function and a `timedOut()` probe for callers
 * that need to distinguish timeout aborts from user aborts (e.g. subagents).
 */
export function composeAbortSignal(args: {
  parent?: AbortSignal;
  timeoutMs?: number;
}): { signal: AbortSignal | undefined; cleanup: () => void; timedOut: () => boolean } {
  const { parent, timeoutMs } = args;
  if (!parent && (!timeoutMs || timeoutMs <= 0)) {
    return { signal: undefined, cleanup: () => {}, timedOut: () => false };
  }
  const controller = new AbortController();
  const cleanupFns: Array<() => void> = [];
  let timedOut = false;
  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      const onAbort = () => controller.abort(parent.reason);
      parent.addEventListener("abort", onAbort, { once: true });
      cleanupFns.push(() => parent.removeEventListener("abort", onAbort));
    }
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0 && !controller.signal.aborted) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Subagent timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    cleanupFns.push(() => clearTimeout(timeout));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const fn of cleanupFns) fn();
    },
    timedOut: () => timedOut,
  };
}
