import { spawn } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";
import type { ExperimentFailure } from "../contracts.js";
import type {
  RemoteAgentErrorCode,
  RemoteAgentJobRequest,
  RemoteAgentRequest,
  RemoteAgentResponse,
  RemoteAgentSubmitRequest,
  RemoteBackendJobObservation,
  SlurmResourceSpec,
} from "./contracts.js";
import {
  createRemoteAgentJobState,
  RemoteAgentStateError,
  RemoteAgentStateRepository,
  type RemoteAgentJobPaths,
  type RemoteAgentJobState,
  updateRemoteAgentJobState,
} from "./agentState.js";
import { remoteJobKey } from "./paths.js";
import { validateRemoteAgentRequest } from "./protocol.js";
import {
  buildSlurmSubmissionArgs,
  parseSlurmAccountingLine,
  parseSlurmNamedObservation,
  parseSlurmQueueLine,
  parseSlurmSubmissionOutput,
} from "./slurm.js";

const SCHEDULER_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;

export type RemoteAgentCommandResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

export type RemoteAgentExperimentResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
}>;

export interface RemoteAgentProcessHost {
  runCommand(input: Readonly<{
    executable: string;
    args: readonly string[];
    cwd?: string;
    timeoutMs: number;
  }>): Promise<RemoteAgentCommandResult>;
  launchDetached(input: Readonly<{
    executable: string;
    args: readonly string[];
    cwd: string;
  }>): Promise<number>;
  runExperiment(input: Readonly<{
    argv: readonly string[];
    cwd: string;
    stdoutPath: string;
    stderrPath: string;
    onSpawn: (pid: number) => Promise<void>;
    timeoutMs?: number;
  }>): Promise<RemoteAgentExperimentResult>;
  isProcessAlive(pid: number): boolean;
  terminateProcessTree(pid: number): Promise<void>;
}

export class RemoteAgentProcessError extends Error {
  readonly code: "spawn_failed" | "timeout" | "output_limit";

  constructor(code: RemoteAgentProcessError["code"], message: string) {
    super(message);
    this.name = "RemoteAgentProcessError";
    this.code = code;
  }
}

export class NodeRemoteAgentProcessHost implements RemoteAgentProcessHost {
  async runCommand(input: Readonly<{
    executable: string;
    args: readonly string[];
    cwd?: string;
    timeoutMs: number;
  }>): Promise<RemoteAgentCommandResult> {
    return new Promise<RemoteAgentCommandResult>((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawn(input.executable, [...input.args], {
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        rejectPromise(processError("spawn_failed", `Unable to spawn ${input.executable}: ${messageOf(error)}`));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let exceeded = false;
      let timedOut = false;
      let settled = false;
      let terminationStarted = false;
      let escalation: NodeJS.Timeout | undefined;
      const terminate = () => {
        if (terminationStarted) return;
        terminationStarted = true;
        child.kill("SIGTERM");
        escalation = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 1_000);
        escalation.unref();
      };
      const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          exceeded = true;
          terminate();
          return;
        }
        target.push(buffer);
      };
      child.stdout.on("data", capture(stdout));
      child.stderr.on("data", capture(stderr));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        rejectPromise(processError("spawn_failed", `Unable to run ${input.executable}: ${error.message}`));
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        if (timedOut) {
          rejectPromise(processError("timeout", `${input.executable} exceeded ${input.timeoutMs}ms.`));
          return;
        }
        if (exceeded) {
          rejectPromise(processError("output_limit", `${input.executable} output exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes.`));
          return;
        }
        resolvePromise(Object.freeze({
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }));
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, input.timeoutMs);
      timeout.unref();
    });
  }

  async launchDetached(input: Readonly<{
    executable: string;
    args: readonly string[];
    cwd: string;
  }>): Promise<number> {
    return new Promise<number>((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawn(input.executable, [...input.args], {
          cwd: input.cwd,
          shell: false,
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        });
      } catch (error) {
        rejectPromise(processError("spawn_failed", `Unable to launch remote runner: ${messageOf(error)}`));
        return;
      }
      child.once("error", (error) => rejectPromise(processError("spawn_failed", `Unable to launch remote runner: ${error.message}`)));
      child.once("spawn", () => {
        if (!Number.isSafeInteger(child.pid) || child.pid! <= 0) {
          rejectPromise(processError("spawn_failed", "Remote runner did not expose a process id."));
          return;
        }
        child.unref();
        resolvePromise(child.pid!);
      });
    });
  }

  async runExperiment(input: Readonly<{
    argv: readonly string[];
    cwd: string;
    stdoutPath: string;
    stderrPath: string;
    onSpawn: (pid: number) => Promise<void>;
    timeoutMs?: number;
  }>): Promise<RemoteAgentExperimentResult> {
    const [stdout, stderr] = await Promise.all([
      open(input.stdoutPath, "a", 0o600),
      open(input.stderrPath, "a", 0o600),
    ]);
    try {
      return await this.#runExperimentWithHandles(input, stdout, stderr);
    } finally {
      await Promise.all([stdout.close().catch(() => undefined), stderr.close().catch(() => undefined)]);
    }
  }

  isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  async terminateProcessTree(pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    const target = process.platform === "win32" ? pid : -pid;
    try {
      process.kill(target, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return;
    }
    await delay(250);
    if (process.platform === "win32" && !this.isProcessAlive(pid)) return;
    try {
      process.kill(target, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  async #runExperimentWithHandles(
    input: Readonly<{
      argv: readonly string[];
      cwd: string;
      stdoutPath: string;
      stderrPath: string;
      onSpawn: (pid: number) => Promise<void>;
      timeoutMs?: number;
    }>,
    stdout: FileHandle,
    stderr: FileHandle,
  ): Promise<RemoteAgentExperimentResult> {
    return new Promise<RemoteAgentExperimentResult>((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawn(input.argv[0]!, [...input.argv.slice(1)], {
          cwd: input.cwd,
          shell: false,
          detached: true,
          windowsHide: true,
          stdio: ["ignore", stdout.fd, stderr.fd],
        });
      } catch (error) {
        rejectPromise(processError("spawn_failed", `Unable to spawn experiment command: ${messageOf(error)}`));
        return;
      }
      let settled = false;
      let spawnRecorded = Promise.resolve();
      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;
      const terminateForTimeout = () => {
        if (!Number.isSafeInteger(child.pid) || child.pid! <= 0) return;
        timedOut = true;
        void this.terminateProcessTree(child.pid!).catch(() => {
          try { child.kill("SIGKILL"); } catch { /* process may already be gone */ }
        });
      };
      child.once("spawn", () => {
        if (!Number.isSafeInteger(child.pid) || child.pid! <= 0) {
          spawnRecorded = Promise.reject(processError("spawn_failed", "Experiment process did not expose a process id."));
          return;
        }
        spawnRecorded = input.onSpawn(child.pid!);
        if (input.timeoutMs !== undefined) {
          timeout = setTimeout(terminateForTimeout, input.timeoutMs);
          timeout.unref();
        }
        void spawnRecorded.catch((error) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          void this.terminateProcessTree(child.pid!).catch(() => undefined);
          rejectPromise(error);
        });
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        rejectPromise(processError("spawn_failed", `Unable to spawn experiment command: ${error.message}`));
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        spawnRecorded.then(() => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          resolvePromise(Object.freeze({ exitCode, signal, ...(timedOut ? { timedOut: true } : {}) }));
        }, (error) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          if (!child.killed) child.kill("SIGTERM");
          rejectPromise(error);
        });
      });
    });
  }
}

export class RemoteAgentRuntime {
  readonly repository: RemoteAgentStateRepository;
  readonly #processHost: RemoteAgentProcessHost;
  readonly #runnerCommand: readonly string[];

  constructor(options: Readonly<{
    workspaceRoot: string;
    stateRoot: string;
    actualWorkspaceRoot?: string;
    actualStateRoot?: string;
    runnerCommand: readonly string[];
    processHost?: RemoteAgentProcessHost;
    now?: () => Date;
  }>) {
    if (!Array.isArray(options.runnerCommand) || options.runnerCommand.length === 0) throw new TypeError("runnerCommand is required.");
    this.#runnerCommand = Object.freeze(options.runnerCommand.map((value, index) => boundedArgument(value, `runnerCommand[${index}]`)));
    this.#processHost = options.processHost ?? new NodeRemoteAgentProcessHost();
    this.repository = new RemoteAgentStateRepository({
      workspaceRoot: options.workspaceRoot,
      stateRoot: options.stateRoot,
      ...(options.actualWorkspaceRoot === undefined ? {} : { actualWorkspaceRoot: options.actualWorkspaceRoot }),
      ...(options.actualStateRoot === undefined ? {} : { actualStateRoot: options.actualStateRoot }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  async handle(value: unknown): Promise<RemoteAgentResponse> {
    let request: RemoteAgentRequest;
    try {
      request = validateRemoteAgentRequest(value);
    } catch (error) {
      return invalidRequestResponse(value, error);
    }
    try {
      await this.repository.initialize();
      this.repository.assertRequestRoots(request);
      if (request.action === "stage") {
        const result = await this.repository.stage(request);
        return Object.freeze({
          protocolVersion: 1,
          requestId: request.requestId,
          ok: true,
          action: "stage",
          duplicate: result.duplicate,
          stagedFiles: result.files,
        });
      }
      if (request.action === "submit") return await this.#submit(request);
      return await this.#operate(request);
    } catch (error) {
      return errorResponse(request, error);
    }
  }

  async runWorker(remoteJobPath: string): Promise<void> {
    await this.repository.initialize();
    const paths = this.repository.pathsFromRemoteJobPath(remoteJobPath);
    const claim = await this.repository.withJobLock(paths, async () => {
      const current = await this.repository.loadJob(paths);
      if (!current) throw new RemoteAgentStateError("job_not_found", "Remote worker job state does not exist.");
      const expected = this.repository.pathsFor(current.request);
      if (expected.key !== paths.key || expected.remoteJobPath !== remoteJobPath) {
        throw new RemoteAgentStateError("path_violation", "Remote worker state path does not match its job identity.");
      }
      if (isTerminal(current.status) || current.cancelRequestedAt) return Object.freeze({ state: current, claimed: false });
      if (current.request.backend === "ssh") {
        if (current.processPid !== undefined && this.#processHost.isProcessAlive(current.processPid)) {
          return Object.freeze({ state: current, claimed: false });
        }
        if (current.runnerPid !== undefined && current.runnerPid !== process.pid) {
          if (this.#processHost.isProcessAlive(current.runnerPid)) return Object.freeze({ state: current, claimed: false });
          const now = this.repository.now();
          const failure: ExperimentFailure = Object.freeze({
            category: "disconnected",
            message: "The original SSH runner disappeared; a duplicate worker invocation was not allowed to rerun the job.",
            retryable: true,
            observedAt: now.toISOString(),
          });
          const uncertain = await this.repository.saveJob(paths, transitionState(current, { status: "unknown", failure }, now));
          return Object.freeze({ state: uncertain, claimed: false });
        }
        if (current.status === "running" || current.status === "unknown") {
          return Object.freeze({ state: current, claimed: false });
        }
      }
      const now = this.repository.now();
      const running = transitionState(current, {
        status: "running",
        runnerPid: process.pid,
        startedAt: current.startedAt ?? now.toISOString(),
      }, now);
      return Object.freeze({ state: await this.repository.saveJob(paths, running), claimed: true });
    });
    let state = claim.state;
    if (!claim.claimed) return;
    let result: RemoteAgentExperimentResult;
    try {
      const actualWorkdir = await this.repository.ensureWorkdir(state.request.workdir);
      result = await this.#processHost.runExperiment({
        argv: state.request.argv,
        cwd: actualWorkdir,
        stdoutPath: paths.actualStdoutPath,
        stderrPath: paths.actualStderrPath,
        ...(state.request.maxWallTimeMs === undefined ? {} : { timeoutMs: state.request.maxWallTimeMs }),
        onSpawn: async (pid) => {
          let cancelledBeforeRecording = false;
          state = await this.repository.withJobLock(paths, async () => {
            const current = await requireJob(this.repository, paths);
            if (isTerminal(current.status) || current.cancelRequestedAt) {
              cancelledBeforeRecording = true;
              return current;
            }
            return this.repository.saveJob(paths, transitionState(current, { status: "running", processPid: pid }, this.repository.now()));
          });
          if (cancelledBeforeRecording) {
            await this.#processHost.terminateProcessTree(pid);
            throw new RemoteAgentProcessError("spawn_failed", "Experiment process was cancelled before its pid could be recorded.");
          }
        },
      });
    } catch (error) {
      await this.repository.withJobLock(paths, async () => {
        const current = await requireJob(this.repository, paths);
        if (isTerminal(current.status)) return;
        const now = this.repository.now();
        const failure = failureForProcessError(error, now);
        await this.repository.saveJob(paths, transitionState(current, {
          status: "failed",
          failure,
          finishedAt: now.toISOString(),
        }, now));
      });
      return;
    }
    await this.repository.withJobLock(paths, async () => {
      const current = await requireJob(this.repository, paths);
      if (isTerminal(current.status)) return;
      const now = this.repository.now();
      if (result.timedOut) {
        const failure: ExperimentFailure = Object.freeze({
          category: "timeout",
          message: `Remote experiment exceeded its ${state.request.maxWallTimeMs}ms execution grant wall-time reservation.`,
          retryable: true,
          observedAt: now.toISOString(),
          exitCode: result.exitCode,
          ...(result.signal === null ? {} : { signal: result.signal }),
        });
        await this.repository.saveJob(paths, transitionState(current, {
          status: "failed",
          exitCode: result.exitCode,
          ...(result.signal === null ? {} : { signal: result.signal }),
          failure,
          finishedAt: now.toISOString(),
        }, now));
        return;
      }
      if (result.exitCode === 0 && result.signal === null) {
        await this.repository.saveJob(paths, transitionState(current, {
          status: "succeeded",
          exitCode: 0,
          finishedAt: now.toISOString(),
        }, now));
        return;
      }
      const failure: ExperimentFailure = Object.freeze({
        category: result.signal ? "worker_signalled" : "worker_exit_nonzero",
        message: result.signal
          ? `Remote experiment was terminated by ${result.signal}.`
          : `Remote experiment exited with code ${String(result.exitCode)}.`,
        retryable: false,
        observedAt: now.toISOString(),
        exitCode: result.exitCode,
        ...(result.signal === null ? {} : { signal: result.signal }),
      });
      await this.repository.saveJob(paths, transitionState(current, {
        status: "failed",
        exitCode: result.exitCode,
        ...(result.signal === null ? {} : { signal: result.signal }),
        failure,
        finishedAt: now.toISOString(),
      }, now));
    });
  }

  async #submit(request: RemoteAgentSubmitRequest): Promise<RemoteAgentResponse> {
    const paths = this.repository.pathsFor(request);
    const result = await this.repository.withJobLock(paths, async () => {
      const existing = await this.repository.loadJob(paths);
      if (existing) {
        assertSameSubmission(existing, request);
        return Object.freeze({ state: existing, duplicate: true });
      }
      const stage = await this.repository.loadStage(paths);
      if (stage) {
        if (stage.requestHash !== request.requestHash || stage.jobId !== request.jobId) {
          throw new RemoteAgentStateError("job_conflict", `Staged files for ${request.jobId} belong to another request.`);
        }
        await this.repository.verifyStage(stage);
      }
      const workdir = await this.repository.ensureWorkdir(request.workdir);
      if (request.backend === "ssh") {
        let state = createRemoteAgentJobState({
          request,
          status: "queued",
          backendJobId: `ssh:${remoteJobKey(request.requestHash).slice(0, 48)}`,
          now: this.repository.now(),
        });
        state = await this.repository.saveJob(paths, state);
        try {
          const runnerPid = await this.#processHost.launchDetached({
            executable: this.#runnerCommand[0]!,
            args: Object.freeze([...this.#runnerCommand.slice(1), paths.remoteJobPath]),
            cwd: paths.actualDirectory,
          });
          const now = this.repository.now();
          state = await this.repository.saveJob(paths, transitionState(state, {
            status: "queued",
            runnerPid,
            submittedAt: now.toISOString(),
          }, now));
        } catch (error) {
          const now = this.repository.now();
          state = await this.repository.saveJob(paths, transitionState(state, {
            status: "failed",
            failure: failureForProcessError(error, now),
            finishedAt: now.toISOString(),
          }, now));
        }
        return Object.freeze({ state, duplicate: false });
      }
      const slurmJobName = stableSlurmJobName(paths.key);
      let state = createRemoteAgentJobState({ request, status: "queued", slurmJobName, now: this.repository.now() });
      state = await this.repository.saveJob(paths, state);
      state = await this.#submitSlurm(paths, state, workdir);
      return Object.freeze({ state, duplicate: false });
    });
    return successObservationResponse(request, stateObservation(result.state, result.duplicate), result.duplicate);
  }

  async #operate(request: RemoteAgentJobRequest): Promise<RemoteAgentResponse> {
    const paths = this.repository.pathsFor(request);
    const state = await this.repository.withJobLock(paths, async () => {
      const current = await this.repository.loadJob(paths);
      if (!current) throw new RemoteAgentStateError("job_not_found", `Remote job ${request.jobId} was not found.`);
      assertJobRequest(current, request);
      if (request.action === "cancel") return this.#cancel(paths, current);
      if (isTerminal(current.status)) return current;
      return current.request.backend === "ssh"
        ? this.#refreshSsh(paths, current)
        : this.#refreshSlurm(paths, current, true);
    });
    return successObservationResponse(request, stateObservation(state, true), true);
  }

  async #submitSlurm(paths: RemoteAgentJobPaths, state: RemoteAgentJobState, actualWorkdir: string): Promise<RemoteAgentJobState> {
    const args = buildSlurmSubmissionArgs({
      jobName: state.slurmJobName!,
      workdir: state.request.workdir,
      stdoutPath: paths.remoteStdoutPath,
      stderrPath: paths.remoteStderrPath,
      runnerPath: this.#runnerCommand[0]!,
      runnerArgs: this.#runnerCommand.slice(1),
      statePath: paths.remoteJobPath,
      runnerInvocation: "wrap",
      resources: slurmResourcesWithinWallBudget(state.request.slurm, state.request.maxWallTimeMs),
    });
    try {
      const result = await this.#processHost.runCommand({
        executable: "sbatch",
        args,
        cwd: actualWorkdir,
        timeoutMs: SCHEDULER_COMMAND_TIMEOUT_MS,
      });
      if (result.exitCode === 0 && result.signal === null) {
        try {
          const submitted = parseSlurmSubmissionOutput(result.stdout);
          const now = this.repository.now();
          return this.repository.saveJob(paths, transitionState(state, {
            status: "queued",
            backendJobId: submitted.backendJobId,
            schedulerJobId: submitted.schedulerJobId,
            submittedAt: now.toISOString(),
          }, now));
        } catch {
          return this.#refreshSlurm(paths, state, true, timeoutFailure("Slurm submission returned an unrecognized job id.", this.repository.now()));
        }
      }
      const now = this.repository.now();
      const failure: ExperimentFailure = Object.freeze({
        category: "adapter_unavailable",
        message: `sbatch rejected the job: ${boundedDiagnostic(result.stderr || result.stdout)}.`,
        retryable: false,
        observedAt: now.toISOString(),
        exitCode: result.exitCode,
        ...(result.signal === null ? {} : { signal: result.signal }),
      });
      return this.repository.saveJob(paths, transitionState(state, { status: "failed", failure, finishedAt: now.toISOString() }, now));
    } catch (error) {
      return this.#refreshSlurm(paths, state, true, failureForSchedulerUncertainty(error, this.repository.now()));
    }
  }

  async #refreshSsh(paths: RemoteAgentJobPaths, state: RemoteAgentJobState): Promise<RemoteAgentJobState> {
    const processAlive = state.processPid !== undefined && this.#processHost.isProcessAlive(state.processPid);
    const runnerAlive = state.runnerPid !== undefined && this.#processHost.isProcessAlive(state.runnerPid);
    const now = this.repository.now();
    if (processAlive) return this.repository.saveJob(paths, transitionState(state, { status: "running" }, now));
    if (runnerAlive) return this.repository.saveJob(paths, transitionState(state, { status: state.status === "queued" ? "queued" : "running" }, now));
    const failure: ExperimentFailure = Object.freeze({
      category: "disconnected",
      message: "The detached SSH runner disappeared before recording a terminal result.",
      retryable: true,
      observedAt: now.toISOString(),
    });
    return this.repository.saveJob(paths, transitionState(state, { status: "unknown", failure }, now));
  }

  async #refreshSlurm(
    paths: RemoteAgentJobPaths,
    state: RemoteAgentJobState,
    recoverByName: boolean,
    fallbackFailure?: ExperimentFailure,
  ): Promise<RemoteAgentJobState> {
    let observation: RemoteBackendJobObservation | undefined;
    if (state.schedulerJobId) observation = await this.#querySlurmById(state);
    if (!observation && recoverByName && state.slurmJobName) observation = await this.#querySlurmByName(state);
    if (!observation) {
      const now = this.repository.now();
      const failure = fallbackFailure ?? Object.freeze({
        category: "disconnected" as const,
        message: "Slurm did not expose the job by scheduler id or stable job name.",
        retryable: true,
        observedAt: now.toISOString(),
      });
      return this.repository.saveJob(paths, transitionState(state, { status: "unknown", failure }, now));
    }
    const normalized: RemoteBackendJobObservation = Object.freeze({
      ...observation,
      jobId: state.request.jobId,
      duplicate: true,
      ...(state.backendJobId === undefined ? {} : { backendJobId: state.backendJobId }),
    });
    return this.repository.saveJob(paths, stateFromObservation(state, normalized, this.repository.now()));
  }

  async #querySlurmById(state: RemoteAgentJobState): Promise<RemoteBackendJobObservation | undefined> {
    const schedulerJobId = state.schedulerJobId!;
    const queue = await this.#schedulerCommand("squeue", ["--noheader", "--jobs", schedulerJobId, "--format", "%i|%T|%R|%S"]);
    if (queue?.exitCode === 0 && queue.signal === null) {
      const observation = parseSlurmQueueLine({
        jobId: schedulerJobId,
        observationJobId: state.request.jobId,
        stdout: queue.stdout,
        now: this.repository.now(),
      });
      if (observation) return observation;
    }
    const accounting = await this.#schedulerCommand("sacct", [
      "--noheader", "--parsable2", "--jobs", schedulerJobId,
      "--format", "JobIDRaw,State,ExitCode,Reason,Start,End",
    ]);
    if (accounting?.exitCode !== 0 || accounting.signal !== null) return undefined;
    return parseSlurmAccountingLine({
      jobId: schedulerJobId,
      observationJobId: state.request.jobId,
      stdout: accounting.stdout,
      now: this.repository.now(),
    });
  }

  async #querySlurmByName(state: RemoteAgentJobState): Promise<RemoteBackendJobObservation | undefined> {
    const jobName = state.slurmJobName!;
    const queue = await this.#schedulerCommand("squeue", ["--noheader", "--name", jobName, "--format", "%i|%j|%T|%R|%S"]);
    if (queue?.exitCode === 0 && queue.signal === null) {
      const observation = parseSlurmNamedObservation({
        jobName,
        stdout: queue.stdout,
        source: "queue",
        observationJobId: state.request.jobId,
        now: this.repository.now(),
      });
      if (observation) return observation;
    }
    const accounting = await this.#schedulerCommand("sacct", [
      "--noheader", "--parsable2", "--duplicates", "--name", jobName,
      "--format", "JobIDRaw,JobName,State,ExitCode,Reason,Start,End",
    ]);
    if (accounting?.exitCode !== 0 || accounting.signal !== null) return undefined;
    return parseSlurmNamedObservation({
      jobName,
      stdout: accounting.stdout,
      source: "accounting",
      observationJobId: state.request.jobId,
      now: this.repository.now(),
    });
  }

  async #schedulerCommand(executable: "squeue" | "sacct", args: readonly string[]): Promise<RemoteAgentCommandResult | undefined> {
    try {
      return await this.#processHost.runCommand({ executable, args, timeoutMs: SCHEDULER_COMMAND_TIMEOUT_MS });
    } catch {
      return undefined;
    }
  }

  async #cancel(paths: RemoteAgentJobPaths, state: RemoteAgentJobState): Promise<RemoteAgentJobState> {
    if (isTerminal(state.status)) return state;
    if (state.request.backend === "ssh") {
      if (state.processPid !== undefined) await this.#processHost.terminateProcessTree(state.processPid);
      const now = this.repository.now();
      return this.repository.saveJob(paths, cancelledState(state, now));
    }
    let current = state;
    if (!current.schedulerJobId) current = await this.#refreshSlurm(paths, current, true);
    if (!current.schedulerJobId) return current;
    let result: RemoteAgentCommandResult;
    try {
      result = await this.#processHost.runCommand({
        executable: "scancel",
        args: Object.freeze([current.schedulerJobId]),
        timeoutMs: SCHEDULER_COMMAND_TIMEOUT_MS,
      });
    } catch (error) {
      const now = this.repository.now();
      return this.repository.saveJob(paths, transitionState(current, {
        status: "unknown",
        failure: failureForSchedulerUncertainty(error, now),
      }, now));
    }
    if (result.exitCode !== 0 || result.signal !== null) return this.#refreshSlurm(paths, current, false);
    const now = this.repository.now();
    return this.repository.saveJob(paths, cancelledState(current, now));
  }
}

function successObservationResponse(
  request: Exclude<RemoteAgentRequest, { action: "stage" }>,
  observation: RemoteBackendJobObservation,
  duplicate: boolean,
): RemoteAgentResponse {
  return Object.freeze({
    protocolVersion: 1,
    requestId: request.requestId,
    ok: true,
    action: request.action,
    duplicate,
    observation,
  });
}

function stateObservation(state: RemoteAgentJobState, duplicate: boolean): RemoteBackendJobObservation {
  return Object.freeze({
    backend: state.request.backend,
    jobId: state.request.jobId,
    ...(state.backendJobId === undefined ? {} : { backendJobId: state.backendJobId }),
    ...(state.schedulerJobId === undefined ? {} : { schedulerJobId: state.schedulerJobId }),
    status: state.status,
    duplicate,
    observedAt: state.observedAt,
    ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
    ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
    ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
    ...(state.signal === undefined ? {} : { signal: state.signal }),
    ...(state.failure === undefined ? {} : { failure: state.failure }),
  });
}

function stateFromObservation(state: RemoteAgentJobState, observation: RemoteBackendJobObservation, now: Date): RemoteAgentJobState {
  return transitionState(state, {
    status: observation.status,
    ...(state.backendJobId || observation.backendJobId ? { backendJobId: state.backendJobId ?? observation.backendJobId } : {}),
    ...(state.schedulerJobId || observation.schedulerJobId ? { schedulerJobId: state.schedulerJobId ?? observation.schedulerJobId } : {}),
    ...(observation.exitCode === undefined ? {} : { exitCode: observation.exitCode }),
    ...(observation.signal === undefined ? {} : { signal: observation.signal }),
    ...(observation.failure === undefined ? {} : { failure: observation.failure }),
    ...(state.startedAt || observation.startedAt ? { startedAt: state.startedAt ?? observation.startedAt } : {}),
    ...(["succeeded", "failed", "cancelled"].includes(observation.status)
      ? { finishedAt: observation.finishedAt ?? observation.observedAt }
      : {}),
    observedAt: observation.observedAt,
  }, now);
}

function transitionState(
  current: RemoteAgentJobState,
  changes: Partial<Omit<RemoteAgentJobState, "schemaVersion" | "kind" | "request" | "createdAt" | "integrityHash">> & { status: RemoteAgentJobState["status"] },
  now: Date,
): RemoteAgentJobState {
  const {
    failure: _failure,
    finishedAt: _finishedAt,
    exitCode: _exitCode,
    signal: _signal,
    ...withoutTerminalState
  } = current;
  const terminal = ["succeeded", "failed", "cancelled"].includes(changes.status);
  return updateRemoteAgentJobState(withoutTerminalState as RemoteAgentJobState, {
    ...changes,
    ...(terminal && changes.finishedAt === undefined ? { finishedAt: now.toISOString() } : {}),
  }, now);
}

function cancelledState(state: RemoteAgentJobState, now: Date): RemoteAgentJobState {
  const failure: ExperimentFailure = Object.freeze({
    category: "cancelled",
    message: "Remote job was cancelled by an explicit request.",
    retryable: false,
    observedAt: now.toISOString(),
  });
  return transitionState(state, {
    status: "cancelled",
    failure,
    cancelRequestedAt: now.toISOString(),
    finishedAt: now.toISOString(),
  }, now);
}

function assertSameSubmission(state: RemoteAgentJobState, request: RemoteAgentSubmitRequest): void {
  if (JSON.stringify(state.request) !== JSON.stringify(request)) {
    throw new RemoteAgentStateError("job_conflict", `Remote job ${request.jobId} cannot be rebound to another request.`);
  }
}

function assertJobRequest(state: RemoteAgentJobState, request: RemoteAgentJobRequest): void {
  if (state.request.connectionId !== request.connectionId || state.request.projectId !== request.projectId
    || state.request.jobId !== request.jobId || state.request.requestHash !== request.requestHash || state.request.backend !== request.backend) {
    throw new RemoteAgentStateError("job_conflict", `Remote job ${request.jobId} identity does not match its durable state.`);
  }
  if (request.backendJobId && state.backendJobId && request.backendJobId !== state.backendJobId) {
    throw new RemoteAgentStateError("job_conflict", `Remote job ${request.jobId} backend identity changed.`);
  }
}

async function requireJob(repository: RemoteAgentStateRepository, paths: RemoteAgentJobPaths): Promise<RemoteAgentJobState> {
  const state = await repository.loadJob(paths);
  if (!state) throw new RemoteAgentStateError("job_not_found", "Remote job state disappeared.");
  return state;
}

function stableSlurmJobName(key: string): string {
  return `pd-${key.slice(0, 40)}`;
}

function slurmResourcesWithinWallBudget(
  resources: SlurmResourceSpec | undefined,
  maxWallTimeMs: number | undefined,
): SlurmResourceSpec | undefined {
  if (maxWallTimeMs === undefined) return resources;
  const safeMinutes = Math.floor(maxWallTimeMs / 60_000);
  if (safeMinutes < 1) {
    throw new RemoteAgentStateError(
      "scheduler_error",
      "Slurm cannot enforce a wall-time reservation shorter than one minute; do not submit this job.",
    );
  }
  const requestedMinutes = resources?.timeLimitMinutes;
  return Object.freeze({
    ...(resources ?? {}),
    timeLimitMinutes: requestedMinutes === undefined ? safeMinutes : Math.min(requestedMinutes, safeMinutes),
  });
}

function isTerminal(status: RemoteAgentJobState["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function failureForProcessError(error: unknown, now: Date): ExperimentFailure {
  const spawnFailure = error instanceof RemoteAgentProcessError && error.code === "spawn_failed";
  return Object.freeze({
    category: spawnFailure ? "worker_spawn_failed" : "unknown",
    message: messageOf(error),
    retryable: false,
    observedAt: now.toISOString(),
  });
}

function failureForSchedulerUncertainty(error: unknown, now: Date): ExperimentFailure {
  return Object.freeze({
    category: error instanceof RemoteAgentProcessError && error.code === "timeout" ? "timeout" : "disconnected",
    message: `Slurm submission result is uncertain: ${messageOf(error)}`,
    retryable: true,
    observedAt: now.toISOString(),
  });
}

function timeoutFailure(message: string, now: Date): ExperimentFailure {
  return Object.freeze({ category: "disconnected", message, retryable: true, observedAt: now.toISOString() });
}

function errorResponse(request: RemoteAgentRequest, error: unknown): RemoteAgentResponse {
  const mapped = mapRuntimeError(error);
  return Object.freeze({
    protocolVersion: 1,
    requestId: request.requestId,
    ok: false,
    action: request.action,
    code: mapped.code,
    message: boundedDiagnostic(mapped.message),
    retryable: mapped.retryable,
  });
}

function invalidRequestResponse(value: unknown, error: unknown): RemoteAgentResponse {
  const requestId = isRecord(value) && typeof value.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.requestId)
    ? value.requestId
    : "invalid-request";
  const action = isRecord(value) && ["stage", "submit", "query", "recover", "cancel"].includes(String(value.action))
    ? value.action as RemoteAgentRequest["action"]
    : "query";
  return Object.freeze({
    protocolVersion: 1,
    requestId,
    ok: false,
    action,
    code: "invalid_request",
    message: boundedDiagnostic(messageOf(error)),
    retryable: false,
  });
}

function mapRuntimeError(error: unknown): Readonly<{ code: RemoteAgentErrorCode; message: string; retryable: boolean }> {
  if (error instanceof RemoteAgentStateError) {
    const code: RemoteAgentErrorCode = error.code === "storage_error" ? "internal_error" : error.code;
    return Object.freeze({ code, message: error.message, retryable: error.code === "job_not_found" || error.code === "storage_error" });
  }
  if (error instanceof RemoteAgentProcessError) {
    return Object.freeze({
      code: error.code === "spawn_failed" ? "adapter_unavailable" : "scheduler_error",
      message: error.message,
      retryable: error.code !== "spawn_failed",
    });
  }
  if (error instanceof TypeError) return Object.freeze({ code: "invalid_request", message: error.message, retryable: false });
  return Object.freeze({ code: "internal_error", message: messageOf(error), retryable: true });
}

function boundedArgument(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 4_096 || value.includes("\u0000")
    || /[\u0001-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded argument without control characters.`);
  }
  return value;
}

function boundedDiagnostic(value: string): string {
  const trimmed = value.trim().slice(0, 16_000);
  return trimmed || "Remote operation failed without a diagnostic";
}

function processError(code: RemoteAgentProcessError["code"], message: string): RemoteAgentProcessError {
  return new RemoteAgentProcessError(code, message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
