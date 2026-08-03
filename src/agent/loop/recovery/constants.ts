/**
 * Loop-wide constants for recovery / status / scheduling behavior.
 * Extracted from AgentLoop so recovery modules can share them without
 * importing the loop class.
 */

export const TOOL_EVENT_PUMP_INTERVAL_MS = 500;
export const SUBAGENT_STATUS_HEARTBEAT_MS = 2_000;
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 4_096;
export const EMPTY_LENGTH_OUTPUT_RETRY_FLOOR = 4_096;

export const CIRCUIT_BREAKER_GRACE_PROMPT = [
  "Your last several tool calls all failed input validation with the same error.",
  "This may indicate a tool-side issue rather than a problem with your approach.",
  "Options: (1) try a different tool or different parameters,",
  "(2) explain the situation in text without calling tools,",
  "(3) if you believe the tool should work, try once more with corrected input.",
].join(" ");

export const PLAN_MODE_REMINDER_MESSAGE = [
  "Plan mode is active.",
  "Read first using read-only tools, then write or refine plan markdown only under `.rigorium/plans/`.",
  "Do not make implementation changes while planning.",
  "When the plan is ready for user review, call `exit_plan_mode` with the plan file path.",
].join("\n");
