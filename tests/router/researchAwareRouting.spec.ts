import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTierPrior,
  categorizeTool,
  computeCapabilityRequirements,
  parseResearchHint,
  tierPriorForRequirements,
} from "../../src/router/policy/capabilityRequirements.js";
import { AmortizedRanker } from "../../src/router/learning/AmortizedRanker.js";
import { UncertaintyGatedTierClassifier } from "../../src/router/learning/uncertaintyGatedClassifier.js";
import type { TierClassifier } from "../../src/router/tokenSaver/tierClassifier.js";

// ---------------------------------------------------------------------------
// capabilityRequirements
// ---------------------------------------------------------------------------

test("categorizeTool: maps tool names to capability categories", () => {
  assert.equal(categorizeTool("web_search"), "search");
  assert.equal(categorizeTool("literature_search"), "search");
  assert.equal(categorizeTool("agent"), "orchestration");
  assert.equal(categorizeTool("experiment_analysis"), "analysis");
  assert.equal(categorizeTool("manuscript_version"), "content_generation");
  assert.equal(categorizeTool("read_file"), "filesystem");
  assert.equal(categorizeTool("mcp__custom__thing"), "other");
});

test("computeCapabilityRequirements: collects modalities, tools, and complexity", () => {
  const requirements = computeCapabilityRequirements({
    provider: "p",
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(20_000) },
          { type: "image", source: "base64", mimeType: "image/png", bytes: 10, data: "base64" },
        ],
      },
    ],
    tools: [{ name: "web_search", description: "", inputSchema: { type: "object" } }],
  });
  // Modality collection reports the non-text modalities required (text is
  // always available).
  assert.deepEqual([...requirements.modalities], ["image"]);
  assert.ok(requirements.toolCategories.includes("search"));
  assert.equal(requirements.requiresOrchestration, false);
  assert.equal(requirements.complexitySignal, true, "20k chars is a complexity signal");
});

test("computeCapabilityRequirements: orchestration detection via agent tool", () => {
  const requirements = computeCapabilityRequirements({
    provider: "p",
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "delegate" }] }],
    tools: [{ name: "agent", description: "", inputSchema: { type: "object" } }],
  });
  assert.equal(requirements.requiresOrchestration, true);
});

test("tierPriorForRequirements: research actions demand reasoning/complex tiers", () => {
  const search = computeCapabilityRequirements({
    provider: "p",
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "survey" }] }],
    tools: [{ name: "web_search", description: "", inputSchema: { type: "object" } }],
  });
  assert.ok(tierPriorForRequirements(search).includes("reasoning"));

  const orchestrated = computeCapabilityRequirements({
    provider: "p",
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    tools: [{ name: "agent", description: "", inputSchema: { type: "object" } }],
  });
  assert.ok(tierPriorForRequirements(orchestrated).includes("complex"));

  const writing = computeCapabilityRequirements(
    {
      provider: "p",
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "write" }] }],
      tools: [],
    },
    { actionType: "write_section" },
  );
  assert.ok(tierPriorForRequirements(writing).includes("reasoning"));
});

test("applyTierPrior: upgrades a too-weak tier, leaves adequate tiers alone", () => {
  const tiers = ["simple", "medium", "complex", "reasoning"];
  const upgraded = applyTierPrior("simple", ["reasoning"], tiers);
  assert.equal(upgraded.tier, "reasoning");
  assert.equal(upgraded.upgraded, true);

  const adequate = applyTierPrior("reasoning", ["reasoning", "complex"], tiers);
  assert.equal(adequate.upgraded, false);

  const noPriors = applyTierPrior("simple", [], tiers);
  assert.equal(noPriors.upgraded, false);

  const unknownPriors = applyTierPrior("simple", ["super-tier"], tiers);
  assert.equal(unknownPriors.upgraded, false, "priors referencing unknown tiers are ignored");
});

test("parseResearchHint: extracts fields from untrusted metadata, drops garbage", () => {
  assert.deepEqual(
    parseResearchHint({ artifactKinds: ["run_attempt"], actionType: "run_experiment" }),
    { artifactKinds: ["run_attempt"], actionType: "run_experiment" },
  );
  assert.equal(parseResearchHint(undefined), undefined);
  assert.equal(parseResearchHint("nope"), undefined);
  assert.equal(parseResearchHint({}), undefined);
  assert.equal(parseResearchHint({ artifactKinds: [42], actionType: 7 }), undefined);
  assert.deepEqual(parseResearchHint({ artifactKinds: ["a", 42], actionType: "write_section" }), {
    artifactKinds: ["a"],
    actionType: "write_section",
  });
});

// ---------------------------------------------------------------------------
// AmortizedRanker
// ---------------------------------------------------------------------------

function requirements(overrides: { actionType?: string; search?: boolean; orchestrate?: boolean } = {}) {
  return computeCapabilityRequirements(
    {
      provider: "p",
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "task" }] }],
      tools: [
        ...(overrides.search ? [{ name: "web_search", description: "", inputSchema: { type: "object" } }] : []),
        ...(overrides.orchestrate ? [{ name: "agent", description: "", inputSchema: { type: "object" } }] : []),
      ],
    },
    { actionType: overrides.actionType },
  );
}

test("AmortizedRanker: same capability signature maps to the same bucket", () => {
  const ranker = new AmortizedRanker();
  const a = ranker.bucketKey(requirements({ search: true }));
  const b = ranker.bucketKey(requirements({ search: true }));
  const c = ranker.bucketKey(requirements({ orchestrate: true }));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("AmortizedRanker: observes and scores tiers with Laplace smoothing", () => {
  const ranker = new AmortizedRanker();
  const bucket = ranker.bucketKey(requirements({ search: true }));
  ranker.observe(bucket, "reasoning", "success");
  ranker.observe(bucket, "reasoning", "success");
  ranker.observe(bucket, "reasoning", "success");
  ranker.observe(bucket, "medium", "failure");
  ranker.observe(bucket, "medium", "failure");

  const scored = ranker.score(bucket);
  assert.equal(scored.totalObservations, 5);
  assert.equal(scored.topTier, "reasoning");
  assert.ok(scored.topMargin > 0);
  assert.ok(scored.entries[0]!.score > scored.entries[1]!.score);
  assert.ok(scored.topTierAvgCostUnits >= 0);
});

test("AmortizedRanker: unknown bucket scores empty", () => {
  const ranker = new AmortizedRanker();
  const scored = ranker.score("nope");
  assert.equal(scored.totalObservations, 0);
  assert.equal(scored.topTier, undefined);
});

// ---------------------------------------------------------------------------
// UncertaintyGatedTierClassifier
// ---------------------------------------------------------------------------

const JUDGE_DECISION = { tier: "medium", selection: { id: "p/m2", provider: "p", model: "m2" }, resolvedFrom: "judge" as const };
const CONFIG = {
  enabled: true,
  judge: { id: "p/j", provider: "p", model: "j" },
  defaultTier: "medium",
  judgeTimeoutMs: 1_000,
  tiers: {
    simple: { model: { id: "p/m1", provider: "p", model: "m1" } },
    medium: { model: { id: "p/m2", provider: "p", model: "m2" } },
    reasoning: { model: { id: "p/m3", provider: "p", model: "m3" } },
  },
};

function judgeStub(): TierClassifier {
  return { classify: async () => JUDGE_DECISION };
}

test("UncertaintyGatedTierClassifier: cold start delegates to the judge", async () => {
  const ranker = new AmortizedRanker();
  let judgeCalls = 0;
  const classifier = new UncertaintyGatedTierClassifier(
    {
      classify: async (input) => {
        judgeCalls += 1;
        return JUDGE_DECISION;
      },
    },
    ranker,
  );
  const decision = await classifier.classify({
    config: CONFIG as never,
    messages: [],
    judgeRuntime: undefined as never,
    requirements: requirements({ search: true }),
  });
  assert.equal(judgeCalls, 1);
  assert.equal(decision?.resolvedFrom, "judge");
});

test("UncertaintyGatedTierClassifier: confident ranker skips the judge", async () => {
  const ranker = new AmortizedRanker();
  const bucket = ranker.bucketKey(requirements({ search: true }));
  // Two competing tiers with a decisive margin: reasoning succeeded 6×,
  // medium failed 3× → learned path must win without the judge.
  for (let i = 0; i < 6; i += 1) {
    ranker.observe(bucket, "reasoning", "success");
  }
  for (let i = 0; i < 3; i += 1) {
    ranker.observe(bucket, "medium", "failure");
  }
  let judgeCalls = 0;
  const classifier = new UncertaintyGatedTierClassifier(
    {
      classify: async () => {
        judgeCalls += 1;
        return JUDGE_DECISION;
      },
    },
    ranker,
    { minObservations: 4, minMargin: 0.1 },
  );
  const decision = await classifier.classify({
    config: CONFIG as never,
    messages: [],
    judgeRuntime: undefined as never,
    requirements: requirements({ search: true }),
  });
  assert.equal(judgeCalls, 0, "judge must be skipped when the ranker is confident");
  assert.equal(decision?.resolvedFrom, "learned");
  assert.equal(decision?.tier, "reasoning");
  assert.equal(decision?.selection.model, "m3");
});

test("UncertaintyGatedTierClassifier: a failure-only single-tier bucket never locks out the judge", async () => {
  const ranker = new AmortizedRanker();
  const bucket = ranker.bucketKey(requirements({ search: true }));
  // Four consecutive failures on the only observed tier: the learned path
  // must NOT fire (no competition between tiers) — the judge stays in charge.
  for (let i = 0; i < 4; i += 1) {
    ranker.observe(bucket, "reasoning", "failure");
  }
  let judgeCalls = 0;
  const classifier = new UncertaintyGatedTierClassifier(
    {
      classify: async () => {
        judgeCalls += 1;
        return JUDGE_DECISION;
      },
    },
    ranker,
    { minObservations: 4, minMargin: 0.1 },
  );
  const decision = await classifier.classify({
    config: CONFIG as never,
    messages: [],
    judgeRuntime: undefined as never,
    requirements: requirements({ search: true }),
  });
  assert.equal(judgeCalls, 1, "failure-only bucket must consult the judge");
  assert.equal(decision?.resolvedFrom, "judge");
});

test("UncertaintyGatedTierClassifier: mixed outcomes keep the judge in charge", async () => {
  const ranker = new AmortizedRanker();
  const bucket = ranker.bucketKey(requirements({ search: true }));
  ranker.observe(bucket, "reasoning", "success");
  ranker.observe(bucket, "medium", "success");
  ranker.observe(bucket, "medium", "success");
  let judgeCalls = 0;
  const classifier = new UncertaintyGatedTierClassifier(
    {
      classify: async () => {
        judgeCalls += 1;
        return JUDGE_DECISION;
      },
    },
    ranker,
    { minObservations: 4, minMargin: 0.1 },
  );
  await classifier.classify({
    config: CONFIG as never,
    messages: [],
    judgeRuntime: undefined as never,
    requirements: requirements({ search: true }),
  });
  assert.equal(judgeCalls, 1, "low margin → judge decides");
});
