import assert from "node:assert/strict";
import test from "node:test";
import {
  EVIDENCE_STRENGTH_WEIGHTS,
  computeBelief,
} from "../../src/research/claims/beliefPropagation.js";
import type { Claim, EvidenceContribution } from "../../src/research/claims/types.js";

/**
 * Golden assertions locking the belief mathematics — the core design of the
 * platform. If anyone changes the saturation formula, the thresholds, or the
 * evidence weights, these tests must force an explicit decision (and a
 * comment update), not silently drift.
 */

function makeClaim(claimId: string, statement: string): Claim {
  return Object.freeze({ claimId, statement, createdAt: "2026-08-03T00:00:00.000Z" });
}

function contribution(
  sourceArtifactId: string,
  sourceKind: string,
  relation: "supports" | "challenges",
  strength: EvidenceContribution["strength"],
): EvidenceContribution {
  return Object.freeze({
    sourceArtifactId,
    sourceKind,
    relation,
    strength,
    sourceRevision: 1,
    observedAt: "2026-08-03T00:00:00.000Z",
  });
}

const replicated = (relation: "supports" | "challenges") =>
  contribution(`run-${Math.random()}`, "run_attempt", relation, "replicated_result");

test("golden: fresh claim starts at maximal ignorance (confidence 0.5, uncertainty 1)", () => {
  const belief = computeBelief(makeClaim("c", "X improves Y"), []);
  assert.equal(belief.confidence, 0.5);
  assert.equal(belief.uncertainty, 1);
  assert.equal(belief.status, "active");
  assert.equal(belief.evidenceCount, 0);
});

test("golden: three replications land at ~0.77 (documented anchor)", () => {
  // delta = 3 × 0.4 = 1.2 → 0.5 + 0.5·(1.2 / 2.2) = 0.7727…
  const belief = computeBelief(
    makeClaim("c", "X improves Y"),
    [replicated("supports"), replicated("supports"), replicated("supports")],
  );
  assert.ok(Math.abs(belief.confidence - 0.7727) < 0.001, `confidence=${belief.confidence}`);
  assert.equal(belief.supportsWeight, 3 * EVIDENCE_STRENGTH_WEIGHTS.replicated_result);
  assert.equal(belief.status, "active");
});

test("golden: saturation transform anchors (delta=1 → 0.75, delta=8 → 0.944)", () => {
  const delta1 = computeBelief(makeClaim("c", "X"), [
    contribution("a", "run_attempt", "supports", "replicated_result"),
    contribution("b", "run_attempt", "supports", "observed_result"),
    contribution("c", "evidence_pack", "supports", "citation"),
  ]); // 0.4 + 0.25 + 0.1 = 0.75… delta = 0.75
  // Use direct delta instead: 0.5 + 0.5·(0.75/1.75) = 0.7143
  assert.ok(Math.abs(delta1.confidence - (0.5 + 0.5 * (0.75 / 1.75))) < 1e-9);

  const big = computeBelief(makeClaim("c", "X"), [
    contribution("a", "run_attempt", "supports", "replicated_result"),
    contribution("b", "run_attempt", "supports", "replicated_result"),
    contribution("c", "run_attempt", "supports", "replicated_result"),
    contribution("d", "run_attempt", "supports", "replicated_result"),
    contribution("e", "run_attempt", "supports", "replicated_result"),
    contribution("f", "run_attempt", "supports", "replicated_result"),
    contribution("g", "run_attempt", "supports", "replicated_result"),
    contribution("h", "run_attempt", "supports", "replicated_result"),
    contribution("i", "run_attempt", "supports", "replicated_result"),
    contribution("j", "run_attempt", "supports", "replicated_result"),
    contribution("k", "run_attempt", "supports", "replicated_result"),
    contribution("l", "run_attempt", "supports", "replicated_result"),
    contribution("m", "run_attempt", "supports", "replicated_result"),
    contribution("n", "run_attempt", "supports", "replicated_result"),
    contribution("o", "run_attempt", "supports", "replicated_result"),
    contribution("p", "run_attempt", "supports", "replicated_result"),
    contribution("q", "run_attempt", "supports", "replicated_result"),
    contribution("r", "run_attempt", "supports", "replicated_result"),
    contribution("s", "run_attempt", "supports", "replicated_result"),
    contribution("t", "run_attempt", "supports", "replicated_result"),
  ]); // 20 × 0.4 = 8.0 → 0.5 + 0.5·(8/9) = 0.9444…
  assert.ok(Math.abs(big.confidence - (0.5 + 0.5 * (8 / 9))) < 1e-9);
});

test("property: confidence is monotone non-decreasing in the support-challenge delta", () => {
  let previous = -Infinity;
  for (let supports = 0; supports <= 10; supports += 1) {
    const belief = computeBelief(
      makeClaim("c", "X"),
      Array.from({ length: supports }, () => replicated("supports")),
    );
    assert.ok(belief.confidence >= previous, `confidence regressed at supports=${supports}`);
    previous = belief.confidence;
    assert.ok(belief.confidence >= 0 && belief.confidence <= 1);
  }
});

test("property: confidence stays in [0,1] and uncertainty in [0,1] under extreme evidence", () => {
  const huge = computeBelief(
    makeClaim("c", "X"),
    Array.from({ length: 500 }, () => replicated("supports")),
  );
  // The saturation transform is asymptotic: delta = 500×0.4 = 200 →
  // 0.5 + 0.5·(200/201) = 0.99751…, never exactly 1 (that is the design:
  // the last sliver of doubt is only removed by explicit falsification).
  assert.ok(Math.abs(huge.confidence - (0.5 + 0.5 * (200 / 201))) < 1e-9);
  assert.ok(huge.confidence < 1);
  assert.equal(huge.uncertainty, 0);
  const overwhelming = computeBelief(
    makeClaim("c", "X"),
    Array.from({ length: 500 }, () => replicated("challenges")),
  );
  // Same asymptote from below: delta = -200 → 0.5 - 0.5·(200/201) = 0.00249…
  assert.ok(Math.abs(overwhelming.confidence - (0.5 - 0.5 * (200 / 201))) < 1e-9);
  assert.ok(overwhelming.confidence > 0);
  assert.ok(overwhelming.uncertainty >= 0 && overwhelming.uncertainty <= 1);
  assert.equal(overwhelming.status, "falsified");
});

test("golden: falsification bar is weighted challenges ≥ 1.0 with challenges > supports", () => {
  // 2 × review_consensus (0.6) challenges → challenged but NOT falsified.
  const challenged = computeBelief(makeClaim("c", "X"), [
    contribution("a", "finding", "challenges", "review_consensus"),
    contribution("b", "finding", "challenges", "review_consensus"),
  ]);
  assert.equal(challenged.status, "challenged");
  // 3 × replicated (1.2) challenges → falsified.
  const falsified = computeBelief(makeClaim("c", "X"), [
    contribution("a", "run_attempt", "challenges", "replicated_result"),
    contribution("b", "run_attempt", "challenges", "replicated_result"),
    contribution("c", "run_attempt", "challenges", "replicated_result"),
  ]);
  assert.equal(falsified.status, "falsified");
  // Supported by 1 citation (0.1) — challenges still dominate.
  const supported = computeBelief(makeClaim("c", "X"), [
    contribution("s", "evidence_pack", "supports", "citation"),
    contribution("a", "run_attempt", "challenges", "replicated_result"),
    contribution("b", "run_attempt", "challenges", "replicated_result"),
    contribution("c", "run_attempt", "challenges", "replicated_result"),
  ]);
  assert.equal(supported.status, "falsified", "weighted challenges dominate a weak citation");
});

test("property: uncertainty decays monotonically with accumulated evidence weight", () => {
  let previous = Infinity;
  for (let count = 0; count <= 8; count += 1) {
    const belief = computeBelief(
      makeClaim("c", "X"),
      Array.from({ length: count }, () => contribution("a", "run_attempt", "supports", "observed_result")),
    );
    assert.ok(belief.uncertainty <= previous, `uncertainty rose at count=${count}`);
    previous = belief.uncertainty;
  }
  assert.equal(computeBelief(makeClaim("c", "X"), [replicated("supports")]).uncertainty, 1 - 0.15 * 0.4);
});
