import assert from "node:assert/strict";
import test from "node:test";

import {
  DeepSeekNativeSearchError,
  searchDeepSeekNative,
} from "../../src/deepseek-native-search/index.js";
import { resolveDeepSeekNativeSearchConfig } from "../../src/rigorium/config/resolveDeepSeekNativeSearch.js";
import { parseToolsConfig } from "../../src/rigorium/config/parseToolsConfig.js";
import type { RigoriumConfigDiagnostic } from "../../src/rigorium/config/types.js";
import { createDeepSeekNativeSearchTool } from "../../src/tool/builtin/deepseekNativeSearch.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("DeepSeek native search sends the Anthropic server-tool contract and bounds evidence", async () => {
  let request: RequestInit | undefined;
  const result = await searchDeepSeekNative({
    query: "current release",
    apiKey: "test-key",
    maxAnswerChars: 256,
    maxCitationSnippetChars: 80,
    maxCitations: 1,
    fetchImpl: async (_url, init) => {
      request = init;
      return jsonResponse({
        content: [
          { type: "text", text: "A".repeat(300) },
          {
            type: "web_search_tool_result",
            content: [
              { title: "Example", url: "https://example.test/a", snippet: "1".repeat(100) },
              { title: "Duplicate", url: "https://example.test/a", snippet: "ignored" },
            ],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 34 },
      });
    },
  });

  const headers = new Headers(request?.headers);
  const body = JSON.parse(String(request?.body));
  assert.equal(headers.get("x-api-key"), "test-key");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.equal(request?.redirect, "error");
  assert.equal(body.tools[0].type, "web_search_20260209");
  assert.equal(body.tools[0].max_uses, 5);
  assert.equal(body.messages[0].role, "user");
  assert.equal(result.answer.length, 256);
  assert.equal(result.answer.endsWith("..."), true);
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0]?.snippet?.length, 80);
  assert.equal(result.citations[0]?.snippet?.endsWith("..."), true);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 34 });
});

test("DeepSeek native search falls back only for an unsupported server-tool variant", async () => {
  const variants: string[] = [];
  const result = await searchDeepSeekNative({
    query: "fallback",
    apiKey: "test-key",
    toolVariants: ["web_search_20260209", "web_search_20250305"],
    fetchImpl: async (_url, init) => {
      variants.push(JSON.parse(String(init?.body)).tools[0].type);
      return variants.length === 1
        ? jsonResponse({ error: { message: "unknown variant" } }, 400)
        : jsonResponse({ content: [{ type: "text", text: "ok" }] });
    },
  });

  assert.deepEqual(variants, ["web_search_20260209", "web_search_20250305"]);
  assert.equal(result.answer, "ok");
  assert.deepEqual(result.diagnostics.attemptedToolVariants, variants);
});

test("automatic credentials never authorize a custom native-search endpoint", async () => {
  const resolved = resolveDeepSeekNativeSearchConfig({
    nativeSearch: { endpoint: "https://untrusted.example/messages" },
    modelProviders: {
      deepseek: { url: "https://api.deepseek.com/v1", apiKey: "provider-key" },
    },
    environment: { DEEPSEEK_NATIVE_SEARCH_API_KEY: "environment-key" },
  });
  assert.equal(resolved.settings.apiKey, undefined);

  let calls = 0;
  await assert.rejects(
    searchDeepSeekNative({
      query: "must not send a key",
      endpoint: "https://untrusted.example/messages",
      apiKey: "inherited-provider-key",
      credentialSource: "automatic",
      environment: { DEEPSEEK_API_KEY: "environment-key" },
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    }),
    (error: unknown) => error instanceof DeepSeekNativeSearchError && error.code === "setup_required",
  );
  assert.equal(calls, 0);
});

test("tools config parses native search independently from web_search", () => {
  const diagnostics: RigoriumConfigDiagnostic[] = [];
  const config = parseToolsConfig({
    deepseekNativeSearch: {
      apiKey: "dedicated-key",
      endpoint: "https://api.deepseek.com/anthropic/v1/messages",
      model: "deepseek-v4-flash",
    },
  }, diagnostics);

  assert.deepEqual(config?.deepseekNativeSearch, {
    apiKey: "dedicated-key",
    endpoint: "https://api.deepseek.com/anthropic/v1/messages",
    model: "deepseek-v4-flash",
  });
  assert.equal(config?.webSearch, undefined);
  assert.equal(diagnostics.length, 0);
});

test("DeepSeek native-search tool keeps structured evidence out of model-visible content", async () => {
  const tool = createDeepSeekNativeSearchTool({
    apiKey: "test-key",
    fetchImpl: async () => jsonResponse({
      content: [
        { type: "text", text: "A concise answer" },
        { type: "web_search_tool_result", content: [{ url: "https://example.test", title: "Example" }] },
      ],
    }),
  });
  const output = await tool.execute(
    { query: "test" },
    { cwd: "/", projectRoot: "/", env: {}, abortSignal: undefined } as never,
  );

  assert.equal(output.content.length, 1);
  assert.equal(output.content[0]?.type, "text");
  assert.equal(output.data?.citations.length, 1);
  assert.equal(output.metadata?.citationCount, 1);
});
