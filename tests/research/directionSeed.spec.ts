import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeResearchDirectionSeed,
  type ResearchDirectionSeedInput,
} from "../../src/research/direction/directionSeed.js";

function validInput(overrides: Partial<ResearchDirectionSeedInput> = {}): ResearchDirectionSeedInput {
  return {
    cues: [
      { id: "cue-interest", kind: "interest", text: "Reliable small-model evaluation" },
      { id: "cue-paper", kind: "paper", text: "A paper reports calibration failures", sourceReference: "10.1000/example" },
      { id: "cue-data", kind: "data", text: "A small labeled benchmark is available" },
      { id: "cue-observation", kind: "experiment_observation", text: "Errors cluster under distribution shift" },
    ],
    terminology: [
      { id: "term-calibration", text: "calibration", cueIds: ["cue-paper", "cue-observation"], status: "observed" },
      { id: "term-shift", text: "distribution shift", cueIds: ["cue-observation"], status: "observed" },
    ],
    constraints: [
      { id: "constraint-data", kind: "data", label: "Small labeled benchmark", status: "satisfied", cueIds: ["cue-data"] },
      { id: "constraint-compute", kind: "compute", label: "Single-device budget", status: "unknown", cueIds: ["cue-interest"] },
    ],
    candidates: [
      {
        id: "candidate-calibration",
        summary: "Evaluate calibration interventions for small models under distribution shift.",
        cueIds: ["cue-interest", "cue-paper", "cue-observation"],
        terminologyIds: ["term-calibration", "term-shift"],
        constraintIds: ["constraint-data", "constraint-compute"],
        hypotheses: [
          {
            id: "hypothesis-1",
            statement: "Calibration intervention quality changes under distribution shift.",
            cueIds: ["cue-paper", "cue-observation"],
            terminologyIds: ["term-calibration", "term-shift"],
          },
        ],
        contributions: [
          {
            id: "contribution-1",
            statement: "A bounded comparison protocol for calibration under shift.",
            cueIds: ["cue-interest", "cue-observation"],
            constraintIds: ["constraint-data"],
          },
        ],
        titleSeed: "Calibration interventions for small models under distribution shift",
      },
    ],
    ...overrides,
  };
}

test("normalizes traceable clues, terms, constraints, drafts, and a pending provisional title", () => {
  const result = normalizeResearchDirectionSeed(validInput());
  const candidate = result.candidateDirections[0]!;

  assert.deepEqual(result.cues.map((cue) => cue.id), ["cue-data", "cue-interest", "cue-observation", "cue-paper"]);
  assert.deepEqual(candidate.cueIds, ["cue-interest", "cue-observation", "cue-paper"]);
  assert.deepEqual(candidate.terminologyIds, ["term-calibration", "term-shift"]);
  assert.deepEqual(candidate.constraintIds, ["constraint-compute", "constraint-data"]);
  assert.equal(candidate.hypotheses[0]?.cueIds.includes("cue-paper"), true);
  assert.equal(candidate.contributions[0]?.constraintIds?.includes("constraint-data"), true);
  assert.equal(result.constraintCoverage.status, "unresolved");
  assert.deepEqual(result.constraintCoverage.unresolvedConstraintIds, ["constraint-compute"]);
  assert.equal(candidate.provisionalTitle.status, "proposed");
  assert.match(candidate.provisionalTitle.text ?? "", /^Provisional: /);
  assert.equal(candidate.provisionalTitle.confirmation.status, "pending");
  assert.equal(candidate.provisionalTitle.confirmation.confirmed, false);
  assert.equal(candidate.provisionalTitle.confirmation.projectNameUpdate.status, "not_ready");
  assert.equal(candidate.provisionalTitle.confirmation.projectNameUpdate.requiresExplicitUserAction, true);
});

test("fails closed on an empty cue set", () => {
  assert.throws(() => normalizeResearchDirectionSeed(validInput({ cues: [] })), /at least one cue/);
});

test("does not invent missing constraints", () => {
  const input = validInput();
  const candidate = input.candidates[0]!;
  const result = normalizeResearchDirectionSeed({
    ...input,
    constraints: undefined,
    candidates: [{
      ...candidate,
      constraintIds: undefined,
      contributions: candidate.contributions?.map((contribution) => ({
        ...contribution,
        constraintIds: undefined,
      })),
    }],
  });
  assert.deepEqual(result.constraints, []);
  assert.equal(result.constraintCoverage.status, "not_provided");
  assert.deepEqual(result.constraintCoverage.suppliedConstraintIds, []);
});

test("rejects derived records that do not identify a source cue", () => {
  const input = validInput();
  assert.throws(() => normalizeResearchDirectionSeed({
    ...input,
    candidates: [{ ...input.candidates[0]!, cueIds: ["missing-cue"] }],
  }), /Unknown candidate candidate-calibration cue ID/);
});

test("downgrades overcommitting preliminary titles without confirming them", () => {
  const input = validInput();
  const title = normalizeResearchDirectionSeed({
    ...input,
    candidates: [{
      ...input.candidates[0]!,
      titleSeed: "The first breakthrough that always solves calibration",
      neutralTitle: "Evaluating calibration interventions under distribution shift",
    }],
  }).candidateDirections[0]!.provisionalTitle;
  assert.equal(title.status, "downgraded");
  assert.match(title.text ?? "", /^Provisional: Evaluating/);
  assert.equal(title.confirmation.projectNameUpdate.status, "not_ready");
});
