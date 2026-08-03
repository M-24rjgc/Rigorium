import type { ClaimBelief } from "../../claims/types.js";
import { estimateEig } from "./estimate.js";
import type {
  EigActionInput,
  EigEstimate,
  EigPlan,
  EigPlannerDeps,
  EigPlannerOptions,
  ResearchActionType,
} from "./types.js";

export const DEFAULT_STOP_SCORE_THRESHOLD = 0.005;
export const DEFAULT_MAX_ACTIONS = 6;
export const DEFAULT_MAX_ACTIONS_PER_CLAIM = 1;

/** Action types considered per active claim (evidence-gathering spectrum). */
const CLAIM_ACTION_TYPES: readonly ResearchActionType[] = [
  "run_experiment",
  "literature_search",
  "review",
];

/**
 * Belief-driven planner: rank (claim, action) pairs by expected information
 * gain per unit cost and pick a de-duplicated batch.
 *
 * This is the anti-pipeline: no fixed stage order, no hard-coded workflow.
 * The planner only computes a *ranking*; the director (and the agent loop)
 * decide how many actions to dispatch, in what order, and whether to
 * parallelize independent claims. Stop is a first-class output: when no
 * action clears the minimum score bar, the honest recommendation is to stop
 * or revise principles — not to grind through a fixed sequence.
 */
export function planByInformationGain(
  beliefs: readonly ClaimBelief[],
  options: EigPlannerOptions = {},
  deps: EigPlannerDeps = {},
): EigPlan {
  const stopScoreThreshold = options.stopScoreThreshold ?? DEFAULT_STOP_SCORE_THRESHOLD;
  const maxActions = options.maxActions ?? DEFAULT_MAX_ACTIONS;
  const maxActionsPerClaim = options.maxActionsPerClaim ?? DEFAULT_MAX_ACTIONS_PER_CLAIM;

  const active = beliefs.filter((belief) => belief.status === "active");
  const candidates: EigEstimate[] = [];

  for (const belief of active) {
    for (const type of CLAIM_ACTION_TYPES) {
      const action: EigActionInput = {
        type,
        claimId: belief.claimId,
        producesKinds: producesFor(type),
      };
      candidates.push(estimateEig(action, belief, deps));
    }
  }

  // Principle revision is always a candidate: aggregate uncertainty may make
  // it the highest-gain action even when per-claim actions look weak.
  const activeBeliefs = active;
  const aggregateUncertainty = activeBeliefs.length > 0
    ? activeBeliefs.reduce((sum, belief) => sum + belief.uncertainty, 0) / activeBeliefs.length
    : 0;
  candidates.push(estimateEig({ type: "principle_revision" }, undefined, deps, { aggregateUncertainty }));

  const ranked = candidates
    .filter((estimate) => estimate.expectedInformationGain > 0)
    .sort((left, right) => right.score - left.score);

  // Batch selection with de-duplication: at most `maxActionsPerClaim` actions
  // per claim (they are mutually redundant), up to `maxActions` total.
  const perClaim = new Map<string, number>();
  const selected: EigEstimate[] = [];
  for (const estimate of ranked) {
    const claimId = estimate.action.claimId;
    if (claimId !== undefined) {
      const count = perClaim.get(claimId) ?? 0;
      if (count >= maxActionsPerClaim) continue;
      perClaim.set(claimId, count + 1);
    }
    selected.push(estimate);
    if (selected.length >= maxActions) break;
  }

  const topScore = selected[0]?.score ?? 0;
  const shouldStop = topScore < stopScoreThreshold;
  const stopReason = shouldStop
    ? `Best action score ${topScore.toFixed(4)} is below the stop threshold ${stopScoreThreshold}; ` +
      "no evidence-gathering action is worth its cost."
    : undefined;

  return Object.freeze({
    computedAt: new Date().toISOString(),
    ranked: Object.freeze(selected),
    shouldStop,
    stopReason,
  });
}

function producesFor(type: ResearchActionType): readonly string[] {
  switch (type) {
    case "run_experiment":
      return ["run_attempt", "metric_observation"];
    case "literature_search":
      return ["evidence_pack"];
    case "review":
      return ["finding"];
    default:
      return [];
  }
}
