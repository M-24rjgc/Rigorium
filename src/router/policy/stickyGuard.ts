import type { RouterStickyConfig } from "../config/schema.js";
import {
  DEFAULT_STICKY_MAX_QUALITY_FAILURES,
  DEFAULT_STICKY_TTL_MS,
} from "../config/schema.js";
import type { SessionRoutingState } from "../protocol/decision.js";

export type UsableSticky = SessionRoutingState & {
  stickyProvider: string;
  stickyModel: string;
};

/**
 * Sticky-selection guardrail factory.
 *
 * A sticky selection is only honored while it is fresh and healthy:
 * - not older than `sticky.ttlMs` (a resumed session or a long-lived turn
 *   should re-judge instead of pinning an arbitrary model forever), and
 * - below `sticky.maxQualityFailures` consecutive routed-turn failures
 *   (empty responses / exhausted fallback chains on the pinned model
 *   release the pin so the next decide() re-classifies).
 *
 * Declared as a type predicate so callers see a fully-populated sticky
 * (provider/model guaranteed present) inside the true branch.
 */
export function createStickyGuard(
  config: RouterStickyConfig | undefined,
  nowMs: () => number,
): (state: SessionRoutingState | undefined) => state is UsableSticky {
  const enabled = config?.enabled !== false;
  const ttlMs = config?.ttlMs ?? DEFAULT_STICKY_TTL_MS;
  const maxQualityFailures = config?.maxQualityFailures ?? DEFAULT_STICKY_MAX_QUALITY_FAILURES;

  return function isStickyUsable(
    state: SessionRoutingState | undefined,
  ): state is UsableSticky {
    if (!state || !enabled) {
      return false;
    }
    if (!state.stickyProvider || !state.stickyModel) {
      return false;
    }
    if (nowMs() - state.updatedAt > ttlMs) {
      return false;
    }
    if ((state.qualityFailures ?? 0) >= maxQualityFailures) {
      return false;
    }
    return true;
  };
}
