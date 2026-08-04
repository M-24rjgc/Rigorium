import type { ModelRuntime } from "../../model/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type { RouterModelRef, RouterTokenSaverConfig } from "../config/schema.js";
import { classifyAndRoute } from "./classifyAndRoute.js";

export type TokenSaverDecision = {
  tier: string;
  selection: RouterModelRef;
  resolvedFrom: "judge" | "default" | "fallback" | "learned" | "heuristic" | "continuation";
  failureReason?: "timeout" | "model_error" | "parse_error";
};

export type ClassifyAndRouteInput = {
  config: RouterTokenSaverConfig;
  messages: import("../../model/index.js").CanonicalMessage[];
  judgeRuntime: ModelRuntime;
  abortSignal?: AbortSignal;
  /** Tier from the previous turn; passed to the judge for context-aware classification. */
  previousTier?: string;
  sessionId?: string;
  telemetry?: TelemetryClient;
};

/**
 * Strategy seam for tier classification.
 *
 * `decide()` calls exactly one classifier per non-sticky request. The default
 * implementation (`JudgeTierClassifier`) keeps the historical behavior: a
 * judge LLM call with timeout/retry/parse fallbacks. Phase 2 of the routing
 * upgrade replaces this with an uncertainty-gated implementation that only
 * invokes the judge when a cheap amortized ranker is unsure — without changing
 * any call site.
 */
export interface TierClassifier {
  classify(input: ClassifyAndRouteInput): Promise<TokenSaverDecision | undefined>;
}

/**
 * The historical judge-LLM classifier. Behavior-preserving wrapper around
 * `classifyAndRoute` so the interface can be swapped without touching the
 * router core.
 */
export class JudgeTierClassifier implements TierClassifier {
  async classify(input: ClassifyAndRouteInput): Promise<TokenSaverDecision | undefined> {
    return classifyAndRoute(input);
  }
}

/** Singleton-safe default classifier (stateless). */
const defaultClassifier = new JudgeTierClassifier();

export function createDefaultTierClassifier(): TierClassifier {
  return defaultClassifier;
}
