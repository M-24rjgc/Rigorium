export class RigoriumLifecycleRuntimeError extends Error {
  readonly name = "RigoriumLifecycleRuntimeError";

  constructor(
    readonly code: "hook_blocked" | "hook_failed",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
