import type { PermissionDecision, PermissionDecisionReason, PermissionMode } from "../../permission/index.js";
import type { RigoriumToolErrorCode } from "../protocol/errors.js";

export type RigoriumPermissionAuditRecord = {
  type: "permission";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  mode: PermissionMode;
  decision: PermissionDecision["type"];
  reason: PermissionDecisionReason;
  createdAt: string;
};

export type RigoriumToolAuditRecord = {
  type: "tool";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  status: "success" | "error";
  errorCode?: RigoriumToolErrorCode;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

export type RigoriumToolAuditRecorder = {
  recordPermission(record: RigoriumPermissionAuditRecord): void | Promise<void>;
  recordTool(record: RigoriumToolAuditRecord): void | Promise<void>;
};
