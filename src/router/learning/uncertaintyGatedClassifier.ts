import type { ModelRuntime } from "../../model/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type { RouterModelRef, RouterTokenSaverConfig } from "../config/schema.js";
import type { CapabilityRequirements } from "../policy/capabilityRequirements.js";
import type {
  ClassifyAndRouteInput,
  TierClassifier,
  TokenSaverDecision,
} from "../tokenSaver/tierClassifier.js";
import { AmortizedRanker } from "./AmortizedRanker.js";

/**
 * Uncertainty-gated tier classifier (Phase 2.2).
 *
 * The judge LLM is expensive (~5-15s per call) and its classification is
 * deterministic work for recurring task shapes. This classifier delegates to
 * the amortized ranker whenever the per-bucket evidence is strong enough:
 *
 *   - at least `minObservations` routed turns for the capability signature,
 *   - and the top tier beats the runner-up by at least `minMargin`.
 *
 * Otherwise it falls through to the judge (cold start / genuinely novel task
 * shapes). The ranker is fed by the router's own outcomes, so the gating
 * threshold is a quality/cost knob — not a learned policy itself.
 */
export type UncertaintyGatedClassifierOptions = {
  minObservations?: number;
  minMargin?: number;
  /** When false, always delegate to the judge (diagnostics). */
  enabled?: boolean;
};

export type LearnedClassifyInput = ClassifyAndRouteInput & {
  /** Capability requirements computed by the router for this request. */
  requirements?: CapabilityRequirements;
};

const DEFAULT_MIN_OBSERVATIONS = 4;
const DEFAULT_MIN_MARGIN = 0.15;

export class UncertaintyGatedTierClassifier implements TierClassifier {
  private readonly judge: TierClassifier;
  private readonly ranker: AmortizedRanker;
  private readonly minObservations: number;
  private readonly minMargin: number;
  private readonly enabled: boolean;

  constructor(
    judge: TierClassifier,
    ranker: AmortizedRanker,
    options: UncertaintyGatedClassifierOptions = {},
  ) {
    this.judge = judge;
    this.ranker = ranker;
    this.minObservations = options.minObservations ?? DEFAULT_MIN_OBSERVATIONS;
    this.minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN;
    this.enabled = options.enabled ?? true;
  }

  async classify(input: LearnedClassifyInput): Promise<TokenSaverDecision | undefined> {
    const requirements = input.requirements;
    if (this.enabled && requirements) {
      const bucket = this.ranker.bucketKey(requirements);
      const scored = this.ranker.score(bucket);
      // The learned path requires BOTH enough observations AND a genuine
      // margin between at least two tiers. A single-tier bucket has no
      // competition: its "margin" degenerates to the raw Laplace score, so a
      // bucket that only ever failed (score 1/6 at 4 observations) must not
      // lock the judge out — the judge is exactly the escape hatch for
      // known-broken tiers.
      const hasCompetition = scored.entries.length >= 2;
      if (
        hasCompetition &&
        scored.totalObservations >= this.minObservations &&
        scored.topTier !== undefined &&
        scored.topMargin >= this.minMargin
      ) {
        const selection = tierModel(input.config, scored.topTier);
        if (selection) {
          input.telemetry?.trackFeatureLoopStage?.({
            module: "router",
            ownerModule: "router",
            executionKind: "router_judge",
            phase: "classify",
            loopStage: "module_event",
            outcome: "success",
            sessionId: input.sessionId,
            metadata: {
              event: "learned_route",
              bucket,
              tier: scored.topTier,
              observations: scored.totalObservations,
              margin: scored.topMargin,
            },
          });
          return {
            tier: scored.topTier,
            selection,
            resolvedFrom: "learned",
          };
        }
      }
    }
    return this.judge.classify(input);
  }
}

function tierModel(
  config: RouterTokenSaverConfig,
  tier: string,
): RouterModelRef | undefined {
  return config.tiers[tier]?.model;
}
