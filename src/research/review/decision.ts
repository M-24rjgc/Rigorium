import { randomUUID } from "node:crypto";
import {
  buildResearchArtifactGraph,
  createResearchArtifact,
  invalidateResearchArtifactDescendants,
  toResearchArtifactRef,
  type ResearchArtifactEnvelope,
  type ResearchArtifactParent,
  type ResearchArtifactRef,
} from "../artifacts/index.js";
import type {
  AppliedRevisionDecision,
  RevisionDecisionEntry,
  RevisionDecisionInput,
  RevisionDisposition,
  ReviewFindingArtifact,
} from "./contracts.js";
import {
  fullRefKey,
  identifier,
  isoDate,
  mergeRefs,
  sameRef,
  text,
  uniqueRefs,
} from "./validation.js";

const DISPOSITIONS = new Set<RevisionDisposition>(["revise", "dismiss", "defer"]);

export function createRevisionDecision(input: RevisionDecisionInput): AppliedRevisionDecision {
  if (!input || typeof input !== "object") throw new TypeError("RevisionDecision input must be an object.");
  assertReviewRound(input.reviewRound);
  if (!Array.isArray(input.findings) || !Array.isArray(input.resolutions) || !Array.isArray(input.artifacts)) {
    throw new TypeError("RevisionDecision findings, resolutions, and artifacts must be arrays.");
  }
  const findings = validateFindings(input.findings, input.reviewRound.payload.reviewRoundId);
  assertRoundFindingSet(input.reviewRound.payload.findingRefs, findings);
  const findingsById = new Map(findings.map((finding) => [finding.artifactId, finding]));
  const resolutionIds = new Set<string>();
  const decisions: RevisionDecisionEntry[] = [];

  for (const [index, resolution] of input.resolutions.entries()) {
    if (!resolution || typeof resolution !== "object") throw new TypeError(`Revision resolution ${index} must be an object.`);
    const findingArtifactId = identifier(resolution.findingArtifactId, `resolution ${index} findingArtifactId`);
    if (resolutionIds.has(findingArtifactId)) throw new TypeError(`Finding ${findingArtifactId} has duplicate resolutions.`);
    resolutionIds.add(findingArtifactId);
    const finding = findingsById.get(findingArtifactId);
    if (!finding) throw new TypeError(`Resolution references finding ${findingArtifactId}, which is outside the ReviewRound.`);
    if (!DISPOSITIONS.has(resolution.disposition)) throw new TypeError(`Resolution ${index} has an invalid disposition.`);
    const targetArtifactRefs = uniqueRefs(resolution.targetArtifactRefs, `resolution ${index} targetArtifactRefs`);
    const affected = new Set(finding.payload.affectedArtifactRefs.map(fullRefKey));
    if (targetArtifactRefs.some((ref) => !affected.has(fullRefKey(ref)))) {
      throw new TypeError(`Resolution for ${findingArtifactId} targets an artifact outside the finding's affectedArtifactRefs.`);
    }
    if (resolution.disposition === "revise" && targetArtifactRefs.length === 0) {
      throw new TypeError(`Revise resolution for ${findingArtifactId} must target at least one affected artifact.`);
    }
    if (resolution.disposition !== "revise" && targetArtifactRefs.length > 0) {
      throw new TypeError(`${resolution.disposition} resolution for ${findingArtifactId} must not invalidate artifacts.`);
    }
    decisions.push(Object.freeze({
      findingRef: toResearchArtifactRef(finding),
      disposition: resolution.disposition,
      rationale: text(resolution.rationale, `resolution ${index} rationale`, 8_000),
      targetArtifactRefs: Object.freeze(targetArtifactRefs),
    }));
  }
  if (resolutionIds.size !== findings.length) {
    const unresolved = findings.filter((finding) => !resolutionIds.has(finding.artifactId)).map((finding) => finding.artifactId);
    throw new TypeError(`Every ReviewRound finding needs one resolution; missing: ${unresolved.join(", ")}.`);
  }
  decisions.sort((left, right) => compareRefs(left.findingRef, right.findingRef));

  const invalidationRootRefs = mergeRefs(decisions
    .filter((decision) => decision.disposition === "revise")
    .map((decision) => decision.targetArtifactRefs));
  buildResearchArtifactGraph(input.artifacts);
  const artifactRefs = new Map(input.artifacts.map((artifact) => [fullRefKey(toResearchArtifactRef(artifact)), artifact]));
  assertArtifactPresent(input.reviewRound, artifactRefs, "ReviewRound");
  for (const finding of findings) assertArtifactPresent(finding, artifactRefs, `finding ${finding.artifactId}`);
  for (const root of invalidationRootRefs) {
    const artifact = artifactRefs.get(fullRefKey(root));
    if (!artifact || artifact.status !== "active") {
      throw new TypeError(`Revision target ${fullRefKey(root)} must be present as an active artifact.`);
    }
  }

  const now = input.now ?? new Date();
  const invalidated = invalidationRootRefs.length === 0
    ? [...input.artifacts]
    : invalidateResearchArtifactDescendants({
        artifacts: input.artifacts,
        roots: invalidationRootRefs,
        reason: "review_finding",
        now,
      });
  const invalidatedArtifactRefs = changedToStale(input.artifacts, invalidated);
  const producer = input.producer ?? { kind: "tool" as const, toolName: "research_review" };
  const decisionArtifactId = identifier(
    input.artifactId ?? `revision-decision-${randomUUID()}`,
    "RevisionDecision artifactId",
  );
  if (input.artifacts.some((artifact) => artifact.artifactId === decisionArtifactId)) {
    throw new TypeError(`RevisionDecision artifactId ${decisionArtifactId} already exists.`);
  }
  const parents: ResearchArtifactParent[] = [
    { relation: "uses", artifact: toResearchArtifactRef(input.reviewRound) },
    ...findings.map((finding): ResearchArtifactParent => ({ relation: "uses", artifact: toResearchArtifactRef(finding) })),
  ];
  const decision = createResearchArtifact({
    kind: "revision_decision",
    artifactId: decisionArtifactId,
    payload: Object.freeze({
      schemaVersion: 1 as const,
      kind: "revision_decision" as const,
      reviewRoundRef: toResearchArtifactRef(input.reviewRound),
      decisions: Object.freeze(decisions),
      invalidationRootRefs: Object.freeze(invalidationRootRefs),
      status: decisionStatus(decisions),
      decidedAt: isoDate(now, "RevisionDecision time"),
    }),
    producer,
    parents,
    now,
  });
  return Object.freeze({
    decision,
    artifacts: Object.freeze([...invalidated, decision]),
    invalidatedArtifactRefs: Object.freeze(invalidatedArtifactRefs),
  });
}

function assertReviewRound(value: RevisionDecisionInput["reviewRound"]): void {
  if (!value || value.kind !== "review_round" || value.status !== "active"
    || value.payload?.kind !== "review_round" || value.payload.schemaVersion !== 1) {
    throw new TypeError("RevisionDecision requires an active ReviewRound artifact.");
  }
}

function validateFindings(
  findings: readonly ReviewFindingArtifact[],
  reviewRoundId: string,
): ReviewFindingArtifact[] {
  const byRef = new Set<string>();
  const ids = new Set<string>();
  return findings.map((finding, index) => {
    if (!finding || finding.kind !== "finding" || finding.status !== "active"
      || finding.payload?.kind !== "finding" || finding.payload.schemaVersion !== 1) {
      throw new TypeError(`RevisionDecision finding ${index} must be an active finding artifact.`);
    }
    if (finding.payload.reviewRoundId !== reviewRoundId) {
      throw new TypeError(`Finding ${finding.artifactId} belongs to a different ReviewRound.`);
    }
    const refKey = fullRefKey(toResearchArtifactRef(finding));
    if (byRef.has(refKey) || ids.has(finding.artifactId)) throw new TypeError(`Finding ${finding.artifactId} is duplicated.`);
    byRef.add(refKey);
    ids.add(finding.artifactId);
    return finding;
  });
}

function assertRoundFindingSet(
  expected: readonly ResearchArtifactRef[],
  findings: readonly ReviewFindingArtifact[],
): void {
  if (expected.length !== findings.length) throw new TypeError("RevisionDecision findings do not cover the ReviewRound finding set.");
  const actual = findings.map(toResearchArtifactRef);
  for (const ref of expected) {
    if (!actual.some((candidate) => sameRef(candidate, ref))) {
      throw new TypeError(`RevisionDecision is missing ReviewRound finding ${fullRefKey(ref)}.`);
    }
  }
}

function changedToStale(
  before: readonly ResearchArtifactEnvelope[],
  after: readonly ResearchArtifactEnvelope[],
): ResearchArtifactRef[] {
  const previous = new Map(before.map((artifact) => [fullRefKey(toResearchArtifactRef(artifact)), artifact]));
  return after
    .filter((artifact) => previous.get(fullRefKey(toResearchArtifactRef(artifact)))?.status === "active"
      && artifact.status === "stale")
    .map(toResearchArtifactRef)
    .sort(compareRefs);
}

function decisionStatus(decisions: readonly RevisionDecisionEntry[]): "revision_required" | "deferred" | "no_revision" {
  if (decisions.some((decision) => decision.disposition === "revise")) return "revision_required";
  if (decisions.some((decision) => decision.disposition === "defer")) return "deferred";
  return "no_revision";
}

function assertArtifactPresent(
  expected: ResearchArtifactEnvelope,
  artifacts: ReadonlyMap<string, ResearchArtifactEnvelope>,
  label: string,
): void {
  const actual = artifacts.get(fullRefKey(toResearchArtifactRef(expected)));
  if (!actual || actual.status !== expected.status) {
    throw new TypeError(`RevisionDecision artifact graph must contain the active ${label} envelope.`);
  }
}

function compareRefs(left: ResearchArtifactRef, right: ResearchArtifactRef): number {
  return fullRefKey(left).localeCompare(fullRefKey(right), "en");
}
