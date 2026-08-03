import type {
  CanonicalToolSchema,
} from "../../model/index.js";
import type {
  RigoriumReadFileStateMap,
  RigoriumToolDefinition,
  RigoriumToolResult,
  RigoriumWriteSnapshotMap,
} from "../../tool/index.js";
import type { LifecycleDispatchResult } from "../../lifecycle/index.js";
import type { PermissionMode, PermissionRule } from "../../permission/index.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import {
  ASK_MODE_DESCRIPTION_SUFFIX,
  isAskModeAllowedTool,
} from "../../tool/askModeConstraints.js";
import { buildAskModeAgentToolSchema } from "../../tool/builtin/agent.js";
import { isRecord } from "./recovery/messages.js";

/** Replace user-source rules with the caller's user rules, preserving others. */
export function mergeUserRules(target: PermissionRule[], userRules: PermissionRule[] | undefined): void {
  const nonUserRules = target.filter((rule) => rule.source !== "user");
  target.splice(0, target.length, ...nonUserRules, ...(userRules ?? []));
}

/** Filter tools to ask-mode-allowed set, overriding the agent tool schema. */
export function filterAskModeTools(tools: RigoriumToolDefinition[]): CanonicalToolSchema[] {
  const agentOverride = buildAskModeAgentToolSchema();
  return tools
    .filter(isAskModeAllowedTool)
    .map((tool) => {
      if (tool.name === "agent") {
        return { ...toolToCanonicalSchema(tool), description: agentOverride.description, inputSchema: agentOverride.inputSchema };
      }
      const suffix = ASK_MODE_DESCRIPTION_SUFFIX[tool.name];
      const schema = toolToCanonicalSchema(tool);
      return suffix ? { ...schema, description: schema.description + suffix } : schema;
    });
}

export function toolToCanonicalSchema(tool: RigoriumToolDefinition): CanonicalToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

export function findLifecycleBlock(result: LifecycleDispatchResult): { reason: string; stopReason?: string } | undefined {
  return result.effects.find(
    (effect): effect is { type: "block"; reason: string; stopReason?: string } => effect.type === "block",
  );
}

export function findToolLifecycleBlock(results: RigoriumToolResult[]): { reason: string; stopReason?: string } | undefined {
  for (const result of results) {
    const lifecycle = result.metadata?.lifecycle;
    if (isRecord(lifecycle) && isRecord(lifecycle.blocked) && typeof lifecycle.blocked.reason === "string") {
      return {
        reason: lifecycle.blocked.reason,
        stopReason: typeof lifecycle.blocked.stopReason === "string" ? lifecycle.blocked.stopReason : undefined,
      };
    }
  }
  return undefined;
}

export function cloneReadFileStateMap(
  state: RigoriumReadFileStateMap | undefined,
): RigoriumReadFileStateMap {
  const out: RigoriumReadFileStateMap = new Map();
  if (!state) return out;
  for (const [key, value] of state.entries()) {
    out.set(key, { ...value });
  }
  return out;
}

export function cloneWriteSnapshotMap(
  state: RigoriumWriteSnapshotMap | undefined,
): RigoriumWriteSnapshotMap {
  const out: RigoriumWriteSnapshotMap = new Map();
  if (!state) return out;
  for (const [key, value] of state.entries()) {
    out.set(key, { ...value });
  }
  return out;
}

/** Extract the subagent id from a `"<cwd>::sub::<id>"` session id. */
export function subagentIdFromSessionId(sessionId: string): string | undefined {
  const marker = "::sub::";
  const index = sessionId.lastIndexOf(marker);
  if (index < 0) return undefined;
  const subagentId = sessionId.slice(index + marker.length).trim();
  return subagentId.length > 0 ? subagentId : undefined;
}

export function isPermissionMode(value: unknown): value is AgentRuntimeConfig["permissionMode"] {
  return (
    value === "default" ||
    value === "plan" ||
    value === "bypassPermissions"
  );
}

export function readRequestedMode(value: unknown): PermissionMode | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const requestedMode = (value as Record<string, unknown>).requestedMode;
  return isPermissionMode(requestedMode) ? requestedMode : undefined;
}
