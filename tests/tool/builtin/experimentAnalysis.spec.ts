import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { createExperimentAnalysisTool } from "../../../src/tool/builtin/experimentAnalysis.js";
import { PilotDeckToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import {
  ANALYSIS_TEST_NOW,
  metricObservation,
  runAttempt,
} from "../../research/experimentation/analysis/fixtures.js";

function context(): PilotDeckToolRuntimeContext {
  return {
    sessionId: "experiment-analysis-tool-test",
    turnId: "turn-1",
    cwd: "D:\\synthetic-project",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: "D:\\synthetic-project" }),
    now: () => ANALYSIS_TEST_NOW,
  };
}

function validInput() {
  const metric = metricObservation({
    observationId: "metric-tool",
    runAttemptId: "attempt-tool",
    value: 0.9,
  });
  const run = runAttempt({
    attemptId: "attempt-tool",
    metricObservationIds: [metric.artifactId],
  });
  return {
    runAttempts: [run],
    metricObservations: [metric],
    baselineObservations: [],
    trialDescriptors: [{ attemptId: run.artifactId, routeId: "tool-route" }],
    objectives: [{ experimentId: "experiment-main", metricName: "accuracy", direction: "maximize" as const }],
    analysisId: "analysis-tool",
  };
}

test("experiment_analysis is read-only and returns the immutable report", async () => {
  const tool = createExperimentAnalysisTool();
  const input = validInput();
  assert.equal(tool.isReadOnly(input), true);
  assert.equal(tool.isConcurrencySafe(input), true);
  assert.equal(tool.isDestructive?.(input), false);
  assert.equal(tool.requiresUserInteraction?.(input), false);
  assert.equal(tool.isOpenWorld?.(input), false);

  const validation = await tool.validateInput!(input, context());
  assert.equal(validation.ok, true);
  const output = await tool.execute(input, context());
  assert.equal(output.data?.analysisId, "analysis-tool");
  assert.equal(output.data?.aggregates[0]?.routeId, "tool-route");
  assert.equal(output.data?.provenancePolicy.filesWritten, false);
  assert.equal(output.metadata?.aggregateCount, 1);
});

test("experiment_analysis rejects host metadata, unknown fields, and corrupt envelopes", async () => {
  const tool = createExperimentAnalysisTool();
  const producerValidation = await tool.validateInput!({
    ...validInput(),
    producer: { kind: "user" },
  } as never, context());
  assert.equal(producerValidation.ok, false);
  if (producerValidation.ok) assert.fail("expected producer rejection");
  assert.match(producerValidation.issues[0]?.message ?? "", /does not accept producer or now/u);

  const projectValidation = await tool.validateInput!({ ...validInput(), projectRoot: "D:\\outside" } as never, context());
  assert.equal(projectValidation.ok, false);
  if (projectValidation.ok) assert.fail("expected unknown field rejection");
  assert.match(projectValidation.issues[0]?.message ?? "", /does not accept projectRoot/u);

  const corrupt = validInput();
  const corruptMetric = { ...corrupt.metricObservations[0]!, contentHash: `sha256:${"0".repeat(64)}` };
  await assert.rejects(
    tool.execute({ ...corrupt, metricObservations: [corruptMetric] }, context()),
    (error: unknown) => error instanceof PilotDeckToolRuntimeError
      && error.code === "invalid_tool_input"
      && /contentHash does not match/u.test(error.message),
  );
});
