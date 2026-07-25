import {
  DIRECTOR_CONFIRMATION_BOUNDARIES,
  RESEARCH_DIRECTOR_SCHEMA_VERSION,
  type DirectorConfirmationBoundary,
  type ResearchDirectorApprovalReceipt,
  type ResearchDirectorBudget,
  type ResearchDirectorCapability,
  type ResearchDirectorExecutionReceipt,
  type ResearchDirectorGoal,
  type ResearchDirectorPermissionSnapshot,
  type ResearchDirectorPlanRecord,
} from "./types.js";
import {
  hashResearchArtifactContent,
  RESEARCH_ARTIFACT_KINDS,
  type ResearchArtifactKind,
  type ResearchArtifactRef,
} from "../artifacts/index.js";

const ARTIFACT_KINDS = new Set<string>(RESEARCH_ARTIFACT_KINDS);
const CONFIRMATION_BOUNDARIES = new Set<string>(DIRECTOR_CONFIRMATION_BOUNDARIES);

export function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new TypeError(`${label} must be a safe identifier.`);
  }
  return value;
}

export function boundedText(value: unknown, label: string, maximum = 16_000): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
    || value.includes("\u0000") || value.length > maximum) {
    throw new TypeError(`${label} must be bounded non-empty trimmed text.`);
  }
  return value;
}

export function textList(value: unknown, label: string, maximum = 256): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} must be a bounded array.`);
  return value.map((entry, index) => boundedText(entry, `${label}[${index}]`, 8_000));
}

export function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number.`);
  }
  return value;
}

export function isoDate(value: unknown, label: string): string {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label} must be an ISO date.`);
  }
  return new Date(timestamp).toISOString();
}

export function normalizeGoal(value: ResearchDirectorGoal): ResearchDirectorGoal {
  if (!value || typeof value !== "object") throw new TypeError("Director goal must be an object.");
  const constraints = value.constraints === undefined ? undefined : textList(value.constraints, "goal.constraints");
  const successCriteria = value.successCriteria === undefined
    ? undefined
    : textList(value.successCriteria, "goal.successCriteria");
  return Object.freeze({
    objective: boundedText(value.objective, "goal.objective", 16_000),
    ...(constraints === undefined ? {} : { constraints: Object.freeze(constraints) }),
    ...(successCriteria === undefined ? {} : { successCriteria: Object.freeze(successCriteria) }),
  });
}

export function normalizeCapability(value: ResearchDirectorCapability, index: number): ResearchDirectorCapability {
  if (!value || typeof value !== "object") throw new TypeError(`capabilities[${index}] must be an object.`);
  if (typeof value.available !== "boolean" || typeof value.concurrencySafe !== "boolean") {
    throw new TypeError(`capabilities[${index}] availability and concurrencySafe must be booleans.`);
  }
  if (!Array.isArray(value.accepts) || !Array.isArray(value.produces)) {
    throw new TypeError(`capabilities[${index}] accepts and produces must be arrays.`);
  }
  const unavailableReason = value.unavailableReason === undefined
    ? undefined
    : boundedText(value.unavailableReason, `capabilities[${index}].unavailableReason`, 4_000);
  if (!value.available && unavailableReason === undefined) {
    throw new TypeError(`capabilities[${index}] requires unavailableReason when unavailable.`);
  }
  const dependencies = value.dependsOnCapabilityIds === undefined
    ? []
    : uniqueIdentifiers(value.dependsOnCapabilityIds, `capabilities[${index}].dependsOnCapabilityIds`);
  const confirmationBoundary = value.confirmationBoundary === undefined
    ? undefined
    : normalizeConfirmationBoundary(value.confirmationBoundary, `capabilities[${index}].confirmationBoundary`);
  return Object.freeze({
    capabilityId: identifier(value.capabilityId, `capabilities[${index}].capabilityId`),
    toolName: identifier(value.toolName, `capabilities[${index}].toolName`),
    operation: identifier(value.operation, `capabilities[${index}].operation`),
    available: value.available,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    concurrencySafe: value.concurrencySafe,
    accepts: Object.freeze(uniqueArtifactKinds(value.accepts, `capabilities[${index}].accepts`)),
    produces: Object.freeze(uniqueArtifactKinds(value.produces, `capabilities[${index}].produces`)),
    dependsOnCapabilityIds: Object.freeze(dependencies),
    estimatedCostUnits: nonNegativeNumber(value.estimatedCostUnits, `capabilities[${index}].estimatedCostUnits`),
    estimatedDurationMs: nonNegativeNumber(value.estimatedDurationMs, `capabilities[${index}].estimatedDurationMs`),
    ...(confirmationBoundary === undefined ? {} : { confirmationBoundary }),
  });
}

export function normalizeCapabilities(values: readonly ResearchDirectorCapability[]): ResearchDirectorCapability[] {
  if (!Array.isArray(values) || values.length > 1_000) throw new TypeError("capabilities must be a bounded array.");
  const capabilities = values.map(normalizeCapability);
  const ids = new Set<string>();
  for (const capability of capabilities) {
    if (ids.has(capability.capabilityId)) throw new TypeError(`Capability ${capability.capabilityId} is duplicated.`);
    ids.add(capability.capabilityId);
  }
  for (const capability of capabilities) {
    for (const dependency of capability.dependsOnCapabilityIds ?? []) {
      if (dependency === capability.capabilityId) throw new TypeError(`Capability ${capability.capabilityId} depends on itself.`);
      if (!ids.has(dependency)) throw new TypeError(`Capability ${capability.capabilityId} has unknown dependency ${dependency}.`);
    }
  }
  assertCapabilityGraphAcyclic(capabilities);
  return capabilities.sort((left, right) => compareText(left.capabilityId, right.capabilityId));
}

export function normalizeBudget(value: ResearchDirectorBudget): ResearchDirectorBudget {
  if (!value || typeof value !== "object") throw new TypeError("budget must be an object.");
  const limitUnits = nonNegativeNumber(value.limitUnits, "budget.limitUnits");
  const spentUnits = nonNegativeNumber(value.spentUnits, "budget.spentUnits");
  if (spentUnits > limitUnits) throw new TypeError("budget.spentUnits must not exceed limitUnits.");
  const limitDurationMs = value.limitDurationMs === undefined
    ? undefined
    : nonNegativeNumber(value.limitDurationMs, "budget.limitDurationMs");
  const spentDurationMs = value.spentDurationMs === undefined
    ? undefined
    : nonNegativeNumber(value.spentDurationMs, "budget.spentDurationMs");
  if ((limitDurationMs === undefined) !== (spentDurationMs === undefined)) {
    throw new TypeError("budget duration limit and spent duration must be supplied together.");
  }
  if (limitDurationMs !== undefined && spentDurationMs !== undefined && spentDurationMs > limitDurationMs) {
    throw new TypeError("budget.spentDurationMs must not exceed limitDurationMs.");
  }
  return Object.freeze({
    limitUnits,
    spentUnits,
    ...(limitDurationMs === undefined ? {} : { limitDurationMs, spentDurationMs }),
  });
}

export function normalizePermissions(value: ResearchDirectorPermissionSnapshot): ResearchDirectorPermissionSnapshot {
  if (!value || typeof value !== "object" || !["allow", "deny"].includes(value.defaultAccess)) {
    throw new TypeError("permissions.defaultAccess must be allow or deny.");
  }
  const allowedCapabilityIds = uniqueIdentifiers(value.allowedCapabilityIds ?? [], "permissions.allowedCapabilityIds");
  const deniedCapabilityIds = uniqueIdentifiers(value.deniedCapabilityIds ?? [], "permissions.deniedCapabilityIds");
  const allowed = new Set(allowedCapabilityIds);
  for (const id of deniedCapabilityIds) {
    if (allowed.has(id)) throw new TypeError(`Capability ${id} cannot be both allowed and denied.`);
  }
  return Object.freeze({
    defaultAccess: value.defaultAccess,
    allowedCapabilityIds: Object.freeze(allowedCapabilityIds),
    deniedCapabilityIds: Object.freeze(deniedCapabilityIds),
  });
}

export function normalizeApprovalReceipts(
  values: readonly ResearchDirectorApprovalReceipt[] = [],
): ResearchDirectorApprovalReceipt[] {
  if (!Array.isArray(values) || values.length > 1_000) throw new TypeError("approvals must be a bounded array.");
  const ids = new Set<string>();
  return values.map((value, index) => {
    if (!value || typeof value !== "object" || !["approved", "denied"].includes(value.status)) {
      throw new TypeError(`approvals[${index}] must be a valid approval receipt.`);
    }
    const receiptId = identifier(value.receiptId, `approvals[${index}].receiptId`);
    if (ids.has(receiptId)) throw new TypeError(`Approval receipt ${receiptId} is duplicated.`);
    ids.add(receiptId);
    return Object.freeze({
      receiptId,
      boundary: normalizeConfirmationBoundary(value.boundary, `approvals[${index}].boundary`),
      ...(value.capabilityId === undefined
        ? {}
        : { capabilityId: identifier(value.capabilityId, `approvals[${index}].capabilityId`) }),
      status: value.status,
      decidedBy: boundedText(value.decidedBy, `approvals[${index}].decidedBy`, 1_000),
      decidedAt: isoDate(value.decidedAt, `approvals[${index}].decidedAt`),
    });
  });
}

export function normalizeRef(value: ResearchArtifactRef, label: string): ResearchArtifactRef {
  if (!value || typeof value !== "object" || !ARTIFACT_KINDS.has(String(value.kind))) {
    throw new TypeError(`${label} must be a valid research artifact reference.`);
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new TypeError(`${label}.revision must be a positive integer.`);
  }
  if (typeof value.contentHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.contentHash)) {
    throw new TypeError(`${label}.contentHash must be a SHA-256 hash.`);
  }
  return Object.freeze({
    artifactId: identifier(value.artifactId, `${label}.artifactId`),
    revision: value.revision,
    kind: value.kind,
    contentHash: value.contentHash,
  });
}

export function uniqueRefs(values: readonly ResearchArtifactRef[], label: string): ResearchArtifactRef[] {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array.`);
  const byKey = new Map<string, ResearchArtifactRef>();
  for (const [index, value] of values.entries()) {
    const ref = normalizeRef(value, `${label}[${index}]`);
    const key = fullRefKey(ref);
    if (byKey.has(key)) throw new TypeError(`${label} contains duplicate reference ${key}.`);
    byKey.set(key, ref);
  }
  return [...byKey.values()].sort(compareRefs);
}

export function normalizeExecutionReceipts(
  values: readonly ResearchDirectorExecutionReceipt[],
  plan: ResearchDirectorPlanRecord,
): ResearchDirectorExecutionReceipt[] {
  if (!Array.isArray(values) || values.length > 10_000) throw new TypeError("receipts must be a bounded array.");
  const actions = new Map(plan.actions.map((action) => [action.actionId, action]));
  const ids = new Set<string>();
  const actionIds = new Set<string>();
  return values.map((value, index) => {
    if (!value || typeof value !== "object"
      || !["succeeded", "failed", "blocked", "cancelled"].includes(value.status)) {
      throw new TypeError(`receipts[${index}] must be a valid execution receipt.`);
    }
    const receiptId = identifier(value.receiptId, `receipts[${index}].receiptId`);
    if (ids.has(receiptId)) throw new TypeError(`Execution receipt ${receiptId} is duplicated.`);
    ids.add(receiptId);
    if (value.planId !== plan.planId) throw new TypeError(`Execution receipt ${receiptId} belongs to a different plan.`);
    const actionId = identifier(value.actionId, `receipts[${index}].actionId`);
    const action = actions.get(actionId);
    if (!action) throw new TypeError(`Execution receipt ${receiptId} references unknown action ${actionId}.`);
    if (actionIds.has(actionId)) throw new TypeError(`Action ${actionId} has duplicate execution receipts.`);
    actionIds.add(actionId);
    if (action.blockedBoundaryIds.length > 0) {
      throw new TypeError(`Execution receipt ${receiptId} references blocked action ${actionId}; create a fresh plan after resolving its boundaries.`);
    }
    if (value.capabilityId !== action.capabilityId) {
      throw new TypeError(`Execution receipt ${receiptId} capability does not match action ${actionId}.`);
    }
    if (value.status === "succeeded" && value.error !== undefined) {
      throw new TypeError(`Successful receipt ${receiptId} must not contain an error.`);
    }
    if (value.status === "failed" && value.error === undefined) {
      throw new TypeError(`Failed receipt ${receiptId} requires an error.`);
    }
    const outcome = value.outcome;
    if (outcome !== undefined && ![
      "progressed",
      "candidate_supported",
      "candidate_rejected",
      "evidence_incomplete",
      "artifact_revision_required",
      "objective_satisfied",
    ].includes(outcome)) throw new TypeError(`Execution receipt ${receiptId} has an invalid outcome.`);
    const error = value.error === undefined ? undefined : Object.freeze({
      code: identifier(value.error.code, `receipts[${index}].error.code`),
      message: boundedText(value.error.message, `receipts[${index}].error.message`, 8_000),
      retryable: strictBoolean(value.error.retryable, `receipts[${index}].error.retryable`),
    });
    return Object.freeze({
      receiptId,
      planId: plan.planId,
      actionId,
      capabilityId: action.capabilityId,
      status: value.status,
      ...(outcome === undefined ? {} : { outcome }),
      outputArtifactRefs: Object.freeze(uniqueRefs(value.outputArtifactRefs, `receipts[${index}].outputArtifactRefs`)),
      costUnits: nonNegativeNumber(value.costUnits, `receipts[${index}].costUnits`),
      durationMs: nonNegativeNumber(value.durationMs, `receipts[${index}].durationMs`),
      completedAt: isoDate(value.completedAt, `receipts[${index}].completedAt`),
      ...(error === undefined ? {} : { error }),
    });
  }).sort((left, right) => compareText(left.receiptId, right.receiptId));
}

export function assertPlanRecord(value: ResearchDirectorPlanRecord): ResearchDirectorPlanRecord {
  if (!value || typeof value !== "object" || value.schemaVersion !== RESEARCH_DIRECTOR_SCHEMA_VERSION
    || value.recordKind !== "research_director_plan") {
    throw new TypeError("Decision input requires a ResearchDirector plan record.");
  }
  identifier(value.planId, "plan.planId");
  isoDate(value.createdAt, "plan.createdAt");
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.auditHash)) throw new TypeError("plan.auditHash is invalid.");
  if (!Array.isArray(value.actions) || !Array.isArray(value.readyBatches) || !Array.isArray(value.blockedBoundaries)) {
    throw new TypeError("Director plan arrays are invalid.");
  }
  const { auditHash, ...body } = value;
  if (hashResearchArtifactContent(body) !== auditHash) {
    throw new TypeError("Director plan auditHash does not match its canonical record content.");
  }
  return value;
}

export function inferConfirmationBoundary(
  capability: ResearchDirectorCapability,
): DirectorConfirmationBoundary | undefined {
  if (capability.confirmationBoundary !== undefined) return capability.confirmationBoundary;
  const normalized = `${capability.capabilityId} ${capability.toolName} ${capability.operation}`
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "_");
  const words = normalized.split("_").filter(Boolean);
  const has = (word: string): boolean => words.includes(word);
  if (normalized.includes("zotero_write")
    || (has("zotero") && ["write", "create", "update", "delete", "mutate"].some(has))) {
    return "zotero_write";
  }
  if (words.some((word) => word === "export" || word.startsWith("export"))) return "export";
  if (words.some((word) => word === "snapshot" || word.startsWith("snapshot"))) return "snapshot";
  if (normalized.includes("final_title") || normalized.includes("confirm_title")
    || normalized.includes("confirmed_title") || (has("final") && has("title"))) return "final_title";
  if (normalized.includes("budget_auto") || normalized.includes("auto_budget")
    || (has("budget") && (has("auto") || has("automatic")))) return "budget_auto";
  return undefined;
}

export function capabilityIsAllowed(
  capabilityId: string,
  permissions: ResearchDirectorPermissionSnapshot,
): boolean {
  const denied = new Set(permissions.deniedCapabilityIds ?? []);
  if (denied.has(capabilityId)) return false;
  const allowed = new Set(permissions.allowedCapabilityIds ?? []);
  return allowed.has(capabilityId) || permissions.defaultAccess === "allow";
}

export function approvalFor(
  capabilityId: string,
  boundary: DirectorConfirmationBoundary,
  approvals: readonly ResearchDirectorApprovalReceipt[],
): ResearchDirectorApprovalReceipt | undefined {
  return [...approvals]
    .filter((receipt) => receipt.boundary === boundary
      && (receipt.capabilityId === undefined || receipt.capabilityId === capabilityId))
    .sort((left, right) => compareText(right.decidedAt, left.decidedAt)
      || Number(right.status === "denied") - Number(left.status === "denied")
      || compareText(right.receiptId, left.receiptId))[0];
}

export function fullRefKey(ref: ResearchArtifactRef): string {
  return `${ref.kind}:${ref.artifactId}@${ref.revision}:${ref.contentHash}`;
}

export function compareRefs(left: ResearchArtifactRef, right: ResearchArtifactRef): number {
  return compareText(fullRefKey(left), fullRefKey(right));
}

export function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function uniqueIdentifiers(value: readonly string[], label: string): string[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new TypeError(`${label} must be a bounded array.`);
  const ids = value.map((entry, index) => identifier(entry, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new TypeError(`${label} must not contain duplicates.`);
  return ids.sort(compareText);
}

function uniqueArtifactKinds(value: readonly ResearchArtifactKind[], label: string): ResearchArtifactKind[] {
  const kinds = value.map((entry, index) => {
    if (!ARTIFACT_KINDS.has(String(entry))) throw new TypeError(`${label}[${index}] is invalid.`);
    return entry;
  });
  if (new Set(kinds).size !== kinds.length) throw new TypeError(`${label} must not contain duplicates.`);
  return kinds.sort(compareText);
}

function normalizeConfirmationBoundary(value: unknown, label: string): DirectorConfirmationBoundary {
  if (typeof value !== "string" || !CONFIRMATION_BOUNDARIES.has(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value as DirectorConfirmationBoundary;
}

function strictBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function assertCapabilityGraphAcyclic(capabilities: readonly ResearchDirectorCapability[]): void {
  const dependencies = new Map(capabilities.map((capability) => [
    capability.capabilityId,
    capability.dependsOnCapabilityIds ?? [],
  ]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new TypeError(`Capability dependency graph contains a cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...dependencies.keys()].sort(compareText)) visit(id);
}
