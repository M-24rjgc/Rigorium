import type { CanonicalMessage, InputModality } from "../../model/index.js";
import type { VisionAssistant } from "../../model/vision/VisionAssistant.js";

/**
 * Automatic vision enrichment (Phase 4 — the multimodal boundary).
 *
 * When the agent's main model has no vision capability and a vision
 * assistant is configured, images in the request are *described* by the
 * assistant and replaced with their descriptions before the request reaches
 * the model. The model never sees a bare "[Image omitted]" placeholder — it
 * sees what the image contains.
 *
 * Never touches requests for vision-capable models (their images stay
 * intact), never blocks the turn on vision failure (falls back to the
 * standard placeholder + diagnostic), and is bounded (maxImages).
 */

export type VisionEnrichmentOptions = {
  /** Multimodal constraints of the model this request is built for. */
  modelInputModalities?: readonly InputModality[];
  assistant?: VisionAssistant;
  signal?: AbortSignal;
  maxImages?: number;
};

export type VisionEnrichmentResult = Readonly<{
  messages: CanonicalMessage[];
  /** Images successfully described. */
  enriched: number;
  /** Images skipped (cap or failure). */
  skipped: number;
  diagnostics: readonly string[];
}>;

export const DEFAULT_MAX_ENRICHED_IMAGES = 4;

export async function enrichMessagesWithVisionDescriptions(
  messages: CanonicalMessage[],
  options: VisionEnrichmentOptions,
): Promise<VisionEnrichmentResult> {
  const assistant = options.assistant;
  if (!assistant || !assistant.isConfigured()) {
    return { messages, enriched: 0, skipped: 0, diagnostics: [] };
  }
  if (options.modelInputModalities?.includes("image")) {
    // Vision-capable model: images stay untouched.
    return { messages, enriched: 0, skipped: 0, diagnostics: [] };
  }

  const maxImages = options.maxImages ?? DEFAULT_MAX_ENRICHED_IMAGES;
  let enriched = 0;
  let skipped = 0;
  const diagnostics: string[] = [];
  const out = messages.map((message) => ({ ...message, content: [...message.content] }));

  for (const message of out) {
    for (let i = 0; i < message.content.length; i += 1) {
      const block = message.content[i]!;
      if (block.type === "image") {
        const outcome = await describeOrSkip(block, assistant, options.signal, enriched >= maxImages);
        if (outcome.kind === "described") {
          message.content[i] = { type: "text", text: outcome.text };
          enriched += 1;
        } else {
          skipped += 1;
          if (outcome.diagnostic) diagnostics.push(outcome.diagnostic);
        }
        continue;
      }
      if (block.type === "tool_result") {
        let changed = false;
        const newContent = [];
        for (const sub of block.content) {
          if (sub.type === "image") {
            const outcome = await describeOrSkip(sub, assistant, options.signal, enriched >= maxImages);
            if (outcome.kind === "described") {
              newContent.push({ type: "text" as const, text: outcome.text });
              enriched += 1;
              changed = true;
            } else {
              newContent.push(sub);
              skipped += 1;
              if (outcome.diagnostic) diagnostics.push(outcome.diagnostic);
            }
          } else {
            newContent.push(sub);
          }
        }
        if (changed) {
          (block as { content: typeof block.content }).content = newContent;
        }
      }
    }
  }

  return Object.freeze({
    messages: out,
    enriched,
    skipped,
    diagnostics: Object.freeze(diagnostics),
  });
}

async function describeOrSkip(
  image: { mimeType: string; data: string; bytes?: number },
  assistant: VisionAssistant,
  signal: AbortSignal | undefined,
  overCap: boolean,
): Promise<
  | { kind: "described"; text: string }
  | { kind: "skipped"; diagnostic?: string }
> {
  if (overCap) {
    return {
      kind: "skipped",
      diagnostic: "Vision enrichment skipped an image: per-request cap reached.",
    };
  }
  try {
    const result = await assistant.describeImage({
      image: { mimeType: image.mimeType, data: image.data, bytes: image.bytes },
      signal,
    });
    return {
      kind: "described",
      text: `[Image described by vision assistant (${result.model}): ${result.description}]`,
    };
  } catch (error) {
    return {
      kind: "skipped",
      diagnostic: `Vision enrichment failed for an image: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
