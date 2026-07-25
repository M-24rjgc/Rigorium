import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import type {
  NumericalExpectation,
  NumericalVerificationResult,
  VerificationCheckSpec,
  VerificationRecord,
} from "./contracts.js";

const MAX_CAPTURED_OUTPUT_BYTES = 4 * 1024 * 1024;

export async function runVerificationCheck(input: {
  projectRoot: string;
  workspaceRoot: string;
  check: VerificationCheckSpec;
  abortSignal?: AbortSignal;
  recordId?: string;
  now?: Date;
}): Promise<VerificationRecord> {
  const check = assertCheck(input.check);
  const workspaceRoot = await assertIsolatedWorkspace(input.projectRoot, input.workspaceRoot);
  const recordId = input.recordId === undefined
    ? `verification-${randomUUID()}`
    : identifier(input.recordId, "recordId");
  const executedAt = isoDate(input.now ?? new Date(), "now");
  const command = Object.freeze([check.command, ...check.args]);
  const startedAt = performance.now();
  const stdout = outputCapture();
  const stderr = outputCapture();

  if (input.abortSignal?.aborted) {
    return record({
      id: recordId,
      check,
      command,
      status: "cancelled",
      exitCode: null,
      stdout,
      stderr,
      durationMs: elapsed(startedAt),
      executedAt,
      numericalResults: [],
      failureMessage: "Verification was cancelled before the process started.",
    });
  }

  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(check.command, [...check.args], {
      cwd: workspaceRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return record({
      id: recordId,
      check,
      command,
      status: "failed",
      exitCode: null,
      stdout,
      stderr,
      durationMs: elapsed(startedAt),
      executedAt,
      numericalResults: [],
      failureMessage: `Unable to start verification: ${messageOf(error)}.`,
    });
  }

  let timedOut = false;
  let cancelled = false;
  let outputLimitExceeded = false;
  let spawnError: Error | undefined;
  const terminate = () => {
    if (child.killed) return;
    try { child.kill("SIGTERM"); } catch { /* process may already be closed */ }
  };
  const captureStdout = (chunk: Buffer | string) => {
    stdout.add(chunk);
    if (stdout.bytes > MAX_CAPTURED_OUTPUT_BYTES) {
      outputLimitExceeded = true;
      terminate();
    }
  };
  const captureStderr = (chunk: Buffer | string) => {
    stderr.add(chunk);
    if (stderr.bytes > MAX_CAPTURED_OUTPUT_BYTES) {
      outputLimitExceeded = true;
      terminate();
    }
  };
  child.stdout.on("data", captureStdout);
  child.stderr.on("data", captureStderr);
  child.once("error", (error) => { spawnError = error; });

  const onAbort = () => {
    if (timedOut) return;
    cancelled = true;
    terminate();
  };
  input.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    if (cancelled) return;
    timedOut = true;
    terminate();
  }, check.timeoutMs);

  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  try {
    [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolvePromise) => {
      child.once("close", (code, closeSignal) => resolvePromise([code, closeSignal]));
    });
  } finally {
    clearTimeout(timeout);
    input.abortSignal?.removeEventListener("abort", onAbort);
    child.stdout.off("data", captureStdout);
    child.stderr.off("data", captureStderr);
  }

  const failures: string[] = [];
  let status: VerificationRecord["status"] = "passed";
  if (timedOut) {
    status = "timeout";
    failures.push(`Verification exceeded its ${check.timeoutMs}ms timeout.`);
  } else if (cancelled) {
    status = "cancelled";
    failures.push("Verification was cancelled.");
  } else if (spawnError) {
    status = "failed";
    failures.push(`Unable to start verification: ${spawnError.message}.`);
  } else if (signal) {
    status = "failed";
    failures.push(`Verification was terminated by ${signal}.`);
  }
  const markFailed = () => {
    if (status === "passed") status = "failed";
  };
  if (outputLimitExceeded) {
    markFailed();
    failures.push(`Verification output exceeded ${MAX_CAPTURED_OUTPUT_BYTES} bytes.`);
  }
  if (!timedOut && !cancelled && !spawnError && !signal && exitCode !== check.expectedExitCode) {
    status = "failed";
    failures.push(`Verification exited with code ${exitCode}; expected ${check.expectedExitCode}.`);
  }

  const stdoutText = stdout.text();
  for (const expectedText of check.stdoutIncludes) {
    if (!stdoutText.includes(expectedText)) {
      markFailed();
      failures.push(`Verification stdout did not include ${JSON.stringify(expectedText)}.`);
    }
  }
  const numerical = evaluateNumericalExpectations(check.numericalExpectations, stdoutText);
  if (numerical.failureMessage) {
    markFailed();
    failures.push(numerical.failureMessage);
  }
  if (numerical.results.some((result) => !result.passed)) {
    markFailed();
    failures.push("One or more numerical expectations failed.");
  }

  return record({
    id: recordId,
    check,
    command,
    status,
    exitCode,
    signal,
    stdout,
    stderr,
    durationMs: elapsed(startedAt),
    executedAt,
    numericalResults: numerical.results,
    ...(failures.length === 0 ? {} : { failureMessage: failures.join(" ") }),
  });
}

function evaluateNumericalExpectations(
  expectations: readonly NumericalExpectation[],
  stdout: string,
): { results: NumericalVerificationResult[]; failureMessage?: string } {
  if (expectations.length === 0) return { results: [] };
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim()) as unknown;
  } catch (error) {
    return {
      results: expectations.map((expectation) => resultFor(expectation, undefined)),
      failureMessage: `Numerical verification stdout is not valid JSON: ${messageOf(error)}.`,
    };
  }
  if (!isRecord(value)) {
    return {
      results: expectations.map((expectation) => resultFor(expectation, undefined)),
      failureMessage: "Numerical verification stdout must be a JSON object.",
    };
  }
  return {
    results: expectations.map((expectation) => {
      const actual = numberAtKey(value, expectation.key);
      return resultFor(expectation, actual);
    }),
  };
}

function resultFor(expectation: NumericalExpectation, actual: number | undefined): NumericalVerificationResult {
  return Object.freeze({
    key: expectation.key,
    expected: expectation.expected,
    ...(actual === undefined ? {} : { actual }),
    absoluteTolerance: expectation.absoluteTolerance,
    passed: actual !== undefined && Math.abs(actual - expectation.expected) <= expectation.absoluteTolerance,
  });
}

function numberAtKey(value: Record<string, unknown>, key: string): number | undefined {
  const exact = value[key];
  if (typeof exact === "number" && Number.isFinite(exact)) return exact;
  let current: unknown = value;
  for (const segment of key.split(".")) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

async function assertIsolatedWorkspace(projectRootInput: string, workspaceRootInput: string): Promise<string> {
  const projectRoot = rootPath(projectRootInput, "projectRoot");
  const workspaceRoot = rootPath(workspaceRootInput, "workspaceRoot");
  const [projectStats, workspaceStats] = await Promise.all([lstat(projectRoot), lstat(workspaceRoot)]);
  if (!projectStats.isDirectory() || projectStats.isSymbolicLink()) {
    throw new TypeError("projectRoot must be a real directory.");
  }
  if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
    throw new TypeError("workspaceRoot must be a real directory.");
  }
  const [projectRealRoot, workspaceRealRoot] = await Promise.all([realpath(projectRoot), realpath(workspaceRoot)]);
  if (containsPath(projectRealRoot, workspaceRealRoot) || containsPath(workspaceRealRoot, projectRealRoot)) {
    throw new TypeError("Verification workspace must be separate from the project root.");
  }
  return workspaceRealRoot;
}

function containsPath(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function rootPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\u0000")) {
    throw new TypeError(`${label} must be a non-empty path.`);
  }
  return resolve(value);
}

function assertCheck(value: VerificationCheckSpec): VerificationCheckSpec {
  if (!value || typeof value !== "object" || !["unit", "numerical", "smoke"].includes(value.kind)) {
    throw new TypeError("check.kind is invalid.");
  }
  if (typeof value.command !== "string" || !value.command.trim() || value.command !== value.command.trim()
    || value.command.includes("\u0000")) {
    throw new TypeError("check.command must be non-empty text without NUL bytes.");
  }
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string" || arg.includes("\u0000"))) {
    throw new TypeError("check.args must contain bounded process arguments.");
  }
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 3_600_000) {
    throw new TypeError("check.timeoutMs is invalid.");
  }
  if (!Number.isSafeInteger(value.expectedExitCode)) throw new TypeError("check.expectedExitCode must be an integer.");
  if (!Array.isArray(value.stdoutIncludes) || value.stdoutIncludes.some((entry) => typeof entry !== "string")) {
    throw new TypeError("check.stdoutIncludes must be an array of strings.");
  }
  if (!Array.isArray(value.numericalExpectations)) throw new TypeError("check.numericalExpectations must be an array.");
  if (value.kind === "numerical" && value.numericalExpectations.length === 0) {
    throw new TypeError("A numerical check needs at least one expectation.");
  }
  for (const expectation of value.numericalExpectations) {
    identifier(expectation.key, "numerical expectation key");
    if (!Number.isFinite(expectation.expected) || !Number.isFinite(expectation.absoluteTolerance)
      || expectation.absoluteTolerance < 0) {
      throw new TypeError("Numerical expectations require finite values and non-negative tolerances.");
    }
  }
  return value;
}

function outputCapture() {
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let bytes = 0;
  let storedBytes = 0;
  return {
    add(chunk: Buffer | string) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      bytes += buffer.length;
      hash.update(buffer);
      const remaining = MAX_CAPTURED_OUTPUT_BYTES - storedBytes;
      if (remaining > 0) {
        const captured = buffer.subarray(0, remaining);
        chunks.push(captured);
        storedBytes += captured.length;
      }
    },
    get bytes() { return bytes; },
    text() { return Buffer.concat(chunks, storedBytes).toString("utf8"); },
    digest() { return `sha256:${hash.digest("hex")}`; },
  };
}

function record(input: {
  id: string;
  check: VerificationCheckSpec;
  command: readonly string[];
  status: VerificationRecord["status"];
  exitCode: number | null;
  signal?: string | null;
  stdout: ReturnType<typeof outputCapture>;
  stderr: ReturnType<typeof outputCapture>;
  durationMs: number;
  executedAt: string;
  numericalResults: readonly NumericalVerificationResult[];
  failureMessage?: string;
}): VerificationRecord {
  return Object.freeze({
    id: input.id,
    checkId: input.check.id,
    kind: input.check.kind,
    status: input.status,
    command: input.command,
    exitCode: input.exitCode,
    ...(input.signal ? { signal: input.signal } : {}),
    stdoutHash: input.stdout.digest(),
    stderrHash: input.stderr.digest(),
    stdoutBytes: input.stdout.bytes,
    stderrBytes: input.stderr.bytes,
    durationMs: input.durationMs,
    executedAt: input.executedAt,
    workspaceMode: "isolated" as const,
    numericalResults: Object.freeze([...input.numericalResults]),
    ...(input.failureMessage === undefined ? {} : { failureMessage: input.failureMessage }),
  });
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new TypeError(`${label} must be a safe identifier.`);
  }
  return value;
}

function isoDate(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`${label} must be a valid date.`);
  return value.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
