import { throwAbortError } from "./abortable.js";

/**
 * Per-provider concurrency gate.
 *
 * Best practice from LLM gateways (LiteLLM per-deployment concurrency,
 * OpenRouter 429 guidance): a client-side semaphore per provider keeps a
 * degraded or self-hosted endpoint from being hammered by concurrent
 * sessions/turns. Routing decisions are untouched — the gate only limits
 * how many provider requests are in flight at once.
 *
 * Semantics:
 * - FIFO waiters (no starvation for late-but-eager turns).
 * - Bounded wait: after `waitTimeoutMs` the waiter is released with a
 *   retryable `provider_concurrency_limit` error, which flows through the
 *   existing transient-retry / fallback machinery (backoff, then another
 *   provider) instead of failing the turn.
 * - Abort-aware: an aborted turn leaves the queue immediately and the
 *   abort propagates; a slot held by an aborted request is released.
 * - The gate is a pure in-process semaphore: no timers leak, all state is
 *   per-provider, and a disabled gate is a no-op passthrough.
 */
export type ProviderConcurrencyConfig = {
  enabled?: boolean;
  /** Max in-flight requests per provider (per process). */
  maxPerProvider?: number;
  /** How long a waiter stays queued before surfacing a retryable error. */
  waitTimeoutMs?: number;
};

export const DEFAULT_PROVIDER_CONCURRENCY: Required<ProviderConcurrencyConfig> = Object.freeze({
  // Opt-in by default, matching LiteLLM's `max_parallel_requests` (None =
  // unlimited): capping in-flight requests is a deployment decision. Users
  // with self-hosted endpoints opt in via `router.concurrency.enabled`.
  enabled: false,
  maxPerProvider: 4,
  waitTimeoutMs: 30_000,
});

type Waiter = {
  resolve: () => void;
  cleanup: () => void;
};

type ProviderSlot = {
  active: number;
  waiters: Waiter[];
};

/**
 * Error-shaped object thrown on queue timeout. streamAttempt's catch reads
 * `error.error` and treats it as the canonical model error directly, so the
 * transient-retry loop sees a clean retryable error with no re-canonicalization.
 * `protocol` is unknown at gate level; streamAttempt fills the real protocol.
 */
export type ProviderConcurrencyGateError = {
  error: Readonly<
    Omit<import("../../model/index.js").CanonicalModelError, "protocol"> &
      { protocol?: string }
  >;
};

export function providerConcurrencyLimitError(
  provider: string,
  waitTimeoutMs: number,
): ProviderConcurrencyGateError {
  return {
    error: Object.freeze({
      provider,
      protocol: "unknown",
      code: "provider_concurrency_limit",
      message: `Provider "${provider}" is at its concurrency limit (waited ${Math.round(waitTimeoutMs / 1000)}s for a free slot).`,
      retryable: true,
      userHint: "Retry shortly, reduce parallel subagents, or raise router.concurrency.maxPerProvider.",
    }),
  };
}

export class ProviderConcurrencyGate {
  private readonly options: Required<ProviderConcurrencyConfig>;
  private readonly slots = new Map<string, ProviderSlot>();

  constructor(options?: ProviderConcurrencyConfig) {
    this.options = {
      enabled: options?.enabled ?? DEFAULT_PROVIDER_CONCURRENCY.enabled,
      maxPerProvider: Math.max(1, options?.maxPerProvider ?? DEFAULT_PROVIDER_CONCURRENCY.maxPerProvider),
      waitTimeoutMs: Math.max(1, options?.waitTimeoutMs ?? DEFAULT_PROVIDER_CONCURRENCY.waitTimeoutMs),
    };
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  get maxPerProvider(): number {
    return this.options.maxPerProvider;
  }

  /** Observability: in-flight requests for a provider (0 for unknown). */
  activeCount(provider: string): number {
    return this.slots.get(provider)?.active ?? 0;
  }

  /** Observability: queued waiters for a provider (0 for unknown). */
  waitingCount(provider: string): number {
    return this.slots.get(provider)?.waiters.length ?? 0;
  }

  /**
   * Wait for a free slot for `provider`, then return a release function.
   * Throws on queue timeout (`{ error: CanonicalModelError }` shape,
   * retryable) or on abort (the abort reason propagates).
   */
  async acquire(provider: string, opts: { abortSignal?: AbortSignal } = {}): Promise<() => void> {
    if (!this.options.enabled) {
      return () => undefined;
    }
    if (opts.abortSignal?.aborted) {
      throwAbortError(opts.abortSignal.reason);
    }

    const slot = this.getOrCreateSlot(provider);
    if (slot.active < this.options.maxPerProvider) {
      slot.active += 1;
      return () => this.release(provider);
    }

    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        const index = slot.waiters.indexOf(waiter);
        if (index >= 0) slot.waiters.splice(index, 1);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        opts.abortSignal?.removeEventListener("abort", onAbort);
        reject(opts.abortSignal!.reason);
      };
      const waiter: Waiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          cleanup();
          opts.abortSignal?.removeEventListener("abort", onAbort);
          slot.active += 1;
          resolve(() => this.release(provider));
        },
        cleanup,
      };

      slot.waiters.push(waiter);
      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) {
          settled = true;
          cleanup();
          reject(opts.abortSignal.reason);
          return;
        }
        opts.abortSignal.addEventListener("abort", onAbort, { once: true });
      }
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        opts.abortSignal?.removeEventListener("abort", onAbort);
        reject(providerConcurrencyLimitError(provider, this.options.waitTimeoutMs));
      }, this.options.waitTimeoutMs);
    });
  }

  private getOrCreateSlot(provider: string): ProviderSlot {
    let slot = this.slots.get(provider);
    if (!slot) {
      slot = { active: 0, waiters: [] };
      this.slots.set(provider, slot);
    }
    return slot;
  }

  private release(provider: string): void {
    const slot = this.slots.get(provider);
    if (!slot || slot.active <= 0) return;
    slot.active -= 1;
    const next = slot.waiters.shift();
    if (next) {
      next.resolve();
    } else if (slot.active === 0) {
      // Drop the empty entry so per-provider state does not grow unboundedly
      // with config churn.
      this.slots.delete(provider);
    }
  }
}
