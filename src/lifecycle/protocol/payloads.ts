import type { CanonicalMessage } from "../../model/index.js";
import type { RigoriumHookEvent } from "../../extension/hooks/protocol/events.js";
import type { RigoriumHookBaseInput } from "../../extension/hooks/protocol/input.js";
import type { RigoriumHookEffect, RigoriumLifecycleError } from "./effects.js";

export type LifecycleDispatchInput = {
  event: RigoriumHookEvent;
  baseInput: RigoriumHookBaseInput;
  payload?: Record<string, unknown>;
  matchQuery?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};

export type LifecycleDispatchResult = {
  effects: RigoriumHookEffect[];
  messages: CanonicalMessage[];
  events: unknown[];
  blockingErrors: RigoriumLifecycleError[];
  nonBlockingErrors: RigoriumLifecycleError[];
};

export function emptyLifecycleDispatchResult(): LifecycleDispatchResult {
  return {
    effects: [],
    messages: [],
    events: [],
    blockingErrors: [],
    nonBlockingErrors: [],
  };
}
