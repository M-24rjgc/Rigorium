import { setTimeout as sleep } from "node:timers/promises";
import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  cloneMessages,
  createModelMessageAssemblerState,
  type CanonicalToolCall,
  type CanonicalMessage,
  type CanonicalModelError,
  ModelProviderError,
  type CanonicalModelRequest,
  type CanonicalUsage,
  type CanonicalToolCallBlock,
  materializeMediaReferences,
  getSelfCorrectPrompt,
  detectFormatByText,
} from "../../model/index.js";
import type {
  RigoriumToolDefinition,
  RigoriumReadFileStateMap,
  RigoriumSubagentForkApi,
  RigoriumToolErrorResult,
  RigoriumToolResult,
  RigoriumToolRuntimeContext,
  RigoriumWriteSnapshotMap,
} from "../../tool/index.js";
import {
  SUBAGENT_DEFINITIONS,
  getSubagentDefinition,
} from "../sub/builtinSubagentTypes.js";
import { agentError } from "../protocol/errors.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentPermissionDenial, AgentTurnResult } from "../protocol/result.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import type { LifecycleDispatchResult } from "../../lifecycle/index.js";
import type { RigoriumHookEvent } from "../../extension/hooks/protocol/events.js";
import { NullContextRuntime } from "../../context/NullContextRuntime.js";
import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import type { ContextRecoveryDecision, ContextSupplementalToolResultMessage, TokenBudgetSnapshot } from "../../context/index.js";
import type { PermissionMode, PermissionRule, PermissionRuleSet } from "../../permission/index.js";
import { collectToolCalls, countDuplicateToolCalls } from "./collectToolCalls.js";
import { createMissingToolResult, ensureToolResultPairing } from "./ensureToolResultPairing.js";
import { LargeFileRepair, type LargeFileRepairDecision } from "./LargeFileRepair.js";
import { resolveOutputTokenRetryBump } from "./outputTokenRetry.js";
import { projectToolResults } from "./projectToolResults.js";
import {
  CIRCUIT_BREAKER_GRACE_PROMPT,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  EMPTY_LENGTH_OUTPUT_RETRY_FLOOR,
  SUBAGENT_STATUS_HEARTBEAT_MS,
  TOOL_EVENT_PUMP_INTERVAL_MS,
} from "./recovery/constants.js";
import {
  appendPlanModeReminder,
  buildPartialTextToolCallRecoveryPrompt,
  normalizeMessagesForModelRequest,
  removeTransientPromptsById,
  stripImagesFromMessages,
  stripTrailingErrorPair,
  textFromMessage,
  truncateHeadKeepRatio,
} from "./recovery/messages.js";
import {
  annotateRepeatedToolFailures,
  bindSupplementalMessagesToToolCalls,
  buildInvalidFingerprint,
  collectPermissionDenials,
  detectRepeatedToolFailure,
} from "./recovery/toolFailures.js";
import {
  classifyModelError,
  createEmptyResponseStatus,
  createFinishReasonStatus,
  createLifecycleBlockedStatus,
  createMaxOutputRecoveryExhaustedStatus,
  createMaxTurnsStatus,
  createModelRequestFailedStatus,
  createStructuredOutputCompletedStatus,
  createToolCallRecoveryExhaustedStatus,
  createToolErrorLoopStatus,
  createTurnAbortedStatus,
  shouldSurfaceAbortStatus,
  stringifyAbortReason,
  type AgentStatusMessage,
} from "./recovery/status.js";
import {
  clampOutputToModelCap,
  composeAbortSignal,
  mergeUsage,
  modelErrorTarget,
  tokensFromUsage,
} from "./recovery/usage.js";
import {
  cloneReadFileStateMap,
  cloneWriteSnapshotMap,
  filterAskModeTools,
  findLifecycleBlock,
  findToolLifecycleBlock,
  mergeUserRules,
  readRequestedMode,
  subagentIdFromSessionId,
  toolToCanonicalSchema,
} from "./assembly.js";
import { enrichMessagesWithVisionDescriptions } from "./visionEnrichment.js";
import { requiresPromptCapability } from "../../tool/userInteractionConstraints.js";
import type { AgentRunMode } from "../protocol/input.js";
import { repairToolName } from "../../model/streaming/repairToolName.js";

type ActiveSubagentStatus = {
  subagentId: string;
  subagentType?: string;
  startedAtMs: number;
  lastHeartbeatMs: number;
  currentToolCallId?: string;
  currentToolName?: string;
};

export type AgentLoopInput = {
  sessionId: string;
  turnId: string;
  messages: CanonicalMessage[];
  maxTurns?: number;
  runMode?: AgentRunMode;
  permissionMode?: PermissionMode;
  allowedReadFiles?: string[];
  /** The user's actual permission preference before plan-mode override. */
  basePermissionMode?: PermissionMode;
  /** Allow model-visible plan mode tools for this turn. */
  allowPlanModeTools?: boolean;
  canPrompt?: boolean;
  permissionRules?: Partial<PermissionRuleSet>;
  abortSignal?: AbortSignal;
  /** Research context (artifact kinds + EIG action type) for research-aware routing. */
  researchContext?: import("../../router/index.js").ResearchRoutingHint;
  onDurableMessage?: (message: CanonicalMessage) => void | Promise<void>;
  onAgentStatusMessage?: (status: AgentStatusMessage) => void | Promise<void>;
};

export type AgentLoopRunResult = {
  result: AgentTurnResult;
  messages: CanonicalMessage[];
};

export type AgentLoopSeedState = {
  readFileState?: RigoriumReadFileStateMap;
  writeSnapshots?: RigoriumWriteSnapshotMap;
  allowedReadFiles?: string[];
};

export class AgentLoop {
  private readonly readFileState: RigoriumReadFileStateMap;
  private readonly writeSnapshots: RigoriumWriteSnapshotMap;
  private readonly allowedReadFiles: Set<string>;
  private readonly transientTokenCaps = new Map<string, {
    maxContextTokens?: number;
    requestedMaxOutputTokens?: number;
    attemptMaxOutputTokens?: number;
    hardMaxOutputTokens?: number;
  }>();

  constructor(
    private readonly config: AgentRuntimeConfig,
    private readonly dependencies: AgentRuntimeDependencies,
    seedState?: AgentLoopSeedState,
  ) {
    this.readFileState = cloneReadFileStateMap(seedState?.readFileState);
    this.writeSnapshots = cloneWriteSnapshotMap(seedState?.writeSnapshots);
    this.allowedReadFiles = new Set(seedState?.allowedReadFiles ?? []);
  }

  snapshotFileState(): AgentLoopSeedState {
    return {
      readFileState: cloneReadFileStateMap(this.readFileState),
      writeSnapshots: cloneWriteSnapshotMap(this.writeSnapshots),
      allowedReadFiles: [...this.allowedReadFiles],
    };
  }

  async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    this.clearTurnScopedTokenCaps();
    this.applyRunModeOverride(input.runMode);
    this.applyPermissionOverrides(input.permissionMode, input.permissionRules, input.basePermissionMode);
    for (const filePath of input.allowedReadFiles ?? []) {
      this.allowedReadFiles.add(filePath);
    }
    const startedAt = this.now().toISOString();
    let messages = [...input.messages];
    let turnCount = 1;
    let usage: CanonicalUsage = {};
    let lastModelUsage: CanonicalUsage | undefined;
    let permissionDenials: AgentPermissionDenial[] = [];
    let structuredOutput: unknown;
    let finalMessage: CanonicalMessage | undefined;
    const toAgentStatusEvent = (status: AgentStatusMessage): AgentEvent => ({
      type: "agent_status",
      sessionId: input.sessionId,
      turnId: input.turnId,
      event: status.event,
      detail: status.detail,
    });
    const emitStatus = async (status: AgentStatusMessage): Promise<AgentEvent> => {
      await input.onAgentStatusMessage?.(status);
      return toAgentStatusEvent(status);
    };
    const createAbortStatus = (): AgentStatusMessage | undefined => {
      if (!shouldSurfaceAbortStatus(input.abortSignal?.reason)) return undefined;
      return createTurnAbortedStatus({ reason: stringifyAbortReason(input.abortSignal?.reason) });
    };
    const captureTurn = async (errored: boolean): Promise<void> => {
      const hook = this.dependencies.context?.captureTurn;
      if (!hook) return;
      try {
        await hook.call(this.dependencies.context, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          messages,
          errored,
        });
      } catch {
        // captureTurn must never break a turn — context impl already
        // swallows; this catch is defensive.
      }
    };
    /**
     * Single-shot reactive truncate-and-retry guard. Set true after the loop
     * already truncated for a `prompt_too_long` once; subsequent PTL errors
     * fall through to fallback / fail (legacy single-shot semantics).
     */
    let hasAttemptedCompact = false;
    /**
     * Single-shot guard for `max_output_reached` retries. The loop only bumps
     * an explicitly configured cap; catalog-default requests are already sent
     * at the selected model's known output cap and go straight to continuation.
     */
    let hasAttemptedOutputRetry = false;
    /**
     * Single-shot guard for empty assistant responses (no text, no tool
     * calls). The model's thinking may have consumed the full output
     * budget leaving nothing visible; we prompt it once to retry.
     */
    let hasAttemptedEmptyRetry = false;
    /**
     * Multi-turn continuation recovery counter for `max_output_reached`.
     * After the single-shot token bump, the loop injects a continuation
     * prompt and preserves the truncated assistant message so the model can
     * resume from where it was cut off — up to MAX_OUTPUT_RECOVERY_LIMIT
     * times.
     */
    const MAX_OUTPUT_RECOVERY_LIMIT = 50;
    let maxOutputRecoveryCount = 0;
    const MAX_CONSECUTIVE_EMPTY = 3;
    let consecutiveEmptyCount = 0;
    const MAX_JSON_SELF_CORRECT_RETRIES = 3;
    let jsonSelfCorrectCount = 0;
    let hasAttemptedToolCallRetry = false;
    const largeFileRepair = new LargeFileRepair();

    /**
     * Circuit breaker: detects loops by fingerprinting each turn's
     * invalid_tool_input errors (toolName + errorMessage). Only identical
     * repeated failures trigger recovery, so changed parameters/tools are not
     * mistaken for the same stuck loop. A one-time grace prompt gives the
     * model a final chance to change strategy before termination.
     */
    const MAX_SAME_INVALID_FINGERPRINT = 3;
    let lastInvalidFingerprint: string | undefined;
    let sameInvalidFingerprintCount = 0;
    let hasUsedInvalidGracePeriod = false;
    let lastToolFailureFingerprint: string | undefined;
    let transientPromptCounter = 0;
    const activeTransientPromptIds = new Set<string>();

    const pushTransientSyntheticPrompt = (prompt: string, purpose: string): void => {
      const transientId = this.dependencies.uuid?.() ?? `transient-${++transientPromptCounter}`;
      messages.push({
        role: "user",
        content: [{ type: "text", text: prompt }],
        metadata: { synthetic: true, transient: true, transientId, purpose },
      });
      activeTransientPromptIds.add(transientId);
    };

    const expireConsumedTransientPrompts = (): void => {
      if (activeTransientPromptIds.size === 0) {
        return;
      }
      messages = removeTransientPromptsById(messages, activeTransientPromptIds);
      activeTransientPromptIds.clear();
    };
    const missingToolResultRecoveryContext = () => ({
      cwd: this.config.cwd,
      permissionMode: this.config.permissionMode,
    });

    const stickyInfo = this.dependencies.router.invalidateSticky?.(input.sessionId);
    let previousTier: string | undefined = stickyInfo?.previousTier;

    const continueWithSyntheticPrompt = async (
      decision: LargeFileRepairDecision,
      options: { stripCurrentAssistant?: boolean } = {},
    ): Promise<{
      type: "continue";
      event: AgentEvent;
    } | {
      type: "completed";
      result: AgentTurnResult;
      status?: AgentStatusMessage;
    }> => {
      if (decision.type === "stop") {
        const error = agentError("agent_tool_error_loop", decision.reason);
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "tool_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [error],
        });
        return { type: "completed", result, status: createToolErrorLoopStatus({ error }) };
      }
      if (options.stripCurrentAssistant !== false) {
        if (decision.strip === "error_pair") {
          messages = stripTrailingErrorPair(messages);
        } else if (decision.strip === "assistant") {
          const last = messages[messages.length - 1];
          if (last?.role === "assistant") {
            messages = messages.slice(0, -1);
          }
        }
      }
      pushTransientSyntheticPrompt(decision.prompt, decision.purpose);
      if (this.config.maxOutputTokens !== undefined
        && this.config.maxOutputTokens < largeFileRepair.recommendedMaxOutputTokens) {
        this.config.maxOutputTokens = largeFileRepair.recommendedMaxOutputTokens;
      }
      return {
        type: "continue",
        event: {
          type: "turn_continued",
          sessionId: input.sessionId,
          turnId: input.turnId,
          reason: "model_error",
        },
      };
    };

    while (true) {
      if (input.abortSignal?.aborted) {
        const result = this.createTurnResult(input, {
          type: "aborted",
          stopReason: "aborted_streaming",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
        });
        const status = createAbortStatus();
        if (status) {
          yield await emitStatus(status);
        }
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      let pendingContextBudget: TokenBudgetSnapshot | undefined;
      const ctx = this.dependencies.context;
      const preRoutingMaxContextTokens = this.currentMaxContextTokens(this.config.provider, this.config.model);
      if (ctx?.tryAutoCompact) {
        try {
          const reservedOutputTokens = this.getReservedOutputTokens();
          const compact = await ctx.tryAutoCompact({
            messages,
            abortSignal: input.abortSignal,
            reservedOutputTokens,
            lastUsage: lastModelUsage,
            budgetEvaluator: this.createBudgetEvaluator(input, {
              maxContextTokens: preRoutingMaxContextTokens,
              reservedOutputTokens,
            }),
          });
          if (compact.type === "compacted") {
            messages = compact.messages;
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "auto_compact",
            };
          }
          pendingContextBudget = compact.snapshot;
        } catch {
          // Auto-compaction must never block the model call — proceed with
          // the original messages if evaluation or summarization fails.
        }
        yield* this.drainEventBuffer();
      }

      let request = await this.createModelRequest(messages, input);
      if (input.abortSignal?.aborted) {
        const result = this.createTurnResult(input, {
          type: "aborted",
          stopReason: "aborted_streaming",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
        });
        const status = createAbortStatus();
        if (status) {
          yield await emitStatus(status);
        }
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }
      this.dispatchLifecycle(input, "PreModelRequest", {
        provider: request.provider,
        model: request.model,
      }).catch(() => {});
      yield {
        type: "model_request_started",
        sessionId: input.sessionId,
        turnId: input.turnId,
        model: request.model,
        provider: request.provider,
      };

      // Split decide + execute so we can insert a post-routing compact pass
      // when the routed model's context window differs from the agent's
      // default model (the window used by the first tryAutoCompact above).
      const decision = await this.dependencies.router.decide({
        request,
        sessionId: input.sessionId,
        isMainAgent: !this.config.isSubagent,
        metadata: {
          ...(stickyInfo
            ? {
              previousTier,
              previousProvider: stickyInfo.previousProvider,
              previousModel: stickyInfo.previousModel,
            }
            : previousTier ? { previousTier } : {}),
          ...(input.researchContext ? { research: input.researchContext } : {}),
        },
      });
      const routedLimits = this.getModelTokenLimits(decision.provider, decision.model);
      const routedMaxOutputTokens = routedLimits?.maxOutputTokens;

      let emittedContextBudget = false;
      if (ctx?.tryAutoCompact) {
        const routedMaxCtx = routedLimits?.maxContextTokens ?? this.dependencies.getModelMaxContextTokens?.(decision.provider, decision.model);
        const currentBudgetMaxCtx = preRoutingMaxContextTokens;
        if (routedMaxCtx !== undefined && routedMaxCtx !== currentBudgetMaxCtx) {
          try {
            const reservedOutputTokens = this.getReservedOutputTokens(decision.provider, decision.model);
            const recompact = await ctx.tryAutoCompact({
              messages,
              abortSignal: input.abortSignal,
              maxContextTokens: routedMaxCtx,
              reservedOutputTokens,
              lastUsage: lastModelUsage,
              budgetEvaluator: this.createBudgetEvaluator(input, {
                decision,
                baseRequest: request,
                maxContextTokens: routedMaxCtx,
                reservedOutputTokens,
              }),
            });
            if (recompact.type === "compacted") {
              messages = recompact.messages;
              request = await this.createModelRequest(messages, input);
              request = this.applyTokenCapsToRequest(request, decision.provider, decision.model);
              yield {
                type: "turn_continued",
                sessionId: input.sessionId,
                turnId: input.turnId,
                reason: "auto_compact",
              };
            }
            yield {
              type: "context_budget",
              sessionId: input.sessionId,
              turnId: input.turnId,
              snapshot: recompact.snapshot,
            };
            emittedContextBudget = true;
          } catch {
            // Post-routing compaction must never block the model call.
          }
        }
      }
      request = this.applyTokenCapsToRequest(request, decision.provider, decision.model);
      this.clearAttemptOutputTokenCap(decision.provider, decision.model);
      if (pendingContextBudget && !emittedContextBudget) {
        yield {
          type: "context_budget",
          sessionId: input.sessionId,
          turnId: input.turnId,
          snapshot: pendingContextBudget,
        };
      }

      const assembler = createModelMessageAssemblerState();
      try {
        for await (const event of this.dependencies.router.execute(decision, request, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          projectPath: this.config.cwd,
          abortSignal: input.abortSignal,
          // Declared role — keeps the quality-failure counter in the same
          // sticky slot decide() reads (matches decide's isMainAgent).
          isMainAgent: !this.config.isSubagent,
        })) {
          yield { type: "model_event", sessionId: input.sessionId, turnId: input.turnId, event };
          applyModelEventToAssembler(assembler, event);
          if (event.type === "error") {
            break;
          }
        }
        if (!stickyInfo?.orchestrating) previousTier = undefined;
      } catch (error) {
        if (input.abortSignal?.aborted) {
          const partialAssembled = assembleAssistantMessage(assembler);
          if (partialAssembled.message.content.length > 0) {
            finalMessage = partialAssembled.message;
            messages.push(partialAssembled.message);
            expireConsumedTransientPrompts();
            usage = mergeUsage(usage, partialAssembled.usage);
            yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: partialAssembled.message };
            await input.onDurableMessage?.(partialAssembled.message);
          }
          const result = this.createTurnResult(input, {
            type: "aborted",
            stopReason: "aborted_streaming",
            usage,
            permissionDenials,
            turns: turnCount,
            startedAt,
            finalMessage,
          });
          await captureTurn(result.type === "error");
          yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
          return { result, messages };
        }
        const modelError = error instanceof ModelProviderError ? error.error : undefined;
        const stopFailureMsg = modelError?.message ?? (error instanceof Error ? error.message : String(error));
        await this.dispatchLifecycle(input, "StopFailure", { error: stopFailureMsg });
        yield { type: "stop_failure", sessionId: input.sessionId, turnId: input.turnId, error: stopFailureMsg };
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "model_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          errors: [agentError("agent_model_error", stopFailureMsg, modelError, modelError?.userHint)],
        });
        const abortStatus = createAbortStatus();
        if (abortStatus) {
          yield await emitStatus(abortStatus);
        } else {
          yield await emitStatus(createModelRequestFailedStatus({
            error: result.errors![0]!,
            modelError,
          }));
        }
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      if (input.abortSignal?.aborted) {
        const partialAssembled = assembleAssistantMessage(assembler);
        if (partialAssembled.message.content.length > 0) {
          finalMessage = partialAssembled.message;
          messages.push(partialAssembled.message);
          expireConsumedTransientPrompts();
          usage = mergeUsage(usage, partialAssembled.usage);
          yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: partialAssembled.message };
          await input.onDurableMessage?.(partialAssembled.message);
        }
        const result = this.createTurnResult(input, {
          type: "aborted",
          stopReason: "aborted_streaming",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
        });
        const status = createAbortStatus();
        if (status) {
          yield await emitStatus(status);
        }
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      const assembled = assembleAssistantMessage(assembler);
      usage = mergeUsage(usage, assembled.usage);
      lastModelUsage = assembled.usage;
      let assistantMessage = assembled.message;
      const duplicateToolCallCount = countDuplicateToolCalls(assistantMessage);
      if (duplicateToolCallCount > 0) {
        yield {
          type: "warning",
          sessionId: input.sessionId,
          turnId: input.turnId,
          code: "duplicate_tool_calls_dropped",
          message: `Model repeated ${duplicateToolCallCount} tool-call id(s) in one reply; duplicates were dropped (side-effecting tools must not run twice).`,
        };
      }
      let toolCalls = collectToolCalls(assistantMessage);
      if (assembled.hasTextFallbackToolCalls) {
        const repaired = this.repairTextExtractedToolNames(assistantMessage, toolCalls);
        assistantMessage = repaired.message;
        toolCalls = repaired.toolCalls;
      }
      finalMessage = assistantMessage;
      expireConsumedTransientPrompts();

      if (assembled.hasPartialTextToolCall) {
        if (maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
          maxOutputRecoveryCount++;
          pushTransientSyntheticPrompt(
            buildPartialTextToolCallRecoveryPrompt(assembled.partialTextToolCall),
            "max_output_recovery",
          );
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        const detail = assembled.partialTextToolCall
          ? `${assembled.partialTextToolCall.format}/${assembled.partialTextToolCall.reason}`
          : "unknown partial text tool-call";
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "model_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [agentError(
            "agent_model_error",
            `Partial text tool-call recovery exhausted after ${MAX_OUTPUT_RECOVERY_LIMIT} attempts (${detail}).`,
          )],
        });
        yield await emitStatus(createToolCallRecoveryExhaustedStatus({
          error: result.errors![0]!,
          attempts: maxOutputRecoveryCount,
          reason: detail,
        }));
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      // When jsonrepair silently "fixed" truncated JSON and the response
      // was cut by max_tokens, the tool call arguments are likely incomplete
      // (e.g. half-written file content). Apply the same recovery as
      // max_output_reached: token doubling → continuation prompt → give up.
      //
      // This gate intentionally runs before durable assistant emission. The
      // recovered response should replace the dirty repaired/truncated message,
      // not leave an unmatched tool_call in the transcript.
      if (assembled.hasRepairedToolCalls && (assembled.finishReason === "length" || assembled.finishReason === "tool_call" || assembled.finishReason === "stop")) {
        console.warn(
          `[AgentLoop] Blocking ${toolCalls.length} repaired-but-truncated tool call(s) — entering max_output recovery`,
        );

        const largeFileDecision = largeFileRepair.recoverFromRepairedTruncation(toolCalls);
        if (largeFileDecision) {
          const continued = await continueWithSyntheticPrompt(largeFileDecision, { stripCurrentAssistant: false });
          if (continued.type === "completed") {
            if (continued.status) {
              yield await emitStatus(continued.status);
            }
            yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: continued.result.errors![0]! };
            await captureTurn(continued.result.type === "error");
            yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: continued.result };
            return { result: continued.result, messages };
          }
          yield continued.event;
          continue;
        }

        // Phase A: token doubling (if not yet attempted)
          if (!hasAttemptedOutputRetry) {
            hasAttemptedOutputRetry = true;
            const nextMaxOutputTokens = resolveOutputTokenRetryBump({
              currentMaxOutputTokens: this.currentMaxOutputTokens(decision.provider, decision.model),
              modelMaxOutputTokens: routedMaxOutputTokens,
            });
            if (nextMaxOutputTokens !== undefined) {
              const previousOutput = this.currentMaxOutputTokens(decision.provider, decision.model);
              this.setTransientTokenCap(decision.provider, decision.model, { requestedMaxOutputTokens: nextMaxOutputTokens });
              yield {
                type: "token_cap_adjusted",
                sessionId: input.sessionId,
                turnId: input.turnId,
                provider: decision.provider,
                model: decision.model,
                cap: "output",
                previous: previousOutput,
                next: nextMaxOutputTokens,
                reason: "max-output-retry-bump",
              };
              yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          }
        }

        // Phase B: continuation recovery
        if (maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
          maxOutputRecoveryCount++;
          pushTransientSyntheticPrompt(
            "Output token limit hit. Resume directly - no apology, no recap of what you were doing. "
              + "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
            "max_output_recovery",
          );
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        // Phase C: exhausted. Do not execute repaired/truncated calls; the
        // arguments may be syntactically repaired while semantically partial.
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "model_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [agentError(
            "agent_model_error",
            "Recovered tool call still looked repaired/truncated after max-output recovery was exhausted.",
          )],
        });
        yield await emitStatus(createToolCallRecoveryExhaustedStatus({
          error: result.errors![0]!,
          attempts: maxOutputRecoveryCount,
          reason: "repaired_truncated_tool_calls",
        }));
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      if (!assembled.error && toolCalls.length === 0 && textFromMessage(assistantMessage).length === 0) {
        if (maxOutputRecoveryCount > 0) {
          consecutiveEmptyCount++;
          if (consecutiveEmptyCount < MAX_CONSECUTIVE_EMPTY
            && maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
            maxOutputRecoveryCount++;
            if (assembled.finishReason === "length") {
              const previousMaxOutputTokens = this.currentMaxOutputTokens(decision.provider, decision.model);
              const nextMaxOutputTokens = clampOutputToModelCap(
                Math.max((previousMaxOutputTokens ?? 0) * 2, EMPTY_LENGTH_OUTPUT_RETRY_FLOOR),
                routedMaxOutputTokens,
              );
              if (nextMaxOutputTokens !== undefined && nextMaxOutputTokens !== previousMaxOutputTokens) {
                this.setTransientTokenCap(decision.provider, decision.model, { requestedMaxOutputTokens: nextMaxOutputTokens });
                yield {
                  type: "empty_output_recovery",
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  provider: decision.provider,
                  model: decision.model,
                  finishReason: assembled.finishReason,
                  previousMaxOutputTokens,
                  nextMaxOutputTokens,
                };
              }
            }
            pushTransientSyntheticPrompt(
              "Output token limit hit. Resume directly - no apology, no recap of what you were doing. "
                + "Pick up mid-sentence if that is where the cut happened.",
              "max_output_recovery",
            );
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          }
          finalMessage = messages.filter((m) => m.role === "assistant").at(-1);
          const status = createEmptyResponseStatus({
            provider: request.provider,
            model: request.model,
            attempts: consecutiveEmptyCount,
          });
          yield await emitStatus(status);
          const result = this.createTurnResult(input, {
            type: "success",
            stopReason: "completed",
            usage,
            permissionDenials,
            turns: turnCount,
            startedAt,
            finalMessage,
          });
          await captureTurn(true);
          yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
          return { result, messages };
        }

        if (!hasAttemptedEmptyRetry) {
          hasAttemptedEmptyRetry = true;
          maxOutputRecoveryCount++;
          if (assembled.finishReason === "length") {
            const previousMaxOutputTokens = this.currentMaxOutputTokens(decision.provider, decision.model);
            const nextMaxOutputTokens = clampOutputToModelCap(
              Math.max((previousMaxOutputTokens ?? 0) * 2, EMPTY_LENGTH_OUTPUT_RETRY_FLOOR),
              routedMaxOutputTokens,
            );
            if (nextMaxOutputTokens !== undefined && nextMaxOutputTokens !== previousMaxOutputTokens) {
              this.setTransientTokenCap(decision.provider, decision.model, { requestedMaxOutputTokens: nextMaxOutputTokens });
              yield {
                type: "empty_output_recovery",
                sessionId: input.sessionId,
                turnId: input.turnId,
                provider: decision.provider,
                model: decision.model,
                finishReason: assembled.finishReason,
                previousMaxOutputTokens,
                nextMaxOutputTokens,
              };
            }
          }
          pushTransientSyntheticPrompt(
            "Your previous response was empty (thinking only, no visible text). "
              + "Please provide your answer as visible text output.",
            "empty_response_retry",
          );
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        const status = createEmptyResponseStatus({
          provider: request.provider,
          model: request.model,
          attempts: 2,
        });
        yield await emitStatus(status);
        const result = this.createTurnResult(input, {
          type: "success",
          stopReason: "completed",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage: messages.filter((m) => m.role === "assistant").at(-1),
        });
        await captureTurn(true);
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      messages.push(assistantMessage);
      yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: assistantMessage };
      await input.onDurableMessage?.(assistantMessage);

      if (assembled.error) {
        if (toolCalls.length > 0) {
          const projected = projectToolResults(
            toolCalls.map((call) =>
              createMissingToolResult(
                call,
                this.now,
                "Model error interrupted tool execution.",
                missingToolResultRecoveryContext(),
              )
            ),
          );
          messages.push(...projected);
          yield { type: "tool_results_projected", sessionId: input.sessionId, turnId: input.turnId, message: projected[0]! };
          for (const msg of projected) {
            await input.onDurableMessage?.(msg);
          }
        }

        if (
          this.config.jsonSelfCorrect &&
          assembled.error.code === "invalid_tool_arguments" &&
          jsonSelfCorrectCount < MAX_JSON_SELF_CORRECT_RETRIES
        ) {
          jsonSelfCorrectCount++;
          pushTransientSyntheticPrompt(
            "Your previous tool call contained invalid JSON in the arguments and could not be parsed. "
              + "Please retry with valid JSON. Common issues: missing quotes around keys/values, "
              + "trailing commas, unescaped special characters in strings.",
            "json_self_correct",
          );
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        // Reactive recovery: ask context runtime if it can recover from the
        // model error (e.g. `prompt_too_long` → truncate head and retry).
        // Single-shot per turn — see legacy parity §3.1 #8.
        const reactive = await this.tryReactiveRecover(input, assembled.error, messages, hasAttemptedCompact);
        if (reactive && reactive.type === "adjust_output_and_retry" && !hasAttemptedOutputRetry) {
          hasAttemptedOutputRetry = true;
          const target = modelErrorTarget(assembled.error, decision.provider, decision.model);
          const previousOutput = this.currentMaxOutputTokens(target.provider, target.model);
          this.setTransientTokenCap(target.provider, target.model, reactive.scope === "attempt"
            ? { attemptMaxOutputTokens: reactive.maxOutputTokens }
            : { hardMaxOutputTokens: reactive.maxOutputTokens });
          if (target.provider !== decision.provider || target.model !== decision.model) {
            this.setTransientTokenCap(decision.provider, decision.model, { attemptMaxOutputTokens: reactive.maxOutputTokens });
          }
          messages = stripTrailingErrorPair(messages);
          yield {
            type: "token_cap_adjusted",
            sessionId: input.sessionId,
            turnId: input.turnId,
            provider: target.provider,
            model: target.model,
            cap: "output",
            previous: previousOutput,
            next: reactive.maxOutputTokens,
            reason: reactive.reason,
          };
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        if (reactive && reactive.type === "compact_and_retry" && !hasAttemptedCompact) {
          const target = modelErrorTarget(assembled.error, decision.provider, decision.model);
          const previousContext = this.currentMaxContextTokens(target.provider, target.model);
          if (reactive.maxContextTokens !== undefined) {
            this.setTransientTokenCap(target.provider, target.model, { maxContextTokens: reactive.maxContextTokens });
            yield {
              type: "token_cap_adjusted",
              sessionId: input.sessionId,
              turnId: input.turnId,
              provider: target.provider,
              model: target.model,
              cap: "context",
              previous: previousContext,
              next: reactive.maxContextTokens,
              reason: reactive.reason,
            };
          }
          if (reactive.maxOutputTokens !== undefined) {
            const previousOutput = this.currentMaxOutputTokens(target.provider, target.model);
            this.setTransientTokenCap(target.provider, target.model, { attemptMaxOutputTokens: reactive.maxOutputTokens });
            if (target.provider !== decision.provider || target.model !== decision.model) {
              this.setTransientTokenCap(decision.provider, decision.model, { attemptMaxOutputTokens: reactive.maxOutputTokens });
            }
            yield {
              type: "token_cap_adjusted",
              sessionId: input.sessionId,
              turnId: input.turnId,
              provider: target.provider,
              model: target.model,
              cap: "output",
              previous: previousOutput,
              next: reactive.maxOutputTokens,
              reason: reactive.reason,
            };
          }
          messages = stripTrailingErrorPair(messages);
          if (ctx?.tryAutoCompact) {
            try {
              const compact = await ctx.tryAutoCompact({
                messages,
                abortSignal: input.abortSignal,
                maxContextTokens: this.currentMaxContextTokens(target.provider, target.model),
                reservedOutputTokens: this.getReservedOutputTokens(target.provider, target.model),
                lastUsage: lastModelUsage,
              });
              if (compact.type === "compacted") {
                messages = compact.messages;
              } else {
                messages = truncateHeadKeepRatio(messages, 0.5);
              }
            } catch {
              messages = truncateHeadKeepRatio(messages, 0.5);
            }
          } else {
            messages = truncateHeadKeepRatio(messages, 0.5);
          }
          hasAttemptedCompact = true;
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        if (reactive && reactive.type === "truncate_head_and_retry") {
          // Drop the failed assistant message + any synthetic tool_result we just
          // pushed so the retry doesn't carry a half-baked tool_call. Then apply
          // keepRatio so the cap is computed against valid history only.
          messages = stripTrailingErrorPair(messages);
          messages = truncateHeadKeepRatio(messages, reactive.keepRatio);
          hasAttemptedCompact = true;
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        if (reactive && reactive.type === "strip_images_and_retry") {
          messages = stripTrailingErrorPair(messages);
          messages = stripImagesFromMessages(messages);
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        // `max_output_reached`: output token limit hit (or truncated JSON
        // reclassified from invalid_tool_arguments when finishReason=length).
        //
        // Phase A — single-shot token doubling for explicit caps only.
        // Phase B — multi-turn continuation: keep the truncated assistant
        // message in context and inject a "resume" prompt so the model can
        // pick up where it was cut off (up to MAX_OUTPUT_RECOVERY_LIMIT).
        // Phase C — exhausted: fall through to error surfacing.
        if (assembled.error.code === "max_output_reached") {
          // Phase A
          if (!hasAttemptedOutputRetry) {
            hasAttemptedOutputRetry = true;
            const nextMaxOutputTokens = resolveOutputTokenRetryBump({
              currentMaxOutputTokens: this.currentMaxOutputTokens(decision.provider, decision.model),
              modelMaxOutputTokens: routedMaxOutputTokens,
            });
            if (nextMaxOutputTokens !== undefined) {
              messages = stripTrailingErrorPair(messages);
              const previousOutput = this.currentMaxOutputTokens(decision.provider, decision.model);
              this.setTransientTokenCap(decision.provider, decision.model, { requestedMaxOutputTokens: nextMaxOutputTokens });
              yield {
                type: "token_cap_adjusted",
                sessionId: input.sessionId,
                turnId: input.turnId,
                provider: decision.provider,
                model: decision.model,
                cap: "output",
                previous: previousOutput,
                next: nextMaxOutputTokens,
                reason: "max-output-retry-bump",
              };
              yield {
                type: "turn_continued",
                sessionId: input.sessionId,
                turnId: input.turnId,
                reason: "model_error",
              };
              continue;
            }
          }

          // Phase B
          if (maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
            maxOutputRecoveryCount++;
            pushTransientSyntheticPrompt(
              "Output token limit hit. Resume directly - no apology, no recap of what you were doing. "
                + "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
              "max_output_recovery",
            );
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          }
          // Phase C: fall through to error surfacing
        }

        // Cross-provider fallback decisions are now owned by RouterRuntime
        // (see `runFallbackChain` + `zeroUsageRetry`); the loop only
        // classifies the surfaced error and falls through.
        const classified = classifyModelError(assembled.error);
        await this.dispatchLifecycle(input, "StopFailure", { error: assembled.error });
        yield { type: "stop_failure", sessionId: input.sessionId, turnId: input.turnId, error: typeof assembled.error === "string" ? assembled.error : JSON.stringify(assembled.error) };
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: classified.stopReason,
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          errors: [classified.error],
        });
        yield await emitStatus(createModelRequestFailedStatus({
          error: classified.error,
          modelError: assembled.error,
        }));
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      if (toolCalls.length === 0) {
        const assistantText = textFromMessage(assistantMessage);

        // Global guard: empty assistant response (no text, no tool calls).
        // The model produced nothing visible — typically because extended
        // thinking consumed the entire output budget.
        if (assistantText.length === 0) {
          messages.pop();

          if (maxOutputRecoveryCount > 0) {
            consecutiveEmptyCount++;
            if (consecutiveEmptyCount < MAX_CONSECUTIVE_EMPTY
              && maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
              maxOutputRecoveryCount++;
              if (assembled.finishReason === "length") {
                const previousMaxOutputTokens = this.currentMaxOutputTokens(decision.provider, decision.model);
                const nextMaxOutputTokens = clampOutputToModelCap(
                  Math.max((previousMaxOutputTokens ?? 0) * 2, EMPTY_LENGTH_OUTPUT_RETRY_FLOOR),
                  routedMaxOutputTokens,
                );
                if (nextMaxOutputTokens !== undefined && nextMaxOutputTokens !== previousMaxOutputTokens) {
                  this.setTransientTokenCap(decision.provider, decision.model, { requestedMaxOutputTokens: nextMaxOutputTokens });
                  yield {
                    type: "empty_output_recovery",
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    provider: decision.provider,
                    model: decision.model,
                    finishReason: assembled.finishReason,
                    previousMaxOutputTokens,
                    nextMaxOutputTokens,
                  };
                }
              }
              pushTransientSyntheticPrompt(
                "Output token limit hit. Resume directly - no apology, no recap of what you were doing. "
                  + "Pick up mid-sentence if that is where the cut happened.",
                "max_output_recovery",
              );
              yield {
                type: "turn_continued",
                sessionId: input.sessionId,
                turnId: input.turnId,
                reason: "model_error",
              };
              continue;
            }
            // Exhausted consecutive empty retries — surface a UI-only status
            // message instead of injecting diagnostic assistant text into the
            // model transcript.
            finalMessage = messages.filter((m) => m.role === "assistant").at(-1);
            const status = createEmptyResponseStatus({
              provider: request.provider,
              model: request.model,
              attempts: consecutiveEmptyCount,
            });
            yield await emitStatus(status);
            const result = this.createTurnResult(input, {
              type: "success",
              stopReason: "completed",
              usage,
              permissionDenials,
              turns: turnCount,
              startedAt,
              finalMessage,
            });
            await captureTurn(true);
            yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
            return { result, messages };
          } else if (!hasAttemptedEmptyRetry) {
            // First occurrence: prompt the model to produce visible output.
            hasAttemptedEmptyRetry = true;
            maxOutputRecoveryCount++;
            if (assembled.finishReason === "length") {
              const previousMaxOutputTokens = this.currentMaxOutputTokens(decision.provider, decision.model);
              const nextMaxOutputTokens = clampOutputToModelCap(
                Math.max((previousMaxOutputTokens ?? 0) * 2, EMPTY_LENGTH_OUTPUT_RETRY_FLOOR),
                routedMaxOutputTokens,
              );
              if (nextMaxOutputTokens !== undefined && nextMaxOutputTokens !== previousMaxOutputTokens) {
                this.setTransientTokenCap(decision.provider, decision.model, { requestedMaxOutputTokens: nextMaxOutputTokens });
                yield {
                  type: "empty_output_recovery",
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  provider: decision.provider,
                  model: decision.model,
                  finishReason: assembled.finishReason,
                  previousMaxOutputTokens,
                  nextMaxOutputTokens,
                };
              }
            }
            pushTransientSyntheticPrompt(
              "Your previous response was empty (thinking only, no visible text). "
                + "Please provide your answer as visible text output.",
              "empty_response_retry",
            );
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          } else {
            const status = createEmptyResponseStatus({
              provider: request.provider,
              model: request.model,
              attempts: 2,
            });
            yield await emitStatus(status);
          }
          // fall through to normal stop
        }

        // Pure-text output truncated by max_output_tokens: the model was
        // mid-sentence with no tool calls. Unlike tool-call truncation we
        // skip the "strip-and-retry-with-doubled-tokens" phase (Phase A)
        // because (a) the text already generated is valid and discarding it
        // wastes tokens, and (b) blindly doubling maxOutputTokens may
        // exceed the provider's model cap and trigger a 400 error.
        // Instead, keep the truncated assistant message in context and
        // inject a continuation prompt so the model resumes from the cut.
        if (assembled.finishReason === "length") {
          consecutiveEmptyCount = 0;
          if (maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
            maxOutputRecoveryCount++;
            pushTransientSyntheticPrompt(
              "Output token limit hit. Resume directly - no apology, no recap of what you were doing. "
                + "Pick up mid-sentence if that is where the cut happened.",
              "max_output_recovery",
            );
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          }
          // Exhausted — fall through to normal completion with whatever
          // text was produced so far.
          const status = createMaxOutputRecoveryExhaustedStatus({ attempts: maxOutputRecoveryCount });
          yield await emitStatus(status);
        }

        const largeFileDecision = largeFileRepair.onNoToolCalls();
        if (largeFileDecision) {
          const continued = await continueWithSyntheticPrompt(largeFileDecision);
          if (continued.type === "completed") {
            if (continued.status) {
              yield await emitStatus(continued.status);
            }
            yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: continued.result.errors![0]! };
            await captureTurn(continued.result.type === "error");
            yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: continued.result };
            return { result: continued.result, messages };
          }
          yield continued.event;
          continue;
        }

        if (!assembled.hasPartialTextToolCall && assembled.hasUnparsedTextToolCall) {
          if (!hasAttemptedToolCallRetry) {
            hasAttemptedToolCallRetry = true;
            pushTransientSyntheticPrompt(
              getSelfCorrectPrompt(this.config.toolCallFormat ?? assembled.textToolCallFormat, assistantText),
              "unparsed_tool_call_retry",
            );
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          }

          yield {
            type: "warning",
            sessionId: input.sessionId,
            turnId: input.turnId,
            code: "unparsed_tool_call",
            message: "Model attempted to call a tool but the output could not be parsed. The response may be incomplete.",
            metadata: {
              detectedFormat: assembled.textToolCallFormat ?? detectFormatByText(assistantText)?.id,
            },
          };
        }

        const stopHooks = await this.dispatchLifecycle(input, "Stop", {
          stopHookActive: false,
          lastAssistantMessage: textFromMessage(assistantMessage),
        });
        yield { type: "stop_requested", sessionId: input.sessionId, turnId: input.turnId };
        messages.push(...stopHooks.messages);
        const stopBlock = findLifecycleBlock(stopHooks);
        if (stopBlock) {
          const result = this.createTurnResult(input, {
            type: "error",
            stopReason: "tool_error",
            usage,
            permissionDenials,
            turns: turnCount,
            startedAt,
            finalMessage,
            structuredOutput,
            errors: [agentError("agent_unsupported_feature", stopBlock.reason)],
          });
          yield await emitStatus(createLifecycleBlockedStatus({
            error: result.errors![0]!,
            stage: "stop",
          }));
          yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
          await captureTurn(result.type === "error");
          yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
          return { result, messages };
        }
        const finishStatus = createFinishReasonStatus(assembled.finishReason, assistantText);
        if (finishStatus) {
          yield await emitStatus(finishStatus);
        }

        const result = this.createTurnResult(input, {
          type: "success",
          stopReason: "completed",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
        });
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      yield { type: "tool_calls_detected", sessionId: input.sessionId, turnId: input.turnId, calls: toolCalls };
      if (input.abortSignal?.aborted) {
        const result = this.createTurnResult(input, {
          type: "aborted",
          stopReason: "aborted_streaming",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
        });
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      let results: RigoriumToolResult[];
      try {
        const toolContext = this.createToolContext(input, messages);
        if (assembled.finishReason === "length" || assembled.hasRepairedToolCalls) {
          toolContext.outputTruncated = true;
        }
        results = yield* this.executeToolsWithEventPump(
          toolCalls,
          toolContext,
          input,
        );
      } catch (error) {
        results = toolCalls.map((call) =>
          createMissingToolResult(
            call,
            this.now,
            error instanceof Error ? error.message : String(error),
            missingToolResultRecoveryContext(),
          ),
        );
      }
      if (input.abortSignal?.aborted) {
        const result = this.createTurnResult(input, {
          type: "aborted",
          stopReason: "aborted_streaming",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
        });
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }
      yield* this.drainEventBuffer();

      let pairedResults = ensureToolResultPairing(
        toolCalls,
        results,
        this.now,
        "Tool execution did not produce a result.",
        missingToolResultRecoveryContext(),
      );
      const repeatedFailure = detectRepeatedToolFailure(
        pairedResults,
        lastToolFailureFingerprint,
      );
      pairedResults = annotateRepeatedToolFailures(pairedResults, repeatedFailure.repeatedKeys);
      lastToolFailureFingerprint = repeatedFailure.currentFingerprint;
      const toolResultRepair = largeFileRepair.analyzeToolResults(pairedResults, {
        outputTruncated: assembled.finishReason === "length" || assembled.hasRepairedToolCalls === true,
        repairedToolCalls: assembled.hasRepairedToolCalls === true,
        finishReason: assembled.finishReason,
      });
      permissionDenials = [...permissionDenials, ...collectPermissionDenials(pairedResults)];
      for (const result of pairedResults) {
        if (result.type === "success" && result.metadata?.structuredOutput) {
          structuredOutput = result.data;
        }
        const requestedMode = readRequestedMode(result.type === "success" ? result.data : undefined);
        if (requestedMode) {
          let effectiveMode = requestedMode;

          if (requestedMode === "plan" && this.config.permissionMode !== "plan") {
            this.config.permissionModeBeforePlan = this.config.permissionMode;
          } else if (this.config.permissionMode === "plan" && requestedMode !== "plan") {
            if (this.config.permissionModeBeforePlan) {
              effectiveMode = this.config.permissionModeBeforePlan;
              this.config.permissionModeBeforePlan = undefined;
            }
          }

          this.config.permissionMode = effectiveMode;
          this.config.permissionContext.mode = effectiveMode;
          yield { type: "mode_change_requested", sessionId: input.sessionId, turnId: input.turnId, mode: effectiveMode };
        }
        yield { type: "tool_result", sessionId: input.sessionId, turnId: input.turnId, result };
      }

      const projected = projectToolResults(pairedResults);
      // Route the freshly projected tool_result message through the context
      // runtime so large payloads land on disk via `ToolResultBudget`. When
      // the runtime doesn't implement `applyToolResults` (e.g. NullContext),
      // we simply append the raw projection (legacy behaviour).
      const [toolResultMsg, ...supplementalMsgs] = projected;
      const supplementalInputs = bindSupplementalMessagesToToolCalls(pairedResults, supplementalMsgs);
      let appendedMessages: CanonicalMessage[] = projected;
      const ctxApply = this.dependencies.context?.applyToolResults;
      if (ctxApply) {
        try {
          const applied = await ctxApply.call(this.dependencies.context, {
            sessionId: input.sessionId,
            turnId: input.turnId,
            toolResultMessage: toolResultMsg,
            supplementalMessages: supplementalInputs,
            messages,
          });
          messages = applied.messages;
          appendedMessages = applied.appendedMessages ?? projected;
        } catch {
          messages.push(...projected);
        }
      } else {
        messages.push(...projected);
      }
      for (const appended of appendedMessages) {
        yield { type: "tool_results_projected", sessionId: input.sessionId, turnId: input.turnId, message: appended };
        await input.onDurableMessage?.(appended);
      }

      if (toolResultRepair) {
        const continued = await continueWithSyntheticPrompt(toolResultRepair);
        if (continued.type === "completed") {
          if (continued.status) {
            yield await emitStatus(continued.status);
          }
          yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: continued.result.errors![0]! };
          await captureTurn(continued.result.type === "error");
          yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: continued.result };
          return { result: continued.result, messages };
        }
        yield continued.event;
        continue;
      }

      const lifecycleBlock = findToolLifecycleBlock(pairedResults);
      if (lifecycleBlock) {
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "tool_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [agentError("agent_unsupported_feature", lifecycleBlock.reason)],
        });
        yield await emitStatus(createLifecycleBlockedStatus({
          error: result.errors![0]!,
          stage: "tool_lifecycle",
        }));
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      // Circuit breaker: detect turns where ALL tool calls returned
      // invalid_tool_input. Uses fingerprint-based detection (toolName +
      // errorMessage), and injects one grace prompt before final termination.
      // When LargeFileRepair is actively managing recovery, defer to its own
      // attempt limits instead of terminating here.
      const allInvalid = pairedResults.length > 0 && pairedResults.every(
        (r) => r.type === "error" && r.error.code === "invalid_tool_input",
      );
      if (allInvalid && largeFileRepair.hasPendingRepair) {
        const fallbackRepair = largeFileRepair.onInvalidToolInput();
        if (fallbackRepair) {
          const continued = await continueWithSyntheticPrompt(fallbackRepair);
          if (continued.type === "completed") {
            if (continued.status) {
              yield await emitStatus(continued.status);
            }
            yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: continued.result.errors![0]! };
            await captureTurn(continued.result.type === "error");
            yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: continued.result };
            return { result: continued.result, messages };
          }
          yield continued.event;
          continue;
        }
      }
      if (allInvalid) {
        const fingerprint = buildInvalidFingerprint(pairedResults);
        if (fingerprint === lastInvalidFingerprint) {
          sameInvalidFingerprintCount++;
        } else {
          sameInvalidFingerprintCount = 1;
          lastInvalidFingerprint = fingerprint;
          hasUsedInvalidGracePeriod = false;
        }

        if (sameInvalidFingerprintCount >= MAX_SAME_INVALID_FINGERPRINT) {
          if (!hasUsedInvalidGracePeriod) {
            hasUsedInvalidGracePeriod = true;
            pushTransientSyntheticPrompt(CIRCUIT_BREAKER_GRACE_PROMPT, "circuit_breaker_grace");
            yield { type: "turn_continued", sessionId: input.sessionId, turnId: input.turnId, reason: "model_error" };
            continue;
          }

          const result = this.createTurnResult(input, {
            type: "error",
            stopReason: "tool_error",
            usage,
            permissionDenials,
            turns: turnCount,
            startedAt,
            finalMessage,
            structuredOutput,
            errors: [agentError(
              "agent_tool_error_loop",
              `Terminated: ${sameInvalidFingerprintCount} consecutive turns with identical tool input validation failures (same tool + same error). The model appears stuck in a loop.`,
              undefined,
              "The model is repeatedly producing invalid tool calls. Consider switching to a more capable model via settings.",
            )],
          });
          yield await emitStatus(createToolErrorLoopStatus({
            error: result.errors![0]!,
            repeatedFailures: sameInvalidFingerprintCount,
          }));
          yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
          await captureTurn(result.type === "error");
          yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
          return { result, messages };
        }
      } else {
        sameInvalidFingerprintCount = 0;
        lastInvalidFingerprint = undefined;
        hasUsedInvalidGracePeriod = false;
        if (!pairedResults.some((r) => r.type === "error")) {
          lastToolFailureFingerprint = undefined;
        }
        maxOutputRecoveryCount = 0;
        consecutiveEmptyCount = 0;
        hasAttemptedOutputRetry = false;
        hasAttemptedEmptyRetry = false;
        hasAttemptedToolCallRetry = false;
      }

      if (this.config.stopOnStructuredOutput && structuredOutput !== undefined) {
        const result = this.createTurnResult(input, {
          type: "success",
          stopReason: "completed",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
        });
        const status = createStructuredOutputCompletedStatus();
        yield await emitStatus(status);
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      const nextTurnCount = turnCount + 1;
      if (input.maxTurns && nextTurnCount > input.maxTurns) {
        const maxTurnsError = agentError(
          "agent_max_turns_reached",
          `Reached maximum number of turns (${input.maxTurns}).`,
          undefined,
          "Max turn limit reached. Increase maxTurns in config or break the task into smaller steps.",
        );
        const result = this.createTurnResult(input, {
          type: "max_turns",
          stopReason: "max_turns",
          usage,
          permissionDenials,
          turns: nextTurnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [maxTurnsError],
        });
        const status = createMaxTurnsStatus({ maxTurns: input.maxTurns, error: maxTurnsError });
        yield await emitStatus(status);
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      turnCount = nextTurnCount;
      yield { type: "turn_continued", sessionId: input.sessionId, turnId: input.turnId, reason: "next_turn" };
    }
  }

  private async tryReactiveRecover(
    input: AgentLoopInput,
    error: CanonicalModelError,
    messages: CanonicalMessage[],
    hasAttemptedCompact: boolean,
  ): Promise<ContextRecoveryDecision | undefined> {
    const ctx: AgentContextRuntime | undefined = this.dependencies.context;
    if (!ctx?.recoverFromModelError) {
      return undefined;
    }
    try {
      return await ctx.recoverFromModelError({
        sessionId: input.sessionId,
        turnId: input.turnId,
        error,
        messages,
        hasAttemptedCompact,
      });
    } catch {
      // Recovery probe should never block fallback. Pretend the runtime gave up.
      return undefined;
    }
  }

  private async createModelRequest(
    messages: CanonicalMessage[],
    input: AgentLoopInput,
    options: { emitInstructionEvents?: boolean } = {},
  ): Promise<CanonicalModelRequest> {
    const contextRuntime = this.dependencies.context ?? new NullContextRuntime();
    const planTodo = this.dependencies.planTodoManager?.forSession(input.sessionId);
    const canPrompt = input.canPrompt ?? this.config.permissionContext.canPrompt;
    const promptBlockedToolNames = canPrompt
      ? new Set<string>()
      : new Set(
          this.dependencies.tools.registry.list()
            .filter((tool) => requiresPromptCapability(tool, {}))
            .map((tool) => tool.name),
        );
    let toolDefinitions = this.dependencies.tools.registry.list()
      .filter((tool) => !promptBlockedToolNames.has(tool.name));
    if (input.allowPlanModeTools !== true) {
      toolDefinitions = toolDefinitions.filter(
        (tool) => tool.name !== "enter_plan_mode" && tool.name !== "exit_plan_mode",
      );
    }
    const requestMessages = normalizeMessagesForModelRequest(messages);
    let tools = toolDefinitions.map(toolToCanonicalSchema);
    if (this.config.runMode === "ask") {
      tools = filterAskModeTools(toolDefinitions);
    }
    const prepared = await contextRuntime.prepareForModel({
      sessionId: input.sessionId,
      turnId: input.turnId,
      cwd: this.config.cwd,
      provider: this.config.provider,
      model: this.config.model,
      permissionMode: this.config.permissionMode,
      runMode: this.config.runMode ?? "agent",
      additionalWorkingDirectories: this.config.permissionContext.additionalWorkingDirectories,
      messages: cloneMessages(requestMessages),
      tools,
      maxMessages: this.config.maxContextMessages,
      customSystemPrompt: this.config.systemPrompt,
      appendSystemPrompt: planTodo?.buildPromptAddendum(),
      abortSignal: input.abortSignal,
    });

    if (options.emitInstructionEvents !== false) {
      this.dispatchLifecycle(input, "InstructionsLoaded", {
        hasSystemPrompt: !!prepared.systemPrompt,
      }).catch(() => {});
      this.dependencies.eventEmitter?.({
        type: "instructions_loaded",
        sessionId: input.sessionId,
        turnId: input.turnId,
        hasSystemPrompt: !!prepared.systemPrompt,
      });
    }

    const materialized = await materializeMediaReferences(prepared.messages);
    for (const diagnostic of materialized.diagnostics) {
      // eslint-disable-next-line no-console
      console.warn(
        `[rigorium] ${diagnostic.code}: ${diagnostic.message} (${diagnostic.mediaType}, ${diagnostic.path})`,
      );
    }

    // Phase 4: automatic vision enrichment — when the main model cannot see
    // images and a vision assistant is configured, describe images before
    // they reach the model instead of letting the multimodal downgrade turn
    // them into bare placeholders.
    const baseMessages = this.config.permissionMode === "plan"
      ? appendPlanModeReminder(materialized.messages)
      : materialized.messages;
    let visionEnrichedMessages = baseMessages;
    if (this.dependencies.visionAssistant && this.config.modelMultimodal?.input.includes("image") !== true) {
      const enrichment = await enrichMessagesWithVisionDescriptions(baseMessages, {
        modelInputModalities: this.config.modelMultimodal?.input,
        assistant: this.dependencies.visionAssistant,
        signal: input.abortSignal,
      });
      for (const diagnostic of enrichment.diagnostics) {
        // eslint-disable-next-line no-console
        console.warn(`[rigorium] vision-enrichment: ${diagnostic}`);
      }
      visionEnrichedMessages = enrichment.messages;
    }

    return {
      provider: this.config.provider,
      model: this.config.model,
      messages: visionEnrichedMessages,
      systemPrompt: prepared.systemPrompt ?? this.config.systemPrompt,
      tools: prepared.tools,
      toolChoice: this.config.toolChoice,
      maxOutputTokens: this.config.maxOutputTokens,
      temperature: this.config.temperature,
      thinking: this.config.thinking,
      stream: true,
      metadata: this.config.metadata,
      cacheBreakpoints: prepared.cacheBreakpoints,
    };
  }

  private createBudgetEvaluator(
    input: AgentLoopInput,
    options: {
      decision?: import("../../router/index.js").RouterDecision;
      baseRequest?: CanonicalModelRequest;
      maxContextTokens?: number;
      reservedOutputTokens: number;
    },
  ): ((candidateMessages: CanonicalMessage[], lastUsage?: CanonicalUsage) => Promise<TokenBudgetSnapshot>) | undefined {
    const tokenAccounting = this.dependencies.tokenAccounting;
    const maxContextTokens = options.maxContextTokens;
    if (!tokenAccounting || !maxContextTokens) {
      return undefined;
    }
    return async (candidateMessages, lastUsage) => {
      let candidateRequest = await this.createModelRequest(candidateMessages, input, {
        emitInstructionEvents: false,
      });
      if (options.decision && options.baseRequest && this.dependencies.router.materializeRequest) {
        const patchedBase = { ...options.baseRequest, messages: candidateRequest.messages };
        candidateRequest = this.dependencies.router.materializeRequest(options.decision, {
          ...patchedBase,
          systemPrompt: candidateRequest.systemPrompt,
          tools: candidateRequest.tools,
          cacheBreakpoints: candidateRequest.cacheBreakpoints,
        });
      }
      const snapshot = await tokenAccounting.evaluateRequestBudget(candidateRequest, {
        maxContextTokens,
        reservedOutputTokens: options.reservedOutputTokens,
        signal: input.abortSignal,
        usePadding: true,
      });
      const usageTokens = tokensFromUsage(lastUsage);
      if (usageTokens === undefined || usageTokens <= snapshot.tokens) {
        return snapshot;
      }
      return tokenAccounting.snapshotFromTokens(usageTokens, maxContextTokens, {
        reservedOutputTokens: options.reservedOutputTokens,
        usageTokens,
        budgetTokens: snapshot.budgetTokens,
        source: snapshot.source,
        exact: snapshot.exact,
        estimatorError: snapshot.estimatorError,
      });
    };
  }

  private getReservedOutputTokens(provider?: string, model?: string): number {
    if (provider && model) {
      return this.currentMaxOutputTokens(provider, model) ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
    }
    return this.currentMaxOutputTokens(this.config.provider, this.config.model) ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
  }

  private tokenCapKey(provider: string, model: string): string {
    return `${provider}/${model}`;
  }

  private getModelTokenLimits(provider: string, model: string): { maxContextTokens?: number; maxOutputTokens?: number } | undefined {
    const combined = this.dependencies.getModelTokenLimits?.(provider, model);
    if (combined) return combined;
    const maxContextTokens = this.dependencies.getModelMaxContextTokens?.(provider, model);
    const maxOutputTokens = this.dependencies.getModelMaxOutputTokens?.(provider, model);
    if (maxContextTokens === undefined && maxOutputTokens === undefined) return undefined;
    return { maxContextTokens, maxOutputTokens };
  }

  private currentMaxContextTokens(provider: string, model: string): number {
    const transient = this.transientTokenCaps.get(this.tokenCapKey(provider, model))?.maxContextTokens;
    return transient ?? this.getModelTokenLimits(provider, model)?.maxContextTokens ?? this.config.maxContextTokens ?? 1_000_000;
  }

  private currentMaxOutputTokens(provider: string, model: string): number | undefined {
    const transient = this.transientTokenCaps.get(this.tokenCapKey(provider, model));
    const modelMaxOutputTokens = this.getModelTokenLimits(provider, model)?.maxOutputTokens;
    const requested = transient?.attemptMaxOutputTokens ?? transient?.requestedMaxOutputTokens ?? this.config.maxOutputTokens ?? modelMaxOutputTokens;
    const candidates = [requested, modelMaxOutputTokens, transient?.hardMaxOutputTokens]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    return candidates.length > 0 ? Math.min(...candidates.map((value) => Math.floor(value))) : undefined;
  }

  private setTransientTokenCap(provider: string, model: string, cap: {
    maxContextTokens?: number;
    requestedMaxOutputTokens?: number;
    attemptMaxOutputTokens?: number;
    hardMaxOutputTokens?: number;
  }): void {
    const key = this.tokenCapKey(provider, model);
    const previous = this.transientTokenCaps.get(key) ?? {};
    this.transientTokenCaps.set(key, { ...previous, ...cap });
  }

  private clearAttemptOutputTokenCap(provider: string, model: string): void {
    const key = this.tokenCapKey(provider, model);
    const previous = this.transientTokenCaps.get(key);
    if (!previous || previous.attemptMaxOutputTokens === undefined) return;
    const { attemptMaxOutputTokens: _attemptMaxOutputTokens, ...rest } = previous;
    this.transientTokenCaps.set(key, rest);
  }

  private clearTurnScopedTokenCaps(): void {
    for (const [key, cap] of this.transientTokenCaps) {
      const {
        requestedMaxOutputTokens: _requestedMaxOutputTokens,
        attemptMaxOutputTokens: _attemptMaxOutputTokens,
        ...sessionCaps
      } = cap;
      if (sessionCaps.maxContextTokens === undefined && sessionCaps.hardMaxOutputTokens === undefined) {
        this.transientTokenCaps.delete(key);
      } else {
        this.transientTokenCaps.set(key, sessionCaps);
      }
    }
  }

  private applyTokenCapsToRequest(request: CanonicalModelRequest, provider: string, model: string): CanonicalModelRequest {
    return {
      ...request,
      provider,
      model,
      maxOutputTokens: this.currentMaxOutputTokens(provider, model),
    };
  }

  private repairTextExtractedToolNames(
    message: CanonicalMessage,
    toolCalls: CanonicalToolCall[],
  ): { message: CanonicalMessage; toolCalls: CanonicalToolCall[] } {
    if (toolCalls.length === 0) return { message, toolCalls };
    const validNames = new Set(this.dependencies.tools.registry.list().map((tool) => tool.name));
    const repairedById = new Map<string, string>();
    const repairedToolCalls = toolCalls.map((call) => {
      const repaired = repairToolName(call.name, validNames, this.config.toolAliases);
      if (!repaired) return call;
      repairedById.set(call.id, repaired.name);
      return { ...call, name: repaired.name };
    });
    if (repairedById.size === 0) return { message, toolCalls };

    return {
      message: {
        ...message,
        content: message.content.map((block) => {
          if (block.type !== "tool_call") return block;
          const repairedName = repairedById.get(block.id);
          return repairedName ? ({ ...block, name: repairedName } satisfies CanonicalToolCallBlock) : block;
        }),
      },
      toolCalls: repairedToolCalls,
    };
  }

  private createToolContext(
    input: AgentLoopInput,
    messages: CanonicalMessage[],
  ): RigoriumToolRuntimeContext {
    const planDirectoryPath = this.dependencies.planFileManager?.getPlanDirectoryPath();
    const planTodo = this.dependencies.planTodoManager?.forSession(input.sessionId);
    const canPrompt = input.canPrompt ?? this.config.permissionContext.canPrompt;
    const permissionContext = {
      ...this.config.permissionContext,
      cwd: this.config.cwd,
      canPrompt,
      ...(planDirectoryPath ? { planDirectoryPath } : {}),
    };
    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      // Group key for `FileHistoryStore.trackEdit` (C4). Our canonical
      // assistant messages don't carry an id, so the turn id is the closest
      // stable scope: every edit/write produced inside this turn rewinds as
      // a single batch — semantic match to legacy "rewind by messageId".
      messageId: input.turnId,
      cwd: this.config.cwd,
      abortSignal: input.abortSignal,
      subagentTimeoutMs: this.config.subagentTimeoutMs,
      toolAliases: this.config.toolAliases,
      runMode: this.config.runMode ?? "agent",
      permissionMode: this.config.permissionMode,
      permissionContext,
      auditRecorder: this.dependencies.auditRecorder,
      now: this.now,
      env: this.config.env,
      maxResultBytes: this.config.maxResultBytes,
      // Tools that need a secondary model call (e.g. `agent` subagents in
      // fallback mode, `web_fetch` extraction) get a thin adapter that
      // funnels into the router's stream so subagents inherit fallback /
      // zero-usage retry.
      model: {
        stream: (request, signal) =>
          this.dependencies.router.stream(request, {
            sessionId: input.sessionId,
            turnId: input.turnId,
            projectPath: this.config.cwd,
            abortSignal: signal,
            isMainAgent: false,
          }),
      },
      elicitation: this.dependencies.elicitation,
      fileHistory: this.dependencies.fileHistory,
      subagentDepth: this.config.subagentDepth ?? 0,
      subagent: this.buildSubagentForkApi(input, messages),
      modelMultimodal: this.config.modelMultimodal,
      maxOutputTokens: this.config.maxOutputTokens,
      readFileState: this.readFileState,
      allowedReadFiles: [...this.allowedReadFiles],
      writeSnapshots: this.writeSnapshots,
      fileUpdateNotifier: this.dependencies.fileUpdateNotifier,
      ...(planTodo ? { planTodo } : {}),
      ...(planDirectoryPath
        ? {
            planDirectory: {
              path: planDirectoryPath,
              resolve: (filePath: string) =>
                this.dependencies.planFileManager?.resolvePlanFilePath(filePath, this.config.cwd),
              read: (filePath: string) =>
                this.dependencies.planFileManager?.readPlanFile(filePath, this.config.cwd),
            },
          }
        : {}),
    };
  }

  private buildSubagentForkApi(
    input: AgentLoopInput,
    messages: CanonicalMessage[],
  ): RigoriumSubagentForkApi {
    const depth = this.config.subagentDepth ?? 0;
    const maxDepth = this.config.maxSubagentDepth ?? 1;
    return {
      depth,
      maxSubagentDepth: maxDepth,
      listDefinitions: () =>
        Object.values(SUBAGENT_DEFINITIONS).map((d) => ({
          id: d.id,
          description: d.description,
        })),
      isAllowedDefinition: (id: string) => getSubagentDefinition(id) !== undefined,
      fork: async ({ definitionId, directive, subagentId, toolCallId, abortSignal, timeoutMs }) => {
        // Defer SubAgentSession import to avoid the runtime cycle (sub → loop → sub).
        const { SubAgentSession } = await import("../sub/SubAgentSession.js");
        const def = getSubagentDefinition(definitionId);
        if (!def) throw new Error(`Unknown subagent type: ${definitionId}`);
        const composedAbort = composeAbortSignal({
          parent: abortSignal,
          timeoutMs,
        });

        const subagentSessionId = `${this.config.cwd}::sub::${subagentId}`;
        const transcriptHooks = this.dependencies.subagentTranscript;
        const sidechain = transcriptHooks?.subagentTranscriptResolver?.(subagentId);
        const transcriptRelativePath = sidechain?.transcriptRelativePath ?? "";

        await transcriptHooks?.recordSubagentStarted?.({
          sessionId: input.sessionId,
          turnId: input.turnId,
          subagentId,
          subagentType: def.id,
          prompt: directive,
          transcriptRelativePath,
          subagentSessionId,
        });
        await this.dispatchLifecycle(input, "SubagentStart", {
          subagentId,
          subagentType: def.id,
        });
        this.dependencies.eventEmitter?.({
          type: "subagent_started",
          sessionId: input.sessionId,
          turnId: input.turnId,
          subagentId,
          subagentType: def.id,
          toolCallId,
        });

        const subSession = new SubAgentSession({
          definition: def,
          directive,
          parentConfig: {
            ...this.config,
            subagentDepth: depth + 1,
            isSubagent: true,
          },
          parentDependencies: this.dependencies,
          parentReadFileState: this.readFileState,
          parentWriteSnapshots: this.writeSnapshots,
          parentSessionId: input.sessionId,
          parentTurnId: input.turnId,
          subagentSessionId,
          subagentId,
          abortSignal: composedAbort.signal,
          sidechainTranscript: sidechain
            ? {
                recordAcceptedInput: sidechain.recordAcceptedInput.bind(sidechain),
                recordDurableMessage: sidechain.recordDurableMessage.bind(sidechain),
              }
            : undefined,
        });

        let report;
        let errored = false;
        try {
          report = await subSession.run();
          if (composedAbort.timedOut()) {
            throw new Error(`Subagent timed out after ${timeoutMs}ms.`);
          }
        } catch (err) {
          composedAbort.cleanup();
          errored = true;
          await transcriptHooks?.recordSubagentCompleted?.({
            sessionId: input.sessionId,
            turnId: input.turnId,
            subagentId,
            subagentType: def.id,
            summary: err instanceof Error ? err.message : String(err),
            turns: 0,
            durationMs: 0,
            errored: true,
          });
          await this.dispatchLifecycle(input, "SubagentStop", {
            subagentId,
            subagentType: def.id,
            success: false,
          });
          this.dependencies.eventEmitter?.({
            type: "subagent_completed",
            sessionId: input.sessionId,
            turnId: input.turnId,
            subagentId,
            subagentType: def.id,
            success: false,
            durationMs: 0,
          });
          throw err;
        }
        composedAbort.cleanup();

        await transcriptHooks?.recordSubagentCompleted?.({
          sessionId: input.sessionId,
          turnId: input.turnId,
          subagentId,
          subagentType: def.id,
          summary: report.markdown,
          usage: report.usage,
          turns: report.turns,
          durationMs: report.durationMs,
          errored,
        });
        await this.dispatchLifecycle(input, "SubagentStop", {
          subagentId,
          subagentType: def.id,
          success: !errored,
        });
        this.dependencies.eventEmitter?.({
          type: "subagent_completed",
          sessionId: input.sessionId,
          turnId: input.turnId,
          subagentId,
          subagentType: def.id,
          success: !errored,
          durationMs: report.durationMs,
        });

        return {
          markdown: report.markdown,
          usage: report.usage,
          turns: report.turns,
          durationMs: report.durationMs,
          parsed: report.parsed as unknown as Record<string, string> | undefined,
        };
      },
    };
  }

  private async dispatchLifecycle(
    input: AgentLoopInput,
    event: RigoriumHookEvent,
    payload: Record<string, unknown>,
  ): Promise<LifecycleDispatchResult> {
    return this.dependencies.lifecycle?.dispatch({
      event,
      baseInput: {
        sessionId: input.sessionId,
        transcriptPath: "",
        cwd: this.config.cwd,
        permissionMode: this.config.permissionMode,
      },
      payload,
      matchQuery: event,
      signal: input.abortSignal,
      env: this.config.env,
    }) ?? {
      effects: [],
      messages: [],
      events: [],
      blockingErrors: [],
      nonBlockingErrors: [],
    };
  }

  private *drainEventBuffer(): Generator<AgentEvent> {
    const events = this.dependencies.drainEvents?.() ?? [];
    for (const event of events) {
      yield event;
    }
  }

  private async *executeToolsWithEventPump(
    toolCalls: CanonicalToolCall[],
    context: RigoriumToolRuntimeContext,
    input: AgentLoopInput,
  ): AsyncGenerator<AgentEvent, RigoriumToolResult[], unknown> {
    const activeSubagents = new Map<string, ActiveSubagentStatus>();
    let results: RigoriumToolResult[] | undefined;
    let error: unknown;
    let settled = false;

    const execution = this.dependencies.tools.scheduler.executeAll(toolCalls, context)
      .then((value) => {
        results = value;
      }, (err) => {
        error = err;
      })
      .finally(() => {
        settled = true;
      });

    while (!settled) {
      await Promise.race([execution, sleep(TOOL_EVENT_PUMP_INTERVAL_MS)]);
      yield* this.drainToolEventBufferForSubagentStatus(input, activeSubagents);
      if (!settled) {
        yield* this.emitSubagentHeartbeats(input, activeSubagents);
      }
    }

    yield* this.drainToolEventBufferForSubagentStatus(input, activeSubagents);
    if (error) throw error;
    return results ?? [];
  }

  private *drainToolEventBufferForSubagentStatus(
    input: AgentLoopInput,
    activeSubagents: Map<string, ActiveSubagentStatus>,
  ): Generator<AgentEvent> {
    const events = this.dependencies.drainEvents?.() ?? [];
    for (const event of events) {
      const statusEvent = this.updateSubagentStatusFromEvent(input, activeSubagents, event);
      yield event;
      if (statusEvent) {
        yield statusEvent;
      }
    }
  }

  private updateSubagentStatusFromEvent(
    input: AgentLoopInput,
    activeSubagents: Map<string, ActiveSubagentStatus>,
    event: AgentEvent,
  ): AgentEvent | undefined {
    if (event.type === "subagent_started") {
      const nowMs = this.now().getTime();
      activeSubagents.set(event.subagentId, {
        subagentId: event.subagentId,
        subagentType: event.subagentType,
        startedAtMs: nowMs,
        lastHeartbeatMs: nowMs,
      });
      return undefined;
    }

    if (event.type === "subagent_completed") {
      activeSubagents.delete(event.subagentId);
      return undefined;
    }

    if (event.type !== "pre_tool_execute" && event.type !== "post_tool_execute") {
      return undefined;
    }

    const subagentId = subagentIdFromSessionId(event.sessionId);
    if (!subagentId) {
      return undefined;
    }

    const nowMs = this.now().getTime();
    const state = activeSubagents.get(subagentId) ?? {
      subagentId,
      startedAtMs: nowMs,
      lastHeartbeatMs: nowMs,
    };
    if (event.type === "pre_tool_execute") {
      state.currentToolCallId = event.toolCallId;
      state.currentToolName = event.toolName;
    } else {
      state.currentToolCallId = undefined;
      state.currentToolName = undefined;
    }
    state.lastHeartbeatMs = nowMs;
    activeSubagents.set(subagentId, state);

    return {
      type: "subagent_status",
      sessionId: input.sessionId,
      turnId: input.turnId,
      subagentId,
      subagentType: state.subagentType,
      status: event.type === "pre_tool_execute" ? "tool_started" : "tool_completed",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.type === "post_tool_execute" ? { success: event.success } : {}),
      durationMs: Math.max(0, nowMs - state.startedAtMs),
    };
  }

  private *emitSubagentHeartbeats(
    input: AgentLoopInput,
    activeSubagents: Map<string, ActiveSubagentStatus>,
  ): Generator<AgentEvent> {
    const nowMs = this.now().getTime();
    for (const state of activeSubagents.values()) {
      if (nowMs - state.lastHeartbeatMs < SUBAGENT_STATUS_HEARTBEAT_MS) {
        continue;
      }
      state.lastHeartbeatMs = nowMs;
      yield {
        type: "subagent_status",
        sessionId: input.sessionId,
        turnId: input.turnId,
        subagentId: state.subagentId,
        subagentType: state.subagentType,
        status: state.currentToolName ? "running" : "waiting_model",
        toolCallId: state.currentToolCallId,
        toolName: state.currentToolName,
        durationMs: Math.max(0, nowMs - state.startedAtMs),
      };
    }
  }

  private createTurnResult(
    input: AgentLoopInput,
    options: Omit<AgentTurnResult, "sessionId" | "turnId" | "completedAt">,
  ): AgentTurnResult {
    return {
      ...options,
      sessionId: input.sessionId,
      turnId: input.turnId,
      completedAt: this.now().toISOString(),
    };
  }

  private applyPermissionOverrides(
    permissionMode?: PermissionMode,
    permissionRules?: Partial<PermissionRuleSet>,
    basePermissionMode?: PermissionMode,
  ): void {
    if (permissionMode) {
      if (permissionMode === "plan" && this.config.permissionMode !== "plan") {
        this.config.permissionModeBeforePlan = basePermissionMode ?? this.config.permissionMode;
      }
      this.config.permissionMode = permissionMode;
      this.config.permissionContext.mode = permissionMode;
    }
    if (!permissionRules) return;
    mergeUserRules(this.config.permissionContext.rules.allow, permissionRules.allow);
    mergeUserRules(this.config.permissionContext.rules.deny, permissionRules.deny);
    mergeUserRules(this.config.permissionContext.rules.ask, permissionRules.ask);
  }

  private applyRunModeOverride(runMode?: AgentRunMode): void {
    if (runMode) {
      this.config.runMode = runMode;
    } else {
      this.config.runMode ??= "agent";
    }
  }

  private readonly now = (): Date => this.dependencies.now?.() ?? new Date();
}

