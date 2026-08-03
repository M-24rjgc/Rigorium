import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectAnomaly, applyAnomalyBoost } from "../../src/research/director/eig/anomalyDetector.js";
import { planByInformationGain } from "../../src/research/director/eig/planner.js";
import { reconcileWithBeliefs } from "../../src/research/director/eig/reconcile.js";
import { TasteCalibrator } from "../../src/research/claims/taste.js";
import type { ClaimBelief } from "../../src/research/claims/types.js";

function belief(claimId: string, uncertainty: number, status: ClaimBelief["status"], supportsWeight = 0, challengesWeight = 0): ClaimBelief {
  return Object.freeze({
    claimId,
    status,
    confidence: 0.5,
    uncertainty,
    supportsWeight,
    challengesWeight,
    evidenceCount: 1,
    computedAt: "2026-08-03T00:00:00.000Z",
  });
}

// ---------------------------------------------------------------------------
// anomalyDetector
// ---------------------------------------------------------------------------

test("detectAnomaly: challenge-heavy claim space triggers anomaly mode", () => {
  const result = detectAnomaly([
    belief("c1", 0.8, "challenged", 0.1, 0.7),
    belief("c2", 0.9, "challenged", 0.2, 0.6),
    belief("c3", 0.3, "active", 0.8, 0.1),
  ]);
  assert.equal(result.detected, true);
  assert.ok(result.anomalyScore > 0.5);
  assert.equal(result.challengedClaimCount, 2);
});

test("detectAnomaly: healthy claim space stays calm", () => {
  const result = detectAnomaly([
    belief("c1", 0.4, "active", 0.8, 0.1),
    belief("c2", 0.2, "active", 0.9, 0.05),
  ]);
  assert.equal(result.detected, false);
});

test("applyAnomalyBoost: boosts principle_revision above weak actions", () => {
  const plan = planByInformationGain([belief("c1", 0.2, "active"), belief("c2", 0.2, "active")]);
  assert.equal(plan.ranked[0]!.action.type !== "principle_revision", true, "weak uncertainty → no revision without anomaly");
  const anomaly = detectAnomaly([
    belief("c1", 0.2, "challenged", 0.05, 0.7),
    belief("c2", 0.2, "challenged", 0.05, 0.6),
  ]);
  assert.equal(anomaly.detected, true);
  const boosted = applyAnomalyBoost(plan, anomaly);
  const top = boosted.ranked[0]!;
  assert.equal(top.action.type, "principle_revision", "anomaly must lift principle revision to the top");
  assert.match(top.rationale, /anomaly boost/);
});

// ---------------------------------------------------------------------------
// reconcileWithBeliefs
// ---------------------------------------------------------------------------

test("reconcile: reports downgrades as backtracking and drops dead targets", () => {
  const previous = [
    belief("c1", 0.9, "active"),
    belief("c2", 0.8, "active"),
  ];
  const current = [
    belief("c1", 0.9, "falsified"),
    belief("c2", 0.8, "active"),
  ];
  const plan = planByInformationGain(previous);
  assert.equal(plan.ranked[0]!.action.claimId, "c1");

  const reconciled = reconcileWithBeliefs(current, previous, plan);
  assert.equal(reconciled.backtracking, true);
  assert.equal(reconciled.revisions.length, 1);
  assert.equal(reconciled.revisions[0]!.from, "active");
  assert.equal(reconciled.revisions[0]!.to, "falsified");
  const claimIds = reconciled.plan.ranked.map((estimate) => estimate.action.claimId);
  assert.ok(!claimIds.includes("c1"), "actions targeting a falsified claim must be dropped");
  assert.equal(reconciled.nextActionClaimId, "c2");
});

test("reconcile: no changes → no backtracking, plan unchanged", () => {
  const beliefs = [belief("c1", 0.9, "active")];
  const plan = planByInformationGain(beliefs);
  const reconciled = reconcileWithBeliefs(beliefs, beliefs, plan);
  assert.equal(reconciled.backtracking, false);
  assert.equal(reconciled.revisions.length, 0);
  assert.equal(reconciled.plan.ranked.length, plan.ranked.length);
});

test("reconcile: evidence restored upgrades challenged claim back to active", () => {
  const previous = [belief("c1", 0.8, "challenged", 0.1, 0.7)];
  const current = [belief("c1", 0.3, "active", 0.8, 0.1)];
  const plan = planByInformationGain(previous);
  const reconciled = reconcileWithBeliefs(current, previous, plan);
  assert.equal(reconciled.backtracking, false, "upgrade is not a backtrack");
  assert.equal(reconciled.revisions[0]!.from, "challenged");
  assert.equal(reconciled.revisions[0]!.to, "active");
});

// ---------------------------------------------------------------------------
// TasteCalibrator
// ---------------------------------------------------------------------------

function createTempProject(): string {
  return mkdtempSync(join(tmpdir(), "rigorium-taste-"));
}

test("TasteCalibrator: cold start returns raw proxy score", async () => {
  const projectRoot = createTempProject();
  try {
    const calibrator = new TasteCalibrator({ projectRoot });
    assert.equal(await calibrator.calibrate(7), 7);
    assert.equal((await calibrator.stateSnapshot()).calibration, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("TasteCalibrator: learns multiplicative correction from outcome pairs", async () => {
  const projectRoot = createTempProject();
  try {
    const calibrator = new TasteCalibrator({ projectRoot, alpha: 0.3, minObservations: 3 });
    // The platform over-scores: proxy 8 vs actual 5 repeatedly.
    await calibrator.observe(8, 5);
    await calibrator.observe(8, 5);
    await calibrator.observe(8, 5);
    const state = await calibrator.stateSnapshot();
    assert.equal(state.observations, 3);
    assert.ok(state.calibration < 1, "systematic over-scoring must pull calibration below 1");
    const calibrated = await calibrator.calibrate(8);
    assert.ok(calibrated < 8, "calibrated score must be corrected downward");
    assert.ok(calibrated > 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("TasteCalibrator: persists across instances", async () => {
  const projectRoot = createTempProject();
  try {
    const calibrator = new TasteCalibrator({ projectRoot, alpha: 0.5, minObservations: 1 });
    await calibrator.observe(10, 5);
    const reloaded = new TasteCalibrator({ projectRoot, minObservations: 1 });
    assert.equal((await reloaded.stateSnapshot()).observations, 1);
    assert.ok(await reloaded.calibrate(10) < 10);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("TasteCalibrator: calibration is clamped to the safe range", async () => {
  const projectRoot = createTempProject();
  try {
    const calibrator = new TasteCalibrator({ projectRoot, alpha: 1, minObservations: 1 });
    await calibrator.observe(10, 0.5); // ratio clamps to 0.2
    await calibrator.observe(10, 100); // ratio clamps to 3
    const state = await calibrator.stateSnapshot();
    assert.ok(state.calibration >= 0.5 && state.calibration <= 2.0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
