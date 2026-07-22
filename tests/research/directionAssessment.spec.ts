import assert from "node:assert/strict";
import test from "node:test";
import {
  assessResearchDirections,
  type DirectionAssessmentInput,
} from "../../src/research/direction/directionAssessment.js";

const baseEvidence = {
  id: "evidence-prior",
  paperId: "paper-prior",
  role: "prior_art" as const,
  statement: "The cited paper establishes the current task setting.",
  strength: "direct" as const,
};

function viableInput(overrides: Partial<DirectionAssessmentInput> = {}): DirectionAssessmentInput {
  return {
    evidence: [
      baseEvidence,
      {
        id: "evidence-gap",
        paperId: "paper-gap",
        role: "gap",
        statement: "The cited paper describes an unresolved evaluation limitation.",
        strength: "direct",
      },
    ],
    constraints: [
      { id: "data", kind: "data", label: "Dataset access", status: "satisfied" },
      { id: "compute", kind: "compute", label: "Compute allocation", status: "satisfied" },
      { id: "ethics", kind: "ethics", label: "Ethics review", status: "satisfied" },
      { id: "baseline", kind: "baseline", label: "Reference baseline", status: "satisfied" },
      { id: "evaluation", kind: "evaluation", label: "Evaluation protocol", status: "satisfied" },
      { id: "time", kind: "time", label: "Submission time", status: "satisfied" },
    ],
    targetConferences: [
      {
        id: "venue",
        name: "Example Conference",
        deadline: "2026-10-01",
        status: "satisfied",
        evidenceIds: ["evidence-gap"],
      },
    ],
    candidates: [
      {
        id: "valid-direction",
        summary: "Evaluate a bounded method against a reference baseline.",
        titleSeed: "Evaluating a bounded method against a reference baseline",
        evidenceIds: ["evidence-prior", "evidence-gap"],
        constraintIds: ["data", "compute", "ethics", "baseline", "evaluation", "time"],
        targetConferenceIds: ["venue"],
        hypotheses: [
          {
            id: "hypothesis-1",
            statement: "The proposed comparison can be evaluated under the cited setting.",
            failureCriterion: "The comparison does not meet the predeclared evaluation criterion.",
            evidenceIds: ["evidence-prior", "evidence-gap"],
            evaluationConstraintId: "evaluation",
            baselineConstraintIds: ["baseline"],
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("missing literature evidence leaves novelty unestablished and viability evidence-bound", () => {
  const result = assessResearchDirections({
    candidates: [{ id: "empty-direction", summary: "Assess a possible direction." }],
  });
  const assessment = result.assessments[0]!;

  assert.equal(assessment.minimumViability.status, "needs_evidence");
  assert.equal(assessment.novelty.status, "not_established");
  assert.deepEqual(assessment.novelty.evidenceIds, []);
  assert.equal(assessment.unmetEvidenceGaps.some((gap) => gap.code === "literature_evidence_missing"), true);
  assert.equal(assessment.unmetEvidenceGaps.some((gap) => gap.code === "direct_evidence_missing"), true);
  assert.match(assessment.provisionalTitle.text ?? "", /^Provisional: /);
});

test("a required blocked constraint prevents minimum viability and remains traceable", () => {
  const input = viableInput();
  input.constraints = input.constraints!.map((constraint) =>
    constraint.id === "compute" ? { ...constraint, status: "blocked" as const } : constraint,
  );

  const assessment = assessResearchDirections(input).assessments[0]!;
  assert.equal(assessment.minimumViability.status, "blocked");
  assert.equal(assessment.unmetEvidenceGaps.some((gap) =>
    gap.code === "constraint_blocked" && gap.constraintIds.includes("compute")), true);
  assert.equal(assessment.minimumViability.reasons.some((reason) =>
    reason.code === "constraint_blocked" && reason.constraintIds.includes("compute")), true);
});

test("equal scores use direction IDs for a stable deterministic ranking", () => {
  const sharedCandidate = {
    summary: "Evaluate an evidence-bounded direction.",
    evidenceIds: ["evidence-prior"],
    constraintIds: ["baseline", "evaluation"],
    hypotheses: [
      {
        id: "hypothesis",
        statement: "The direction can be measured against the baseline.",
        failureCriterion: "The result does not meet the evaluation criterion.",
        evidenceIds: ["evidence-prior"],
        evaluationConstraintId: "evaluation",
        baselineConstraintIds: ["baseline"],
      },
    ],
  };
  const result = assessResearchDirections({
    evidence: [baseEvidence],
    constraints: [
      { id: "baseline", kind: "baseline", label: "Baseline", status: "satisfied" },
      { id: "evaluation", kind: "evaluation", label: "Evaluation", status: "satisfied" },
    ],
    candidates: [
      { ...sharedCandidate, id: "direction-z" },
      { ...sharedCandidate, id: "direction-a" },
    ],
  });

  assert.deepEqual(result.rankedDirectionIds, ["direction-a", "direction-z"]);
  assert.deepEqual(result.assessments.map((assessment) => assessment.rank), [1, 2]);
  assert.equal(result.assessments[0]!.score.total, result.assessments[1]!.score.total);
});

test("overcommitting titles are downgraded when a neutral summary exists and rejected otherwise", () => {
  const result = assessResearchDirections({
    candidates: [
      {
        id: "downgrade-title",
        summary: "Evaluate a bounded comparison.",
        titleSeed: "The First SOTA Breakthrough for Every Task",
      },
      {
        id: "reject-title",
        summary: "A Novel Breakthrough That Solves Every Task",
      },
    ],
  });
  const downgraded = result.assessments.find((assessment) => assessment.directionId === "downgrade-title")!;
  const rejected = result.assessments.find((assessment) => assessment.directionId === "reject-title")!;

  assert.equal(downgraded.provisionalTitle.status, "downgraded");
  assert.match(downgraded.provisionalTitle.text ?? "", /^Provisional: /);
  assert.doesNotMatch(downgraded.provisionalTitle.text ?? "", /first|sota|breakthrough/iu);
  assert.equal(rejected.provisionalTitle.status, "rejected");
  assert.equal(rejected.provisionalTitle.text, undefined);
});

test("a fully cited direction yields a provisional, viable assessment with falsifiable hypotheses", () => {
  const assessment = assessResearchDirections(viableInput()).assessments[0]!;

  assert.equal(assessment.minimumViability.status, "viable");
  assert.equal(assessment.novelty.status, "gap_evidenced");
  assert.deepEqual(assessment.novelty.paperIds, ["paper-gap"]);
  assert.equal(assessment.falsifiableHypotheses[0]!.status, "ready");
  assert.deepEqual(assessment.falsifiableHypotheses[0]!.paperIds, ["paper-gap", "paper-prior"]);
  assert.equal(assessment.provisionalTitle.status, "accepted");
  assert.match(assessment.provisionalTitle.text ?? "", /^Provisional: /);
  assert.equal(assessment.provisionalTitle.text?.includes("Novel"), false);
  assert.equal(assessment.score.total > 0, true);
});
