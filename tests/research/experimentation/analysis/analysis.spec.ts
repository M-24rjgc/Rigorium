import assert from "node:assert/strict";
import test from "node:test";
import {
  hashResearchArtifactContent,
  toResearchArtifactRef,
} from "../../../../src/research/artifacts/index.js";
import { createExperimentAnalysisReport } from "../../../../src/research/experimentation/analysis/analysis.js";
import { EXPERIMENT_ANALYSIS_CANDIDATE_SURVEY } from "../../../../src/research/experimentation/analysis/candidateSurvey.js";
import type { MetricObservation, RunAttempt } from "../../../../src/research/experimentation/contracts.js";
import {
  ANALYSIS_TEST_NOW,
  ANALYSIS_TEST_PRODUCER,
  failure,
  metricObservation,
  observedBaseline,
  reportedBaseline,
  runAttempt,
  sha256,
} from "./fixtures.js";

test("analysis reports repeat statistics, provenance, ablations, robustness, Pareto, and proposals", () => {
  const fixtures = routeFixtures();
  const paper = reportedBaseline({ baselineId: "baseline-paper", value: 0.75 });
  const observed = observedBaseline({
    baselineId: "baseline-observed",
    runAttemptId: "attempt-b1",
    metricObservationId: "metric-b1-accuracy",
    value: 0.86,
  });
  const failedMetric = metricObservation({
    observationId: "metric-failed-accuracy",
    runAttemptId: "attempt-failed",
    value: 0.99,
  });
  const failedRun = runAttempt({
    attemptId: "attempt-failed",
    status: "failed",
    metricObservationIds: [failedMetric.artifactId],
    failure: failure("timeout", true),
  });
  const unusedSucceeded = runAttempt({
    attemptId: "attempt-unused",
    metricObservationIds: [],
  });
  const olderA1 = runAttempt({
    attemptId: "attempt-a1",
    revision: 1,
    status: "running",
    metricObservationIds: [],
  });
  const latestA1 = runAttempt({
    attemptId: "attempt-a1",
    revision: 2,
    metricObservationIds: ["metric-a1-accuracy", "metric-a1-latency"],
    startedAt: "2026-07-25T08:00:00.000Z",
    finishedAt: "2026-07-25T08:01:00.000Z",
  });
  const input = {
    runAttempts: [olderA1, latestA1, ...fixtures.runs.filter((run) => run.artifactId !== "attempt-a1"), failedRun, unusedSucceeded],
    metricObservations: [...fixtures.metrics, failedMetric],
    baselineObservations: [paper, observed],
    trialDescriptors: fixtures.descriptors,
    objectives: [
      { experimentId: "experiment-main", metricName: "accuracy", direction: "maximize" as const },
      { experimentId: "experiment-main", metricName: "latency", direction: "minimize" as const, unit: "ms" },
    ],
    ablationFactors: [{ name: "depth", controlValue: 1 }],
    robustnessDimensions: [{ name: "noise" }],
    budget: { maxAttempts: 20, maxWallTimeMs: 1_000_000, maxCostUsd: 20 },
    searchSpace: {
      routeId: "route-a",
      parameters: [{ name: "depth", values: [1, 2, 3] }],
      maxProposals: 2,
      estimatedWallTimeMsPerTrial: 1_000,
      estimatedCostUsdPerTrial: 1,
    },
    figureTable: {
      artifactId: "figure-analysis-summary",
      items: [{
        itemId: "table-route-summary",
        kind: "table" as const,
        label: "tab:route-summary",
        data: [{ path: "analysis/route-summary.csv", contentHash: sha256("1"), mediaType: "text/csv" }],
        script: {
          status: "available" as const,
          file: { path: "analysis/render-table.ts", contentHash: sha256("2"), mediaType: "text/typescript" },
          command: ["node", "analysis/render-table.ts"],
        },
        output: { path: "analysis/route-summary.tex", contentHash: sha256("3"), mediaType: "text/x-tex" },
        captionLatex: "Synthetic route summary from recorded observations.",
        captionEvidenceRefs: [toResearchArtifactRef(paper)],
        citationKeys: [],
      }],
    },
    analysisId: "analysis-comprehensive",
    now: ANALYSIS_TEST_NOW,
    producer: ANALYSIS_TEST_PRODUCER,
  };

  const report = createExperimentAnalysisReport(input);
  const repeated = createExperimentAnalysisReport(input);
  assert.deepEqual(repeated, report);
  assert.equal(report.ignoredRunRevisionRefs.some((ref) => ref.artifactId === "attempt-a1" && ref.revision === 1), true);
  assert.equal(report.aggregates.length, 6);
  assert.equal(report.aggregates.some((aggregate) => aggregate.observationRefs.some((ref) => ref.artifactId === failedMetric.artifactId)), false);
  assert.equal(report.failures.totalAttempts, 7);
  assert.equal(report.failures.entries.find((entry) => entry.category === "timeout")?.retryableCount, 1);
  assert.deepEqual(report.failures.dataIssues.map((issue) => issue.code), ["metric_from_unsuccessful_run"]);
  assert.equal(report.baselineComparisons.filter((comparison) => comparison.provenance === "reported_not_rerun").length, 3);
  assert.equal(report.baselineComparisons.filter((comparison) => comparison.provenance === "observed_run").length, 3);
  assert.equal(report.routeEffects.length, 6);
  assert.deepEqual(report.ablations[0]?.rows.map((row) => row.value), [1, 2]);
  assert.deepEqual(report.robustness[0]?.slices.map((slice) => slice.value), ["clean", "noisy"]);
  assert.deepEqual(report.pareto.frontierRouteIds, ["route-b"]);
  assert.equal(report.pareto.points.find((point) => point.routeId === "route-a")?.dominatedBy.includes("route-b"), true);
  assert.deepEqual(report.optimization.proposals.map((proposal) => proposal.parameters.depth), [3]);
  assert.equal(report.optimization.proposals[0]?.status, "proposed_not_executed");
  assert.equal("predictedValue" in (report.optimization.proposals[0] ?? {}), false);
  assert.equal(report.figureTableArtifact?.artifactId, "figure-analysis-summary");
  assert.equal(report.figureTableArtifact?.payload.items[0]?.reuseStatus, "recomputable");
  const runProvenanceParents = report.figureTableArtifact?.parents
    .filter((parent) => parent.relation === "uses" && parent.artifact.kind === "run_attempt") ?? [];
  assert.deepEqual(runProvenanceParents.map((parent) => parent.artifact), [
    toResearchArtifactRef(latestA1),
    ...fixtures.runs
      .filter((run) => run.artifactId !== "attempt-a1")
      .map(toResearchArtifactRef),
  ]);
  assert.equal(runProvenanceParents.some((parent) => parent.artifact.artifactId === olderA1.artifactId
    && parent.artifact.revision === olderA1.revision), false);
  assert.equal(runProvenanceParents.some((parent) => parent.artifact.artifactId === failedRun.artifactId), false);
  assert.equal(runProvenanceParents.some((parent) => parent.artifact.artifactId === unusedSucceeded.artifactId), false);
  const withoutParticipatingRuns = createExperimentAnalysisReport({
    ...input,
    runAttempts: [unusedSucceeded],
    metricObservations: [],
    baselineObservations: [paper],
    trialDescriptors: [],
    analysisId: "analysis-without-participating-runs",
  });
  assert.deepEqual(withoutParticipatingRuns.figureTableArtifact?.parents
    .filter((parent) => parent.relation === "uses" && parent.artifact.kind === "run_attempt"), []);
  assert.notEqual(withoutParticipatingRuns.figureTableArtifact?.contentHash, report.figureTableArtifact?.contentHash);
  assert.equal(report.provenancePolicy.filesWritten, false);
  assert.equal(report.provenancePolicy.measurementsSynthesized, false);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.optimization.proposals), true);
  const { contentHash, ...content } = report;
  assert.equal(contentHash, hashResearchArtifactContent(content));
});

test("reported baselines remain visible when no measurements exist", () => {
  const report = createExperimentAnalysisReport({
    runAttempts: [],
    metricObservations: [],
    baselineObservations: [reportedBaseline({ baselineId: "baseline-only", value: 0.8 })],
    objectives: [{ experimentId: "experiment-main", metricName: "accuracy", direction: "maximize" }],
    analysisId: "analysis-no-measurements",
    now: ANALYSIS_TEST_NOW,
  });
  assert.equal(report.aggregates.length, 0);
  assert.equal(report.baselineComparisons[0]?.provenance, "reported_not_rerun");
  assert.equal(report.baselineComparisons[0]?.status, "missing_observed_measurements");
  assert.equal(report.baselineComparisons[0]?.effectSize.status, "unavailable");
  assert.equal(report.pareto.eligibleRouteCount, 0);
});

test("persisted run facts drive analysis and cannot be overwritten by trial descriptors", () => {
  const metric = metricObservation({
    observationId: "metric-ledger-facts",
    runAttemptId: "attempt-ledger-facts",
    value: 0.91,
  });
  const run = runAttempt({
    attemptId: "attempt-ledger-facts",
    metricObservationIds: [metric.artifactId],
    runFacts: {
      routeId: "persisted-route",
      parameters: { depth: 3 },
      slices: { domain: "heldout" },
      actualWallTimeMs: 420,
      actualCost: {
        usd: 1.25,
        source: "provider_reported",
        reference: "invoice-ledger",
        recordedAt: ANALYSIS_TEST_NOW.toISOString(),
      },
    },
  });
  const input = {
    runAttempts: [run],
    metricObservations: [metric],
    baselineObservations: [],
    objectives: [{ experimentId: "experiment-main", metricName: "accuracy", direction: "maximize" as const }],
    analysisId: "analysis-persisted-facts",
  };
  const report = createExperimentAnalysisReport(input);
  assert.equal(report.aggregates[0]?.routeId, "persisted-route");

  assert.throws(
    () => createExperimentAnalysisReport({
      ...input,
      trialDescriptors: [{
        attemptId: run.artifactId,
        routeId: "caller-override",
        parameters: { depth: 1 },
        slices: { domain: "train" },
        costUsd: 99,
        wallTimeMs: 1,
      }],
    }),
    /cannot override persisted run facts/u,
  );
});

test("early stopping and exhausted budgets block deterministic proposals without executing them", () => {
  const values = [1, 1.05, 1.04];
  const metrics = values.map((value, index) => metricObservation({
    observationId: `metric-stop-${index}`,
    runAttemptId: `attempt-stop-${index}`,
    value,
    observedAt: `2026-07-25T08:0${index}:30.000Z`,
  }));
  const runs = metrics.map((metric, index) => runAttempt({
    attemptId: `attempt-stop-${index}`,
    metricObservationIds: [metric.artifactId],
    preparedAt: `2026-07-25T08:0${index}:00.000Z`,
    startedAt: `2026-07-25T08:0${index}:00.000Z`,
    finishedAt: `2026-07-25T08:0${index}:30.000Z`,
  }));
  const common = {
    runAttempts: runs,
    metricObservations: metrics,
    baselineObservations: [],
    trialDescriptors: runs.map((run, index) => ({
      attemptId: run.artifactId,
      routeId: "route-stop",
      parameters: { step: index },
    })),
    objectives: [{ experimentId: "experiment-main", metricName: "accuracy", direction: "maximize" as const }],
    earlyStop: {
      objective: { experimentId: "experiment-main", metricName: "accuracy", direction: "maximize" as const },
      routeId: "route-stop",
      patience: 2,
      minimumImprovement: 0.1,
      minimumMeasuredRuns: 3,
    },
    searchSpace: {
      routeId: "route-stop",
      parameters: [{ name: "step", values: [0, 1, 2, 3] }],
    },
    now: ANALYSIS_TEST_NOW,
  };
  const stopped = createExperimentAnalysisReport({
    ...common,
    budget: { maxAttempts: 10 },
    analysisId: "analysis-stopped",
  });
  assert.equal(stopped.optimization.earlyStop.status, "stop_recommended");
  assert.equal(stopped.optimization.earlyStop.nonImprovingTail, 2);
  assert.deepEqual(stopped.optimization.blockedReasons, ["early_stop_recommended"]);
  assert.equal(stopped.optimization.proposals.length, 0);

  const exhausted = createExperimentAnalysisReport({
    ...common,
    budget: { maxAttempts: 3 },
    analysisId: "analysis-exhausted",
  });
  assert.equal(exhausted.optimization.earlyStop.status, "budget_exhausted");
  assert.equal(exhausted.optimization.budget.remainingAttempts, 0);
  assert.deepEqual(exhausted.optimization.blockedReasons, ["budget_exhausted"]);
});

test("candidate survey keeps external runtimes as audit evidence rather than hidden dependencies", () => {
  const optuna = EXPERIMENT_ANALYSIS_CANDIDATE_SURVEY.candidates.find((candidate) => candidate.name === "Optuna");
  const mlflow = EXPERIMENT_ANALYSIS_CANDIDATE_SURVEY.candidates.find((candidate) => candidate.name === "MLflow");
  assert.equal(optuna?.adoption, "excluded");
  assert.match(optuna?.inspectedVersion ?? "", /^[a-f0-9]{40}$/u);
  assert.equal(mlflow?.adoption, "query_shape_reuse");
  assert.match(EXPERIMENT_ANALYSIS_CANDIDATE_SURVEY.decision.statistics, /pure TypeScript deterministic core/u);
});

function routeFixtures(): Readonly<{
  runs: readonly RunAttempt[];
  metrics: readonly MetricObservation[];
  descriptors: readonly Readonly<{
    attemptId: string;
    routeId: string;
    parameters: Readonly<{ depth: number }>;
    slices: Readonly<{ noise: string }>;
    costUsd: number;
    wallTimeMs: number;
  }>[];
}> {
  const definitions = [
    { id: "a1", route: "route-a", accuracy: 0.8, latency: 100, depth: 1, noise: "clean" },
    { id: "a2", route: "route-a", accuracy: 0.9, latency: 110, depth: 2, noise: "noisy" },
    { id: "b1", route: "route-b", accuracy: 0.86, latency: 95, depth: 1, noise: "clean" },
    { id: "b2", route: "route-b", accuracy: 0.88, latency: 90, depth: 2, noise: "noisy" },
    { id: "c1", route: "route-c", accuracy: 0.7, latency: 120, depth: 1, noise: "clean" },
  ] as const;
  const metrics: MetricObservation[] = [];
  const runs: RunAttempt[] = [];
  for (const [index, definition] of definitions.entries()) {
    const accuracy = metricObservation({
      observationId: `metric-${definition.id}-accuracy`,
      runAttemptId: `attempt-${definition.id}`,
      value: definition.accuracy,
    });
    const latency = metricObservation({
      observationId: `metric-${definition.id}-latency`,
      runAttemptId: `attempt-${definition.id}`,
      name: "latency",
      value: definition.latency,
      direction: "minimize",
      unit: "ms",
    });
    metrics.push(accuracy, latency);
    runs.push(runAttempt({
      attemptId: `attempt-${definition.id}`,
      revision: definition.id === "a1" ? 2 : 1,
      metricObservationIds: [accuracy.artifactId, latency.artifactId],
      startedAt: `2026-07-25T08:0${index}:00.000Z`,
      finishedAt: `2026-07-25T08:0${index}:30.000Z`,
    }));
  }
  return Object.freeze({
    runs: Object.freeze(runs),
    metrics: Object.freeze(metrics),
    descriptors: Object.freeze(definitions.map((definition) => Object.freeze({
      attemptId: `attempt-${definition.id}`,
      routeId: definition.route,
      parameters: Object.freeze({ depth: definition.depth }),
      slices: Object.freeze({ noise: definition.noise }),
      costUsd: 1,
      wallTimeMs: 30_000,
    }))),
  });
}
