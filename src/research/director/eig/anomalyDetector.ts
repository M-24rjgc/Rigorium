import type { ClaimBelief } from "../../claims/types.js";
import type { EigPlan } from "./types.js";

/**
 * Anomaly accumulation detector (principle-evolution gate).
 *
 * When challenges to the claim space accumulate (weighted challenge density
 * above threshold across at least `minChallengedClaims` claims), the research
 * is signalling that its underlying assumptions — the *principle space* —
 * may be wrong. The planner then boosts the principle_revision action so a
 * paradigm shift becomes competitive with ordinary evidence gathering.
 */
export type AnomalyDetectionResult = Readonly<{
  anomalyScore: number;
  detected: boolean;
  challengedClaimCount: number;
  aggregateSupportsWeight: number;
  aggregateChallengesWeight: number;
}>;

export type AnomalyDetectorOptions = {
  /** Challenge density above this triggers anomaly mode. */
  challengeDensityThreshold?: number;
  /** Minimum number of challenged/falsified claims required. */
  minChallengedClaims?: number;
};

export const DEFAULT_CHALLENGE_DENSITY_THRESHOLD = 0.5;
export const DEFAULT_MIN_CHALLENGED_CLAIMS = 2;

export function detectAnomaly(
  beliefs: readonly ClaimBelief[],
  options: AnomalyDetectorOptions = {},
): AnomalyDetectionResult {
  const challengeDensityThreshold = options.challengeDensityThreshold ?? DEFAULT_CHALLENGE_DENSITY_THRESHOLD;
  const minChallengedClaims = options.minChallengedClaims ?? DEFAULT_MIN_CHALLENGED_CLAIMS;

  let aggregateSupportsWeight = 0;
  let aggregateChallengesWeight = 0;
  let challengedClaimCount = 0;
  for (const belief of beliefs) {
    aggregateSupportsWeight += belief.supportsWeight;
    aggregateChallengesWeight += belief.challengesWeight;
    if (belief.status === "challenged" || belief.status === "falsified") {
      challengedClaimCount += 1;
    }
  }

  const total = aggregateSupportsWeight + aggregateChallengesWeight;
  const anomalyScore = total > 0 ? aggregateChallengesWeight / total : 0;
  const detected = challengedClaimCount >= minChallengedClaims && anomalyScore >= challengeDensityThreshold;

  return Object.freeze({
    anomalyScore,
    detected,
    challengedClaimCount,
    aggregateSupportsWeight,
    aggregateChallengesWeight,
  });
}

/**
 * Boost factor applied to principle_revision gain when an anomaly is
 * detected. Scales linearly with the challenge density: a paradigm shift is
 * most attractive exactly when anomalies dominate the evidence.
 */
export function principleRevisionBoost(anomaly: AnomalyDetectionResult): number {
  if (!anomaly.detected) {
    return 1;
  }
  return 1 + 3 * anomaly.anomalyScore;
}

/**
 * Feed the anomaly signal into an EIG plan: when anomaly mode is active,
 * principle_revision becomes attractive enough to outrank weak per-claim
 * actions. `shouldStop`/`stopReason` are re-derived from the boosted ranking
 * so the plan stays internally consistent (a boosted principle revision may
 * legitimately clear the stop bar). The stop bar is the caller's configured
 * threshold — a custom `stopScoreThreshold` must not be silently overridden
 * by a hard-coded constant (the caller's threshold is the plan's own).
 */
export function applyAnomalyBoost(
  plan: EigPlan,
  anomaly: AnomalyDetectionResult,
  stopScoreThreshold = DEFAULT_STOP_SCORE_THRESHOLD,
): EigPlan {
  if (!anomaly.detected) {
    return plan;
  }
  const boost = principleRevisionBoost(anomaly);
  const ranked = plan.ranked.map((estimate) => {
    if (estimate.action.type !== "principle_revision") {
      return estimate;
    }
    return Object.freeze({
      ...estimate,
      expectedInformationGain: estimate.expectedInformationGain * boost,
      score: estimate.score * boost,
      rationale: `${estimate.rationale} (anomaly boost ×${boost.toFixed(2)}: challenges accumulated)`,
    });
  });
  const sorted = [...ranked].sort((left, right) => right.score - left.score);
  const topScore = sorted[0]?.score ?? 0;
  // Re-derive the stop decision from the boosted ranking.
  const shouldStop = plan.shouldStop && topScore < stopScoreThreshold;
  const stopReason = shouldStop
    ? plan.stopReason
    : topScore >= stopScoreThreshold && plan.shouldStop
      ? `Anomaly boost lifted principle revision above the stop threshold (score ${topScore.toFixed(4)}); the plan resumes.`
      : plan.stopReason;
  return Object.freeze({
    ...plan,
    ranked: Object.freeze(sorted),
    shouldStop,
    stopReason,
  });
}

/** Stop bar used to re-derive shouldStop after the anomaly boost. */
export const DEFAULT_STOP_SCORE_THRESHOLD = 0.005;
