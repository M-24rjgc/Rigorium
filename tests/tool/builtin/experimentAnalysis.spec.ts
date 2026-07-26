import assert from "node:assert/strict";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import test, { after } from "node:test";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import {
  issueExecutionGrant,
  saveExperimentSpec,
  submitLocalExperimentRun,
} from "../../../src/research/experimentation/index.js";
import { createExperimentAnalysisTool } from "../../../src/tool/builtin/experimentAnalysis.js";
import { RigoriumToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { RigoriumToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import {
  ANALYSIS_TEST_NOW,
  metricObservation,
  runAttempt,
} from "../../research/experimentation/analysis/fixtures.js";

const ledgerRoots = new Set<string>();

after(async () => {
  for (const root of ledgerRoots) await removeLedgerRoot(root);
});

function context(cwd = "D:\\synthetic-project"): RigoriumToolRuntimeContext {
  return {
    sessionId: "experiment-analysis-tool-test",
    turnId: "turn-1",
    cwd,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd }),
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
    (error: unknown) => error instanceof RigoriumToolRuntimeError
      && error.code === "invalid_tool_input"
      && /contentHash does not match/u.test(error.message),
  );
});

test("experiment_analysis defaults to the persisted project ledger and rejects caller overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-experiment-analysis-ledger-"));
  ledgerRoots.add(root);
  await saveExperimentSpec({
    projectRoot: root,
    spec: {
      experimentId: "experiment-ledger",
      title: "Ledger analysis",
      expectedMetrics: ["accuracy"],
      localWorker: { kind: "mock", result: { metrics: [{ name: "accuracy", value: 0.92, direction: "maximize" }] } },
    },
  });
  const grant = await issueExecutionGrant({
    projectRoot: root,
    grant: {
      grantId: "grant-ledger-analysis",
      experimentId: "experiment-ledger",
      mode: "budget_auto",
      reason: "Persist analysis facts",
      budget: { maxAttempts: 1 },
    },
  });
  await submitLocalExperimentRun({
    projectRoot: root,
    experimentId: "experiment-ledger",
    grantId: grant.value.payload.grantId,
    jobId: "job-ledger-analysis",
    run: {
      routeId: "ledger-route",
      parameters: { seed: 11 },
      slices: { split: "heldout" },
    },
  });
  const tool = createExperimentAnalysisTool();
  const input = {
    objectives: [{ experimentId: "experiment-ledger", metricName: "accuracy", direction: "maximize" as const }],
    analysisId: "analysis-from-ledger",
  };
  const output = await tool.execute(input as never, context(root));
  assert.equal(output.data?.aggregates[0]?.routeId, "ledger-route");

  await assert.rejects(
    tool.execute({
      ...input,
      trialDescriptors: [{ attemptId: "run-caller", routeId: "caller-route" }],
    } as never, context(root)),
    (error: unknown) => error instanceof RigoriumToolRuntimeError
      && error.code === "invalid_tool_input"
      && /trialDescriptors/u.test(error.message),
  );
});

async function removeLedgerRoot(root: string): Promise<void> {
  const temporaryRoot = await realpath(tmpdir());
  const resolvedRoot = await realpath(root);
  const relativePath = relative(temporaryRoot, resolvedRoot);
  const stats = await lstat(resolvedRoot);
  assert.equal(
    relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath)
      && basename(resolvedRoot).startsWith("rigorium-experiment-analysis-ledger-")
      && stats.isDirectory() && !stats.isSymbolicLink(),
    true,
    `Refusing to clean an unvalidated ledger test root: ${resolvedRoot}`,
  );
  await rm(resolvedRoot, { recursive: true, force: false });
}
