import { createHash } from "node:crypto";
import type { CapabilityRequirements } from "../policy/capabilityRequirements.js";

/**
 * Per-project amortized tier ranker (Phase 2.2).
 *
 * A router instance belongs to one project runtime, so the ranker's memory is
 * naturally project-local: it learns which tier actually succeeds for which
 * *capability signature* (tool categories × modalities × research action) and
 * at what cost. Once a signature has enough observations, the uncertainty
 * gating classifier trusts the ranker and skips the judge LLM call entirely —
 * cutting routing latency on recurring task shapes (the recurring ones being
 * exactly what a research platform produces).
 *
 * Online update: per-bucket success/failure counts with Laplace smoothing;
 * confidence = (observations, margin between top two tier scores).
 */
export type TierOutcome = "success" | "failure";

export type TierStat = Readonly<{
  tier: string;
  successCount: number;
  failureCount: number;
  observations: number;
  /** Laplace-smoothed success rate. */
  score: number;
  /** Average observed cost in cost units (0 when unknown). */
  avgCostUnits: number;
}>;

export type TierScoreResult = Readonly<{
  bucket: string;
  /** Per-tier stats sorted by score, descending. */
  entries: readonly TierStat[];
  topTier?: string;
  /** Score gap between the top two tiers (confidence signal). */
  topMargin: number;
  totalObservations: number;
  /** Avg cost of the top tier (used by the cost model feedback loop). */
  topTierAvgCostUnits: number;
}>;

export type AmortizedRankerOptions = {
  /** Smoothing constant for the Laplace-smoothed score. */
  smoothing?: number;
  /** Feature hash salt (per-process, avoids cross-version collisions). */
  salt?: string;
};

const DEFAULT_SMOOTHING = 1;
const DEFAULT_SALT = "rigorium-rank-v1";

type BucketRecord = {
  byTier: Map<string, { successCount: number; failureCount: number; costSum: number; costObservations: number }>;
};

export class AmortizedRanker {
  private readonly buckets = new Map<string, BucketRecord>();
  private readonly smoothing: number;
  private readonly salt: string;

  constructor(options: AmortizedRankerOptions = {}) {
    this.smoothing = options.smoothing ?? DEFAULT_SMOOTHING;
    this.salt = options.salt ?? DEFAULT_SALT;
  }

  /** Stable feature hash for a capability signature. */
  bucketKey(requirements: CapabilityRequirements): string {
    // NOTE: message-length complexity signals are deliberately excluded —
    // they flip as context grows within a turn and would fragment the
    // learning across buckets for the same task shape. Only structural
    // signals (tools, modalities, orchestration, research context) bucket.
    const feature = [
      [...requirements.toolCategories].sort().join(","),
      [...requirements.modalities].sort().join(","),
      requirements.requiresOrchestration ? "orch" : "",
      requirements.research.actionType ?? "",
      [...(requirements.research.artifactKinds ?? [])].sort().join(","),
    ].join("|");
    return `b:${createHash("sha1").update(`${this.salt}|${feature}`, "utf8").digest("hex").slice(0, 16)}`;
  }

  observe(bucket: string, tier: string, outcome: TierOutcome, costUnits?: number): void {
    let record = this.buckets.get(bucket);
    if (!record) {
      record = { byTier: new Map() };
      this.buckets.set(bucket, record);
    }
    let stat = record.byTier.get(tier);
    if (!stat) {
      stat = { successCount: 0, failureCount: 0, costSum: 0, costObservations: 0 };
      record.byTier.set(tier, stat);
    }
    if (outcome === "success") {
      stat.successCount += 1;
    } else {
      stat.failureCount += 1;
    }
    if (costUnits !== undefined && Number.isFinite(costUnits) && costUnits > 0) {
      stat.costSum += costUnits;
      stat.costObservations += 1;
    }
  }

  score(bucket: string): TierScoreResult {
    const record = this.buckets.get(bucket);
    if (!record) {
      return {
        bucket,
        entries: [],
        topMargin: 0,
        totalObservations: 0,
        topTierAvgCostUnits: 0,
      };
    }
    const entries: TierStat[] = [];
    let totalObservations = 0;
    for (const [tier, stat] of record.byTier) {
      const observations = stat.successCount + stat.failureCount;
      totalObservations += observations;
      entries.push({
        tier,
        observations,
        successCount: stat.successCount,
        failureCount: stat.failureCount,
        score: (stat.successCount + this.smoothing) / (observations + 2 * this.smoothing),
        // Average cost over cost-bearing observations only — failures with
        // no usage must not deflate the tier's observed cost.
        avgCostUnits: stat.costObservations > 0 ? stat.costSum / stat.costObservations : 0,
      });
    }
    entries.sort((left, right) => right.score - left.score);
    const top = entries[0];
    const second = entries[1];
    const topMargin = top && second ? top.score - second.score : top ? top.score : 0;
    return Object.freeze({
      bucket,
      entries: Object.freeze(entries),
      topTier: top?.tier,
      topMargin,
      totalObservations,
      topTierAvgCostUnits: top?.avgCostUnits ?? 0,
    });
  }

  /** Total observations across all buckets (diagnostics). */
  totalObservations(): number {
    let total = 0;
    for (const record of this.buckets.values()) {
      for (const stat of record.byTier.values()) {
        total += stat.successCount + stat.failureCount;
      }
    }
    return total;
  }

  /** Serialize the ranker state (for persistence across restarts). */
  serialize(): string {
    const buckets: Array<{
      bucket: string;
      tiers: Array<{ tier: string; successCount: number; failureCount: number; costSum: number; costObservations: number }>;
    }> = [];
    for (const [bucket, record] of this.buckets) {
      buckets.push({
        bucket,
        tiers: [...record.byTier].map(([tier, stat]) => ({
          tier,
          successCount: stat.successCount,
          failureCount: stat.failureCount,
          costSum: stat.costSum,
          costObservations: stat.costObservations,
        })),
      });
    }
    return JSON.stringify({ schemaVersion: 1, buckets });
  }

  /** Replace the ranker's state from a serialized payload (version-tolerant). */
  deserialize(json: string): void {
    try {
      const parsed = JSON.parse(json) as {
        schemaVersion?: number;
        buckets?: Array<{
          bucket: string;
          tiers?: Array<{ tier: string; successCount?: number; failureCount?: number; costSum?: number; costObservations?: number }>;
        }>;
      };
      if (!parsed || !Array.isArray(parsed.buckets)) return;
      this.buckets.clear();
      for (const entry of parsed.buckets) {
        if (typeof entry.bucket !== "string" || !Array.isArray(entry.tiers)) continue;
        const record: BucketRecord = { byTier: new Map() };
        for (const tier of entry.tiers) {
          if (typeof tier.tier !== "string") continue;
          record.byTier.set(tier.tier, {
            successCount: finiteNonNegative(tier.successCount),
            failureCount: finiteNonNegative(tier.failureCount),
            costSum: finiteNonNegative(tier.costSum),
            costObservations: finiteNonNegative(tier.costObservations),
          });
        }
        this.buckets.set(entry.bucket, record);
      }
    } catch {
      // Corrupt payload → start fresh; never crash routing over learning state.
    }
  }
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
