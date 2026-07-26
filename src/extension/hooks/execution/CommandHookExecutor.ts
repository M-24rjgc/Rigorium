import { spawn } from "node:child_process";
import type { RigoriumHookInput } from "../protocol/input.js";
import type { RigoriumHookCommand } from "../protocol/settings.js";
import { parseHookOutput } from "./parseHookOutput.js";
import type { RigoriumHookOutput } from "../protocol/output.js";

export const RIGORIUM_HOOK_TIMEOUT_MS = 10 * 60 * 1000;
export const RIGORIUM_SESSION_END_HOOK_TIMEOUT_MS = 1500;

export type CommandHookExecutionOptions = {
  hook: Extract<RigoriumHookCommand, { type: "command" }>;
  hookInput: RigoriumHookInput;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type CommandHookExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode?: number;
  outcome: "success" | "blocking" | "non_blocking_error" | "cancelled" | "timeout";
  output: RigoriumHookOutput;
};

export class CommandHookExecutor {
  execute(options: CommandHookExecutionOptions): Promise<CommandHookExecutionResult> {
    const timeoutMs = options.timeoutMs ?? RIGORIUM_HOOK_TIMEOUT_MS;
    const child = spawn(options.hook.command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.stdin.end(JSON.stringify(options.hookInput));

    return new Promise((resolve) => {
      const finish = (result: Omit<CommandHookExecutionResult, "stdout" | "stderr" | "output">) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        resolve({
          ...result,
          stdout,
          stderr,
          output: parseHookOutput(stdout),
        });
      };

      const abort = () => {
        child.kill();
        finish({ outcome: "cancelled" });
      };

      const timer = setTimeout(() => {
        child.kill();
        finish({ outcome: "timeout" });
      }, timeoutMs);
      timer.unref();

      options.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", (error) => {
        stderr += error instanceof Error ? error.message : String(error);
        finish({ outcome: "non_blocking_error" });
      });
      child.on("close", (code) => {
        const exitCode = code ?? undefined;
        finish({
          exitCode,
          outcome: exitCode === 0 ? "success" : exitCode === 2 ? "blocking" : "non_blocking_error",
        });
      });
    });
  }
}
