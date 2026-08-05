#!/usr/bin/env node
/**
 * End-to-end routing comparison harness.
 *
 * Compares the tokenSaver routing paths against a LIVE OpenAI-compatible
 * endpoint over the real HTTP protocol:
 *   - judge-only path (every request classified by the judge LLM)
 *   - heuristic+judge path (zero-cost pre-filter over the judge)
 *
 * Metrics per path: judge calls, tier-decision latency (p50/p95), and
 * decision agreement between paths (the judge's answer vs the heuristic's
 * would-be answer on intercepted requests).
 *
 * Modes:
 *   REAL endpoint — set RIGORIUM_E2E_BASE_URL / RIGORIUM_E2E_API_KEY /
 *                   RIGORIUM_E2E_MODEL (or OPENAI_API_KEY + OPENAI_BASE_URL)
 *   MOCK mode     — no key: a built-in OpenAI-compatible mock server
 *                   validates the harness end to end (protocol, parsing,
 *                   metrics) so the real run is one env-var away.
 *
 * Usage:
 *   node scripts/benchmark-router-e2e.mjs                 # mock mode
 *   node scripts/benchmark-router-e2e.mjs --samples 40    # real or mock
 */
import { createServer } from "node:http";

const SAMPLES_DEFAULT = 20;

const SAMPLE_MESSAGES = [
  "hello",
  "thanks!",
  "what is a claim graph?",
  "define uncertainty",
  "hi, quick question",
  "explain briefly what EIG means",
  "debug this function",
  "implement the feature with error handling",
  "design the architecture for the distributed system",
  "evaluate and compare these two algorithms",
  "refactor the python module and add tests",
  "write code for the experiment runner",
  "analyze the experiment results statistically",
  "prove the convergence of the algorithm",
  "review the manuscript section by section",
  "run the experiment with the new baseline",
  "update the literature review",
  "what is the difference between these metrics",
  "configure the kubernetes deployment",
  "optimize the sql query for the database",
];

/** Deterministic mock judge: tier by message markers (protocol-compatible). */
function mockJudgeTier(text) {
  const t = text.toLowerCase();
  // A reasonable judge agrees with the simple-indicator heuristic on
  // greetings / simple questions (harness agreement metric then validates
  // both the interception and the agreement bookkeeping).
  if (/\b(hello|hi|hey|thanks|thank you|what is|define|explain briefly|who are you)\b/.test(t)) return "simple";
  if (/\b(debug|implement|refactor|write code|configure|optimize|sql)\b/.test(t)) return "complex";
  if (/\b(design|architecture|distributed|evaluate|compare|prove|analyze|review|run the experiment)\b/.test(t)) return "reasoning";
  if (/\b(difference|what's)\b/.test(t)) return "medium";
  return "simple";
}

function createMockServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url === "/v1/chat/completions") {
          const payload = JSON.parse(body);
          const userText = payload.messages
            .filter((m) => m.role === "user")
            .map((m) => (typeof m.content === "string" ? m.content : ""))
            .join(" ");
          const tier = mockJudgeTier(userText);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "mock-1",
            object: "chat.completion",
            model: payload.model ?? "mock",
            choices: [{ index: 0, message: { role: "assistant", content: `<tier>${tier}</tier>` }, finish_reason: "stop" }],
            usage: { prompt_tokens: userText.length / 4, completion_tokens: 2, total_tokens: userText.length / 4 + 2 },
          }));
        } else {
          res.writeHead(404);
          res.end("{}");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/** One judge call over the OpenAI-compatible protocol. */
async function judgeTier(baseUrl, apiKey, model, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: message }],
        max_tokens: 32,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    const match = content.match(/<tier>([^<]+)<\/tier>/);
    return { tier: match?.[1]?.toLowerCase() ?? "unparseable", content };
  } finally {
    clearTimeout(timer);
  }
}

function pct(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

/** Try the user's rigorium.yaml providers (first with url + apiKey). */
async function endpointFromConfig() {
  try {
    const { loadRigoriumConfig } = await import("../dist/src/rigorium/config/loadRigoriumConfig.js");
    const snapshot = loadRigoriumConfig({ projectRoot: process.cwd() });
    const providers = snapshot.config.model?.providers ?? {};
    for (const [id, provider] of Object.entries(providers)) {
      if (provider?.url && provider?.apiKey) {
        // Skip placeholder endpoints (config templates, e.g. .invalid hosts).
        if (/placeholder\.invalid|\.invalid/i.test(provider.url)) continue;
        const firstModel = Object.keys(provider.models ?? {})[0];
        return { baseUrl: provider.url, apiKey: provider.apiKey, model: firstModel, id };
      }
    }
  } catch {
    // no config / parse failure → mock mode
  }
  return null;
}

async function main() {
  const samplesArg = process.argv.indexOf("--samples");
  const sampleCount = samplesArg >= 0 ? Number(process.argv[samplesArg + 1] ?? SAMPLES_DEFAULT) : SAMPLES_DEFAULT;
  const messages = SAMPLE_MESSAGES.slice(0, Math.max(1, Math.min(sampleCount, SAMPLE_MESSAGES.length)));

  let baseUrl = process.env.RIGORIUM_E2E_BASE_URL ?? process.env.OPENAI_BASE_URL;
  let apiKey = process.env.RIGORIUM_E2E_API_KEY ?? process.env.OPENAI_API_KEY;
  let model = process.env.RIGORIUM_E2E_MODEL ?? process.env.OPENAI_MODEL;
  let mockServer = null;
  let mode = "mock";
  let configSource = "env";

  if (!baseUrl || !apiKey) {
    const fromConfig = await endpointFromConfig();
    if (fromConfig) {
      baseUrl = fromConfig.baseUrl;
      apiKey = fromConfig.apiKey;
      model = fromConfig.model;
      mode = "real";
      configSource = `rigorium.yaml provider "${fromConfig.id}"`;
    } else {
      mockServer = await createMockServer();
      const address = mockServer.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      apiKey = "mock-key";
      model = "mock-judge";
    }
  } else {
    mode = "real";
    model = model ?? "gpt-4o-mini";
  }

  const lines = [`# End-to-End Routing Comparison (mode: ${mode})`, ""];
  lines.push(`Samples: ${messages.length} · endpoint: ${mode === "mock" ? "built-in mock (protocol-validated)" : `${baseUrl} (${configSource})`}`);
  lines.push("");

  const latencies = { judge: [], heuristic: [] };
  let judgeCalls = 0;
  let heuristicIntercepted = 0;
  let agreement = 0;
  let agreementTotal = 0;

  for (const message of messages) {
    // Path 2 (heuristic+judge): intercept obvious-simple, else judge.
    const start = performance.now();
    const { classifyHeuristicSimple } = await import("../dist/src/router/tokenSaver/heuristicTier.js");
    const simple = classifyHeuristicSimple(message);
    let heuristicTier = null;
    if (simple.isSimple) {
      heuristicIntercepted += 1;
      heuristicTier = "simple";
    } else {
      const result = await judgeTier(baseUrl, apiKey, model, message);
      latencies.heuristic.push(performance.now() - start);
      heuristicTier = result.tier;
    }

    // Path 1 (judge-only): always judge.
    const startJudge = performance.now();
    const judged = await judgeTier(baseUrl, apiKey, model, message);
    latencies.judge.push(performance.now() - startJudge);
    judgeCalls += 1;

    // Agreement on messages the heuristic intercepted (would the judge
    // have said simple too?).
    if (simple.isSimple) {
      agreementTotal += 1;
      if (judged.tier === "simple") agreement += 1;
    }
  }

  lines.push("| path | judge calls | tier-decision latency p50 | p95 |");
  lines.push("|---|---|---|---|");
  lines.push(`| judge-only | ${judgeCalls} | ${pct(latencies.judge, 50).toFixed(0)}ms | ${pct(latencies.judge, 95).toFixed(0)}ms |`);
  lines.push(`| heuristic+judge | ${judgeCalls - heuristicIntercepted} | ${pct(latencies.heuristic, 50).toFixed(0)}ms | ${pct(latencies.heuristic, 95).toFixed(0)}ms |`);
  lines.push("");
  lines.push(`Heuristic intercepts: ${heuristicIntercepted}/${messages.length} (${((heuristicIntercepted / messages.length) * 100).toFixed(0)}%)`);
  lines.push(
    `Judge agreement on intercepted messages: ${agreement}/${agreementTotal} ` +
    `(${agreementTotal > 0 ? ((agreement / agreementTotal) * 100).toFixed(0) : "n/a"}%)`,
  );
  lines.push("");
  if (mode === "mock") {
    lines.push("MOCK MODE: harness protocol/parsing/metrics validated end to end.");
    lines.push("For a real comparison set RIGORIUM_E2E_BASE_URL + RIGORIUM_E2E_API_KEY (+ optional RIGORIUM_E2E_MODEL).");
  } else {
    lines.push(`REAL MODE: ${baseUrl} · model ${model}.`);
  }
  lines.push("");

  if (mockServer) {
    mockServer.close();
  }
  console.log(lines.join("\n"));
}

await main();
