import assert from "node:assert/strict";
import test from "node:test";
import { toResearchArtifactRef } from "../../../src/research/artifacts/index.js";
import { createReviewRound } from "../../../src/research/review/round.js";
import {
  REVIEW_NOW,
  createFindingDraft,
  createLaneReports,
  createSyntheticReviewArtifacts,
} from "./fixtures.js";

test("ReviewRound requires and records all seven independent lanes", () => {
  const fixture = createSyntheticReviewArtifacts();
  const round = createReviewRound({
    manuscript: fixture.manuscript,
    renderRun: fixture.render,
    citationSet: fixture.citations,
    evidencePacks: [fixture.evidence],
    figureTableArtifacts: [fixture.figure],
    runAttempts: [fixture.run],
    laneReports: createLaneReports(toResearchArtifactRef(fixture.manuscript)),
    artifactId: "review-round-clean",
    now: REVIEW_NOW,
  });

  assert.equal(round.reviewRound.payload.status, "pass");
  assert.equal(round.reviewRound.payload.laneSummaries.length, 7);
  assert.equal(round.reviewRound.payload.laneSummaries.every((lane) => lane.independent && lane.verdict === "pass"), true);
  assert.equal(round.findings.length, 0);
  assert.equal(round.reviewRound.payload.preflightChecks.every((check) => check.status === "passed"), true);
});

test("ReviewRound merges compatible concerns and preserves concern-cleared contradictions", () => {
  const fixture = createSyntheticReviewArtifacts();
  const manuscriptRef = toResearchArtifactRef(fixture.manuscript);
  const common = {
    manuscriptRef,
    dedupeKey: "synthetic:shared-assessment",
    summary: "The synthetic result requires an explicit assumption.",
    category: "method" as const,
  };
  const reports = createLaneReports(manuscriptRef, {
    method: [createFindingDraft({ ...common, id: "method-concern", lane: "method", reviewerId: "reviewer-1-method" })],
    theory: [createFindingDraft({ ...common, id: "theory-concern", lane: "theory", reviewerId: "reviewer-2-theory" })],
    evidence: [createFindingDraft({
      ...common,
      id: "evidence-cleared",
      lane: "evidence",
      reviewerId: "reviewer-4-evidence",
      assessment: "cleared",
    })],
  });
  const round = createReviewRound({
    manuscript: fixture.manuscript,
    renderRun: fixture.render,
    citationSet: fixture.citations,
    evidencePacks: [fixture.evidence],
    figureTableArtifacts: [fixture.figure],
    runAttempts: [fixture.run],
    laneReports: reports,
    artifactId: "review-round-contradiction",
    now: REVIEW_NOW,
  });

  assert.equal(round.findings.length, 2);
  const concern = round.findings.find((finding) => finding.payload.assessment === "concern")!;
  assert.deepEqual(concern.payload.lanes, ["method", "theory"]);
  assert.deepEqual(concern.payload.mergedFromFindingIds, ["method-concern", "theory-concern"]);
  assert.equal(round.reviewRound.payload.contradictions.length, 1);
  assert.equal(round.reviewRound.payload.contradictions[0]?.findingRefs.length, 2);
  assert.equal(round.findings.every((finding) => finding.payload.contradictionGroupId
    === round.reviewRound.payload.contradictions[0]?.id), true);
  assert.equal(round.reviewRound.payload.status, "needs_changes");
});

test("ReviewRound rejects missing lanes, reused reviewer identities, and unknown anchors", () => {
  const fixture = createSyntheticReviewArtifacts();
  const manuscriptRef = toResearchArtifactRef(fixture.manuscript);
  const reports = createLaneReports(manuscriptRef);
  assert.throws(() => createReviewRound({
    manuscript: fixture.manuscript,
    laneReports: reports.slice(0, 6),
  }), /exactly 7 independent lane reports/iu);

  const repeatedReviewer = reports.map((report, index) => index === 1
    ? { ...report, reviewerId: reports[0]!.reviewerId }
    : report);
  assert.throws(() => createReviewRound({
    manuscript: fixture.manuscript,
    laneReports: repeatedReviewer,
  }), /cannot serve more than one independent lane/iu);

  const invalidFinding = {
    ...createFindingDraft({ id: "bad-anchor", lane: "method", reviewerId: "reviewer-1-method", manuscriptRef }),
    location: { sectionId: "missing-section", anchorText: "Unknown" },
  };
  assert.throws(() => createReviewRound({
    manuscript: fixture.manuscript,
    laneReports: createLaneReports(manuscriptRef, { method: [invalidFinding] }),
  }), /unknown section/iu);
});
