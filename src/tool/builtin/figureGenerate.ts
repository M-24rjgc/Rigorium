import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ImageGenerator } from "../../model/vision/ImageGenerator.js";
import { ImageGeneratorError } from "../../model/vision/ImageGenerator.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult, RigoriumToolInputSchema } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";

/**
 * figure_generate — text-to-image figure creation (architecture diagrams,
 * concept illustrations, schematic figures) via the configured image model.
 *
 * NOTE (config-surface only): this tool requires a `figureGen:` block in
 * rigorium.yaml (baseUrl/apiKey/model) and is **not tested against a live
 * endpoint yet** — the user supplies the Key and validates it. Data figures
 * should still be code-drawn (matplotlib etc.); this tool is for figures
 * that are genuinely better generated (architecture, concepts).
 */

export type FigureType = "architecture" | "data" | "concept" | "other";

export type FigureGenerateToolInput = Readonly<{
  figureType: FigureType;
  /** What the figure must convey (2-4 sentences). */
  description: string;
  /** Optional style guidance (palette, fonts, layout, venue conventions). */
  styleRefs?: string;
  /** Output path relative to the project (PNG). */
  outputPath: string;
  size?: "1024x1024" | "1536x1024" | "1024x1536";
  quality?: "low" | "medium" | "high";
}>;

export type FigureGenerateToolResult = Readonly<{
  outputPath: string;
  figureType: FigureType;
  bytes: number;
  model: string;
  latencyMs: number;
  revisedPrompt?: string;
}>;

export type CreateFigureGenerateToolOptions = Readonly<{
  maxResultBytes?: number;
  /** Image generator (wired by the gateway from rigorium.yaml `figureGen:`). */
  generator: ImageGenerator;
  /** Injectable file writer (tests). */
  writeOutput?: (absolutePath: string, data: Buffer) => Promise<void>;
}>;

const FIGURE_TYPE_PROMPTS: Record<FigureType, string> = {
  architecture:
    "Draw a clean architecture diagram for a machine-learning / research system. " +
    "Use labeled boxes, arrows between components, and a white or very light background. " +
    "Text must be large and legible. No photorealism, no decorative elements.",
  data:
    "This should look like a publication-quality data figure placeholder: clean axes, " +
    "legible labels, muted colors. (Prefer code-drawn figures when real data exists.)",
  concept:
    "Draw a conceptual illustration that communicates the idea clearly. " +
    "Clean, minimal, scientific style. No photorealism.",
  other: "Draw a clean, publication-quality figure. No photorealism.",
};

export function createFigureGenerateTool(
  options: CreateFigureGenerateToolOptions,
): RigoriumToolDefinition<FigureGenerateToolInput, FigureGenerateToolResult> {
  return {
    name: "figure_generate",
    title: "Generate a Figure with the Image Model",
    description: `Generate a figure (architecture diagram, concept illustration, schematic) with the configured image-generation model (figureGen: in rigorium.yaml — baseUrl, apiKey, model; e.g. gpt-image-2). Provide the figure type, a precise description of what it must convey, optional style references, and an output path (PNG). The image is saved to the project and the path returned. NOTE: the endpoint is config-surface only — the user must provide a working API Key and verify it; this tool is not yet validated against a live endpoint. Prefer code-drawn figures for real data.`,
    kind: "custom",
    inputSchema: figureGenerateInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 1_000_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isOpenWorld: () => false,
    validateInput: async (input) => validateInput(input),
    execute: async (input, context) => {
      const prompt = buildPrompt(input);
      let generated;
      try {
        generated = await options.generator.generateImage({
          prompt,
          ...(input.size ? { size: input.size } : {}),
          ...(input.quality ? { quality: input.quality } : {}),
        });
      } catch (error) {
        if (error instanceof ImageGeneratorError) {
          throw new RigoriumToolRuntimeError("tool_execution_failed", figureGenHint(error), {
            code: error.code,
            status: error.status,
          });
        }
        throw error;
      }
      const absolutePath = resolve(context.cwd, input.outputPath);
      const writer = options.writeOutput ?? ((path, data) => writeFile(path, data));
      await mkdir(dirname(absolutePath), { recursive: true });
      await writer(absolutePath, Buffer.from(generated.imageData, "base64"));
      const result: FigureGenerateToolResult = Object.freeze({
        outputPath: input.outputPath,
        figureType: input.figureType,
        bytes: Math.floor((generated.imageData.length * 3) / 4),
        model: generated.model,
        latencyMs: generated.latencyMs,
        ...(generated.revisedPrompt ? { revisedPrompt: generated.revisedPrompt } : {}),
      });
      return { content: [{ type: "text", text: renderSummary(result) }], data: result };
    },
  };
}

function buildPrompt(input: FigureGenerateToolInput): string {
  const parts = [FIGURE_TYPE_PROMPTS[input.figureType], input.description];
  if (input.styleRefs) {
    parts.push(`Style references: ${input.styleRefs}`);
  }
  return parts.join("\n\n");
}

function figureGenHint(error: ImageGeneratorError): string {
  switch (error.code) {
    case "not_configured":
      return "Figure generation is not configured. Add a `figureGen:` block to rigorium.yaml (baseUrl, apiKey, model — e.g. an OpenAI-compatible image endpoint with gpt-image-2), then retry. This feature is config-surface only; provide a working Key to validate it.";
    case "http_error":
      return `Image endpoint rejected the request (HTTP ${error.status ?? "?"}). Check figureGen.baseUrl/apiKey/model.`;
    case "timeout":
      return "Figure generation timed out. Increase figureGen.timeoutMs.";
    default:
      return `Figure generation failed: ${error.message}`;
  }
}

async function validateInput(input: FigureGenerateToolInput): Promise<RigoriumToolValidationResult> {
  if (!input || typeof input.description !== "string" || input.description.trim().length < 10) {
    return { ok: false, issues: [issue("description is required (min 10 chars)")] };
  }
  if (typeof input.outputPath !== "string" || input.outputPath.trim() === "") {
    return { ok: false, issues: [issue("outputPath is required")] };
  }
  if (!["architecture", "data", "concept", "other"].includes(input.figureType)) {
    return { ok: false, issues: [issue("figureType must be architecture, data, concept, or other")] };
  }
  if (input.size !== undefined && !["1024x1024", "1536x1024", "1024x1536"].includes(input.size)) {
    return { ok: false, issues: [issue("size must be one of 1024x1024, 1536x1024, 1024x1536")] };
  }
  return { ok: true, input };
}

function issue(message: string): RigoriumToolValidationIssue {
  return { path: "", code: "invalid_type", message };
}

function figureGenerateInputSchema(): RigoriumToolInputSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["figureType", "description", "outputPath"],
    properties: {
      figureType: { type: "string", enum: ["architecture", "data", "concept", "other"] },
      description: { type: "string" },
      styleRefs: { type: "string" },
      outputPath: { type: "string" },
      size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536"] },
      quality: { type: "string", enum: ["low", "medium", "high"] },
    },
  };
}

function renderSummary(result: FigureGenerateToolResult): string {
  return `Generated ${result.figureType} figure (${result.bytes} bytes) via ${result.model} → ${result.outputPath} (${result.latencyMs}ms)${result.revisedPrompt ? `\nRevised prompt: ${result.revisedPrompt}` : ""}`;
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
