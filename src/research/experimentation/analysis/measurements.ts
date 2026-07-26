import type { MetricObservation, RunAttempt } from "../contracts.js";
import type { AnalysisObjective, TrialDescriptor } from "./contracts.js";
import type { ValidatedExperimentAnalysisInput } from "./validation.js";

export type AnalysisMeasurement = Readonly<{
  metric: MetricObservation;
  run: RunAttempt;
  routeId: string;
  descriptor?: TrialDescriptor;
}>;

export function buildAnalysisMeasurements(input: ValidatedExperimentAnalysisInput): readonly AnalysisMeasurement[] {
  const runs = new Map(input.runAttempts.map((run) => [run.payload.attemptId, run]));
  const descriptors = new Map(input.trialDescriptors.map((descriptor) => [descriptor.attemptId, descriptor]));
  const measurements = input.metricObservations.map((metric) => {
    const run = runs.get(metric.payload.runAttemptId);
    if (!run) throw new TypeError(`Validated metric ${metric.artifactId} lost run ${metric.payload.runAttemptId}.`);
    const descriptor = persistedTrialDescriptor(run) ?? descriptors.get(run.payload.attemptId);
    return Object.freeze({
      metric,
      run,
      routeId: run.payload.runFacts?.routeId ?? descriptor?.routeId ?? run.payload.adapterId,
      ...(descriptor === undefined ? {} : { descriptor }),
    });
  });
  return Object.freeze(measurements.sort(measurementOrder));
}

export function measurementMatchesObjective(
  measurement: AnalysisMeasurement,
  objective: AnalysisObjective,
): boolean {
  const payload = measurement.metric.payload;
  return payload.experimentId === objective.experimentId
    && payload.name === objective.metricName
    && payload.split === objective.split
    && payload.unit === objective.unit;
}

export function measurementsForObjective(
  measurements: readonly AnalysisMeasurement[],
  objective: AnalysisObjective,
  routeId?: string,
): readonly AnalysisMeasurement[] {
  return measurements.filter((measurement) => measurementMatchesObjective(measurement, objective)
    && (routeId === undefined || measurement.routeId === routeId));
}

export function routeIdsFromAnalysis(
  input: ValidatedExperimentAnalysisInput,
  measurements: readonly AnalysisMeasurement[],
): readonly string[] {
  const descriptors = new Map(input.trialDescriptors.map((descriptor) => [descriptor.attemptId, descriptor]));
  return Object.freeze([...new Set([
    ...input.trialDescriptors.map((descriptor) => descriptor.routeId),
    ...input.runAttempts.map((run) => run.payload.runFacts?.routeId
      ?? persistedTrialDescriptor(run)?.routeId
      ?? descriptors.get(run.payload.attemptId)?.routeId
      ?? run.payload.adapterId),
    ...measurements.map((measurement) => measurement.routeId),
  ])].sort((left, right) => left.localeCompare(right, "en")));
}

function persistedTrialDescriptor(run: RunAttempt): TrialDescriptor | undefined {
  const facts = run.payload.runFacts;
  if (!facts) return undefined;
  return Object.freeze({
    attemptId: run.payload.attemptId,
    routeId: facts.routeId,
    parameters: facts.parameters,
    slices: facts.slices,
    ...(facts.actualCost === undefined ? {} : { costUsd: facts.actualCost.usd }),
    ...(facts.actualWallTimeMs === undefined ? {} : { wallTimeMs: facts.actualWallTimeMs }),
  });
}

function measurementOrder(left: AnalysisMeasurement, right: AnalysisMeasurement): number {
  return left.run.payload.experimentId.localeCompare(right.run.payload.experimentId, "en")
    || left.routeId.localeCompare(right.routeId, "en")
    || left.metric.payload.name.localeCompare(right.metric.payload.name, "en")
    || (left.metric.payload.split ?? "").localeCompare(right.metric.payload.split ?? "", "en")
    || (left.metric.payload.unit ?? "").localeCompare(right.metric.payload.unit ?? "", "en")
    || Date.parse(runTimestamp(left.run)) - Date.parse(runTimestamp(right.run))
    || left.run.payload.attemptId.localeCompare(right.run.payload.attemptId, "en")
    || left.metric.artifactId.localeCompare(right.metric.artifactId, "en");
}

export function runTimestamp(run: RunAttempt): string {
  return run.payload.finishedAt
    ?? run.payload.startedAt
    ?? run.payload.queuedAt
    ?? run.payload.preparedAt
    ?? run.updatedAt;
}
