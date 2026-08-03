import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadRigoriumConfig } from "../../src/rigorium/config/loadRigoriumConfig.js";
import { redactConfig } from "../../src/rigorium/config/redact.js";

const BASE_YAML = `
schemaVersion: 1
agent:
  model: openai/gpt-4o-mini
model:
  providers:
    openai:
      baseUrl: https://api.openai.com/v1
      apiKey: test-key-openai
      models:
        gpt-4o-mini:
          contextWindow: 128000
          maxOutputTokens: 16384
`;

function load(yamlExtra: string): ReturnType<typeof loadRigoriumConfig> {
  const home = mkdtempSync(join(tmpdir(), "rigorium-config-"));
  try {
    writeFileSync(join(home, "rigorium.yaml"), BASE_YAML + yamlExtra, "utf8");
    return loadRigoriumConfig({ env: { ...process.env, RIGORIUM_HOME: home } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("vision section is parsed into snapshot.config.vision", () => {
  const snap = load(`
vision:
  enabled: true
  baseUrl: https://models.github.ai/v1
  apiKey: sk-test-vision
  model: gpt-4o
  timeoutMs: 30000
`);
  assert.deepEqual(snap.config.vision, {
    enabled: true,
    baseUrl: "https://models.github.ai/v1",
    apiKey: "sk-test-vision",
    model: "gpt-4o",
    timeoutMs: 30000,
  });
  // No unknown-field warnings for the vision/figureGen keys.
  assert.equal(snap.diagnostics.some((d) => d.code === "CONFIG_UNKNOWN_FIELD"), false);
});

test("figureGen section is parsed into snapshot.config.figureGen", () => {
  const snap = load(`
figureGen:
  baseUrl: https://api.openai.com/v1
  apiKey: sk-test-fig
  model: gpt-image-2
`);
  assert.deepEqual(snap.config.figureGen, {
    enabled: true,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test-fig",
    model: "gpt-image-2",
  });
});

test("incomplete vision/figureGen sections warn and are dropped (never fatal)", () => {
  const snap = load(`
vision:
  enabled: true
  baseUrl: https://models.github.ai/v1
figureGen:
  apiKey: sk-only
`);
  assert.equal(snap.config.vision, undefined);
  assert.equal(snap.config.figureGen, undefined);
  const codes = snap.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("CONFIG_VISION_INCOMPLETE"));
  assert.ok(codes.includes("CONFIG_FIGURE_GEN_INCOMPLETE"));
  assert.equal(snap.diagnostics.some((d) => d.severity === "fatal"), false);
});

test("vision secrets are redacted from the snapshot content hash path", () => {
  const snap = load(`
vision:
  baseUrl: https://models.github.ai/v1
  apiKey: sk-top-secret-vision
  model: gpt-4o
`);
  const redacted = redactConfig(snap.config) as { vision: { apiKey: string } };
  assert.equal(redacted.vision.apiKey, "<redacted>");
});

test("router.sticky/researchAware/learning sections survive parsing", () => {
  const snap = load(`
router:
  researchAware:
    enabled: true
    tierUpgrade: true
  learning:
    enabled: true
    minObservations: 3
    minMargin: 0.1
  sticky:
    enabled: true
    ttlMs: 60000
    maxQualityFailures: 4
`);
  assert.equal(snap.config.router!.researchAware?.enabled, true);
  assert.equal(snap.config.router!.learning?.minObservations, 3);
  assert.equal(snap.config.router!.learning?.minMargin, 0.1);
  assert.equal(snap.config.router!.sticky?.ttlMs, 60000);
  assert.equal(snap.config.router!.sticky?.maxQualityFailures, 4);
});

test("router sections with invalid values produce fatal diagnostics", () => {
  // Fatal diagnostics abort the load by throwing — the diagnostics ride along.
  let error: unknown;
  try {
    load(`
router:
  learning:
    enabled: true
    minObservations: -1
    minMargin: 5
  sticky:
    ttlMs: "not-a-number"
`);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "fatal router diagnostics must abort the load");
  const codes = (error as { diagnostics?: { code: string }[] }).diagnostics?.map((d) => d.code) ?? [];
  assert.ok(codes.includes("ROUTER_LEARNING_MIN_OBSERVATIONS_INVALID"));
  assert.ok(codes.includes("ROUTER_LEARNING_MIN_MARGIN_INVALID"));
  assert.ok(codes.includes("ROUTER_STICKY_TTL_INVALID"));
});

test("vision/figureGen keys are accepted top-level keys (no unknown-field warning)", () => {
  const snap = load(`
vision:
  baseUrl: https://x/v1
  apiKey: k
  model: m
figureGen:
  baseUrl: https://y/v1
  apiKey: k2
  model: m2
`);
  assert.equal(snap.diagnostics.some((d) => d.code === "CONFIG_UNKNOWN_FIELD" && d.path === "vision"), false);
  assert.equal(snap.diagnostics.some((d) => d.code === "CONFIG_UNKNOWN_FIELD" && d.path === "figureGen"), false);
});
