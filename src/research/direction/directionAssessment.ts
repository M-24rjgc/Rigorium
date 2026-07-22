/**
 * Bounded, side-effect-free assessment of research directions. This module
 * deliberately has no dependency on projects, persistence, tools, or UI.
 */

export const DIRECTION_ASSESSMENT_LIMITS = {
  maxCandidates: 24,
  maxEvidence: 320,
  maxConstraints: 64,
  maxTargetConferences: 16,
  maxEvidencePerCandidate: 48,
  maxConstraintsPerCandidate: 16,
  maxTargetConferencesPerCandidate: 8,
  maxCaveatsPerCandidate: 12,
  maxHypothesesPerCandidate: 8,
  maxEvidencePerCaveat: 12,
  maxEvidencePerHypothesis: 16,
  maxBaselinesPerHypothesis: 8,
  maxOutputGapsPerCandidate: 16,
  maxOutputConclusionsPerCandidate: 24,
  maxTextLength: 1_000,
  maxTitleLength: 180,
  maxIdentifierLength: 180,
} as const;

export type DirectionEvidenceRole =
  | "prior_art"
  | "gap"
  | "method"
  | "result"
  | "limitation"
  | "data"
  | "baseline"
  | "evaluation"
  | "ethics"
  | "venue";

export type DirectionEvidenceStrength = "direct" | "indirect";

/** One paper-grounded observation selected by the agent. */
export type DirectionEvidence = {
  id: string;
  paperId: string;
  role: DirectionEvidenceRole;
  statement: string;
  strength?: DirectionEvidenceStrength;
};

export type DirectionConstraintKind =
  | "venue"
  | "time"
  | "data"
  | "compute"
  | "ethics"
  | "baseline"
  | "evaluation";

export type DirectionConstraintStatus = "satisfied" | "unknown" | "blocked";

/**
 * A feasibility input. It may be grounded in local facts rather than a paper,
 * so its trace also carries the constraint ID when no paper evidence exists.
 */
export type DirectionConstraint = {
  id: string;
  kind: DirectionConstraintKind;
  label: string;
  status: DirectionConstraintStatus;
  required?: boolean;
  evidenceIds?: readonly string[];
};

export type DirectionTargetConference = {
  id: string;
  name: string;
  deadline?: string;
  status: DirectionConstraintStatus;
  evidenceIds?: readonly string[];
};

export type DirectionCaveatSeverity = "low" | "medium" | "high";

/** A contradiction or limitation supplied for one candidate direction. */
export type DirectionCaveat = {
  id: string;
  summary: string;
  severity: DirectionCaveatSeverity;
  evidenceIds?: readonly string[];
};

/**
 * A hypothesis is only reported as ready when it has cited evidence, a
 * falsifier, an evaluable condition, and a usable baseline condition.
 */
export type DirectionHypothesisDraft = {
  id: string;
  statement: string;
  failureCriterion?: string;
  evidenceIds?: readonly string[];
  evaluationConstraintId?: string;
  baselineConstraintIds?: readonly string[];
};

export type CandidateResearchDirection = {
  id: string;
  summary: string;
  titleSeed?: string;
  evidenceIds?: readonly string[];
  caveats?: readonly DirectionCaveat[];
  hypotheses?: readonly DirectionHypothesisDraft[];
  constraintIds?: readonly string[];
  targetConferenceIds?: readonly string[];
};

/**
 * The agent may supply any subset appropriate to the research domain. This is
 * an assessment snapshot, not a workflow stage or a persisted state machine.
 */
export type DirectionAssessmentInput = {
  candidates: readonly CandidateResearchDirection[];
  evidence?: readonly DirectionEvidence[];
  constraints?: readonly DirectionConstraint[];
  targetConferences?: readonly DirectionTargetConference[];
};

/** Every derived item exposes the exact records used to derive it. */
export type DirectionTrace = {
  evidenceIds: string[];
  paperIds: string[];
  constraintIds: string[];
};

export type DirectionEvidenceGapCode =
  | "literature_evidence_missing"
  | "direct_evidence_missing"
  | "gap_evidence_missing"
  | "caveat_evidence_missing"
  | "hypothesis_evidence_missing"
  | "failure_criterion_missing"
  | "evaluation_constraint_missing"
  | "baseline_constraint_missing"
  | "constraint_unverified"
  | "constraint_blocked"
  | "conference_unverified"
  | "conference_blocked";

export type DirectionEvidenceGap = DirectionTrace & {
  code: DirectionEvidenceGapCode;
  severity: "required" | "advisory";
  hypothesisId?: string;
  caveatId?: string;
  relatedId?: string;
};

export type DirectionConclusionCode =
  | "literature_support"
  | "candidate_gap_evidenced"
  | "novelty_not_established"
  | "caveat_cited"
  | "constraint_satisfied"
  | "constraint_unverified"
  | "constraint_blocked"
  | "conference_satisfied"
  | "conference_unverified"
  | "conference_blocked"
  | "hypothesis_ready"
  | "hypothesis_needs_evidence"
  | "hypothesis_needs_design"
  | "hypothesis_blocked";

export type DirectionAssessmentConclusion = DirectionTrace & {
  code: DirectionConclusionCode;
  status: "supported" | "unproven" | "blocked";
  relatedId?: string;
};

export type AssessedDirectionCaveat = DirectionTrace & {
  id: string;
  summary: string;
  severity: DirectionCaveatSeverity;
  status: "cited" | "needs_evidence";
};

export type FalsifiableHypothesisStatus = "ready" | "needs_evidence" | "needs_design" | "blocked";

export type AssessedFalsifiableHypothesis = DirectionTrace & {
  id: string;
  statement: string;
  failureCriterion?: string;
  status: FalsifiableHypothesisStatus;
};

/** This status intentionally never labels a direction itself as novel. */
export type DirectionNoveltyAssessment = DirectionTrace & {
  status: "gap_evidenced" | "not_established";
};

export type DirectionMinimumViability = {
  status: "viable" | "needs_evidence" | "blocked";
  reasons: DirectionAssessmentConclusion[];
};

export type DirectionAssessmentScore = DirectionTrace & {
  total: number;
  evidence: number;
  feasibility: number;
  testability: number;
  gapOpportunity: number;
  caveatPenalty: number;
  blockerPenalty: number;
};

/** A returned title is always explicitly provisional; rejected titles have no text. */
export type ProvisionalDirectionTitle = DirectionTrace & {
  status: "accepted" | "downgraded" | "rejected";
  text?: string;
  reasonCodes: Array<"provisional" | "overcommitting_claim">;
};

export type AssessedTargetConference = DirectionTrace & {
  id: string;
  name: string;
  deadline?: string;
  status: DirectionConstraintStatus;
};

export type DirectionAssessment = {
  rank: number;
  directionId: string;
  summary: string;
  score: DirectionAssessmentScore;
  novelty: DirectionNoveltyAssessment;
  caveats: AssessedDirectionCaveat[];
  falsifiableHypotheses: AssessedFalsifiableHypothesis[];
  targetConferences: AssessedTargetConference[];
  unmetEvidenceGaps: DirectionEvidenceGap[];
  minimumViability: DirectionMinimumViability;
  provisionalTitle: ProvisionalDirectionTitle;
  conclusions: DirectionAssessmentConclusion[];
};

export type DirectionAssessmentResult = {
  limits: typeof DIRECTION_ASSESSMENT_LIMITS;
  rankedDirectionIds: string[];
  assessments: DirectionAssessment[];
};

type ValidatedInput = {
  candidates: readonly CandidateResearchDirection[];
  evidenceById: Map<string, DirectionEvidence>;
  constraintsById: Map<string, DirectionConstraint>;
  conferencesById: Map<string, DirectionTargetConference>;
};

const EVIDENCE_ROLES = new Set<DirectionEvidenceRole>([
  "prior_art",
  "gap",
  "method",
  "result",
  "limitation",
  "data",
  "baseline",
  "evaluation",
  "ethics",
  "venue",
]);
const CONSTRAINT_KINDS = new Set<DirectionConstraintKind>([
  "venue",
  "time",
  "data",
  "compute",
  "ethics",
  "baseline",
  "evaluation",
]);
const CONSTRAINT_STATUSES = new Set<DirectionConstraintStatus>(["satisfied", "unknown", "blocked"]);
const CAVEAT_SEVERITIES = new Set<DirectionCaveatSeverity>(["low", "medium", "high"]);
const OVERCOMMITTING_TITLE_PATTERN = /\b(?:first|novel|unprecedented|state[-\s]?of[-\s]?the[-\s]?art|sota|breakthrough|definitive|proven|guarantee(?:d)?|universal(?:ly)?|best|superior|outperform(?:s|ing|ed)?|solve(?:s|d|ing)?)\b|\u9996\u4e2a|\u9996\u6b21|\u7a81\u7834|\u6700\u4f18|\u9886\u5148|\u65b0\u9896/iu;
const TITLE_PREFIX = "Provisional: ";

/**
 * Assess independently supplied candidate directions without mutating their
 * inputs. Ranking is deterministic: total score descending, direction ID
 * ascending for equal scores.
 */
export function assessResearchDirections(input: DirectionAssessmentInput): DirectionAssessmentResult {
  const validated = validateInput(input);
  const assessed = validated.candidates.map((candidate) => assessCandidate(candidate, validated));
  assessed.sort((left, right) => right.score.total - left.score.total || compareText(left.directionId, right.directionId));

  const assessments = assessed.map((assessment, index) => ({ ...assessment, rank: index + 1 }));
  return {
    limits: { ...DIRECTION_ASSESSMENT_LIMITS },
    rankedDirectionIds: assessments.map((assessment) => assessment.directionId),
    assessments,
  };
}

/** Clear alias for callers that describe the inputs as candidate directions. */
export const assessDirectionCandidates = assessResearchDirections;

function assessCandidate(candidate: CandidateResearchDirection, input: ValidatedInput): DirectionAssessment {
  const candidateEvidenceIds = referenceIds(
    candidate.evidenceIds,
    "candidate evidence IDs",
    DIRECTION_ASSESSMENT_LIMITS.maxEvidencePerCandidate,
    input.evidenceById,
  );
  const caveats = arrayValue(candidate.caveats, "candidate caveats");
  const hypotheses = arrayValue(candidate.hypotheses, "candidate hypotheses");
  const candidateConstraintIds = referenceIds(
    candidate.constraintIds,
    "candidate constraint IDs",
    DIRECTION_ASSESSMENT_LIMITS.maxConstraintsPerCandidate,
    input.constraintsById,
  );
  const conferenceIds = referenceIds(
    candidate.targetConferenceIds,
    "candidate target conference IDs",
    DIRECTION_ASSESSMENT_LIMITS.maxTargetConferencesPerCandidate,
    input.conferencesById,
  );

  const assessedCaveats = caveats
    .map((caveat) => assessCaveat(caveat, input))
    .sort((left, right) => compareText(left.id, right.id));
  const assessedHypotheses = hypotheses
    .map((hypothesis) => assessHypothesis(hypothesis, input))
    .sort((left, right) => compareText(left.id, right.id));
  const hypothesisConstraintIds = assessedHypotheses.flatMap((hypothesis) => hypothesis.constraintIds);
  const constraintIds = sortedUnique([...candidateConstraintIds, ...hypothesisConstraintIds]);
  const constraints = constraintIds.map((id) => input.constraintsById.get(id)!);
  const targetConferences = conferenceIds.map((id) => assessConference(input.conferencesById.get(id)!, input));

  const hypothesisEvidenceIds = assessedHypotheses.flatMap((hypothesis) => hypothesis.evidenceIds);
  const supportEvidenceIds = sortedUnique([...candidateEvidenceIds, ...hypothesisEvidenceIds]);
  const supportEvidence = supportEvidenceIds.map((id) => input.evidenceById.get(id)!);
  const directEvidenceIds = supportEvidence
    .filter((evidence) => (evidence.strength ?? "direct") === "direct")
    .map((evidence) => evidence.id);
  const indirectEvidenceIds = supportEvidence
    .filter((evidence) => (evidence.strength ?? "direct") === "indirect")
    .map((evidence) => evidence.id);
  const directGapEvidenceIds = supportEvidence
    .filter((evidence) => evidence.role === "gap" && (evidence.strength ?? "direct") === "direct")
    .map((evidence) => evidence.id);
  const indirectGapEvidenceIds = supportEvidence
    .filter((evidence) => evidence.role === "gap" && (evidence.strength ?? "direct") === "indirect")
    .map((evidence) => evidence.id);

  const caveatEvidenceIds = assessedCaveats.flatMap((caveat) => caveat.evidenceIds);
  const constraintEvidenceIds = constraints.flatMap((constraint) =>
    referenceIds(constraint.evidenceIds, `constraint ${constraint.id} evidence IDs`, DIRECTION_ASSESSMENT_LIMITS.maxEvidencePerCaveat, input.evidenceById),
  );
  const conferenceEvidenceIds = targetConferences.flatMap((conference) => conference.evidenceIds);
  const allEvidenceIds = sortedUnique([
    ...supportEvidenceIds,
    ...caveatEvidenceIds,
    ...constraintEvidenceIds,
    ...conferenceEvidenceIds,
  ]);

  const conclusions = buildConclusions({
    supportEvidenceIds,
    directGapEvidenceIds,
    assessedCaveats,
    constraints,
    targetConferences,
    assessedHypotheses,
    evidenceById: input.evidenceById,
  });
  const gaps = buildGaps({
    supportEvidenceIds,
    directEvidenceIds,
    directGapEvidenceIds,
    indirectGapEvidenceIds,
    assessedCaveats,
    constraints,
    targetConferences,
    assessedHypotheses,
    evidenceById: input.evidenceById,
  });

  const requiredBlocked = constraints.some((constraint) => constraint.status === "blocked" && constraint.required !== false)
    || targetConferences.some((conference) => conference.status === "blocked");
  const requiredUnknown = constraints.some((constraint) => constraint.status === "unknown" && constraint.required !== false)
    || targetConferences.some((conference) => conference.status === "unknown");
  const readyHypotheses = assessedHypotheses.filter((hypothesis) => hypothesis.status === "ready");
  const needsCoreEvidence = supportEvidenceIds.length === 0 || directEvidenceIds.length === 0 || readyHypotheses.length === 0;
  const viabilityStatus: DirectionMinimumViability["status"] = requiredBlocked
    ? "blocked"
    : requiredUnknown || needsCoreEvidence
      ? "needs_evidence"
      : "viable";
  const viabilityReasons = selectViabilityReasons(conclusions, viabilityStatus);

  const evidenceScore = Math.min(40, directEvidenceIds.length * 12 + indirectEvidenceIds.length * 4);
  const feasibilityConditions = [
    ...constraints.filter((constraint) => constraint.required !== false),
    ...targetConferences,
  ];
  const satisfiedConditions = feasibilityConditions.filter((condition) => condition.status === "satisfied").length;
  const feasibilityScore = feasibilityConditions.length === 0
    ? 0
    : Math.floor((30 * satisfiedConditions) / feasibilityConditions.length);
  const testabilityScore = Math.min(20, readyHypotheses.length * 20);
  const gapOpportunityScore = directGapEvidenceIds.length > 0 ? 10 : indirectGapEvidenceIds.length > 0 ? 4 : 0;
  const caveatPenalty = Math.min(15, assessedCaveats
    .filter((caveat) => caveat.status === "cited")
    .reduce((total, caveat) => total + caveatPenaltyFor(caveat.severity), 0));
  const blockerPenalty = requiredBlocked ? 30 : 0;
  const totalScore = clamp(
    evidenceScore + feasibilityScore + testabilityScore + gapOpportunityScore - caveatPenalty - blockerPenalty,
    0,
    100,
  );
  const trace = traceFor(allEvidenceIds, constraintIds, input.evidenceById);

  return {
    rank: 0,
    directionId: candidate.id,
    summary: cleanText(candidate.summary, `candidate ${candidate.id} summary`, DIRECTION_ASSESSMENT_LIMITS.maxTextLength),
    score: {
      total: totalScore,
      evidence: evidenceScore,
      feasibility: feasibilityScore,
      testability: testabilityScore,
      gapOpportunity: gapOpportunityScore,
      caveatPenalty,
      blockerPenalty,
      ...trace,
    },
    novelty: directGapEvidenceIds.length > 0 || indirectGapEvidenceIds.length > 0
      ? { status: "gap_evidenced", ...traceFor([...directGapEvidenceIds, ...indirectGapEvidenceIds], [], input.evidenceById) }
      : { status: "not_established", ...traceFor(supportEvidenceIds, [], input.evidenceById) },
    caveats: assessedCaveats,
    falsifiableHypotheses: assessedHypotheses,
    targetConferences,
    unmetEvidenceGaps: gaps,
    minimumViability: { status: viabilityStatus, reasons: viabilityReasons },
    provisionalTitle: provisionalTitle(candidate, supportEvidenceIds, input.evidenceById),
    conclusions,
  };
}

function buildConclusions(input: {
  supportEvidenceIds: string[];
  directGapEvidenceIds: string[];
  assessedCaveats: AssessedDirectionCaveat[];
  constraints: DirectionConstraint[];
  targetConferences: AssessedTargetConference[];
  assessedHypotheses: AssessedFalsifiableHypothesis[];
  evidenceById: Map<string, DirectionEvidence>;
}): DirectionAssessmentConclusion[] {
  const conclusions: DirectionAssessmentConclusion[] = [];
  if (input.supportEvidenceIds.length > 0) {
    conclusions.push({
      code: "literature_support",
      status: "supported",
      ...traceFor(input.supportEvidenceIds, [], input.evidenceById),
    });
  }
  if (input.directGapEvidenceIds.length > 0) {
    conclusions.push({
      code: "candidate_gap_evidenced",
      status: "supported",
      ...traceFor(input.directGapEvidenceIds, [], input.evidenceById),
    });
  } else {
    conclusions.push({
      code: "novelty_not_established",
      status: "unproven",
      ...traceFor(input.supportEvidenceIds, [], input.evidenceById),
    });
  }
  for (const caveat of input.assessedCaveats) {
    if (caveat.status !== "cited") continue;
    conclusions.push({
      code: "caveat_cited",
      status: "supported",
      relatedId: caveat.id,
      evidenceIds: [...caveat.evidenceIds],
      paperIds: [...caveat.paperIds],
      constraintIds: [],
    });
  }
  for (const constraint of input.constraints) {
    const evidenceIds = referenceIds(
      constraint.evidenceIds,
      `constraint ${constraint.id} evidence IDs`,
      DIRECTION_ASSESSMENT_LIMITS.maxEvidencePerCaveat,
      input.evidenceById,
    );
    conclusions.push({
      code: constraint.status === "satisfied"
        ? "constraint_satisfied"
        : constraint.status === "blocked"
          ? "constraint_blocked"
          : "constraint_unverified",
      status: constraint.status === "satisfied" ? "supported" : constraint.status === "blocked" ? "blocked" : "unproven",
      relatedId: constraint.id,
      ...traceFor(evidenceIds, [constraint.id], input.evidenceById),
    });
  }
  for (const conference of input.targetConferences) {
    conclusions.push({
      code: conference.status === "satisfied"
        ? "conference_satisfied"
        : conference.status === "blocked"
          ? "conference_blocked"
          : "conference_unverified",
      status: conference.status === "satisfied" ? "supported" : conference.status === "blocked" ? "blocked" : "unproven",
      relatedId: conference.id,
      evidenceIds: [...conference.evidenceIds],
      paperIds: [...conference.paperIds],
      constraintIds: [],
    });
  }
  for (const hypothesis of input.assessedHypotheses) {
    conclusions.push({
      code: hypothesis.status === "ready"
        ? "hypothesis_ready"
        : hypothesis.status === "blocked"
          ? "hypothesis_blocked"
          : hypothesis.status === "needs_evidence"
            ? "hypothesis_needs_evidence"
            : "hypothesis_needs_design",
      status: hypothesis.status === "ready" ? "supported" : hypothesis.status === "blocked" ? "blocked" : "unproven",
      relatedId: hypothesis.id,
      evidenceIds: [...hypothesis.evidenceIds],
      paperIds: [...hypothesis.paperIds],
      constraintIds: [...hypothesis.constraintIds],
    });
  }
  return conclusions
    .sort(compareConclusion)
    .slice(0, DIRECTION_ASSESSMENT_LIMITS.maxOutputConclusionsPerCandidate);
}

function buildGaps(input: {
  supportEvidenceIds: string[];
  directEvidenceIds: string[];
  directGapEvidenceIds: string[];
  indirectGapEvidenceIds: string[];
  assessedCaveats: AssessedDirectionCaveat[];
  constraints: DirectionConstraint[];
  targetConferences: AssessedTargetConference[];
  assessedHypotheses: AssessedFalsifiableHypothesis[];
  evidenceById: Map<string, DirectionEvidence>;
}): DirectionEvidenceGap[] {
  const gaps: DirectionEvidenceGap[] = [];
  if (input.supportEvidenceIds.length === 0) {
    gaps.push(gap("literature_evidence_missing", "required", [], [], input.evidenceById));
  }
  if (input.directEvidenceIds.length === 0) {
    gaps.push(gap("direct_evidence_missing", "required", input.supportEvidenceIds, [], input.evidenceById));
  }
  if (input.directGapEvidenceIds.length === 0 && input.indirectGapEvidenceIds.length === 0) {
    gaps.push(gap("gap_evidence_missing", "advisory", input.supportEvidenceIds, [], input.evidenceById));
  }
  for (const caveat of input.assessedCaveats) {
    if (caveat.status === "needs_evidence") {
      gaps.push(gap("caveat_evidence_missing", "required", [], [], input.evidenceById, { caveatId: caveat.id }));
    }
  }
  for (const hypothesis of input.assessedHypotheses) {
    if (hypothesis.evidenceIds.length === 0) {
      gaps.push(gap("hypothesis_evidence_missing", "required", [], hypothesis.constraintIds, input.evidenceById, { hypothesisId: hypothesis.id }));
    }
    if (!hypothesis.failureCriterion) {
      gaps.push(gap("failure_criterion_missing", "required", hypothesis.evidenceIds, hypothesis.constraintIds, input.evidenceById, { hypothesisId: hypothesis.id }));
    }
    if (!hypothesis.constraintIds.some((id) => input.constraints.some((constraint) => constraint.id === id && constraint.kind === "evaluation"))) {
      gaps.push(gap("evaluation_constraint_missing", "required", hypothesis.evidenceIds, hypothesis.constraintIds, input.evidenceById, { hypothesisId: hypothesis.id }));
    }
    if (!hypothesis.constraintIds.some((id) => input.constraints.some((constraint) => constraint.id === id && constraint.kind === "baseline"))) {
      gaps.push(gap("baseline_constraint_missing", "required", hypothesis.evidenceIds, hypothesis.constraintIds, input.evidenceById, { hypothesisId: hypothesis.id }));
    }
  }
  for (const constraint of input.constraints) {
    if (constraint.required === false) continue;
    if (constraint.status === "unknown") {
      gaps.push(gap("constraint_unverified", "required", [], [constraint.id], input.evidenceById, { relatedId: constraint.id }));
    }
    if (constraint.status === "blocked") {
      gaps.push(gap("constraint_blocked", "required", [], [constraint.id], input.evidenceById, { relatedId: constraint.id }));
    }
  }
  for (const conference of input.targetConferences) {
    if (conference.status === "unknown") {
      gaps.push(gap("conference_unverified", "required", conference.evidenceIds, [], input.evidenceById, { relatedId: conference.id }));
    }
    if (conference.status === "blocked") {
      gaps.push(gap("conference_blocked", "required", conference.evidenceIds, [], input.evidenceById, { relatedId: conference.id }));
    }
  }
  return gaps
    .sort(compareGap)
    .slice(0, DIRECTION_ASSESSMENT_LIMITS.maxOutputGapsPerCandidate);
}

function assessCaveat(caveat: DirectionCaveat, input: ValidatedInput): AssessedDirectionCaveat {
  const evidenceIds = referenceIds(
    caveat.evidenceIds,
    `caveat ${caveat.id} evidence IDs`,
    DIRECTION_ASSESSMENT_LIMITS.maxEvidencePerCaveat,
    input.evidenceById,
  );
  return {
    id: caveat.id,
    summary: cleanText(caveat.summary, `caveat ${caveat.id} summary`, DIRECTION_ASSESSMENT_LIMITS.maxTextLength),
    severity: caveat.severity,
    status: evidenceIds.length > 0 ? "cited" : "needs_evidence",
    ...traceFor(evidenceIds, [], input.evidenceById),
  };
}

function assessHypothesis(hypothesis: DirectionHypothesisDraft, input: ValidatedInput): AssessedFalsifiableHypothesis {
  const evidenceIds = referenceIds(
    hypothesis.evidenceIds,
    `hypothesis ${hypothesis.id} evidence IDs`,
    DIRECTION_ASSESSMENT_LIMITS.maxEvidencePerHypothesis,
    input.evidenceById,
  );
  const baselineConstraintIds = referenceIds(
    hypothesis.baselineConstraintIds,
    `hypothesis ${hypothesis.id} baseline constraint IDs`,
    DIRECTION_ASSESSMENT_LIMITS.maxBaselinesPerHypothesis,
    input.constraintsById,
  );
  const evaluationConstraintId = optionalReferenceId(
    hypothesis.evaluationConstraintId,
    `hypothesis ${hypothesis.id} evaluation constraint ID`,
    input.constraintsById,
  );
  const constraintIds = sortedUnique([
    ...baselineConstraintIds,
    ...(evaluationConstraintId ? [evaluationConstraintId] : []),
  ]);
  const associatedConstraints = constraintIds.map((id) => input.constraintsById.get(id)!);
  const hasEvaluation = evaluationConstraintId !== undefined
    && input.constraintsById.get(evaluationConstraintId)?.kind === "evaluation";
  const hasBaseline = baselineConstraintIds.some((id) => input.constraintsById.get(id)?.kind === "baseline");
  const blocked = associatedConstraints.some((constraint) => constraint.status === "blocked");
  const needsEvidence = evidenceIds.length === 0;
  const needsDesign = !cleanOptionalText(hypothesis.failureCriterion, DIRECTION_ASSESSMENT_LIMITS.maxTextLength)
    || !hasEvaluation
    || !hasBaseline
    || associatedConstraints.some((constraint) => constraint.status === "unknown");
  const status: FalsifiableHypothesisStatus = blocked
    ? "blocked"
    : needsEvidence
      ? "needs_evidence"
      : needsDesign
        ? "needs_design"
        : "ready";
  const failureCriterion = cleanOptionalText(hypothesis.failureCriterion, DIRECTION_ASSESSMENT_LIMITS.maxTextLength);
  return {
    id: hypothesis.id,
    statement: cleanText(hypothesis.statement, `hypothesis ${hypothesis.id} statement`, DIRECTION_ASSESSMENT_LIMITS.maxTextLength),
    ...(failureCriterion ? { failureCriterion } : {}),
    status,
    ...traceFor(evidenceIds, constraintIds, input.evidenceById),
  };
}

function assessConference(conference: DirectionTargetConference, input: ValidatedInput): AssessedTargetConference {
  const evidenceIds = referenceIds(
    conference.evidenceIds,
    `target conference ${conference.id} evidence IDs`,
    DIRECTION_ASSESSMENT_LIMITS.maxEvidencePerCaveat,
    input.evidenceById,
  );
  const deadline = cleanOptionalText(conference.deadline, DIRECTION_ASSESSMENT_LIMITS.maxTextLength);
  return {
    id: conference.id,
    name: cleanText(conference.name, `target conference ${conference.id} name`, DIRECTION_ASSESSMENT_LIMITS.maxTextLength),
    ...(deadline ? { deadline } : {}),
    status: conference.status,
    ...traceFor(evidenceIds, [], input.evidenceById),
  };
}

function provisionalTitle(
  candidate: CandidateResearchDirection,
  evidenceIds: string[],
  evidenceById: Map<string, DirectionEvidence>,
): ProvisionalDirectionTitle {
  const titleSeed = cleanOptionalText(candidate.titleSeed, DIRECTION_ASSESSMENT_LIMITS.maxTitleLength - TITLE_PREFIX.length);
  const summary = cleanText(candidate.summary, `candidate ${candidate.id} summary`, DIRECTION_ASSESSMENT_LIMITS.maxTextLength);
  const trace = traceFor(evidenceIds, [], evidenceById);
  const titleBody = titleSeed ?? truncateTitle(summary);
  if (!OVERCOMMITTING_TITLE_PATTERN.test(titleBody)) {
    return { status: "accepted", text: `${TITLE_PREFIX}${titleBody}`, reasonCodes: ["provisional"], ...trace };
  }
  const fallback = titleSeed ? truncateTitle(summary) : undefined;
  if (fallback && !OVERCOMMITTING_TITLE_PATTERN.test(fallback)) {
    return {
      status: "downgraded",
      text: `${TITLE_PREFIX}${fallback}`,
      reasonCodes: ["provisional", "overcommitting_claim"],
      ...trace,
    };
  }
  return {
    status: "rejected",
    reasonCodes: ["provisional", "overcommitting_claim"],
    ...trace,
  };
}

function selectViabilityReasons(
  conclusions: DirectionAssessmentConclusion[],
  status: DirectionMinimumViability["status"],
): DirectionAssessmentConclusion[] {
  const relevantCodes = status === "blocked"
    ? new Set<DirectionConclusionCode>(["constraint_blocked", "conference_blocked", "hypothesis_blocked"])
    : status === "needs_evidence"
      ? new Set<DirectionConclusionCode>([
        "novelty_not_established",
        "constraint_unverified",
        "conference_unverified",
        "hypothesis_needs_evidence",
        "hypothesis_needs_design",
      ])
      : new Set<DirectionConclusionCode>(["literature_support", "constraint_satisfied", "conference_satisfied", "hypothesis_ready"]);
  const reasons = conclusions.filter((conclusion) => relevantCodes.has(conclusion.code));
  if (reasons.length > 0) return reasons;
  return status === "viable"
    ? conclusions.filter((conclusion) => conclusion.status === "supported").slice(0, 1)
    : conclusions.filter((conclusion) => conclusion.status !== "supported").slice(0, 1);
}

function gap(
  code: DirectionEvidenceGapCode,
  severity: DirectionEvidenceGap["severity"],
  evidenceIds: string[],
  constraintIds: string[],
  evidenceById: Map<string, DirectionEvidence>,
  related: Pick<DirectionEvidenceGap, "hypothesisId" | "caveatId" | "relatedId"> = {},
): DirectionEvidenceGap {
  return { code, severity, ...related, ...traceFor(evidenceIds, constraintIds, evidenceById) };
}

function traceFor(
  evidenceIds: readonly string[],
  constraintIds: readonly string[],
  evidenceById: Map<string, DirectionEvidence>,
): DirectionTrace {
  const uniqueEvidenceIds = sortedUnique(evidenceIds);
  return {
    evidenceIds: uniqueEvidenceIds,
    paperIds: sortedUnique(uniqueEvidenceIds.map((id) => evidenceById.get(id)?.paperId).filter(isString)),
    constraintIds: sortedUnique(constraintIds),
  };
}

function validateInput(input: DirectionAssessmentInput): ValidatedInput {
  if (!input || typeof input !== "object") throw new Error("Direction assessment input must be an object.");
  const candidates = arrayValue(input.candidates, "candidates");
  const evidence = arrayValue(input.evidence, "evidence");
  const constraints = arrayValue(input.constraints, "constraints");
  const targetConferences = arrayValue(input.targetConferences, "target conferences");
  assertCount(candidates, DIRECTION_ASSESSMENT_LIMITS.maxCandidates, "candidates");
  assertCount(evidence, DIRECTION_ASSESSMENT_LIMITS.maxEvidence, "evidence records");
  assertCount(constraints, DIRECTION_ASSESSMENT_LIMITS.maxConstraints, "constraints");
  assertCount(targetConferences, DIRECTION_ASSESSMENT_LIMITS.maxTargetConferences, "target conferences");
  if (candidates.length === 0) throw new Error("Direction assessment requires at least one candidate.");

  const evidenceById = uniqueRecordMap(evidence, "evidence record");
  const constraintsById = uniqueRecordMap(constraints, "constraint");
  const conferencesById = uniqueRecordMap(targetConferences, "target conference");
  uniqueRecordMap(candidates, "candidate direction");

  for (const record of evidence) validateEvidence(record);
  for (const record of constraints) validateConstraint(record, evidenceById);
  for (const record of targetConferences) validateConference(record, evidenceById);
  for (const candidate of candidates) {
    validateCandidate(candidate, evidenceById, constraintsById, conferencesById);
  }
  return { candidates, evidenceById, constraintsById, conferencesById };
}

function validateEvidence(evidence: DirectionEvidence): void {
  assertRecord(evidence, "evidence record");
  assertIdentifier(evidence.id, "evidence ID");
  assertIdentifier(evidence.paperId, `paper ID for evidence ${evidence.id}`);
  cleanText(evidence.statement, `evidence ${evidence.id} statement`, DIRECTION_ASSESSMENT_LIMITS.maxTextLength);
  if (!EVIDENCE_ROLES.has(evidence.role)) throw new Error(`Unsupported evidence role for ${evidence.id}.`);
  if (evidence.strength !== undefined && evidence.strength !== "direct" && evidence.strength !== "indirect") {
    throw new Error(`Unsupported evidence strength for ${evidence.id}.`);
  }
}

function validateConstraint(constraint: DirectionConstraint, evidenceById: Map<string, DirectionEvidence>): void {
  assertRecord(constraint, "constraint");
  assertIdentifier(constraint.id, "constraint ID");
  cleanText(constraint.label, `constraint ${constraint.id} label`, DIRECTION_ASSESSMENT_LIMITS.maxTextLength);
  if (!CONSTRAINT_KINDS.has(constraint.kind)) throw new Error(`Unsupported constraint kind for ${constraint.id}.`);
  if (!CONSTRAINT_STATUSES.has(constraint.status)) throw new Error(`Unsupported constraint status for ${constraint.id}.`);
  referenceIds(constraint.evidenceIds, `constraint ${constraint.id} evidence IDs`, DIRECTION_ASSESSMENT_LIMITS.maxEvidencePerCaveat, evidenceById);
}

function validateConference(conference: DirectionTargetConference, evidenceById: Map<string, DirectionEvidence>): void {
  assertRecord(conference, "target conference");
  assertIdentifier(conference.id, "target conference ID");
  cleanText(conference.name, `target conference ${conference.id} name`, DIRECTION_ASSESSMENT_LIMITS.maxTextLength);
  cleanOptionalText(conference.deadline, DIRECTION_ASSESSMENT_LIMITS.maxTextLength);
  if (!CONSTRAINT_STATUSES.has(conference.status)) throw new Error(`Unsupported target conference status for ${conference.id}.`);
  referenceIds(conference.evidenceIds, `target conference ${conference.id} evidence IDs`, DIRECTION_ASSESSMENT_LIMITS.maxEvidencePerCaveat, evidenceById);
}

function validateCandidate(
  candidate: CandidateResearchDirection,
  evidenceById: Map<string, DirectionEvidence>,
  constraintsById: Map<string, DirectionConstraint>,
  conferencesById: Map<string, DirectionTargetConference>,
): void {
  assertRecord(candidate, "candidate direction");
  assertIdentifier(candidate.id, "candidate direction ID");
  cleanText(candidate.summary, `candidate ${candidate.id} summary`, DIRECTION_ASSESSMENT_LIMITS.maxTextLength);
  cleanOptionalText(candidate.titleSeed, DIRECTION_ASSESSMENT_LIMITS.maxTitleLength - TITLE_PREFIX.length);
  referenceIds(candidate.evidenceIds, `candidate ${candidate.id} evidence IDs`, DIRECTION_ASSESSMENT_LIMITS.maxEvidencePerCandidate, evidenceById);
  referenceIds(candidate.constraintIds, `candidate ${candidate.id} constraint IDs`, DIRECTION_ASSESSMENT_LIMITS.maxConstraintsPerCandidate, constraintsById);
  referenceIds(candidate.targetConferenceIds, `candidate ${candidate.id} target conference IDs`, DIRECTION_ASSESSMENT_LIMITS.maxTargetConferencesPerCandidate, conferencesById);

  const caveats = arrayValue(candidate.caveats, `candidate ${candidate.id} caveats`);
  const hypotheses = arrayValue(candidate.hypotheses, `candidate ${candidate.id} hypotheses`);
  assertCount(caveats, DIRECTION_ASSESSMENT_LIMITS.maxCaveatsPerCandidate, `candidate ${candidate.id} caveats`);
  assertCount(hypotheses, DIRECTION_ASSESSMENT_LIMITS.maxHypothesesPerCandidate, `candidate ${candidate.id} hypotheses`);
  uniqueRecordMap(caveats, `candidate ${candidate.id} caveat`);
  uniqueRecordMap(hypotheses, `candidate ${candidate.id} hypothesis`);
  for (const caveat of caveats) {
    assertRecord(caveat, `candidate ${candidate.id} caveat`);
    assertIdentifier(caveat.id, `candidate ${candidate.id} caveat ID`);
    cleanText(caveat.summary, `caveat ${caveat.id} summary`, DIRECTION_ASSESSMENT_LIMITS.maxTextLength);
    if (!CAVEAT_SEVERITIES.has(caveat.severity)) throw new Error(`Unsupported caveat severity for ${caveat.id}.`);
    referenceIds(caveat.evidenceIds, `caveat ${caveat.id} evidence IDs`, DIRECTION_ASSESSMENT_LIMITS.maxEvidencePerCaveat, evidenceById);
  }
  for (const hypothesis of hypotheses) {
    assertRecord(hypothesis, `candidate ${candidate.id} hypothesis`);
    assertIdentifier(hypothesis.id, `candidate ${candidate.id} hypothesis ID`);
    cleanText(hypothesis.statement, `hypothesis ${hypothesis.id} statement`, DIRECTION_ASSESSMENT_LIMITS.maxTextLength);
    cleanOptionalText(hypothesis.failureCriterion, DIRECTION_ASSESSMENT_LIMITS.maxTextLength);
    referenceIds(hypothesis.evidenceIds, `hypothesis ${hypothesis.id} evidence IDs`, DIRECTION_ASSESSMENT_LIMITS.maxEvidencePerHypothesis, evidenceById);
    optionalReferenceId(hypothesis.evaluationConstraintId, `hypothesis ${hypothesis.id} evaluation constraint ID`, constraintsById);
    referenceIds(hypothesis.baselineConstraintIds, `hypothesis ${hypothesis.id} baseline constraint IDs`, DIRECTION_ASSESSMENT_LIMITS.maxBaselinesPerHypothesis, constraintsById);
  }
}

function uniqueRecordMap<T extends { id: string }>(records: readonly T[], label: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const record of records) {
    assertRecord(record, label);
    assertIdentifier(record.id, `${label} ID`);
    if (map.has(record.id)) throw new Error(`Duplicate ${label} ID: ${record.id}.`);
    map.set(record.id, record);
  }
  return map;
}

function referenceIds<T>(
  values: readonly string[] | undefined,
  label: string,
  maximum: number,
  records: Map<string, T>,
): string[] {
  const references = arrayValue(values, label);
  assertCount(references, maximum, label);
  for (const id of references) {
    assertIdentifier(id, label);
    if (!records.has(id)) throw new Error(`Unknown ${label.slice(0, -1)}: ${id}.`);
  }
  return sortedUnique(references);
}

function optionalReferenceId<T>(value: string | undefined, label: string, records: Map<string, T>): string | undefined {
  if (value === undefined) return undefined;
  assertIdentifier(value, label);
  if (!records.has(value)) throw new Error(`Unknown ${label}: ${value}.`);
  return value;
}

function arrayValue<T>(value: readonly T[] | undefined, label: string): readonly T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object.`);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > DIRECTION_ASSESSMENT_LIMITS.maxIdentifierLength) {
    throw new Error(`${label} must be a trimmed non-empty string no longer than ${DIRECTION_ASSESSMENT_LIMITS.maxIdentifierLength} characters.`);
  }
}

function cleanText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maximum) throw new Error(`${label} must be 1 to ${maximum} characters.`);
  return cleaned;
}

function cleanOptionalText(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return cleanText(value, "optional text", maximum);
}

function assertCount(values: readonly unknown[], maximum: number, label: string): void {
  if (values.length > maximum) throw new Error(`${label} exceeds the maximum of ${maximum}.`);
}

function caveatPenaltyFor(severity: DirectionCaveatSeverity): number {
  return severity === "high" ? 8 : severity === "medium" ? 4 : 2;
}

function truncateTitle(value: string): string {
  const maximum = DIRECTION_ASSESSMENT_LIMITS.maxTitleLength - TITLE_PREFIX.length;
  return value.length <= maximum ? value : value.slice(0, maximum).trimEnd();
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareConclusion(left: DirectionAssessmentConclusion, right: DirectionAssessmentConclusion): number {
  return compareText(left.code, right.code)
    || compareText(left.relatedId ?? "", right.relatedId ?? "")
    || compareText(left.evidenceIds.join("\u0000"), right.evidenceIds.join("\u0000"));
}

function compareGap(left: DirectionEvidenceGap, right: DirectionEvidenceGap): number {
  return compareText(left.code, right.code)
    || compareText(left.hypothesisId ?? left.caveatId ?? left.relatedId ?? "", right.hypothesisId ?? right.caveatId ?? right.relatedId ?? "")
    || compareText(left.evidenceIds.join("\u0000"), right.evidenceIds.join("\u0000"));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
