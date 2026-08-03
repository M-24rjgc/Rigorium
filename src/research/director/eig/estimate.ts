import type { ClaimBelief } from "../../claims/types.js";
import type {
  EigActionInput,
  EigEstimate,
  EigPlannerDeps,
  ResearchActionType,
} from "./types.js";

/**
 * Default epistemic gain factors per action type: how much of the target
 * claim's remaining uncertainty an action is expected to resolve.
 *
 * These are prior estimates; the taste-calibration loop (Phase 1.4) may
 * learn empirical factors from completed actions over time.
 */
export const DEFAULT_GAIN_FACTORS: Readonly<Record<ResearchActionType, number>> = {
  run_experiment: 0.7,
  literature_search: 0.35,
  review: 0.4,
  write_section: 0,
  figure_generation: 0.1,
  principle_revision: 0.5,
  stop: 0,
};

/** Default execution costs in director cost units (calibrated heuristics). */
export const DEFAULT_ACTION_COSTS: Readonly<Record<ResearchActionType, number>> = {
  run_experiment: 10,
  literature_search: 2,
  review: 3,
  write_section: 4,
  figure_generation: 3,
  principle_revision: 8,
  stop: 0,
};

export type EigEstimateOptions = {
  /** Gain factors override (per action type). */
  gainFactors?: Partial<Record<ResearchActionType, number>>;
  /**
   * Aggregate remaining uncertainty across the active claim space (0..1).
   * Principle revision scales its gain by this value, so it is only
   * attractive when the research as a whole is genuinely unsettled.
   */
  aggregateUncertainty?: number;
};

/**
 * Estimate the expected information gain of executing `action` against
 * `claim`:
 *
 *   EIG = uncertainty × gainFactor(action) × maturityDiscount(claim)
 *
 * where maturityDiscount dampens actions on claims that already have plenty
 * of evidence (diminishing returns — another experiment on a settled claim
 * adds little). `write_section` deliberately carries zero EIG: writing does
 * not resolve uncertainty, it consumes it; the director only schedules it
 * once the claim's evidence maturity allows (see manuscript gating).
 */
export function estimateEig(
  action: EigActionInput,
  claim: ClaimBelief | undefined,
  deps: EigPlannerDeps = {},
  options: EigEstimateOptions = {},
): EigEstimate {
  const gainFactor = finiteOr(
    options.gainFactors?.[action.type],
    DEFAULT_GAIN_FACTORS[action.type] ?? 0,
  );
  const baseCost = deps.actionCosts?.[action.type] ?? DEFAULT_ACTION_COSTS[action.type] ?? 4;

  let expectedInformationGain: number;
  let rationale: string;
  if (action.type === "principle_revision") {
    // Principle revision acts on the whole principle space: its gain is the
    // aggregate remaining uncertainty across all active claims, so it is
    // only attractive when the research as a whole is unsettled.
    const aggregate = finiteOr(options.aggregateUncertainty, 0);
    expectedInformationGain = finiteOr(gainFactor, 0) * aggregate;
    rationale = `Principle revision: aggregate uncertainty ${aggregate.toFixed(2)} × factor ${gainFactor}`;
  } else if (!claim) {
    expectedInformationGain = 0;
    rationale = `No target claim for ${action.type}; gain is zero.`;
  } else if (action.type === "write_section") {
    expectedInformationGain = 0;
    rationale = "Writing consumes evidence maturity; it does not resolve uncertainty.";
  } else {
    const uncertainty = claim.uncertainty;
    const maturityDiscount = Math.max(0.25, 1 - claim.evidenceCount * 0.05);
    expectedInformationGain = uncertainty * gainFactor * maturityDiscount;
    rationale = `${action.type} on "${claim.claimId}": uncertainty ${uncertainty.toFixed(2)} × factor ${gainFactor} × maturity ${maturityDiscount.toFixed(2)}`;
  }

  // Artifact-cost model: observed cost of the kinds this action produces.
  // Non-finite values are treated as zero so a bad cost entry can never
  // poison the score with NaN.
  const artifactCost = (action.producesKinds ?? []).reduce(
    (sum, kind) => sum + finiteOr(deps.artifactCostModel?.get(kind), 0),
    0,
  );
  const costUnits = Math.max(0.5, finiteOr(baseCost, 4) + artifactCost);
  const score = finiteOr(expectedInformationGain, 0) / costUnits;

  return Object.freeze({
    action: Object.freeze({ ...action }),
    expectedInformationGain,
    costUnits,
    score,
    rationale,
  });
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
