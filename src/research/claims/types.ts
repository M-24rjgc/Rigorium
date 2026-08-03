/**
 * Claim-graph domain types (Phase 1 — belief-driven orchestration).
 *
 * A research project's claims form a directed graph: claims may depend on
 * other claims, and evidence artifacts (run_attempt, evidence_pack, finding,
 * …) point at claims through the artifact DAG's `supports` / `challenges`
 * parent relations. The belief engine aggregates those contributions into a
 * per-claim belief (confidence + uncertainty + status), which the EIG planner
 * (src/research/director/eig) uses to choose the next research action.
 */

export type ClaimStatus = "active" | "challenged" | "falsified" | "superseded";

/** Epistemic strength of an evidence contribution, derived from artifact kind. */
export type EvidenceStrength =
  | "replicated_result"
  | "observed_result"
  | "baseline_observation"
  | "review_consensus"
  | "citation";

/** A claim as stated by the research process (persisted). */
export type Claim = Readonly<{
  claimId: string;
  /** Natural-language statement of the claim. */
  statement: string;
  /** Condition under which the claim would be considered falsified. */
  falsificationCondition?: string;
  /** Parent claims this claim depends on (derivation edges). */
  parentClaimIds?: readonly string[];
  /** Artifact id that originally introduced the claim (provenance). */
  sourceArtifactId?: string;
  createdAt: string;
}>;

/** A single evidence contribution harvested from the artifact DAG. */
export type EvidenceContribution = Readonly<{
  /** Artifact id carrying the evidence (run_attempt / finding / ...). */
  sourceArtifactId: string;
  sourceKind: string;
  relation: "supports" | "challenges";
  strength: EvidenceStrength;
  /** Revision of the evidence artifact at harvest time. */
  sourceRevision: number;
  observedAt: string;
}>;

/** Computed belief over a claim (not persisted — derived on demand). */
export type ClaimBelief = Readonly<{
  claimId: string;
  status: ClaimStatus;
  /** 0..1 posterior confidence after evidence aggregation. */
  confidence: number;
  /** 0..1 remaining uncertainty (1 = completely uncertain). */
  uncertainty: number;
  supportsWeight: number;
  challengesWeight: number;
  evidenceCount: number;
  computedAt: string;
}>;

/** Immutable snapshot of the whole belief system at a point in time. */
export type BeliefSnapshot = Readonly<{
  computedAt: string;
  beliefs: readonly ClaimBelief[];
}>;
