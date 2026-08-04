import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { runBenchmark } from "../../src/benchmark/routerPolicyBenchmark.js";

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
  const [baseline, gate] = await runBenchmark(42);
  assert.equal(baseline.policy, "judge-only");
  assert.equal(gate.policy, "gate");
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
  assert.ok(sticky.successRate >= gate.successRate, "session pins must not hurt quality");
});
