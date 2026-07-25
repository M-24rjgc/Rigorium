import assert from "node:assert/strict";
import test from "node:test";
import { validateExperimentAnalysisInput } from "../../../../src/research/experimentation/analysis/validation.js";
import {
  failure,
  metricObservation,
  observedBaseline,
  reportedBaseline,
  runAttempt,
} from "./fixtures.js";

test("validation selects the latest run revision and retains older refs", () => {
  const metric = metricObservation({ observationId: "metric-current", runAttemptId: "attempt-current", value: 0.9 });
  const older = runAttempt({
    attemptId: "attempt-current",
    revision: 1,
    status: "running",
    metricObservationIds: [],
  });
  const latest = runAttempt({
    attemptId: "attempt-current",
    revision: 2,
    status: "succeeded",
    metricObservationIds: [metric.artifactId],
  });
  const baseline = reportedBaseline({ baselineId: "baseline-paper", value: 0.8 });

  const validated = validateExperimentAnalysisInput({
    runAttempts: [older, latest],
    metricObservations: [metric],
    baselineObservations: [baseline],
    objectives: [{ experimentId: "experiment-main", metricName: "accuracy", direction: "maximize" }],
  });

  assert.equal(validated.runAttempts.length, 1);
  assert.equal(validated.runAttempts[0]?.revision, 2);
  assert.deepEqual(validated.ignoredRunRevisionRefs.map((ref) => `${ref.artifactId}@${ref.revision}`), ["attempt-current@1"]);
  assert.deepEqual(validated.metricObservations.map((entry) => entry.artifactId), ["metric-current"]);
  assert.deepEqual(validated.baselineObservations.map((entry) => entry.artifactId), ["baseline-paper"]);
});

test("validation excludes bad measurement links and records a complete issue taxonomy", () => {
  const valid = metricObservation({ observationId: "metric-valid", runAttemptId: "attempt-valid", value: 0.9 });
  const missingRun = metricObservation({ observationId: "metric-orphan", runAttemptId: "attempt-missing", value: 0.1 });
  const failedMetric = metricObservation({ observationId: "metric-failed", runAttemptId: "attempt-failed", value: 0.2 });
  const unlisted = metricObservation({ observationId: "metric-unlisted", runAttemptId: "attempt-valid", value: 0.3 });
  const validRun = runAttempt({
    attemptId: "attempt-valid",
    status: "succeeded",
    metricObservationIds: [valid.artifactId],
  });
  const failedRun = runAttempt({
    attemptId: "attempt-failed",
    status: "failed",
    metricObservationIds: [failedMetric.artifactId],
    failure: failure("timeout", true),
  });
  const validObserved = observedBaseline({
    baselineId: "baseline-valid-observed",
    runAttemptId: validRun.artifactId,
    metricObservationId: valid.artifactId,
    value: valid.payload.value,
  });
  const missingObservedRun = observedBaseline({
    baselineId: "baseline-missing-run",
    runAttemptId: "attempt-missing",
    metricObservationId: valid.artifactId,
    value: valid.payload.value,
  });
  const missingObservedMetric = observedBaseline({
    baselineId: "baseline-missing-metric",
    runAttemptId: validRun.artifactId,
    metricObservationId: "metric-missing",
    value: valid.payload.value,
  });
  const mismatchedObserved = observedBaseline({
    baselineId: "baseline-mismatch",
    runAttemptId: validRun.artifactId,
    metricObservationId: valid.artifactId,
    value: 0.8,
  });

  const validated = validateExperimentAnalysisInput({
    runAttempts: [validRun, failedRun],
    metricObservations: [valid, missingRun, failedMetric, unlisted],
    baselineObservations: [validObserved, missingObservedRun, missingObservedMetric, mismatchedObserved],
    objectives: [{ experimentId: "experiment-main", metricName: "accuracy", direction: "maximize" }],
  });

  assert.deepEqual(validated.metricObservations.map((entry) => entry.artifactId), ["metric-valid"]);
  assert.deepEqual(validated.baselineObservations.map((entry) => entry.artifactId), ["baseline-valid-observed"]);
  assert.deepEqual(new Set(validated.dataIssues.map((issue) => issue.code)), new Set([
    "metric_missing_run",
    "metric_from_unsuccessful_run",
    "metric_not_listed_by_run",
    "observed_baseline_missing_run",
    "observed_baseline_missing_metric",
    "observed_baseline_mismatch",
  ]));
});

test("validation rejects corrupt envelopes, ambiguous objectives, and unknown input fields", () => {
  const metric = metricObservation({ observationId: "metric-corrupt", runAttemptId: "attempt-corrupt", value: 0.9 });
  const run = runAttempt({
    attemptId: "attempt-corrupt",
    metricObservationIds: [metric.artifactId],
  });
  const corruptMetric = { ...metric, contentHash: `sha256:${"0".repeat(64)}` };
  assert.throws(() => validateExperimentAnalysisInput({
    runAttempts: [run],
    metricObservations: [corruptMetric],
    baselineObservations: [],
    objectives: [{ experimentId: "experiment-main", metricName: "accuracy", direction: "maximize" }],
  }), /contentHash does not match/u);

  assert.throws(() => validateExperimentAnalysisInput({
    runAttempts: [run],
    metricObservations: [metric],
    baselineObservations: [],
    objectives: [
      { experimentId: "experiment-main", metricName: "accuracy", direction: "maximize" },
      { experimentId: "experiment-main", metricName: "accuracy", direction: "minimize" },
    ],
  }), /Objective accuracy is duplicated/u);

  assert.throws(() => validateExperimentAnalysisInput({
    runAttempts: [run],
    metricObservations: [metric],
    baselineObservations: [],
    objectives: [{ experimentId: "experiment-main", metricName: "accuracy", direction: "maximize" }],
    projectRoot: "outside",
  }), /does not accept projectRoot/u);

  assert.throws(() => validateExperimentAnalysisInput({
    runAttempts: [run],
    metricObservations: [metric],
    baselineObservations: [],
    objectives: [{ experimentId: "experiment-main", metricName: "accuracy", direction: "maximize" }],
    searchSpace: {
      routeId: "route-large",
      parameters: [
        { name: "left", values: Array.from({ length: 400 }, (_, index) => index) },
        { name: "right", values: Array.from({ length: 400 }, (_, index) => index) },
      ],
    },
  }), /cannot exceed 100000 discrete combinations/u);
});
