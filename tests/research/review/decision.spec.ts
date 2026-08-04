import assert from "node:assert/strict";
import test from "node:test";
import {
  createResearchArtifact,
  toResearchArtifactRef,
} from "../../../src/research/artifacts/index.js";
import { createRevisionDecision } from "../../../src/research/review/decision.js";
import { createReviewRound } from "../../../src/research/review/round.js";
import {
  REVIEW_NOW,
  createFindingDraft,
  createLaneReports,
  createSyntheticReviewArtifacts,
} from "./fixtures.js";

function reviewWithConcern() {
  const fixture = createSyntheticReviewArtifacts();
  const manuscriptRef = toResearchArtifactRef(fixture.manuscript);
  const reports = createLaneReports(manuscriptRef, {
    method: [createFindingDraft({
      id: "revision-concern",
      lane: "method",
      reviewerId: "reviewer-1-method",
      manuscriptRef,
    })],
  });
  const review = createReviewRound({
    manuscript: fixture.manuscript,
    renderRun: fixture.render,
    citationSet: fixture.citations,
    evidencePacks: [fixture.evidence],
    figureTableArtifacts: [fixture.figure],
    runAttempts: [fixture.run],
    laneReports: reports,
    artifactId: "review-round-decision",
    now: REVIEW_NOW,
  });
  const unrelated = createResearchArtifact({
    kind: "method_spec",
    artifactId: "unrelated-method",
    payload: { fixture: true },
    producer: { kind: "user" },
    now: REVIEW_NOW,
  });
  const artifacts = [
    fixture.evidence,
    fixture.citations,
    fixture.figure,
    fixture.run,
    fixture.manuscript,
    fixture.render,
    ...review.findings,
    review.reviewRound,
    unrelated,
  ];
  return { fixture, review, unrelated, artifacts };
}

test("RevisionDecision keeps revised roots active and stales only active descendants", () => {
  const { fixture, review, unrelated, artifacts } = reviewWithConcern();
  const finding = review.findings[0]!;
  const applied = createRevisionDecision({
    reviewRound: review.reviewRound,
    findings: review.findings,
    resolutions: [{
      findingArtifactId: finding.artifactId,
      disposition: "revise",
      rationale: "Revise the anchored manuscript statement.",
      targetArtifactRefs: [toResearchArtifactRef(fixture.manuscript)],
    }],
    artifacts,
    artifactId: "revision-decision-applied",
    now: REVIEW_NOW,
  });
  const byId = new Map(applied.artifacts.map((artifact) => [artifact.artifactId, artifact]));

  assert.equal(applied.decision.payload.status, "revision_required");
  assert.equal(byId.get(fixture.manuscript.artifactId)?.status, "active");
  assert.equal(byId.get(fixture.render.artifactId)?.status, "stale");
  assert.equal(byId.get(finding.artifactId)?.status, "stale");
  assert.equal(byId.get(review.reviewRound.artifactId)?.status, "stale");
  assert.equal(byId.get(unrelated.artifactId)?.status, "active");
  assert.equal(byId.get(fixture.citations.artifactId)?.status, "active");
  assert.equal(applied.invalidatedArtifactRefs.some((ref) => ref.artifactId === fixture.manuscript.artifactId), false);
});

test("RevisionDecision rejects targets outside the finding and keeps dismissals non-invalidating", () => {
  const { fixture, review, artifacts } = reviewWithConcern();
  const finding = review.findings[0]!;
  assert.throws(() => createRevisionDecision({
    reviewRound: review.reviewRound,
    findings: review.findings,
    resolutions: [{
      findingArtifactId: finding.artifactId,
      disposition: "revise",
      rationale: "Invalid synthetic target.",
      targetArtifactRefs: [toResearchArtifactRef(fixture.evidence)],
    }],
    artifacts,
    now: REVIEW_NOW,
  }), /outside the finding's affectedArtifactRefs/iu);

  const dismissed = createRevisionDecision({
    reviewRound: review.reviewRound,
    findings: review.findings,
    resolutions: [{
      findingArtifactId: finding.artifactId,
      disposition: "dismiss",
      rationale: "The concern is not applicable to this synthetic fixture.",
      targetArtifactRefs: [],
    }],
    artifacts,
    artifactId: "revision-decision-dismissed",
    now: REVIEW_NOW,
  });
  assert.equal(dismissed.decision.payload.status, "no_revision");
  assert.equal(dismissed.invalidatedArtifactRefs.length, 0);
  assert.equal(dismissed.artifacts.filter((artifact) => artifact.artifactId !== dismissed.decision.artifactId)
    .every((artifact) => artifact.status === "active"), true);
});
