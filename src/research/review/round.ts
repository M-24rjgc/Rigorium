import { randomUUID } from "node:crypto";
import {
  createResearchArtifact,
  toResearchArtifactRef,
  type ResearchArtifactParent,
  type ResearchArtifactRef,
} from "../artifacts/index.js";
import {
  REVIEWER_LANES,
  type ManuscriptLocation,
  type ReviewFindingArtifact,
  type ReviewLaneSummary,
  type ReviewLaneVerdict,
  type ReviewPreflightCheck,
  type ReviewRoundInput,
  type ReviewRoundPackage,
  type ReviewerLane,
  type ReviewerLaneReport,
} from "./contracts.js";
import { aggregateReviewFindings } from "./findings.js";
import { runDeterministicReviewPreflight } from "./preflight.js";
import {
  assertReviewableManuscript,
  fullRefKey,
  identifier,
  isoDate,
  normalizeLocation,
  normalizeTarget,
} from "./validation.js";

export function createReviewRound(input: ReviewRoundInput): ReviewRoundPackage {
  if (!input || typeof input !== "object") throw new TypeError("ReviewRound input must be an object.");
  const manuscript = assertReviewableManuscript(input.manuscript);
  const manuscriptRef = toResearchArtifactRef(manuscript);
  const reports = normalizeLaneReports(input.laneReports);
  const preflight = runDeterministicReviewPreflight(input);
  const reviewerDrafts = reports.flatMap((report) => report.findings);
  for (const finding of [...preflight.findings, ...reviewerDrafts]) {
    assertLocationInManuscript(finding.location, manuscript);
  }

  const reviewRoundId = identifier(
    input.artifactId ?? `review-round-${randomUUID()}`,
    "ReviewRound artifactId",
  );
  const now = input.now ?? new Date();
  const producer = input.producer ?? { kind: "tool" as const, toolName: "research_review" };
  const aggregation = aggregateReviewFindings({
    reviewRoundId,
    manuscriptRef,
    drafts: [...preflight.findings, ...reviewerDrafts],
    producer,
    now,
  });
  const checks = materializePreflightFindingIds(preflight.checks, aggregation.findings);
  const laneSummaries = REVIEWER_LANES.map((lane) => laneSummary(lane, reports, aggregation.findings));
  const status = overallVerdict(aggregation.findings);
  const findingRefs = aggregation.findings.map(toResearchArtifactRef);
  const parents: ResearchArtifactParent[] = [
    { relation: "derived_from", artifact: manuscriptRef },
    ...findingRefs.map((artifact): ResearchArtifactParent => ({ relation: "uses", artifact })),
  ];
  if (input.renderRun) parents.push({ relation: "uses", artifact: toResearchArtifactRef(input.renderRun) });
  if (input.citationSet) parents.push({ relation: "uses", artifact: toResearchArtifactRef(input.citationSet) });

  const reviewRound = createResearchArtifact({
    kind: "review_round",
    artifactId: reviewRoundId,
    payload: Object.freeze({
      schemaVersion: 1 as const,
      kind: "review_round" as const,
      reviewRoundId,
      manuscriptRef,
      ...(input.renderRun === undefined ? {} : { renderRunRef: toResearchArtifactRef(input.renderRun) }),
      ...(input.citationSet === undefined ? {} : { citationSetRef: toResearchArtifactRef(input.citationSet) }),
      target: normalizeTarget(manuscript.payload.target),
      preflightChecks: Object.freeze(checks),
      laneSummaries: Object.freeze(laneSummaries),
      findingRefs: Object.freeze(findingRefs),
      contradictions: aggregation.contradictions,
      status,
      completedAt: isoDate(now, "ReviewRound completion time"),
    }),
    producer,
    parents: uniqueParents(parents),
    now,
  });
  return Object.freeze({ reviewRound, findings: aggregation.findings });
}

function normalizeLaneReports(value: readonly ReviewerLaneReport[]): ReviewerLaneReport[] {
  if (!Array.isArray(value) || value.length !== REVIEWER_LANES.length) {
    throw new TypeError(`ReviewRound requires exactly ${REVIEWER_LANES.length} independent lane reports.`);
  }
  const reports = new Map<ReviewerLane, ReviewerLaneReport>();
  const reviewers = new Set<string>();
  for (const [index, report] of value.entries()) {
    if (!report || typeof report !== "object" || !REVIEWER_LANES.includes(report.lane)) {
      throw new TypeError(`Review lane report ${index} has an invalid lane.`);
    }
    if (report.independent !== true) throw new TypeError(`Review lane ${report.lane} must be independent.`);
    if (reports.has(report.lane)) throw new TypeError(`Review lane ${report.lane} is duplicated.`);
    const reviewerId = identifier(report.reviewerId, `review lane ${report.lane} reviewerId`);
    if (reviewerId === "deterministic-preflight") {
      throw new TypeError("deterministic-preflight is reserved for the preflight checker.");
    }
    if (reviewers.has(reviewerId)) {
      throw new TypeError(`Reviewer ${reviewerId} cannot serve more than one independent lane in the same round.`);
    }
    reviewers.add(reviewerId);
    if (!Array.isArray(report.findings)) throw new TypeError(`Review lane ${report.lane} findings must be an array.`);
    for (const finding of report.findings) {
      if (finding.lane !== report.lane || finding.reviewerId !== reviewerId) {
        throw new TypeError(`Every ${report.lane} finding must retain its lane and reviewer identity.`);
      }
    }
    reports.set(report.lane, Object.freeze({
      lane: report.lane,
      reviewerId,
      independent: true as const,
      findings: Object.freeze([...report.findings]),
    }));
  }
  for (const lane of REVIEWER_LANES) {
    if (!reports.has(lane)) throw new TypeError(`ReviewRound is missing the ${lane} lane.`);
  }
  return REVIEWER_LANES.map((lane) => reports.get(lane)!);
}

function assertLocationInManuscript(
  value: ManuscriptLocation,
  manuscript: ReviewRoundInput["manuscript"],
): void {
  const location = normalizeLocation(value);
  const section = manuscript.payload.sections.find((candidate) => candidate.sectionId === location.sectionId);
  if (!section) throw new TypeError(`Review finding location references unknown section ${location.sectionId}.`);
  if (location.statementId !== undefined
    && !section.statements.some((statement) => statement.statementId === location.statementId)) {
    throw new TypeError(`Review finding location references unknown statement ${location.statementId}.`);
  }
}

function laneSummary(
  lane: ReviewerLane,
  reports: readonly ReviewerLaneReport[],
  findings: readonly ReviewFindingArtifact[],
): ReviewLaneSummary {
  const report = reports.find((candidate) => candidate.lane === lane)!;
  const laneFindings = findings.filter((finding) => finding.payload.lanes.includes(lane));
  const concerns = laneFindings.filter((finding) => finding.payload.assessment === "concern");
  const verdict: ReviewLaneVerdict = concerns.some((finding) => finding.payload.severity === "blocker")
    ? "blocked"
    : concerns.length > 0 ? "needs_changes" : "pass";
  return Object.freeze({
    lane,
    reviewerId: report.reviewerId,
    independent: true as const,
    verdict,
    findingRefs: Object.freeze(laneFindings.map(toResearchArtifactRef).sort(compareRefs)),
  });
}

function overallVerdict(findings: readonly ReviewFindingArtifact[]): ReviewLaneVerdict {
  const concerns = findings.filter((finding) => finding.payload.assessment === "concern");
  if (concerns.some((finding) => finding.payload.severity === "blocker")) return "blocked";
  return concerns.length > 0 ? "needs_changes" : "pass";
}

function materializePreflightFindingIds(
  checks: readonly ReviewPreflightCheck[],
  findings: readonly ReviewFindingArtifact[],
): ReviewPreflightCheck[] {
  return checks.map((check) => {
    const sourceIds = new Set(check.findingIds);
    const findingIds = findings
      .filter((finding) => finding.payload.mergedFromFindingIds.some((id) => sourceIds.has(id)))
      .map((finding) => finding.payload.findingId)
      .sort(compareText);
    return Object.freeze({ ...check, findingIds: Object.freeze(findingIds) });
  });
}

function uniqueParents(parents: readonly ResearchArtifactParent[]): ResearchArtifactParent[] {
  const byKey = new Map<string, ResearchArtifactParent>();
  for (const parent of parents) byKey.set(`${parent.relation}:${fullRefKey(parent.artifact)}`, parent);
  return [...byKey.entries()].sort(([left], [right]) => compareText(left, right)).map(([, parent]) => parent);
}

function compareRefs(left: ResearchArtifactRef, right: ResearchArtifactRef): number {
  return compareText(fullRefKey(left), fullRefKey(right));
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}
