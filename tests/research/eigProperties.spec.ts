import assert from "node:assert/strict";
import test from "node:test";
import { planByInformationGain, DEFAULT_STOP_SCORE_THRESHOLD } from "../../src/research/director/eig/planner.js";
import { estimateEig } from "../../src/research/director/eig/estimate.js";
import type { ClaimBelief } from "../../src/research/claims/types.js";

/**
 * Property tests locking the EIG planner's invariants — the batch is always
 * de-duplicated, sorted, finite, and stop is consistent with the top score.
 */

function belief(claimId: string, uncertainty: number, evidenceCount = 0): ClaimBelief {
  return Object.freeze({
    claimId,
    statement: `claim ${claimId}`,
    status: "active",
    confidence: 1 - uncertainty,
    uncertainty,
    supportsWeight: evidenceCount * 0.25,
    challengesWeight: 0,
    evidenceCount,
    computedAt: "2026-08-03T00:00:00.000Z",
  });
}

test("property: every plan field is finite (NaN/Infinity can never reach the agent)", () => {
  for (const beliefs of [
    [belief("a", 0.9, 0), belief("b", 0.5, 10)],
    [],
    [belief("a", 0.2, 200)],
  ]) {
    const plan = planByInformationGain(beliefs);
    for (const estimate of plan.ranked) {
      assert.ok(Number.isFinite(estimate.score), `score NaN for ${estimate.action.type}`);
      assert.ok(Number.isFinite(estimate.expectedInformationGain));
      assert.ok(Number.isFinite(estimate.costUnits));
      assert.ok(estimate.costUnits >= 0.5, "cost units have a floor");
    }
  }
});

test("property: plan tolerates adversarial deps (Infinity costs never poison the score)", () => {
  const plan = planByInformationGain([belief("a", 0.9)], {}, {
    actionCosts: { run_experiment: Number.POSITIVE_INFINITY } as never,
    artifactCostModel: new Map([["run_attempt", Number.NaN]]) as never,
  });
  for (const estimate of plan.ranked) {
    assert.ok(Number.isFinite(estimate.score));
    assert.ok(Number.isFinite(estimate.costUnits));
  }
});

test("property: ranked actions are sorted by score descending", () => {
  const plan = planByInformationGain([
    belief("a", 0.9),
    belief("b", 0.8),
    belief("c", 0.7),
    belief("d", 0.6),
  ]);
  for (let index = 1; index < plan.ranked.length; index += 1) {
    assert.ok(
      plan.ranked[index - 1]!.score >= plan.ranked[index]!.score,
      `ranking broken at index ${index}`,
    );
  }
});

test("property: at most maxActionsPerClaim actions per claim, maxActions total", () => {
  const plan = planByInformationGain(
    Array.from({ length: 12 }, (_, i) => belief(`c-${i}`, 0.9)),
    { maxActions: 6, maxActionsPerClaim: 1 },
  );
  assert.ok(plan.ranked.length <= 6);
  const perClaim = new Map<string, number>();
  for (const estimate of plan.ranked) {
    const claimId = estimate.action.claimId!;
    perClaim.set(claimId, (perClaim.get(claimId) ?? 0) + 1);
  }
  for (const count of perClaim.values()) {
    assert.ok(count <= 1, "de-duplication must cap actions per claim");
  }
});

test("property: shouldStop is exactly topScore < threshold (never a separate rule)", () => {
  const settled = planByInformationGain([belief("a", 0.01, 500)]);
  assert.equal(settled.shouldStop, settled.ranked[0] === undefined || settled.ranked[0]!.score < DEFAULT_STOP_SCORE_THRESHOLD);
  const plan = planByInformationGain([belief("a", 0.01, 500)]);
  assert.equal(plan.shouldStop, true, "a fully-settled claim must recommend stop");
  assert.match(plan.stopReason ?? "", /below the stop threshold/);
});

test("property: principle revision is a candidate and scales with aggregate uncertainty", () => {
  const unsettled = planByInformationGain([belief("a", 0.9), belief("b", 0.95)]);
  const revision = unsettled.ranked.find((e) => e.action.type === "principle_revision");
  assert.ok(revision, "principle revision must be considered when research is unsettled");

  // EIG of principle revision = gain factor × aggregate uncertainty.
  const high = estimateEig({ type: "principle_revision" }, undefined, {}, { aggregateUncertainty: 0.9 });
  const low = estimateEig({ type: "principle_revision" }, undefined, {}, { aggregateUncertainty: 0.1 });
  assert.ok(high.expectedInformationGain > low.expectedInformationGain);
  assert.equal(low.expectedInformationGain, 0.5 * 0.1, "gain factor 0.5 × aggregate");
});

test("property: EIG for a claim action is monotone in the claim's uncertainty", () => {
  const gains: number[] = [];
  for (const uncertainty of [0.2, 0.5, 0.8, 1.0]) {
    const estimate = estimateEig(
      { type: "literature_search", claimId: "c", producesKinds: ["evidence_pack"] },
      belief("c", uncertainty, 0),
    );
    gains.push(estimate.expectedInformationGain);
  }
  for (let index = 1; index < gains.length; index += 1) {
    assert.ok(gains[index]! >= gains[index - 1]!, "EIG must not fall when uncertainty rises");
  }
});

test("property: maturity discount dampens actions on evidence-heavy claims", () => {
  const fresh = estimateEig(
    { type: "run_experiment", claimId: "c", producesKinds: ["run_attempt"] },
    belief("c", 0.9, 0),
  );
  const saturated = estimateEig(
    { type: "run_experiment", claimId: "c", producesKinds: ["run_attempt"] },
    belief("c", 0.9, 500),
  );
  assert.ok(fresh.expectedInformationGain > saturated.expectedInformationGain);
  // discount floor: 1 - evidenceCount×0.05 clamped at 0.25
  assert.equal(saturated.expectedInformationGain, 0.9 * 0.7 * 0.25);
});

test("property: write_section carries zero EIG (writing consumes evidence, it does not resolve uncertainty)", () => {
  const estimate = estimateEig(
    { type: "write_section", claimId: "c" },
    belief("c", 0.9),
  );
  assert.equal(estimate.expectedInformationGain, 0);
  assert.equal(estimate.score, 0);
});
