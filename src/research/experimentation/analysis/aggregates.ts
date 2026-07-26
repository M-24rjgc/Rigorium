import { canonicalJson, toResearchArtifactRef } from "../../artifacts/index.js";
import type { BaselineObservation, MetricDirection } from "../contracts.js";
import type {
  AblationMatrix,
  AnalysisObjective,
  AnalysisScalar,
  BaselineComparison,
  EffectSize,
  MetricAggregate,
  RobustnessSlice,
  RouteEffectComparison,
} from "./contracts.js";
import {
  type AnalysisMeasurement,
  measurementMatchesObjective,
  measurementsForObjective,
} from "./measurements.js";
import { hedgesGIndependentGroups, hedgesGOneSample, mean, summarizeSample } from "./statistics.js";
import { analysisScalarKey, type ValidatedExperimentAnalysisInput } from "./validation.js";

const ABLATION_ASSUMPTIONS = Object.freeze([
  "Ablation values come from immutable persisted run facts or legacy trial descriptors, not inferred treatments.",
  "Differences are descriptive means relative to the declared control value.",
  "No causal claim is made without a randomized or otherwise justified design.",
]);

const ROBUSTNESS_ASSUMPTIONS = Object.freeze([
  "Slice membership comes from immutable persisted run facts or legacy descriptors, and each metric is analyzed in its recorded slice.",
  "Slice summaries are descriptive and do not adjust for unequal sample sizes.",
]);

type MeasurementGroup = Readonly<{
  key: string;
  experimentId: string;
  routeId: string;
  metricName: string;
  direction: MetricDirection;
  split?: string;
  unit?: string;
  measurements: readonly AnalysisMeasurement[];
}>;

export function createMetricAggregates(
  input: ValidatedExperimentAnalysisInput,
  measurements: readonly AnalysisMeasurement[],
): readonly MetricAggregate[] {
  return Object.freeze(groupMeasurements(input.objectives, measurements).map((group) => {
    const summary = summarizeSample(group.measurements.map((measurement) => measurement.metric.payload.value));
    return Object.freeze({
      key: group.key,
      experimentId: group.experimentId,
      routeId: group.routeId,
      metricName: group.metricName,
      direction: group.direction,
      ...(group.split === undefined ? {} : { split: group.split }),
      ...(group.unit === undefined ? {} : { unit: group.unit }),
      count: summary.count,
      attemptIds: Object.freeze([...new Set(group.measurements.map((measurement) => measurement.run.payload.attemptId))]
        .sort((left, right) => left.localeCompare(right, "en"))),
      observationRefs: Object.freeze(group.measurements.map((measurement) => toResearchArtifactRef(measurement.metric))),
      mean: summary.mean,
      median: summary.median,
      minimum: summary.minimum,
      maximum: summary.maximum,
      ...(summary.sampleStandardDeviation === undefined ? {} : { sampleStandardDeviation: summary.sampleStandardDeviation }),
      ...(summary.standardError === undefined ? {} : { standardError: summary.standardError }),
      confidenceInterval: summary.confidenceInterval,
    });
  }));
}

export function createBaselineComparisons(
  input: ValidatedExperimentAnalysisInput,
  measurements: readonly AnalysisMeasurement[],
): readonly BaselineComparison[] {
  const groups = groupMeasurements(input.objectives, measurements);
  const comparisons: BaselineComparison[] = [];
  for (const baseline of input.baselineObservations) {
    const direction = objectiveDirectionForBaseline(input.objectives, baseline) ?? baseline.payload.direction;
    const matchingGroups = groups.filter((group) => group.experimentId === baseline.payload.experimentId
      && group.metricName === baseline.payload.metricName
      && group.split === baseline.payload.split
      && group.unit === baseline.payload.unit
      && group.direction === direction);
    if (matchingGroups.length === 0) {
      comparisons.push(Object.freeze({
        baselineRef: toResearchArtifactRef(baseline),
        provenance: baseline.payload.provenance.kind === "reported" ? "reported_not_rerun" : "observed_run",
        experimentId: baseline.payload.experimentId,
        metricName: baseline.payload.metricName,
        direction,
        ...(baseline.payload.split === undefined ? {} : { split: baseline.payload.split }),
        ...(baseline.payload.unit === undefined ? {} : { unit: baseline.payload.unit }),
        baselineValue: baseline.payload.value,
        status: "missing_observed_measurements",
        observedCount: 0,
        assessment: "not_assessed",
        effectSize: unavailableOneSampleEffect(),
      }));
      continue;
    }
    for (const group of matchingGroups) {
      const values = group.measurements.map((measurement) => measurement.metric.payload.value);
      const observedMean = mean(values);
      const absoluteDifference = observedMean - baseline.payload.value;
      comparisons.push(Object.freeze({
        baselineRef: toResearchArtifactRef(baseline),
        provenance: baseline.payload.provenance.kind === "reported" ? "reported_not_rerun" : "observed_run",
        experimentId: baseline.payload.experimentId,
        routeId: group.routeId,
        metricName: baseline.payload.metricName,
        direction,
        ...(baseline.payload.split === undefined ? {} : { split: baseline.payload.split }),
        ...(baseline.payload.unit === undefined ? {} : { unit: baseline.payload.unit }),
        baselineValue: baseline.payload.value,
        status: "compared",
        observedCount: values.length,
        observedMean,
        absoluteDifference,
        ...(baseline.payload.value === 0 ? {} : { relativeDifference: absoluteDifference / Math.abs(baseline.payload.value) }),
        assessment: assessDifference(absoluteDifference, direction),
        effectSize: hedgesGOneSample(values, baseline.payload.value),
      }));
    }
  }
  return Object.freeze(comparisons.sort((left, right) => left.baselineRef.artifactId.localeCompare(right.baselineRef.artifactId, "en")
    || (left.routeId ?? "").localeCompare(right.routeId ?? "", "en")));
}

export function createRouteEffects(
  objectives: readonly AnalysisObjective[],
  measurements: readonly AnalysisMeasurement[],
): readonly RouteEffectComparison[] {
  const comparisons: RouteEffectComparison[] = [];
  for (const objective of objectives) {
    const byRoute = groupByRoute(measurementsForObjective(measurements, objective));
    const routeIds = [...byRoute.keys()].sort((left, right) => left.localeCompare(right, "en"));
    for (let leftIndex = 0; leftIndex < routeIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < routeIds.length; rightIndex += 1) {
        const leftRouteId = routeIds[leftIndex]!;
        const rightRouteId = routeIds[rightIndex]!;
        const leftValues = byRoute.get(leftRouteId)!.map((measurement) => measurement.metric.payload.value);
        const rightValues = byRoute.get(rightRouteId)!.map((measurement) => measurement.metric.payload.value);
        comparisons.push(Object.freeze({
          objective,
          leftRouteId,
          rightRouteId,
          leftCount: leftValues.length,
          rightCount: rightValues.length,
          meanDifference: mean(leftValues) - mean(rightValues),
          effectSize: hedgesGIndependentGroups(leftValues, rightValues),
        }));
      }
    }
  }
  return Object.freeze(comparisons);
}

export function createAblationMatrices(
  input: ValidatedExperimentAnalysisInput,
  measurements: readonly AnalysisMeasurement[],
): readonly AblationMatrix[] {
  const matrices: AblationMatrix[] = [];
  for (const factor of input.ablationFactors) {
    for (const objective of input.objectives) {
      const groups = new Map<string, { value: AnalysisScalar; measurements: AnalysisMeasurement[] }>();
      for (const measurement of measurementsForObjective(measurements, objective)) {
        const value = measurement.descriptor?.parameters?.[factor.name];
        if (value === undefined) continue;
        const key = analysisScalarKey(value);
        const group = groups.get(key) ?? { value, measurements: [] };
        group.measurements.push(measurement);
        groups.set(key, group);
      }
      if (groups.size === 0) continue;
      const control = groups.get(analysisScalarKey(factor.controlValue));
      const controlMean = control === undefined
        ? undefined
        : mean(control.measurements.map((measurement) => measurement.metric.payload.value));
      const rows = [...groups.values()]
        .sort((left, right) => compareScalars(left.value, right.value))
        .map((group) => {
          const groupMean = mean(group.measurements.map((measurement) => measurement.metric.payload.value));
          return Object.freeze({
            value: group.value,
            count: group.measurements.length,
            mean: groupMean,
            ...(controlMean === undefined ? {} : { differenceFromControl: groupMean - controlMean }),
          });
        });
      matrices.push(Object.freeze({
        factor: factor.name,
        controlValue: factor.controlValue,
        objective,
        rows: Object.freeze(rows),
        assumptions: ABLATION_ASSUMPTIONS,
      }));
    }
  }
  return Object.freeze(matrices);
}

export function createRobustnessSlices(
  input: ValidatedExperimentAnalysisInput,
  measurements: readonly AnalysisMeasurement[],
): readonly RobustnessSlice[] {
  const results: RobustnessSlice[] = [];
  for (const dimension of input.robustnessDimensions) {
    for (const objective of input.objectives) {
      const groups = new Map<string, { value: AnalysisScalar; values: number[] }>();
      for (const measurement of measurementsForObjective(measurements, objective)) {
        const value = measurement.descriptor?.slices?.[dimension.name];
        if (value === undefined) continue;
        const key = analysisScalarKey(value);
        const group = groups.get(key) ?? { value, values: [] };
        group.values.push(measurement.metric.payload.value);
        groups.set(key, group);
      }
      if (groups.size === 0) continue;
      const slices = [...groups.values()]
        .sort((left, right) => compareScalars(left.value, right.value))
        .map((group) => {
          const range = group.values.slice(1).reduce(
            (current, value) => ({ minimum: Math.min(current.minimum, value), maximum: Math.max(current.maximum, value) }),
            { minimum: group.values[0]!, maximum: group.values[0]! },
          );
          return Object.freeze({
            value: group.value,
            count: group.values.length,
            mean: mean(group.values),
            minimum: range.minimum,
            maximum: range.maximum,
          });
        });
      results.push(Object.freeze({
        dimension: dimension.name,
        objective,
        slices: Object.freeze(slices),
        assumptions: ROBUSTNESS_ASSUMPTIONS,
      }));
    }
  }
  return Object.freeze(results);
}

function groupMeasurements(
  objectives: readonly AnalysisObjective[],
  measurements: readonly AnalysisMeasurement[],
): MeasurementGroup[] {
  const groups = new Map<string, { metadata: Omit<MeasurementGroup, "measurements">; measurements: AnalysisMeasurement[] }>();
  for (const measurement of measurements) {
    const payload = measurement.metric.payload;
    const objective = objectives.find((candidate) => measurementMatchesObjective(measurement, candidate));
    const direction = objective?.direction ?? payload.direction;
    const key = canonicalJson([
      payload.experimentId,
      measurement.routeId,
      payload.name,
      direction,
      payload.split ?? null,
      payload.unit ?? null,
    ]);
    const metadata: Omit<MeasurementGroup, "measurements"> = {
      key,
      experimentId: payload.experimentId,
      routeId: measurement.routeId,
      metricName: payload.name,
      direction,
      ...(payload.split === undefined ? {} : { split: payload.split }),
      ...(payload.unit === undefined ? {} : { unit: payload.unit }),
    };
    const group = groups.get(key) ?? { metadata, measurements: [] };
    group.measurements.push(measurement);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => left.metadata.key.localeCompare(right.metadata.key, "en"))
    .map((group) => Object.freeze({ ...group.metadata, measurements: Object.freeze(group.measurements) }));
}

function objectiveDirectionForBaseline(
  objectives: readonly AnalysisObjective[],
  baseline: BaselineObservation,
): AnalysisObjective["direction"] | undefined {
  return objectives.find((objective) => objective.experimentId === baseline.payload.experimentId
    && objective.metricName === baseline.payload.metricName
    && objective.split === baseline.payload.split
    && objective.unit === baseline.payload.unit)?.direction;
}

function assessDifference(difference: number, direction: MetricDirection): BaselineComparison["assessment"] {
  if (difference === 0) return "equal";
  if (direction === "neutral") return "not_assessed";
  if (direction === "maximize") return difference > 0 ? "improved" : "worse";
  return difference < 0 ? "improved" : "worse";
}

function unavailableOneSampleEffect(): EffectSize {
  return Object.freeze({
    status: "unavailable",
    method: "hedges_g_one_sample",
    reason: "insufficient_groups",
    assumptions: Object.freeze([
      "No succeeded matching measurements were available for comparison.",
      "The baseline remains recorded without an inferred effect.",
    ]),
  });
}

function groupByRoute(measurements: readonly AnalysisMeasurement[]): Map<string, AnalysisMeasurement[]> {
  const groups = new Map<string, AnalysisMeasurement[]>();
  for (const measurement of measurements) {
    const group = groups.get(measurement.routeId) ?? [];
    group.push(measurement);
    groups.set(measurement.routeId, group);
  }
  return groups;
}

function compareScalars(left: AnalysisScalar, right: AnalysisScalar): number {
  const typeDifference = scalarTypeOrder(left) - scalarTypeOrder(right);
  if (typeDifference !== 0) return typeDifference;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), "en");
}

function scalarTypeOrder(value: AnalysisScalar): number {
  switch (typeof value) {
    case "boolean": return 0;
    case "number": return 1;
    case "string": return 2;
  }
}
