import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalModelError,
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelRuntime,
} from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { createRouterRuntime } from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import { computeCapabilityRequirements } from "../../src/router/policy/capabilityRequirements.js";
import { AmortizedRanker } from "../../src/router/learning/AmortizedRanker.js";
import { UncertaintyGatedTierClassifier } from "../../src/router/learning/uncertaintyGatedClassifier.js";
import { createDefaultTierClassifier } from "../../src/router/tokenSaver/tierClassifier.js";

const SIMPLE = { id: "p/m1", provider: "p", model: "m1" };
const MEDIUM = { id: "p/m2", provider: "p", model: "m2" };
const REASONING = { id: "p/m3", provider: "p", model: "m3" };

function config(overrides: { researchAware?: boolean; learning?: boolean } = {}): RouterConfig {
  return {
    enabled: true,
    scenarios: { default: MEDIUM },
    fallback: { default: [MEDIUM] },
    tokenSaver: {
      enabled: true,
      judge: SIMPLE,
      defaultTier: "medium",
      judgeTimeoutMs: 1_000,
      tiers: {
        simple: { model: SIMPLE, description: "Simple" },
        medium: { model: MEDIUM, description: "Medium" },
        complex: { model: MEDIUM, description: "Complex" },
        reasoning: { model: REASONING, description: "Reasoning" },
      },
    },
    sticky: { enabled: false },
    researchAware: { enabled: overrides.researchAware ?? false, tierUpgrade: true },
    learning: { enabled: overrides.learning ?? false },
    stats: { enabled: false },
  };
}

function searchRequest(): CanonicalModelRequest {
  return {
    provider: "p",
    model: "m1",
    messages: [
      { role: "user", content: [{ type: "text", text: "survey the literature on X" }] },
    ],
    tools: [{ name: "web_search", description: "", inputSchema: { type: "object" } }],
    stream: true,
  };
}

function createModelRuntime(options: { fail?: boolean } = {}): ModelRuntime {
  const fail = options.fail ?? false;
  return {
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      if (fail) {
        yield {
          type: "error",
          error: {
            provider: "p",
            protocol: "openai",
            code: "server_error",
            message: "boom",
            retryable: false,
          } satisfies CanonicalModelError,
        };
        return;
      }
      yield { type: "text_delta", text: "ok" };
      yield { type: "usage", usage: { inputTokens: 2_000, outputTokens: 500, totalTokens: 2_500 } };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete(): Promise<CanonicalModelResponse> {
      return { role: "assistant", content: [{ type: "text", text: "ok" }], finishReason: "stop" };
    },
    getCapabilities: () => ({
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsToolUse: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 4_096,
    }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "http://127.0.0.1:1/v1",
  };
}

test("researchAware: search-tool request classified 'simple' is upgraded to reasoning", async () => {
  const router = createRouterRuntime(config({ researchAware: true }), {
    modelRuntime: createModelRuntime(),
    tierClassifier: {
      classify: async () => ({ tier: "simple", selection: SIMPLE, resolvedFrom: "judge" }),
    },
    now: () => new Date(1_000),
  });

  const decision = await router.decide({
    request: searchRequest(),
    sessionId: "s1",
    isMainAgent: true,
  });
  assert.equal(decision.model, "m3", "must upgrade to the reasoning-tier model");
  assert.equal(decision.tokenSaverTier, "reasoning");
  assert.equal(decision.mutations.researchAwareTierUpgraded?.from, "simple");
  assert.equal(decision.mutations.researchAwareTierUpgraded?.to, "reasoning");
});

test("researchAware: adequate classification is untouched", async () => {
  const router = createRouterRuntime(config({ researchAware: true }), {
    modelRuntime: createModelRuntime(),
    tierClassifier: {
      classify: async () => ({ tier: "reasoning", selection: REASONING, resolvedFrom: "judge" }),
    },
    now: () => new Date(1_000),
  });
  const decision = await router.decide({
    request: searchRequest(),
    sessionId: "s1",
    isMainAgent: true,
  });
  assert.equal(decision.model, "m3");
  assert.equal(decision.mutations.researchAwareTierUpgraded, undefined);
});

test("research metadata end-to-end: actionType=write_section upgrades a simple turn to reasoning", async () => {
  const router = createRouterRuntime(config({ researchAware: true }), {
    modelRuntime: createModelRuntime(),
    tierClassifier: {
      classify: async () => ({ tier: "simple", selection: SIMPLE, resolvedFrom: "judge" }),
    },
    now: () => new Date(1_000),
  });
  const decision = await router.decide({
    request: searchRequest(),
    sessionId: "s-research",
    isMainAgent: true,
    // The EIG planner's action type travels through GatewaySubmitTurnInput.research
    // → AgentSession → TurnRunner → RouterRuntime.decide metadata.
    metadata: { research: { actionType: "write_section", artifactKinds: ["manuscript_version"] } },
  });
  assert.equal(decision.tokenSaverTier, "reasoning", "write_section priors require the reasoning tier");
  assert.equal(decision.model, "m3");
  assert.equal(decision.mutations.researchAwareTierUpgraded?.from, "simple");
  assert.equal(decision.mutations.researchAwareTierUpgraded?.to, "reasoning");
});

test("research metadata end-to-end: classified tier already in priors stays untouched", async () => {
  const router = createRouterRuntime(config({ researchAware: true }), {
    modelRuntime: createModelRuntime(),
    tierClassifier: {
      classify: async () => ({ tier: "reasoning", selection: REASONING, resolvedFrom: "judge" }),
    },
    now: () => new Date(1_000),
  });
  const decision = await router.decide({
    request: searchRequest(),
    sessionId: "s-research-2",
    isMainAgent: true,
    metadata: { research: { actionType: "run_experiment" } },
  });
  // run_experiment priors = [reasoning]; the classified tier is already in the
  // priors — upgrade-only semantics keep it untouched.
  assert.equal(decision.mutations.researchAwareTierUpgraded, undefined);
  assert.equal(decision.tokenSaverTier, "reasoning");
});

test("learning: completed turns are observed as successes", async () => {
  const ranker = new AmortizedRanker();
  const router = createRouterRuntime(config({ learning: true }), {
    modelRuntime: createModelRuntime(),
    tierClassifier: new UncertaintyGatedTierClassifier(createDefaultTierClassifier(), ranker, {
      enabled: false, // keep the judge in charge; only the observer path is tested
    }),
    learning: { ranker },
    now: () => new Date(1_000),
  });

  assert.equal(ranker.totalObservations(), 0);
  const request = searchRequest();
  const decision = await router.decide({ request, sessionId: "s2", isMainAgent: true });
  const ctx = { sessionId: "s2", turnId: "t1", projectPath: "/tmp/p" };
  for await (const _event of router.execute(decision, request, ctx)) {
    // drain
  }
  assert.equal(ranker.totalObservations(), 1, "a completed turn must be observed");

  const bucket = ranker.bucketKey(computeCapabilityRequirements(request));
  const entries = ranker.score(bucket).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.successCount, 1);
});

test("learning: failed turns are observed as failures", async () => {
  const ranker = new AmortizedRanker();
  const router = createRouterRuntime(config({ learning: true }), {
    modelRuntime: createModelRuntime({ fail: true }),
    tierClassifier: new UncertaintyGatedTierClassifier(createDefaultTierClassifier(), ranker, {
      enabled: false,
    }),
    learning: { ranker },
    now: () => new Date(1_000),
  });
  const request = searchRequest();
  const decision = await router.decide({ request, sessionId: "s3", isMainAgent: true });
  const ctx = { sessionId: "s3", turnId: "t1", projectPath: "/tmp/p" };
  let sawError = false;
  for await (const event of router.execute(decision, request, ctx)) {
    if (event.type === "error") sawError = true;
  }
  assert.equal(sawError, true);
  const bucket = ranker.bucketKey(computeCapabilityRequirements(request));
  const entries = ranker.score(bucket).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.failureCount, 1);
});
