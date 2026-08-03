import assert from "node:assert/strict";
import test from "node:test";

import { estimateEig } from "../../src/research/director/eig/estimate.js";
import { planByInformationGain } from "../../src/research/director/eig/planner.js";
import type { ClaimBelief } from "../../src/research/claims/types.js";

function belief(claimId: string, uncertainty: number, evidenceCount = 0, status: ClaimBelief["status"] = "active"): ClaimBelief {
  return Object.freeze({
    claimId,
    status,
    confidence: 0.5,
    uncertainty,
    supportsWeight: 0,
    challengesWeight: 0,
    evidenceCount,
    computedAt: "2026-08-03T00:00:00.000Z",
  });
}

test("estimateEig: EIG = uncertainty × gainFactor × maturityDiscount", () => {
  const claim = belief("c1", 0.8, 0);
  const experiment = estimateEig({ type: "run_experiment", claimId: "c1" }, claim);
  assert.ok(Math.abs(experiment.expectedInformationGain - 0.8 * 0.7) < 1e-9);
  assert.equal(experiment.costUnits, 10);
  assert.ok(experiment.score > 0);
});

test("estimateEig: settled claims have diminishing returns", () => {
  const settled = belief("c1", 0.8, 8);
  const fresh = belief("c2", 0.8, 0);
  const settledGain = estimateEig({ type: "run_experiment", claimId: "c1" }, settled).expectedInformationGain;
  const freshGain = estimateEig({ type: "run_experiment", claimId: "c2" }, fresh).expectedInformationGain;
  assert.ok(settledGain < freshGain, "maturity discount must dampen settled claims");
});

test("estimateEig: write_section carries zero EIG; principle_revision scales with aggregate uncertainty", () => {
  const claim = belief("c1", 0.9);
  const writing = estimateEig({ type: "write_section", claimId: "c1" }, claim);
  assert.equal(writing.expectedInformationGain, 0);
  const revision = estimateEig({ type: "principle_revision" }, undefined, {}, { aggregateUncertainty: 0.8 });
  assert.equal(revision.expectedInformationGain, 0.4); // 0.5 × 0.8
  const settled = estimateEig({ type: "principle_revision" }, undefined, {}, { aggregateUncertainty: 0.02 });
  assert.ok(settled.expectedInformationGain <= 0.01, "settled research must not recommend principle revision");
});

test("estimateEig: artifact cost model inflates cost of expensive producers", () => {
  const claim = belief("c1", 0.9);
  const deps = {
    artifactCostModel: new Map([["run_attempt", 5]]),
  };
  const expensive = estimateEig({ type: "run_experiment", claimId: "c1", producesKinds: ["run_attempt"] }, claim, deps);
  assert.equal(expensive.costUnits, 15);
});

test("planByInformationGain: most-uncertain claim dominates the ranking", () => {
  const plan = planByInformationGain([belief("c1", 0.95), belief("c2", 0.1)]);
  assert.equal(plan.shouldStop, false);
  assert.ok(plan.ranked.length >= 1);
  const top = plan.ranked[0]!;
  assert.equal(top.action.claimId, "c1", "highest-uncertainty claim must rank first");
  // Cheap information-gathering (literature_search) can beat expensive
  // experiments on gain-per-cost — that is the point of cost-aware ranking.
  assert.ok(top.action.type === "literature_search" || top.action.type === "review" || top.action.type === "run_experiment");
  const c2Best = Math.max(
    ...plan.ranked.filter((estimate) => estimate.action.claimId === "c2").map((estimate) => estimate.score),
    0,
  );
  assert.ok(top.score >= c2Best, "c1's best action must outscore c2's best");
});

test("planByInformationGain: de-duplicates actions per claim", () => {
  const plan = planByInformationGain([belief("c1", 0.95)], { maxActions: 10 });
  const perClaim = plan.ranked.filter((estimate) => estimate.action.claimId === "c1").length;
  assert.equal(perClaim, 1, "at most one action per claim by default");
});

test("planByInformationGain: stop when nothing clears the bar", () => {
  const plan = planByInformationGain([belief("c1", 0.02)], { stopScoreThreshold: 0.05 });
  assert.equal(plan.shouldStop, true);
  assert.ok(plan.stopReason);
});

test("planByInformationGain: challenged/falsified claims are excluded", () => {
  const plan = planByInformationGain([
    belief("c-challenged", 0.9, 0, "challenged"),
    belief("c-falsified", 0.9, 0, "falsified"),
    belief("c-superseded", 0.9, 0, "superseded"),
    belief("c-active", 0.9),
  ]);
  const claimIds = new Set(plan.ranked.map((estimate) => estimate.action.claimId));
  assert.ok(claimIds.has("c-active"));
  assert.ok(!claimIds.has("c-challenged"));
  assert.ok(!claimIds.has("c-falsified"));
  assert.ok(!claimIds.has("c-superseded"));
});

test("planByInformationGain: no active claims → stop with rationale", () => {
  const plan = planByInformationGain([belief("c1", 0.9, 0, "falsified")]);
  assert.equal(plan.shouldStop, true);
});
