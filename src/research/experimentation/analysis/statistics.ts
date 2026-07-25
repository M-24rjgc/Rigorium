import type { ConfidenceInterval, EffectSize } from "./contracts.js";

const CI_ASSUMPTIONS = Object.freeze([
  "Observations are treated as independent repeated runs.",
  "The run-level mean is approximately Student-t distributed.",
  "The interval is descriptive and does not correct for multiple comparisons.",
]);

const ONE_SAMPLE_EFFECT_ASSUMPTIONS = Object.freeze([
  "The baseline is treated as a fixed reference value without sampling variance.",
  "Observations are treated as independent repeated runs.",
  "Hedges' small-sample correction uses the run-level degrees of freedom.",
]);

const INDEPENDENT_EFFECT_ASSUMPTIONS = Object.freeze([
  "The two route groups are treated as independent.",
  "The standardized effect uses a pooled within-group variance.",
  "Hedges' small-sample correction uses pooled degrees of freedom.",
]);

export type SampleSummary = Readonly<{
  count: number;
  mean: number;
  median: number;
  minimum: number;
  maximum: number;
  sampleStandardDeviation?: number;
  standardError?: number;
  confidenceInterval: ConfidenceInterval;
}>;

export function summarizeSample(values: readonly number[]): SampleSummary {
  validateSample(values, "sample");
  if (values.length === 0) throw new TypeError("sample must contain at least one value.");
  const sampleMean = mean(values);
  const standardDeviation = sampleStandardDeviation(values, sampleMean);
  const confidenceInterval = studentTConfidenceInterval95(values, sampleMean, standardDeviation);
  const range = minimumMaximum(values);
  return Object.freeze({
    count: values.length,
    mean: sampleMean,
    median: median(values),
    minimum: range.minimum,
    maximum: range.maximum,
    ...(standardDeviation === undefined ? {} : { sampleStandardDeviation: standardDeviation }),
    ...(standardDeviation === undefined ? {} : { standardError: standardDeviation / Math.sqrt(values.length) }),
    confidenceInterval,
  });
}

export function mean(values: readonly number[]): number {
  validateSample(values, "values");
  if (values.length === 0) throw new TypeError("values must contain at least one value.");
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const adjusted = value - compensation;
    const next = sum + adjusted;
    compensation = (next - sum) - adjusted;
    sum = next;
  }
  return normalizeZero(sum / values.length);
}

export function median(values: readonly number[]): number {
  validateSample(values, "values");
  if (values.length === 0) throw new TypeError("values must contain at least one value.");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : normalizeZero((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export function sampleStandardDeviation(values: readonly number[], sampleMean = mean(values)): number | undefined {
  validateSample(values, "values");
  if (!Number.isFinite(sampleMean)) throw new TypeError("sampleMean must be finite.");
  if (values.length < 2) return undefined;
  let squaredDeviationSum = 0;
  let compensation = 0;
  for (const value of values) {
    const squaredDeviation = (value - sampleMean) ** 2;
    const adjusted = squaredDeviation - compensation;
    const next = squaredDeviationSum + adjusted;
    compensation = (next - squaredDeviationSum) - adjusted;
    squaredDeviationSum = next;
  }
  return normalizeZero(Math.sqrt(squaredDeviationSum / (values.length - 1)));
}

export function studentTConfidenceInterval95(
  values: readonly number[],
  sampleMean = mean(values),
  standardDeviation = sampleStandardDeviation(values, sampleMean),
): ConfidenceInterval {
  validateSample(values, "values");
  if (values.length < 2 || standardDeviation === undefined) {
    return Object.freeze({
      status: "unavailable",
      level: 0.95,
      reason: "single_observation",
      method: "student_t_two_sided",
      assumptions: CI_ASSUMPTIONS,
    });
  }
  if (standardDeviation === 0) {
    return Object.freeze({
      status: "unavailable",
      level: 0.95,
      reason: "zero_variance",
      method: "student_t_two_sided",
      assumptions: CI_ASSUMPTIONS,
    });
  }
  const criticalValue = studentTQuantile(0.975, values.length - 1);
  const margin = criticalValue * standardDeviation / Math.sqrt(values.length);
  return Object.freeze({
    status: "available",
    level: 0.95,
    lower: normalizeZero(sampleMean - margin),
    upper: normalizeZero(sampleMean + margin),
    method: "student_t_two_sided",
    assumptions: CI_ASSUMPTIONS,
  });
}

export function hedgesGOneSample(values: readonly number[], baselineValue: number): EffectSize {
  validateSample(values, "values");
  if (!Number.isFinite(baselineValue)) throw new TypeError("baselineValue must be finite.");
  if (values.length < 2) return unavailableEffect("hedges_g_one_sample", "single_observation", ONE_SAMPLE_EFFECT_ASSUMPTIONS);
  const sampleMean = mean(values);
  const standardDeviation = sampleStandardDeviation(values, sampleMean)!;
  if (standardDeviation === 0) return unavailableEffect("hedges_g_one_sample", "zero_variance", ONE_SAMPLE_EFFECT_ASSUMPTIONS);
  const degreesOfFreedom = values.length - 1;
  const correction = hedgesCorrection(degreesOfFreedom);
  return Object.freeze({
    status: "available",
    method: "hedges_g_one_sample",
    value: normalizeZero(correction * (sampleMean - baselineValue) / standardDeviation),
    assumptions: ONE_SAMPLE_EFFECT_ASSUMPTIONS,
  });
}

export function hedgesGIndependentGroups(left: readonly number[], right: readonly number[]): EffectSize {
  validateSample(left, "left group");
  validateSample(right, "right group");
  if (left.length === 0 || right.length === 0) {
    return unavailableEffect("hedges_g_independent_groups", "insufficient_groups", INDEPENDENT_EFFECT_ASSUMPTIONS);
  }
  if (left.length < 2 || right.length < 2) {
    return unavailableEffect("hedges_g_independent_groups", "single_observation", INDEPENDENT_EFFECT_ASSUMPTIONS);
  }
  const leftMean = mean(left);
  const rightMean = mean(right);
  const leftSd = sampleStandardDeviation(left, leftMean)!;
  const rightSd = sampleStandardDeviation(right, rightMean)!;
  const degreesOfFreedom = left.length + right.length - 2;
  const pooledVariance = ((left.length - 1) * leftSd ** 2 + (right.length - 1) * rightSd ** 2) / degreesOfFreedom;
  if (pooledVariance === 0) {
    return unavailableEffect("hedges_g_independent_groups", "zero_variance", INDEPENDENT_EFFECT_ASSUMPTIONS);
  }
  return Object.freeze({
    status: "available",
    method: "hedges_g_independent_groups",
    value: normalizeZero(hedgesCorrection(degreesOfFreedom) * (leftMean - rightMean) / Math.sqrt(pooledVariance)),
    assumptions: INDEPENDENT_EFFECT_ASSUMPTIONS,
  });
}

/** Quantile for a standard Student-t distribution. */
export function studentTQuantile(probability: number, degreesOfFreedom: number): number {
  if (!(probability > 0 && probability < 1)) throw new TypeError("probability must be between zero and one.");
  if (!Number.isSafeInteger(degreesOfFreedom) || degreesOfFreedom < 1) {
    throw new TypeError("degreesOfFreedom must be a positive integer.");
  }
  if (probability === 0.5) return 0;
  if (probability < 0.5) return -studentTQuantile(1 - probability, degreesOfFreedom);

  let lower = 0;
  let upper = 1;
  while (studentTCdf(upper, degreesOfFreedom) < probability) {
    upper *= 2;
    if (!Number.isFinite(upper)) throw new RangeError("Student-t quantile could not be bracketed.");
  }
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (studentTCdf(middle, degreesOfFreedom) < probability) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}

export function studentTCdf(value: number, degreesOfFreedom: number): number {
  if (!Number.isFinite(value)) {
    if (value === Number.NEGATIVE_INFINITY) return 0;
    if (value === Number.POSITIVE_INFINITY) return 1;
    throw new TypeError("value must be a real number.");
  }
  if (!Number.isSafeInteger(degreesOfFreedom) || degreesOfFreedom < 1) {
    throw new TypeError("degreesOfFreedom must be a positive integer.");
  }
  if (value === 0) return 0.5;
  const x = degreesOfFreedom / (degreesOfFreedom + value ** 2);
  const tail = 0.5 * regularizedIncompleteBeta(x, degreesOfFreedom / 2, 0.5);
  return value > 0 ? 1 - tail : tail;
}

function hedgesCorrection(degreesOfFreedom: number): number {
  return 1 - 3 / (4 * degreesOfFreedom - 1);
}

function unavailableEffect(
  method: "hedges_g_one_sample" | "hedges_g_independent_groups",
  reason: "single_observation" | "zero_variance" | "insufficient_groups",
  assumptions: readonly string[],
): EffectSize {
  return Object.freeze({ status: "unavailable", method, reason, assumptions });
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x < 0 || x > 1) throw new RangeError("Incomplete beta x must be in [0, 1].");
  if (x === 0 || x === 1) return x;
  const logarithmicFactor = logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log1p(-x);
  const factor = Math.exp(logarithmicFactor);
  if (x < (a + 1) / (a + b + 2)) return factor * betaContinuedFraction(a, b, x) / a;
  return 1 - factor * betaContinuedFraction(b, a, 1 - x) / b;
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maximumIterations = 300;
  const epsilon = 3e-14;
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;
  for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
    const doubled = 2 * iteration;
    let numerator = iteration * (b - iteration) * x / ((qam + doubled) * (a + doubled));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    result *= d * c;

    numerator = -(a + iteration) * (qab + iteration) * x / ((a + doubled) * (qap + doubled));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) <= epsilon) return result;
  }
  throw new RangeError("Incomplete beta continued fraction did not converge.");
}

function logGamma(value: number): number {
  const coefficients = [
    0.9999999999998099,
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  const shifted = value - 1;
  let series = coefficients[0]!;
  for (let index = 1; index < coefficients.length; index += 1) series += coefficients[index]! / (shifted + index);
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(series);
}

function validateSample(values: readonly number[], label: string): void {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array.`);
  for (const value of values) {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain only finite numbers.`);
  }
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function minimumMaximum(values: readonly number[]): Readonly<{ minimum: number; maximum: number }> {
  let minimum = values[0]!;
  let maximum = values[0]!;
  for (const value of values.slice(1)) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  return { minimum, maximum };
}
