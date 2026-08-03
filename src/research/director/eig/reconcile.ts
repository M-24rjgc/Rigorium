import type { ClaimBelief } from "../../claims/types.js";
import type { EigPlan, ResearchActionType } from "./types.js";

/**
 * Belief-revision loop (Phase 1.3): the bridge between evidence, belief, and
 * the next plan.
 *
 * A full research cycle is: execute an action → artifacts land in the DAG →
 * beliefs recompute → if a claim was falsified/superseded, its descendants
 * were cascade-invalidated → the EIG planner re-ranks from the *revised*
 * belief state → the director dispatches the top action (or stops).
 *
 * `planReconciledActions` packages that transition for the director:
 * it reports which claims changed status since the previous plan (the
 * "backtracking" ledger) and which actions the new belief state favors.
 */
export type BeliefRevisionEvent = Readonly<{
  claimId: string;
  from: ClaimBelief["status"];
  /** "removed" marks a claim that disappeared from the graph. */
  to: ClaimBelief["status"] | "removed";
  reason: string;
}>;

export type ReconciledPlan = Readonly<{
  plan: EigPlan;
  /** Claims whose belief status changed since the last plan. */
  revisions: readonly BeliefRevisionEvent[];
  /** True when any active claim was downgraded (falsified/superseded). */
  backtracking: boolean;
  /** Action the director should dispatch next (plan.ranked[0]). */
  nextActionType?: ResearchActionType;
  nextActionClaimId?: string;
}>;

export type ReconciledPlanOptions = {
  /** Per-action cost overrides passed through to the EIG planner. */
  actionCosts?: Partial<Record<ResearchActionType, number>>;
  artifactCostModel?: ReadonlyMap<string, number>;
  /** Stop threshold used to re-derive shouldStop from the filtered ranking. */
  stopScoreThreshold?: number;
};

/**
 * Compare the current belief snapshot against the previous one, report the
 * revisions, and reconcile the EIG plan with the new state. The previous
 * plan's selected actions are re-scored: actions targeting now-invalid
 * claims are dropped, actions that remain valid keep their ranking, and
 * `shouldStop` is re-derived from the *filtered* ranking (a plan can become
 * stop-worthy when its best action's claim just got falsified).
 */
export function reconcileWithBeliefs(
  currentBeliefs: readonly ClaimBelief[],
  previousBeliefs: readonly ClaimBelief[] | undefined,
  plan: EigPlan,
  options: ReconciledPlanOptions = {},
): ReconciledPlan {
  const previousByClaim = new Map(previousBeliefs?.map((belief) => [belief.claimId, belief]) ?? []);
  const currentByClaim = new Map(currentBeliefs.map((belief) => [belief.claimId, belief]));

  const revisions: BeliefRevisionEvent[] = [];
  let backtracking = false;
  for (const current of currentBeliefs) {
    const previous = previousByClaim.get(current.claimId);
    if (!previous || previous.status === current.status) continue;
    const downgrade = isDowngrade(previous.status, current.status);
    revisions.push({
      claimId: current.claimId,
      from: previous.status,
      to: current.status,
      reason: downgrade
        ? `Evidence or supersession moved "${current.claimId}" from ${previous.status} to ${current.status}.`
        : `Evidence restored "${current.claimId}" from ${previous.status} to ${current.status}.`,
    });
    if (downgrade) backtracking = true;
  }
  // Claims that disappeared from the graph are a revision too (removed).
  for (const previous of previousBeliefs ?? []) {
    if (!currentByClaim.has(previous.claimId)) {
      revisions.push({
        claimId: previous.claimId,
        from: previous.status,
        to: "removed",
        reason: `Claim "${previous.claimId}" was removed from the graph.`,
      });
      if (previous.status === "active" || previous.status === "challenged") {
        backtracking = true;
      }
    }
  }

  // Drop actions that target claims which are no longer active.
  const activeClaimIds = new Set(
    currentBeliefs.filter((belief) => belief.status === "active").map((belief) => belief.claimId),
  );
  const ranked = plan.ranked.filter((estimate) => {
    const claimId = estimate.action.claimId;
    if (claimId === undefined) return true; // principle_revision / stop
    return activeClaimIds.has(claimId);
  });

  // Re-derive the stop decision from the filtered ranking so the plan is
  // internally consistent (a falsified top action can make the plan stop).
  const stopScoreThreshold = options.stopScoreThreshold ?? DEFAULT_RECONCILE_STOP_THRESHOLD;
  const topScore = ranked[0]?.score ?? 0;
  const shouldStop = ranked.length === 0 || topScore < stopScoreThreshold || plan.shouldStop;
  const stopReason = ranked.length === 0
    ? "All planned actions target claims that are no longer active."
    : topScore < stopScoreThreshold
      ? `Best remaining action score ${topScore.toFixed(4)} is below the stop threshold ${stopScoreThreshold}; ` +
        "no evidence-gathering action is worth its cost."
      : plan.stopReason;
  const reconciled: EigPlan = Object.freeze({
    ...plan,
    ranked: Object.freeze(ranked),
    shouldStop,
    stopReason,
  });

  const top = reconciled.ranked[0];
  return Object.freeze({
    plan: reconciled,
    revisions: Object.freeze(revisions),
    backtracking,
    nextActionType: top?.action.type,
    nextActionClaimId: top?.action.claimId,
  });
}

export const DEFAULT_RECONCILE_STOP_THRESHOLD = 0.005;

function isDowngrade(from: ClaimBelief["status"] | "removed", to: ClaimBelief["status"] | "removed"): boolean {
  if (from === "superseded" || from === "falsified" || from === "removed") return false;
  return to === "superseded" || to === "falsified" || to === "removed" || (from === "active" && to === "challenged");
}
