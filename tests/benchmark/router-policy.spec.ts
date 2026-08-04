import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { runBenchmark, runBenchmarkSeeds } from "../../src/benchmark/routerPolicyBenchmark.js";

/**
 * Locks the router-policy benchmark (scripts/benchmark-router-policy.mjs):
 * deterministic output for a fixed seed, and the qualitative relationships
 * the policy improvements are supposed to deliver:
 *   - the uncertainty gate cuts judge calls dramatically vs judge-only;
 *   - exploration (R14) trades some judge savings for higher quality;
 *   - sticky pins (R15 semantics) reuse decisions within a session.
 */
test("benchmark: deterministic for a fixed seed", async () => {
  const a = await runBenchmark(42);
  const b = await runBenchmark(42);
  assert.deepEqual(a, b, "same seed must produce identical results");
});

test("benchmark: gate cuts judge calls with near-parity quality", async () => {
  const results = await runBenchmark(42);
  const baseline = results.find((r) => r.policy === "judge-only")!;
  const gate = results.find((r) => r.policy === "gate")!;
  assert.ok(
    gate.judgeCallRate < baseline.judgeCallRate * 0.25,
    `gate must cut judge calls by >75% (got ${gate.judgeCallRate.toFixed(3)} vs ${baseline.judgeCallRate.toFixed(3)})`,
  );
  assert.ok(gate.successRate >= baseline.successRate - 0.05, "quality must stay within 5pp of the judge baseline");
  assert.ok(gate.costUnits < baseline.costUnits, "gate must cost less than judge-only");
});

test("benchmark: exploration trades judge savings for quality", async () => {
  const results = await runBenchmark(42);
  const gate = results.find((r) => r.policy === "gate")!;
  const explored = results.find((r) => r.policy === "gate+explore")!;
  assert.ok(explored.judgeCallRate > gate.judgeCallRate, "exploration consults the judge more often");
  assert.ok(explored.successRate > gate.successRate, "exploration must recover quality the locked learned path loses");
});

test("benchmark: sticky reuses pins across session turns", async () => {
  const results = await runBenchmark(42);
  const sticky = results.find((r) => r.policy === "sticky+gate")!;
  const gate = results.find((r) => r.policy === "gate")!;
  assert.ok(sticky.judgeCallRate < gate.judgeCallRate, "pins must cut judge calls below the plain gate");
  // Pins trade a little quality for the judge savings (mixed message types
  // within a session can make a locked tier suboptimal) — bound, not equal.
  assert.ok(sticky.successRate >= gate.successRate - 0.03, "pin quality must stay within 3pp of the gate");
});

test("benchmark: heuristic pre-filter cuts judge calls at zero quality cost (no-learning deployment)", async () => {
  const results = await runBenchmark(42);
  const baseline = results.find((r) => r.policy === "judge-only")!;
  const heuristic = results.find((r) => r.policy === "heuristic+judge")!;
  assert.ok(heuristic.judgeCallRate < baseline.judgeCallRate * 0.9, "heuristic must cut judge calls");
  assert.ok(
    Math.abs(heuristic.successRate - baseline.successRate) < 0.01,
    "heuristic must not hurt quality (zero mis-interception)",
  );
  assert.equal(heuristic.heuristicMisinterceptionRate, 0, "conservative exclusions must yield zero mis-interception");
});

test("benchmark: multi-seed aggregation is deterministic and stable", async () => {
  const a = await runBenchmarkSeeds([42, 43, 44]);
  const b = await runBenchmarkSeeds([42, 43, 44]);
  assert.deepEqual(a, b, "same seed set must produce identical aggregates");
  const gate = a.find((r) => r.policy === "gate")!;
  assert.ok(gate.judgeCallRateStd > 0, "error bars are non-zero across seeds");
  assert.ok(gate.judgeCallRate < 0.3, "gate stays under 30% judge calls across seeds");
  assert.ok(gate.successRate >= 0.9, "gate quality stays above 90% across seeds");
});
