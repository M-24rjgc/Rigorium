import assert from "node:assert/strict";
import test from "node:test";
import { confirmProvisionalTitle } from "../../src/research/direction/titleConfirmation.js";

const evidence = [{
  id: "ev-gap",
  paperId: "paper-1",
  role: "gap" as const,
  statement: "The prior work does not evaluate the target setting.",
}];

test("returns an evidence-traceable provisional title without mutating a project", () => {
  const result = confirmProvisionalTitle({
    directionId: "direction-1",
    candidateTitle: "Evaluating a bounded research method",
    evidence,
  });
  assert.equal(result.title.status, "accepted");
  assert.equal(result.title.text, "Evaluating a bounded research method");
  assert.deepEqual(result.title.evidenceIds, ["ev-gap"]);
  assert.deepEqual(result.title.paperIds, ["paper-1"]);
  assert.equal(result.confirmation.status, "pending");
  assert.equal(result.confirmation.projectNameUpdate.status, "not_ready");
});

test("overcommitting titles are downgraded only with a neutral fallback", () => {
  const result = confirmProvisionalTitle({
    directionId: "direction-1",
    candidateTitle: "A breakthrough method that always solves the problem",
    neutralTitle: "Evaluating a method for the target problem",
    evidence,
  });
  assert.equal(result.title.status, "downgraded");
  assert.equal(result.title.text, "Evaluating a method for the target problem");
  assert.deepEqual(result.title.reasonCodes, ["provisional", "overcommitting_claim"]);
});

test("rejects unsupported or sensitive titles and never confirms them", () => {
  const unsupported = confirmProvisionalTitle({
    directionId: "direction-1",
    candidateTitle: "A breakthrough result",
    evidence,
  });
  assert.equal(unsupported.title.status, "rejected");
  assert.equal(unsupported.confirmation.confirmed, false);

  const sensitive = confirmProvisionalTitle({
    directionId: "direction-1",
    candidateTitle: "Method using api_key=secret",
    evidence,
    confirmed: true,
  });
  assert.equal(sensitive.title.status, "rejected");
  assert.equal(sensitive.confirmation.status, "pending");
  assert.equal(sensitive.confirmation.projectNameUpdate.status, "not_ready");
});

test("only an explicit confirmation produces a project-name update intent", () => {
  const result = confirmProvisionalTitle({
    directionId: "direction-1",
    candidateTitle: "Evaluating a bounded research method",
    evidence,
    confirmed: true,
  });
  assert.equal(result.confirmation.status, "confirmed");
  assert.equal(result.confirmation.projectNameUpdate.status, "ready_for_explicit_project_action");
  assert.equal(result.confirmation.projectNameUpdate.name, result.title.text);
  assert.equal(result.confirmation.projectNameUpdate.requiresExplicitUserAction, true);
});

test("invalid evidence and unbounded text fail closed", () => {
  assert.throws(() => confirmProvisionalTitle({
    directionId: "direction-1",
    candidateTitle: "Valid title",
    evidence: [{ ...evidence[0], id: "" }],
  }), /evidence\.id/);
  assert.throws(() => confirmProvisionalTitle({
    directionId: "direction-1",
    candidateTitle: "x".repeat(181),
    evidence,
  }), /candidateTitle/);
});
