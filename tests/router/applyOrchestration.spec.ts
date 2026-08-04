import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_ORCHESTRATION_TURNS,
  applyOrchestration,
} from "../../src/router/orchestrate/applyOrchestration.js";
import type { RouterAutoOrchestrateConfig } from "../../src/router/config/schema.js";

function config(overrides: Partial<RouterAutoOrchestrateConfig> = {}): RouterAutoOrchestrateConfig {
  return {
    enabled: true,
    triggerTiers: ["expert"],
    slimSystemPrompt: true,
    ...overrides,
  };
}

test("orchestration starts only when the tier is in triggerTiers", () => {
  const result = applyOrchestration({ config: config(), isMainAgent: true, tier: "expert" });
  assert.equal(result.applied, true);
  assert.equal(result.exited, false);
  assert.equal(result.mutations.orchestrationActivated?.continued, false);
});

test("non-trigger tier does not start orchestration", () => {
  const result = applyOrchestration({ config: config(), isMainAgent: true, tier: "simple" });
  assert.equal(result.applied, false);
  assert.equal(result.exited, false);
});

test("subagent turns never orchestrate", () => {
  const result = applyOrchestration({ config: config(), isMainAgent: false, tier: "expert" });
  assert.equal(result.applied, false);
});

test("a continuation turn whose tier no longer triggers exits immediately (no grace turn)", () => {
  const result = applyOrchestration({
    config: config(),
    isMainAgent: true,
    tier: "simple", // reclassified down on the very next turn
    alreadyOrchestrating: true,
    continuationCount: 0,
  });
  assert.equal(result.applied, false);
  assert.equal(result.exited, true, "a downgraded tier must end orchestration immediately");
});

test("an undefined tier in a continuation turn exits (judge/classifier failure)", () => {
  const result = applyOrchestration({
    config: config(),
    isMainAgent: true,
    tier: undefined,
    alreadyOrchestrating: true,
    continuationCount: 1,
  });
  assert.equal(result.applied, false);
  assert.equal(result.exited, true);
});

test("reclassification below trigger tiers exits an active run", () => {
  const result = applyOrchestration({
    config: config(),
    isMainAgent: true,
    tier: "simple",
    alreadyOrchestrating: true,
    continuationCount: 1,
  });
  assert.equal(result.applied, false);
  assert.equal(result.exited, true, "a downgraded tier must end orchestration");
});

test("the run cap exits an active run even while the tier still triggers", () => {
  const result = applyOrchestration({
    config: config({ maxContinuationTurns: 3 }),
    isMainAgent: true,
    tier: "expert",
    alreadyOrchestrating: true,
    continuationCount: 3,
  });
  assert.equal(result.applied, false);
  assert.equal(result.exited, true);
});

test("the default cap is DEFAULT_MAX_ORCHESTRATION_TURNS and continues below it", () => {
  const result = applyOrchestration({
    config: config(),
    isMainAgent: true,
    tier: "expert",
    alreadyOrchestrating: true,
    continuationCount: DEFAULT_MAX_ORCHESTRATION_TURNS - 1,
  });
  assert.equal(result.applied, true);
  assert.equal(result.exited, false);
});

test("an empty triggerTiers list treats every tier as triggering", () => {
  const result = applyOrchestration({
    config: config({ triggerTiers: [] }),
    isMainAgent: true,
    tier: "anything",
    alreadyOrchestrating: true,
    continuationCount: 0,
  });
  assert.equal(result.applied, true);
});

test("disabled config never orchestrates", () => {
  const result = applyOrchestration({ config: config({ enabled: false }), isMainAgent: true, tier: "expert" });
  assert.equal(result.applied, false);
  assert.equal(result.exited, false);
});
