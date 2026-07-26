import { randomUUID } from "node:crypto";
import {
  hashResearchArtifactContent,
  toResearchArtifactRef,
  type ResearchArtifactProducer,
  type ResearchArtifactRef,
} from "../../artifacts/index.js";
import {
  createAblationMatrices,
  createBaselineComparisons,
  createMetricAggregates,
  createRobustnessSlices,
  createRouteEffects,
} from "./aggregates.js";
import {
  EXPERIMENT_ANALYSIS_SCHEMA_VERSION,
  type ExperimentAnalysisInput,
  type ExperimentAnalysisReport,
} from "./contracts.js";
import { createFailureTaxonomy } from "./failures.js";
import { createAnalysisFigureTableArtifact } from "./figureTable.js";
import {
  buildAnalysisMeasurements,
  type AnalysisMeasurement,
} from "./measurements.js";
import { createOptimizationPlan } from "./optimization.js";
import { createRouteParetoComparison } from "./pareto.js";
import { validateExperimentAnalysisInput } from "./validation.js";

const ANALYSIS_ASSUMPTIONS = Object.freeze([
  "Only the latest revision of each RunAttempt artifact identity is analyzed.",
  "Measurements must belong to a succeeded run and be explicitly listed by that run.",
  "Reported baselines remain reported_not_rerun and are never promoted to observed results.",
  "Persisted run facts supply route, parameter, slice, actual-cost, and measured wall-time metadata; legacy trial descriptors remain supported only for legacy runs without persisted facts.",
  "Statistics are descriptive unless a separate study design justifies stronger inference.",
]);

export function createExperimentAnalysisReport(input: ExperimentAnalysisInput): ExperimentAnalysisReport {
  const validated = validateExperimentAnalysisInput(input);
  const now = validated.now ?? new Date();
  const producer: ResearchArtifactProducer = validated.producer
    ?? Object.freeze({ kind: "tool", id: "experimentation-analysis", toolName: "experiment_analysis" });
  const measurements = buildAnalysisMeasurements(validated);
  const provenanceRunRefs = collectParticipatingRunRefs(measurements);
  const figureTableArtifact = createAnalysisFigureTableArtifact({
    figureTable: validated.figureTable,
    provenanceRunRefs,
    producer,
    now,
  });
  const content = {
    schemaVersion: EXPERIMENT_ANALYSIS_SCHEMA_VERSION,
    kind: "experiment_analysis" as const,
    analysisId: validated.analysisId ?? `experiment-analysis-${randomUUID()}`,
    createdAt: now.toISOString(),
    inputRefs: collectInputRefs(validated),
    ignoredRunRevisionRefs: validated.ignoredRunRevisionRefs,
    assumptions: ANALYSIS_ASSUMPTIONS,
    aggregates: createMetricAggregates(validated, measurements),
    baselineComparisons: createBaselineComparisons(validated, measurements),
    routeEffects: createRouteEffects(validated.objectives, measurements),
    ablations: createAblationMatrices(validated, measurements),
    robustness: createRobustnessSlices(validated, measurements),
    failures: createFailureTaxonomy(validated.runAttempts, validated.dataIssues),
    optimization: createOptimizationPlan(validated, measurements),
    pareto: createRouteParetoComparison(validated, measurements),
    ...(figureTableArtifact === undefined ? {} : { figureTableArtifact }),
    provenancePolicy: Object.freeze({
      measurementsSynthesized: false as const,
      expectedConclusionsPromoted: false as const,
      filesWritten: false as const,
      figureFilesSuppliedByCaller: true as const,
    }),
  };
  const contentHash = hashResearchArtifactContent(content);
  return deepFreeze({ ...content, contentHash }) as ExperimentAnalysisReport;
}

export const analyzeExperiment = createExperimentAnalysisReport;

function collectInputRefs(input: ReturnType<typeof validateExperimentAnalysisInput>): readonly ResearchArtifactRef[] {
  const refs = [
    ...input.runAttempts.map(toResearchArtifactRef),
    ...input.metricObservations.map(toResearchArtifactRef),
    ...input.baselineObservations.map(toResearchArtifactRef),
    ...input.dataIssues.map((issue) => issue.artifactRef),
  ];
  const unique = new Map<string, ResearchArtifactRef>();
  for (const ref of refs) unique.set(`${ref.kind}:${ref.artifactId}@${ref.revision}:${ref.contentHash}`, ref);
  return Object.freeze([...unique.values()].sort((left, right) => left.kind.localeCompare(right.kind, "en")
    || left.artifactId.localeCompare(right.artifactId, "en")
    || left.revision - right.revision));
}

function collectParticipatingRunRefs(measurements: readonly AnalysisMeasurement[]): readonly ResearchArtifactRef[] {
  const refs = new Map<string, ResearchArtifactRef>();
  for (const measurement of measurements) {
    if (measurement.run.payload.status !== "succeeded") continue;
    const ref = toResearchArtifactRef(measurement.run);
    refs.set(`${ref.kind}:${ref.artifactId}@${ref.revision}:${ref.contentHash}`, ref);
  }
  return Object.freeze([...refs.values()].sort((left, right) => left.kind.localeCompare(right.kind, "en")
    || left.artifactId.localeCompare(right.artifactId, "en")
    || left.revision - right.revision
    || left.contentHash.localeCompare(right.contentHash, "en")));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
