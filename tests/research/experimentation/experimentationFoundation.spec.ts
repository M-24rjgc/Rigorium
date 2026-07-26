import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import test, { after } from "node:test";
import {
  createResearchArtifact,
  toResearchArtifactRef,
} from "../../../src/research/artifacts/index.js";
import {
  ExperimentRepositoryError,
  ExperimentServiceError,
  confirmExecutionJob,
  getProjectExperimentPaths,
  issueExecutionGrant,
  listExperimentAdapters,
  loadExperimentManifest,
  prepareExperimentRun,
  recordObservedBaseline,
  recordReportedBaseline,
  recordExperimentRunCost,
  recoverExperimentJob,
  saveExperimentSpec,
  submitLocalExperimentRun,
} from "../../../src/research/experimentation/index.js";

const TEST_ROOT_PREFIX = "rigorium-experiment-";
const testRoots = new Set<string>();

async function projectRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${TEST_ROOT_PREFIX}${label}-`));
  testRoots.add(root);
  return root;
}

after(async () => {
  for (const root of [...testRoots].reverse()) await removeValidatedTestRoot(root);
});

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

function upstreamClosure() {
  const now = new Date("2026-07-25T00:00:00.000Z");
  const brief = createResearchArtifact({
    kind: "research_brief",
    artifactId: "brief-upstream",
    revision: 1,
    payload: { topic: "Source-aware experimentation" },
    producer: { kind: "tool", id: "research-design", toolName: "research_design" },
    now,
  });
  const method = createResearchArtifact({
    kind: "method_spec",
    artifactId: "method-upstream",
    revision: 1,
    payload: { method: "calibrated-evaluation" },
    producer: { kind: "tool", id: "research-method", toolName: "research_method" },
    parents: [{ relation: "uses", artifact: toResearchArtifactRef(brief) }],
    now,
  });
  const implementation = createResearchArtifact({
    kind: "implementation_snapshot",
    artifactId: "implementation-upstream",
    revision: 1,
    payload: { route: "reference-route" },
    producer: { kind: "tool", id: "research-method", toolName: "research_method" },
    parents: [{ relation: "derived_from", artifact: toResearchArtifactRef(method) }],
    now,
  });
  return { brief, method, implementation, now };
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

test("spec source parent closures are projected, revisioned, and restart-verifiable", async () => {
  const root = await projectRoot("source-closure");
  const { brief, method, implementation, now } = upstreamClosure();
  const sourceParents = [
    { relation: "uses" as const, artifact: toResearchArtifactRef(implementation) },
    { relation: "derived_from" as const, artifact: toResearchArtifactRef(method) },
  ];
  const specInput = {
    experimentId: "experiment-provenanced",
    title: "Provenanced evaluation",
    expectedMetrics: ["accuracy"],
    parents: sourceParents,
    sourceArtifacts: [implementation, method, brief, method],
  };

  const first = await saveExperimentSpec({ projectRoot: root, spec: specInput, now });
  assert.equal(first.value.revision, 1);
  assert.deepEqual(first.value.parents.map((parent) => parent.relation), ["derived_from", "uses"]);
  assert.equal(first.manifest.artifactEnvelopes.length, 3);

  const duplicate = await saveExperimentSpec({
    projectRoot: root,
    spec: {
      ...specInput,
      parents: [sourceParents[1]!, sourceParents[0]!, sourceParents[0]!],
      sourceArtifacts: [brief, method, implementation, brief],
    },
    now: new Date("2026-07-25T00:01:00.000Z"),
  });
  assert.equal(duplicate.value.revision, 1);
  assert.equal(duplicate.persisted, false);

  const implementationRevision = createResearchArtifact({
    kind: "implementation_snapshot",
    artifactId: "implementation-upstream-next",
    revision: 1,
    payload: { route: "revised-route" },
    producer: { kind: "tool", id: "research-method", toolName: "research_method" },
    parents: [{ relation: "derived_from", artifact: toResearchArtifactRef(method) }],
    now: new Date("2026-07-25T00:02:00.000Z"),
  });
  const revised = await saveExperimentSpec({
    projectRoot: root,
    spec: {
      ...specInput,
      parents: [{ relation: "uses", artifact: toResearchArtifactRef(implementationRevision) }],
      sourceArtifacts: [implementationRevision],
    },
    now: new Date("2026-07-25T00:03:00.000Z"),
  });
  assert.equal(revised.value.revision, 2);
  assert.equal(revised.value.parents.some((parent) => parent.relation === "uses"
    && parent.artifact.artifactId === implementationRevision.artifactId), true);
  assert.equal(revised.value.parents.some((parent) => parent.relation === "supersedes"
    && parent.artifact.contentHash === first.value.contentHash), true);
  assert.equal(revised.manifest.artifactEnvelopes.length, 4);

  const reloaded = await loadExperimentManifest({ projectRoot: root });
  assert.equal(reloaded?.specs.length, 2);
  assert.equal(reloaded?.artifactEnvelopes.length, 4);
});

test("spec revisions can reuse an already-projected upstream closure", async () => {
  const root = await projectRoot("reused-source-closure");
  const { brief, method, implementation, now } = upstreamClosure();
  const parent = { relation: "uses" as const, artifact: toResearchArtifactRef(implementation) };
  const first = await saveExperimentSpec({
    projectRoot: root,
    spec: {
      experimentId: "experiment-reused-provenance",
      title: "Initial provenanced evaluation",
      parents: [parent],
      sourceArtifacts: [implementation, method, brief],
    },
    now,
  });

  const revised = await saveExperimentSpec({
    projectRoot: root,
    spec: {
      experimentId: "experiment-reused-provenance",
      title: "Revised provenanced evaluation",
      parents: [parent],
    },
    now: new Date("2026-07-25T00:01:00.000Z"),
  });

  assert.equal(revised.value.revision, 2);
  assert.equal(revised.manifest.artifactEnvelopes.length, 3);
  assert.equal(revised.value.parents.some((entry) => entry.relation === "uses"
    && entry.artifact.contentHash === implementation.contentHash), true);
  assert.equal(revised.value.parents.some((entry) => entry.relation === "supersedes"
    && entry.artifact.contentHash === first.value.contentHash), true);
});

test("spec parents reject unresolved, incomplete, or tampered closures and caller-supplied supersedes", async () => {
  const root = await projectRoot("invalid-source-closure");
  const { brief, method, implementation } = upstreamClosure();
  const parent = { relation: "uses" as const, artifact: toResearchArtifactRef(implementation) };

  await assert.rejects(
    saveExperimentSpec({
      projectRoot: root,
      spec: { experimentId: "experiment-missing", title: "Missing source", parents: [parent] },
    }),
    (error: unknown) => error instanceof ExperimentServiceError
      && error.code === "invalid_input"
      && /is not resolved/u.test(error.message),
  );
  await assert.rejects(
    saveExperimentSpec({
      projectRoot: root,
      spec: {
        experimentId: "experiment-incomplete",
        title: "Incomplete source closure",
        parents: [parent],
        sourceArtifacts: [implementation],
      },
    }),
    (error: unknown) => error instanceof ExperimentServiceError
      && error.code === "invalid_input"
      && /complete, valid Artifact DAG closure/u.test(error.message),
  );
  await assert.rejects(
    saveExperimentSpec({
      projectRoot: root,
      spec: {
        experimentId: "experiment-tampered",
        title: "Tampered source closure",
        parents: [parent],
        sourceArtifacts: [{ ...implementation, contentHash: "0".repeat(64) }, method, brief],
      },
    }),
    (error: unknown) => error instanceof ExperimentServiceError
      && error.code === "invalid_input"
      && /contentHash does not match/u.test(error.message),
  );
  await assert.rejects(
    saveExperimentSpec({
      projectRoot: root,
      spec: {
        experimentId: "experiment-forged-lineage",
        title: "Forged lineage",
        parents: [{ relation: "supersedes", artifact: toResearchArtifactRef(method) }],
        sourceArtifacts: [method],
      } as never,
    }),
    (error: unknown) => error instanceof ExperimentServiceError
      && error.code === "invalid_input"
      && /cannot use supersedes/u.test(error.message),
  );
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

test("enforces explicit wall-time and cost reservations, then records measured local usage", async () => {
  const root = await projectRoot("budget-ledger");
  await createSpec(root, {
    worker: { kind: "mock", delayMs: 30, result: { metrics: [{ name: "accuracy", value: 0.93 }] } },
  });
  const grant = await issueExecutionGrant({
    projectRoot: root,
    grant: {
      grantId: "grant-budget-ledger",
      experimentId: "experiment-main",
      mode: "budget_auto",
      reason: "Bounded run ledger test",
      budget: { maxAttempts: 3, maxWallTimeMs: 10, maxCostUsd: 2 },
    },
  });

  await assert.rejects(
    submitLocalExperimentRun({
      projectRoot: root,
      experimentId: "experiment-main",
      grantId: grant.value.payload.grantId,
      jobId: "job-without-reservation",
    }),
    (error: unknown) => error instanceof ExperimentServiceError
      && error.code === "permission_denied"
      && /reservation/u.test(error.message),
  );

  const timedOut = await submitLocalExperimentRun({
    projectRoot: root,
    experimentId: "experiment-main",
    grantId: grant.value.payload.grantId,
    jobId: "job-budget-ledger",
    run: {
      routeId: "ledger-route",
      parameters: { seed: 7 },
      slices: { split: "heldout" },
      budgetReservation: {
        wallTimeMs: 10,
        cost: { usd: 2, source: "provider_quote", reference: "pricing-v1" },
      },
    },
  });
  assert.equal(timedOut.value.payload.status, "failed");
  assert.equal(timedOut.value.payload.failure?.category, "timeout");
  assert.equal(timedOut.value.payload.runFacts?.routeId, "ledger-route");
  assert.equal((timedOut.value.payload.runFacts?.actualWallTimeMs ?? 0) >= 10, true);

  await recordExperimentRunCost({
    projectRoot: root,
    attemptId: timedOut.value.payload.attemptId,
    actualCost: { usd: 1.5, source: "provider_reported", reference: "invoice-42" },
  });
  const manifest = await loadExperimentManifest({ projectRoot: root });
  const latestGrant = [...(manifest?.executionGrants ?? [])]
    .filter((entry) => entry.artifactId === grant.value.artifactId)
    .sort((left, right) => right.revision - left.revision)[0];
  assert.equal(latestGrant?.payload.budgetUsage?.consumedCostUsd, 1.5);
  assert.equal(latestGrant?.payload.budgetUsage?.reservedCostUsd, 0);

  await assert.rejects(
    submitLocalExperimentRun({
      projectRoot: root,
      experimentId: "experiment-main",
      grantId: grant.value.payload.grantId,
      jobId: "job-after-wall-budget",
      run: {
        budgetReservation: {
          wallTimeMs: 1,
          cost: { usd: 0.1, source: "provider_quote", reference: "pricing-v1" },
        },
      },
    }),
    (error: unknown) => error instanceof ExperimentServiceError
      && error.code === "permission_denied",
  );
});

test("reported baselines require a classified, explicitly confirmed rerun intent before preparation", async () => {
  const root = await projectRoot("baseline-rerun");
  await createSpec(root);
  const baseline = await recordReportedBaseline({
    projectRoot: root,
    baseline: {
      baselineId: "baseline-paper-rerun",
      experimentId: "experiment-main",
      metricName: "accuracy",
      reportedValue: 0.88,
      direction: "maximize",
      citation: { text: "Doe et al. (2025), Table 2" },
    },
  });
  const grant = await createGrant(root, "budget_auto", 1);

  await assert.rejects(
    prepareExperimentRun({
      projectRoot: root,
      experimentId: "experiment-main",
      grantId: grant.value.payload.grantId,
      jobId: "job-unconfirmed-baseline-rerun",
      run: {
        baselineRerun: {
          baselineId: baseline.value.payload.baselineId,
          purpose: "reproduce_reported_baseline",
          confirmed: false,
        },
      },
    }),
    (error: unknown) => error instanceof ExperimentServiceError
      && error.code === "permission_denied"
      && /confirmed/u.test(error.message),
  );

  const prepared = await prepareExperimentRun({
    projectRoot: root,
    experimentId: "experiment-main",
    grantId: grant.value.payload.grantId,
    jobId: "job-confirmed-baseline-rerun",
    run: {
      baselineRerun: {
        baselineId: baseline.value.payload.baselineId,
        purpose: "reproduce_reported_baseline",
        confirmed: true,
      },
    },
  });
  assert.deepEqual(prepared.value.payload.baselineRerun?.baselineId, baseline.value.payload.baselineId);
  assert.equal(prepared.value.payload.baselineRerun?.purpose, "reproduce_reported_baseline");
  assert.match(prepared.value.payload.baselineRerun?.confirmedAt ?? "", /^\d{4}-\d{2}-\d{2}T/u);
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

test("candidate descriptors expose local and authorized remote implementations while external control planes remain reserved", () => {
  const adapters = listExperimentAdapters();
  for (const id of ["local", "ssh", "slurm"] as const) {
    assert.equal(adapters.find((adapter) => adapter.id === id)?.status, "implemented");
  }
  for (const id of ["mlflow", "optuna", "dvc"] as const) {
    assert.equal(adapters.find((adapter) => adapter.id === id)?.status, "reserved");
  }
});

test("rejects project storage symlinks instead of following them outside the project", async (t) => {
  const root = await projectRoot("symlink-root");
  const outside = await projectRoot("symlink-outside");
  try {
    await symlink(outside, join(root, ".rigorium"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("This host does not allow creating a test directory link.");
      return;
    }
    throw error;
  }
  await assert.rejects(
    createSpec(root),
    (error: unknown) => error instanceof ExperimentRepositoryError && error.code === "path_violation",
  );
});

test("reclaims only stale locks whose owner process is gone", async () => {
  const root = await projectRoot("stale-lock");
  await createSpec(root);
  const paths = getProjectExperimentPaths({ projectRoot: root });
  await writeFile(paths.lockPath, "999999999\n0\n", "utf8");
  const stale = new Date(Date.now() - 120_000);
  await utimes(paths.lockPath, stale, stale);

  const updated = await saveExperimentSpec({
    projectRoot: root,
    spec: {
      experimentId: "experiment-main",
      title: "Updated after stale lock recovery",
      localWorker: { kind: "mock" },
    },
  });
  assert.equal(updated.value.revision, 2);
});

test("rejects a manifest whose artifact content no longer matches its hash", async () => {
  const root = await projectRoot("tampered-hash");
  const saved = await createSpec(root);
  const document = JSON.parse(await readFile(saved.path, "utf8")) as {
    specs: Array<{ payload: { title: string } }>;
  };
  document.specs[0]!.payload.title = "Tampered title";
  await writeFile(saved.path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await assert.rejects(
    loadExperimentManifest({ projectRoot: root }),
    (error: unknown) => error instanceof ExperimentRepositoryError && error.code === "invalid_schema",
  );
});

test("execution grant identities are idempotent and cannot be rebound to broader terms", async () => {
  const root = await projectRoot("grant-identity");
  await createSpec(root);
  const grant = {
    grantId: "stable-grant",
    experimentId: "experiment-main",
    mode: "confirm_each" as const,
    reason: "Stable authorization terms",
    budget: { maxAttempts: 1 },
  };
  const first = await issueExecutionGrant({ projectRoot: root, grant, now: new Date("2026-07-25T00:00:00.000Z") });
  const duplicate = await issueExecutionGrant({ projectRoot: root, grant, now: new Date("2026-07-25T01:00:00.000Z") });
  assert.equal(duplicate.value.revision, first.value.revision);
  assert.equal(duplicate.persisted, false);
  await assert.rejects(
    issueExecutionGrant({
      projectRoot: root,
      grant: { ...grant, mode: "budget_auto", budget: { maxAttempts: 10 } },
    }),
    (error: unknown) => error instanceof ExperimentServiceError && error.code === "duplicate_submission",
  );
});

test("unrelated concurrent jobs can both finalize without stale manifest revision conflicts", async () => {
  const root = await projectRoot("parallel-jobs");
  await createSpec(root, {
    worker: { kind: "mock", delayMs: 80, result: { metrics: [{ name: "accuracy", value: 0.95 }] } },
  });
  const grant = await createGrant(root, "budget_auto", 2);
  const results = await Promise.all(["job-parallel-a", "job-parallel-b"].map((jobId) => submitLocalExperimentRun({
    projectRoot: root,
    experimentId: "experiment-main",
    grantId: grant.value.payload.grantId,
    jobId,
  })));
  assert.deepEqual(results.map((result) => result.value.payload.status), ["succeeded", "succeeded"]);
  const manifest = await loadExperimentManifest({ projectRoot: root });
  assert.equal(manifest?.metricObservations.length, 2);
});

test("rejects malformed local worker definitions before persisting a spec", async () => {
  const root = await projectRoot("invalid-worker");
  await assert.rejects(
    saveExperimentSpec({
      projectRoot: root,
      spec: {
        title: "Invalid worker",
        localWorker: { kind: "process", command: process.execPath, timeoutMs: -1 } as never,
      },
    }),
    (error: unknown) => error instanceof ExperimentServiceError && error.code === "invalid_input",
  );
});

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
