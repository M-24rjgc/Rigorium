import { randomUUID } from "node:crypto";
import {
  createResearchArtifact,
  type ResearchArtifactEnvelope,
  type ResearchArtifactParent,
  type ResearchArtifactProducer,
  type ResearchArtifactRef,
  type ResearchArtifactSource,
} from "../artifacts/index.js";
import type { DirectionAssessmentResult } from "../direction/directionAssessment.js";
import type { ResearchDirectionSeed } from "../direction/directionSeed.js";
import type { ResearchDirectionLifecycleState } from "../direction/directionLifecycle.js";
import { normalizeEliminationRecords } from "./comparison.js";
import type { EliminationRecord, MultiObjectiveComparison } from "./comparison.js";

export const RESEARCH_DESIGN_SCHEMA_VERSION = 1 as const;

export type ResearchDesignEntry = "discover" | "complete";
export type ResearchDesignStatus = "ready" | "needs_evidence" | "needs_input" | "blocked";
export type ResearchDesignConstraintKind =
  | "baseline"
  | "evaluation"
  | "compute"
  | "ethics"
  | "data"
  | "venue"
  | "timeline";
export type ResearchDesignConstraintStatus = "satisfied" | "unknown" | "blocked";
export type ResearchDesignInnovationKind = "theory" | "algorithm" | "system";
export type ResearchDesignSeverity = "low" | "medium" | "high";

export type ResearchIdea = Readonly<{
  id: string;
  statement: string;
  question?: string;
  context?: string;
  source: "user" | "conversation" | "literature" | "import";
}>;

export type ResearchDesignConstraint = Readonly<{
  id: string;
  kind: ResearchDesignConstraintKind;
  statement: string;
  status: ResearchDesignConstraintStatus;
  required: boolean;
  evidenceIds: readonly string[];
}>;

export type ResearchMechanism = Readonly<{
  id: string;
  family: string;
  description: string;
  differentiator: string;
  signature: string;
  distinctFrom: readonly string[];
}>;

export type ResearchInnovationClaim = Readonly<{
  id: string;
  kind: ResearchDesignInnovationKind;
  claim: string;
  testablePrediction: string;
  evidenceIds: readonly string[];
}>;

export type ResearchFalsificationCondition = Readonly<{
  id: string;
  statement: string;
  observable: string;
  threshold?: string;
  severity: ResearchDesignSeverity;
}>;

export type ResearchFailureCriterion = Readonly<{
  id: string;
  statement: string;
  stopRule: string;
  severity: ResearchDesignSeverity;
}>;

export type ResearchHypothesis = Readonly<{
  id: string;
  statement: string;
  innovationIds: readonly string[];
  falsificationIds: readonly string[];
  failureCriterionIds: readonly string[];
}>;

export type ResearchBaseline = Readonly<{
  id: string;
  label: string;
  rationale: string;
  sourceEvidenceIds: readonly string[];
  rerunRequired: boolean;
}>;

export type ResearchEvaluationPlan = Readonly<{
  protocol: string;
  primaryMetric: string;
  metrics: readonly string[];
  splits: readonly string[];
  successRule: string;
  ablations: readonly string[];
}>;

export type ResearchComputePlan = Readonly<{
  budget: string;
  hardware: string;
  timeLimit: string;
  reproducibilityNotes: string;
}>;

export type ResearchEthicsPlan = Readonly<{
  risks: readonly string[];
  mitigations: readonly string[];
  exclusions: readonly string[];
  approvalRequired: boolean;
}>;

export type ResearchCandidate = Readonly<{
  id: string;
  summary: string;
  mechanism: ResearchMechanism;
  innovations: readonly ResearchInnovationClaim[];
  hypotheses: readonly ResearchHypothesis[];
  falsificationConditions: readonly ResearchFalsificationCondition[];
  failureCriteria: readonly ResearchFailureCriterion[];
  baselines: readonly ResearchBaseline[];
  evaluation: ResearchEvaluationPlan;
  compute: ResearchComputePlan;
  ethics: ResearchEthicsPlan;
  evidenceIds: readonly string[];
  title?: string;
}>;

export type ResearchCandidateInput = Omit<ResearchCandidate, "id" | "mechanism" | "innovations" | "hypotheses" | "falsificationConditions" | "failureCriteria" | "baselines" | "evaluation" | "compute" | "ethics" | "evidenceIds"> & {
  id: string;
  mechanism: Omit<ResearchMechanism, "signature" | "distinctFrom"> & Partial<Pick<ResearchMechanism, "signature" | "distinctFrom">>;
  innovations: readonly ResearchInnovationClaim[];
  hypotheses: readonly ResearchHypothesis[];
  falsificationConditions: readonly ResearchFalsificationCondition[];
  failureCriteria: readonly ResearchFailureCriterion[];
  baselines: readonly ResearchBaseline[];
  evaluation: ResearchEvaluationPlan;
  compute: ResearchComputePlan;
  ethics: ResearchEthicsPlan;
  evidenceIds?: readonly string[];
  title?: string;
};

export type EvidencePackRequest = Readonly<{
  id: string;
  purpose: "prior_art" | "gap" | "method" | "baseline" | "evaluation" | "ethics" | "data";
  queries: readonly string[];
  requestedClaims: readonly string[];
  sourceIds: readonly string[];
  maxEntries: number;
  status: "pending" | "fulfilled" | "partial";
}>;

export type EvidenceCitation = Readonly<{
  id: string;
  sourceId: string;
  recordId?: string;
  locator?: string;
  claim: string;
  role: EvidencePackRequest["purpose"];
  strength: "direct" | "indirect";
  artifactRef?: ResearchArtifactRef;
}>;

export type EvidencePackLink = Readonly<{
  request: EvidencePackRequest;
  citations: readonly EvidenceCitation[];
}>;

export type DirectionCompatibility = Readonly<{
  schemaVersion: 1;
  sourceKinds: readonly ("research_direction_seed" | "direction_assessment" | "research_direction_lifecycle")[];
  sourceArtifactIds: readonly string[];
  candidateIds: readonly string[];
  selectedCandidateId?: string;
  dynamicChecks: Readonly<{
    evidence: "complete" | "needs_evidence";
    constraints: "complete" | "needs_input" | "blocked";
    confirmation: "complete" | "awaiting_confirmation" | "not_applicable";
  }>;
  /** Display-only legacy hint. No AgentLoop or scheduler consumes this field. */
  legacyNextStageId?: string;
  agentLoopControl: "none";
}>;

export type CandidatePortfolioPayload = Readonly<{
  schemaVersion: 1;
  kind: "candidate_portfolio";
  entry: ResearchDesignEntry;
  idea: ResearchIdea;
  candidates: readonly ResearchCandidate[];
  constraints: readonly ResearchDesignConstraint[];
  evidence: EvidencePackLink;
  compatibility?: DirectionCompatibility;
  status: ResearchDesignStatus;
  checks: Readonly<{
    mechanismDistinct: boolean;
    theoryOrAlgorithmInnovation: boolean;
    falsificationCovered: boolean;
    failureCriteriaCovered: boolean;
    baselineEvaluationComputeEthicsCovered: boolean;
  }>;
}>;

export type CandidatePortfolioArtifact = ResearchArtifactEnvelope<"candidate_portfolio", CandidatePortfolioPayload>;

export type ChallengeFinding = Readonly<{
  id: string;
  candidateId: string;
  category: "mechanism" | "novelty" | "falsification" | "failure" | "baseline" | "evaluation" | "compute" | "ethics" | "evidence" | "similar_work" | "contradiction";
  severity: ResearchDesignSeverity;
  statement: string;
  resolution: string;
  evidenceIds: readonly string[];
}>;

export type SimilarWorkRescan = Readonly<{
  id: string;
  candidateId: string;
  query: string;
  comparedWork: string;
  mechanismComparison: string;
  outcome: "distinct" | "overlap" | "inconclusive";
  evidenceIds: readonly string[];
}>;

export type EvidenceRescan = Readonly<{
  id: string;
  candidateId: string;
  query: string;
  sourceIds: readonly string[];
  claimChecked: string;
  outcome: "supports" | "contradicts" | "inconclusive";
  evidenceIds: readonly string[];
}>;

export type ContradictionRecord = Readonly<{
  id: string;
  candidateId: string;
  claim: string;
  counterClaim: string;
  evidenceIds: readonly string[];
  status: "open" | "resolved" | "accepted";
  resolution?: string;
}>;

export type IndependentCriticism = Readonly<{
  id: string;
  candidateId: string;
  reviewerId: string;
  category: ChallengeFinding["category"];
  severity: ResearchDesignSeverity;
  status: "open" | "resolved";
  statement: string;
  resolution: string;
  evidenceIds: readonly string[];
  independent: true;
}>;

export type ChallengeReportPayload = Readonly<{
  schemaVersion: 1;
  kind: "challenge_report";
  portfolioArtifactId: string;
  independentCriticisms: readonly IndependentCriticism[];
  similarWorkRescans: readonly SimilarWorkRescan[];
  evidenceRescans: readonly EvidenceRescan[];
  contradictions: readonly ContradictionRecord[];
  findings: readonly ChallengeFinding[];
  candidateVerdicts: Readonly<Record<string, "pass" | "revise" | "reject">>;
  unresolved: readonly string[];
  status: ResearchDesignStatus;
}>;

export type ChallengeReportArtifact = ResearchArtifactEnvelope<"challenge_report", ChallengeReportPayload>;

export type DecisionRecordPayload = Readonly<{
  schemaVersion: 1;
  kind: "decision_record";
  portfolioArtifactId: string;
  challengeReportArtifactId: string;
  choice: string | null;
  status: "selected" | "deferred" | "rejected";
  rationale: string;
  comparison: MultiObjectiveComparison;
  eliminations: readonly EliminationRecord[];
  alternativesConsidered: readonly string[];
  unresolvedRisks: readonly string[];
  explicitUserConfirmation: boolean;
}>;

export type DecisionRecordArtifact = ResearchArtifactEnvelope<"decision_record", DecisionRecordPayload>;

export type ResearchBriefPayload = Readonly<{
  schemaVersion: 1;
  kind: "research_brief";
  portfolioArtifactId: string;
  candidateId: string | null;
  title: Readonly<{
    text?: string;
    status: "untitled" | "draft" | "provisional" | "confirmed";
    metadataRevision: number;
    confirmedBy?: string;
    confirmedAt?: string;
  }>;
  question: string;
  mechanism: string;
  hypotheses: readonly string[];
  evidence: EvidencePackLink;
  challengeReportArtifactId?: string;
  decisionRecordArtifactId?: string;
  baselinePlan: readonly string[];
  evaluationPlan: ResearchEvaluationPlan | null;
  computePlan: ResearchComputePlan | null;
  ethicsPlan: ResearchEthicsPlan | null;
  falsificationConditions: readonly string[];
  failureCriteria: readonly string[];
  status: ResearchDesignStatus;
}>;

export type ResearchBriefArtifact = ResearchArtifactEnvelope<"research_brief", ResearchBriefPayload>;

export type CandidatePortfolioBuildInput = Readonly<{
  entry: ResearchDesignEntry;
  idea: Partial<ResearchIdea> & Pick<ResearchIdea, "statement">;
  candidates: readonly ResearchCandidateInput[];
  constraints?: readonly ResearchDesignConstraint[];
  evidenceRequest?: Partial<EvidencePackRequest> & Pick<EvidencePackRequest, "purpose" | "queries" | "requestedClaims" | "sourceIds">;
  citations?: readonly EvidenceCitation[];
  compatibility?: DirectionCompatibility;
  producer?: ResearchArtifactProducer;
  parents?: readonly ResearchArtifactParent[];
  artifactId?: string;
  revision?: number;
  now?: Date;
}>;

export type ChallengeReportBuildInput = Readonly<{
  portfolio: CandidatePortfolioArtifact;
  independentCriticisms?: readonly Omit<IndependentCriticism, "independent">[];
  similarWorkRescans?: readonly SimilarWorkRescan[];
  evidenceRescans?: readonly EvidenceRescan[];
  contradictions?: readonly ContradictionRecord[];
  additionalChallenges?: readonly Readonly<{ id: string; candidateId: string; category: ChallengeFinding["category"]; statement: string; resolution?: string; evidenceIds?: readonly string[] }>[];
  producer?: ResearchArtifactProducer;
  parents?: readonly ResearchArtifactParent[];
  artifactId?: string;
  revision?: number;
  now?: Date;
}>;

export type DecisionRecordBuildInput = Readonly<{
  portfolio: CandidatePortfolioArtifact;
  challengeReport: ChallengeReportArtifact;
  choice: string | null;
  status: DecisionRecordPayload["status"];
  rationale: string;
  comparison: MultiObjectiveComparison;
  eliminations: readonly EliminationRecord[];
  alternativesConsidered?: readonly string[];
  unresolvedRisks?: readonly string[];
  explicitUserConfirmation?: boolean;
  producer?: ResearchArtifactProducer;
  artifactId?: string;
  revision?: number;
  now?: Date;
}>;

export type ResearchBriefBuildInput = Readonly<{
  portfolio: CandidatePortfolioArtifact;
  candidateId: string | null;
  question?: string;
  title?: Readonly<{
    text?: string;
    status?: "untitled" | "draft" | "provisional" | "confirmed";
    explicitConfirmation?: boolean;
    confirmedBy?: string;
    confirmedAt?: string;
  }>;
  challengeReport?: ChallengeReportArtifact;
  decisionRecord?: DecisionRecordArtifact;
  evidence?: EvidencePackLink;
  producer?: ResearchArtifactProducer;
  parents?: readonly ResearchArtifactParent[];
  artifactId?: string;
  revision?: number;
  now?: Date;
}>;

export function buildEvidencePackLink(input: {
  request?: Partial<EvidencePackRequest> & Pick<EvidencePackRequest, "purpose" | "queries" | "requestedClaims" | "sourceIds">;
  citations?: readonly EvidenceCitation[];
}): EvidencePackLink {
  const requestInput = input.request;
  const citations = normalizeCitations(input.citations ?? []);
  const request: EvidencePackRequest = {
    id: identifier(requestInput?.id ?? `evidence-request-${randomUUID()}`, "evidence request ID"),
    purpose: requestInput?.purpose ?? "gap",
    queries: textList(requestInput?.queries ?? [], "evidence request queries", 32),
    requestedClaims: textList(requestInput?.requestedClaims ?? [], "evidence request claims", 64),
    sourceIds: identifierList(requestInput?.sourceIds ?? [], "evidence request sources", 64),
    maxEntries: positiveInteger(requestInput?.maxEntries ?? 64, "evidence request maxEntries"),
    status: requestInput?.status ?? (citations.length === 0 ? "pending" : "partial"),
  };
  if (request.status === "fulfilled" && citations.length === 0) {
    throw new TypeError("A fulfilled evidence request must contain citations.");
  }
  if (citations.length > request.maxEntries) throw new TypeError("Evidence citations exceed request maxEntries.");
  return Object.freeze({ request, citations: Object.freeze(citations) });
}

export function buildCandidatePortfolioPayload(input: CandidatePortfolioBuildInput): CandidatePortfolioPayload {
  if (input.entry !== "discover" && input.entry !== "complete") throw new TypeError("entry must be discover or complete.");
  const idea = normalizeIdea(input.idea);
  const citations = normalizeCitations(input.citations ?? []);
  const citationIds = new Set(citations.map((citation) => citation.id));
  const candidates = normalizeCandidates(input.candidates, citationIds);
  if (candidates.length < 2) throw new TypeError("Candidate portfolio requires at least two candidates with different mechanisms.");
  const constraints = normalizeConstraints(input.constraints ?? [], citationIds);
  const evidence = buildEvidencePackLink({ request: input.evidenceRequest, citations });
  const mechanismSignatures = new Set<string>();
  let mechanismDistinct = true;
  for (const candidate of candidates) {
    if (mechanismSignatures.has(candidate.mechanism.signature)) mechanismDistinct = false;
    mechanismSignatures.add(candidate.mechanism.signature);
  }
  if (!mechanismDistinct) throw new TypeError("Candidates must use mechanically distinct mechanism signatures.");
  const allCandidateIds = new Set(candidates.map((candidate) => candidate.id));
  for (const candidate of candidates) {
    const expected = candidates.filter((other) => other.id !== candidate.id).map((other) => other.id);
    const declared = new Set(candidate.mechanism.distinctFrom);
    if (expected.some((id) => !declared.has(id))) {
      throw new TypeError(`Candidate ${candidate.id} must explain how its mechanism differs from every alternative.`);
    }
    if (candidate.mechanism.distinctFrom.some((id) => !allCandidateIds.has(id) || id === candidate.id)) {
      throw new TypeError(`Candidate ${candidate.id} has an invalid mechanism contrast target.`);
    }
  }
  const checks = {
    mechanismDistinct,
    theoryOrAlgorithmInnovation: candidates.every((candidate) => candidate.innovations.some((innovation) => innovation.kind === "theory" || innovation.kind === "algorithm")),
    falsificationCovered: candidates.every((candidate) => candidate.falsificationConditions.length > 0),
    failureCriteriaCovered: candidates.every((candidate) => candidate.failureCriteria.length > 0),
    baselineEvaluationComputeEthicsCovered: candidates.every((candidate) => candidate.baselines.length > 0
      && candidate.evaluation.metrics.length > 0
      && candidate.compute.budget.length > 0
      && candidate.ethics.risks.length > 0
      && candidate.ethics.mitigations.length > 0),
  };
  const status: ResearchDesignStatus = checks.mechanismDistinct && checks.theoryOrAlgorithmInnovation
    && checks.falsificationCovered && checks.failureCriteriaCovered && checks.baselineEvaluationComputeEthicsCovered
    ? (citations.length > 0 ? "ready" : "needs_evidence")
    : "needs_input";
  return Object.freeze({
    schemaVersion: RESEARCH_DESIGN_SCHEMA_VERSION,
    kind: "candidate_portfolio",
    entry: input.entry,
    idea,
    candidates: Object.freeze(candidates),
    constraints: Object.freeze(constraints),
    evidence,
    ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
    status,
    checks,
  });
}

export function createCandidatePortfolioArtifact(input: CandidatePortfolioBuildInput): CandidatePortfolioArtifact {
  const payload = buildCandidatePortfolioPayload(input);
  return createResearchArtifact({
    kind: "candidate_portfolio",
    payload,
    producer: input.producer ?? { kind: "tool", toolName: "research_design" },
    parents: input.parents,
    sources: sourceRecords(payload.evidence.citations),
    artifactId: input.artifactId ?? `candidate-portfolio-${randomUUID()}`,
    revision: input.revision,
    now: input.now,
  }) as CandidatePortfolioArtifact;
}

export function createChallengeReportArtifact(input: ChallengeReportBuildInput): ChallengeReportArtifact {
  const portfolio = input.portfolio;
  const candidateIds = new Set(portfolio.payload.candidates.map((candidate) => candidate.id));
  const evidenceIds = new Set(portfolio.payload.evidence.citations.map((citation) => citation.id));
  const independentCriticisms = normalizeIndependentCriticisms(input.independentCriticisms ?? [], candidateIds, evidenceIds);
  const similarWorkRescans = normalizeSimilarWorkRescans(input.similarWorkRescans ?? [], candidateIds, evidenceIds);
  const evidenceRescans = normalizeEvidenceRescans(input.evidenceRescans ?? [], candidateIds, evidenceIds);
  const contradictions = normalizeContradictions(input.contradictions ?? [], candidateIds, evidenceIds);
  const findings: ChallengeFinding[] = [];
  const candidateVerdicts: Record<string, "pass" | "revise" | "reject"> = {};
  for (const candidate of portfolio.payload.candidates) {
    const candidateFindings: ChallengeFinding[] = [];
    if (candidate.innovations.every((innovation) => innovation.kind === "system")) {
      candidateFindings.push(finding(candidate.id, "novelty", "high", "No theory or algorithm innovation claim is testable.", "Add a theory or algorithm claim with a measurable prediction.", []));
    }
    if (candidate.falsificationConditions.length === 0) {
      candidateFindings.push(finding(candidate.id, "falsification", "high", "No condition could falsify the hypothesis.", "Define an observable threshold that would count against the mechanism.", []));
    }
    if (candidate.failureCriteria.length === 0) {
      candidateFindings.push(finding(candidate.id, "failure", "high", "No stop rule is recorded.", "Define a failure criterion and an experiment stop rule.", []));
    }
    if (candidate.baselines.length === 0) candidateFindings.push(finding(candidate.id, "baseline", "high", "No baseline is specified.", "Name at least one competitive or ablation baseline.", []));
    if (candidate.evaluation.metrics.length === 0) candidateFindings.push(finding(candidate.id, "evaluation", "high", "No evaluation metric is specified.", "Specify a primary metric and protocol.", []));
    if (!candidate.compute.budget.trim()) candidateFindings.push(finding(candidate.id, "compute", "medium", "Compute budget is unknown.", "Bound hardware, time, or monetary budget before execution.", []));
    if (candidate.ethics.risks.length === 0 || candidate.ethics.mitigations.length === 0) candidateFindings.push(finding(candidate.id, "ethics", "high", "Ethics risk and mitigation are incomplete.", "Record risks, mitigations, and exclusions.", []));
    findings.push(...candidateFindings);
    candidateVerdicts[candidate.id] = candidateFindings.some((item) => item.severity === "high") ? "revise" : "pass";
  }
  findings.push(...(input.additionalChallenges ?? []).map((challenge, index) => finding(
    knownCandidate(challenge.candidateId, candidateIds, `additionalChallenges[${index}]`),
    challenge.category,
    "high",
    bounded(challenge.statement, `additionalChallenges[${index}].statement`, 8_000),
    bounded(challenge.resolution ?? "Resolve this challenge before selecting the candidate.", `additionalChallenges[${index}].resolution`, 8_000),
    knownEvidence(challenge.evidenceIds ?? [], evidenceIds, `additionalChallenges[${index}].evidenceIds`),
    identifier(challenge.id, `additionalChallenges[${index}].id`),
  )));
  findings.push(...independentCriticisms.filter((criticism) => criticism.status === "open").map((criticism) => finding(
    criticism.candidateId,
    criticism.category,
    criticism.severity,
    criticism.statement,
    criticism.resolution,
    criticism.evidenceIds,
    criticism.id,
  )));
  for (const rescan of similarWorkRescans) {
    if (rescan.outcome === "distinct") continue;
    findings.push(finding(
      rescan.candidateId,
      "similar_work",
      rescan.outcome === "overlap" ? "high" : "medium",
      rescan.outcome === "overlap" ? `Mechanism overlap found with ${rescan.comparedWork}.` : `Similarity remains inconclusive for ${rescan.comparedWork}.`,
      "Revise the novelty claim or gather stronger mechanism-level evidence.",
      rescan.evidenceIds,
      rescan.id,
    ));
  }
  for (const rescan of evidenceRescans) {
    if (rescan.outcome === "supports") continue;
    findings.push(finding(
      rescan.candidateId,
      rescan.outcome === "contradicts" ? "contradiction" : "evidence",
      rescan.outcome === "contradicts" ? "high" : "medium",
      rescan.outcome === "contradicts" ? `Evidence rescan contradicts: ${rescan.claimChecked}` : `Evidence rescan is inconclusive: ${rescan.claimChecked}`,
      "Resolve the claim against the cited source snapshot before selection.",
      rescan.evidenceIds,
      rescan.id,
    ));
  }
  for (const contradiction of contradictions) {
    if (contradiction.status === "resolved") continue;
    findings.push(finding(
      contradiction.candidateId,
      "contradiction",
      contradiction.status === "open" ? "high" : "medium",
      `${contradiction.claim} conflicts with ${contradiction.counterClaim}.`,
      contradiction.resolution ?? "Resolve or explicitly accept the contradiction before selection.",
      contradiction.evidenceIds,
      contradiction.id,
    ));
  }
  const findingIds = findings.map((item) => item.id);
  if (new Set(findingIds).size !== findingIds.length) throw new TypeError("Challenge finding IDs must be unique.");
  for (const candidate of portfolio.payload.candidates) {
    const candidateFindings = findings.filter((item) => item.candidateId === candidate.id);
    candidateVerdicts[candidate.id] = candidateFindings.some((item) => item.severity === "high") ? "revise" : "pass";
  }
  const unresolved = findings.filter((findingItem) => findingItem.severity === "high").map((findingItem) => findingItem.id);
  const payload: ChallengeReportPayload = {
    schemaVersion: 1,
    kind: "challenge_report",
    portfolioArtifactId: portfolio.artifactId,
    independentCriticisms: Object.freeze(independentCriticisms),
    similarWorkRescans: Object.freeze(similarWorkRescans),
    evidenceRescans: Object.freeze(evidenceRescans),
    contradictions: Object.freeze(contradictions),
    findings: Object.freeze(findings),
    candidateVerdicts,
    unresolved: Object.freeze(unresolved),
    status: unresolved.length > 0 ? "needs_input" : (portfolio.payload.status === "ready" ? "ready" : "needs_evidence"),
  };
  const parents = [
    { relation: "derived_from" as const, artifact: refOf(portfolio) },
    ...(input.parents ?? []),
  ];
  return createResearchArtifact({
    kind: "challenge_report",
    payload,
    producer: input.producer ?? { kind: "tool", toolName: "research_design" },
    parents,
    sources: sourceRecords(portfolio.payload.evidence.citations),
    artifactId: input.artifactId ?? `challenge-report-${randomUUID()}`,
    revision: input.revision,
    now: input.now,
  }) as ChallengeReportArtifact;
}

export function createDecisionRecordArtifact(input: DecisionRecordBuildInput): DecisionRecordArtifact {
  if (input.choice !== null && !input.portfolio.payload.candidates.some((candidate) => candidate.id === input.choice)) {
    throw new TypeError(`Decision choice ${input.choice} is not in the candidate portfolio.`);
  }
  if (input.status === "selected" && input.choice === null) throw new TypeError("A selected decision requires a candidate choice.");
  if (input.status !== "selected" && input.choice !== null && input.challengeReport.payload.candidateVerdicts[input.choice] === "reject") {
    throw new TypeError("A rejected candidate cannot be recorded as a deferred choice.");
  }
  if (input.status === "selected" && input.choice !== null && input.challengeReport.payload.candidateVerdicts[input.choice] === "reject") {
    throw new TypeError("A candidate with a reject challenge verdict cannot be selected.");
  }
  if (input.status === "selected" && input.choice !== null
    && input.challengeReport.payload.candidateVerdicts[input.choice] === "revise"
    && input.explicitUserConfirmation !== true) {
    throw new TypeError("Selecting a candidate with unresolved challenge findings requires explicit user confirmation.");
  }
  const eliminations = normalizeEliminationRecords({
    portfolio: input.portfolio,
    comparison: input.comparison,
    records: input.eliminations,
  });
  if (input.choice !== null && eliminations.some((record) => record.candidateId === input.choice && record.outcome === "eliminated")) {
    throw new TypeError("An eliminated candidate cannot be selected or deferred as the decision choice.");
  }
  const payload: DecisionRecordPayload = {
    schemaVersion: 1,
    kind: "decision_record",
    portfolioArtifactId: input.portfolio.artifactId,
    challengeReportArtifactId: input.challengeReport.artifactId,
    choice: input.choice,
    status: input.status,
    rationale: bounded(input.rationale, "decision rationale", 16_000),
    comparison: input.comparison,
    eliminations,
    alternativesConsidered: identifierList(input.alternativesConsidered ?? input.portfolio.payload.candidates.map((candidate) => candidate.id), "alternatives", 32),
    unresolvedRisks: textList(input.unresolvedRisks ?? [], "unresolved risks", 64),
    explicitUserConfirmation: input.explicitUserConfirmation ?? false,
  };
  return createResearchArtifact({
    kind: "decision_record",
    payload,
    producer: input.producer ?? { kind: "tool", toolName: "research_design" },
    parents: [
      { relation: "uses", artifact: refOf(input.portfolio) },
      { relation: "derived_from", artifact: refOf(input.challengeReport) },
    ],
    sources: sourceRecords(input.portfolio.payload.evidence.citations),
    artifactId: input.artifactId ?? `decision-record-${randomUUID()}`,
    revision: input.revision,
    now: input.now,
  }) as DecisionRecordArtifact;
}

export function createResearchBriefArtifact(input: ResearchBriefBuildInput): ResearchBriefArtifact {
  const portfolio = input.portfolio;
  const candidate = input.candidateId === null ? undefined : portfolio.payload.candidates.find((item) => item.id === input.candidateId);
  if (input.candidateId !== null && !candidate) throw new TypeError(`Brief candidate ${input.candidateId} is not in the candidate portfolio.`);
  if (input.decisionRecord && input.decisionRecord.payload.choice !== input.candidateId) {
    throw new TypeError("Brief candidate does not match the decision record choice.");
  }
  const evidence = input.evidence ?? portfolio.payload.evidence;
  const title = normalizeBriefTitle(input.title, candidate?.title, input.revision ?? 1, input.now);
  const payload: ResearchBriefPayload = {
    schemaVersion: 1,
    kind: "research_brief",
    portfolioArtifactId: portfolio.artifactId,
    candidateId: input.candidateId,
    title,
    question: bounded(input.question ?? portfolio.payload.idea.question ?? portfolio.payload.idea.statement, "brief question", 4_000),
    mechanism: candidate?.mechanism.description ?? "No candidate selected; mechanism remains open.",
    hypotheses: Object.freeze(candidate?.hypotheses.map((hypothesis) => hypothesis.statement) ?? []),
    evidence,
    ...(input.challengeReport === undefined ? {} : { challengeReportArtifactId: input.challengeReport.artifactId }),
    ...(input.decisionRecord === undefined ? {} : { decisionRecordArtifactId: input.decisionRecord.artifactId }),
    baselinePlan: Object.freeze(candidate?.baselines.map((baseline) => baseline.label) ?? []),
    evaluationPlan: candidate?.evaluation ?? null,
    computePlan: candidate?.compute ?? null,
    ethicsPlan: candidate?.ethics ?? null,
    falsificationConditions: Object.freeze(candidate?.falsificationConditions.map((condition) => condition.statement) ?? []),
    failureCriteria: Object.freeze(candidate?.failureCriteria.map((criterion) => criterion.statement) ?? []),
    status: candidate && portfolio.payload.status === "ready" ? "ready" : (candidate ? "needs_evidence" : "needs_input"),
  };
  const parents: ResearchArtifactParent[] = [
    { relation: "derived_from", artifact: refOf(portfolio) },
    ...(input.challengeReport ? [{ relation: "uses" as const, artifact: refOf(input.challengeReport) }] : []),
    ...(input.decisionRecord ? [{ relation: "uses" as const, artifact: refOf(input.decisionRecord) }] : []),
    ...(input.parents ?? []),
  ];
  return createResearchArtifact({
    kind: "research_brief",
    payload,
    producer: input.producer ?? { kind: "tool", toolName: "research_brief" },
    parents,
    sources: sourceRecords(evidence.citations),
    artifactId: input.artifactId ?? `research-brief-${randomUUID()}`,
    revision: input.revision,
    now: input.now,
  }) as ResearchBriefArtifact;
}

export function reviseResearchBriefArtifact(input: {
  previous: ResearchBriefArtifact;
  portfolio: CandidatePortfolioArtifact;
  candidateId?: string | null;
  question?: string;
  title?: ResearchBriefBuildInput["title"];
  challengeReport?: ChallengeReportArtifact;
  decisionRecord?: DecisionRecordArtifact;
  evidence?: EvidencePackLink;
  producer?: ResearchArtifactProducer;
  now?: Date;
}): ResearchBriefArtifact {
  if (input.previous.payload.portfolioArtifactId !== input.portfolio.artifactId) {
    throw new TypeError("A ResearchBrief revision must remain attached to the same candidate portfolio.");
  }
  return createResearchBriefArtifact({
    portfolio: input.portfolio,
    candidateId: input.candidateId === undefined ? input.previous.payload.candidateId : input.candidateId,
    question: input.question ?? input.previous.payload.question,
    title: input.title ?? {
      text: input.previous.payload.title.text,
      status: input.previous.payload.title.status,
      explicitConfirmation: input.previous.payload.title.status === "confirmed",
      confirmedBy: input.previous.payload.title.confirmedBy,
      confirmedAt: input.previous.payload.title.confirmedAt,
    },
    challengeReport: input.challengeReport,
    decisionRecord: input.decisionRecord,
    evidence: input.evidence ?? input.previous.payload.evidence,
    producer: input.producer ?? { kind: "tool", toolName: "research_brief" },
    parents: [{ relation: "supersedes", artifact: refOf(input.previous) }],
    artifactId: input.previous.artifactId,
    revision: input.previous.revision + 1,
    now: input.now,
  });
}

export function buildDirectionCompatibility(input: {
  seed?: ResearchDirectionSeed;
  assessment?: DirectionAssessmentResult;
  lifecycle?: ResearchDirectionLifecycleState;
  sourceArtifactIds?: readonly string[];
}): DirectionCompatibility {
  const sourceKinds: Array<DirectionCompatibility["sourceKinds"][number]> = [];
  const sourceArtifactIds = identifierList(input.sourceArtifactIds ?? [], "source artifact IDs", 16);
  if (input.seed) sourceKinds.push("research_direction_seed");
  if (input.assessment) sourceKinds.push("direction_assessment");
  if (input.lifecycle) sourceKinds.push("research_direction_lifecycle");
  const candidateIds = input.seed?.candidateDirections.map((candidate) => candidate.id)
    ?? input.assessment?.assessments.map((assessment) => assessment.directionId)
    ?? input.lifecycle?.seed.candidateDirections.map((candidate) => candidate.id)
    ?? [];
  const selectedCandidateId = input.lifecycle?.selectedDirectionId ?? input.assessment?.rankedDirectionIds[0];
  const statuses = input.lifecycle?.checklist.items ?? [];
  const assessmentEvidenceComplete = input.assessment !== undefined
    && input.assessment.assessments.every((assessment) => assessment.unmetEvidenceGaps.length === 0);
  const evidenceStatus: DirectionCompatibility["dynamicChecks"]["evidence"] = statuses.some((stage) => stage.id === "evidence_gap_analysis" && stage.status === "complete") || assessmentEvidenceComplete
    ? "complete"
    : "needs_evidence";
  const constraintsStatus: DirectionCompatibility["dynamicChecks"]["constraints"] = statuses.some((stage) => stage.id === "constraints" && stage.status === "blocked")
    ? "blocked"
    : statuses.some((stage) => stage.id === "constraints" && stage.status === "complete") || input.seed?.constraintCoverage.status === "specified"
      ? "complete"
      : "needs_input";
  const confirmationStatus: DirectionCompatibility["dynamicChecks"]["confirmation"] = input.lifecycle?.titleConfirmation?.result.confirmation.confirmed
    ? "complete"
    : input.lifecycle?.titleConfirmation
      ? "awaiting_confirmation"
      : "not_applicable";
  return Object.freeze({
    schemaVersion: 1,
    sourceKinds: Object.freeze(sourceKinds),
    sourceArtifactIds: Object.freeze(sourceArtifactIds),
    candidateIds: Object.freeze(identifierList(candidateIds, "candidate IDs", 128)),
    ...(selectedCandidateId === undefined ? {} : { selectedCandidateId }),
    dynamicChecks: { evidence: evidenceStatus, constraints: constraintsStatus, confirmation: confirmationStatus },
    ...(input.lifecycle?.checklist.nextStageId === undefined ? {} : { legacyNextStageId: input.lifecycle.checklist.nextStageId }),
    agentLoopControl: "none",
  });
}

export function refOf(artifact: ResearchArtifactEnvelope): ResearchArtifactRef {
  return {
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    kind: artifact.kind,
    contentHash: artifact.contentHash,
  };
}

function normalizeBriefTitle(
  value: ResearchBriefBuildInput["title"],
  candidateTitle: string | undefined,
  metadataRevision: number,
  now: Date | undefined,
): ResearchBriefPayload["title"] {
  const textValue = value?.text ?? candidateTitle;
  const status = value?.status ?? (textValue ? "provisional" : "untitled");
  if (!["untitled", "draft", "provisional", "confirmed"].includes(status)) throw new TypeError("Brief title status is invalid.");
  if (status === "untitled") {
    if (textValue !== undefined) throw new TypeError("An untitled brief cannot contain title text.");
    return { status, metadataRevision: positiveInteger(metadataRevision, "title metadata revision") };
  }
  const text = bounded(textValue, "brief title", 256);
  if (status !== "confirmed") {
    if (value?.explicitConfirmation === true || value?.confirmedBy !== undefined || value?.confirmedAt !== undefined) {
      throw new TypeError("Confirmation metadata is valid only for a confirmed title.");
    }
    return { text, status, metadataRevision: positiveInteger(metadataRevision, "title metadata revision") };
  }
  if (value?.explicitConfirmation !== true) throw new TypeError("A confirmed title requires explicitConfirmation=true.");
  const confirmedBy = identifier(value.confirmedBy, "title confirmedBy");
  const confirmedAt = value.confirmedAt ?? (now ?? new Date()).toISOString();
  if (Number.isNaN(Date.parse(confirmedAt))) throw new TypeError("title confirmedAt must be an ISO timestamp.");
  return { text, status, metadataRevision: positiveInteger(metadataRevision, "title metadata revision"), confirmedBy, confirmedAt };
}

function normalizeIdea(value: CandidatePortfolioBuildInput["idea"]): ResearchIdea {
  return {
    id: identifier(value.id ?? `idea-${randomUUID()}`, "idea ID"),
    statement: bounded(value.statement, "idea statement", 8_000),
    ...(value.question === undefined ? {} : { question: bounded(value.question, "idea question", 4_000) }),
    ...(value.context === undefined ? {} : { context: bounded(value.context, "idea context", 8_000) }),
    source: value.source ?? "conversation",
  };
}

function normalizeCandidates(values: readonly ResearchCandidateInput[], citationIds: ReadonlySet<string>): ResearchCandidate[] {
  if (!Array.isArray(values) || values.length > 16) throw new TypeError("candidates must contain between two and sixteen entries.");
  const ids = new Set<string>();
  return values.map((value, index) => {
    const candidate = normalizeCandidate(value, index, citationIds);
    if (ids.has(candidate.id)) throw new TypeError(`Candidate ${candidate.id} is duplicated.`);
    ids.add(candidate.id);
    return candidate;
  });
}

function normalizeCandidate(value: ResearchCandidateInput, index: number, citationIds: ReadonlySet<string>): ResearchCandidate {
  const label = `candidates[${index}]`;
  const mechanism = value.mechanism;
  const signature = identifier(mechanism.signature ?? `${mechanism.family}:${mechanism.description}`, `${label}.mechanism.signature`).toLocaleLowerCase("en");
  const candidate: ResearchCandidate = {
    id: identifier(value.id, `${label}.id`),
    summary: bounded(value.summary, `${label}.summary`, 8_000),
    mechanism: {
      id: identifier(mechanism.id, `${label}.mechanism.id`),
      family: bounded(mechanism.family, `${label}.mechanism.family`, 512),
      description: bounded(mechanism.description, `${label}.mechanism.description`, 8_000),
      differentiator: bounded(mechanism.differentiator, `${label}.mechanism.differentiator`, 4_000),
      signature,
      distinctFrom: identifierList(mechanism.distinctFrom ?? [], `${label}.mechanism.distinctFrom`, 16),
    },
    innovations: value.innovations.map((innovation, innovationIndex) => normalizeInnovation(innovation, `${label}.innovations[${innovationIndex}]`, citationIds)),
    hypotheses: value.hypotheses.map((hypothesis, hypothesisIndex) => normalizeHypothesis(hypothesis, `${label}.hypotheses[${hypothesisIndex}]`)),
    falsificationConditions: value.falsificationConditions.map((condition, conditionIndex) => normalizeFalsification(condition, `${label}.falsificationConditions[${conditionIndex}]`)),
    failureCriteria: value.failureCriteria.map((criterion, criterionIndex) => normalizeFailure(criterion, `${label}.failureCriteria[${criterionIndex}]`)),
    baselines: value.baselines.map((baseline, baselineIndex) => normalizeBaseline(baseline, `${label}.baselines[${baselineIndex}]`, citationIds)),
    evaluation: normalizeEvaluation(value.evaluation, `${label}.evaluation`),
    compute: normalizeCompute(value.compute, `${label}.compute`),
    ethics: normalizeEthics(value.ethics, `${label}.ethics`),
    evidenceIds: identifierList(value.evidenceIds ?? [], `${label}.evidenceIds`, 128),
    ...(value.title === undefined ? {} : { title: bounded(value.title, `${label}.title`, 256) }),
  };
  for (const id of candidate.evidenceIds) requireCitation(id, citationIds, `${label}.evidenceIds`);
  return candidate;
}

function normalizeInnovation(value: ResearchInnovationClaim, label: string, citationIds: ReadonlySet<string>): ResearchInnovationClaim {
  if (!["theory", "algorithm", "system"].includes(value.kind)) throw new TypeError(`${label}.kind is invalid.`);
  const evidenceIds = identifierList(value.evidenceIds ?? [], `${label}.evidenceIds`, 32);
  for (const id of evidenceIds) requireCitation(id, citationIds, `${label}.evidenceIds`);
  return { id: identifier(value.id, `${label}.id`), kind: value.kind, claim: bounded(value.claim, `${label}.claim`, 4_000), testablePrediction: bounded(value.testablePrediction, `${label}.testablePrediction`, 4_000), evidenceIds };
}

function normalizeHypothesis(value: ResearchHypothesis, label: string): ResearchHypothesis {
  const hypothesis = {
    id: identifier(value.id, `${label}.id`),
    statement: bounded(value.statement, `${label}.statement`, 4_000),
    innovationIds: identifierList(value.innovationIds, `${label}.innovationIds`, 16),
    falsificationIds: identifierList(value.falsificationIds, `${label}.falsificationIds`, 16),
    failureCriterionIds: identifierList(value.failureCriterionIds, `${label}.failureCriterionIds`, 16),
  };
  if (hypothesis.falsificationIds.length === 0 || hypothesis.failureCriterionIds.length === 0) throw new TypeError(`${label} must reference falsification and failure criteria.`);
  return hypothesis;
}

function normalizeFalsification(value: ResearchFalsificationCondition, label: string): ResearchFalsificationCondition {
  if (!["low", "medium", "high"].includes(value.severity)) throw new TypeError(`${label}.severity is invalid.`);
  return { id: identifier(value.id, `${label}.id`), statement: bounded(value.statement, `${label}.statement`, 4_000), observable: bounded(value.observable, `${label}.observable`, 4_000), ...(value.threshold === undefined ? {} : { threshold: bounded(value.threshold, `${label}.threshold`, 1_000) }), severity: value.severity };
}

function normalizeFailure(value: ResearchFailureCriterion, label: string): ResearchFailureCriterion {
  if (!["low", "medium", "high"].includes(value.severity)) throw new TypeError(`${label}.severity is invalid.`);
  return { id: identifier(value.id, `${label}.id`), statement: bounded(value.statement, `${label}.statement`, 4_000), stopRule: bounded(value.stopRule, `${label}.stopRule`, 4_000), severity: value.severity };
}

function normalizeBaseline(value: ResearchBaseline, label: string, citationIds: ReadonlySet<string>): ResearchBaseline {
  const sourceEvidenceIds = identifierList(value.sourceEvidenceIds ?? [], `${label}.sourceEvidenceIds`, 32);
  for (const id of sourceEvidenceIds) requireCitation(id, citationIds, `${label}.sourceEvidenceIds`);
  return { id: identifier(value.id, `${label}.id`), label: bounded(value.label, `${label}.label`, 1_000), rationale: bounded(value.rationale, `${label}.rationale`, 4_000), sourceEvidenceIds, rerunRequired: value.rerunRequired !== false };
}

function normalizeEvaluation(value: ResearchEvaluationPlan, label: string): ResearchEvaluationPlan {
  const metrics = textList(value.metrics, `${label}.metrics`, 32);
  if (metrics.length === 0) throw new TypeError(`${label}.metrics must contain at least one metric.`);
  return { protocol: bounded(value.protocol, `${label}.protocol`, 8_000), primaryMetric: bounded(value.primaryMetric, `${label}.primaryMetric`, 1_000), metrics, splits: textList(value.splits, `${label}.splits`, 32), successRule: bounded(value.successRule, `${label}.successRule`, 4_000), ablations: textList(value.ablations ?? [], `${label}.ablations`, 32) };
}

function normalizeCompute(value: ResearchComputePlan, label: string): ResearchComputePlan {
  return { budget: bounded(value.budget, `${label}.budget`, 2_000), hardware: bounded(value.hardware, `${label}.hardware`, 2_000), timeLimit: bounded(value.timeLimit, `${label}.timeLimit`, 2_000), reproducibilityNotes: bounded(value.reproducibilityNotes, `${label}.reproducibilityNotes`, 4_000) };
}

function normalizeEthics(value: ResearchEthicsPlan, label: string): ResearchEthicsPlan {
  const risks = textList(value.risks, `${label}.risks`, 32);
  const mitigations = textList(value.mitigations, `${label}.mitigations`, 32);
  if (risks.length === 0 || mitigations.length === 0) throw new TypeError(`${label} must include risks and mitigations.`);
  return { risks, mitigations, exclusions: textList(value.exclusions ?? [], `${label}.exclusions`, 32), approvalRequired: value.approvalRequired === true };
}

function normalizeConstraints(values: readonly ResearchDesignConstraint[], citationIds: ReadonlySet<string>): ResearchDesignConstraint[] {
  const ids = new Set<string>();
  return values.map((value, index) => {
    const label = `constraints[${index}]`;
    if (!["baseline", "evaluation", "compute", "ethics", "data", "venue", "timeline"].includes(value.kind)) throw new TypeError(`${label}.kind is invalid.`);
    if (!["satisfied", "unknown", "blocked"].includes(value.status)) throw new TypeError(`${label}.status is invalid.`);
    const id = identifier(value.id, `${label}.id`);
    if (ids.has(id)) throw new TypeError(`Constraint ${id} is duplicated.`);
    ids.add(id);
    const evidenceIds = identifierList(value.evidenceIds ?? [], `${label}.evidenceIds`, 32);
    for (const evidenceId of evidenceIds) requireCitation(evidenceId, citationIds, `${label}.evidenceIds`);
    return { id, kind: value.kind, statement: bounded(value.statement, `${label}.statement`, 4_000), status: value.status, required: value.required !== false, evidenceIds };
  });
}

function normalizeCitations(values: readonly EvidenceCitation[]): EvidenceCitation[] {
  const ids = new Set<string>();
  return values.map((value, index) => {
    const label = `citations[${index}]`;
    const id = identifier(value.id, `${label}.id`);
    if (ids.has(id)) throw new TypeError(`Citation ${id} is duplicated.`);
    ids.add(id);
    const citation: EvidenceCitation = { id, sourceId: identifier(value.sourceId, `${label}.sourceId`), ...(value.recordId === undefined ? {} : { recordId: identifier(value.recordId, `${label}.recordId`) }), ...(value.locator === undefined ? {} : { locator: bounded(value.locator, `${label}.locator`, 4_096) }), claim: bounded(value.claim, `${label}.claim`, 8_000), role: value.role, strength: value.strength, ...(value.artifactRef === undefined ? {} : { artifactRef: value.artifactRef }) };
    if (!["prior_art", "gap", "method", "baseline", "evaluation", "ethics", "data"].includes(citation.role)) throw new TypeError(`${label}.role is invalid.`);
    if (!["direct", "indirect"].includes(citation.strength)) throw new TypeError(`${label}.strength is invalid.`);
    return citation;
  });
}

function normalizeIndependentCriticisms(
  values: readonly Omit<IndependentCriticism, "independent">[],
  candidateIds: ReadonlySet<string>,
  evidenceIds: ReadonlySet<string>,
): IndependentCriticism[] {
  return values.map((value, index) => {
    const label = `independentCriticisms[${index}]`;
    if (!["low", "medium", "high"].includes(value.severity)) throw new TypeError(`${label}.severity is invalid.`);
    if (value.status !== "open" && value.status !== "resolved") throw new TypeError(`${label}.status is invalid.`);
    const candidateId = knownCandidate(value.candidateId, candidateIds, label);
    const cited = knownEvidence(value.evidenceIds, evidenceIds, `${label}.evidenceIds`);
    return {
      id: identifier(value.id, `${label}.id`),
      candidateId,
      reviewerId: identifier(value.reviewerId, `${label}.reviewerId`),
      category: value.category,
      severity: value.severity,
      status: value.status,
      statement: bounded(value.statement, `${label}.statement`, 8_000),
      resolution: bounded(value.resolution, `${label}.resolution`, 8_000),
      evidenceIds: cited,
      independent: true,
    };
  });
}

function normalizeSimilarWorkRescans(
  values: readonly SimilarWorkRescan[],
  candidateIds: ReadonlySet<string>,
  evidenceIds: ReadonlySet<string>,
): SimilarWorkRescan[] {
  return values.map((value, index) => {
    const label = `similarWorkRescans[${index}]`;
    if (!["distinct", "overlap", "inconclusive"].includes(value.outcome)) throw new TypeError(`${label}.outcome is invalid.`);
    return {
      id: identifier(value.id, `${label}.id`),
      candidateId: knownCandidate(value.candidateId, candidateIds, label),
      query: bounded(value.query, `${label}.query`, 4_000),
      comparedWork: bounded(value.comparedWork, `${label}.comparedWork`, 4_000),
      mechanismComparison: bounded(value.mechanismComparison, `${label}.mechanismComparison`, 8_000),
      outcome: value.outcome,
      evidenceIds: knownEvidence(value.evidenceIds, evidenceIds, `${label}.evidenceIds`),
    };
  });
}

function normalizeEvidenceRescans(
  values: readonly EvidenceRescan[],
  candidateIds: ReadonlySet<string>,
  evidenceIds: ReadonlySet<string>,
): EvidenceRescan[] {
  return values.map((value, index) => {
    const label = `evidenceRescans[${index}]`;
    if (!["supports", "contradicts", "inconclusive"].includes(value.outcome)) throw new TypeError(`${label}.outcome is invalid.`);
    return {
      id: identifier(value.id, `${label}.id`),
      candidateId: knownCandidate(value.candidateId, candidateIds, label),
      query: bounded(value.query, `${label}.query`, 4_000),
      sourceIds: identifierList(value.sourceIds, `${label}.sourceIds`, 64),
      claimChecked: bounded(value.claimChecked, `${label}.claimChecked`, 8_000),
      outcome: value.outcome,
      evidenceIds: knownEvidence(value.evidenceIds, evidenceIds, `${label}.evidenceIds`),
    };
  });
}

function normalizeContradictions(
  values: readonly ContradictionRecord[],
  candidateIds: ReadonlySet<string>,
  evidenceIds: ReadonlySet<string>,
): ContradictionRecord[] {
  return values.map((value, index) => {
    const label = `contradictions[${index}]`;
    if (!["open", "resolved", "accepted"].includes(value.status)) throw new TypeError(`${label}.status is invalid.`);
    if (value.status === "resolved" && value.resolution === undefined) throw new TypeError(`${label}.resolution is required when resolved.`);
    return {
      id: identifier(value.id, `${label}.id`),
      candidateId: knownCandidate(value.candidateId, candidateIds, label),
      claim: bounded(value.claim, `${label}.claim`, 8_000),
      counterClaim: bounded(value.counterClaim, `${label}.counterClaim`, 8_000),
      evidenceIds: knownEvidence(value.evidenceIds, evidenceIds, `${label}.evidenceIds`),
      status: value.status,
      ...(value.resolution === undefined ? {} : { resolution: bounded(value.resolution, `${label}.resolution`, 8_000) }),
    };
  });
}

function knownCandidate(value: string, candidates: ReadonlySet<string>, label: string): string {
  const candidateId = identifier(value, `${label}.candidateId`);
  if (!candidates.has(candidateId)) throw new TypeError(`${label} references unknown candidate ${candidateId}.`);
  return candidateId;
}

function knownEvidence(values: readonly string[], evidence: ReadonlySet<string>, label: string): string[] {
  const ids = identifierList(values, label, 128);
  for (const id of ids) {
    if (!evidence.has(id)) throw new TypeError(`${label} references unknown evidence ${id}.`);
  }
  return ids;
}

function sourceRecords(citations: readonly EvidenceCitation[]): ResearchArtifactSource[] {
  return citations.map((citation) => ({ sourceId: citation.sourceId, ...(citation.recordId === undefined ? {} : { recordId: citation.recordId }), ...(citation.locator === undefined ? {} : { locator: citation.locator }) }));
}

function finding(candidateId: string, category: ChallengeFinding["category"], severity: ResearchDesignSeverity, statement: string, resolution: string, evidenceIds: readonly string[], id = `${candidateId}-${category}-${randomUUID()}`): ChallengeFinding {
  return { id, candidateId, category, severity, statement, resolution, evidenceIds };
}

function refOfUnknown(value: unknown): value is ResearchArtifactEnvelope {
  return Boolean(value && typeof value === "object" && "artifactId" in value && "contentHash" in value && "kind" in value && "revision" in value);
}

function requireCitation(id: string, citationIds: ReadonlySet<string>, label: string): void {
  if (!citationIds.has(id)) throw new TypeError(`${label} references unknown citation ${id}.`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256 || value.includes("\u0000")) throw new TypeError(`${label} must be a trimmed non-empty identifier.`);
  return value;
}

function identifierList(value: readonly string[], label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} must contain at most ${maximum} identifiers.`);
  const result = value.map((item, index) => identifier(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} must not contain duplicates.`);
  return result;
}

function textList(value: readonly string[], label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} must contain at most ${maximum} entries.`);
  return value.map((item, index) => bounded(item, `${label}[${index}]`, 8_000));
}

function bounded(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\u0000")) throw new TypeError(`${label} must be bounded non-empty text.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${label} must be a positive integer.`);
  return value as number;
}

export function isResearchArtifactEnvelope(value: unknown): value is ResearchArtifactEnvelope {
  return refOfUnknown(value);
}
