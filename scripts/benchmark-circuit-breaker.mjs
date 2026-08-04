#!/usr/bin/env node
/**
 * Circuit-breaker recovery-policy simulation — quantifies why Rigorium's
 * half-open probe WINDOW (ratio verdict) beats Hystrix-style single-probe
 * reopen under flaky providers.
 *
 * Clean probabilistic model (no state-machine interaction):
 * each outage cycle, once the provider has RECOVERED, a probe still fails
 * with probability f (transient jitter). The policy then decides:
 *
 *   single-probe (Hystrix) — 1 probe; failure → needless reopen (prob = f)
 *   window-3 (Rigorium R17) — 3 probes; ≥2 failures → needless reopen
 *                             (prob = 3·f²·(1-f) + f³, the binomial tail)
 *
 * Metrics over N cycles (deterministic seed, Monte-Carlo):
 *   needless reopens — reopening an already-recovered provider (cooldown
 *                      penalty, wasted probes, latency)
 *   probes — total probes sent across all cycles
 *
 * Analytic expectation is printed alongside the Monte-Carlo result so the
 * simulation is self-verifying.
 *
 * Usage: node scripts/benchmark-circuit-breaker.mjs [cycles] [seed] [flakyRate]
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function binomialTailAtLeastK(n, k, p) {
  let sum = 0;
  for (let i = k; i <= n; i += 1) {
    let c = 1;
    for (let j = 1; j <= i; j += 1) c = (c * (n - j + 1)) / j;
    sum += c * p ** i * (1 - p) ** (n - i);
  }
  return sum;
}

const cycles = Number(process.argv[2] ?? 200);
const seed = Number(process.argv[3] ?? 7);
const flakyRate = Number(process.argv[4] ?? 0.1);

// Each cycle: the provider has recovered with probability pRecoveredBeforeProbe
// (uniform outage 0.5-4s vs probe slot every 1s → recovered ~70% of the time).
const pRecovered = 0.7;

const rng = mulberry32(seed);
let singleReopens = 0;
let windowReopens = 0;
let singleProbes = 0;
let windowProbes = 0;

for (let cycle = 0; cycle < cycles; cycle += 1) {
  const recovered = rng() < pRecovered;
  // single-probe: 1 probe; needless reopen when recovered AND flaky-failed.
  singleProbes += 1;
  if (recovered && rng() < flakyRate) singleReopens += 1;
  // window-3: 3 probes; needless reopen when recovered AND ≥2 flaky-failed.
  windowProbes += 3;
  const failures = (rng() < flakyRate ? 1 : 0) + (rng() < flakyRate ? 1 : 0) + (rng() < flakyRate ? 1 : 0);
  if (recovered && failures >= 2) windowReopens += 1;
}

const analyticSingle = cycles * pRecovered * flakyRate;
const analyticWindow = cycles * pRecovered * binomialTailAtLeastK(3, 2, flakyRate);

console.log(`# Circuit-breaker recovery-policy simulation (cycles=${cycles}, seed=${seed}, flakyRate=${flakyRate})`);
console.log("");
console.log("| policy | needless reopens (MC) | probes | analytic expectation |");
console.log("|---|---|---|---|");
console.log(`| single-probe (Hystrix) | ${singleReopens} | ${singleProbes} | ${analyticSingle.toFixed(1)} |`);
console.log(`| window-3 (Rigorium R17) | ${windowReopens} | ${windowProbes} | ${analyticWindow.toFixed(1)} |`);
console.log("");
const reduction = (1 - windowReopens / Math.max(1, singleReopens)) * 100;
console.log(`Needless reopens avoided by the probe window: ${(singleReopens - windowReopens).toFixed(0)} of ${singleReopens} (${reduction.toFixed(1)}% reduction)`);
console.log("Probe cost: single-probe sends 1 probe/cycle; window-3 sends 3 — the window trades");
console.log("3× probe volume for a ~(1 - " + (analyticWindow / Math.max(1, analyticSingle)).toFixed(2) + ") reduction in needless reopen penalty.");
