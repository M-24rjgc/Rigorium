import assert from "node:assert/strict";
import test from "node:test";
import {
  hedgesGIndependentGroups,
  hedgesGOneSample,
  studentTQuantile,
  summarizeSample,
} from "../../../../src/research/experimentation/analysis/statistics.js";

test("Student-t 95% interval matches independently audited SciPy and statsmodels values", () => {
  const summary = summarizeSample([0.8, 0.9, 1.0, 1.1]);
  assert.equal(summary.count, 4);
  assert.ok(Math.abs(summary.mean - 0.95) < 1e-14);
  assert.ok(Math.abs(summary.sampleStandardDeviation! - 0.12909944487358058) < 1e-14);
  assert.ok(Math.abs(studentTQuantile(0.975, 3) - 3.182446305284263) < 1e-12);
  assert.equal(summary.confidenceInterval.status, "available");
  if (summary.confidenceInterval.status !== "available") assert.fail("expected available interval");
  assert.ok(Math.abs(summary.confidenceInterval.lower - 0.7445739743239121) < 1e-12);
  assert.ok(Math.abs(summary.confidenceInterval.upper - 1.155426025676088) < 1e-12);
});

test("small and zero-variance samples return explicit unavailable statistics", () => {
  const single = summarizeSample([2]).confidenceInterval;
  const constant = summarizeSample([2, 2, 2]).confidenceInterval;
  assert.equal(single.status, "unavailable");
  assert.equal(constant.status, "unavailable");
  if (single.status !== "unavailable" || constant.status !== "unavailable") assert.fail("expected unavailable intervals");
  assert.deepEqual(single.reason, "single_observation");
  assert.deepEqual(constant.reason, "zero_variance");
  assert.equal(hedgesGOneSample([2], 1).status, "unavailable");
  assert.equal(hedgesGOneSample([2, 2, 2], 1).status, "unavailable");
  assert.equal(hedgesGIndependentGroups([], [1, 2]).status, "unavailable");
  assert.equal(hedgesGIndependentGroups([1], [2, 3]).status, "unavailable");
});

test("Hedges g applies the documented small-sample correction", () => {
  const oneSample = hedgesGOneSample([1, 2, 3], 0);
  assert.equal(oneSample.status, "available");
  if (oneSample.status !== "available") assert.fail("expected one-sample effect");
  assert.ok(Math.abs(oneSample.value - 8 / 7) < 1e-14);

  const independent = hedgesGIndependentGroups([1, 2, 3], [0, 1, 2]);
  assert.equal(independent.status, "available");
  if (independent.status !== "available") assert.fail("expected independent effect");
  assert.ok(Math.abs(independent.value - 0.8) < 1e-14);
});
