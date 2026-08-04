#!/usr/bin/env node
/**
 * Router policy benchmark CLI (logic lives in src/benchmark/routerPolicyBenchmark.ts).
 *
 * Usage:
 *   node scripts/benchmark-router-policy.mjs [seed] [--json]
 *   node scripts/benchmark-router-policy.mjs --seeds 42,43,44 [--json]
 *   --seeds runs the multi-seed aggregation (mean ± std report).
 */
import {
  runBenchmark,
  runBenchmarkSeeds,
  renderBenchmarkMarkdown,
  renderBenchmarkAggregateMarkdown,
} from "../dist/src/benchmark/routerPolicyBenchmark.js";

const json = process.argv.includes("--json");
const seedsIndex = process.argv.indexOf("--seeds");
const seedsFlag = process.argv.find((arg) => arg.startsWith("--seeds="));
const seedsValue = seedsFlag
  ? seedsFlag.split("=")[1]
  : seedsIndex >= 0 ? process.argv[seedsIndex + 1] : undefined;
if (seedsValue !== undefined) {
  const seeds = seedsValue.split(",").map(Number).filter((n) => Number.isFinite(n));
  if (seeds.length === 0) {
    console.error("rigorium benchmark: --seeds requires a comma-separated list of numbers.");
    process.exitCode = 1;
  } else {
    const results = await runBenchmarkSeeds(seeds);
    if (json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(renderBenchmarkAggregateMarkdown(results));
    }
  }
} else {
  const seed = Number(process.argv[2] ?? 42);
  const results = await runBenchmark(seed);
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(renderBenchmarkMarkdown(results));
  }
}
