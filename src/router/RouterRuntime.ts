import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelRuntime,
} from "../model/index.js";
import {
  LITELLM_DEFAULT_MAX_RETRIES,
  LITELLM_INITIAL_RETRY_DELAY_MS,
  LITELLM_MAX_RETRY_DELAY_MS,
} from "../model/streaming/streamModel.js";
import { buildLiteLLMContinuationRequest } from "../model/streaming/continuationRequest.js";
import {
  DEFAULT_SUBAGENT_POLICY,
  type RouterConfig,
  type RouterModelRef,
} from "./config/schema.js";
import type {
  RigoriumCustomRouter,
  CustomRouterRegistry,
} from "./customRouter/customRouter.js";
import { noopCustomRouterRegistry } from "./customRouter/customRouter.js";
import { isFallbackEligible, planFallback } from "./fallback/runFallbackChain.js";
import { applyOrchestration } from "./orchestrate/applyOrchestration.js";
import type {
  RouterDecision,
  RouterDecisionInput,
  RouterExecuteContext,
  RouterMutationsLog,
  RouterScenarioType,
} from "./protocol/decision.js";
import type { RouterEventBus } from "./protocol/events.js";
import { decideScenario } from "./scenario/decideScenario.js";
import { stripSubagentTagFromMessages } from "./scenario/subagentDetector.js";
import { SessionRouterStore } from "./session/SessionRouterStore.js";
import { SessionUsageCache } from "./session/sessionUsageCache.js";
import { ProviderHealthTracker } from "./health/ProviderHealthTracker.js";
import { TokenStatsCollector } from "./stats/TokenStatsCollector.js";
import {
  createDefaultTierClassifier,
  type TierClassifier,
} from "./tokenSaver/tierClassifier.js";
import { countMessagesTokens, countResponseTokens, dispose as disposeTokenizer } from "./utils/countTokens.js";
import { collectRequiredInputModalities } from "./utils/mediaRequirements.js";
import type { TelemetryClient } from "../telemetry/index.js";
import { abortableDelay } from "./execution/abortable.js";
import {
  buildAttemptPlans,
  clampMaxOutputTokensToModelCap,
  downgradeRequestForAttempt,
  type AttemptPlan,
} from "./execution/attemptPlanning.js";
import { SERVER_RETRY_AFTER_CAP_MS, exponentialBackoffDelay } from "../model/streaming/backoff.js";
import {
  bufferedHasToolCall,
  calculateLiteLLMRetryDelay,
  classifyRetryReason,
  createUnsupportedMediaError,
  extractPartialText,
  isMidStreamRateLimitError,
  protocolForProvider,
} from "./execution/errors.js";
import {
  streamAttempt,
  type AttemptOutcome,
} from "./execution/streamAttempt.js";
import { ProviderConcurrencyGate } from "./execution/providerConcurrency.js";
import {
  createMediaCapabilityChecks,
  rerouteDecisionForMedia,
} from "./policy/mediaCapability.js";
import {
  maybePreserveStickyForCache,
  type CacheAwareSwitchingConfig,
} from "./policy/cacheAwareSwitching.js";
import { createStickyGuard } from "./policy/stickyGuard.js";
import {
  applyTierPrior,
  computeCapabilityRequirements,
  tierPriorForRequirements,
} from "./policy/capabilityRequirements.js";
import { AmortizedRanker } from "./learning/AmortizedRanker.js";

export type RouterRuntimeDeps = {
  modelRuntime: ModelRuntime;
  judgeRuntime?: ModelRuntime;
  customRouterRegistry?: CustomRouterRegistry;
  /** Optional skill prompt loader for AutoOrchestrate; receives extension id, returns text. */
  loadSkillPrompt?: (extensionId: string) => Promise<string | undefined>;
  events?: RouterEventBus;
  telemetry?: TelemetryClient;
  now?: () => Date;
  /**
   * Externally-owned session store that survives config-reload cycles.
   * When provided, `shutdown()` will NOT clear it.
   */
  sessionStore?: SessionRouterStore;
  /**
   * Externally-owned health tracker shared across router instances.
   * Provider degradation is a provider-level fact (a provider outage affects
   * every session and every project), so it should not be re-discovered per
   * session. When omitted, a per-session tracker is kept for compatibility.
   */
  healthTracker?: ProviderHealthTracker;
  /**
   * Strategy seam for tier classification (tokenSaver). Defaults to the
   * judge-LLM classifier; Phase 2 swaps in an uncertainty-gated
   * implementation without touching call sites.
   */
  tierClassifier?: TierClassifier;
  /**
   * Phase 2: amortized ranker for the uncertainty-gated classifier. When
   * provided, the router computes capability requirements per request and
   * feeds routed-turn outcomes back into the ranker (success/failure/cost).
   * `persistPath` (when set) makes shutdown() flush the ranker state.
   */
  learning?: { ranker: AmortizedRanker; persistPath?: string };
};

export type InvalidateStickyResult = {
  previousTier?: string;
  previousProvider?: string;
  previousModel?: string;
  orchestrating: boolean;
};

export type RouterRuntime = {
  decide(input: RouterDecisionInput): Promise<RouterDecision>;
  execute(
    decision: RouterDecision,
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext & { isMainAgent?: boolean },
  ): AsyncIterable<CanonicalModelEvent>;
  /** Convenience helper used by agent loop: decide + execute in one call. */
  stream(
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext & { sessionId: string; isMainAgent: boolean; previousTier?: string },
  ): AsyncIterable<CanonicalModelEvent>;
  materializeRequest(decision: RouterDecision, request: CanonicalModelRequest): CanonicalModelRequest;
  /**
   * Clear routing sticky (provider/model/tier) for a session while preserving
   * orchestration state.  Call at the start of each new user turn so the
   * judge re-classifies the fresh message instead of reusing a stale tier.
   */
  invalidateSticky(sessionId: string): InvalidateStickyResult;
  observeUsage(sessionId: string, usage: import("../model/index.js").CanonicalUsage | undefined): void;
  stats: TokenStatsCollector;
  shutdown(): Promise<void>;
};

export function createRouterRuntime(
  config: RouterConfig,
  deps: RouterRuntimeDeps,
): RouterRuntime {
  const enabled = config.enabled !== false;
  // Per-provider concurrency gate (LiteLLM-style in-flight cap). One gate per
  // runtime instance — the gateway creates a single shared RouterRuntime for
  // all sessions, so the cap is process-wide, not per-session. Router
  // disabled (passthrough) → no gate.
  const concurrencyGate = enabled && config.concurrency?.enabled !== false
    ? new ProviderConcurrencyGate(config.concurrency)
    : undefined;
  const stats = new TokenStatsCollector({
    ...config.stats,
    enabled: enabled && (config.stats?.enabled ?? false),
    baselineModel: config.scenarios?.default
      ? { provider: config.scenarios.default.provider, model: config.scenarios.default.model }
      : config.stats?.baselineModel,
  });
  const externalStore = !!deps.sessionStore;
  const sessionStore = deps.sessionStore ?? new SessionRouterStore({
    now: () => (deps.now?.() ?? new Date()).getTime(),
  });
  const usageCache = new SessionUsageCache();
  const customRouters = deps.customRouterRegistry ?? noopCustomRouterRegistry;
  const judgeRuntime = deps.judgeRuntime ?? deps.modelRuntime;
  const events = deps.events ?? { emit: () => undefined };
  const telemetry = deps.telemetry;
  const tierClassifier = deps.tierClassifier ?? createDefaultTierClassifier();
  const sharedHealthTracker = deps.healthTracker;
  const healthTrackers = new Map<string, ProviderHealthTracker>();
  function getHealthTracker(sessionId: string): ProviderHealthTracker {
    if (sharedHealthTracker) {
      return sharedHealthTracker;
    }
    let tracker = healthTrackers.get(sessionId);
    if (!tracker) {
      tracker = new ProviderHealthTracker();
      healthTrackers.set(sessionId, tracker);
    }
    return tracker;
  }

  /**
   * Feed a routed-turn outcome back into the amortized ranker. Cost units are
   * a coarse token-derived proxy (1 unit ≈ 1k tokens); the taste-calibration
   * loop refines the mapping later. Successes are only attributed to the
   * decide-time tier when the *pinned attempt* delivered (attemptIndex 0) —
   * a fallback-rescued turn says nothing about the pinned tier's quality.
   */
  function observeRoutingOutcome(
    decision: RouterDecision,
    outcome: "success" | "failure",
    costUnits?: number,
  ): void {
    if (!learningRanker) return;
    const pending = pendingByDecision.get(decision);
    if (!pending) return;
    learningRanker.observe(pending.bucket, pending.tier, outcome, costUnits);
  }

  const mediaChecks = createMediaCapabilityChecks(deps.modelRuntime);
  const isStickyUsable = createStickyGuard(config.sticky, () =>
    (deps.now?.() ?? new Date()).getTime(),
  );
  const cacheAwareConfig: CacheAwareSwitchingConfig | undefined =
    config.tokenSaver?.cacheAwareSwitching;
  const researchAwareEnabled = config.researchAware?.enabled === true;
  const learningRanker = deps.learning?.ranker;
  /**
   * Per-decision routing context stashed by decide() for execute() to feed
   * outcome observations back into the amortized ranker. Keyed by the
   * decision object itself (not sessionId): decide→execute pairs are matched
   * 1:1 even when the agent loop interleaves parallel routed streams on the
   * same session, and the entry is garbage-collected with the decision.
   */
  const pendingByDecision = new WeakMap<
    RouterDecision,
    { bucket: string; tier: string }
  >();

  function fallbackCandidatesFor(scenarioType: RouterScenarioType): RouterModelRef[] {
    const candidates: RouterModelRef[] = [];
    const add = (refs: RouterModelRef[] | undefined) => {
      for (const ref of refs ?? []) {
        const id = ref.id || `${ref.provider}/${ref.model}`;
        if (!candidates.some((candidate) => candidate.provider === ref.provider && candidate.model === ref.model)) {
          candidates.push({ ...ref, id });
        }
      }
    };
    add((config.fallback as Record<string, RouterModelRef[] | undefined> | undefined)?.[scenarioType]);
    add(config.fallback?.default);
    return candidates;
  }

  async function resolveCustom(
    input: RouterDecisionInput,
  ): Promise<Partial<RouterDecision> | undefined> {
    if (!config.customRouter) {
      return undefined;
    }
    const router: RigoriumCustomRouter | undefined = customRouters.lookupRouter(
      config.customRouter.extensionId,
    );
    if (!router) {
      return undefined;
    }
    try {
      return await router.decide({
        ...input,
        context: {
          sessionId: input.sessionId,
          isMainAgent: input.isMainAgent,
          scenarios: Object.keys(config.scenarios ?? {}),
        },
      });
    } catch (error) {
      events.emit({
        type: "rigorium_router_custom_failed",
        sessionId: input.sessionId,
        extensionId: config.customRouter.extensionId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async function decide(input: RouterDecisionInput): Promise<RouterDecision> {
    if (!enabled) {
      return {
        provider: input.request.provider,
        model: input.request.model,
        scenarioType: "default",
        isSubagent: !input.isMainAgent,
        orchestrating: false,
        resolvedFrom: "scenario",
        mutations: {},
      };
    }

    const sticky = sessionStore.get(input.sessionId, !input.isMainAgent);
    const baseUsage = usageCache.get(input.sessionId);
    const inputWithUsage: RouterDecisionInput = {
      ...input,
      metadata: {
        ...input.metadata,
        lastUsage: input.metadata?.lastUsage ?? {
          inputTokens: baseUsage?.inputTokens,
          outputTokens: baseUsage?.outputTokens,
          totalTokens: baseUsage?.totalTokens,
        },
      },
    };

    const custom = await resolveCustom(inputWithUsage);
    const scenarioOutcome = decideScenario(inputWithUsage, config.scenarios ?? {} as any);

    // Phase 2: deterministic capability requirements — derived once, consumed
    // by the uncertainty-gated classifier, the research-aware tier upgrade,
    // and the outcome observer.
    const requirements = researchAwareEnabled || learningRanker
      ? computeCapabilityRequirements(input.request, input.metadata?.research)
      : undefined;

    let scenarioType: RouterScenarioType = scenarioOutcome.scenarioType;
    const previousStickySelection = (input.metadata?.previousProvider && input.metadata.previousModel)
      ? {
        id: `${input.metadata.previousProvider}/${input.metadata.previousModel}`,
        provider: input.metadata.previousProvider,
        model: input.metadata.previousModel,
      }
      : isStickyUsable(sticky)
      ? { id: `${sticky.stickyProvider}/${sticky.stickyModel}`, provider: sticky.stickyProvider, model: sticky.stickyModel }
      : undefined;
    let selection: RouterModelRef | undefined =
      custom?.provider && custom.model
        ? { id: `${custom.provider}/${custom.model}`, provider: custom.provider, model: custom.model }
        : scenarioOutcome.selection;

    let resolvedFrom: RouterDecision["resolvedFrom"] = custom?.provider
      ? "custom"
      : scenarioType === "explicit"
        ? "explicit"
        : "scenario";

    let tokenSaverTier: string | undefined;
    let cacheAwareSwitch: RouterMutationsLog["cacheAwareSwitch"];
    const subagentPolicy = config.tokenSaver?.subagent?.policy ?? DEFAULT_SUBAGENT_POLICY;
    if (
      !custom?.provider &&
      scenarioType !== "explicit" &&
      config.tokenSaver?.enabled &&
      (input.isMainAgent || subagentPolicy !== "skip")
    ) {
      let stickyHit = false;

      if (input.isMainAgent && input.request.messages.length > 1) {
        const mainSticky = sessionStore.get(input.sessionId, false);
        if (isStickyUsable(mainSticky)) {
          selection = {
            id: `${mainSticky.stickyProvider}/${mainSticky.stickyModel}`,
            provider: mainSticky.stickyProvider,
            model: mainSticky.stickyModel,
          };
          resolvedFrom = "tokenSaver";
          tokenSaverTier = mainSticky.tokenSaverTier;
          stickyHit = true;
        }
      }

      if (!input.isMainAgent && subagentPolicy === "judge" && input.request.messages.length > 1) {
        const subSticky = sessionStore.get(input.sessionId, true);
        if (isStickyUsable(subSticky)) {
          selection = {
            id: `${subSticky.stickyProvider}/${subSticky.stickyModel}`,
            provider: subSticky.stickyProvider,
            model: subSticky.stickyModel,
          };
          resolvedFrom = "tokenSaver";
          tokenSaverTier = subSticky.tokenSaverTier;
          stickyHit = true;
        }
      }

      if (!stickyHit) {
        const tokenSaver = await tierClassifier.classify({
          config: config.tokenSaver,
          messages: input.request.messages,
          judgeRuntime,
          previousTier: input.metadata?.previousTier,
          sessionId: input.sessionId,
          telemetry,
          ...(requirements ? { requirements } : {}),
        });
        if (tokenSaver) {
          if (tokenSaver.failureReason) {
            events.emit({
              type: "rigorium_router_token_saver_failed",
              sessionId: input.sessionId,
              reason: tokenSaver.failureReason,
              fallbackTier: tokenSaver.tier,
            });
          }
          if (tokenSaver.selection) {
            selection = tokenSaver.selection;
            // Preserve the classifier's provenance (judge vs learned vs
            // default): the learned path must be observable in decisions and
            // stats, not flattened into a generic "tokenSaver".
            resolvedFrom = tokenSaver.resolvedFrom ?? "tokenSaver";
            const cacheAware = maybePreserveStickyForCache(
              previousStickySelection,
              selection,
              input.request.messages,
              baseUsage,
              cacheAwareConfig,
              config.stats?.modelPricing,
            );
            selection = cacheAware.selection;
            cacheAwareSwitch = cacheAware.mutation;
          }
          tokenSaverTier = cacheAwareSwitch?.action === "kept_sticky"
            ? (sticky?.tokenSaverTier ?? input.metadata?.previousTier ?? tokenSaver.tier)
            : tokenSaver.tier;
        }
      }
    }

    if (!selection && scenarioOutcome.subagentModelHint) {
      const slash = scenarioOutcome.subagentModelHint.indexOf("/");
      if (slash >= 0) {
        const provider = scenarioOutcome.subagentModelHint.slice(0, slash);
        const model = scenarioOutcome.subagentModelHint.slice(slash + 1);
        if (provider && model) {
          selection = { id: scenarioOutcome.subagentModelHint, provider, model };
          resolvedFrom = "explicit";
        }
      }
    }

    if (!selection) {
      selection = config.scenarios?.default;
      scenarioType = scenarioType === "explicit" ? scenarioType : "default";
    }

    if (!selection) {
      throw new Error("Router: no default scenario configured and no model could be resolved");
    }

    // Phase 2: research-aware tier upgrade — capability requirements may
    // override a too-weak classification (e.g. a web-research task judged
    // "simple" because its first message was short).
    let researchAwareUpgrade: RouterMutationsLog["researchAwareTierUpgraded"];
    if (
      researchAwareEnabled &&
      config.researchAware?.tierUpgrade !== false &&
      requirements &&
      tokenSaverTier
    ) {
      const knownTiers = Object.keys(config.tokenSaver?.tiers ?? {});
      const priors = tierPriorForRequirements(requirements);
      const { tier: targetTier, upgraded } = applyTierPrior(tokenSaverTier, priors, knownTiers);
      if (upgraded && targetTier !== tokenSaverTier) {
        const targetModel = config.tokenSaver?.tiers?.[targetTier]?.model;
        if (targetModel) {
          researchAwareUpgrade = {
            from: tokenSaverTier,
            to: targetTier,
            reason: `requirements: ${priors.join(",")}`,
          };
          tokenSaverTier = targetTier;
          selection = targetModel;
        }
      }
    }

    // Stash the routing context on the decision object so execute() can feed
    // outcome observations back into the amortized ranker for this capability
    // signature (matched by object identity — safe under interleaved streams).
    const decision: RouterDecision = {
      provider: selection.provider,
      model: selection.model,
      scenarioType,
      tokenSaverTier,
      isSubagent: scenarioOutcome.isSubagent,
      orchestrating: false,
      resolvedFrom,
      mutations: {},
    };
    if (learningRanker && requirements) {
      pendingByDecision.set(decision, {
        bucket: learningRanker.bucketKey(requirements),
        tier: tokenSaverTier ?? "default",
      });
    }

    const alreadyOrchestrating = sticky?.orchestrating === true;
    const tokenSaverActive = config.tokenSaver?.enabled === true && tokenSaverTier != null;
    const orchGate = tokenSaverActive || alreadyOrchestrating;

    let mutations: RouterMutationsLog = {};
    if (cacheAwareSwitch) {
      mutations = { ...mutations, cacheAwareSwitch };
    }
    if (researchAwareUpgrade) {
      mutations = { ...mutations, researchAwareTierUpgraded: researchAwareUpgrade };
    }
    if (config.autoOrchestrate?.enabled && orchGate) {
      const orchestrated = applyOrchestration({
        config: config.autoOrchestrate,
        isMainAgent: input.isMainAgent,
        tier: tokenSaverTier,
        alreadyOrchestrating,
        continuationCount: sticky?.orchestrationContinuations ?? 0,
      });
      // On explicit run exit (reclassification below trigger tiers, or the
      // run cap) decision.orchestrating stays false, so the sticky write
      // below persists orchestrating:false and the next turn re-judges
      // instead of staying pinned to the orchestration mode.
      if (orchestrated.applied) {
        mutations = { ...mutations, ...orchestrated.mutations };
        decision.orchestrating = true;
      }
    }

    if (scenarioOutcome.subagentModelHint || decision.isSubagent) {
      mutations = { ...mutations, subagentTagStripped: true };
    }

    const mediaMessages = decision.requestPatch?.messages ?? input.request.messages;
    mutations = rerouteDecisionForMedia(decision, mediaMessages, mutations, {
      ...mediaChecks,
      fallbackCandidatesFor,
    });

    decision.mutations = mutations;

    // The consecutive-failure counter describes the *model*, not the request:
    // keep it while the sticky stays pinned to the same model (so a broken
    // model released by re-judging doesn't restart at zero), and reset it
    // when a different model is selected.
    const stickyStaysOnSameModel =
      sticky?.stickyProvider === decision.provider && sticky?.stickyModel === decision.model;
    sessionStore.set({
      sessionId: input.sessionId,
      // Slot key must match every read side (decide, tokenSaver sticky
      // lookup, invalidateSticky), which keys by the turn's declared role
      // (input.isMainAgent). decision.isSubagent may differ for subagent-
      // tagged main turns — those are execution semantics (cap, stats role),
      // not storage semantics; writing them to the `:sub` slot would strand
      // the sticky/quality-failure state where no reader looks.
      isSubagent: !input.isMainAgent,
      tokenSaverTier,
      stickyProvider: decision.provider,
      stickyModel: decision.model,
      orchestrating: decision.orchestrating,
      orchestrationContinuations: decision.orchestrating
        ? (sticky?.orchestrationContinuations ?? 0) + 1
        : undefined,
      qualityFailures: stickyStaysOnSameModel ? sticky?.qualityFailures : undefined,
      lastUsage: sticky?.lastUsage,
      updatedAt: (deps.now?.() ?? new Date()).getTime(),
    });

    events.emit({
      type: "rigorium_router_decision",
      sessionId: input.sessionId,
      decision,
    });

    return decision;
  }

  function applyDecisionToRequest(
    decision: RouterDecision,
    request: CanonicalModelRequest,
  ): CanonicalModelRequest {
    let messages = decision.requestPatch?.messages ?? request.messages;
    if (decision.mutations.subagentTagStripped) {
      messages = stripSubagentTagFromMessages(messages);
    }
    return clampMaxOutputTokensToModelCap({
      ...request,
      ...decision.requestPatch,
      provider: decision.provider,
      model: decision.model,
      messages,
    }, deps.modelRuntime);
  }

  async function* execute(
    decision: RouterDecision,
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext & { isMainAgent?: boolean },
  ): AsyncIterable<CanonicalModelEvent> {
    // Sticky storage is keyed by the turn's declared role (matches every
    // sessionStore read); decision.isSubagent is execution semantics that
    // may differ for subagent-tagged main turns. Fall back to the decision
    // only when the caller didn't declare a role (direct execute() users).
    const storageIsSubagent = ctx.isMainAgent === undefined ? decision.isSubagent : !ctx.isMainAgent;
    if (!enabled) {
      const passthroughRequest: CanonicalModelRequest = {
        ...request,
        provider: decision.provider,
        model: decision.model,
      };
      const downgradedPassthrough = downgradeRequestForAttempt(
        passthroughRequest,
        { id: `${decision.provider}/${decision.model}`, provider: decision.provider, model: decision.model },
        deps.modelRuntime,
      );
      const cappedPassthroughRequest = clampMaxOutputTokensToModelCap(downgradedPassthrough, deps.modelRuntime);
      let sawErrorEvent = false;
      for await (const item of streamAttempt(cappedPassthroughRequest, deps.modelRuntime, ctx, events)) {
        if (item.kind === "event") {
          if (item.event.type === "error") {
            sawErrorEvent = true;
          }
          yield item.event;
          continue;
        }
        if (item.outcome.error && !sawErrorEvent) {
          yield { type: "error", error: item.outcome.error };
        }
      }
      return;
    }

    const startedAt = (deps.now?.() ?? new Date()).toISOString();
    const startedAtMs = (deps.now?.() ?? new Date()).getTime();
    const fallbackPlan = planFallback(config.fallback, decision.scenarioType);
    const baseRequest = applyDecisionToRequest(decision, request);
    const requiredModalities = collectRequiredInputModalities(baseRequest.messages);
    const requestedAttempt: RouterModelRef = {
      id: `${decision.provider}/${decision.model}`,
      provider: decision.provider,
      model: decision.model,
    };
    const candidateAttempts: RouterModelRef[] = [
      requestedAttempt,
      ...fallbackPlan.attempts,
    ].filter((attempt, index, all) =>
      all.findIndex((candidate) =>
        candidate.provider === attempt.provider && candidate.model === attempt.model
      ) === index
    );
    const attemptPlans: AttemptPlan[] = buildAttemptPlans(
      candidateAttempts,
      requiredModalities,
      mediaChecks,
    );
    const zeroUsageMax = Math.max(1, config.zeroUsageRetry?.maxAttempts ?? 5);
    const zeroUsageEnabled = config.zeroUsageRetry?.enabled ?? true;
    const transientRetryEnabled = config.transientRetry?.enabled ?? true;
    const transientRetryMax = Math.max(1, config.transientRetry?.maxAttempts ?? LITELLM_DEFAULT_MAX_RETRIES);
    const transientBaseDelayMs = config.transientRetry?.baseDelayMs ?? LITELLM_INITIAL_RETRY_DELAY_MS;
    const transientMaxDelayMs = config.transientRetry?.maxDelayMs ?? LITELLM_MAX_RETRY_DELAY_MS;

    let lastBuffered: CanonicalModelEvent[] = [];
    let lastError: import("../model/index.js").CanonicalModelError | undefined;
    let lastUsage: import("../model/index.js").CanonicalUsage | undefined;
    let lastAttempt: RouterModelRef | undefined;
    let lastDecision: RouterDecision = decision;
    let lastHasYieldedContent = false;

    if (attemptPlans.length === 0) {
      const missing = mediaChecks.missingForModel(requestedAttempt, requiredModalities);
      const error = createUnsupportedMediaError(
        requestedAttempt,
        requiredModalities,
        missing,
        protocolForProvider(deps.modelRuntime, requestedAttempt.provider),
      );
      events.emit({
        type: "rigorium_router_execute_failed",
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        scenarioType: decision.scenarioType,
        provider: requestedAttempt.provider,
        model: requestedAttempt.model,
        error,
      });
      yield { type: "error", error };
      return;
    }

    outer: for (let attemptIndex = 0; attemptIndex < attemptPlans.length; attemptIndex += 1) {
      if (ctx.abortSignal?.aborted) {
        return;
      }
      const attemptPlan = attemptPlans[attemptIndex];
      const attempt = attemptPlan.attempt;
      if (
        attemptIndex > 0 &&
        getHealthTracker(ctx.sessionId).shouldSkip(attempt.provider) &&
        attemptIndex < attemptPlans.length - 1
      ) {
        continue;
      }
      const attemptDecision: RouterDecision = {
        ...decision,
        provider: attempt.provider,
        model: attempt.model,
        resolvedFrom: attemptIndex === 0 ? decision.resolvedFrom : "fallback",
      };
      let attemptRequest = applyDecisionToRequest(attemptDecision, request);
      if (attemptPlan.downgradeUnsupportedMedia) {
        attemptRequest = downgradeRequestForAttempt(attemptRequest, attempt, deps.modelRuntime);
      }
      lastAttempt = attempt;
      lastDecision = attemptDecision;

      if (decision.isSubagent && config.autoOrchestrate?.subagentMaxTokens) {
        const budget = config.autoOrchestrate.subagentMaxTokens;
        const estimated = countMessagesTokens(attemptRequest.messages);
        if (estimated > budget) {
          yield {
            type: "error",
            error: {
              provider: attempt.provider,
              protocol: protocolForProvider(deps.modelRuntime, attempt.provider),
              code: "subagent_budget_exceeded",
              message: `Sub-agent budget exceeded (${estimated} estimated tokens > ${budget} limit).`,
              retryable: false,
              userHint: "Reduce the subagent prompt/context, increase the subagent token budget, or split the task into smaller steps.",
            },
          } as CanonicalModelEvent;
          return;
        }
      }

      let zeroUsageAttempt = 0;
      let transientRetryCount = 0;
      while (true) {
        zeroUsageAttempt += 1;
        // Live-stream events. We track whether we've already surfaced any
        // content event (text/thinking/tool) to the consumer; once we have,
        // fallback / retry is no longer safe (would duplicate text).
        let hasYieldedContent = false;
        const pending: CanonicalModelEvent[] = [];
        let outcome: AttemptOutcome | undefined;

        for await (const item of streamAttempt(attemptRequest, deps.modelRuntime, ctx, events, concurrencyGate)) {
          if (item.kind === "outcome") {
            outcome = item.outcome;
            break;
          }
          const event = item.event;
          if (!hasYieldedContent && isContentEvent(event)) {
            // Flush any framing events queued before the first content delta
            // (request_started / message_start) and the content event itself.
            for (const queued of pending) {
              yield queued;
            }
            pending.length = 0;
            yield event;
            hasYieldedContent = true;
            continue;
          }
          if (hasYieldedContent) {
            yield event;
            continue;
          }
          // Pre-content phase: defer framing events; we may need to swallow
          // them and replay from a fallback attempt.
          pending.push(event);
        }

        if (!outcome) {
          lastHasYieldedContent = hasYieldedContent;
          break outer;
        }

        lastBuffered = outcome.buffered;
        lastUsage = outcome.usage;

        if (outcome.error) {
          lastError = outcome.error;
          const health = getHealthTracker(ctx.sessionId);
          health.recordFailure(attempt.provider, outcome.error.code);
          if (health.getState(attempt.provider) === "degraded") {
            events.emit({
              type: "rigorium_router_provider_degraded",
              sessionId: ctx.sessionId,
              turnId: ctx.turnId,
              provider: attempt.provider,
              model: attempt.model,
              errorCode: outcome.error.code,
              consecutiveFailures: health.snapshot().get(attempt.provider)?.consecutiveFailures ?? 0,
            });
          }
          if (!hasYieldedContent && isFallbackEligible(outcome.error)) {
            if (attemptIndex < attemptPlans.length - 1) {
              // Fall back to the next attempt. The quality-failure counter is
              // intentionally NOT incremented here: a rescued turn either
              // succeeds (reset at the pinned attempt below) or exhausts the
              // whole chain (recorded once at the end) — never twice.
              const next = attemptPlans[attemptIndex + 1].attempt;
              events.emit({
                type: "rigorium_router_fallback",
                sessionId: ctx.sessionId,
                turnId: ctx.turnId,
                scenarioType: attemptDecision.scenarioType,
                attempt: attemptIndex + 1,
                fromProvider: attempt.provider,
                fromModel: attempt.model,
                toProvider: next.provider,
                toModel: next.model,
                error: outcome.error,
              });
              telemetry?.trackFeatureLoopStage({
                module: "router",
                ownerModule: "router",
                phase: "fallback",
                loopStage: "module_event",
                outcome: "success",
                sessionId: ctx.sessionId,
                metadata: {
                  event: "fallback_attempt",
                  scenarioType: attemptDecision.scenarioType,
                  attempt: attemptIndex + 1,
                  fromProvider: attempt.provider,
                  fromModel: attempt.model,
                  toProvider: next.provider,
                  toModel: next.model,
                  errorCode: outcome.error.code,
                },
              });
              continue outer;
            }
          }
          if (
            !hasYieldedContent &&
            isFallbackEligible(outcome.error) &&
            transientRetryEnabled &&
            transientRetryCount < transientRetryMax
          ) {
            // A server-provided retry-after is authoritative (capped at 60s,
            // not the local 8s cap — providers like Anthropic return 30-60s
            // for 429s; clamping them locally guarantees another 429).
            const delay = outcome.error.retryAfterMs != null
              ? Math.min(outcome.error.retryAfterMs, SERVER_RETRY_AFTER_CAP_MS)
              : calculateLiteLLMRetryDelay(transientRetryCount, transientBaseDelayMs, transientMaxDelayMs);
            console.warn(
              `[Rigorium] transientRetry: ${outcome.error.code} (attempt ${transientRetryCount + 1}/${transientRetryMax}, delay=${Math.round(delay)}ms)`,
            );
            events.emit({
              type: "rigorium_router_transient_retry",
              sessionId: ctx.sessionId,
              turnId: ctx.turnId,
              attempt: transientRetryCount + 1,
              delayMs: Math.round(delay),
              provider: attempt.provider,
              model: attempt.model,
              errorCode: outcome.error.code,
            });
            events.emit({
              type: "rigorium_router_retry_progress",
              sessionId: ctx.sessionId,
              turnId: ctx.turnId,
              attempt: transientRetryCount + 1,
              maxAttempts: transientRetryMax,
              delayMs: Math.round(delay),
              reason: classifyRetryReason(outcome.error.code),
              provider: attempt.provider,
              model: attempt.model,
            });
            telemetry?.trackFeatureLoopStage({
              module: "router",
              ownerModule: "router",
              phase: "fallback",
              loopStage: "module_event",
              outcome: "success",
              sessionId: ctx.sessionId,
              metadata: {
                event: "transient_retry",
                attempt: transientRetryCount + 1,
                delayMs: Math.round(delay),
                provider: attempt.provider,
                model: attempt.model,
                errorCode: outcome.error.code,
              },
            });
            await abortableDelay(delay, ctx.abortSignal);
            transientRetryCount++;
            continue;
          }
          if (
            hasYieldedContent &&
            transientRetryCount < transientRetryMax &&
            // Continuation is only safe for text: a mid-stream tool-call
            // block's arguments are unreliable and must not be resumed, and
            // non-retryable errors (auth, billing, invalid request) would
            // fail identically on the retry.
            outcome.error.retryable !== false &&
            !bufferedHasToolCall(outcome.buffered)
          ) {
            const partialText = extractPartialText(outcome.buffered);
            if (partialText.length > 0) {
              const midDelay = outcome.error.retryAfterMs != null
                ? Math.min(outcome.error.retryAfterMs, SERVER_RETRY_AFTER_CAP_MS)
                : calculateLiteLLMRetryDelay(transientRetryCount, transientBaseDelayMs, transientMaxDelayMs);
              console.warn(
                `[Rigorium] midStreamRetry: ${outcome.error.code} after partial content ` +
                `(attempt ${transientRetryCount + 1}/${transientRetryMax}, delay=${Math.round(midDelay)}ms)`,
              );
              events.emit({
                type: "rigorium_router_retry_progress",
                sessionId: ctx.sessionId,
                turnId: ctx.turnId,
                attempt: transientRetryCount + 1,
                maxAttempts: transientRetryMax,
                delayMs: Math.round(midDelay),
                reason: classifyRetryReason(outcome.error.code),
                provider: attempt.provider,
                model: attempt.model,
              });
              await abortableDelay(midDelay, ctx.abortSignal);
              attemptRequest = buildLiteLLMContinuationRequest(attemptRequest, partialText);
              transientRetryCount++;
              continue;
            }
          }
          for (const queued of pending) {
            yield queued;
          }
          lastHasYieldedContent = hasYieldedContent;
          break outer;
        }

        if (
          !hasYieldedContent &&
          zeroUsageEnabled &&
          outcome.shouldRetryZeroUsage &&
          zeroUsageAttempt < zeroUsageMax
        ) {
          console.warn(
            `[Rigorium] zeroUsageRetry: empty response from ${attempt.provider}/${attempt.model} ` +
            `(attempt ${zeroUsageAttempt}/${zeroUsageMax}, session=${ctx.sessionId})`,
          );
          events.emit({
            type: "rigorium_router_zero_usage_retry",
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            attempt: zeroUsageAttempt,
            provider: attempt.provider,
            model: attempt.model,
          });
          events.emit({
            type: "rigorium_router_retry_progress",
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            attempt: zeroUsageAttempt,
            maxAttempts: zeroUsageMax,
            delayMs: Math.round(exponentialBackoffDelay(zeroUsageAttempt, 500, 8000)),
            reason: "zero_usage",
            provider: attempt.provider,
            model: attempt.model,
          });
          telemetry?.trackFeatureLoopStage({
            module: "router",
            ownerModule: "router",
            phase: "fallback",
            loopStage: "module_event",
            outcome: "success",
            sessionId: ctx.sessionId,
            metadata: {
              event: "zero_usage_retry",
              attempt: zeroUsageAttempt,
              provider: attempt.provider,
              model: attempt.model,
            },
          });
          await abortableDelay(exponentialBackoffDelay(zeroUsageAttempt, 500, 8000), ctx.abortSignal);
          continue;
        }

        getHealthTracker(ctx.sessionId).recordSuccess(attempt.provider);

        if (!hasYieldedContent) {
          for (const queued of pending) {
            yield queued;
          }
        }

        const endedAt = (deps.now?.() ?? new Date()).toISOString();
        let finalUsage = outcome.usage;
        if (!finalUsage || (!finalUsage.inputTokens && !finalUsage.outputTokens)) {
          const inputEst = countMessagesTokens(attemptRequest.messages);
          const outputEst = countResponseTokens(outcome.buffered);
          finalUsage = { inputTokens: inputEst, outputTokens: outputEst, totalTokens: inputEst + outputEst };
        }
        usageCache.observe(ctx.sessionId, finalUsage);
        stats.observe({
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          projectPath: ctx.projectPath,
          scenarioType: attemptDecision.scenarioType,
          resolvedFrom: attemptDecision.resolvedFrom,
          provider: attempt.provider,
          model: attempt.model,
          tier: decision.tokenSaverTier,
          role: decision.isSubagent ? "subagent" : "main",
          usage: finalUsage,
          startedAt,
          endedAt,
          latencyMs: (deps.now?.() ?? new Date()).getTime() - startedAtMs,
          fallbacks: attemptIndex,
          estimatedUsage: !outcome.usage || (!outcome.usage.inputTokens && !outcome.usage.outputTokens),
        });
        // A completed turn on the PINNED attempt (index 0) proves that model
        // still works — clear its consecutive-failure count. A fallback-
        // rescued turn says nothing about the pinned model, so its counter is
        // preserved (a permanently broken pinned model must be released, not
        // kept alive by fallback successes). Same attribution for the ranker.
        if (attemptIndex === 0) {
          sessionStore.resetQualityFailures(ctx.sessionId, storageIsSubagent);
          observeRoutingOutcome(
            decision,
            "success",
            finalUsage?.totalTokens ? Math.max(1, Math.round(finalUsage.totalTokens / 1000)) : undefined,
          );
        }
        return;
      }
    }

    if (lastError && lastAttempt) {
      // The whole attempt plan failed — the pinned model (and its fallbacks)
      // did not deliver. Count it once against the sticky selection so the
      // next decide() re-classifies instead of retrying the same broken
      // model, and record the failure for the amortized ranker.
      sessionStore.recordQualityFailure(ctx.sessionId, storageIsSubagent);
      observeRoutingOutcome(decision, "failure");
      events.emit({
        type: "rigorium_router_execute_failed",
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        scenarioType: lastDecision.scenarioType,
        provider: lastAttempt.provider,
        model: lastAttempt.model,
        error: lastError,
      });
      const endedAt = (deps.now?.() ?? new Date()).toISOString();
      let failUsage = lastUsage;
      if (!failUsage || (!failUsage.inputTokens && !failUsage.outputTokens)) {
        const inputEst = countMessagesTokens(request.messages);
        const outputEst = countResponseTokens(lastBuffered);
        failUsage = { inputTokens: inputEst, outputTokens: outputEst, totalTokens: inputEst + outputEst };
      }
      stats.observe({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        projectPath: ctx.projectPath,
        scenarioType: lastDecision.scenarioType,
        resolvedFrom: lastDecision.resolvedFrom,
        provider: lastAttempt.provider,
        model: lastAttempt.model,
        tier: decision.tokenSaverTier,
        role: decision.isSubagent ? "subagent" : "main",
        usage: failUsage,
        startedAt,
        endedAt,
        latencyMs: (deps.now?.() ?? new Date()).getTime() - startedAtMs,
        errorCode: lastError?.code,
        fallbacks: attemptPlans.length - 1,
        estimatedUsage: !lastUsage || (!lastUsage.inputTokens && !lastUsage.outputTokens),
      });
      if (!lastHasYieldedContent) {
        for (const event of lastBuffered) {
          if (event.type !== "error") {
            yield event;
          }
        }
      }
      yield { type: "error", error: { ...lastError, provider: lastAttempt.provider, model: lastAttempt.model } };
    }
  }

  async function* stream(
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext & { sessionId: string; isMainAgent: boolean; previousTier?: string },
  ): AsyncIterable<CanonicalModelEvent> {
    const decision = await decide({
      request,
      sessionId: ctx.sessionId,
      isMainAgent: ctx.isMainAgent,
      metadata: ctx.previousTier ? { previousTier: ctx.previousTier } : undefined,
    });
    yield* execute(decision, request, ctx);
  }

  function invalidateSticky(sessionId: string): InvalidateStickyResult {
    if (!enabled) {
      return { orchestrating: false };
    }

    const current = sessionStore.get(sessionId, false);
    const previousTier = current?.tokenSaverTier;
    const previousProvider = current?.stickyProvider;
    const previousModel = current?.stickyModel;
    const orchestrating = current?.orchestrating ?? false;
    if (orchestrating && previousTier) {
      // While orchestrating, preserve the tier sticky so continuation turns
      // don't get re-judged and accidentally downgraded. The continuation
      // counter rides along so the run cap accumulates across turns.
      sessionStore.set({
        sessionId,
        isSubagent: false,
        orchestrating,
        orchestrationContinuations: current?.orchestrationContinuations,
        tokenSaverTier: previousTier,
        stickyProvider: current?.stickyProvider,
        stickyModel: current?.stickyModel,
        qualityFailures: current?.qualityFailures,
        updatedAt: (deps.now?.() ?? new Date()).getTime(),
      });
    } else {
      sessionStore.set({
        sessionId,
        isSubagent: false,
        orchestrating,
        updatedAt: (deps.now?.() ?? new Date()).getTime(),
      });
    }
    return { previousTier, previousProvider, previousModel, orchestrating };
  }

  return {
    decide,
    execute,
    stream,
    materializeRequest: applyDecisionToRequest,
    invalidateSticky,
    observeUsage(sessionId, usage) {
      if (!enabled) return;
      usageCache.observe(sessionId, usage);
    },
    stats,
    async shutdown() {
      await stats.flush();
      stats.dispose();
      disposeTokenizer();
      if (!externalStore) sessionStore.clear();
      usageCache.clear();
      healthTrackers.clear();
      // Persist the amortized ranker so learned routing survives restarts.
      if (learningRanker && deps.learning?.persistPath) {
        try {
          const { writeFile, mkdir } = await import("node:fs/promises");
          const { dirname } = await import("node:path");
          await mkdir(dirname(deps.learning.persistPath), { recursive: true });
          await writeFile(deps.learning.persistPath, learningRanker.serialize(), { encoding: "utf8" });
        } catch (error) {
          console.warn(`[rigorium] Failed to persist router learning state: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}

/**
 * "Content" events are the ones that are visible to the end-user / agent
 * loop in a way that can't be retracted: text, thinking, and tool-call
 * material. Once we've yielded any of these to the consumer, fallback /
 * retry would produce duplicates, so we lock in the current attempt.
 */
function isContentEvent(event: CanonicalModelEvent): boolean {
  return (
    event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "tool_call_start" ||
    event.type === "tool_call_delta" ||
    event.type === "tool_call_end"
  );
}
