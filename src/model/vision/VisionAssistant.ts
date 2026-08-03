import type { RigoriumVisionConfig } from "../../rigorium/config/types.js";

/**
 * Vision assistant — the Codex read-image pattern, native.
 *
 * When the agent's main model has no vision capability, images are delegated
 * to a separate OpenAI-compatible vision endpoint (GitHub Copilot's model
 * gateway and any OpenAI-compatible service speak the same chat/completions
 * protocol). The description comes back as text and is injected into the
 * agent's context — the agent "sees" through the assistant.
 *
 * Transport is plain fetch (no SDK dependency); tests inject a fetch stub.
 */

export type VisionImageInput = Readonly<{
  /** MIME type, e.g. image/png. */
  mimeType: string;
  /** Base64-encoded image bytes. */
  data: string;
  bytes?: number;
}>;

export type DescribeImageInput = Readonly<{
  image: VisionImageInput;
  /** What the assistant should extract/describe. */
  prompt?: string;
  signal?: AbortSignal;
}>;

export type DescribeImageResult = Readonly<{
  description: string;
  model: string;
  providerBaseUrl: string;
  /** Total tokens when reported by the endpoint. */
  usageTokens?: number;
  latencyMs: number;
}>;

export type VisionAssistant = {
  describeImage(input: DescribeImageInput): Promise<DescribeImageResult>;
  /** Config snapshot (for tool diagnostics). */
  config: RigoriumVisionConfig;
  isConfigured(): boolean;
};

export type VisionAssistantOptions = {
  /** fetch implementation (tests inject a stub). */
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export const DEFAULT_VISION_TIMEOUT_MS = 30_000;
export const DEFAULT_VISION_PROMPT =
  "Describe this image in detail for an AI research assistant that cannot see it. " +
  "Cover: what is shown, layout, text/numbers/axes visible, colors, and any scientific content. " +
  "Be precise and complete — the reader will act on your description alone.";

export function createVisionAssistant(
  config: RigoriumVisionConfig,
  options: VisionAssistantOptions = {},
): VisionAssistant {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = config.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;

  async function describeImage(input: DescribeImageInput): Promise<DescribeImageResult> {
    if (!config.enabled) {
      throw new VisionAssistantError("not_configured", "Vision assistant is disabled in rigorium.yaml (vision.enabled).");
    }
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const startedAt = now().getTime();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Vision assistant timed out after ${timeoutMs}ms.`)), timeoutMs);
    const onOuterAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: input.prompt ?? DEFAULT_VISION_PROMPT },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${input.image.mimeType};base64,${input.image.data}`,
                  },
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new VisionAssistantError(
          "http_error",
          `Vision endpoint returned HTTP ${response.status}: ${body.slice(0, 300)}`,
          response.status,
        );
      }
      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { total_tokens?: number };
      };
      const description = payload.choices?.[0]?.message?.content?.trim();
      if (!description) {
        throw new VisionAssistantError("empty_response", "Vision endpoint returned no content.");
      }
      return Object.freeze({
        description,
        model: config.model,
        providerBaseUrl: baseUrl,
        ...(payload.usage?.total_tokens !== undefined
          ? { usageTokens: payload.usage.total_tokens }
          : {}),
        latencyMs: now().getTime() - startedAt,
      });
    } catch (error) {
      if (error instanceof VisionAssistantError) throw error;
      if (controller.signal.aborted && !input.signal?.aborted) {
        // The internal timeout fired (the outer signal did not abort).
        throw new VisionAssistantError("timeout", `Vision assistant timed out after ${timeoutMs}ms.`);
      }
      if (input.signal?.aborted) {
        throw new VisionAssistantError("network_error", "Vision request was aborted.");
      }
      throw new VisionAssistantError("network_error", `Vision request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  return {
    describeImage,
    config,
    isConfigured: () => config.enabled === true && config.baseUrl.length > 0 && config.apiKey.length > 0 && config.model.length > 0,
  };
}

export class VisionAssistantError extends Error {
  readonly name = "VisionAssistantError";
  readonly code: "not_configured" | "http_error" | "empty_response" | "timeout" | "network_error";
  readonly status?: number;
  constructor(code: VisionAssistantError["code"], message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}
