import { createHash } from "node:crypto";
import { AmortizedRanker } from "../router/learning/AmortizedRanker.js";
import { UncertaintyGatedTierClassifier } from "../router/learning/uncertaintyGatedClassifier.js";
import { createStickyGuard } from "../router/policy/stickyGuard.js";
import { classifyHeuristicSimple } from "../router/tokenSaver/heuristicTier.js";
import type { TierClassifier, TokenSaverDecision } from "../router/tokenSaver/tierClassifier.js";
import type { SessionRoutingState } from "../router/protocol/decision.js";

/**
 * Router policy benchmark — verifiable, reproducible numbers for the
 * tokenSaver routing loop, framed with the same metrics RouteLLM reports
 * (strong-model call retention at a quality bar).
 *
 * Workload: a synthetic, seeded corpus of capability buckets, each with a
 * hidden ground-truth tier (the tier a perfect judge would pick) and a
 * judge-noise model (the judge answers correctly with p=0.85, else random).
 * A session is one task shape: all its turns share a bucket. Turns succeed
 * when the chosen tier is strong enough for the bucket, fail otherwise
 * (plus a small provider-fault rate).
 *
 * Policies compared:
 *   judge-only    — every turn consults the judge (baseline, 100% judge)
 *   gate          — uncertainty-gated learned path (explorationRate 0)
 *   gate+explore  — current default (explorationRate 0.05)
 *   sticky+gate   — per-session pin: judge on the first turn of a session,
 *                   reuse the pin for the remaining turns
 *
 * All policies share one workload (ground truth, bucket sequence, fault
 * sequence drawn from the seed once) — only the decisions differ, so the
 * comparison is fair. Every metric is deterministic for a given seed.
 *
 * RouteLLM mapping: judgeCallRate ≈ "% calls routed to the strong model";
 * learnedAgreement ≈ quality retention; costUnits ≈ total spend.
 */
export const TIER_NAMES = ["simple", "medium", "complex", "reasoning"];
const TIER_COSTS = [1, 2, 4, 8]; // cost units per tier choice (1 ≈ 1k tokens)
const JUDGE_COST = 6; // a judge call costs ~6 units (small model, short prompt)
const BUCKETS = 12;
export const TURNS = 600;
const SESSION_LENGTH = 6; // turns per session for the sticky policy
const JUDGE_CORRECTNESS = 0.85;
const PROVIDER_FAULT_RATE = 0.02;

export type BenchmarkPolicyResult = {
  policy: string;
  judgeCalls: number;
  learnedDecisions: number;
  learnedAgreeing: number;
  successfulTurns: number;
  costUnits: number;
  totalTurns: number;
  judgeCallRate: number;
  learnedAgreement: number | null;
  successRate: number;
  heuristicDecisions: number;
  heuristicMisintercepted: number;
  heuristicMisinterceptionRate: number | null;
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Structural capability requirements per bucket (deterministic variation). */
function requirementsForBucket(bucketIndex: number) {
  const toolSets = [
    ["search", "read"],
    ["search", "read", "write"],
    ["bash", "search", "read", "write"],
    ["bash", "search", "read", "write", "agent"],
  ];
  const tools = toolSets[bucketIndex % toolSets.length];
  return {
    toolCategories: tools,
    modalities: bucketIndex % 3 === 0 ? ["text", "image"] : ["text"],
    requiresOrchestration: bucketIndex % 4 === 3,
    research: {
      actionType: bucketIndex % 5 === 0 ? "literature_search" : undefined,
      artifactKinds: bucketIndex % 3 === 0 ? ["claim"] : [],
    },
  };
}

/**
 * Message per turn, bound to the bucket's ground truth (simple buckets get
 * short simple messages; complex buckets get long complex ones) with a 10%
 * noise flip — so the heuristic's conservative exclusions are exercised.
 */
function messageForBucket(groundTruthTier: number, rng: () => number): string {
  const noisy = rng() < 0.1;
  const wantSimple = (groundTruthTier === 0) !== noisy;
  if (wantSimple) {
    return "what is the definition of the term?";
  }
  return "implement the feature with error handling and step by step reasoning about the architecture";
}

function buildTierConfig() {
  const models = TIER_NAMES.map((tier, i) => ({ id: `p/m${i}`, provider: "p", model: `m${i}` }));
  return {
    enabled: true,
    judge: models[0],
    defaultTier: "medium",
    judgeTimeoutMs: 1000,
    tiers: Object.fromEntries(TIER_NAMES.map((tier, i) => [tier, { model: models[i] }])),
  };
}

/**
 * Judge simulator backed by a PRECOMPUTED verdict sequence (drawn from the
 * shared workload RNG): every policy sees the exact same judge answers for
 * the same turns — the only thing policies differ on is their own decisions.
 */
function createJudgeSimulator(
  bucketGroundTruth: number[],
  sessionBuckets: number[],
  rng: () => number,
): { classify(input: { _turnIndex: number }): Promise<{ tier: string; selection: { id: string; provider: string; model: string }; resolvedFrom: "judge" }> } {
  // One verdict per TURN (sessions repeat their bucket across 6 turns).
  const verdicts = Array.from({ length: TURNS }, (_, turn) => {
    const bucketIndex = sessionBuckets[Math.floor(turn / SESSION_LENGTH)];
    const tier = rng() < JUDGE_CORRECTNESS
      ? bucketGroundTruth[bucketIndex]
      : Math.floor(rng() * TIER_NAMES.length);
    return tier;
  });
  return {
    async classify(input) {
      const tier = verdicts[input._turnIndex];
      return {
        tier: TIER_NAMES[tier],
        selection: { id: `p/m${tier}`, provider: "p", model: `m${tier}` },
        resolvedFrom: "judge",
      };
    },
  };
}

function tierIndex(tierName: string): number {
  return TIER_NAMES.indexOf(tierName);
}

// Per-session pin store for the sticky policy (reset per policy run).
const stickyState = new Map<string, Record<string, unknown> & { qualityFailures: number }>();

async function runPolicy(policy: string, seed: number): Promise<BenchmarkPolicyResult> {
  // Shared workload: identical ground truth, bucket sequence, and fault
  // sequence across policies — only the decisions differ (fair comparison).
  const workloadRng = mulberry32(seed);
  const groundTruth = Array.from({ length: BUCKETS }, () => Math.floor(workloadRng() * TIER_NAMES.length));
  // A session is one task shape: all its turns share a bucket.
  const sessionCount = Math.ceil(TURNS / SESSION_LENGTH);
  const sessionBuckets = Array.from({ length: sessionCount }, () => Math.floor(workloadRng() * BUCKETS));
  const policyRng = mulberry32(seed ^ 0x9e3779b9);
  const ranker = new AmortizedRanker();
  const judge = createJudgeSimulator(groundTruth, sessionBuckets, workloadRng);
  const config = buildTierConfig();

  let classifier: TierClassifier = judge as unknown as TierClassifier;
  if (policy === "heuristic+judge") {
    // No learning: the zero-cost heuristic pre-filters obvious-simple
    // messages over the judge (the heuristic's intended deployment — the
    // default config has learning disabled).
    classifier = {
      async classify(input: { messages?: Array<{ content?: Array<{ type?: string; text?: string }> }> }) {
        const message = String(input.messages?.[0]?.content?.[0]?.text ?? "");
        const simple = classifyHeuristicSimple(message);
        if (simple.isSimple) {
          return {
            tier: "simple",
            selection: { id: "p/m0", provider: "p", model: "m0" },
            resolvedFrom: "heuristic",
          };
        }
        return judge.classify(input as never);
      },
    } as unknown as TierClassifier;
  } else if (policy !== "judge-only") {
    const explorationRate = policy === "gate+explore" ? 0.05 : 0;
    classifier = new UncertaintyGatedTierClassifier(judge as unknown as TierClassifier, ranker, {
      minObservations: 4,
      minMargin: 0.15,
      explorationRate,
      random: policyRng,
    });
  }

  const stickyConfig = { enabled: true, ttlMs: 30 * 60 * 1000, maxQualityFailures: 2 };
  // Guard time advances 1s per turn; a 30min TTL comfortably covers a
  // session, and updatedAt is written when the pin is set.
  let clock = 0;
  const isStickyUsable = createStickyGuard(stickyConfig, () => clock);

  const stats = {
    judgeCalls: 0,
    learnedDecisions: 0,
    learnedAgreeing: 0,
    heuristicDecisions: 0,
    heuristicMisintercepted: 0,
    successfulTurns: 0,
    costUnits: 0,
    totalTurns: TURNS,
  };

  // Fault and message sequences drawn once from the shared workload RNG —
  // every policy sees the SAME workload (fair comparison).
  const faultSequence = Array.from({ length: TURNS }, () => workloadRng() < PROVIDER_FAULT_RATE);
  const messageSequence = Array.from({ length: TURNS }, (_, turn) => {
    const bucketIndex = sessionBuckets[Math.floor(turn / SESSION_LENGTH)];
    return messageForBucket(groundTruth[bucketIndex], workloadRng);
  });
  for (let turn = 0; turn < TURNS; turn += 1) {
    const sessionId = `s${Math.floor(turn / SESSION_LENGTH)}`;
    const bucketIndex = sessionBuckets[Math.floor(turn / SESSION_LENGTH)];
    const requirements = requirementsForBucket(bucketIndex);
    const messageText = messageSequence[turn];
    const messageIsSimple = messageText.startsWith("what is");

    // Sticky policy: reuse the session pin when usable (no re-classify);
    // quality failures release it so a broken pin is re-judged.
    let decision: TokenSaverDecision | null = null;
    if (policy === "sticky+gate") {
      const pin = stickyState.get(sessionId) ?? undefined;
      if (isStickyUsable(pin as unknown as SessionRoutingState)) decision = pin as unknown as TokenSaverDecision;
    }
    if (!decision) {
      const input = {
        config,
        messages: [{ role: "user", content: [{ type: "text", text: messageText }] }],
        judgeRuntime: null,
        requirements,
        sessionId,
        _bucketIndex: bucketIndex,
        _turnIndex: turn,
      };
      decision = (await classifier.classify(input as never)) ?? null;
      if (!decision) continue;
      if (decision?.resolvedFrom === "judge") stats.judgeCalls += 1;
      if (decision?.resolvedFrom === "learned") {
        stats.learnedDecisions += 1;
        if (tierIndex(decision.tier) === groundTruth[bucketIndex]) stats.learnedAgreeing += 1;
      }
      if (decision?.resolvedFrom === "heuristic") {
        stats.heuristicDecisions += 1;
        // Mis-interception: the heuristic said simple but the message was
        // actually complex (the conservative-exclusion guard failing would
        // show up here) — the ONLY case where heuristic interception hurts.
        if (!messageIsSimple) stats.heuristicMisintercepted += 1;
      }
      if (policy === "sticky+gate") {
        stickyState.set(sessionId, {
          ...decision,
          stickyProvider: decision.selection.provider,
          stickyModel: decision.selection.model,
          qualityFailures: 0,
          updatedAt: clock,
        });
      }
    }

    const tier = tierIndex(decision.tier);
    // Success model: a simple message is served correctly by ANY tier
    // (a "what is X" question answered by a simple model succeeds); a
    // complex message needs a tier at least as strong as the bucket's
    // ground truth. This is the honest quality model for text-level
    // heuristics — intercepting a simple message to the simple tier is
    // NOT a failure.
    const requiredTier = messageIsSimple ? 0 : groundTruth[bucketIndex];
    const adequate = tier >= requiredTier;
    const providerFault = faultSequence[turn];
    const success = adequate && !providerFault;
    if (success) stats.successfulTurns += 1;

    if (policy !== "judge-only" && policy !== "heuristic+judge") {
      const bucket = ranker.bucketKey(requirements as never);
      ranker.observe(bucket, decision.tier, success ? "success" : "failure");
    }
    if (policy === "sticky+gate") {
      const pin = stickyState.get(sessionId);
      if (pin) {
        pin.qualityFailures = success ? 0 : (pin.qualityFailures ?? 0) + 1;
      }
    }

    stats.costUnits += JUDGE_COST * (decision?.resolvedFrom === "judge" ? 1 : 0) + TIER_COSTS[tier];
    clock += 1000;
  }

  return {
    policy,
    ...stats,
    judgeCallRate: stats.judgeCalls / TURNS,
    learnedAgreement: stats.learnedDecisions > 0 ? stats.learnedAgreeing / stats.learnedDecisions : null,
    successRate: stats.successfulTurns / TURNS,
    heuristicMisinterceptionRate: stats.heuristicDecisions > 0 ? stats.heuristicMisintercepted / stats.heuristicDecisions : null,
  };
}

export async function runBenchmark(seed = 42): Promise<BenchmarkPolicyResult[]> {
  const policies = ["judge-only", "heuristic+judge", "gate", "gate+explore", "sticky+gate"];
  const results: BenchmarkPolicyResult[] = [];
  for (const policy of policies) {
    stickyState.clear();
    results.push(await runPolicy(policy, seed));
  }
  return results;
}

export function renderBenchmarkMarkdown(results: BenchmarkPolicyResult[]): string {
  const lines = [
    "# Router Policy Benchmark",
    "",
    `Seed: deterministic · buckets: ${BUCKETS} · turns: ${TURNS} · judge correctness: ${JUDGE_CORRECTNESS}`,
    "",
    "| policy | judge call rate | learned agreement | success rate | cost units |",
    "|---|---|---|---|---|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.policy} | ${(r.judgeCallRate * 100).toFixed(1)}% | ` +
      `${r.learnedAgreement === null ? "n/a" : `${(r.learnedAgreement * 100).toFixed(1)}%`} | ` +
      `${(r.successRate * 100).toFixed(1)}% | ${r.costUnits.toFixed(0)} |`,
    );
    if (r.policy === "heuristic+gate") {
      lines.push(
        `  heuristic: ${r.heuristicDecisions} decisions, ` +
        `mis-interception rate ${r.heuristicMisinterceptionRate === null ? "n/a" : `${(r.heuristicMisinterceptionRate * 100).toFixed(1)}%`}`,
      );
    }
  }
  lines.push("");
  const baseline = results.find((r) => r.policy === "judge-only");
  if (baseline) {
    for (const r of results) {
      if (r.policy === "judge-only") continue;
      const judgeSaving = (1 - r.judgeCallRate / baseline.judgeCallRate) * 100;
      const qualityDelta = r.successRate - baseline.successRate;
      lines.push(
        `**${r.policy}** vs judge-only: judge calls **-${judgeSaving.toFixed(1)}%**` +
        `, success rate ${qualityDelta >= 0 ? "+" : ""}${(qualityDelta * 100).toFixed(1)}pp, ` +
        `cost **${((r.costUnits / baseline.costUnits - 1) * 100).toFixed(1)}%** vs baseline.`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
