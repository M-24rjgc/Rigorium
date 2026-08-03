export * from "./planner.js";
export * from "./records.js";
export * from "./types.js";
// Phase 4: the production belief-driven orchestration loop (claim graph →
// EIG plan → anomaly boost → reconcile → venue/style context). Exported so
// tools (research_plan) and hosts can drive the loop without reaching into
// private paths.
export {
  ResearchOrchestrator,
  defaultArtifactLoader,
  type OrchestratedAction,
  type OrchestrationPlan,
  type OrchestratorOptions,
} from "./ResearchOrchestrator.js";
export {
  DEFAULT_ACTION_COSTS,
  DEFAULT_GAIN_FACTORS,
  estimateEig,
  type EigEstimateOptions,
} from "./eig/estimate.js";
export {
  DEFAULT_MAX_ACTIONS,
  DEFAULT_MAX_ACTIONS_PER_CLAIM,
  DEFAULT_STOP_SCORE_THRESHOLD,
  planByInformationGain,
} from "./eig/planner.js";
export { detectAnomaly, applyAnomalyBoost } from "./eig/anomalyDetector.js";
export { reconcileWithBeliefs, type BeliefRevisionEvent } from "./eig/reconcile.js";
export type { EigActionInput, EigPlan, EigPlannerDeps, EigPlannerOptions, ResearchActionType } from "./eig/types.js";
