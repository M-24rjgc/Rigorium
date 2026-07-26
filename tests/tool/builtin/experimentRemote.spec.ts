import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import test, { after } from "node:test";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import {
  issueExecutionGrant,
  saveExperimentSpec,
} from "../../../src/research/experimentation/index.js";
import {
  RemoteTransportError,
  type RemoteAgentRequest,
  type RemoteAgentResponse,
  type RemoteConnectionRecord,
  type RemoteExecutionTransport,
} from "../../../src/research/experimentation/remote/index.js";
import {
  createExperimentRemoteTool,
  type ExperimentRemoteInput,
} from "../../../src/tool/builtin/experimentRemote.js";
import { RigoriumToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { RigoriumToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const TEST_ROOT_PREFIX = "rigorium-experiment-remote-tool-";
const testRoots = new Set<string>();
const NOW = new Date("2026-07-25T12:00:00.000Z");
const workspaceRoot = "/srv/rigorium/workspaces";
const stateRoot = "/srv/rigorium/state";

after(async () => {
  for (const root of [...testRoots].reverse()) await removeValidatedTestRoot(root);
});

test("experiment_remote distinguishes local stage preflight from authorized network execution", async () => {
  const root = await testRoot("operations");
  const inputDirectory = join(root, "inputs");
  await mkdir(inputDirectory);
  const localFile = join(inputDirectory, "dataset.txt");
  await writeFile(localFile, "alpha\nbeta\n", "utf8");
  const knownHostsFile = join(root, "known_hosts");
  await writeFile(knownHostsFile, "cluster.test ssh-ed25519 AAAATEST\n", "utf8");

  await saveExperimentSpec({
    projectRoot: root,
    spec: {
      experimentId: "experiment-main",
      title: "Remote experiment tool test",
      adapterId: "ssh",
      expectedMetrics: ["accuracy"],
    },
    now: NOW,
  });
  const planOnly = await issueGrant(root, "plan_only", "grant-plan");
  const confirmEach = await issueGrant(root, "confirm_each", "grant-confirm");
  const budgetAuto = await issueGrant(root, "budget_auto", "grant-auto");
  const uncertainAuto = await issueGrant(root, "budget_auto", "grant-uncertain");

  const transport = new RecordingTransport();
  const tool = createExperimentRemoteTool({ transport, now: () => NOW });
  const runtime = context(root);
  const connection = {
    connectionId: "connection-main",
    host: "cluster.test",
    username: "researcher",
    knownHostsFile,
    agentCommand: ["/usr/bin/node", "/opt/rigorium/remoteAgentCli.js"],
    workspaceRoot,
    stateRoot,
  } as const;
  const stage: ExperimentRemoteInput = {
    operation: "stage",
    connectionId: connection.connectionId,
    workdir: `${workspaceRoot}/project-a/stage-preview`,
    stageFiles: [{ localPath: localFile, remoteRelativePath: "data/dataset.txt" }],
  };
  const submit = (grantId: string, jobId: string, automaticGrantConfirmed?: boolean): ExperimentRemoteInput => ({
    operation: "submit",
    connectionId: connection.connectionId,
    backend: "ssh",
    experimentId: "experiment-main",
    grantId,
    jobId,
    workdir: `${workspaceRoot}/project-a/${jobId}`,
    argv: ["python3", "train.py", "--seed", "7"],
    ...(automaticGrantConfirmed === undefined ? {} : { automaticGrantConfirmed }),
  });

  assert.equal(tool.isReadOnly({ operation: "list" }), true);
  assert.equal(tool.isReadOnly(stage), true);
  assert.equal(tool.isConcurrencySafe(stage), true);
  assert.equal(tool.isOpenWorld?.(stage), false);
  assert.equal(tool.requiresUserInteraction?.(stage), false);
  assert.equal(tool.isReadOnly(submit(budgetAuto, "job-auto", true)), false);
  assert.equal(tool.isOpenWorld?.(submit(budgetAuto, "job-auto", true)), true);
  assert.equal(tool.requiresUserInteraction?.(submit(budgetAuto, "job-auto", true)), false);
  assert.equal(tool.requiresUserInteraction?.({ operation: "confirm", grantId: confirmEach, jobId: "job-confirm", confirmed: true }), true);
  assert.equal(tool.requiresUserInteraction?.({ operation: "cancel", jobId: "job-auto" }), true);
  assert.equal(tool.isDestructive?.({ operation: "cancel", jobId: "job-auto" }), true);

  const registered = await tool.execute({ operation: "register", connection }, runtime);
  assert.equal(registered.data?.connection?.connectionId, connection.connectionId);
  assert.equal(registered.data?.duplicate, false);
  assert.equal(transport.requests.length, 0);

  const listed = await tool.execute({ operation: "list" }, runtime);
  assert.equal(listed.data?.remoteManifest?.connections.length, 1);

  const preflight = await tool.execute(stage, runtime);
  assert.equal(preflight.data?.preparedFiles?.length, 1);
  assert.equal(preflight.data?.preparedFiles?.[0]?.localRelativePath, "inputs/dataset.txt");
  assert.equal(preflight.data?.preparedFiles?.[0]?.remotePath, `${workspaceRoot}/project-a/stage-preview/data/dataset.txt`);
  assert.equal(transport.requests.length, 0, "stage preflight must not contact the remote host");

  await assert.rejects(
    tool.execute({ ...stage, workdir: "/outside-workspace/run" }, runtime),
    (error: unknown) => error instanceof RigoriumToolRuntimeError && error.code === "invalid_tool_input",
  );
  await assert.rejects(
    tool.execute({ ...stage, connectionId: "unregistered" }, runtime),
    (error: unknown) => error instanceof RigoriumToolRuntimeError && error.code === "file_not_found",
  );

  await assert.rejects(
    tool.execute(submit(planOnly, "job-plan"), runtime),
    (error: unknown) => error instanceof RigoriumToolRuntimeError && error.code === "permission_denied",
  );
  assert.equal(transport.count("submit"), 0);

  const confirmSubmission = submit(confirmEach, "job-confirm");
  await assert.rejects(
    tool.execute(confirmSubmission, runtime),
    (error: unknown) => error instanceof RigoriumToolRuntimeError && error.code === "permission_denied",
  );
  await tool.execute({ operation: "confirm", grantId: confirmEach, jobId: "job-confirm", confirmed: true }, runtime);
  const confirmedRun = await tool.execute(confirmSubmission, runtime);
  assert.equal(confirmedRun.data?.result?.job.status, "queued");

  const automaticSubmission = submit(budgetAuto, "job-auto");
  await assert.rejects(
    tool.execute(automaticSubmission, runtime),
    (error: unknown) => error instanceof RigoriumToolRuntimeError && error.code === "permission_denied",
  );
  const automaticRun = await tool.execute(submit(budgetAuto, "job-auto", true), runtime);
  assert.equal(automaticRun.data?.result?.job.status, "queued");
  assert.equal(transport.count("submit"), 2);

  await assert.rejects(
    tool.execute({ ...submit(budgetAuto, "job-auto", true), argv: ["python3", "other.py"] }, runtime),
    (error: unknown) => error instanceof RigoriumToolRuntimeError && error.code === "invalid_tool_input",
  );
  assert.equal(transport.count("submit"), 2, "a stable jobId cannot be rebound to new execution terms");

  transport.disconnectNextSubmit = true;
  const uncertainSubmission = submit(uncertainAuto, "job-uncertain", true);
  const uncertain = await tool.execute(uncertainSubmission, runtime);
  assert.equal(uncertain.data?.result?.job.phase, "submission_uncertain");
  assert.equal(transport.count("submit"), 3);
  const recoveredSubmit = await tool.execute(uncertainSubmission, runtime);
  assert.equal(recoveredSubmit.data?.result?.job.status, "queued");
  assert.equal(transport.count("submit"), 3, "an uncertain submit must recover instead of submitting again");
  assert.equal(transport.count("recover"), 1);

  const queried = await tool.execute({ operation: "query", jobId: "job-auto" }, runtime);
  assert.equal(queried.data?.result?.job.status, "queued");
  const recovered = await tool.execute({ operation: "recover", jobId: "job-auto" }, runtime);
  assert.equal(recovered.data?.result?.job.status, "queued");
  const cancelled = await tool.execute({ operation: "cancel", jobId: "job-auto" }, runtime);
  assert.equal(cancelled.data?.result?.job.status, "cancelled");
  assert.equal(transport.count("query"), 1);
  assert.equal(transport.count("recover"), 2);
  assert.equal(transport.count("cancel"), 1);
});

test("experiment_remote rejects malformed stage and confirmation input before execution", async () => {
  const tool = createExperimentRemoteTool({ transport: new RecordingTransport(), now: () => NOW });
  const runtime = context("D:\\synthetic-project");

  const stageValidation = await tool.validateInput!({
    operation: "stage",
    workdir: `${workspaceRoot}/project-a/run-a`,
    stageFiles: [],
  } as never, runtime);
  assert.equal(stageValidation.ok, false);
  if (stageValidation.ok) assert.fail("expected stage validation failure");
  assert.match(stageValidation.issues[0]?.message ?? "", /connectionId/u);

  const confirmValidation = await tool.validateInput!({
    operation: "confirm",
    grantId: "grant-main",
    jobId: "job-main",
    confirmed: false,
  } as never, runtime);
  assert.equal(confirmValidation.ok, false);
  if (confirmValidation.ok) assert.fail("expected confirmation validation failure");
  assert.match(confirmValidation.issues[0]?.message ?? "", /confirmed=true/u);

  await assert.rejects(
    tool.execute({ operation: "list", jobId: "job-ignored" } as never, runtime),
    (error: unknown) => error instanceof RigoriumToolRuntimeError
      && error.code === "invalid_tool_input"
      && /operation=list does not accept jobId/u.test(error.message),
  );
});

class RecordingTransport implements RemoteExecutionTransport {
  readonly requests: RemoteAgentRequest[] = [];
  disconnectNextSubmit = false;

  count(action: RemoteAgentRequest["action"]): number {
    return this.requests.filter((request) => request.action === action).length;
  }

  async request(_connection: RemoteConnectionRecord, request: RemoteAgentRequest): Promise<RemoteAgentResponse> {
    this.requests.push(request);
    if (request.action === "submit" && this.disconnectNextSubmit) {
      this.disconnectNextSubmit = false;
      throw new RemoteTransportError("disconnected", "Connection closed after request write.", {
        retryable: true,
        submissionUncertain: true,
      });
    }
    if (request.action === "stage") {
      return Object.freeze({
        protocolVersion: 1,
        requestId: request.requestId,
        ok: true,
        action: "stage",
        duplicate: false,
        stagedFiles: request.files.map(({ remoteRelativePath, remotePath, bytes, sha256 }) => ({
          remoteRelativePath,
          remotePath,
          bytes,
          sha256,
        })),
      });
    }
    const status: "cancelled" | "queued" = request.action === "cancel" ? "cancelled" : "queued";
    return Object.freeze({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      action: request.action,
      duplicate: request.action !== "submit",
      observation: {
        backend: request.backend,
        jobId: request.jobId,
        backendJobId: `ssh:${request.jobId}`,
        status,
        duplicate: request.action !== "submit",
        observedAt: NOW.toISOString(),
      },
    });
  }
}

function context(cwd: string): RigoriumToolRuntimeContext {
  return {
    sessionId: "experiment-remote-tool-test",
    turnId: "turn-1",
    cwd,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd }),
    now: () => NOW,
  };
}

async function issueGrant(
  projectRoot: string,
  mode: "plan_only" | "confirm_each" | "budget_auto",
  grantId: string,
): Promise<string> {
  const result = await issueExecutionGrant({
    projectRoot,
    grant: {
      grantId,
      experimentId: "experiment-main",
      mode,
      allowedAdapterIds: ["ssh"],
      reason: "Remote experiment tool test",
      budget: { maxAttempts: 3 },
    },
    now: NOW,
  });
  return result.value.payload.grantId;
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
