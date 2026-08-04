#!/usr/bin/env node
/**
 * Router policy benchmark CLI (logic lives in src/benchmark/routerPolicyBenchmark.ts).
 *
 * Usage: node scripts/benchmark-router-policy.mjs [seed] [--json]
 */
import { runBenchmark, renderBenchmarkMarkdown } from "../dist/src/benchmark/routerPolicyBenchmark.js";

const seed = Number(process.argv[2] ?? 42);
const json = process.argv.includes("--json");
const results = await runBenchmark(seed);
if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(renderBenchmarkMarkdown(results));
}
