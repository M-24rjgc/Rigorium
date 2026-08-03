import type { ClaimBelief } from "../../claims/types.js";

/**
 * Research action space for the information-gain planner.
 *
 * Each action type targets a claim (or the principle space) and carries an
 * estimated epistemic gain and an execution cost. The planner ranks
 * (claim, action) pairs by expected information gain per unit cost — the
 * belief-driven alternative to fixed pipelines.
 */
export type ResearchActionType =
  | "run_experiment"
  | "literature_search"
  | "review"
  | "write_section"
  | "figure_generation"
  | "principle_revision"
  | "stop";

export type EigActionInput = {
  type: ResearchActionType;
  /** Claim the action targets; absent for principle_revision / stop. */
  claimId?: string;
  /** Persisted artifact kinds the action would produce (for cost modeling). */
  producesKinds?: readonly string[];
};

export type EigEstimate = Readonly<{
  action: EigActionInput;
  /** Expected uncertainty reduction (0..1) on the target claim. */
  expectedInformationGain: number;
  /** Estimated execution cost in director cost units. */
  costUnits: number;
  /** Gain per unit cost — the planner's ranking key. */
  score: number;
  rationale: string;
}>;

export type EigPlan = Readonly<{
  computedAt: string;
  /** Actions ranked by score, descending. */
  ranked: readonly EigEstimate[];
  /** True when no action clears the minimum gain-per-cost bar. */
  shouldStop: boolean;
  stopReason?: string;
}>;

export type EigPlannerOptions = {
  /** Below this score the planner recommends stopping. */
  stopScoreThreshold?: number;
  /** Cap on how many actions a single plan may propose. */
  maxActions?: number;
  /**
   * A claim gets at most one action per plan (batch de-duplication);
   * different claims are independent and may run in parallel.
   */
  maxActionsPerClaim?: number;
};

export type EigPlannerDeps = {
  /**
   * Per-action-type cost overrides (in director cost units). Falls back to
   * DEFAULT_ACTION_COSTS.
   */
  actionCosts?: Partial<Record<ResearchActionType, number>>;
  /**
   * Optional cost model from the token stats collector: maps artifact kinds
   * to observed cost units. Merged additively into the action base cost.
   */
  artifactCostModel?: ReadonlyMap<string, number>;
};
