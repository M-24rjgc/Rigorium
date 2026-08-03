import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Evaluative-taste calibration (Phase 1.4).
 *
 * The platform's *proxy scores* (self-assessed quality of a draft, a figure,
 * a review) are systematically biased: an LLM's self-rating is neither an
 * ICLR score nor a human reviewer's. The calibrator learns a per-project
 * multiplicative correction from observed outcome pairs — proxy score vs.
 * actual score (7-lane review aggregate, user rating) — via exponential
 * moving average, so the platform's "taste" converges toward the venue's
 * real standards over time.
 *
 * This is the evaluative-taste half of the taste problem (the vocabulary
 * paper's distinction); generative taste (idea novelty) is scored separately
 * against the literature map.
 */
export type TasteCalibrationState = Readonly<{
  schemaVersion: 1;
  /** Multiplicative correction applied to proxy scores. */
  calibration: number;
  /** Observations seen so far. */
  observations: number;
  /** Total squared residual — drift indicator for diagnostics. */
  squaredResidualSum: number;
  updatedAt: string;
}>;

export type TasteCalibratorOptions = {
  projectRoot: string;
  now?: () => Date;
  /** EMA smoothing factor (0..1). */
  alpha?: number;
  /** Minimum observations before calibration is applied. */
  minObservations?: number;
  /** Calibration is clamped to this range. */
  minCalibration?: number;
  maxCalibration?: number;
};

export const DEFAULT_ALPHA = 0.3;
export const DEFAULT_MIN_OBSERVATIONS = 3;
export const DEFAULT_MIN_CALIBRATION = 0.5;
export const DEFAULT_MAX_CALIBRATION = 2.0;

export class TasteCalibrator {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly alpha: number;
  private readonly minObservations: number;
  private readonly minCalibration: number;
  private readonly maxCalibration: number;
  private state: TasteCalibrationState = {
    schemaVersion: 1,
    calibration: 1,
    observations: 0,
    squaredResidualSum: 0,
    updatedAt: new Date(0).toISOString(),
  };
  private loaded = false;

  constructor(options: TasteCalibratorOptions) {
    this.filePath = join(options.projectRoot, ".rigorium", "research", "claims", "taste.json");
    this.now = options.now ?? (() => new Date());
    const alpha = options.alpha ?? DEFAULT_ALPHA;
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
      throw new TypeError(`TasteCalibrator alpha must be in (0, 1]; got ${alpha}.`);
    }
    this.alpha = alpha;
    this.minObservations = options.minObservations ?? DEFAULT_MIN_OBSERVATIONS;
    this.minCalibration = options.minCalibration ?? DEFAULT_MIN_CALIBRATION;
    this.maxCalibration = options.maxCalibration ?? DEFAULT_MAX_CALIBRATION;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as TasteCalibrationState;
      if (parsed && typeof parsed.calibration === "number" && Number.isFinite(parsed.calibration)) {
        this.state = {
          ...this.state,
          // Clamp on load: a hand-edited or corrupted persisted value must
          // never be applied raw by calibrate().
          calibration: clamp(parsed.calibration, this.minCalibration, this.maxCalibration),
          observations: parsed.observations ?? 0,
          squaredResidualSum: parsed.squaredResidualSum ?? 0,
          updatedAt: parsed.updatedAt ?? this.state.updatedAt,
        };
      }
    } catch {
      // Missing/corrupt → keep the identity calibration.
    }
    this.loaded = true;
  }

  /**
   * Record an outcome pair. `proxyScore` is the platform's self-assessment,
   * `actualScore` the external judgment (review round aggregate, user rating).
   * Both are expected in the same scale (e.g. 0..10).
   */
  async observe(proxyScore: number, actualScore: number): Promise<TasteCalibrationState> {
    await this.load();
    if (!Number.isFinite(proxyScore) || !Number.isFinite(actualScore) || proxyScore <= 0) {
      return this.state;
    }

    const ratio = Math.min(3, Math.max(0.2, actualScore / proxyScore));
    const calibration = clamp(
      this.state.calibration + this.alpha * (ratio - this.state.calibration),
      this.minCalibration,
      this.maxCalibration,
    );
    const residual = actualScore - proxyScore;
    this.state = {
      schemaVersion: 1,
      calibration,
      observations: this.state.observations + 1,
      squaredResidualSum: this.state.squaredResidualSum + residual * residual,
      updatedAt: this.now().toISOString(),
    };
    await this.save();
    return this.state;
  }

  /**
   * Apply the learned correction to a fresh proxy score. Returns the raw
   * score until enough observations have accumulated (cold start).
   */
  async calibrate(proxyScore: number): Promise<number> {
    await this.load();
    if (this.state.observations < this.minObservations) {
      return proxyScore;
    }
    return proxyScore * this.state.calibration;
  }

  async stateSnapshot(): Promise<TasteCalibrationState> {
    await this.load();
    return this.state;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = join(dirname(this.filePath), `.taste.json.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
