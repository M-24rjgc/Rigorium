import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import test, { after } from "node:test";
import { hashResearchArtifactContent } from "../../../src/research/artifacts/index.js";
import {
  confirmExecutionJob,
  issueExecutionGrant,
  loadExperimentManifest,
  recordExperimentRunCost,
  saveExperimentSpec,
} from "../../../src/research/experimentation/index.js";
import {
  OpenSshRemoteTransport,
  RemoteAgentProcessError,
  RemoteAgentRuntime,
  RemoteExecutionControllerError,
  RemoteExecutionRepositoryError,
  RemoteExperimentBridgeError,
  RemoteExperimentController,
  RemoteTransportError,
  buildOpenSshInvocation,
  buildSlurmSubmissionArgs,
  getRemoteExecutionPaths,
  loadRemoteExecutionManifest,
  normalizeRemoteConnection,
  parseSlurmAccountingLine,
  parseSlurmNamedObservation,
  parseSlurmQueueLine,
  prepareRemoteStageFiles,
  registerRemoteConnection,
  sha256,
  slurmStateObservation,
  updateRemoteJob,
  type RemoteAgentCommandResult,
  type RemoteAgentExperimentResult,
  type RemoteAgentJobRequest,
  type RemoteAgentRequest,
  type RemoteAgentResponse,
  type RemoteAgentSubmitRequest,
  type RemoteConnectionRecord,
  type RemoteExecutionTransport,
  type RemoteAgentProcessHost,
  type RemoteProcessRunner,
} from "../../../src/research/experimentation/remote/index.js";

const TEST_ROOT_PREFIX = "rigorium-remote-execution-";
const testRoots = new Set<string>();
const logicalWorkspaceRoot = "/srv/rigorium/workspaces";
const logicalStateRoot = "/srv/rigorium/state";

after(async () => {
  for (const root of [...testRoots].reverse()) await removeValidatedTestRoot(root);
});

test("maps Windows controller files to normalized Linux staging paths and rejects escapes", async (t) => {
  const root = await testRoot("paths");
  const inputDirectory = join(root, "inputs");
  await mkdir(inputDirectory);
  const localPath = join(inputDirectory, "dataset.txt");
  await writeFile(localPath, "alpha\nbeta\n", "utf8");
  const prepared = await prepareRemoteStageFiles({
    projectRoot: root,
    workdir: `${logicalWorkspaceRoot}/project-a/run-1`,
    files: [{ localPath, remoteRelativePath: "data/dataset.txt" }],
  });
  assert.equal(prepared[0]?.localRelativePath, "inputs/dataset.txt");
  assert.equal(prepared[0]?.remotePath, `${logicalWorkspaceRoot}/project-a/run-1/data/dataset.txt`);
  assert.match(prepared[0]?.sha256 ?? "", /^sha256:[a-f0-9]{64}$/u);

  const outside = await testRoot("outside");
  const outsideFile = join(outside, "outside.txt");
  await writeFile(outsideFile, "outside", "utf8");
  await assert.rejects(
    prepareRemoteStageFiles({
      projectRoot: root,
      workdir: `${logicalWorkspaceRoot}/project-a/run-1`,
      files: [{ localPath: outsideFile, remoteRelativePath: "outside.txt" }],
    }),
    /stay inside the Project/u,
  );

  const linkedPath = join(root, "linked.txt");
  try {
    await symlink(outsideFile, linkedPath, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.diagnostic("Host does not permit symlink creation; outside-project checks still ran.");
      return;
    }
    throw error;
  }
  await assert.rejects(
    prepareRemoteStageFiles({
      projectRoot: root,
      workdir: `${logicalWorkspaceRoot}/project-a/run-1`,
      files: [{ localPath: linkedPath, remoteRelativePath: "linked.txt" }],
    }),
    /symbolic link or junction/u,
  );
});

test("OpenSSH invocation contains only connection terms while JSON stdin carries experiment terms", async () => {
  const root = await testRoot("openssh");
  const knownHostsFile = join(root, "known hosts");
  await writeFile(knownHostsFile, "cluster.test ssh-ed25519 AAAATEST\n", "utf8");
  const connection = normalizeRemoteConnection({
    connectionId: "connection-a",
    host: "cluster.test",
    username: "researcher",
    knownHostsFile,
    agentCommand: ["/usr/bin/node", "/opt/rigorium/remoteAgentCli.js"],
    workspaceRoot: logicalWorkspaceRoot,
    stateRoot: logicalStateRoot,
  });
  const runner = new CapturingSshRunner();
  const transport = new OpenSshRemoteTransport({ runner });
  const request = submitRequest({ backend: "ssh", requestHash: sha256("openssh-request") });
  const response = await transport.request(connection, request);
  assert.equal(response.ok, true);
  assert.equal(runner.calls.length, 1);
  const invocation = runner.calls[0]!;
  assert.equal(invocation.args.includes("GlobalKnownHostsFile=none"), true);
  assert.equal(invocation.args.includes(request.workdir), false);
  assert.equal(invocation.args.includes(request.argv[0]!), false);
  assert.deepEqual(invocation.args.slice(-3), [
    "researcher@cluster.test",
    "/usr/bin/node",
    "/opt/rigorium/remoteAgentCli.js",
  ]);
  assert.deepEqual(JSON.parse(invocation.stdin), request);
  assert.deepEqual(buildOpenSshInvocation(connection), {
    executable: "ssh",
    args: invocation.args,
  });
});

test("ambiguous OpenSSH submit protocol failures remain recovery-only", async () => {
  const root = await testRoot("openssh-protocol");
  const connection = normalizeRemoteConnection({
    connectionId: "connection-protocol",
    host: "cluster.test",
    knownHostsFile: join(root, "known_hosts"),
    agentCommand: ["/usr/bin/node", "/opt/rigorium/remoteAgentCli.js"],
    workspaceRoot: logicalWorkspaceRoot,
    stateRoot: logicalStateRoot,
  });
  const transport = new OpenSshRemoteTransport({
    runner: {
      async run() {
        return Object.freeze({ exitCode: 0, signal: null, stdout: "not-json", stderr: "" });
      },
    },
  });
  const request = submitRequest({ backend: "ssh", requestHash: sha256("ambiguous-protocol") });
  await assert.rejects(
    transport.request(connection, request),
    (error: unknown) => error instanceof RemoteTransportError
      && error.code === "protocol_error"
      && error.submissionUncertain === true,
  );
});

test("remote controller enforces all grant modes before the first backend submit", async () => {
  const plan = await controllerFixture("grant-plan", "plan_only", "job-plan");
  const planStageFile = join(plan.root, "plan-stage.txt");
  await writeFile(planStageFile, "must not be uploaded", "utf8");
  await assert.rejects(
    plan.controller.submit({
      ...plan.submission,
      stageFiles: [{ localPath: planStageFile, remoteRelativePath: "inputs/plan-stage.txt" }],
    }),
    (error: unknown) => error instanceof RemoteExperimentBridgeError && error.code === "permission_denied",
  );
  assert.equal(plan.transport.count("stage"), 0);
  assert.equal(plan.transport.count("submit"), 0);

  const confirm = await controllerFixture("grant-confirm", "confirm_each", "job-confirm");
  const confirmStageFile = join(confirm.root, "confirm-stage.txt");
  await writeFile(confirmStageFile, "upload only after confirmation", "utf8");
  const confirmedSubmission = {
    ...confirm.submission,
    stageFiles: [{ localPath: confirmStageFile, remoteRelativePath: "inputs/confirm-stage.txt" }],
  };
  await assert.rejects(
    confirm.controller.submit(confirmedSubmission),
    (error: unknown) => error instanceof RemoteExperimentBridgeError && error.code === "permission_denied",
  );
  assert.equal(confirm.transport.count("stage"), 0);
  assert.equal(confirm.transport.count("submit"), 0);
  await confirmExecutionJob({
    projectRoot: confirm.root,
    grantId: confirm.submission.grantId,
    jobId: confirm.submission.jobId,
  });
  const confirmed = await confirm.controller.submit(confirmedSubmission);
  assert.equal(confirmed.job.status, "queued");
  assert.equal(confirm.transport.count("stage"), 1);
  assert.equal(confirm.transport.count("submit"), 1);

  const automatic = await controllerFixture("grant-auto", "budget_auto", "job-auto");
  const automaticStageFile = join(automatic.root, "automatic-stage.txt");
  await writeFile(automaticStageFile, "upload only after automatic grant confirmation", "utf8");
  const automaticSubmission = {
    ...automatic.submission,
    stageFiles: [{ localPath: automaticStageFile, remoteRelativePath: "inputs/automatic-stage.txt" }],
  };
  await assert.rejects(
    automatic.controller.submit(automaticSubmission),
    (error: unknown) => error instanceof RemoteExperimentBridgeError && error.code === "permission_denied",
  );
  assert.equal(automatic.transport.count("stage"), 0);
  assert.equal(automatic.transport.count("submit"), 0);
  const accepted = await automatic.controller.submit({ ...automaticSubmission, automaticGrantConfirmed: true });
  assert.equal(accepted.job.status, "queued");
  assert.equal(automatic.transport.count("stage"), 1);
  assert.equal(automatic.transport.count("submit"), 1);
});

test("remote submission reserves wall time and quoted cost atomically before contacting the backend", async () => {
  const fixture = await controllerFixture("budget-reservation", "budget_auto", "job-budget-a", {
    maxAttempts: 3,
    maxWallTimeMs: 60_000,
    maxCostUsd: 5,
  });
  const missingReservation = await assert.rejects(
    fixture.controller.submit({ ...fixture.submission, automaticGrantConfirmed: true }),
    (error: unknown) => error instanceof RemoteExperimentBridgeError
      && error.code === "permission_denied"
      && /reservation/u.test(error.message),
  );
  assert.equal(missingReservation, undefined);
  assert.equal(fixture.transport.count("submit"), 0);

  const reservedRun = {
    routeId: "remote-ledger-route",
    parameters: { seed: 7 },
    slices: { split: "heldout" },
    budgetReservation: {
      wallTimeMs: 30_000,
      cost: { usd: 3, source: "provider_quote", reference: "cluster-price-v1" },
    },
  } as const;
  const attempts = await Promise.allSettled([
    fixture.controller.submit({ ...fixture.submission, automaticGrantConfirmed: true, run: reservedRun }),
    fixture.controller.submit({
      ...fixture.submission,
      jobId: "job-budget-b",
      workdir: `${logicalWorkspaceRoot}/project-a/job-budget-b`,
      automaticGrantConfirmed: true,
      run: reservedRun,
    }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  const request = fixture.transport.requests.find((candidate) => candidate.action === "submit");
  assert.equal(request?.action, "submit");
  if (request?.action === "submit") assert.equal(request.maxWallTimeMs, 30_000);

  const manifest = await loadExperimentManifest({ projectRoot: fixture.root });
  const latestGrant = [...(manifest?.executionGrants ?? [])]
    .filter((entry) => entry.artifactId === fixture.submission.grantId)
    .sort((left, right) => right.revision - left.revision)[0];
  assert.equal(latestGrant?.payload.budgetUsage?.reservedCostUsd, 3);
  assert.equal(latestGrant?.payload.budgetUsage?.reservedWallTimeMs, 30_000);
});

test("remote controller rejects a backend that differs from the pinned experiment adapter", async () => {
  const fixture = await controllerFixture("backend-mismatch", "budget_auto", "job-backend-mismatch");
  await assert.rejects(
    fixture.controller.submit({
      ...fixture.submission,
      backend: "slurm",
      slurm: { nodes: 1 },
      automaticGrantConfirmed: true,
    }),
    (error: unknown) => error instanceof RemoteExecutionControllerError && error.code === "invalid_input",
  );
  assert.equal(fixture.transport.count("submit"), 0);
});

test("disconnect after submit recovers through a new controller without a second submit", async () => {
  const fixture = await controllerFixture("uncertain", "budget_auto", "job-uncertain");
  fixture.transport.disconnectNextSubmit = true;
  const first = await fixture.controller.submit({ ...fixture.submission, automaticGrantConfirmed: true });
  assert.equal(first.job.phase, "submission_uncertain");
  assert.equal(first.attempt.payload.status, "recovery_required");
  assert.equal(fixture.transport.count("submit"), 1);

  const restarted = new RemoteExperimentController({ transport: fixture.transport });
  const recovered = await restarted.submit({ ...fixture.submission, automaticGrantConfirmed: true });
  assert.equal(recovered.job.status, "queued");
  assert.equal(recovered.job.phase, "submitted");
  assert.equal(recovered.job.failure, undefined);
  assert.equal(recovered.job.finishedAt, undefined);
  assert.equal(recovered.attempt.payload.status, "queued");
  assert.equal(recovered.attempt.payload.failure, undefined);
  assert.equal(recovered.attempt.payload.finishedAt, undefined);
  assert.equal(fixture.transport.count("submit"), 1);
  assert.equal(fixture.transport.count("recover"), 1);

  const queried = await restarted.query({ projectRoot: fixture.root, jobId: fixture.submission.jobId });
  assert.equal(queried.job.status, "queued");
  assert.equal(fixture.transport.count("submit"), 1);
});

test("remote terminal observations retain wall-time reservations until scheduler timestamps arrive", async () => {
  const fixture = await controllerFixture("terminal-timing", "budget_auto", "job-terminal-timing", {
    maxAttempts: 1,
    maxWallTimeMs: 60_000,
  });
  fixture.transport.nextObservation = { status: "succeeded" };
  const terminal = await fixture.controller.submit({
    ...fixture.submission,
    automaticGrantConfirmed: true,
    run: { budgetReservation: { wallTimeMs: 30_000 } },
  });
  assert.equal(terminal.attempt.payload.status, "succeeded");
  assert.equal(terminal.attempt.payload.runFacts?.actualWallTimeMs, undefined);

  let manifest = await loadExperimentManifest({ projectRoot: fixture.root });
  let grant = [...(manifest?.executionGrants ?? [])]
    .filter((entry) => entry.artifactId === fixture.submission.grantId)
    .sort((left, right) => right.revision - left.revision)[0];
  assert.equal(grant?.payload.budgetUsage?.reservedWallTimeMs, 30_000);
  assert.equal(grant?.payload.budgetUsage?.consumedWallTimeMs, 0);

  fixture.transport.nextObservation = {
    status: "succeeded",
    startedAt: "2026-07-25T00:00:00.000Z",
    finishedAt: "2026-07-25T00:00:12.000Z",
  };
  const reconciled = await fixture.controller.query({ projectRoot: fixture.root, jobId: fixture.submission.jobId });
  assert.equal(reconciled.attempt.payload.runFacts?.actualWallTimeMs, 12_000);

  manifest = await loadExperimentManifest({ projectRoot: fixture.root });
  grant = [...(manifest?.executionGrants ?? [])]
    .filter((entry) => entry.artifactId === fixture.submission.grantId)
    .sort((left, right) => right.revision - left.revision)[0];
  assert.equal(grant?.payload.budgetUsage?.reservedWallTimeMs, 0);
  assert.equal(grant?.payload.budgetUsage?.consumedWallTimeMs, 12_000);
});

test("explicit remote cancellation reconciliation settles wall time but preserves cost until an actual record", async () => {
  const fixture = await controllerFixture("manual-reconciliation", "budget_auto", "job-manual-reconciliation", {
    maxAttempts: 1,
    maxWallTimeMs: 60_000,
    maxCostUsd: 5,
  });
  fixture.transport.disconnectNextSubmit = true;
  const run = {
    budgetReservation: {
      wallTimeMs: 30_000,
      cost: { usd: 3, source: "provider_quote" as const, reference: "cluster-price-v1" },
    },
  };
  const uncertain = await fixture.controller.submit({
    ...fixture.submission,
    automaticGrantConfirmed: true,
    run,
  });
  assert.equal(uncertain.attempt.payload.status, "recovery_required");

  const reconciled = await fixture.controller.reconcile({
    projectRoot: fixture.root,
    jobId: fixture.submission.jobId,
    reconciliation: {
      actualWallTimeMs: 12_000,
      source: "scheduler_audit",
      reference: "scheduler-audit-42",
    },
  });
  assert.equal(reconciled.attempt.payload.status, "cancelled");
  assert.equal(reconciled.attempt.payload.runFacts?.actualWallTimeMs, 12_000);
  assert.equal(reconciled.attempt.payload.remoteCancellationReconciliation?.reference, "scheduler-audit-42");

  let manifest = await loadExperimentManifest({ projectRoot: fixture.root });
  let grant = [...(manifest?.executionGrants ?? [])]
    .filter((entry) => entry.artifactId === fixture.submission.grantId)
    .sort((left, right) => right.revision - left.revision)[0];
  assert.equal(grant?.payload.budgetUsage?.reservedWallTimeMs, 0);
  assert.equal(grant?.payload.budgetUsage?.consumedWallTimeMs, 12_000);
  assert.equal(grant?.payload.budgetUsage?.reservedCostUsd, 3);

  await recordExperimentRunCost({
    projectRoot: fixture.root,
    attemptId: reconciled.attempt.payload.attemptId,
    actualCost: { usd: 1.5, source: "provider_reported", reference: "usage-export-42" },
  });
  manifest = await loadExperimentManifest({ projectRoot: fixture.root });
  grant = [...(manifest?.executionGrants ?? [])]
    .filter((entry) => entry.artifactId === fixture.submission.grantId)
    .sort((left, right) => right.revision - left.revision)[0];
  assert.equal(grant?.payload.budgetUsage?.reservedCostUsd, 0);
  assert.equal(grant?.payload.budgetUsage?.consumedCostUsd, 1.5);
});

test("a persisted submitting phase is recover-only after controller restart", async () => {
  const fixture = await controllerFixture("submitting-restart", "budget_auto", "job-submitting");
  await fixture.controller.submit({ ...fixture.submission, automaticGrantConfirmed: true });
  assert.equal(fixture.transport.count("submit"), 1);
  await updateRemoteJob({
    projectRoot: fixture.root,
    jobId: fixture.submission.jobId,
    update: (current, now) => Object.freeze({
      ...current,
      phase: "submitting",
      updatedAt: now.toISOString(),
      events: Object.freeze([...current.events, Object.freeze({
        sequence: current.events.length + 1,
        at: now.toISOString(),
        status: current.status,
        phase: "submitting" as const,
        message: "Simulated persisted submit-in-progress state.",
      })]),
    }),
  });

  const restarted = new RemoteExperimentController({ transport: fixture.transport });
  const recovered = await restarted.submit({ ...fixture.submission, automaticGrantConfirmed: true });
  assert.equal(recovered.job.phase, "submitted");
  assert.equal(recovered.job.status, "queued");
  assert.equal(fixture.transport.count("submit"), 1);
  assert.equal(fixture.transport.count("recover"), 1);
});

test("controller treats a backend-mismatched submit response as uncertain and recovers", async () => {
  const fixture = await controllerFixture("invalid-response", "budget_auto", "job-invalid-response");
  fixture.transport.invalidNextSubmitResponse = true;
  const first = await fixture.controller.submit({ ...fixture.submission, automaticGrantConfirmed: true });
  assert.equal(first.job.phase, "submission_uncertain");
  assert.equal(first.attempt.payload.status, "recovery_required");
  assert.equal(fixture.transport.count("submit"), 1);

  const recovered = await fixture.controller.submit({ ...fixture.submission, automaticGrantConfirmed: true });
  assert.equal(recovered.job.status, "queued");
  assert.equal(fixture.transport.count("submit"), 1);
  assert.equal(fixture.transport.count("recover"), 1);
});

test("connection and job identities are immutable and remote manifest tampering is rejected", async () => {
  const fixture = await controllerFixture("identity", "budget_auto", "job-identity");
  await fixture.controller.submit({ ...fixture.submission, automaticGrantConfirmed: true });
  await assert.rejects(
    fixture.controller.submit({ ...fixture.submission, argv: ["python3", "other.py"], automaticGrantConfirmed: true }),
    (error: unknown) => error instanceof RemoteExecutionControllerError && error.code === "invalid_input",
  );
  const manifest = await loadRemoteExecutionManifest({ projectRoot: fixture.root });
  const connection = manifest!.connections[0]!;
  await assert.rejects(
    registerRemoteConnection({
      projectRoot: fixture.root,
      connection: { ...connection, host: "other-cluster.test" },
    }),
    (error: unknown) => error instanceof RemoteExecutionRepositoryError && error.code === "invalid_input",
  );

  const paths = getRemoteExecutionPaths({ projectRoot: fixture.root });
  const document = JSON.parse(await readFile(paths.manifestPath, "utf8")) as {
    jobs: Array<{ workdir: string }>;
    integrityHash: string;
  };
  document.jobs[0]!.workdir = `${logicalWorkspaceRoot}/../tampered`;
  const { integrityHash: _integrityHash, ...manifestContent } = document;
  document.integrityHash = hashResearchArtifactContent(manifestContent);
  await writeFile(paths.manifestPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await assert.rejects(
    loadRemoteExecutionManifest({ projectRoot: fixture.root }),
    (error: unknown) => error instanceof RemoteExecutionRepositoryError && error.code === "invalid_schema",
  );
});

test("remote agent stages immutable hashes and persists exactly one SSH launch across restarts", async () => {
  const root = await testRoot("agent-ssh");
  const actualWorkspaceRoot = join(root, "workspace");
  const actualStateRoot = join(root, "state");
  await Promise.all([mkdir(actualWorkspaceRoot), mkdir(actualStateRoot)]);
  const host = new FakeAgentProcessHost();
  host.nextLaunchPid = process.pid;
  const runtime = agentRuntime(actualWorkspaceRoot, actualStateRoot, host);
  const requestHash = sha256("agent-ssh-request");
  const content = Buffer.from("staged input\n", "utf8");
  const stage = stageRequest({ jobId: "job-agent-ssh", requestHash, content });

  const firstStage = await runtime.handle(stage);
  assertSuccess(firstStage);
  assert.equal(firstStage.duplicate, false);
  const duplicateStage = await runtime.handle(stage);
  assertSuccess(duplicateStage);
  assert.equal(duplicateStage.duplicate, true);
  const stagedPath = join(actualWorkspaceRoot, "project-a", "run-a", "inputs", "data.txt");
  assert.equal(await readFile(stagedPath, "utf8"), "staged input\n");

  const submit = submitRequest({ backend: "ssh", requestHash, jobId: "job-agent-ssh" });
  const submitted = await runtime.handle(submit);
  assertSuccess(submitted);
  assert.equal(submitted.duplicate, false);
  assert.equal(host.launches.length, 1);
  assert.equal(host.launches[0]?.args.includes(submit.workdir), false);
  assert.equal(host.launches[0]?.args.includes(submit.argv[0]!), false);

  const restarted = agentRuntime(actualWorkspaceRoot, actualStateRoot, host);
  const duplicateSubmit = await restarted.handle(submit);
  assertSuccess(duplicateSubmit);
  assert.equal(duplicateSubmit.duplicate, true);
  assert.equal(host.launches.length, 1);
  const recovered = await restarted.handle(jobRequest("recover", submit, submitted.observation?.backendJobId));
  assertSuccess(recovered);
  assert.equal(recovered.observation?.status, "queued");
  assert.equal(host.launches.length, 1);

  const conflict = await restarted.handle({ ...submit, requestHash: sha256("different-binding") });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, "job_conflict");

  await writeFile(stagedPath, "tampered\n", "utf8");
  const tamperedStage = await restarted.handle(stage);
  assert.equal(tamperedStage.ok, false);
  if (!tamperedStage.ok) assert.equal(tamperedStage.code, "hash_mismatch");
});

test("remote agent rejects workspace symlink traversal and corrupted durable state", async (t) => {
  const root = await testRoot("agent-security");
  const actualWorkspaceRoot = join(root, "workspace");
  const actualStateRoot = join(root, "state");
  const outside = join(root, "outside");
  await Promise.all([mkdir(actualWorkspaceRoot), mkdir(actualStateRoot), mkdir(outside)]);
  const host = new FakeAgentProcessHost();
  const runtime = agentRuntime(actualWorkspaceRoot, actualStateRoot, host);
  const submit = submitRequest({ backend: "ssh", requestHash: sha256("state-integrity"), jobId: "job-integrity" });
  const submitted = await runtime.handle(submit);
  assertSuccess(submitted);
  const paths = runtime.repository.pathsFor(submit);
  const originalState = JSON.parse(await readFile(paths.actualJobPath, "utf8")) as Record<string, unknown>;
  await writeFile(paths.actualJobPath, `${JSON.stringify({ ...originalState, status: "succeeded" }, null, 2)}\n`, "utf8");
  const corrupted = await runtime.handle(jobRequest("query", submit, submitted.observation?.backendJobId));
  assert.equal(corrupted.ok, false);
  if (!corrupted.ok) assert.equal(corrupted.code, "internal_error");

  const forgedState = { ...originalState, runnerPid: -1, integrityHash: "" };
  const { integrityHash: _integrityHash, ...forgedContent } = forgedState;
  forgedState.integrityHash = hashResearchArtifactContent(forgedContent);
  await writeFile(paths.actualJobPath, `${JSON.stringify(forgedState, null, 2)}\n`, "utf8");
  const forged = await runtime.handle(jobRequest("query", submit, submitted.observation?.backendJobId));
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.code, "internal_error");

  const linkPath = join(actualWorkspaceRoot, "linked-project");
  try {
    await symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.diagnostic("Host does not permit directory links; durable-state integrity assertion still ran.");
      return;
    }
    throw error;
  }
  const content = Buffer.from("unsafe target", "utf8");
  const linkedStage = stageRequest({
    jobId: "job-linked",
    requestHash: sha256("linked-stage"),
    content,
    workdir: `${logicalWorkspaceRoot}/linked-project/run-a`,
  });
  const rejected = await runtime.handle(linkedStage);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, "path_violation");
});

test("remote agent rejects late staging and honors cancellation before pid persistence", async () => {
  const root = await testRoot("agent-cancel-race");
  const actualWorkspaceRoot = join(root, "workspace");
  const actualStateRoot = join(root, "state");
  await Promise.all([mkdir(actualWorkspaceRoot), mkdir(actualStateRoot)]);
  const host = new FakeAgentProcessHost();
  host.nextLaunchPid = process.pid;
  const runtime = agentRuntime(actualWorkspaceRoot, actualStateRoot, host);
  const submit = submitRequest({ backend: "ssh", requestHash: sha256("cancel-race"), jobId: "job-cancel-race" });
  const submitted = await runtime.handle(submit);
  assertSuccess(submitted);

  const lateStage = await runtime.handle(stageRequest({
    jobId: submit.jobId,
    requestHash: submit.requestHash,
    content: Buffer.from("too late", "utf8"),
  }));
  assert.equal(lateStage.ok, false);
  if (!lateStage.ok) assert.equal(lateStage.code, "job_conflict");

  host.beforeExperimentSpawn = async () => {
    const cancelled = await runtime.handle(jobRequest("cancel", submit, submitted.observation?.backendJobId));
    assertSuccess(cancelled);
    assert.equal(cancelled.observation?.status, "cancelled");
  };
  await runtime.runWorker(runtime.repository.pathsFor(submit).remoteJobPath);
  const final = await runtime.handle(jobRequest("query", submit, submitted.observation?.backendJobId));
  assertSuccess(final);
  assert.equal(final.observation?.status, "cancelled");
  assert.equal(host.terminatedPids.length, 1);
});

test("Slurm argv, recovery, cancellation, and terminal classifications stay structured", async () => {
  const args = buildSlurmSubmissionArgs({
    jobName: "pd-job",
    workdir: `${logicalWorkspaceRoot}/project-a/run-a`,
    stdoutPath: `${logicalStateRoot}/jobs/abc/stdout.log`,
    stderrPath: `${logicalStateRoot}/jobs/abc/stderr.log`,
    runnerPath: "/usr/bin/node",
    runnerArgs: ["/opt/rigorium/remoteAgentCli.js", "--run-job"],
    statePath: `${logicalStateRoot}/jobs/abc/job.json`,
    resources: { nodes: 1, tasks: 2, memoryMiB: 4096, timeLimitMinutes: 30 },
  });
  assert.deepEqual(args.slice(-2), [
    "--wrap",
    "'/usr/bin/node' '/opt/rigorium/remoteAgentCli.js' '--run-job' '/srv/rigorium/state/jobs/abc/job.json'",
  ]);
  assert.equal(args.includes("python train.py"), false);

  const queue = parseSlurmQueueLine({
    jobId: "123",
    observationJobId: "job-a",
    stdout: "123|RUNNING|node01|2026-07-25T00:00:00Z\n",
  });
  assert.equal(queue?.status, "running");
  assert.equal(queue?.startedAt, "2026-07-25T00:00:00.000Z");
  const accounting = parseSlurmAccountingLine({
    jobId: "123",
    observationJobId: "job-a",
    stdout: "123|OUT_OF_MEMORY|137:0|oom|2026-07-25T00:00:00Z|2026-07-25T00:00:12Z\n",
  });
  assert.equal(accounting?.failure?.category, "out_of_memory");
  assert.equal(accounting?.finishedAt, "2026-07-25T00:00:12.000Z");
  assert.equal(slurmStateObservation({ jobId: "job-a", schedulerJobId: "123", state: "PREEMPTED" }).failure?.category, "preempted");
  assert.equal(slurmStateObservation({ jobId: "job-a", schedulerJobId: "123", state: "TIMEOUT" }).failure?.category, "timeout");
  assert.equal(slurmStateObservation({ jobId: "job-a", schedulerJobId: "123", state: "CANCELLED by 42" }).status, "cancelled");
  assert.equal(parseSlurmNamedObservation({
    jobName: "pd-stable",
    stdout: "123|pd-stable|PENDING|Resources\n",
    source: "queue",
    observationJobId: "job-a",
  })?.schedulerJobId, "123");
});

test("uncertain Slurm submission recovers by stable name, never resubmits, and cancels by id", async () => {
  const root = await testRoot("agent-slurm");
  const actualWorkspaceRoot = join(root, "workspace");
  const actualStateRoot = join(root, "state");
  await Promise.all([mkdir(actualWorkspaceRoot), mkdir(actualStateRoot)]);
  const host = new FakeAgentProcessHost();
  host.timeoutNextSbatch = true;
  const runtime = agentRuntime(actualWorkspaceRoot, actualStateRoot, host);
  const submit = submitRequest({ backend: "slurm", requestHash: sha256("slurm-uncertain"), jobId: "job-slurm" });
  const recoveredSubmit = await runtime.handle(submit);
  assertSuccess(recoveredSubmit);
  assert.equal(recoveredSubmit.observation?.status, "queued");
  assert.equal(recoveredSubmit.observation?.schedulerJobId, "12345");
  assert.equal(host.countCommand("sbatch"), 1);

  const duplicate = await runtime.handle(submit);
  assertSuccess(duplicate);
  assert.equal(duplicate.duplicate, true);
  assert.equal(host.countCommand("sbatch"), 1);

  const restarted = agentRuntime(actualWorkspaceRoot, actualStateRoot, host);
  host.schedulerState = "RUNNING";
  const queried = await restarted.handle(jobRequest("recover", submit, recoveredSubmit.observation?.backendJobId));
  assertSuccess(queried);
  assert.equal(queried.observation?.status, "running");
  assert.equal(host.countCommand("sbatch"), 1);
  assert.equal(host.commands.some((entry) => entry.executable === "squeue" && entry.args.includes("%i|%T|%R|%S")), true);
  assert.equal(host.commands.some((entry) => entry.executable === "squeue" && entry.args.includes("%i|%j|%T|%R|%S")), true);

  const cancelled = await restarted.handle(jobRequest("cancel", submit, queried.observation?.backendJobId));
  assertSuccess(cancelled);
  assert.equal(cancelled.observation?.status, "cancelled");
  assert.deepEqual(host.commands.filter((entry) => entry.executable === "scancel").map((entry) => entry.args), [["12345"]]);
});

class CapturingSshRunner implements RemoteProcessRunner {
  readonly calls: Array<Readonly<{ executable: string; args: readonly string[]; stdin: string }>> = [];

  async run(input: Parameters<RemoteProcessRunner["run"]>[0]) {
    this.calls.push(Object.freeze({ executable: input.executable, args: input.args, stdin: input.stdin }));
    const request = JSON.parse(input.stdin) as RemoteAgentSubmitRequest;
    return Object.freeze({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({
        protocolVersion: 1,
        requestId: request.requestId,
        ok: true,
        action: request.action,
        duplicate: false,
        observation: observation(request, "queued", false),
      }),
      stderr: "",
    });
  }
}

class ScriptedTransport implements RemoteExecutionTransport {
  readonly requests: RemoteAgentRequest[] = [];
  disconnectNextSubmit = false;
  invalidNextSubmitResponse = false;
  nextObservation?: Readonly<{
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
    startedAt?: string;
    finishedAt?: string;
  }>;

  count(action: RemoteAgentRequest["action"]): number {
    return this.requests.filter((request) => request.action === action).length;
  }

  async request(_connection: RemoteConnectionRecord, request: RemoteAgentRequest): Promise<RemoteAgentResponse> {
    this.requests.push(request);
    if (request.action === "stage") {
      return Object.freeze({
        protocolVersion: 1,
        requestId: request.requestId,
        ok: true,
        action: "stage",
        duplicate: false,
        stagedFiles: request.files.map(({ remoteRelativePath, remotePath, bytes, sha256: digest }) => ({
          remoteRelativePath,
          remotePath,
          bytes,
          sha256: digest,
        })),
      });
    }
    if (request.action === "submit" && this.disconnectNextSubmit) {
      this.disconnectNextSubmit = false;
      throw new RemoteTransportError("disconnected", "Connection closed after request write.", {
        retryable: true,
        submissionUncertain: true,
      });
    }
    if (request.action === "submit" && this.invalidNextSubmitResponse) {
      this.invalidNextSubmitResponse = false;
      return Object.freeze({
        protocolVersion: 1,
        requestId: request.requestId,
        ok: true,
        action: "submit",
        duplicate: false,
        observation: { ...observation(request, "queued", false), backendJobId: "slurm:wrong-backend" },
      }) as RemoteAgentResponse;
    }
    const nextObservation = this.nextObservation;
    this.nextObservation = undefined;
    return Object.freeze({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      action: request.action,
      duplicate: request.action !== "submit",
      observation: Object.freeze({
        ...observation(request, nextObservation?.status ?? "queued", request.action !== "submit"),
        ...(nextObservation?.startedAt === undefined ? {} : { startedAt: nextObservation.startedAt }),
        ...(nextObservation?.finishedAt === undefined ? {} : { finishedAt: nextObservation.finishedAt }),
      }),
    });
  }
}

class FakeAgentProcessHost implements RemoteAgentProcessHost {
  readonly commands: Array<Readonly<{ executable: string; args: readonly string[] }>> = [];
  readonly launches: Array<Readonly<{ executable: string; args: readonly string[]; cwd: string }>> = [];
  readonly alive = new Set<number>();
  readonly terminatedPids: number[] = [];
  beforeExperimentSpawn?: (pid: number) => Promise<void>;
  nextLaunchPid?: number;
  timeoutNextSbatch = false;
  schedulerState = "PENDING";
  #nextPid = 7000;

  countCommand(executable: string): number {
    return this.commands.filter((entry) => entry.executable === executable).length;
  }

  async runCommand(input: Parameters<RemoteAgentProcessHost["runCommand"]>[0]): Promise<RemoteAgentCommandResult> {
    this.commands.push(Object.freeze({ executable: input.executable, args: input.args }));
    if (input.executable === "sbatch") {
      if (this.timeoutNextSbatch) {
        this.timeoutNextSbatch = false;
        throw new RemoteAgentProcessError("timeout", "sbatch timed out after write");
      }
      return commandResult("12345\n");
    }
    if (input.executable === "squeue") {
      const nameIndex = input.args.indexOf("--name");
      if (nameIndex >= 0) {
        const name = input.args[nameIndex + 1]!;
        return commandResult(`12345|${name}|${this.schedulerState}|Resources\n`);
      }
      return commandResult(`12345|${this.schedulerState}|node01\n`);
    }
    if (input.executable === "sacct") return commandResult("");
    if (input.executable === "scancel") return commandResult("");
    throw new RemoteAgentProcessError("spawn_failed", `Unexpected command ${input.executable}`);
  }

  async launchDetached(input: Parameters<RemoteAgentProcessHost["launchDetached"]>[0]): Promise<number> {
    this.launches.push(Object.freeze({ executable: input.executable, args: input.args, cwd: input.cwd }));
    const pid = this.nextLaunchPid ?? this.#nextPid++;
    this.nextLaunchPid = undefined;
    this.alive.add(pid);
    return pid;
  }

  async runExperiment(input: Parameters<RemoteAgentProcessHost["runExperiment"]>[0]): Promise<RemoteAgentExperimentResult> {
    const pid = this.#nextPid++;
    this.alive.add(pid);
    try {
      await this.beforeExperimentSpawn?.(pid);
      await input.onSpawn(pid);
      return Object.freeze({ exitCode: 0, signal: null });
    } finally {
      this.alive.delete(pid);
    }
  }

  isProcessAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async terminateProcessTree(pid: number): Promise<void> {
    this.terminatedPids.push(pid);
    this.alive.delete(pid);
  }
}

async function controllerFixture(
  label: string,
  mode: "plan_only" | "confirm_each" | "budget_auto",
  jobId: string,
  budget: Readonly<{ maxAttempts: number; maxWallTimeMs?: number; maxCostUsd?: number }> = { maxAttempts: 2 },
) {
  const root = await testRoot(label);
  await saveExperimentSpec({
    projectRoot: root,
    spec: {
      experimentId: "experiment-main",
      title: "Remote experiment",
      adapterId: "ssh",
      expectedMetrics: ["accuracy"],
    },
  });
  const grant = await issueExecutionGrant({
    projectRoot: root,
    grant: {
      grantId: `grant-${mode}`,
      experimentId: "experiment-main",
      mode,
      allowedAdapterIds: ["ssh"],
      reason: "Focused remote execution test",
      budget,
    },
  });
  const knownHostsFile = join(root, "known_hosts");
  await writeFile(knownHostsFile, "cluster.test ssh-ed25519 AAAATEST\n", "utf8");
  const transport = new ScriptedTransport();
  const controller = new RemoteExperimentController({ transport });
  await controller.registerConnection({
    projectRoot: root,
    connection: {
      connectionId: "connection-main",
      host: "cluster.test",
      username: "researcher",
      knownHostsFile,
      agentCommand: ["/usr/bin/node", "/opt/rigorium/remoteAgentCli.js"],
      workspaceRoot: logicalWorkspaceRoot,
      stateRoot: logicalStateRoot,
    },
  });
  return {
    root,
    controller,
    transport,
    submission: {
      projectRoot: root,
      connectionId: "connection-main",
      backend: "ssh" as const,
      experimentId: "experiment-main",
      grantId: grant.value.payload.grantId,
      jobId,
      workdir: `${logicalWorkspaceRoot}/project-a/${jobId}`,
      argv: ["python3", "train.py", "--seed", "7"],
    },
  };
}

function agentRuntime(actualWorkspaceRoot: string, actualStateRoot: string, host: RemoteAgentProcessHost): RemoteAgentRuntime {
  return new RemoteAgentRuntime({
    workspaceRoot: logicalWorkspaceRoot,
    stateRoot: logicalStateRoot,
    actualWorkspaceRoot,
    actualStateRoot,
    runnerCommand: ["/usr/bin/node", "/opt/rigorium/remoteAgentCli.js", "--run-job"],
    processHost: host,
  });
}

function submitRequest(input: {
  backend: "ssh" | "slurm";
  requestHash: string;
  jobId?: string;
}): RemoteAgentSubmitRequest {
  return Object.freeze({
    protocolVersion: 1,
    requestId: `submit:${input.requestHash.slice(7, 39)}`,
    connectionId: "connection-main",
    projectId: "project-main",
    stateRoot: logicalStateRoot,
    workspaceRoot: logicalWorkspaceRoot,
    action: "submit",
    backend: input.backend,
    jobId: input.jobId ?? "job-main",
    requestHash: input.requestHash,
    workdir: `${logicalWorkspaceRoot}/project-a/run-a`,
    argv: ["python3", "train.py", "--seed", "7"],
    ...(input.backend === "slurm" ? { slurm: { nodes: 1, tasks: 1, memoryMiB: 2048 } } : {}),
  });
}

function stageRequest(input: {
  jobId: string;
  requestHash: string;
  content: Buffer;
  workdir?: string;
}): Extract<RemoteAgentRequest, { action: "stage" }> {
  const workdir = input.workdir ?? `${logicalWorkspaceRoot}/project-a/run-a`;
  return Object.freeze({
    protocolVersion: 1,
    requestId: `stage:${input.requestHash.slice(7, 39)}`,
    connectionId: "connection-main",
    projectId: "project-main",
    stateRoot: logicalStateRoot,
    workspaceRoot: logicalWorkspaceRoot,
    action: "stage",
    jobId: input.jobId,
    requestHash: input.requestHash,
    workdir,
    files: Object.freeze([{
      remoteRelativePath: "inputs/data.txt",
      remotePath: `${workdir}/inputs/data.txt`,
      bytes: input.content.byteLength,
      sha256: sha256(input.content),
      contentBase64: input.content.toString("base64"),
    }]),
  });
}

function jobRequest(
  action: RemoteAgentJobRequest["action"],
  submit: RemoteAgentSubmitRequest,
  backendJobId?: string,
): RemoteAgentJobRequest {
  return Object.freeze({
    protocolVersion: 1,
    requestId: `${action}:${submit.requestHash.slice(7, 39)}`,
    connectionId: submit.connectionId,
    projectId: submit.projectId,
    stateRoot: submit.stateRoot,
    workspaceRoot: submit.workspaceRoot,
    action,
    backend: submit.backend,
    jobId: submit.jobId,
    requestHash: submit.requestHash,
    ...(backendJobId === undefined ? {} : { backendJobId }),
  });
}

function observation(
  request: Exclude<RemoteAgentRequest, { action: "stage" }>,
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown",
  duplicate: boolean,
) {
  return Object.freeze({
    backend: request.backend,
    jobId: request.jobId,
    backendJobId: request.backend === "ssh" ? `ssh:${request.jobId}` : `slurm:${request.jobId}`,
    ...(request.backend === "slurm" ? { schedulerJobId: "12345" } : {}),
    status,
    duplicate,
    observedAt: new Date().toISOString(),
  });
}

function commandResult(stdout: string): RemoteAgentCommandResult {
  return Object.freeze({ exitCode: 0, signal: null, stdout, stderr: "" });
}

function assertSuccess(response: RemoteAgentResponse): asserts response is Extract<RemoteAgentResponse, { ok: true }> {
  assert.equal(response.ok, true, response.ok ? undefined : response.message);
}

async function testRoot(label: string): Promise<string> {
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
