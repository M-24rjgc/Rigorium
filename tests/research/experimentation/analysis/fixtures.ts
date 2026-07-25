import {
  createResearchArtifact,
  type ResearchArtifactProducer,
} from "../../../../src/research/artifacts/index.js";
import type {
  BaselineObservation,
  ExperimentFailure,
  ExperimentRunStatus,
  MetricDirection,
  MetricObservation,
  RunAttempt,
} from "../../../../src/research/experimentation/contracts.js";

export const ANALYSIS_TEST_NOW = new Date("2026-07-25T08:00:00.000Z");
export const ANALYSIS_TEST_PRODUCER: ResearchArtifactProducer = Object.freeze({
  kind: "tool",
  id: "experiment-analysis-fixture",
  toolName: "fixture",
});
export const TEST_SPEC_DIGEST = `sha256:${"a".repeat(64)}`;

export function runAttempt(input: {
  attemptId: string;
  experimentId?: string;
  revision?: number;
  status?: ExperimentRunStatus;
  metricObservationIds?: readonly string[];
  adapterId?: "local" | "ssh" | "slurm" | "mlflow" | "optuna" | "dvc";
  preparedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  failure?: ExperimentFailure;
}): RunAttempt {
  const status = input.status ?? "succeeded";
  return createResearchArtifact({
    kind: "run_attempt",
    artifactId: input.attemptId,
    revision: input.revision ?? 1,
    payload: {
      attemptId: input.attemptId,
      experimentId: input.experimentId ?? "experiment-main",
      specRevision: 1,
      specDigest: TEST_SPEC_DIGEST,
      adapterId: input.adapterId ?? "local",
      jobId: `job-${input.attemptId}`,
      status,
      grantMode: "budget_auto",
      preparedAt: input.preparedAt ?? ANALYSIS_TEST_NOW.toISOString(),
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
      artifactIds: [],
      metricObservationIds: [...(input.metricObservationIds ?? [])],
      ...(input.failure === undefined ? {} : { failure: input.failure }),
    },
    producer: ANALYSIS_TEST_PRODUCER,
    now: ANALYSIS_TEST_NOW,
  });
}

export function metricObservation(input: {
  observationId: string;
  runAttemptId: string;
  value: number;
  name?: string;
  experimentId?: string;
  direction?: MetricDirection;
  split?: string;
  unit?: string;
  observedAt?: string;
}): MetricObservation {
  return createResearchArtifact({
    kind: "metric_observation",
    artifactId: input.observationId,
    payload: {
      observationId: input.observationId,
      experimentId: input.experimentId ?? "experiment-main",
      runAttemptId: input.runAttemptId,
      name: input.name ?? "accuracy",
      value: input.value,
      ...(input.unit === undefined ? {} : { unit: input.unit }),
      ...(input.split === undefined ? {} : { split: input.split }),
      direction: input.direction ?? "maximize",
      observedAt: input.observedAt ?? ANALYSIS_TEST_NOW.toISOString(),
      source: "manual",
    },
    producer: ANALYSIS_TEST_PRODUCER,
    now: ANALYSIS_TEST_NOW,
  });
}

export function reportedBaseline(input: {
  baselineId: string;
  value: number;
  metricName?: string;
  experimentId?: string;
  direction?: MetricDirection;
  split?: string;
  unit?: string;
}): BaselineObservation {
  return createResearchArtifact({
    kind: "baseline_observation",
    artifactId: input.baselineId,
    payload: {
      baselineId: input.baselineId,
      experimentId: input.experimentId ?? "experiment-main",
      metricName: input.metricName ?? "accuracy",
      value: input.value,
      ...(input.unit === undefined ? {} : { unit: input.unit }),
      ...(input.split === undefined ? {} : { split: input.split }),
      direction: input.direction ?? "maximize",
      recordedAt: ANALYSIS_TEST_NOW.toISOString(),
      provenance: {
        kind: "reported",
        citation: { text: "Synthetic prior-work fixture, table 1." },
        rerunStatus: "not_rerun",
      },
    },
    producer: ANALYSIS_TEST_PRODUCER,
    now: ANALYSIS_TEST_NOW,
  });
}

export function observedBaseline(input: {
  baselineId: string;
  runAttemptId: string;
  metricObservationId: string;
  value: number;
  metricName?: string;
  experimentId?: string;
  direction?: MetricDirection;
  split?: string;
  unit?: string;
}): BaselineObservation {
  return createResearchArtifact({
    kind: "baseline_observation",
    artifactId: input.baselineId,
    payload: {
      baselineId: input.baselineId,
      experimentId: input.experimentId ?? "experiment-main",
      metricName: input.metricName ?? "accuracy",
      value: input.value,
      ...(input.unit === undefined ? {} : { unit: input.unit }),
      ...(input.split === undefined ? {} : { split: input.split }),
      direction: input.direction ?? "maximize",
      recordedAt: ANALYSIS_TEST_NOW.toISOString(),
      provenance: {
        kind: "observed",
        runAttemptId: input.runAttemptId,
        metricObservationId: input.metricObservationId,
      },
    },
    producer: ANALYSIS_TEST_PRODUCER,
    now: ANALYSIS_TEST_NOW,
  });
}

export function failure(category: ExperimentFailure["category"], retryable = false): ExperimentFailure {
  return Object.freeze({
    category,
    message: `Synthetic ${category} failure.`,
    retryable,
    observedAt: ANALYSIS_TEST_NOW.toISOString(),
  });
}

export function sha256(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
