import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createVisionAssistant,
  VisionAssistantError,
} from "../../src/model/vision/VisionAssistant.js";
import { createDescribeImageTool } from "../../src/tool/builtin/describeImage.js";
import type { RigoriumVisionConfig } from "../../src/rigorium/config/types.js";

const CONFIG: RigoriumVisionConfig = {
  enabled: true,
  baseUrl: "https://vision.example.com/v1",
  apiKey: "test-key",
  model: "gpt-4o-mini",
  timeoutMs: 5_000,
};

function stubFetch(handler: (url: string, init: RequestInit) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown>; text?: () => Promise<string> }>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await handler(String(url), init ?? {});
    return {
      ok: response.ok,
      status: response.status ?? 200,
      json: response.json,
      text: async () => "",
    } as Response;
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// VisionAssistant
// ---------------------------------------------------------------------------

test("VisionAssistant: sends OpenAI-compatible chat request and returns the description", async () => {
  let captured: { url: string; body: unknown; auth: string | null } | undefined;
  const fetchImpl = stubFetch(async (url, init) => {
    captured = {
      url,
      body: JSON.parse(String(init.body)),
      auth: (init.headers as Record<string, string>)?.Authorization ?? null,
    };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "A bar chart showing accuracy vs epochs." } }],
        usage: { total_tokens: 42 },
      }),
    };
  });
  const assistant = createVisionAssistant(CONFIG, { fetchImpl, now: () => new Date(1_000) });
  const result = await assistant.describeImage({
    image: { mimeType: "image/png", data: "aGVsbG8=", bytes: 5 },
    prompt: "What does this figure show?",
  });
  assert.equal(result.description, "A bar chart showing accuracy vs epochs.");
  assert.equal(result.model, "gpt-4o-mini");
  assert.equal(result.usageTokens, 42);
  assert.equal(captured?.url, "https://vision.example.com/v1/chat/completions");
  assert.equal(captured?.auth, "Bearer test-key");
  const content = (captured!.body as { messages: { content: unknown[] }[] }).messages[0]!.content;
  assert.deepEqual(content[0], { type: "text", text: "What does this figure show?" });
  assert.equal((content[1] as { type: string; image_url: { url: string } }).image_url.url, "data:image/png;base64,aGVsbG8=");
});

test("VisionAssistant: disabled config rejects immediately", async () => {
  const assistant = createVisionAssistant({ ...CONFIG, enabled: false }, { fetchImpl: stubFetch(async () => ({ ok: true, json: async () => ({}) })) });
  await assert.rejects(
    assistant.describeImage({ image: { mimeType: "image/png", data: "x" } }),
    (error: unknown) => error instanceof VisionAssistantError && error.code === "not_configured",
  );
});

test("VisionAssistant: HTTP errors and timeouts are normalized", async () => {
  const httpFail = createVisionAssistant(CONFIG, {
    fetchImpl: stubFetch(async () => ({ ok: false, status: 401, json: async () => ({ error: "bad key" }) })),
  });
  await assert.rejects(
    httpFail.describeImage({ image: { mimeType: "image/png", data: "x" } }),
    (error: unknown) => error instanceof VisionAssistantError && error.code === "http_error" && error.status === 401,
  );

  const hanging = createVisionAssistant(
    { ...CONFIG, timeoutMs: 10 },
    {
      // A fetch that never resolves on its own but honors the abort signal —
      // the assistant's timeout must abort it.
      fetchImpl: ((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        })) as typeof fetch,
    },
  );
  await assert.rejects(
    hanging.describeImage({ image: { mimeType: "image/png", data: "x" } }),
    (error: unknown) => error instanceof VisionAssistantError && error.code === "timeout",
  );
});

// ---------------------------------------------------------------------------
// describe_image tool
// ---------------------------------------------------------------------------

test("describe_image: reads a local image and returns the description", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "rigorium-vision-"));
  try {
    writeFileSync(join(projectRoot, "fig.png"), Buffer.from("png-bytes"));
    const assistant = createVisionAssistant(CONFIG, {
      fetchImpl: stubFetch(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "Figure 1: method overview diagram." } }] }),
      })),
    });
    const tool = createDescribeImageTool({ assistant });
    const result = (await tool.execute(
      { imagePath: "fig.png", prompt: "Describe the architecture." },
      { cwd: projectRoot, sessionId: "s", turnId: "t", abortSignal: undefined, now: () => new Date() } as never,
    )) as unknown as { data: { description: string; bytes: number; mimeType: string } };
    assert.equal(result.data.description, "Figure 1: method overview diagram.");
    assert.equal(result.data.bytes, 9);
    assert.equal(result.data.mimeType, "image/png");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("describe_image: not-configured assistant yields an actionable error", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "rigorium-vision-"));
  try {
    writeFileSync(join(projectRoot, "fig.png"), Buffer.from("png"));
    const assistant = createVisionAssistant({ ...CONFIG, enabled: false }, {
      fetchImpl: stubFetch(async () => ({ ok: true, json: async () => ({}) })),
    });
    const tool = createDescribeImageTool({ assistant });
    await assert.rejects(
      tool.execute(
        { imagePath: "fig.png" },
        { cwd: projectRoot, sessionId: "s", turnId: "t", abortSignal: undefined, now: () => new Date() } as never,
      ),
      /vision:.*rigorium\.yaml/s,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("describe_image: missing file reports a file error", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "rigorium-vision-"));
  try {
    const assistant = createVisionAssistant(CONFIG, {
      fetchImpl: stubFetch(async () => ({ ok: true, json: async () => ({}) })),
    });
    const tool = createDescribeImageTool({ assistant });
    await assert.rejects(
      tool.execute(
        { imagePath: "nope.png" },
        { cwd: projectRoot, sessionId: "s", turnId: "t", abortSignal: undefined, now: () => new Date() } as never,
      ),
      /Could not read image file/,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
