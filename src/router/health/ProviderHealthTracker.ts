export type ProviderHealthState = "healthy" | "degraded" | "open" | "half_open";

const DEFAULT_DEGRADE_THRESHOLD = 3;
const DEFAULT_OPEN_THRESHOLD = 5;
const DEFAULT_OPEN_DURATION_MS = 30_000;
const DEFAULT_MAX_OPEN_DURATION_MS = 300_000;
const DEFAULT_WINDOW_SIZE = 20;
/** Half-open probe budget (Resilience4j 1-10 / gobreaker 1 consensus). */
const DEFAULT_HALF_OPEN_PROBES = 3;
/** Half-open window reopens when the probe failure ratio reaches this. */
const DEFAULT_HALF_OPEN_FAILURE_RATIO = 0.5;

/**
 * Error codes that signal provider *stress* rather than a bad request:
 * a single 429/overloaded is enough to mark the provider degraded (the
 * next request would likely hit the same limit) instead of waiting for
 * `degradeThreshold` consecutive failures.
 */
const STRESS_CODES = new Set(["rate_limit_error", "overloaded_error"]);

type HalfOpenProbeResults = {
  success: number;
  failure: number;
};

type ProviderRecord = {
  state: ProviderHealthState;
  consecutiveFailures: number;
  /** Timestamp (ms) when the circuit was opened. */
  openedAt: number;
  /** Sliding window of recent results (true = success). */
  window: boolean[];
  /**
   * Consecutive open cycles — drives exponential backoff of the open
   * duration (Envoy base_ejection_time × count / Polly BreakDurationGenerator
   * semantics): the longer the provider stays broken, the less often we
   * re-probe it. Reset on full recovery.
   */
  openCount: number;
  /** Half-open probe window results (Resilience4j ratio semantics). */
  probeResults: HalfOpenProbeResults;
};

/**
 * Lightweight circuit-breaker that tracks per-provider health.
 *
 * States:
 *   healthy  → degraded (after `degradeThreshold` consecutive failures)
 *   degraded → open     (after `openThreshold` consecutive failures)
 *   open     → half_open (after the open duration — which grows
 *                         exponentially per open cycle, capped)
 *   half_open → healthy (probe window succeeds) or open (probe window
 *                        fails by ratio)
 *
 * Half-open recovery follows the Resilience4j / gobreaker model: a limited
 * probe budget (`halfOpenProbes`) of real requests is let through and the
 * window result decides by ratio — a single flaky failure does NOT reopen
 * the circuit, and after the budget is exhausted no further requests reach
 * the provider until the window resolves.
 *
 * The tracker never blocks requests for explicitly-chosen providers
 * (the caller is responsible for that check).
 */
export class ProviderHealthTracker {
  private readonly records = new Map<string, ProviderRecord>();
  private readonly degradeThreshold: number;
  private readonly openThreshold: number;
  private readonly openDurationMs: number;
  private readonly maxOpenDurationMs: number;
  private readonly windowSize: number;
  private readonly halfOpenProbes: number;
  private readonly halfOpenFailureRatio: number;

  private readonly now: () => number;

  constructor(options?: {
    degradeThreshold?: number;
    openThreshold?: number;
    openDurationMs?: number;
    maxOpenDurationMs?: number;
    windowSize?: number;
    halfOpenProbes?: number;
    halfOpenFailureRatio?: number;
    /** Injectable clock (tests); defaults to Date.now(). */
    now?: () => number;
  }) {
    this.degradeThreshold = options?.degradeThreshold ?? DEFAULT_DEGRADE_THRESHOLD;
    this.openThreshold = options?.openThreshold ?? DEFAULT_OPEN_THRESHOLD;
    this.openDurationMs = options?.openDurationMs ?? DEFAULT_OPEN_DURATION_MS;
    this.maxOpenDurationMs = options?.maxOpenDurationMs ?? DEFAULT_MAX_OPEN_DURATION_MS;
    this.windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.halfOpenProbes = Math.max(1, options?.halfOpenProbes ?? DEFAULT_HALF_OPEN_PROBES);
    this.halfOpenFailureRatio = options?.halfOpenFailureRatio ?? DEFAULT_HALF_OPEN_FAILURE_RATIO;
    this.now = options?.now ?? Date.now;
  }

  private getOrCreate(providerId: string): ProviderRecord {
    let rec = this.records.get(providerId);
    if (!rec) {
      rec = {
        state: "healthy",
        consecutiveFailures: 0,
        openedAt: 0,
        window: [],
        openCount: 0,
        probeResults: { success: 0, failure: 0 },
      };
      this.records.set(providerId, rec);
    }
    return rec;
  }

  recordSuccess(providerId: string): void {
    const rec = this.getOrCreate(providerId);
    this.maybeTransitionToHalfOpen(rec);
    rec.consecutiveFailures = 0;
    rec.window.push(true);
    if (rec.window.length > this.windowSize) rec.window.shift();
    if (rec.state === "half_open") {
      rec.probeResults.success += 1;
      if (this.probeWindowComplete(rec)) {
        this.resolveProbeWindow(rec);
      }
      return;
    }
    if (rec.state === "degraded" || rec.state === "open") {
      rec.state = "healthy";
    }
  }

  recordFailure(providerId: string, errorCode?: string): void {
    const rec = this.getOrCreate(providerId);
    this.maybeTransitionToHalfOpen(rec);
    rec.consecutiveFailures++;
    rec.window.push(false);
    if (rec.window.length > this.windowSize) rec.window.shift();
    if (rec.state === "half_open") {
      // Probe window semantics: a single failure does NOT reopen the
      // circuit — the window resolves by ratio once the budget is used up
      // (Resilience4j failureRateThreshold). Only then do we decide.
      rec.probeResults.failure += 1;
      if (this.probeWindowComplete(rec)) {
        this.resolveProbeWindow(rec);
      }
      return;
    }
    if (errorCode !== undefined && STRESS_CODES.has(errorCode) && rec.state === "healthy") {
      // Provider-level stress (rate limit / overload) degrades immediately —
      // the next attempt would likely hit the same wall. Still counts toward
      // the consecutive-failure counters so sustained stress still opens.
      rec.state = "degraded";
    }
    if (rec.consecutiveFailures >= this.openThreshold) {
      if (rec.state !== "open") {
        this.open(rec);
      }
    } else if (rec.consecutiveFailures >= this.degradeThreshold) {
      if (rec.state === "healthy") {
        rec.state = "degraded";
      }
    }
  }

  getState(providerId: string): ProviderHealthState {
    const rec = this.records.get(providerId);
    if (!rec) return "healthy";
    this.maybeTransitionToHalfOpen(rec);
    return rec.state;
  }

  /**
   * Returns true when the provider should be skipped: circuit open, or
   * half-open with the probe budget exhausted (no more real requests are
   * let through until the window resolves).
   */
  shouldSkip(providerId: string): boolean {
    const state = this.getState(providerId);
    if (state === "open") return true;
    if (state === "half_open") {
      const rec = this.records.get(providerId)!;
      return this.probeWindowComplete(rec);
    }
    return false;
  }

  /**
   * Returns true when the provider can accept requests: healthy, degraded
   * (quality-gated upstream), or half-open with probe budget remaining.
   */
  isAvailable(providerId: string): boolean {
    return !this.shouldSkip(providerId);
  }

  getSuccessRate(providerId: string): number {
    const rec = this.records.get(providerId);
    if (!rec || rec.window.length === 0) return 1;
    return rec.window.filter(Boolean).length / rec.window.length;
  }

  /** Per-provider health snapshot (observability/telemetry). */
  snapshot(): Map<string, { state: ProviderHealthState; consecutiveFailures: number; openCount: number }> {
    const out = new Map<string, { state: ProviderHealthState; consecutiveFailures: number; openCount: number }>();
    for (const [providerId, rec] of this.records) {
      out.set(providerId, {
        state: rec.state,
        consecutiveFailures: rec.consecutiveFailures,
        openCount: rec.openCount,
      });
    }
    return out;
  }

  reset(providerId: string): void {
    this.records.delete(providerId);
  }

  resetAll(): void {
    this.records.clear();
  }

  /**
   * Exponential backoff of the open duration (Envoy/Polly consensus):
   * base × 2^(openCount-1), capped. A provider that keeps failing probes
   * waits longer before the next probe window.
   */
  private effectiveOpenDurationMs(rec: ProviderRecord): number {
    const backoff = this.openDurationMs * 2 ** Math.max(0, rec.openCount - 1);
    return Math.min(backoff, this.maxOpenDurationMs);
  }

  /** Time-driven open → half_open transition (fresh probe window). */
  private maybeTransitionToHalfOpen(rec: ProviderRecord): void {
    if (rec.state === "open" && this.now() - rec.openedAt >= this.effectiveOpenDurationMs(rec)) {
      rec.state = "half_open";
      rec.probeResults = { success: 0, failure: 0 };
    }
  }

  private probeWindowComplete(rec: ProviderRecord): boolean {
    return rec.probeResults.success + rec.probeResults.failure >= this.halfOpenProbes;
  }

  /**
   * Half-open window resolved: reopen when the failure ratio is at/above
   * threshold (openCount increments → the next open wait backs off),
   * otherwise the provider recovered (openCount resets).
   */
  private resolveProbeWindow(rec: ProviderRecord): void {
    const total = rec.probeResults.success + rec.probeResults.failure;
    const failureRatio = total > 0 ? rec.probeResults.failure / total : 0;
    if (failureRatio >= this.halfOpenFailureRatio) {
      this.open(rec);
    } else {
      rec.state = "healthy";
      rec.openCount = 0;
    }
    rec.probeResults = { success: 0, failure: 0 };
  }

  private open(rec: ProviderRecord): void {
    if (rec.state !== "open") {
      rec.state = "open";
      rec.openedAt = this.now();
      rec.openCount += 1;
    }
  }
}
