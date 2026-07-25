import { spawn } from "node:child_process";
import type {
  RemoteAgentRequest,
  RemoteAgentResponse,
  RemoteConnectionRecord,
  RemoteExecutionTransport,
} from "./contracts.js";
import { validateRemoteAgentResponse } from "./protocol.js";

const MAX_TRANSPORT_OUTPUT_BYTES = 4 * 1024 * 1024;

export type RemoteProcessResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

export interface RemoteProcessRunner {
  run(input: Readonly<{
    executable: string;
    args: readonly string[];
    stdin: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }>): Promise<RemoteProcessResult>;
}

export type RemoteTransportErrorCode =
  | "spawn_failed"
  | "timeout"
  | "cancelled"
  | "host_key"
  | "authentication"
  | "disconnected"
  | "protocol_error";

export class RemoteTransportError extends Error {
  readonly code: RemoteTransportErrorCode;
  readonly retryable: boolean;
  readonly submissionUncertain: boolean;

  constructor(code: RemoteTransportErrorCode, message: string, options: {
    retryable: boolean;
    submissionUncertain?: boolean;
  }) {
    super(message);
    this.name = "RemoteTransportError";
    this.code = code;
    this.retryable = options.retryable;
    this.submissionUncertain = options.submissionUncertain ?? false;
  }
}

export class OpenSshRemoteTransport implements RemoteExecutionTransport {
  readonly #runner: RemoteProcessRunner;

  constructor(options: Readonly<{ runner?: RemoteProcessRunner }> = {}) {
    this.#runner = options.runner ?? new NodeRemoteProcessRunner();
  }

  async request(
    connection: RemoteConnectionRecord,
    request: RemoteAgentRequest,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<RemoteAgentResponse> {
    const invocation = buildOpenSshInvocation(connection);
    let result: RemoteProcessResult;
    try {
      result = await this.#runner.run({
        executable: invocation.executable,
        args: invocation.args,
        stdin: `${JSON.stringify(request)}\n`,
        timeoutMs: connection.requestTimeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (error instanceof RemoteTransportError) {
        if (request.action === "submit" && ["timeout", "disconnected", "cancelled", "protocol_error"].includes(error.code)) {
          throw new RemoteTransportError(error.code, error.message, { retryable: error.retryable, submissionUncertain: true });
        }
        throw error;
      }
      throw new RemoteTransportError("spawn_failed", `Unable to start OpenSSH: ${messageOf(error)}`, { retryable: false });
    }
    if (result.exitCode !== 0 || result.signal) throw classifyOpenSshFailure(result, request.action === "submit");
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      throw new RemoteTransportError("protocol_error", "Remote agent returned invalid JSON.", {
        retryable: false,
        submissionUncertain: request.action === "submit",
      });
    }
    try {
      return validateRemoteAgentResponse(parsed, request);
    } catch (error) {
      throw new RemoteTransportError("protocol_error", `Remote agent response is invalid: ${messageOf(error)}`, {
        retryable: false,
        submissionUncertain: request.action === "submit",
      });
    }
  }
}

export function buildOpenSshInvocation(connection: RemoteConnectionRecord): Readonly<{
  executable: string;
  args: readonly string[];
}> {
  const destinationHost = connection.host.includes(":") && !connection.host.startsWith("[")
    ? `[${connection.host}]`
    : connection.host;
  const destination = connection.username ? `${connection.username}@${destinationHost}` : destinationHost;
  const args: string[] = [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${connection.knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=none",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "RequestTTY=no",
    "-o", "LogLevel=ERROR",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-o", `ConnectTimeout=${Math.max(1, Math.ceil(connection.connectTimeoutMs / 1_000))}`,
    "-p", String(connection.port),
  ];
  if (connection.identityFile) args.push("-o", "IdentitiesOnly=yes", "-i", connection.identityFile);
  args.push("--", destination, ...connection.agentCommand);
  return Object.freeze({ executable: connection.sshExecutable, args: Object.freeze(args) });
}

export class NodeRemoteProcessRunner implements RemoteProcessRunner {
  async run(input: Readonly<{
    executable: string;
    args: readonly string[];
    stdin: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }>): Promise<RemoteProcessResult> {
    if (input.signal?.aborted) throw new RemoteTransportError("cancelled", "Remote request was cancelled before OpenSSH started.", { retryable: true });
    return new Promise<RemoteProcessResult>((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawn(input.executable, [...input.args], {
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        rejectPromise(new RemoteTransportError("spawn_failed", `Unable to spawn OpenSSH: ${messageOf(error)}`, { retryable: false }));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let cancelled = false;
      let outputExceeded = false;
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
      child.stdout.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.byteLength;
        if (stdoutBytes > MAX_TRANSPORT_OUTPUT_BYTES) {
          outputExceeded = true;
          terminate();
          return;
        }
        stdout.push(buffer);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += buffer.byteLength;
        if (stderrBytes > MAX_TRANSPORT_OUTPUT_BYTES) {
          outputExceeded = true;
          terminate();
          return;
        }
        stderr.push(buffer);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        input.signal?.removeEventListener("abort", onAbort);
        rejectPromise(new RemoteTransportError("spawn_failed", `OpenSSH process failed: ${error.message}`, { retryable: false }));
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        input.signal?.removeEventListener("abort", onAbort);
        if (outputExceeded) {
          rejectPromise(new RemoteTransportError("protocol_error", `OpenSSH output exceeded ${MAX_TRANSPORT_OUTPUT_BYTES} bytes.`, { retryable: false }));
          return;
        }
        if (timedOut) {
          rejectPromise(new RemoteTransportError("timeout", `OpenSSH request exceeded ${input.timeoutMs}ms.`, { retryable: true }));
          return;
        }
        if (cancelled) {
          rejectPromise(new RemoteTransportError("cancelled", "OpenSSH request was cancelled.", { retryable: true }));
          return;
        }
        resolvePromise(Object.freeze({
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }));
      });
      const onAbort = () => {
        cancelled = true;
        terminate();
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, input.timeoutMs);
      child.stdin.end(input.stdin, "utf8");
    });
  }
}

function classifyOpenSshFailure(result: RemoteProcessResult, submission: boolean): RemoteTransportError {
  const diagnostic = result.stderr.trim().slice(0, 2_000);
  const lower = diagnostic.toLocaleLowerCase("en-US");
  if (lower.includes("host key verification failed") || lower.includes("remote host identification has changed")) {
    return new RemoteTransportError("host_key", `OpenSSH host-key verification failed: ${diagnostic}`, { retryable: false });
  }
  if (lower.includes("permission denied") || lower.includes("no supported authentication methods")) {
    return new RemoteTransportError("authentication", `OpenSSH authentication failed: ${diagnostic}`, { retryable: false });
  }
  const disconnected = lower.includes("connection timed out")
    || lower.includes("connection reset")
    || lower.includes("connection closed")
    || lower.includes("could not resolve hostname")
    || lower.includes("no route to host")
    || lower.includes("network is unreachable")
    || result.signal !== null;
  if (disconnected) {
    return new RemoteTransportError("disconnected", `OpenSSH disconnected: ${diagnostic || result.signal || "no diagnostic"}`, {
      retryable: true,
      submissionUncertain: submission,
    });
  }
  return new RemoteTransportError("protocol_error", `OpenSSH exited without a valid response: ${diagnostic || `code ${result.exitCode}`}.`, {
    retryable: false,
    submissionUncertain: submission,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
