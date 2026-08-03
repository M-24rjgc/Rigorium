import type { CanonicalModelRequest, CanonicalUsage } from "../../model/index.js";
import type { RouterModelRef, RouterTokenSaverConfig } from "../config/schema.js";
import type { RouterMutationsLog } from "../protocol/decision.js";
import {
  calculateCacheReadCost,
  calculateInputCost,
} from "../utils/modelPricing.js";
import { countMessagesTokens } from "../utils/countTokens.js";

export type CacheAwareSwitchingConfig = NonNullable<RouterTokenSaverConfig["cacheAwareSwitching"]>;

export type CacheAwareResult = {
  selection: RouterModelRef;
  mutation?: RouterMutationsLog["cacheAwareSwitch"];
};

/**
 * Cost comparison between staying on the session's current (sticky) model —
 * which has a warm prompt cache — and switching to a newly-judged model that
 * would re-prefill the full prompt. Only switch when the re-prefill cost is
 * cheaper than the cached reads by at least `minSavingsRatio`.
 */
export function maybePreserveStickyForCache(
  current: RouterModelRef | undefined,
  next: RouterModelRef,
  messages: CanonicalModelRequest["messages"],
  lastUsage: CanonicalUsage | undefined,
  cacheAware: CacheAwareSwitchingConfig | undefined,
  modelPricing: Parameters<typeof calculateInputCost>[3],
): CacheAwareResult {
  if (cacheAware?.enabled === false || !current) {
    return { selection: next };
  }
  if (current.provider === next.provider && current.model === next.model) {
    return { selection: next };
  }

  const estimatedInputTokens = countMessagesTokens(messages);
  const observedInputTokens = lastUsage?.inputTokens ?? 0;
  const observedCacheReadTokens = lastUsage?.cacheReadTokens ?? 0;
  const observedCacheHitRatio = observedInputTokens > 0
    ? Math.min(1, Math.max(0, observedCacheReadTokens / observedInputTokens))
    : 0;
  if (observedCacheHitRatio <= 0) {
    return { selection: next };
  }

  const estimatedCacheReadTokens = Math.floor(estimatedInputTokens * observedCacheHitRatio);
  const estimatedUncachedTokens = Math.max(0, estimatedInputTokens - estimatedCacheReadTokens);
  const cachedCost = calculateCacheReadCost(
    estimatedCacheReadTokens,
    current.provider,
    current.model,
    modelPricing,
  ) + calculateInputCost(
    estimatedUncachedTokens,
    current.provider,
    current.model,
    modelPricing,
  );
  const prefillCost = calculateInputCost(
    estimatedInputTokens,
    next.provider,
    next.model,
    modelPricing,
  );

  const minSavingsRatio = cacheAware?.minSavingsRatio ?? 0;
  const requiredSavings = cachedCost * minSavingsRatio;
  const shouldSwitch = prefillCost + Number.EPSILON < cachedCost - requiredSavings;
  const from = `${current.provider}/${current.model}`;
  const to = `${next.provider}/${next.model}`;

  if (shouldSwitch) {
    return {
      selection: next,
      mutation: {
        action: "switched",
        from,
        to,
        cachedCost,
        prefillCost,
        estimatedInputTokens,
      },
    };
  }

  return {
    selection: current,
    mutation: {
      action: "kept_sticky",
      from,
      to,
      cachedCost,
      prefillCost,
      estimatedInputTokens,
    },
  };
}
