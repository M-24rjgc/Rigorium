import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { VisionAssistant } from "../../model/vision/VisionAssistant.js";
import { VisionAssistantError } from "../../model/vision/VisionAssistant.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult, RigoriumToolInputSchema } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";

/**
 * describe_image — let the agent "see" through the vision assistant.
 *
 * When the main model lacks vision, images (files, screenshots, figures) are
 * sent to the configured OpenAI-compatible vision endpoint and the resulting
 * description is returned as text. The agent decides when to use it — the
 * tool never forces vision, and the multimodal downgrade path always leaves
 * the original image in place for vision-capable models.
 */

export type DescribeImageToolInput = Readonly<{
  imagePath: string;
  /** What to extract (defaults to a thorough general description). */
  prompt?: string;
}>;

export type DescribeImageToolResult = Readonly<{
  imagePath: string;
  description: string;
  model: string;
  mimeType: string;
  bytes: number;
  usageTokens?: number;
  latencyMs: number;
}>;

export type CreateDescribeImageToolOptions = Readonly<{
  maxResultBytes?: number;
  /** Vision assistant (wired by the gateway from rigorium.yaml `vision:`). */
  assistant: VisionAssistant;
  /** Injectable image loader (tests). */
  loadImage?: (absolutePath: string) => Promise<{ mimeType: string; data: string; bytes: number }>;
}>;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export function createDescribeImageTool(
  options: CreateDescribeImageToolOptions,
): RigoriumToolDefinition<DescribeImageToolInput, DescribeImageToolResult> {
  return {
    name: "describe_image",
    title: "Describe an Image with the Vision Assistant",
    description: `Send an image file to the configured vision assistant (an OpenAI-compatible vision model such as gpt-4o or a GitHub Copilot model) and return its description as text. Use this when the main model has no vision capability and you need to understand a figure, screenshot, diagram, or photo. Provide the image path relative to the project and an optional prompt describing what to extract. The tool reads the file, sends it to the vision endpoint configured under vision: in rigorium.yaml, and returns the model's description.`,
    kind: "custom",
    inputSchema: describeImageInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 1_000_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => false,
    validateInput: async (input) => validateInput(input),
    execute: async (input, context) => {
      const absolutePath = resolve(context.cwd, input.imagePath);
      const loaded = options.loadImage
        ? await options.loadImage(absolutePath)
        : await loadImageFile(absolutePath);
      let result;
      try {
        result = await options.assistant.describeImage({
          image: { mimeType: loaded.mimeType, data: loaded.data, bytes: loaded.bytes },
          ...(input.prompt ? { prompt: input.prompt } : {}),
        });
      } catch (error) {
        if (error instanceof VisionAssistantError) {
          throw new RigoriumToolRuntimeError("tool_execution_failed", visionHint(error), {
            code: error.code,
            status: error.status,
          });
        }
        throw error;
      }
      const output: DescribeImageToolResult = Object.freeze({
        imagePath: input.imagePath,
        description: result.description,
        model: result.model,
        mimeType: loaded.mimeType,
        bytes: loaded.bytes,
        ...(result.usageTokens !== undefined ? { usageTokens: result.usageTokens } : {}),
        latencyMs: result.latencyMs,
      });
      return { content: [{ type: "text", text: output.description }], data: output };
    },
  };
}

async function loadImageFile(absolutePath: string): Promise<{ mimeType: string; data: string; bytes: number }> {
  let buffer: Buffer;
  try {
    buffer = await readFile(absolutePath);
  } catch (error) {
    throw new RigoriumToolRuntimeError(
      "file_not_found",
      `Could not read image file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const extension = absolutePath.slice(absolutePath.lastIndexOf(".")).toLowerCase();
  const mimeType = MIME_BY_EXTENSION[extension] ?? "image/png";
  return { mimeType, data: buffer.toString("base64"), bytes: buffer.byteLength };
}

function visionHint(error: VisionAssistantError): string {
  switch (error.code) {
    case "not_configured":
      return "Vision assistant is not configured. Add a `vision:` block to rigorium.yaml (baseUrl, apiKey, model — e.g. a GitHub Copilot model endpoint or any OpenAI-compatible service), then retry.";
    case "http_error":
      return `Vision endpoint rejected the request (HTTP ${error.status ?? "?"}). Check baseUrl/apiKey/model in the vision: config.`;
    case "timeout":
      return "Vision assistant timed out. Increase vision.timeoutMs or check the endpoint's latency.";
    default:
      return `Vision assistant failed: ${error.message}`;
  }
}

async function validateInput(input: DescribeImageToolInput): Promise<RigoriumToolValidationResult> {
  if (!input || typeof input.imagePath !== "string" || input.imagePath.trim() === "") {
    return { ok: false, issues: [issue("imagePath is required")] };
  }
  if (input.prompt !== undefined && typeof input.prompt !== "string") {
    return { ok: false, issues: [issue("prompt must be a string when provided")] };
  }
  return { ok: true, input };
}

function issue(message: string): RigoriumToolValidationIssue {
  return { path: "", code: "invalid_type", message };
}

function describeImageInputSchema(): RigoriumToolInputSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["imagePath"],
    properties: {
      imagePath: { type: "string" },
      prompt: { type: "string" },
    },
  };
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
