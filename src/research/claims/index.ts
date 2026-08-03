export { ClaimGraph } from "./ClaimGraph.js";
export {
  DEFAULT_CHALLENGE_STATUS_THRESHOLD,
  DEFAULT_FALSIFICATION_CHALLENGE_WEIGHT,
  EVIDENCE_STRENGTH_WEIGHTS,
  UNCERTAINTY_DECAY_PER_EVIDENCE,
  aggregateContributions,
  clamp01,
  computeBelief,
  evidenceWeight,
  recomputeAllBeliefs,
  strengthFromArtifactKind,
} from "./beliefPropagation.js";
export { TasteCalibrator, type TasteCalibrationState } from "./taste.js";
export type {
  BeliefSnapshot,
  Claim,
  ClaimBelief,
  ClaimStatus,
  EvidenceContribution,
  EvidenceStrength,
} from "./types.js";
