export type RigoriumToolErrorCode =
  | "tool_not_found"
  | "invalid_tool_input"
  | "permission_denied"
  | "permission_cancelled"
  | "permission_required"
  | "tool_execution_failed"
  | "tool_aborted"
  | "tool_timeout"
  | "result_too_large"
  | "path_not_allowed"
  | "file_not_found"
  | "file_conflict"
  | "unsupported_tool"
  | "setup_required"
  | "plan_mode_violation"
  | "ask_mode_violation";

export type RigoriumToolError = {
  code: RigoriumToolErrorCode;
  message: string;
  cause?: unknown;
  details?: Record<string, unknown>;
};

export class RigoriumToolRuntimeError extends Error {
  readonly code: RigoriumToolErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: RigoriumToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "RigoriumToolRuntimeError";
    this.code = code;
    this.details = details;
  }
}

export function toolError(
  code: RigoriumToolErrorCode,
  message: string,
  details?: Record<string, unknown>,
): RigoriumToolError {
  return { code, message, details };
}

export function normalizeToolError(error: unknown): RigoriumToolError {
  if (error instanceof RigoriumToolRuntimeError) {
    return toolError(error.code, error.message, error.details);
  }

  if (error instanceof Error) {
    return {
      code: "tool_execution_failed",
      message: error.message,
      cause: error,
    };
  }

  return {
    code: "tool_execution_failed",
    message: "Tool execution failed with a non-Error value.",
    cause: error,
  };
}
