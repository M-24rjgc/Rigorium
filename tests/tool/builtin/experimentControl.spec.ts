import assert from "node:assert/strict";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import test, { after } from "node:test";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { getProjectExperimentPaths, loadExperimentManifest } from "../../../src/research/experimentation/index.js";
import { createExperimentControlTool } from "../../../src/tool/builtin/experimentControl.js";
import { PilotDeckToolRuntimeError } from "../../../src/tool/protocol/errors.js";

const TEST_ROOT_PREFIX = "rigorium-experiment-tool-";
const testRoots = new Set<string>();

after(async () => {
  for (const root of [...testRoots].reverse()) await removeValidatedTestRoot(root);
});

test("experiment_control fixes storage to cwd and lists the current project manifest", async () => {
  const root = await projectRoot("isolation");
  const outside = await projectRoot("outside");
  const tool = createExperimentControlTool();
  const runtime = context(root);
  const invalid = await tool.validateInput!({
    operation: "spec",
    projectRoot: outside,
    spec: { experimentId: "experiment-isolated", title: "Isolated experiment" },
  } as never, runtime);
  assert.equal(invalid.ok, false);

  const saved = await tool.execute({
    operation: "spec",
    spec: {
      experimentId: "experiment-isolated",
      title: "Isolated experiment",
      expectedMetrics: ["accuracy"],
      localWorker: { kind: "mock", result: { metrics: [{ name: "accuracy", value: 0.9 }] } },
    },
  }, runtime);
  assert.equal(saved.data?.artifact?.kind, "experiment_spec");
  assert.equal(saved.data?.manifestPath, getProjectExperimentPaths({ projectRoot: root }).manifestPath);
  assert.equal(await loadExperimentManifest({ projectRoot: outside }), undefined);

  const listed = await tool.execute({ operation: "list" }, runtime);
  assert.equal(listed.data?.manifest?.specs.length, 1);
  assert.equal(listed.data?.adapters?.find((adapter) => adapter.id === "local")?.status, "implemented");
  assert.equal(tool.isReadOnly({ operation: "list" }), true);
  assert.equal(tool.isReadOnly({ operation: "spec", spec: { title: "x" } }), false);
});

test("experiment_control enforces plan_only, confirm_each, and budget_auto grants", async () => {
  const root = await projectRoot("grant-modes");
  const tool = createExperimentControlTool();
  const runtime = context(root);
  await tool.execute({
    operation: "spec",
    spec: {
      experimentId: "experiment-main",
      title: "Grant-mode experiment",
      localWorker: { kind: "mock", result: { metrics: [{ name: "accuracy", value: 0.93, direction: "maximize" }] } },
    },
  }, runtime);
  const reported = await tool.execute({
    operation: "baseline",
    baseline: {
      kind: "reported",
      baselineId: "baseline-reported",
      experimentId: "experiment-main",
      metricName: "accuracy",
      reportedValue: 0.88,
      citation: { text: "Prior work, Table 2" },
    },
  }, runtime);
  assert.equal((reported.data?.artifact?.payload as { provenance?: { kind?: string } }).provenance?.kind, "reported");

  const unconfirmedAutomaticGrant = await tool.validateInput!({
    operation: "grant",
    grant: {
      grantId: "grant-auto-unconfirmed",
      experimentId: "experiment-main",
      mode: "budget_auto",
      reason: "Must be explicitly approved",
      budget: { maxAttempts: 1 },
    },
  }, runtime);
  assert.equal(unconfirmedAutomaticGrant.ok, false);
  assert.equal(tool.requiresUserInteraction?.({
    operation: "grant",
    grant: {
      grantId: "grant-auto-metadata",
      experimentId: "experiment-main",
      mode: "budget_auto",
      reason: "Metadata check",
      budget: { maxAttempts: 1 },
    },
  }), true);
  assert.equal(tool.requiresUserInteraction?.({
    operation: "grant",
    grant: {
      grantId: "grant-plan-metadata",
      experimentId: "experiment-main",
      mode: "plan_only",
      reason: "Metadata check",
      budget: { maxAttempts: 1 },
    },
  }), false);

  await grant(tool, runtime, "grant-plan", "plan_only", 1);
  const planned = await tool.execute({
    operation: "prepare",
    experimentId: "experiment-main",
    grantId: "grant-plan",
    jobId: "job-plan",
  }, runtime);
  await assert.rejects(
    tool.execute({
      operation: "submit",
      experimentId: "experiment-main",
      grantId: "grant-plan",
      jobId: "job-plan",
      attemptId: planned.data?.artifact?.artifactId,
    }, runtime),
    isPermissionDenied,
  );

  await grant(tool, runtime, "grant-confirm", "confirm_each", 1);
  const prepared = await tool.execute({
    operation: "prepare",
    experimentId: "experiment-main",
    grantId: "grant-confirm",
    jobId: "job-confirm",
  }, runtime);
  await assert.rejects(
    tool.execute({
      operation: "submit",
      experimentId: "experiment-main",
      grantId: "grant-confirm",
      jobId: "job-confirm",
      attemptId: prepared.data?.artifact?.artifactId,
    }, runtime),
    isPermissionDenied,
  );
  const invalidConfirmation = await tool.validateInput!({
    operation: "confirm",
    grantId: "grant-confirm",
    jobId: "job-confirm",
  }, runtime);
  assert.equal(invalidConfirmation.ok, false);
  await tool.execute({ operation: "confirm", grantId: "grant-confirm", jobId: "job-confirm", confirmed: true }, runtime);
  const confirmed = await tool.execute({
    operation: "submit",
    experimentId: "experiment-main",
    grantId: "grant-confirm",
    jobId: "job-confirm",
    attemptId: prepared.data?.artifact?.artifactId,
  }, runtime);
  assert.equal((confirmed.data?.artifact?.payload as { status?: string }).status, "succeeded");

  await grant(tool, runtime, "grant-auto", "budget_auto", 1);
  const automatic = await tool.execute({
    operation: "submit",
    experimentId: "experiment-main",
    grantId: "grant-auto",
    jobId: "job-auto",
  }, runtime);
  assert.equal((automatic.data?.artifact?.payload as { status?: string }).status, "succeeded");
  assert.equal(tool.requiresUserInteraction?.({ operation: "confirm", grantId: "x", jobId: "x", confirmed: true }), true);
  assert.equal(tool.isOpenWorld?.({ operation: "submit", experimentId: "x", grantId: "x", jobId: "x" }), true);
});

test("experiment_control recovery records interruption without launching another worker", async () => {
  const root = await projectRoot("recovery");
  const tool = createExperimentControlTool();
  const runtime = context(root);
  await tool.execute({
    operation: "spec",
    spec: {
      experimentId: "experiment-recovery",
      title: "Recoverable experiment",
      localWorker: { kind: "mock", delayMs: 250, result: { metrics: [{ name: "score", value: 1 }] } },
    },
  }, runtime);
  await tool.execute({
    operation: "grant",
    confirmed: true,
    grant: {
      grantId: "grant-recovery",
      experimentId: "experiment-recovery",
      mode: "budget_auto",
      reason: "Recovery test",
      budget: { maxAttempts: 1 },
    },
  }, runtime);
  const running = tool.execute({
    operation: "submit",
    experimentId: "experiment-recovery",
    grantId: "grant-recovery",
    jobId: "job-recovery",
  }, runtime);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
  const recovered = await tool.execute({ operation: "recover", jobId: "job-recovery" }, runtime);
  assert.equal((recovered.data?.artifact?.payload as { status?: string }).status, "recovery_required");
  await running;
  const listed = await tool.execute({ operation: "list" }, runtime);
  const latest = listed.data?.manifest?.runAttempts
    .filter((attempt) => attempt.payload.jobId === "job-recovery")
    .sort((left, right) => right.revision - left.revision)[0];
  assert.equal(latest?.payload.status, "recovery_required");
});

async function grant(
  tool: ReturnType<typeof createExperimentControlTool>,
  runtime: ReturnType<typeof context>,
  grantId: string,
  mode: "plan_only" | "confirm_each" | "budget_auto",
  maxAttempts: number,
): Promise<void> {
  await tool.execute({
    operation: "grant",
    grant: { grantId, experimentId: "experiment-main", mode, reason: `${mode} test`, budget: { maxAttempts } },
    ...(mode === "budget_auto" ? { confirmed: true } : {}),
  }, runtime);
}

function context(root: string) {
  return {
    sessionId: "experiment-control-test-session",
    turnId: "experiment-control-test-turn",
    cwd: root,
    permissionMode: "default" as const,
    permissionContext: createDefaultPermissionContext({ cwd: root, canPrompt: true, bypassAvailable: true }),
    now: () => new Date(),
  };
}

function isPermissionDenied(error: unknown): boolean {
  return error instanceof PilotDeckToolRuntimeError && error.code === "permission_denied";
}

async function projectRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${TEST_ROOT_PREFIX}${label}-`));
  testRoots.add(root);
  return root;
}

async function removeValidatedTestRoot(root: string): Promise<void> {
  const temporaryRoot = await realpath(tmpdir());
  const resolvedRoot = await realpath(root);
  const relativePath = relative(temporaryRoot, resolvedRoot);
  const stats = await lstat(resolvedRoot);
  assert.equal(
    relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath)
      && basename(resolvedRoot).startsWith(TEST_ROOT_PREFIX) && stats.isDirectory() && !stats.isSymbolicLink(),
    true,
    `Refusing to clean an unvalidated test root: ${resolvedRoot}`,
  );
  await rm(resolvedRoot, { recursive: true, force: false });
}
