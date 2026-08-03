import type {
  CanonicalModelRequest,
  InputModality,
  ModelRuntime,
} from "../../model/index.js";
import { cloneMessages, downgradeUnsupportedContent } from "../../model/index.js";
import type { RouterModelRef } from "../config/schema.js";
import type { MediaCapabilityChecks } from "../policy/mediaCapability.js";

export type AttemptPlan = {
  attempt: RouterModelRef;
  downgradeUnsupportedMedia: boolean;
};

/**
 * Order candidate attempts so media-capable models come first; models that
 * cannot accept the request's required modalities are tried last with their
 * content downgraded to text placeholders.
 */
export function buildAttemptPlans(
  candidateAttempts: RouterModelRef[],
  requiredModalities: readonly InputModality[],
  mediaChecks: MediaCapabilityChecks,
): AttemptPlan[] {
  const nativeAttempts = candidateAttempts.filter((attempt) =>
    mediaChecks.supportsMediaRequirements(attempt, requiredModalities));
  const downgradedAttempts = requiredModalities.length > 0
    ? candidateAttempts.filter((attempt) => !mediaChecks.supportsMediaRequirements(attempt, requiredModalities))
    : [];
  return [
    ...nativeAttempts.map((attempt) => ({ attempt, downgradeUnsupportedMedia: false })),
    ...downgradedAttempts.map((attempt) => ({ attempt, downgradeUnsupportedMedia: true })),
  ];
}

/** Clamp `maxOutputTokens` to the routed model's capability cap. */
export function clampMaxOutputTokensToModelCap(
  request: CanonicalModelRequest,
  modelRuntime: ModelRuntime,
): CanonicalModelRequest {
  const requested = request.maxOutputTokens;
  if (requested === undefined) {
    return request;
  }

  try {
    const cap = modelRuntime.getCapabilities(request.provider, request.model).maxOutputTokens;
    if (Number.isFinite(cap) && cap > 0 && requested > cap) {
      return { ...request, maxOutputTokens: cap };
    }
  } catch {
    // Unknown provider/model — let validateModelRequest surface the real error.
  }
  return request;
}

/** Replace unsupported media blocks with text placeholders for an attempt. */
export function downgradeRequestForAttempt(
  request: CanonicalModelRequest,
  attempt: RouterModelRef,
  modelRuntime: ModelRuntime,
): CanonicalModelRequest {
  let multimodal: ReturnType<ModelRuntime["getMultimodal"]>;
  try {
    multimodal = modelRuntime.getMultimodal(attempt.provider, attempt.model);
  } catch {
    // Unknown provider/model should still be reported by validateModelRequest.
    return request;
  }
  const messages = cloneMessages(request.messages);
  downgradeUnsupportedContent(messages, multimodal);
  return { ...request, messages };
}
