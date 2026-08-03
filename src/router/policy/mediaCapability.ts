import type {
  CanonicalModelRequest,
  ModelRuntime,
} from "../../model/index.js";
import { cloneMessages, downgradeUnsupportedContent } from "../../model/index.js";
import type { InputModality } from "../../model/index.js";
import type { RouterModelRef } from "../config/schema.js";
import type {
  RouterDecision,
  RouterMutationsLog,
  RouterScenarioType,
} from "../protocol/decision.js";
import {
  collectRequiredInputModalities,
  missingInputModalities,
} from "../utils/mediaRequirements.js";

export type MediaCapabilityChecks = {
  missingForModel(ref: RouterModelRef, required: readonly InputModality[]): InputModality[];
  supportsMediaRequirements(ref: RouterModelRef, required: readonly InputModality[]): boolean;
};

/**
 * Media-capability checks against the model catalog. Unknown provider/model
 * pairs report everything as missing so the caller's fallback logic treats
 * them conservatively instead of crashing.
 */
export function createMediaCapabilityChecks(modelRuntime: ModelRuntime): MediaCapabilityChecks {
  function missingForModel(
    ref: RouterModelRef,
    required: readonly InputModality[],
  ): InputModality[] {
    if (required.length === 0) {
      return [];
    }
    try {
      return missingInputModalities(
        modelRuntime.getMultimodal(ref.provider, ref.model),
        required,
      );
    } catch {
      return [...required];
    }
  }

  function supportsMediaRequirements(
    ref: RouterModelRef,
    required: readonly InputModality[],
  ): boolean {
    return missingForModel(ref, required).length === 0;
  }

  return { missingForModel, supportsMediaRequirements };
}

export type MediaRerouteDeps = MediaCapabilityChecks & {
  fallbackCandidatesFor: (scenarioType: RouterScenarioType) => RouterModelRef[];
};

/**
 * When the selected model cannot accept the required input modalities
 * (image/pdf/audio), silently swap to the first fallback candidate that can.
 * Returns the (possibly unchanged) mutations log.
 */
export function rerouteDecisionForMedia(
  decision: RouterDecision,
  messages: CanonicalModelRequest["messages"],
  mutations: RouterMutationsLog,
  deps: MediaRerouteDeps,
): RouterMutationsLog {
  const required = collectRequiredModalities(messages);
  if (required.length === 0) {
    return mutations;
  }

  const selected: RouterModelRef = {
    id: `${decision.provider}/${decision.model}`,
    provider: decision.provider,
    model: decision.model,
  };
  if (deps.supportsMediaRequirements(selected, required)) {
    return mutations;
  }

  const replacement = deps
    .fallbackCandidatesFor(decision.scenarioType)
    .find((ref) => deps.supportsMediaRequirements(ref, required));
  if (!replacement) {
    return mutations;
  }

  decision.provider = replacement.provider;
  decision.model = replacement.model;
  decision.resolvedFrom = "fallback";
  return {
    ...mutations,
    mediaCapabilityRerouted: {
      required: [...required],
      from: selected.id,
      to: replacement.id || `${replacement.provider}/${replacement.model}`,
    },
  };
}

function collectRequiredModalities(messages: CanonicalModelRequest["messages"]): InputModality[] {
  return collectRequiredInputModalities(messages);
}
