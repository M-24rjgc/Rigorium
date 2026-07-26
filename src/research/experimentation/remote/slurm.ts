import type {
  ExperimentFailure,
} from "../contracts.js";
import type {
  RemoteBackendJobObservation,
  SlurmResourceSpec,
} from "./contracts.js";
import { normalizeRemoteAbsolutePath } from "./paths.js";

export type SlurmSubmissionCommandInput = Readonly<{
  jobName: string;
  workdir: string;
  stdoutPath: string;
  stderrPath: string;
  runnerPath: string;
  runnerArgs?: readonly string[];
  statePath: string;
  /** Fixed agent invocation only; user argv/workdir never enter this wrapper. */
  runnerInvocation?: "wrap" | "script";
  resources?: SlurmResourceSpec;
}>;

export function buildSlurmSubmissionArgs(input: SlurmSubmissionCommandInput): readonly string[] {
  const jobName = slurmToken(input.jobName, "jobName");
  const workdir = normalizeRemoteAbsolutePath(input.workdir, "workdir");
  const stdoutPath = normalizeRemoteAbsolutePath(input.stdoutPath, "stdoutPath");
  const stderrPath = normalizeRemoteAbsolutePath(input.stderrPath, "stderrPath");
  const runnerPath = normalizeRemoteAbsolutePath(input.runnerPath, "runnerPath");
  const statePath = normalizeRemoteAbsolutePath(input.statePath, "statePath");
  const resources = normalizeSlurmResources(input.resources);
  const args: string[] = [
    "--parsable",
    "--chdir", workdir,
    "--job-name", jobName,
    "--output", stdoutPath,
    "--error", stderrPath,
  ];
  addOptionalToken(args, "--partition", resources.partition);
  addOptionalToken(args, "--account", resources.account);
  addOptionalToken(args, "--qos", resources.qos);
  addOptionalToken(args, "--constraint", resources.constraint);
  addOptionalInteger(args, "--nodes", resources.nodes);
  addOptionalInteger(args, "--ntasks", resources.tasks);
  addOptionalInteger(args, "--cpus-per-task", resources.cpusPerTask);
  if (resources.memoryMiB !== undefined) args.push("--mem", `${resources.memoryMiB}M`);
  addOptionalInteger(args, "--gpus", resources.gpus);
  addOptionalInteger(args, "--time", resources.timeLimitMinutes);
  const runnerArgs = (input.runnerArgs ?? []).map((value, index) => programArgument(value, `runnerArgs[${index}]`));
  const invocation = input.runnerInvocation ?? "wrap";
  if (invocation === "wrap") {
    args.push("--wrap", shellCommand([runnerPath, ...runnerArgs, statePath]));
  } else {
    args.push(runnerPath, ...runnerArgs, statePath);
  }
  return Object.freeze(args);
}

export function parseSlurmSubmissionOutput(stdout: string): Readonly<{
  schedulerJobId: string;
  cluster?: string;
  backendJobId: string;
}> {
  const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) ?? "";
  const [schedulerJobId, cluster, ...rest] = line.split(";");
  if (!/^\d+(?:_[0-9]+)?$/u.test(schedulerJobId ?? "") || rest.length > 0) {
    throw new TypeError(`Slurm sbatch returned an invalid parsable job id: ${line || "empty output"}.`);
  }
  if (cluster !== undefined && cluster !== "" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(cluster)) {
    throw new TypeError("Slurm sbatch returned an unsafe cluster name.");
  }
  return Object.freeze({
    schedulerJobId,
    ...(cluster ? { cluster } : {}),
    backendJobId: cluster ? `slurm:${cluster}:${schedulerJobId}` : `slurm:${schedulerJobId}`,
  });
}

export function parseSlurmAccountingLine(input: {
  jobId: string;
  observationJobId?: string;
  stdout: string;
  now?: Date;
}): RemoteBackendJobObservation | undefined {
  const rows = input.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const exact = rows
    .map((line) => line.split("|"))
    .find((columns) => columns[0] === input.jobId && columns.length >= 4);
  if (!exact) return undefined;
  const state = String(exact[1] ?? "").split(/[ +]/u)[0]!.toUpperCase();
  const exitCode = parseExitCode(exact[2]);
  const reason = String(exact[3] ?? "").trim();
  return slurmStateObservation({
    jobId: input.observationJobId ?? input.jobId,
    schedulerJobId: input.jobId,
    state,
    exitCode,
    reason,
    startedAt: parseSlurmTimestamp(exact[4]),
    finishedAt: parseSlurmTimestamp(exact[5]),
    now: input.now,
  });
}

export function parseSlurmQueueLine(input: {
  jobId: string;
  observationJobId?: string;
  stdout: string;
  now?: Date;
}): RemoteBackendJobObservation | undefined {
  const rows = input.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const exact = rows.map((line) => line.split("|")).find((columns) => columns[0] === input.jobId && columns.length >= 2);
  if (!exact) return undefined;
  return slurmStateObservation({
    jobId: input.observationJobId ?? input.jobId,
    schedulerJobId: input.jobId,
    state: String(exact[1] ?? ""),
    reason: String(exact[2] ?? "").trim(),
    startedAt: parseSlurmTimestamp(exact[3]),
    now: input.now,
  });
}

export function parseSlurmNamedObservation(input: {
  jobName: string;
  stdout: string;
  source: "queue" | "accounting";
  observationJobId: string;
  now?: Date;
}): RemoteBackendJobObservation | undefined {
  const rows = input.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (const columns of rows.map((line) => line.split("|"))) {
    if (columns.length < 3 || columns[1] !== input.jobName || !/^\d+(?:_[0-9]+)?$/u.test(columns[0] ?? "")) continue;
    const schedulerJobId = columns[0]!;
    const state = String(columns[2] ?? "");
    const exitCode = input.source === "accounting" ? parseExitCode(columns[3]) : undefined;
    const reason = String(columns[input.source === "accounting" ? 4 : 3] ?? "").trim();
    const startedAt = parseSlurmTimestamp(columns[input.source === "accounting" ? 5 : 4]);
    const finishedAt = input.source === "accounting" ? parseSlurmTimestamp(columns[6]) : undefined;
    return slurmStateObservation({
      jobId: input.observationJobId,
      schedulerJobId,
      state,
      exitCode,
      reason,
      startedAt,
      finishedAt,
      now: input.now,
    });
  }
  return undefined;
}

export function slurmStateObservation(input: {
  jobId: string;
  schedulerJobId?: string;
  state: string;
  exitCode?: number | null;
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
  now?: Date;
}): RemoteBackendJobObservation {
  const observedAt = (input.now ?? new Date()).toISOString();
  const state = input.state.trim().toUpperCase().split(/[ +]/u)[0]!;
  const schedulerJobId = input.schedulerJobId ?? input.jobId;
  const failure = slurmFailure(state, input.reason, observedAt, input.exitCode);
  const status: RemoteBackendJobObservation["status"] =
    ["PENDING", "CONFIGURING", "SUSPENDED", "RESV_DEL_HOLD", "REQUEUE_FED", "REQUEUE_HOLD"].includes(state)
      ? "queued"
      : ["RUNNING", "COMPLETING", "STAGE_OUT", "RESIZING"].includes(state)
        ? "running"
        : state === "COMPLETED"
          ? "succeeded"
          : state === "CANCELLED"
            ? "cancelled"
            : failure
              ? "failed"
              : "unknown";
  return Object.freeze({
    backend: "slurm",
    jobId: input.jobId,
    backendJobId: `slurm:${schedulerJobId}`,
    schedulerJobId,
    status,
    duplicate: true,
    observedAt,
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(failure ? { failure } : {}),
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
  });
}

export function normalizeSlurmResources(value: SlurmResourceSpec | undefined): SlurmResourceSpec {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("slurm resources must be an object.");
  return Object.freeze({
    ...(value.partition === undefined ? {} : { partition: slurmToken(value.partition, "partition") }),
    ...(value.account === undefined ? {} : { account: slurmToken(value.account, "account") }),
    ...(value.qos === undefined ? {} : { qos: slurmToken(value.qos, "qos") }),
    ...(value.constraint === undefined ? {} : { constraint: slurmToken(value.constraint, "constraint") }),
    ...(value.nodes === undefined ? {} : { nodes: boundedInteger(value.nodes, "nodes", 1, 65_536) }),
    ...(value.tasks === undefined ? {} : { tasks: boundedInteger(value.tasks, "tasks", 1, 1_000_000) }),
    ...(value.cpusPerTask === undefined ? {} : { cpusPerTask: boundedInteger(value.cpusPerTask, "cpusPerTask", 1, 65_536) }),
    ...(value.memoryMiB === undefined ? {} : { memoryMiB: boundedInteger(value.memoryMiB, "memoryMiB", 1, 1_073_741_824) }),
    ...(value.gpus === undefined ? {} : { gpus: boundedInteger(value.gpus, "gpus", 1, 65_536) }),
    ...(value.timeLimitMinutes === undefined ? {} : { timeLimitMinutes: boundedInteger(value.timeLimitMinutes, "timeLimitMinutes", 1, 5_256_000) }),
  });
}

function slurmFailure(
  state: string,
  reason: string | undefined,
  observedAt: string,
  exitCode: number | null | undefined,
): ExperimentFailure | undefined {
  const category = state === "PREEMPTED"
    ? "preempted"
    : state === "OUT_OF_MEMORY"
      ? "out_of_memory"
      : state === "TIMEOUT" || state === "DEADLINE"
        ? "timeout"
        : ["FAILED", "NODE_FAIL", "BOOT_FAIL", "REVOKED", "SPECIAL_EXIT"].includes(state)
          ? "unknown"
          : undefined;
  if (!category) return undefined;
  return Object.freeze({
    category,
    message: `Slurm job entered ${state}${reason ? `: ${reason}` : "."}`,
    retryable: ["preempted", "timeout", "unknown"].includes(category),
    observedAt,
    ...(exitCode === undefined ? {} : { exitCode }),
  });
}

function parseExitCode(value: string | undefined): number | null | undefined {
  if (!value) return undefined;
  const [code] = value.split(":");
  if (!/^\d+$/u.test(code ?? "")) return undefined;
  return Number(code);
}

function parseSlurmTimestamp(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text || /^(?:n\/?a|none|unknown|invalid|not_set|0)$/iu.test(text)) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function addOptionalToken(args: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) args.push(flag, value);
}

function addOptionalInteger(args: string[], flag: string, value: number | undefined): void {
  if (value !== undefined) args.push(flag, String(value));
}

function slurmToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new TypeError(`${label} must be a safe Slurm token.`);
  }
  return value;
}

function programArgument(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 4_096 || value.includes("\u0000")
    || /[\u0001-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded argument without control characters.`);
  }
  return value;
}

function shellCommand(values: readonly string[]): string {
  return values.map((value) => "'" + value.replaceAll("'", "'\"'\"'") + "'").join(" ");
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}
