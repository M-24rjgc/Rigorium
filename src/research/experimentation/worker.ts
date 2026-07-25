import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createExperimentRunWorkspace } from "./repository.js";
import type {
  ExperimentSpec,
  LocalMockWorker,
  LocalProcessWorker,
  WorkerArtifactInput,
  WorkerMetricInput,
  WorkerResultInput,
} from "./contracts.js";
import type { RunAttempt } from "./contracts.js";

const MAX_WORKER_OUTPUT_BYTES = 128 * 1024;
const MAX_WORKER_RESULT_BYTES = 4 * 1024 * 1024;
const TERMINATION_GRACE_MS = 500;

export type LocalWorkerExecution = Readonly<{
  workspacePath: string;
  metrics: readonly WorkerMetricInput[];
  artifacts: readonly WorkerArtifactInput[];
}>;

export class LocalWorkerFailure extends Error {
  constructor(
    readonly category:
      | "invalid_worker_result"
      | "worker_spawn_failed"
      | "worker_exit_nonzero"
      | "worker_signalled"
      | "timeout"
      | "cancelled"
      | "artifact_missing"
      | "storage_error"
      | "disconnected"
      | "preempted"
      | "out_of_memory"
      | "rate_limited"
      | "unknown",
    message: string,
    readonly exitCode?: number | null,
    readonly signal?: string,
  ) {
    super(message);
    this.name = "LocalWorkerFailure";
  }
}

export async function executeLocalWorker(input: {
  projectRoot: string;
  attempt: RunAttempt;
  spec: ExperimentSpec;
  abortSignal?: AbortSignal;
}): Promise<LocalWorkerExecution> {
  const worker = input.spec.payload.localWorker;
  if (!worker) {
    throw new LocalWorkerFailure("invalid_worker_result", "The experiment spec has no local worker definition.");
  }
  let workspacePath: string;
  try {
    workspacePath = await createExperimentRunWorkspace({
      projectRoot: input.projectRoot,
      attemptId: input.attempt.payload.attemptId,
    });
  } catch (error) {
    throw new LocalWorkerFailure("storage_error", `Unable to create an isolated run workspace: ${messageOf(error)}.`);
  }
  await writeFile(
    join(workspacePath, "input.json"),
    `${JSON.stringify({ spec: input.spec.payload, attempt: input.attempt.payload }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  if (worker.kind === "mock") return executeMockWorker(worker, workspacePath, input.abortSignal);
  return executeProcessWorker(worker, workspacePath, input.abortSignal);
}

async function executeMockWorker(
  worker: LocalMockWorker,
  workspacePath: string,
  abortSignal?: AbortSignal,
): Promise<LocalWorkerExecution> {
  await waitWithAbort(worker.delayMs ?? 0, abortSignal);
  if ((worker.outcome ?? "succeed") === "fail") {
    throw new LocalWorkerFailure(
      worker.failureCategory ?? "worker_exit_nonzero",
      worker.failureMessage ?? "Mock worker reported a failure.",
      1,
    );
  }
  const result = normalizeWorkerResult(worker.result ?? {});
  const artifacts: WorkerArtifactInput[] = [];
  for (const artifact of worker.result?.artifacts ?? []) {
    const relativePath = validateRelativeWorkerPath(artifact.path);
    const fullPath = join(workspacePath, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, artifact.content ?? "", "utf8");
    artifacts.push({
      path: relativePath,
      ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
      ...(artifact.role === undefined ? {} : { role: artifact.role }),
    });
  }
  return { workspacePath, metrics: result.metrics ?? [], artifacts };
}

async function executeProcessWorker(
  worker: LocalProcessWorker,
  workspacePath: string,
  abortSignal?: AbortSignal,
): Promise<LocalWorkerExecution> {
  if (!worker.command.trim() || worker.command.includes("\u0000")) {
    throw new LocalWorkerFailure("worker_spawn_failed", "Worker command must be non-empty and contain no NUL bytes.");
  }
  const outputPath = join(workspacePath, "result.json");
  const child = spawn(worker.command, [...(worker.args ?? [])], {
    cwd: workspacePath,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: buildWorkerEnvironment(workspacePath, outputPath),
  });
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout?.on("data", (chunk: Buffer | string) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    stdoutBytes += Buffer.byteLength(text, "utf8");
    if (stdout.length < MAX_WORKER_OUTPUT_BYTES) stdout += text.slice(0, MAX_WORKER_OUTPUT_BYTES - stdout.length);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    stderrBytes += Buffer.byteLength(text, "utf8");
    if (stderr.length < MAX_WORKER_OUTPUT_BYTES) stderr += text.slice(0, MAX_WORKER_OUTPUT_BYTES - stderr.length);
  });

  let timeout: NodeJS.Timeout | undefined;
  let forceKillTimeout: NodeJS.Timeout | undefined;
  let aborted = false;
  let timedOut = false;
  const requestTermination = () => {
    terminate(child, "SIGTERM");
    forceKillTimeout ??= setTimeout(() => terminate(child, "SIGKILL"), TERMINATION_GRACE_MS);
  };
  const onAbort = () => {
    aborted = true;
    requestTermination();
  };
  if (abortSignal?.aborted) onAbort();
  else abortSignal?.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = Math.max(1, Math.min(worker.timeoutMs ?? 300_000, 300_000));
  timeout = setTimeout(() => {
    timedOut = true;
    requestTermination();
  }, timeoutMs);
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  try {
    [exitCode, signal] = await waitForChild(child);
  } catch (error) {
    throw new LocalWorkerFailure("worker_spawn_failed", `Unable to start worker: ${messageOf(error)}.`);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (forceKillTimeout) clearTimeout(forceKillTimeout);
    abortSignal?.removeEventListener("abort", onAbort);
  }
  await writeWorkerLog(workspacePath, "stdout.log", stdout, stdoutBytes);
  await writeWorkerLog(workspacePath, "stderr.log", stderr, stderrBytes);
  if (timedOut) throw new LocalWorkerFailure("timeout", `Worker exceeded its ${timeoutMs}ms timeout.`, exitCode, signal ?? undefined);
  if (aborted) throw new LocalWorkerFailure("cancelled", "Worker was cancelled.", exitCode, signal ?? undefined);
  if (signal) throw new LocalWorkerFailure("worker_signalled", `Worker terminated by ${signal}.`, exitCode, signal);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw classifyProcessExit(exitCode, detail);
  }
  const output = await readWorkerResult(outputPath);
  return {
    workspacePath,
    metrics: output.metrics ?? [],
    artifacts: [
      ...(stdoutBytes > 0 ? [{ path: "stdout.log", role: "log" as const, mediaType: "text/plain" }] : []),
      ...(stderrBytes > 0 ? [{ path: "stderr.log", role: "log" as const, mediaType: "text/plain" }] : []),
      ...(output.artifacts ?? []),
    ],
  };
}

function normalizeWorkerResult(value: unknown): WorkerResultInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalWorkerFailure("invalid_worker_result", "Worker result must be an object.");
  }
  const record = value as Record<string, unknown>;
  const metrics = record.metrics === undefined ? [] : validateMetrics(record.metrics);
  const artifacts = record.artifacts === undefined ? [] : validateArtifacts(record.artifacts);
  return { metrics, artifacts };
}

async function readWorkerResult(path: string): Promise<WorkerResultInput> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return {};
    throw new LocalWorkerFailure("invalid_worker_result", `Worker result could not be inspected: ${messageOf(error)}.`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new LocalWorkerFailure("invalid_worker_result", "Worker result must be a regular file.");
  }
  if (stats.size > MAX_WORKER_RESULT_BYTES) throw new LocalWorkerFailure("invalid_worker_result", "Worker result is too large.");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new LocalWorkerFailure("invalid_worker_result", `Worker result could not be read: ${messageOf(error)}.`);
  }
  try {
    return normalizeWorkerResult(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof LocalWorkerFailure) throw error;
    throw new LocalWorkerFailure("invalid_worker_result", `Worker result is not valid JSON: ${messageOf(error)}.`);
  }
}

function validateMetrics(value: unknown): WorkerMetricInput[] {
  if (!Array.isArray(value)) throw new LocalWorkerFailure("invalid_worker_result", "Worker metrics must be an array.");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new LocalWorkerFailure("invalid_worker_result", `Worker metric ${index} must be an object.`);
    }
    const metric = entry as Record<string, unknown>;
    if (typeof metric.name !== "string" || !metric.name.trim() || typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
      throw new LocalWorkerFailure("invalid_worker_result", `Worker metric ${index} has an invalid name or value.`);
    }
    if (metric.direction !== undefined && !["minimize", "maximize", "neutral"].includes(String(metric.direction))) {
      throw new LocalWorkerFailure("invalid_worker_result", `Worker metric ${index} has an invalid direction.`);
    }
    return {
      name: metric.name,
      value: metric.value,
      ...(metric.unit === undefined ? {} : { unit: requireText(metric.unit, `metric ${index} unit`) }),
      ...(metric.split === undefined ? {} : { split: requireText(metric.split, `metric ${index} split`) }),
      ...(metric.direction === undefined ? {} : { direction: metric.direction as WorkerMetricInput["direction"] }),
    };
  });
}

function validateArtifacts(value: unknown): WorkerArtifactInput[] {
  if (!Array.isArray(value)) throw new LocalWorkerFailure("invalid_worker_result", "Worker artifacts must be an array.");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new LocalWorkerFailure("invalid_worker_result", `Worker artifact ${index} must be an object.`);
    }
    const artifact = entry as Record<string, unknown>;
    const path = typeof artifact.path === "string" ? validateRelativeWorkerPath(artifact.path) : "";
    if (!path) throw new LocalWorkerFailure("invalid_worker_result", `Worker artifact ${index} has an invalid path.`);
    if (artifact.role !== undefined && !["output", "log", "checkpoint", "figure", "table"].includes(String(artifact.role))) {
      throw new LocalWorkerFailure("invalid_worker_result", `Worker artifact ${index} has an invalid role.`);
    }
    return {
      path,
      ...(artifact.mediaType === undefined ? {} : { mediaType: requireText(artifact.mediaType, `artifact ${index} mediaType`) }),
      ...(artifact.role === undefined ? {} : { role: artifact.role as WorkerArtifactInput["role"] }),
    };
  });
}

function validateRelativeWorkerPath(value: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\u0000") || /^[A-Za-z]:/u.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    throw new LocalWorkerFailure("invalid_worker_result", `Worker artifact path must be relative: ${value}.`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized === "." || normalized.split("/").some((part) => part === "" || part === ".." || part.includes(":") || /[. ]$/u.test(part))) {
    throw new LocalWorkerFailure("invalid_worker_result", `Worker artifact path escapes the run directory: ${value}.`);
  }
  return normalized;
}

async function writeWorkerLog(workspacePath: string, filename: string, content: string, byteCount: number): Promise<void> {
  if (byteCount === 0) return;
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createWriteStream(join(workspacePath, filename), { encoding: "utf8" });
    stream.once("error", reject);
    stream.once("finish", resolvePromise);
    stream.end(content);
  });
}

function buildWorkerEnvironment(workspacePath: string, outputPath: string): NodeJS.ProcessEnv {
  const inherited = process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL"]) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  env.RIGORIUM_EXPERIMENT_RUN_DIR = workspacePath;
  env.RIGORIUM_EXPERIMENT_INPUT = join(workspacePath, "input.json");
  env.RIGORIUM_EXPERIMENT_OUTPUT = outputPath;
  return env;
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise([code, signal]));
  });
}

function terminate(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(signal); } catch { /* process may have exited */ }
}

function classifyProcessExit(exitCode: number | null, detail: string): LocalWorkerFailure {
  const normalized = detail.toLowerCase();
  if (exitCode === 137 || /\b(?:out of memory|out-of-memory|oom|cuda out of memory)\b/u.test(normalized)) {
    return new LocalWorkerFailure("out_of_memory", `Worker ran out of memory.${detail ? ` ${detail}` : ""}`, exitCode);
  }
  if (/\b(?:preempted|preemption|job requeued)\b/u.test(normalized)) {
    return new LocalWorkerFailure("preempted", `Worker was preempted.${detail ? ` ${detail}` : ""}`, exitCode);
  }
  if (/\b(?:rate limit|rate-limit|too many requests|http 429)\b/u.test(normalized)) {
    return new LocalWorkerFailure("rate_limited", `Worker hit a rate limit.${detail ? ` ${detail}` : ""}`, exitCode);
  }
  if (/\b(?:connection lost|disconnected|broken pipe|connection reset)\b/u.test(normalized)) {
    return new LocalWorkerFailure("disconnected", `Worker disconnected.${detail ? ` ${detail}` : ""}`, exitCode);
  }
  return new LocalWorkerFailure("worker_exit_nonzero", `Worker exited with code ${exitCode}.${detail ? ` ${detail}` : ""}`, exitCode);
}

async function waitWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 300_000) {
    throw new LocalWorkerFailure("invalid_worker_result", "Mock delayMs must be between 0 and 300000.");
  }
  if (signal?.aborted) throw new LocalWorkerFailure("cancelled", "Mock worker was cancelled.");
  if (delayMs === 0) return;
  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new LocalWorkerFailure("cancelled", "Mock worker was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\u0000") || value.length > 4096) {
    throw new LocalWorkerFailure("invalid_worker_result", `${label} must be non-empty text.`);
  }
  return value;
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && (value as NodeJS.ErrnoException).code === code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
