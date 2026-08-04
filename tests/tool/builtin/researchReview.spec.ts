import assert from "node:assert/strict";
import test from "node:test";
import { toResearchArtifactRef } from "../../../src/research/artifacts/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { createResearchReviewTool } from "../../../src/tool/builtin/researchReview.js";
import {
  REVIEW_NOW,
  createFindingDraft,
  createLaneReports,
  createSyntheticReviewArtifacts,
} from "../../research/review/fixtures.js";

function context() {
  const cwd = "D:\\synthetic-review-project";
  return {
    sessionId: "session-research-review",
    turnId: "turn-research-review",
    cwd,
    permissionMode: "default" as const,
    permissionContext: createDefaultPermissionContext({ cwd }),
    now: () => REVIEW_NOW,
  };
}

test("research_review wrapper runs a seven-lane round and applies its revision decision", async () => {
  const fixture = createSyntheticReviewArtifacts();
  const manuscriptRef = toResearchArtifactRef(fixture.manuscript);
  const tool = createResearchReviewTool();
  const runInput = {
    action: "run_review" as const,
    manuscript: fixture.manuscript,
    renderRun: fixture.render,
    citationSet: fixture.citations,
    evidencePacks: [fixture.evidence],
    figureTableArtifacts: [fixture.figure],
    runAttempts: [fixture.run],
    laneReports: createLaneReports(manuscriptRef, {
      method: [createFindingDraft({
        id: "tool-review-concern",
        lane: "method",
        reviewerId: "reviewer-1-method",
        manuscriptRef,
      })],
    }),
    artifactId: "tool-review-round",
  };

  assert.equal(tool.isReadOnly(runInput), true);
  assert.equal(tool.isConcurrencySafe(runInput), true);
  assert.equal((await tool.validateInput!(runInput, context())).ok, true);
  const reviewed = await tool.execute(runInput, context());
  assert.equal(reviewed.data?.action, "run_review");
  if (reviewed.data?.action !== "run_review") throw new Error("Expected run_review result.");
  assert.equal(reviewed.data.review.reviewRound.payload.laneSummaries.length, 7);
  assert.equal(reviewed.data.review.findings.length, 1);

  const finding = reviewed.data.review.findings[0]!;
  const artifacts = [
    fixture.evidence,
    fixture.citations,
    fixture.figure,
    fixture.run,
    fixture.manuscript,
    fixture.render,
    ...reviewed.data.review.findings,
    reviewed.data.review.reviewRound,
  ];
  const decisionInput = {
    action: "decide_revision" as const,
    reviewRound: reviewed.data.review.reviewRound,
    findings: reviewed.data.review.findings,
    resolutions: [{
      findingArtifactId: finding.artifactId,
      disposition: "revise" as const,
      rationale: "Revise the synthetic manuscript statement.",
      targetArtifactRefs: [manuscriptRef],
    }],
    artifacts,
    artifactId: "tool-revision-decision",
  };
  assert.equal((await tool.validateInput!(decisionInput, context())).ok, true);
  const decided = await tool.execute(decisionInput, context());
  assert.equal(decided.data?.action, "decide_revision");
  if (decided.data?.action !== "decide_revision") throw new Error("Expected decide_revision result.");
  assert.equal(decided.data.revision.decision.payload.status, "revision_required");
  assert.equal(decided.data.revision.invalidatedArtifactRefs.length > 0, true);
});

test("research_review validation rejects incomplete lane coverage", async () => {
  const fixture = createSyntheticReviewArtifacts();
  const manuscriptRef = toResearchArtifactRef(fixture.manuscript);
  const tool = createResearchReviewTool();
  const validation = await tool.validateInput!({
    action: "run_review",
    manuscript: fixture.manuscript,
    laneReports: createLaneReports(manuscriptRef).slice(0, 6),
  }, context());
  assert.equal(validation.ok, false);
  if (validation.ok) throw new Error("Expected invalid lane coverage.");
  assert.match(validation.issues[0]?.message ?? "", /exactly 7 independent lane reports/iu);
});
