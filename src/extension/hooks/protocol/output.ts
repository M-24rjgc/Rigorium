export type RigoriumPermissionHookDecision =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
    }
  | {
      behavior: "deny";
      message?: string;
      interrupt?: boolean;
    };

export type RigoriumHookSpecificOutput = {
  hookEventName: string;
  additionalContext?: string;
  initialUserMessage?: string;
  watchPaths?: string[];
  permissionDecision?: "allow" | "deny" | "ask" | "passthrough";
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  updatedMCPToolOutput?: unknown;
  decision?: RigoriumPermissionHookDecision;
  retry?: boolean;
  worktreePath?: string;
};

export type RigoriumHookSyncOutput = {
  type: "sync";
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  reason?: string;
  systemMessage?: string;
  specific?: RigoriumHookSpecificOutput;
  raw?: unknown;
};

export type RigoriumHookAsyncOutput = {
  type: "async";
  raw?: unknown;
};

export type RigoriumHookOutput = RigoriumHookSyncOutput | RigoriumHookAsyncOutput;
