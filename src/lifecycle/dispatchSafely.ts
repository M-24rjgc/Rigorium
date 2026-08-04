import type { LifecycleRuntime } from "./runtime/LifecycleRuntime.js";
import type { LifecycleDispatchInput, LifecycleDispatchResult } from "./protocol/payloads.js";
import { emptyLifecycleDispatchResult } from "./protocol/payloads.js";

/**
 * Minimal structural view some consumers (e.g. CompactionEngine) accept —
 * they only need dispatch and never read the full result.
 */
export type LifecycleDispatchLike = {
  dispatch(
    input: LifecycleDispatchInput,
  ): LifecycleDispatchResult | Promise<LifecycleDispatchResult> | void | Promise<void>;
};

/**
 * The platform-wide invariant for lifecycle (hook) dispatch: a hook backend
 * failure must never break the agent loop, a tool call, a session, a turn,
 * or a compaction. Every dispatch site funnels through here — a thrown hook
 * error degrades to the same empty result as an absent lifecycle runtime
 * (surfaced as a warning), so a broken hook behaves exactly like a missing
 * one. Hook effects (block/deny/additional context) only apply when the
 * hook actually ran and answered.
 */
export async function dispatchLifecycleSafely(
  lifecycle: LifecycleRuntime | LifecycleDispatchLike | undefined,
  input: LifecycleDispatchInput,
): Promise<LifecycleDispatchResult> {
  if (!lifecycle) {
    return emptyLifecycleDispatchResult();
  }
  try {
    return (await lifecycle.dispatch(input)) ?? emptyLifecycleDispatchResult();
  } catch (error) {
    console.warn(
      `[Rigorium] lifecycle dispatch failed for ${input.event}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return emptyLifecycleDispatchResult();
  }
}
