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
 *
 * Two best-practice refinements (LiteLLM Auto Router cascade / contextual-
 * bandit exploration, researched against RouteLLM, ParetoBandit, semantic
 * router):
 *
 *   - `explorationRate`: even when the learned path is confident, a small
 *     fraction of requests re-consults the judge. The judge's decision feeds
 *     back into the same ranker, so this is a periodic re-calibration that
 *     prevents an outdated advantage (provider upgrades, pricing, task-drift)
 *     from locking the learned path forever — without changing what a
 *     "learned" or "judge" decision means.
 *   - Judge-failure degradation: when the judge itself fails (timeout /
 *     model error / unparseable output) the confident learned path takes
 *     over instead of collapsing to the default tier — strictly more
 *     information than the fixed default, same decision shape.
 */
export type UncertaintyGatedClassifierOptions = {
  minObservations?: number;
  minMargin?: number;
  /** When false, always delegate to the judge (diagnostics). */
  enabled?: boolean;
  /**
   * Probability (0..<1) of re-consulting the judge even when the learned
   * path is confident. Default 0.05 (≈1 request in 20 re-calibrates).
   */
  explorationRate?: number;
  /** Injectable randomness for tests. */
  random?: () => number;
};

export type LearnedClassifyInput = ClassifyAndRouteInput & {
  /** Capability requirements computed by the router for this request. */
  requirements?: CapabilityRequirements;
};

const DEFAULT_MIN_OBSERVATIONS = 4;
const DEFAULT_MIN_MARGIN = 0.15;
const DEFAULT_EXPLORATION_RATE = 0.05;

export class UncertaintyGatedTierClassifier implements TierClassifier {
  private readonly judge: TierClassifier;
  private readonly ranker: AmortizedRanker;
  private readonly minObservations: number;
  private readonly minMargin: number;
  private readonly enabled: boolean;
  private readonly explorationRate: number;
  private readonly random: () => number;

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
    this.explorationRate = options.explorationRate ?? DEFAULT_EXPLORATION_RATE;
    this.random = options.random ?? Math.random;
  }

  async classify(input: LearnedClassifyInput): Promise<TokenSaverDecision | undefined> {
    const requirements = input.requirements;
    if (!this.enabled || !requirements) {
      return this.judge.classify(input);
    }
    const learned = this.tryLearned(input, requirements);
    if (learned && this.random() >= this.explorationRate) {
      this.emitLearnedRoute(input, learned);
      return {
        tier: learned.tier,
        selection: learned.selection,
        resolvedFrom: "learned",
      };
    }
    if (learned) {
      // Exploration: re-consult the judge this once so the ranker gets a
      // fresh observation (periodic re-calibration against drift).
      input.telemetry?.trackFeatureLoopStage?.({
        module: "router",
        ownerModule: "router",
        executionKind: "router_judge",
        phase: "classify",
        loopStage: "module_event",
        outcome: "success",
        sessionId: input.sessionId,
        metadata: {
          event: "judge_recalibration",
          bucket: learned.bucket,
          tier: learned.tier,
          observations: learned.observations,
          margin: learned.margin,
        },
      });
    }

    const decision = await this.judge.classify(input);
    if (decision?.failureReason && learned) {
      // The judge is the escape hatch for known-broken tiers; when it is
      // itself broken, a confident learned answer beats the fixed default.
      input.telemetry?.trackFeatureLoopStage?.({
        module: "router",
        ownerModule: "router",
        executionKind: "router_judge",
        phase: "classify",
        loopStage: "module_event",
        outcome: "success",
        sessionId: input.sessionId,
        metadata: {
          event: "learned_after_judge_failure",
          bucket: learned.bucket,
          tier: learned.tier,
          observations: learned.observations,
          margin: learned.margin,
          judgeFailureReason: decision.failureReason,
        },
      });
      return {
        tier: learned.tier,
        selection: learned.selection,
        resolvedFrom: "learned",
      };
    }
    return decision;
  }

  /**
   * The learned decision when the per-bucket evidence is strong enough.
   * The learned path requires BOTH enough observations AND a genuine margin
   * between at least two tiers. A single-tier bucket has no competition: its
   * "margin" degenerates to the raw Laplace score, so a bucket that only
   * ever failed (score 1/6 at 4 observations) must not lock the judge out —
   * the judge is exactly the escape hatch for known-broken tiers.
   */
  private tryLearned(
    input: LearnedClassifyInput,
    requirements: CapabilityRequirements,
  ): (TokenSaverDecision & { bucket: string; observations: number; margin: number }) | undefined {
    const bucket = this.ranker.bucketKey(requirements);
    const scored = this.ranker.score(bucket);
    if (
      scored.entries.length >= 2 &&
      scored.totalObservations >= this.minObservations &&
      scored.topTier !== undefined &&
      scored.topMargin >= this.minMargin
    ) {
      const selection = tierModel(input.config, scored.topTier);
      if (selection) {
        return {
          tier: scored.topTier,
          selection,
          resolvedFrom: "learned",
          bucket,
          observations: scored.totalObservations,
          margin: scored.topMargin,
        };
      }
    }
    return undefined;
  }

  private emitLearnedRoute(
    input: LearnedClassifyInput,
    learned: TokenSaverDecision & { bucket: string; observations: number; margin: number },
  ): void {
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
        bucket: learned.bucket,
        tier: learned.tier,
        observations: learned.observations,
        margin: learned.margin,
      },
    });
  }
}

function tierModel(
  config: RouterTokenSaverConfig,
  tier: string,
): RouterModelRef | undefined {
  return config.tiers[tier]?.model;
}
