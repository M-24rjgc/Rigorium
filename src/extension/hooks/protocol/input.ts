import type { RigoriumHookEvent } from "./events.js";

export type RigoriumHookBaseInput = {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  permissionMode?: string;
  agentId?: string;
  agentType?: string;
};

export type RigoriumHookInput = RigoriumHookBaseInput &
  Record<string, unknown> & {
    hookEventName: RigoriumHookEvent;
  };

export function createHookInput(
  event: RigoriumHookEvent,
  base: RigoriumHookBaseInput,
  payload: Record<string, unknown> = {},
): RigoriumHookInput {
  return {
    ...base,
    ...payload,
    hookEventName: event,
  };
}

export function toLegacyHookInput(input: RigoriumHookInput): Record<string, unknown> {
  const {
    hookEventName,
    sessionId,
    transcriptPath,
    permissionMode,
    agentId,
    agentType,
    ...rest
  } = input;

  const legacy: Record<string, unknown> = {
    ...camelRecordToSnake(rest),
    hook_event_name: hookEventName,
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: input.cwd,
  };

  if (permissionMode !== undefined) legacy.permission_mode = permissionMode;
  if (agentId !== undefined) legacy.agent_id = agentId;
  if (agentType !== undefined) legacy.agent_type = agentType;
  return legacy;
}

function camelRecordToSnake(record: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    output[camelToSnake(key)] = value;
  }
  return output;
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
