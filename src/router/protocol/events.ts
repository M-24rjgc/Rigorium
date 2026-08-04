import type { CanonicalModelError } from "../../model/index.js";
import type { RouterDecision, RouterScenarioType } from "./decision.js";

export type RouterDecisionEvent = {
  type: "rigorium_router_decision";
  sessionId: string;
  turnId?: string;
  decision: RouterDecision;
};

export type RouterFallbackEvent = {
  type: "rigorium_router_fallback";
  sessionId: string;
  turnId?: string;
  scenarioType: RouterScenarioType;
  attempt: number;
  fromProvider: string;
  fromModel: string;
  toProvider: string;
  toModel: string;
  error: CanonicalModelError;
};

export type RouterZeroUsageRetryEvent = {
  type: "rigorium_router_zero_usage_retry";
  sessionId: string;
  turnId?: string;
  attempt: number;
  provider: string;
  model: string;
};

export type RouterTokenSaverFailedEvent = {
  type: "rigorium_router_token_saver_failed";
  sessionId: string;
  turnId?: string;
  reason: "timeout" | "model_error" | "parse_error";
  fallbackTier: string;
};

export type RouterCustomFailedEvent = {
  type: "rigorium_router_custom_failed";
  sessionId: string;
  turnId?: string;
  extensionId: string;
  reason: string;
};

export type RouterExecuteFailedEvent = {
  type: "rigorium_router_execute_failed";
  sessionId: string;
  turnId?: string;
  scenarioType: RouterScenarioType;
  provider: string;
  model: string;
  error: CanonicalModelError;
};

export type RouterTransientRetryEvent = {
  type: "rigorium_router_transient_retry";
  sessionId: string;
  turnId?: string;
  attempt: number;
  delayMs: number;
  provider: string;
  model: string;
  errorCode: string;
};

export type RouterRetryProgressEvent = {
  type: "rigorium_router_retry_progress";
  sessionId: string;
  turnId?: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: "rate_limit" | "server_error" | "network_error" | "zero_usage" | "overloaded" | "continuation";
  provider: string;
  model: string;
};

/**
 * Emitted when a provider transitions into the `degraded` health state
 * (consecutive failures reached the degrade threshold, or a rate-limit /
 * overload error stressed it). Observability only — degraded providers are
 * still used (only `open` is skipped), but operators can see the provider
 * struggling before the circuit opens.
 */
export type RouterProviderDegradedEvent = {
  type: "rigorium_router_provider_degraded";
  sessionId: string;
  turnId?: string;
  provider: string;
  model: string;
  errorCode: string;
  consecutiveFailures: number;
};

export type RouterEvent =
  | RouterDecisionEvent
  | RouterFallbackEvent
  | RouterZeroUsageRetryEvent
  | RouterTokenSaverFailedEvent
  | RouterCustomFailedEvent
  | RouterExecuteFailedEvent
  | RouterTransientRetryEvent
  | RouterRetryProgressEvent
  | RouterProviderDegradedEvent;

export type RouterEventBus = {
  emit(event: RouterEvent): void;
};
