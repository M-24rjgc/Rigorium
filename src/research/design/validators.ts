import {
  hashResearchArtifactContent,
  type ResearchArtifactEnvelope,
} from "../artifacts/index.js";
import {
  buildCandidatePortfolioPayload,
  type CandidatePortfolioArtifact,
  type ChallengeReportArtifact,
  type DecisionRecordArtifact,
  type ResearchBriefArtifact,
} from "./contracts.js";
import { compareResearchCandidates, normalizeEliminationRecords } from "./comparison.js";

export type ResearchDesignValidationIssue = Readonly<{
  path: string;
  code: "invalid_envelope" | "invalid_payload" | "invalid_reference" | "invalid_comparison";
  message: string;
}>;

export type ResearchDesignValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; issues: readonly ResearchDesignValidationIssue[] }>;

export function validateResearchDesignArtifact(artifact: ResearchArtifactEnvelope): ResearchDesignValidationResult {
  const issues: ResearchDesignValidationIssue[] = [];
  try {
    validateEnvelopeHash(artifact);
    if (artifact.kind === "candidate_portfolio") validateCandidatePortfolioArtifact(artifact as CandidatePortfolioArtifact);
    if (artifact.kind === "challenge_report") validateChallengeReportArtifact(artifact as ChallengeReportArtifact);
    if (artifact.kind === "decision_record") validateDecisionRecordArtifact(artifact as DecisionRecordArtifact);
    if (artifact.kind === "research_brief") validateResearchBriefArtifact(artifact as ResearchBriefArtifact);
  } catch (error) {
    issues.push({ path: "$", code: classify(error), message: messageOf(error) });
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues: Object.freeze(issues) };
}

export function assertValidResearchDesignArtifact(artifact: ResearchArtifactEnvelope): void {
  const result = validateResearchDesignArtifact(artifact);
  if (!result.ok) throw new TypeError(result.issues.map((issue) => issue.message).join("; "));
}

export function validateCandidatePortfolioArtifact(artifact: CandidatePortfolioArtifact): void {
  requireKind(artifact, "candidate_portfolio");
  const payload = artifact.payload;
  const rebuilt = buildCandidatePortfolioPayload({
    entry: payload.entry,
    idea: payload.idea,
    candidates: payload.candidates,
    constraints: payload.constraints,
    evidenceRequest: payload.evidence.request,
    citations: payload.evidence.citations,
    compatibility: payload.compatibility,
  });
  if (hashResearchArtifactContent(rebuilt) !== hashResearchArtifactContent(payload)) {
    throw new TypeError("CandidatePortfolio payload is not canonical.");
  }
}

export function validateChallengeReportArtifact(artifact: ChallengeReportArtifact): void {
  requireKind(artifact, "challenge_report");
  const payload = artifact.payload;
  const candidateIds = new Set(Object.keys(payload.candidateVerdicts));
  const findingIds = new Set<string>();
  for (const finding of payload.findings) {
    if (findingIds.has(finding.id)) throw new TypeError(`Challenge finding ${finding.id} is duplicated.`);
    findingIds.add(finding.id);
    if (!candidateIds.has(finding.candidateId)) throw new TypeError(`Challenge finding ${finding.id} references an unknown candidate.`);
  }
  for (const id of payload.unresolved) {
    const finding = payload.findings.find((item) => item.id === id);
    if (!finding || finding.severity !== "high") throw new TypeError(`Unresolved challenge ${id} is not a high-severity finding.`);
  }
  if (payload.status === "ready" && payload.unresolved.length > 0) {
    throw new TypeError("A ready ChallengeReport cannot contain unresolved high-severity findings.");
  }
}

export function validateDecisionRecordArtifact(artifact: DecisionRecordArtifact): void {
  requireKind(artifact, "decision_record");
  const payload = artifact.payload;
  const candidateIds = new Set(payload.comparison.rows.map((row) => row.candidateId));
  if (payload.choice !== null && !candidateIds.has(payload.choice)) throw new TypeError("Decision choice is absent from its comparison.");
  if (payload.status === "selected" && payload.choice === null) throw new TypeError("A selected DecisionRecord requires a choice.");
  const retained = payload.eliminations.filter((record) => record.outcome === "retained").map((record) => record.candidateId);
  if (payload.choice !== null && payload.eliminations.some((record) => record.candidateId === payload.choice && record.outcome === "eliminated")) {
    throw new TypeError("Decision choice is also marked eliminated.");
  }
  if (payload.status === "selected" && retained.length > 0 && !retained.includes(payload.choice!)) {
    throw new TypeError("Selected decision does not match a retained candidate.");
  }
}

export function validateComparisonAgainstPortfolio(input: {
  portfolio: CandidatePortfolioArtifact;
  decision: DecisionRecordArtifact;
}): void {
  const expected = compareResearchCandidates({
    portfolio: input.portfolio,
    objectives: input.decision.payload.comparison.objectives,
    assessments: input.decision.payload.comparison.assessments,
  });
  if (hashResearchArtifactContent(expected) !== hashResearchArtifactContent(input.decision.payload.comparison)) {
    throw new TypeError("DecisionRecord comparison is not reproducible from its objective assessments.");
  }
  normalizeEliminationRecords({
    portfolio: input.portfolio,
    comparison: expected,
    records: input.decision.payload.eliminations,
  });
}

export function validateResearchBriefArtifact(artifact: ResearchBriefArtifact): void {
  requireKind(artifact, "research_brief");
  const payload = artifact.payload;
  if (payload.title.status === "confirmed") {
    if (!payload.title.text || !payload.title.confirmedBy || !payload.title.confirmedAt) {
      throw new TypeError("A confirmed ResearchBrief title requires text, confirmer, and timestamp.");
    }
  } else if (payload.title.confirmedBy !== undefined || payload.title.confirmedAt !== undefined) {
    throw new TypeError("Unconfirmed ResearchBrief title contains confirmation metadata.");
  }
  if (payload.status === "ready" && payload.candidateId === null) throw new TypeError("A ready ResearchBrief requires a candidate.");
  if (payload.candidateId === null && (payload.hypotheses.length > 0 || payload.evaluationPlan !== null)) {
    throw new TypeError("An unselected ResearchBrief cannot claim candidate-specific design details.");
  }
}

function validateEnvelopeHash(artifact: ResearchArtifactEnvelope): void {
  const expected = hashResearchArtifactContent({
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    kind: artifact.kind,
    parents: artifact.parents,
    sources: artifact.sources,
    payload: artifact.payload,
  });
  if (expected !== artifact.contentHash) throw new TypeError("Research artifact contentHash does not match its envelope content.");
}

function requireKind<TKind extends ResearchArtifactEnvelope["kind"]>(artifact: ResearchArtifactEnvelope, kind: TKind): void {
  if (artifact.schemaVersion !== 1 || artifact.kind !== kind) throw new TypeError(`Expected a ${kind} research artifact.`);
}

function classify(error: unknown): ResearchDesignValidationIssue["code"] {
  const message = messageOf(error);
  if (/contentHash|envelope/iu.test(message)) return "invalid_envelope";
  if (/comparison|objective|score/iu.test(message)) return "invalid_comparison";
  if (/reference|unknown candidate|absent/iu.test(message)) return "invalid_reference";
  return "invalid_payload";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
