import type {
  ResearchArtifactEnvelope,
  ResearchArtifactKind,
  ResearchArtifactRef,
} from "../artifacts/index.js";

export const RESEARCH_DIRECTOR_SCHEMA_VERSION = 1 as const;

export const DIRECTOR_CONFIRMATION_BOUNDARIES = [
  "zotero_write",
  "export",
  "snapshot",
  "final_title",
  "budget_auto",
] as const;

export const DIRECTOR_DECISIONS = [
  "branch",
  "eliminate",
  "rescan",
  "revise",
  "recover",
  "stop",
] as const;

export type DirectorConfirmationBoundary = typeof DIRECTOR_CONFIRMATION_BOUNDARIES[number];
export type ResearchDirectorDecisionKind = typeof DIRECTOR_DECISIONS[number];
export type ResearchDirectorPlanMode = "advance" | "repair";
export type ResearchDirectorActionIntent = "advance" | "recompute" | "revise";

export type ResearchDirectorGoal = Readonly<{
  objective: string;
  constraints?: readonly string[];
  successCriteria?: readonly string[];
}>;

export type ResearchDirectorCapability = Readonly<{
  capabilityId: string;
  toolName: string;
  operation: string;
  available: boolean;
  unavailableReason?: string;
  concurrencySafe: boolean;
  accepts: readonly ResearchArtifactKind[];
  produces: readonly ResearchArtifactKind[];
  dependsOnCapabilityIds?: readonly string[];
  estimatedCostUnits: number;
  estimatedDurationMs: number;
  confirmationBoundary?: DirectorConfirmationBoundary;
}>;

export type ResearchDirectorBudget = Readonly<{
  limitUnits: number;
  spentUnits: number;
  limitDurationMs?: number;
  spentDurationMs?: number;
}>;

export type ResearchDirectorPermissionSnapshot = Readonly<{
  defaultAccess: "allow" | "deny";
  allowedCapabilityIds?: readonly string[];
  deniedCapabilityIds?: readonly string[];
}>;

export type ResearchDirectorApprovalReceipt = Readonly<{
  receiptId: string;
  boundary: DirectorConfirmationBoundary;
  capabilityId?: string;
  status: "approved" | "denied";
  decidedBy: string;
  decidedAt: string;
}>;

export type ResearchDirectorBlockedBoundaryKind =
  | "capability_unavailable"
  | "permission_denied"
  | "confirmation_required"
  | "confirmation_denied"
  | "budget_exceeded"
  | "duration_exceeded"
  | "missing_dependency"
  | "missing_capability";

export type ResearchDirectorBlockedBoundary = Readonly<{
  boundaryId: string;
  kind: ResearchDirectorBlockedBoundaryKind;
  detail: string;
  capabilityId?: string;
  actionId?: string;
  confirmationBoundary?: DirectorConfirmationBoundary;
  artifactRefs: readonly ResearchArtifactRef[];
  findingRefs: readonly ResearchArtifactRef[];
}>;

export type ResearchDirectorAction = Readonly<{
  actionId: string;
  capabilityId: string;
  toolName: string;
  operation: string;
  intent: ResearchDirectorActionIntent;
  inputArtifactRefs: readonly ResearchArtifactRef[];
  targetArtifactRefs: readonly ResearchArtifactRef[];
  findingRefs: readonly ResearchArtifactRef[];
  produces: readonly ResearchArtifactKind[];
  dependsOnActionIds: readonly string[];
  concurrencySafe: boolean;
  estimatedCostUnits: number;
  estimatedDurationMs: number;
  confirmationBoundary?: DirectorConfirmationBoundary;
  blockedBoundaryIds: readonly string[];
}>;

export type ResearchDirectorBatch = Readonly<{
  batchId: string;
  actionIds: readonly string[];
  concurrencySafe: boolean;
  estimatedCostUnits: number;
  estimatedDurationMs: number;
}>;

export type ResearchDirectorBudgetProjection = Readonly<{
  availableUnits: number;
  plannedUnits: number;
  availableDurationMs?: number;
  plannedDurationMs: number;
}>;

export type ResearchDirectorPlanRecord = Readonly<{
  schemaVersion: 1;
  recordKind: "research_director_plan";
  planId: string;
  createdAt: string;
  mode: ResearchDirectorPlanMode;
  goal: ResearchDirectorGoal;
  stateHash: string;
  capabilitySnapshotHash: string;
  artifactRefs: readonly ResearchArtifactRef[];
  staleArtifactRefs: readonly ResearchArtifactRef[];
  unresolvedFindingRefs: readonly ResearchArtifactRef[];
  actions: readonly ResearchDirectorAction[];
  readyBatches: readonly ResearchDirectorBatch[];
  blockedBoundaries: readonly ResearchDirectorBlockedBoundary[];
  budgetProjection: ResearchDirectorBudgetProjection;
  auditHash: string;
}>;

export type CreateResearchDirectorPlanInput = Readonly<{
  goal: ResearchDirectorGoal;
  artifacts: readonly ResearchArtifactEnvelope[];
  findings?: readonly ResearchArtifactEnvelope<"finding", unknown>[];
  capabilities: readonly ResearchDirectorCapability[];
  budget: ResearchDirectorBudget;
  permissions: ResearchDirectorPermissionSnapshot;
  approvals?: readonly ResearchDirectorApprovalReceipt[];
  planId?: string;
  now?: Date;
}>;

export type ResearchDirectorExecutionReceiptStatus = "succeeded" | "failed" | "blocked" | "cancelled";

export type ResearchDirectorExecutionOutcome =
  | "progressed"
  | "candidate_supported"
  | "candidate_rejected"
  | "evidence_incomplete"
  | "artifact_revision_required"
  | "objective_satisfied";

export type ResearchDirectorExecutionReceipt = Readonly<{
  receiptId: string;
  planId: string;
  actionId: string;
  capabilityId: string;
  status: ResearchDirectorExecutionReceiptStatus;
  outcome?: ResearchDirectorExecutionOutcome;
  outputArtifactRefs: readonly ResearchArtifactRef[];
  costUnits: number;
  durationMs: number;
  completedAt: string;
  error?: Readonly<{
    code: string;
    message: string;
    retryable: boolean;
  }>;
}>;

export type CreateResearchDirectorDecisionInput = Readonly<{
  plan: ResearchDirectorPlanRecord;
  receipts: readonly ResearchDirectorExecutionReceipt[];
  approvals?: readonly ResearchDirectorApprovalReceipt[];
  decisionId?: string;
  now?: Date;
}>;

export type ResearchDirectorDecisionRecord = Readonly<{
  schemaVersion: 1;
  recordKind: "research_director_decision";
  decisionId: string;
  planId: string;
  createdAt: string;
  decision: ResearchDirectorDecisionKind;
  rationale: string;
  consumedReceiptIds: readonly string[];
  completedActionIds: readonly string[];
  retryActionIds: readonly string[];
  discardedActionIds: readonly string[];
  nextActionIds: readonly string[];
  outputArtifactRefs: readonly ResearchArtifactRef[];
  findingRefs: readonly ResearchArtifactRef[];
  blockedBoundaries: readonly ResearchDirectorBlockedBoundary[];
  actualCostUnits: number;
  actualDurationMs: number;
  auditHash: string;
}>;
