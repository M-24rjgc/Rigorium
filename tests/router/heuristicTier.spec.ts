import assert from "node:assert/strict";
import test from "node:test";

import { classifyHeuristicSimple } from "../../src/router/tokenSaver/heuristicTier.js";
import { UncertaintyGatedTierClassifier } from "../../src/router/learning/uncertaintyGatedClassifier.js";
import { AmortizedRanker } from "../../src/router/learning/AmortizedRanker.js";

const CONFIG = {
  enabled: true,
  judge: { id: "p/m0", provider: "p", model: "m0" },
  defaultTier: "medium",
  judgeTimeoutMs: 1000,
  tiers: {
    simple: { model: { id: "p/m0", provider: "p", model: "m0" } },
    medium: { model: { id: "p/m1", provider: "p", model: "m1" } },
    complex: { model: { id: "p/m2", provider: "p", model: "m2" } },
    reasoning: { model: { id: "p/m3", provider: "p", model: "m3" } },
  },
};

function messagesWith(text: string) {
  return [{ role: "user" as const, content: [{ type: "text" as const, text }] }];
}

// ---------------------------------------------------------------------------
// heuristicTier
// ---------------------------------------------------------------------------

test("heuristic: obvious-simple requests are classified simple", () => {
  const cases = [
    "what is a claim graph?",
    "hello",
    "thanks!",
    "define uncertainty",
    "hi",
    "explain briefly what EIG means",
  ];
  for (const text of cases) {
    const result = classifyHeuristicSimple(text);
    assert.equal(result.isSimple, true, `expected simple: ${text} (signals: ${result.signals.join(", ")})`);
  }
});

test("heuristic: code/reasoning/technical markers forbid the simple verdict", () => {
  const cases = [
    "what is the best way to debug this function?",
    "define an API for the experiment runner",
    "hello, please implement the fix for the bug",
    "what is a distributed architecture for GPU training?",
    "compare and evaluate these two algorithms",
  ];
  for (const text of cases) {
    const result = classifyHeuristicSimple(text);
    assert.equal(result.isSimple, false, `expected NOT simple: ${text} (signals: ${result.signals.join(", ")})`);
  }
});

test("heuristic: long messages never classify simple", () => {
  const longGreeting = "hello, I wanted to ask a quick question about the project structure".repeat(3);
  const result = classifyHeuristicSimple(longGreeting);
  assert.equal(result.isSimple, false);
  assert.ok(result.signals.some((s) => s.startsWith("long")));
});

test("heuristic: no simple indicator → not simple even when short", () => {
  const result = classifyHeuristicSimple("run the experiment now");
  assert.equal(result.isSimple, false, "no simple-indicator hit must not classify simple");
});

test("heuristic: empty message is never simple", () => {
  assert.equal(classifyHeuristicSimple("   ").isSimple, false);
});

// ---------------------------------------------------------------------------
// classifier integration (zero-cost first level)
// ---------------------------------------------------------------------------

test("classifier: short continuation inherits the previous tier without the judge", async () => {
  const ranker = new AmortizedRanker();
  let judgeCalls = 0;
  const classifier = new UncertaintyGatedTierClassifier(
    {
      classify: async () => {
        judgeCalls += 1;
        return { tier: "medium", selection: CONFIG.tiers.medium.model, resolvedFrom: "judge" };
      },
    },
    ranker,
    { random: () => 0.999 },
  );
  const decision = await classifier.classify({
    config: CONFIG as never,
    messages: messagesWith("continue"),
    judgeRuntime: undefined as never,
    previousTier: "reasoning",
  } as never);
  assert.equal(judgeCalls, 0, "continuation must not consult the judge");
  assert.equal(decision?.resolvedFrom, "continuation");
  assert.equal(decision?.tier, "reasoning");
});

test("classifier: obvious-simple message short-circuits to simple without the judge", async () => {
  const ranker = new AmortizedRanker();
  let judgeCalls = 0;
  const classifier = new UncertaintyGatedTierClassifier(
    {
      classify: async () => {
        judgeCalls += 1;
        return { tier: "medium", selection: CONFIG.tiers.medium.model, resolvedFrom: "judge" };
      },
    },
    ranker,
    { random: () => 0.999 },
  );
  const decision = await classifier.classify({
    config: CONFIG as never,
    messages: messagesWith("what is a claim graph?"),
    judgeRuntime: undefined as never,
    requirements: { toolCategories: ["search"], modalities: ["text"], requiresOrchestration: false, research: {} },
  } as never);
  assert.equal(judgeCalls, 0, "heuristic simple must not consult the judge");
  assert.equal(decision?.resolvedFrom, "heuristic");
  assert.equal(decision?.tier, "simple");
  assert.equal(decision?.selection.model, "m0");
});

test("classifier: complex-looking short message still consults the judge", async () => {
  const ranker = new AmortizedRanker();
  let judgeCalls = 0;
  const classifier = new UncertaintyGatedTierClassifier(
    {
      classify: async () => {
        judgeCalls += 1;
        return { tier: "complex", selection: CONFIG.tiers.complex.model, resolvedFrom: "judge" };
      },
    },
    ranker,
    { random: () => 0.999 },
  );
  const decision = await classifier.classify({
    config: CONFIG as never,
    messages: messagesWith("debug this function"),
    judgeRuntime: undefined as never,
  } as never);
  assert.equal(judgeCalls, 1, "excluded markers must fall through to the judge");
  assert.equal(decision?.resolvedFrom, "judge");
});
