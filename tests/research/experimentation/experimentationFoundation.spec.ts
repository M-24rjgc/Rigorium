import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExperimentServiceError,
  confirmExecutionJob,
  issueExecutionGrant,
  listExperimentAdapters,
  loadExperimentManifest,
  prepareExperimentRun,
  recordObservedBaseline,
  recordReportedBaseline,
  recoverExperimentJob,
  saveExperimentSpec,
  submitLocalExperimentRun,
} from "../../../src/research/experimentation/index.js";

async function projectRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `rigorium-experiment-${label}-`));
}

async function createSpec(root: string, options: {
  experimentId?: string;
  worker?: Parameters<typeof saveExperimentSpec>[0]["spec"]["localWorker"];
} = {}) {
  return saveExperimentSpec({
    projectRoot: root,
    spec: {
      experimentId: options.experimentId ?? "experiment-main",
      title: "Calibrated local evaluation",
      expectedMetrics: ["accuracy"],
      localWorker: options.worker ?? {
        kind: "mock",
        result: {
          metrics: [{ name: "accuracy", value: 0.91, direction: "maximize" }],
          artifacts: [{ path: "metrics/table.txt", content: "accuracy=0.91\n", role: "table", mediaType: "text/plain" }],
        },
      },
    },
  });
}

async function createGrant(root: string, mode: "plan_only" | "confirm_each" | "budget_auto", maxAttempts = 1) {
  return issueExecutionGrant({
    projectRoot: root,
    grant: {
      grantId: `grant-${mode}`,
      experimentId: "experiment-main",
      mode,
      reason: "Focused experimentation test",
      budget: { maxAttempts },
    },
  });
}

test("persists envelope-backed specs and defaults paper baselines to reported, not rerun", async () => {
  const root = await projectRoot("reported-baseline");
  const spec = await createSpec(root);
  assert.equal(spec.value.kind, "experiment_spec");
  assert.equal(spec.value.payload.defaultGrantMode, "plan_only");

  const baseline = await recordReportedBaseline({
    projectRoot: root,
    baseline: {
      baselineId: "baseline-paper",
      experimentId: "experiment-main",
      metricName: "accuracy",
      reportedValue: 0.89,
      direction: "maximize",
      citation: { text: "Doe et al. (2025), Table 2", doi: "10.1000/example" },
    },
  });
  assert.equal(baseline.value.kind, "baseline_observation");
  assert.deepEqual(baseline.value.payload.provenance, {
    kind: "reported",
    citation: { text: "Doe et al. (2025), Table 2", doi: "10.1000/example" },
    rerunStatus: "not_rerun",
  });
  assert.equal(baseline.manifest.runAttempts.length, 0);

  const reloaded = await loadExperimentManifest({ projectRoot: root });
  assert.equal(reloaded?.baselineObservations.length, 1);
  assert.match(await readFile(spec.path, "utf8"), /"experiment_manifest"/u);
});

test("plan_only can prepare a manifest but cannot submit a worker", async () => {
  const root = await projectRoot("plan-only");
  await createSpec(root);
  const grant = await createGrant(root, "plan_only");
  const prepared = await prepareExperimentRun({
    projectRoot: root,
    experimentId: "experiment-main",
    grantId: grant.value.payload.grantId,
    jobId: "job-plan-only",
  });
  assert.equal(prepared.value.payload.status, "prepared");
  await assert.rejects(
    submitLocalExperimentRun({
      projectRoot: root,
      experimentId: "experiment-main",
      grantId: grant.value.payload.grantId,
      jobId: "job-plan-only",
      attemptId: prepared.value.payload.attemptId,
    }),
    (error: unknown) => error instanceof ExperimentServiceError && error.code === "permission_denied",
  );
  const manifest = await loadExperimentManifest({ projectRoot: root });
  assert.equal(manifest?.runAttempts.at(-1)?.payload.status, "prepared");
});

test("confirm_each requires the exact job confirmation and deduplicates later submissions", async () => {
  const root = await projectRoot("confirm-each");
  await createSpec(root);
  const grant = await createGrant(root, "confirm_each");
  const prepared = await prepareExperimentRun({
    projectRoot: root,
    experimentId: "experiment-main",
    grantId: grant.value.payload.grantId,
    jobId: "job-confirmed",
  });
  await assert.rejects(
    submitLocalExperimentRun({
      projectRoot: root,
      experimentId: "experiment-main",
      grantId: grant.value.payload.grantId,
      jobId: "job-confirmed",
      attemptId: prepared.value.payload.attemptId,
    }),
    (error: unknown) => error instanceof ExperimentServiceError && error.code === "permission_denied",
  );

  await confirmExecutionJob({ projectRoot: root, grantId: grant.value.payload.grantId, jobId: "job-confirmed" });
  const completed = await submitLocalExperimentRun({
    projectRoot: root,
    experimentId: "experiment-main",
    grantId: grant.value.payload.grantId,
    jobId: "job-confirmed",
    attemptId: prepared.value.payload.attemptId,
  });
  assert.equal(completed.value.payload.status, "succeeded");
  assert.equal(completed.manifest.metricObservations[0]?.payload.source, "local_mock");
  assert.equal(completed.manifest.artifactFiles[0]?.role, "table");
  assert.match(completed.manifest.artifactRefs[0]?.contentHash ?? "", /^sha256:[a-f0-9]{64}$/u);

  const duplicate = await submitLocalExperimentRun({
    projectRoot: root,
    experimentId: "experiment-main",
    grantId: grant.value.payload.grantId,
    jobId: "job-confirmed",
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.value.payload.attemptId, completed.value.payload.attemptId);
  const latestJobRuns = duplicate.manifest.runAttempts.filter((run) => run.payload.jobId === "job-confirmed");
  assert.equal(new Set(latestJobRuns.map((run) => run.artifactId)).size, 1);

  const observed = await recordObservedBaseline({
    projectRoot: root,
    baseline: {
      baselineId: "baseline-observed",
      experimentId: "experiment-main",
      runAttemptId: completed.value.payload.attemptId,
      metricObservationId: completed.manifest.metricObservations[0]!.artifactId,
    },
  });
  assert.deepEqual(observed.value.payload.provenance, {
    kind: "observed",
    runAttemptId: completed.value.payload.attemptId,
    metricObservationId: completed.manifest.metricObservations[0]!.artifactId,
  });
});

test("budget_auto stops after its attempt budget while retaining the next plan", async () => {
  const root = await projectRoot("budget");
  await createSpec(root);
  const grant = await createGrant(root, "budget_auto", 1);
  const first = await submitLocalExperimentRun({
    projectRoot: root,
    experimentId: "experiment-main",
    grantId: grant.value.payload.grantId,
    jobId: "job-budget-1",
  });
  assert.equal(first.value.payload.status, "succeeded");
  const second = await prepareExperimentRun({
    projectRoot: root,
    experimentId: "experiment-main",
    grantId: grant.value.payload.grantId,
    jobId: "job-budget-2",
  });
  await assert.rejects(
    submitLocalExperimentRun({
      projectRoot: root,
      experimentId: "experiment-main",
      grantId: grant.value.payload.grantId,
      jobId: "job-budget-2",
      attemptId: second.value.payload.attemptId,
    }),
    (error: unknown) => error instanceof ExperimentServiceError && error.code === "permission_denied",
  );
});

test("concurrent submissions with one jobId acquire only one worker claim", async () => {
  const root = await projectRoot("concurrent-idempotency");
  await createSpec(root, {
    worker: { kind: "mock", delayMs: 80, result: { metrics: [{ name: "accuracy", value: 0.95 }] } },
  });
  const grant = await createGrant(root, "budget_auto", 2);
  const submit = () => submitLocalExperimentRun({
    projectRoot: root,
    experimentId: "experiment-main",
    grantId: grant.value.payload.grantId,
    jobId: "job-concurrent",
  });
  const results = await Promise.all([submit(), submit()]);
  assert.equal(results.filter((result) => result.duplicate === true).length, 1);
  const manifest = await loadExperimentManifest({ projectRoot: root });
  const attempts = manifest?.runAttempts.filter((run) => run.payload.jobId === "job-concurrent") ?? [];
  assert.equal(new Set(attempts.map((run) => run.artifactId)).size, 1);
  assert.equal(manifest?.metricObservations.length, 1);
  const grantLatest = [...(manifest?.executionGrants ?? [])]
    .filter((entry) => entry.artifactId === grant.value.artifactId)
    .sort((left, right) => right.revision - left.revision)[0];
  assert.deepEqual(grantLatest?.payload.consumedJobIds, ["job-concurrent"]);
});

test("process workers run without a shell in a dedicated directory and emit metric/artifact envelopes", async () => {
  const root = await projectRoot("process-worker");
  const script = [
    "const fs=require('node:fs');",
    "fs.writeFileSync('worker-output.txt','worker-ok\\n','utf8');",
    "fs.writeFileSync(process.env.RIGORIUM_EXPERIMENT_OUTPUT,JSON.stringify({metrics:[{name:'loss',value:0.2,direction:'minimize'}],artifacts:[{path:'worker-output.txt',role:'output',mediaType:'text/plain'}]}),'utf8');",
  ].join("");
  await createSpec(root, {
    worker: { kind: "process", command: process.execPath, args: ["-e", script], timeoutMs: 10_000 },
  });
  const grant = await createGrant(root, "budget_auto");
  const completed = await submitLocalExperimentRun({
    projectRoot: root,
    experimentId: "experiment-main",
    grantId: grant.value.payload.grantId,
    jobId: "job-process",
  });
  assert.equal(completed.value.payload.status, "succeeded");
  assert.equal(completed.manifest.metricObservations[0]?.payload.name, "loss");
  assert.equal(completed.manifest.artifactFiles.some((file) => file.relativePath === "worker-output.txt"), true);
});

test("recovery is idempotent by jobId and never launches a second worker", async () => {
  const root = await projectRoot("recovery");
  await createSpec(root, { worker: { kind: "mock", delayMs: 250, result: { metrics: [{ name: "accuracy", value: 1 }] } } });
  const grant = await createGrant(root, "budget_auto");
  const runningPromise = submitLocalExperimentRun({
    projectRoot: root,
    experimentId: "experiment-main",
    grantId: grant.value.payload.grantId,
    jobId: "job-recover",
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
  const recovered = await recoverExperimentJob({ projectRoot: root, jobId: "job-recover" });
  assert.equal(recovered.payload.status, "recovery_required");
  assert.equal(recovered.payload.failure?.category, "disconnected");
  const recoveredAgain = await recoverExperimentJob({ projectRoot: root, jobId: "job-recover" });
  assert.equal(recoveredAgain.artifactId, recovered.artifactId);
  assert.equal(recoveredAgain.revision, recovered.revision);
  await runningPromise.catch(() => undefined);
  const manifest = await loadExperimentManifest({ projectRoot: root });
  const jobArtifacts = new Set(manifest?.runAttempts.filter((run) => run.payload.jobId === "job-recover").map((run) => run.artifactId));
  assert.equal(jobArtifacts.size, 1);
});

test("failure taxonomy preserves preemption, OOM, rate-limit, and disconnect states", async () => {
  for (const category of ["preempted", "out_of_memory", "rate_limited", "disconnected"] as const) {
    const root = await projectRoot(category);
    await createSpec(root, { worker: { kind: "mock", outcome: "fail", failureCategory: category, failureMessage: category } });
    const grant = await createGrant(root, "budget_auto");
    const failed = await submitLocalExperimentRun({
      projectRoot: root,
      experimentId: "experiment-main",
      grantId: grant.value.payload.grantId,
      jobId: `job-${category}`,
    });
    assert.equal(failed.value.payload.status, "failed");
    assert.equal(failed.value.payload.failure?.category, category);
  }
});

test("candidate descriptors expose one local implementation and keep external control planes reserved", () => {
  const adapters = listExperimentAdapters();
  assert.equal(adapters.find((adapter) => adapter.id === "local")?.status, "implemented");
  for (const id of ["ssh", "slurm", "mlflow", "optuna", "dvc"] as const) {
    assert.equal(adapters.find((adapter) => adapter.id === id)?.status, "reserved");
  }
});
