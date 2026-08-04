export type PermissionMode = "default" | "plan" | "bypassPermissions";

export type PermissionRuleBehavior = "allow" | "deny" | "ask";

export type PermissionRuleSource = "user" | "project" | "session" | "policy" | "cli";

export type PermissionRule = {
  source: PermissionRuleSource;
  behavior: PermissionRuleBehavior;
  toolName: string;
  pattern?: string;
};

export type PermissionRuleSet = {
  allow: PermissionRule[];
  deny: PermissionRule[];
  ask: PermissionRule[];
};

export type PermissionContext = {
  mode: PermissionMode;
  rules: PermissionRuleSet;
  cwd: string;
  additionalWorkingDirectories: string[];
  canPrompt: boolean;
  bypassAvailable: boolean;
  /** Absolute path of the project-local `.rigorium/plans` directory. */
  planDirectoryPath?: string;
};

export type PermissionDecisionReason =
  | { type: "mode"; mode: PermissionMode; message: string }
  | { type: "rule"; behavior: PermissionRuleBehavior; rule: PermissionRule; message: string }
  | { type: "tool"; toolName: string; message: string }
  | { type: "safety"; message: string }
  | { type: "runtime"; message: string };

export type PermissionRequest = {
  toolCallId: string;
  toolName: string;
  inputSummary: string;
  reason: PermissionDecisionReason;
  options: PermissionRequestOption[];
  metadata?: Record<string, unknown>;
};

export type PermissionRequestOption =
  | { id: "allow_once"; label: string }
  | { id: "allow_session"; label: string; rules?: PermissionRule[] }
  | { id: "deny"; label: string }
  | { id: "cancel"; label: string };

export type PermissionDecision =
  | {
      type: "allow";
      reason: PermissionDecisionReason;
      updatedInput?: unknown;
    }
  | {
      type: "deny";
      reason: PermissionDecisionReason;
      message: string;
    }
  | {
      type: "ask";
      reason: PermissionDecisionReason;
      request: PermissionRequest;
    }
  | {
      type: "cancel";
      reason: PermissionDecisionReason;
      message: string;
    };

export type PermissionResult = PermissionDecision | { type: "passthrough"; reason?: PermissionDecisionReason };

export function emptyPermissionRuleSet(): PermissionRuleSet {
  return {
    allow: [],
    deny: [],
    ask: [],
  };
}

/**
 * Built-in protected paths (Claude Code protected-paths pattern): write
 * tools never target git internals or the platform's own state directory
 * unless a rule explicitly allows them — those are how the project and the
 * platform keep their state, and a stray `Write` must not corrupt them.
 * `source: "policy"` marks them as platform defaults, not user rules.
 */
export const BUILTIN_PROTECTED_PATH_RULES: ReadonlyArray<{
  toolName: string;
  pattern: string;
  behavior: "deny";
  source: "policy";
}> = [
  { toolName: "write_file", pattern: "**/.git/**", behavior: "deny", source: "policy" },
  { toolName: "edit_file", pattern: "**/.git/**", behavior: "deny", source: "policy" },
  { toolName: "write_file", pattern: "**/.rigorium/**", behavior: "deny", source: "policy" },
  { toolName: "edit_file", pattern: "**/.rigorium/**", behavior: "deny", source: "policy" },
];

export function createDefaultPermissionContext(options: {
  cwd: string;
  mode?: PermissionMode;
  canPrompt?: boolean;
  bypassAvailable?: boolean;
  additionalWorkingDirectories?: string[];
  planDirectoryPath?: string;
  rules?: Partial<PermissionRuleSet>;
}): PermissionContext {
  return {
    mode: options.mode ?? "default",
    canPrompt: options.canPrompt ?? false,
    bypassAvailable: options.bypassAvailable ?? false,
    cwd: options.cwd,
    additionalWorkingDirectories: options.additionalWorkingDirectories ?? [],
    ...(options.planDirectoryPath ? { planDirectoryPath: options.planDirectoryPath } : {}),
    rules: {
      ...emptyPermissionRuleSet(),
      ...options.rules,
      // Protected paths apply on top of everything (deny-wins): platform
      // state must not be clobbered even when an allow rule matches. They
      // only gate default mode — bypass mode is explicitly exempt.
      deny: [...(options.rules?.deny ?? []), ...BUILTIN_PROTECTED_PATH_RULES],
    },
  };
}
