import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createImageGenerator, ImageGeneratorError } from "../../src/model/vision/ImageGenerator.js";
import { createFigureGenerateTool } from "../../src/tool/builtin/figureGenerate.js";
import type { FigureGenConfig } from "../../src/rigorium/config/types.js";

const CONFIG: FigureGenConfig = {
  enabled: true,
  baseUrl: "https://images.example.com/v1",
  apiKey: "test-key",
  model: "gpt-image-2",
  timeoutMs: 5_000,
};

function stubFetch(handler: (url: string, init: RequestInit) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await handler(String(url), init ?? {});
    return { ok: response.ok, status: response.status ?? 200, json: response.json, text: async () => "" } as Response;
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// ImageGenerator
// ---------------------------------------------------------------------------

test("ImageGenerator: sends images/generations request, returns b64 image", async () => {
  let captured: { url: string; body: Record<string, unknown>; auth: string | null } | undefined;
  const generator = createImageGenerator(CONFIG, {
    now: () => new Date(1_000),
    fetchImpl: stubFetch(async (url, init) => {
      captured = {
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        auth: (init.headers as Record<string, string>)?.Authorization ?? null,
      };
      return {
        ok: true,
        json: async () => ({
          data: [{ b64_json: "aW1hZ2UtYnl0ZXM=", revised_prompt: "A cleaner architecture diagram." }],
        }),
      };
    }),
  });
  const result = await generator.generateImage({ prompt: "Draw an architecture diagram", size: "1024x1024" });
  assert.equal(result.imageData, "aW1hZ2UtYnl0ZXM=");
  assert.equal(result.revisedPrompt, "A cleaner architecture diagram.");
  assert.equal(captured?.url, "https://images.example.com/v1/images/generations");
  assert.equal(captured?.auth, "Bearer test-key");
  assert.equal(captured!.body.model, "gpt-image-2");
  assert.equal(captured!.body.response_format, "b64_json");
});

test("ImageGenerator: not-configured rejects with actionable error", async () => {
  const generator = createImageGenerator({ ...CONFIG, enabled: false }, {
    fetchImpl: stubFetch(async () => ({ ok: true, json: async () => ({}) })),
  });
  await assert.rejects(
    generator.generateImage({ prompt: "x" }),
    (error: unknown) => error instanceof ImageGeneratorError && error.code === "not_configured",
  );
});

// ---------------------------------------------------------------------------
// figure_generate tool
// ---------------------------------------------------------------------------

test("figure_generate: generates, writes the PNG, returns the path", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "rigorium-figure-"));
  try {
    const generator = createImageGenerator(CONFIG, {
      now: () => new Date(1_000),
      fetchImpl: stubFetch(async () => ({
        ok: true,
        json: async () => ({ data: [{ b64_json: "aW1hZ2UtYnl0ZXM=" }] }),
      })),
    });
    const tool = createFigureGenerateTool({ generator });
    const result = (await tool.execute(
      {
        figureType: "architecture",
        description: "System overview: data flows from literature sources into the claim graph.",
        styleRefs: "muted palette, serif labels, white background",
        outputPath: "figures/architecture.png",
      },
      { cwd: projectRoot, sessionId: "s", turnId: "t", abortSignal: undefined, now: () => new Date() } as never,
    )) as unknown as { data: { outputPath: string; figureType: string; bytes: number; model: string } };
    assert.equal(result.data.outputPath, "figures/architecture.png");
    assert.equal(result.data.model, "gpt-image-2");
    assert.equal(existsSync(join(projectRoot, "figures", "architecture.png")), true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("figure_generate: not-configured yields a hint mentioning the config block", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "rigorium-figure-"));
  try {
    const generator = createImageGenerator({ ...CONFIG, enabled: false }, {
      fetchImpl: stubFetch(async () => ({ ok: true, json: async () => ({}) })),
    });
    const tool = createFigureGenerateTool({ generator });
    await assert.rejects(
      tool.execute(
        {
          figureType: "concept",
          description: "A conceptual illustration of belief-driven research.",
          outputPath: "figures/concept.png",
        },
        { cwd: projectRoot, sessionId: "s", turnId: "t", abortSignal: undefined, now: () => new Date() } as never,
      ),
      /figureGen:/,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("figure_generate: short descriptions are rejected by validation", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "rigorium-figure-"));
  try {
    const generator = createImageGenerator(CONFIG, {
      fetchImpl: stubFetch(async () => ({ ok: true, json: async () => ({}) })),
    });
    const tool = createFigureGenerateTool({ generator });
    const validation = await tool.validateInput!(
      {
        figureType: "data",
        description: "short",
        outputPath: "figures/x.png",
      },
      { cwd: projectRoot, sessionId: "s", turnId: "t", abortSignal: undefined, now: () => new Date() } as never,
    );
    assert.equal(validation.ok, false);
    const issues = validation.ok ? [] : validation.issues;
    assert.match(issues[0]!.message, /description is required/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
