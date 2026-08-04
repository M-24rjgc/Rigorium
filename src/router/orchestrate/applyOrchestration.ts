import type { RouterAutoOrchestrateConfig } from "../config/schema.js";
import type { RouterMutationsLog } from "../protocol/decision.js";

/** Default cap on continuation turns in a single orchestration run. */
export const DEFAULT_MAX_ORCHESTRATION_TURNS = 8;

export type OrchestrationInput = {
  config: RouterAutoOrchestrateConfig;
  isMainAgent: boolean;
  tier?: string;
  /** When true the session was already orchestrating on a prior turn. */
  alreadyOrchestrating?: boolean;
  /**
   * Turns already consumed by the current orchestration run (from the
   * session sticky). Only meaningful while alreadyOrchestrating.
   */
  continuationCount?: number;
};

export type OrchestrationResult = {
  mutations: RouterMutationsLog;
  /** True when orchestration is active for this turn. */
  applied: boolean;
  /** True when this turn ends an active orchestration run. */
  exited: boolean;
};

/**
 * Orchestration has explicit exit paths, otherwise a session that once
 * crossed a trigger tier would stay orchestrated forever (the sticky only
 * expires via TTL or quality failures):
 *
 *  1. Reclassification exit — the judge downgraded this turn's tier below
 *     the trigger tiers: orchestration ends so continuation turns don't get
 *     pinned to a hard-task mode that no longer matches the task.
 *  2. Run cap — `maxContinuationTurns` bounds the run as a safety net; the
 *     next turn re-judges from scratch and may start a fresh run.
 */
export function applyOrchestration(input: OrchestrationInput): OrchestrationResult {
  const { config } = input;
  if (!config.enabled || !input.isMainAgent) {
    return { mutations: {}, applied: false, exited: false };
  }

  const triggerTiers = config.triggerTiers ?? [];
  const tierTriggers = triggerTiers.length === 0 || (!!input.tier && triggerTiers.includes(input.tier));

  if (input.alreadyOrchestrating) {
    const count = input.continuationCount ?? 0;
    const maxContinuationTurns = config.maxContinuationTurns ?? DEFAULT_MAX_ORCHESTRATION_TURNS;
    if (count >= maxContinuationTurns || !tierTriggers) {
      return { mutations: {}, applied: false, exited: true };
    }
    return {
      mutations: {
        orchestrationActivated: {
          tier: input.tier ?? "main",
          continued: true,
        },
      },
      applied: true,
      exited: false,
    };
  }

  if (triggerTiers.length > 0 && (!input.tier || !triggerTiers.includes(input.tier))) {
    return { mutations: {}, applied: false, exited: false };
  }

  return {
    mutations: {
      orchestrationActivated: {
        tier: input.tier ?? "main",
        continued: false,
      },
    },
    applied: true,
    exited: false,
  };
}
