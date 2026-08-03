/**
 * Figure generation — text-to-image for architecture/concept figures.
 *
 * Config surface only by design: the endpoint is OpenAI-compatible
 * (`images/generations`), and the actual Key/endpoint is supplied by the
 * user and tested later (see README). The generator itself is a thin,
 * injectable client so the tool and tests never touch the network.
 */

export type FigureGenConfig = {
  /** Master switch; when off, figure_generate reports not-configured. */
  enabled?: boolean;
  /** OpenAI-compatible base URL (e.g. https://api.openai.com/v1). */
  baseUrl: string;
  apiKey: string;
  /** Image model id. gpt-image-1 / gpt-image-2 — verify availability with the endpoint. */
  model: string;
  timeoutMs?: number;
};

export type GenerateImageInput = Readonly<{
  prompt: string;
  size?: "1024x1024" | "1536x1024" | "1024x1536";
  quality?: "low" | "medium" | "high";
  signal?: AbortSignal;
}>;

export type GenerateImageResult = Readonly<{
  /** Base64-encoded image bytes (b64_json). */
  imageData: string;
  mimeType: string;
  model: string;
  providerBaseUrl: string;
  latencyMs: number;
  revisedPrompt?: string;
}>;

export type ImageGenerator = {
  generateImage(input: GenerateImageInput): Promise<GenerateImageResult>;
  config: FigureGenConfig;
  isConfigured(): boolean;
};

export type ImageGeneratorOptions = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export const DEFAULT_FIGURE_GEN_TIMEOUT_MS = 60_000;

export function createImageGenerator(
  config: FigureGenConfig,
  options: ImageGeneratorOptions = {},
): ImageGenerator {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = config.timeoutMs ?? DEFAULT_FIGURE_GEN_TIMEOUT_MS;

  async function generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    if (!config.enabled) {
      throw new ImageGeneratorError("not_configured", "Figure generation is disabled (figureGen.enabled).");
    }
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const startedAt = now().getTime();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Figure generation timed out after ${timeoutMs}ms.`)), timeoutMs);
    const onOuterAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const response = await fetchImpl(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          prompt: input.prompt,
          n: 1,
          ...(input.size ? { size: input.size } : {}),
          ...(input.quality ? { quality: input.quality } : {}),
          response_format: "b64_json",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new ImageGeneratorError(
          "http_error",
          `Image endpoint returned HTTP ${response.status}: ${body.slice(0, 300)}`,
          response.status,
        );
      }
      const payload = (await response.json()) as {
        data?: { b64_json?: string; revised_prompt?: string }[];
      };
      const imageData = payload.data?.[0]?.b64_json;
      if (!imageData) {
        throw new ImageGeneratorError("empty_response", "Image endpoint returned no b64 image data.");
      }
      return Object.freeze({
        imageData,
        mimeType: "image/png",
        model: config.model,
        providerBaseUrl: baseUrl,
        latencyMs: now().getTime() - startedAt,
        ...(payload.data?.[0]?.revised_prompt
          ? { revisedPrompt: payload.data[0].revised_prompt }
          : {}),
      });
    } catch (error) {
      if (error instanceof ImageGeneratorError) throw error;
      if (controller.signal.aborted && !input.signal?.aborted) {
        throw new ImageGeneratorError("timeout", `Figure generation timed out after ${timeoutMs}ms.`);
      }
      if (input.signal?.aborted) {
        throw new ImageGeneratorError("network_error", "Figure generation was aborted.");
      }
      throw new ImageGeneratorError(
        "network_error",
        `Figure generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  return {
    generateImage,
    config,
    isConfigured: () =>
      config.enabled === true &&
      config.baseUrl.length > 0 &&
      config.apiKey.length > 0 &&
      config.model.length > 0,
  };
}

export class ImageGeneratorError extends Error {
  readonly name = "ImageGeneratorError";
  readonly code: "not_configured" | "http_error" | "empty_response" | "timeout" | "network_error";
  readonly status?: number;
  constructor(code: ImageGeneratorError["code"], message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}
