import type {
  Claim,
  ClaimBelief,
  ClaimStatus,
  EvidenceContribution,
  EvidenceStrength,
} from "./types.js";

/**
 * Belief propagation over the claim graph.
 *
 * The update rule is deliberately simple, monotone, bounded, and
 * interpretable — the platform's taste-calibration loop (Phase 1.4) learns
 * better strength weights over time, so the propagator itself stays a pure
 * function of (claim, contributions, weights).
 *
 *   support   = Σ w(supports)
 *   challenge = Σ w(challenges)
 *   delta     = support - challenge
 *   confidence' = 0.5 + 0.5 · delta / (1 + |delta|)     (saturating, ∈ [0,1])
 *   uncertainty' = clamp01(1 - 0.15 · (support + challenge))
 *
 * The saturating transform keeps confidence from hitting 1.0 at trivially
 * small evidence (three replications land at ~0.77), and uncertainty decays
 * monotonically toward 0 as evidence accumulates — so a settled claim is
 * both confident and certain, and the EIG planner's stop signal is actually
 * reachable.
 *
 * Status transitions (thresholds are independent, not coupled through the
 * linear update):
 *   - challenges ≥ challengeStatusThreshold && challenge > support → challenged
 *   - challenges ≥ falsificationChallengeWeight && challenge > support → falsified
 * (`superseded` is set by graph operations, not by evidence.)
 */

export const EVIDENCE_STRENGTH_WEIGHTS: Readonly<Record<EvidenceStrength, number>> = {
  replicated_result: 0.4,
  observed_result: 0.25,
  baseline_observation: 0.2,
  review_consensus: 0.3,
  citation: 0.1,
};

export const DEFAULT_CHALLENGE_STATUS_THRESHOLD = 0.5;
/** Independent falsification bar: weighted challenges ≥ this value. */
export const DEFAULT_FALSIFICATION_CHALLENGE_WEIGHT = 1.0;
export const UNCERTAINTY_DECAY_PER_EVIDENCE = 0.15;

/** Map artifact kinds to the epistemic strength they confer on a claim. */
export function strengthFromArtifactKind(kind: string): EvidenceStrength {
  switch (kind) {
    case "run_attempt":
    case "metric_observation":
      return "observed_result";
    case "baseline_observation":
      return "baseline_observation";
    case "finding":
    case "review_round":
      return "review_consensus";
    case "evidence_pack":
    case "citation_set":
      return "citation";
    default:
      return "observed_result";
  }
}

export function evidenceWeight(contribution: EvidenceContribution): number {
  const weight = EVIDENCE_STRENGTH_WEIGHTS[contribution.strength];
  if (weight === undefined) {
    // Defensive: unknown strengths must not silently count as weak evidence
    // for or against a claim. Callers control strength via
    // strengthFromArtifactKind; anything else is a programming error.
    throw new TypeError(`Unknown evidence strength: ${contribution.strength}.`);
  }
  return weight;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export type BeliefComputationOptions = {
  challengeStatusThreshold?: number;
  falsificationChallengeWeight?: number;
};

export function computeBelief(
  claim: Claim,
  contributions: readonly EvidenceContribution[],
  options: BeliefComputationOptions = {},
): ClaimBelief {
  const challengeStatusThreshold = options.challengeStatusThreshold ?? DEFAULT_CHALLENGE_STATUS_THRESHOLD;
  const falsificationChallengeWeight = options.falsificationChallengeWeight ?? DEFAULT_FALSIFICATION_CHALLENGE_WEIGHT;

  let supportsWeight = 0;
  let challengesWeight = 0;
  for (const contribution of contributions) {
    // Only the two epistemic relations count; anything else is a caller
    // error and must not silently act as evidence for or against a claim.
    if (contribution.relation !== "supports" && contribution.relation !== "challenges") {
      continue;
    }
    const weight = evidenceWeight(contribution);
    if (contribution.relation === "supports") {
      supportsWeight += weight;
    } else {
      challengesWeight += weight;
    }
  }

  const delta = supportsWeight - challengesWeight;
  // Saturating transform: confidence ∈ [0,1], monotone in delta, and does
  // not saturate until |delta| is large (delta=1 → 0.75, delta=8 → 0.94).
  const priorConfidence = 0.5;
  const confidence = clamp01(priorConfidence + 0.5 * (delta / (1 + Math.abs(delta))));

  const evidenceTotal = supportsWeight + challengesWeight;
  // Uncertainty decays monotonically with accumulated evidence weight and
  // approaches 0 as evidence grows (20 replications → 1 - 0.15·8 → 0).
  const uncertainty = clamp01(1 - UNCERTAINTY_DECAY_PER_EVIDENCE * evidenceTotal);

  const challenged = challengesWeight >= challengeStatusThreshold && challengesWeight > supportsWeight;
  let status: ClaimStatus;
  if (challenged && challengesWeight >= falsificationChallengeWeight) {
    status = "falsified";
  } else if (challenged) {
    status = "challenged";
  } else {
    status = "active";
  }

  return Object.freeze({
    claimId: claim.claimId,
    status,
    confidence,
    uncertainty,
    supportsWeight,
    challengesWeight,
    evidenceCount: contributions.length,
    computedAt: new Date().toISOString(),
  });
}

/**
 * Harvest evidence contributions from an artifact list: every artifact whose
 * parents reference a claim artifact (kind "claim") with relation
 * `supports` / `challenges` contributes to that claim.
 *
 * Correctness rules enforced here:
 * - **revision dedup**: when an artifact appears multiple times, only its
 *   latest revision contributes (retracted/reworked evidence is not
 *   double-counted);
 * - **status filter**: artifacts whose status is not "active" (stale,
 *   superseded, rejected, archived) never contribute;
 * - **relation validation**: anything other than "supports"/"challenges" is
 *   skipped, never counted as a challenge.
 */
export function aggregateContributions(
  artifacts: readonly {
    artifactId: string;
    revision: number;
    kind: string;
    status?: string;
    parents?: readonly { relation: string; artifact: { artifactId: string; kind: string } }[];
    updatedAt?: string;
  }[],
  claimIds: ReadonlySet<string>,
  nowIso?: string,
): Map<string, EvidenceContribution[]> {
  const contributions = new Map<string, EvidenceContribution[]>();
  const now = nowIso ?? new Date().toISOString();

  // Keep only the latest revision of each artifact (by artifactId).
  const latestByArtifact = new Map<string, (typeof artifacts)[number]>();
  for (const artifact of artifacts) {
    const existing = latestByArtifact.get(artifact.artifactId);
    if (!existing || artifact.revision > existing.revision) {
      latestByArtifact.set(artifact.artifactId, artifact);
    }
  }

  for (const artifact of latestByArtifact.values()) {
    if (artifact.status !== undefined && artifact.status !== "active") {
      continue;
    }
    for (const parent of artifact.parents ?? []) {
      if (parent.artifact.kind !== "claim") continue;
      if (!claimIds.has(parent.artifact.artifactId)) continue;
      if (parent.relation !== "supports" && parent.relation !== "challenges") continue;
      const list = contributions.get(parent.artifact.artifactId) ?? [];
      list.push(
        Object.freeze({
          sourceArtifactId: artifact.artifactId,
          sourceKind: artifact.kind,
          relation: parent.relation as "supports" | "challenges",
          strength: strengthFromArtifactKind(artifact.kind),
          sourceRevision: artifact.revision,
          observedAt: now,
        }),
      );
      contributions.set(parent.artifact.artifactId, list);
    }
  }
  return contributions;
}

export function recomputeAllBeliefs(
  claims: readonly Claim[],
  contributionsByClaim: ReadonlyMap<string, readonly EvidenceContribution[]>,
  options?: BeliefComputationOptions,
): ClaimBelief[] {
  return claims.map((claim) =>
    computeBelief(claim, contributionsByClaim.get(claim.claimId) ?? [], options),
  );
}
