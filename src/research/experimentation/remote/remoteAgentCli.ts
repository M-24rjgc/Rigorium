import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { RemoteAgentRuntime } from "./remoteAgent.js";

const MAX_AGENT_INPUT_BYTES = 96 * 1024 * 1024;

export async function runRemoteAgentMain(options: Readonly<{
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  input?: AsyncIterable<Buffer | string>;
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
}> = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const writeStdout = options.writeStdout ?? ((value) => process.stdout.write(value));
  const writeStderr = options.writeStderr ?? ((value) => process.stderr.write(value));
  try {
    const workspaceRoot = requiredEnvironmentPath(env.RIGORIUM_REMOTE_WORKSPACE_ROOT, "RIGORIUM_REMOTE_WORKSPACE_ROOT");
    const stateRoot = requiredEnvironmentPath(env.RIGORIUM_REMOTE_STATE_ROOT, "RIGORIUM_REMOTE_STATE_ROOT");
    const selfPath = fileURLToPath(import.meta.url);
    const runtime = new RemoteAgentRuntime({
      workspaceRoot,
      stateRoot,
      runnerCommand: Object.freeze([process.execPath, selfPath, "--run-job"]),
    });
    if (argv[0] === "--run-job") {
      if (argv.length !== 2 || !argv[1]) throw new TypeError("--run-job requires exactly one state path.");
      await runtime.runWorker(argv[1]);
      return 0;
    }
    if (argv.length !== 0) throw new TypeError("Remote agent accepts no command-line request arguments.");
    const input = options.input ?? process.stdin;
    const raw = await readBoundedInput(input);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const response = await runtime.handle(parsed);
    writeStdout(`${JSON.stringify(response)}\n`);
    return 0;
  } catch (error) {
    writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function readBoundedInput(input: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_AGENT_INPUT_BYTES) throw new TypeError(`Remote agent input exceeds ${MAX_AGENT_INPUT_BYTES} bytes.`);
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!value) throw new TypeError("Remote agent requires one JSON request on stdin.");
  return value;
}

function requiredEnvironmentPath(value: string | undefined, name: string): string {
  if (!value?.trim() || value !== value.trim()) throw new TypeError(`${name} must be configured.`);
  return value;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  void runRemoteAgentMain().then((code) => {
    process.exitCode = code;
  });
}
