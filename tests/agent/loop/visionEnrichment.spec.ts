import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalMessage } from "../../../src/model/index.js";
import type { VisionAssistant } from "../../../src/model/vision/VisionAssistant.js";
import { enrichMessagesWithVisionDescriptions } from "../../../src/agent/loop/visionEnrichment.js";

function imageMessage(role: "user" | "assistant", label: string): CanonicalMessage {
  return {
    role,
    content: [
      { type: "text", text: label },
      { type: "image", source: "base64", mimeType: "image/png", data: "aGVsbG8=", bytes: 5 },
    ],
  } as CanonicalMessage;
}

function imageInToolResult(label: string): CanonicalMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: label },
      {
        type: "tool_result",
        toolCallId: "t1",
        content: [
          { type: "text", text: "tool text" },
          { type: "image", source: "base64", mimeType: "image/png", data: "dG9vbA==", bytes: 4 },
        ],
      },
    ],
  } as CanonicalMessage;
}

function fakeAssistant(description: string, fail = false): VisionAssistant {
  return {
    isConfigured: () => true,
    config: { enabled: true, baseUrl: "https://x/v1", apiKey: "k", model: "m" },
    describeImage: async () => {
      if (fail) throw new Error("vision down");
      return { description, model: "m", providerBaseUrl: "https://x/v1", latencyMs: 1 };
    },
  };
}

test("visionEnrichment: vision-capable models keep images untouched", async () => {
  const messages = [imageMessage("user", "look")];
  const result = await enrichMessagesWithVisionDescriptions(messages, {
    modelInputModalities: ["text", "image"],
    assistant: fakeAssistant("a chart"),
  });
  assert.equal(result.enriched, 0);
  assert.equal(result.messages[0]!.content[1]!.type, "image");
});

test("visionEnrichment: non-vision models get descriptions replacing images", async () => {
  const messages = [imageMessage("user", "look")];
  const result = await enrichMessagesWithVisionDescriptions(messages, {
    modelInputModalities: ["text"],
    assistant: fakeAssistant("a bar chart of accuracy over epochs"),
  });
  assert.equal(result.enriched, 1);
  const block = result.messages[0]!.content[1]!;
  assert.equal(block.type, "text");
  assert.match((block as { text: string }).text, /bar chart of accuracy/);
  assert.match((block as { text: string }).text, /\[Image described by vision assistant/);
});

test("visionEnrichment: tool-result images are described too", async () => {
  const messages = [imageInToolResult("results")];
  const result = await enrichMessagesWithVisionDescriptions(messages, {
    modelInputModalities: ["text"],
    assistant: fakeAssistant("a screenshot of the dashboard"),
  });
  assert.equal(result.enriched, 1);
  const toolResult = result.messages[0]!.content[1]!;
  assert.equal(toolResult.type, "tool_result");
  const subs = (toolResult as { content: { type: string; text?: string }[] }).content;
  assert.equal(subs[0]!.type, "text");
  assert.equal(subs[1]!.type, "text");
  assert.match(subs[1]!.text ?? "", /screenshot of the dashboard/);
});

test("visionEnrichment: per-request cap skips excess images with diagnostics", async () => {
  const messages = [imageMessage("user", "one"), imageMessage("user", "two"), imageMessage("user", "three")];
  const result = await enrichMessagesWithVisionDescriptions(messages, {
    modelInputModalities: ["text"],
    assistant: fakeAssistant("described"),
    maxImages: 2,
  });
  assert.equal(result.enriched, 2);
  assert.equal(result.skipped, 1);
  assert.ok(result.diagnostics.some((d) => /cap reached/.test(d)));
});

test("visionEnrichment: vision failures fall back to placeholders without blocking", async () => {
  const messages = [imageMessage("user", "look")];
  const result = await enrichMessagesWithVisionDescriptions(messages, {
    modelInputModalities: ["text"],
    assistant: fakeAssistant("n/a", true),
  });
  assert.equal(result.enriched, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.messages[0]!.content[1]!.type, "image", "failed image stays in place");
  assert.ok(result.diagnostics.some((d) => /vision down/.test(d)));
});

test("visionEnrichment: no assistant or unconfigured is a no-op", async () => {
  const messages = [imageMessage("user", "look")];
  const without = await enrichMessagesWithVisionDescriptions(messages, { modelInputModalities: ["text"] });
  assert.equal(without.enriched, 0);
  assert.equal(without.messages[0]!.content[1]!.type, "image");
  const unconfigured = await enrichMessagesWithVisionDescriptions(messages, {
    modelInputModalities: ["text"],
    assistant: { ...fakeAssistant("x"), isConfigured: () => false },
  });
  assert.equal(unconfigured.enriched, 0);
});
