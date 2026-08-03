import {
  buildResearchArtifactGraph,
  hashResearchArtifactContent,
  latestResearchArtifactRevisions,
  researchArtifactKey,
  toResearchArtifactRef,
  type ResearchArtifactEnvelope,
  type ResearchArtifactKind,
  type ResearchArtifactRef,
} from "../artifacts/index.js";
import { directorRecordId, sealDirectorDecisionRecord, sealDirectorPlanRecord } from "./records.js";
import type {
  CreateResearchDirectorDecisionInput,
  CreateResearchDirectorPlanInput,
  ResearchDirectorAction,
  ResearchDirectorActionIntent,
  ResearchDirectorBatch,
  ResearchDirectorBlockedBoundary,
  ResearchDirectorBlockedBoundaryKind,
  ResearchDirectorCapability,
  ResearchDirectorDecisionKind,
  ResearchDirectorDecisionRecord,
  ResearchDirectorExecutionReceipt,
  ResearchDirectorPlanRecord,
} from "./types.js";
import {
  approvalFor,
  assertPlanRecord,
  boundedText,
  capabilityIsAllowed,
  compareRefs,
  compareText,
  fullRefKey,
  identifier,
  inferConfirmationBoundary,
  isoDate,
  normalizeApprovalReceipts,
  normalizeBudget,
  normalizeCapabilities,
  normalizeExecutionReceipts,
  normalizeGoal,
  normalizePermissions,
  uniqueRefs,
} from "./validation.js";

type MutableAction = {
  actionId: string;
  capability: ResearchDirectorCapability;
  intent: ResearchDirectorActionIntent;
  inputArtifactRefs: Map<string, ResearchArtifactRef>;
  targetArtifactRefs: Map<string, ResearchArtifactRef>;
  findingRefs: Map<string, ResearchArtifactRef>;
  dependsOnActionIds: Set<string>;
  blockedBoundaryIds: Set<string>;
};

type MutablePlan = {
  actions: Map<string, MutableAction>;
  boundaries: Map<string, ResearchDirectorBlockedBoundary>;
};

export function createResearchDirectorPlan(
  input: CreateResearchDirectorPlanInput,
): ResearchDirectorPlanRecord {
  if (!input || typeof input !== "object" || !Array.isArray(input.artifacts)) {
    throw new TypeError("ResearchDirector plan input requires an artifacts array.");
  }
  if (input.findings !== undefined && !Array.isArray(input.findings)) {
    throw new TypeError("ResearchDirector findings must be an array when supplied.");
  }
  const goal = normalizeGoal(input.goal);
  const capabilities = normalizeCapabilities(input.capabilities);
  const budget = normalizeBudget(input.budget);
  const permissions = normalizePermissions(input.permissions);
  const approvals = normalizeApprovalReceipts(input.approvals);
  const artifacts = mergeArtifacts(input.artifacts, input.findings ?? []);
  const graph = buildResearchArtifactGraph(artifacts);
  const latest = latestResearchArtifactRevisions(artifacts);
  const latestByKey = new Map(latest.map((artifact) => [researchArtifactKey(artifact), artifact]));
  const activeByKind = groupActiveArtifactsByKind(latest);
  const stale = latest.filter((artifact) => artifact.status === "stale");
  const unresolvedFindings = findUnresolvedFindings(latest);
  const mode = stale.length > 0 || unresolvedFindings.length > 0 ? "repair" as const : "advance" as const;
  const mutable: MutablePlan = { actions: new Map(), boundaries: new Map() };
  const producers = producersByKind(capabilities, permissions, approvals);

  for (const missingParent of graph.missingParents) {
    addBoundary(mutable, {
      kind: "missing_dependency",
      detail: `Artifact graph is missing referenced parent ${fullRefKey(missingParent)}.`,
      artifactRefs: [missingParent],
      findingRefs: [],
    });
  }

  if (mode === "repair") {
    addRepairActions({ mutable, stale, unresolvedFindings, latestByKey, producers });
  } else {
    addAdvanceActions({ mutable, capabilities, activeByKind });
  }

  linkArtifactAndCapabilityDependencies({ mutable, activeByKind, capabilities, latestByKey });
  applyCapabilityBoundaries({ mutable, approvals, permissions });
  cascadeBlockedDependencies(mutable);
  let batches = createReadyBatches(mutable.actions);
  applyCostBudget(mutable, batches, budget.limitUnits - budget.spentUnits);
  cascadeBlockedDependencies(mutable);
  batches = createReadyBatches(mutable.actions);
  if (budget.limitDurationMs !== undefined && budget.spentDurationMs !== undefined) {
    applyDurationBudget(mutable, batches, budget.limitDurationMs - budget.spentDurationMs);
    cascadeBlockedDependencies(mutable);
    batches = createReadyBatches(mutable.actions);
  }

  const actions = freezeActions(mutable.actions);
  const blockedBoundaries = [...mutable.boundaries.values()].sort(compareBoundaries);
  const artifactRefs = latest.map(toResearchArtifactRef).sort(compareRefs);
  const staleArtifactRefs = stale.map(toResearchArtifactRef).sort(compareRefs);
  const unresolvedFindingRefs = unresolvedFindings.map(toResearchArtifactRef).sort(compareRefs);
  const capabilitySnapshotHash = hashResearchArtifactContent(capabilities);
  const stateHash = hashResearchArtifactContent({
    goal,
    artifacts: latest.map((artifact) => ({ ref: toResearchArtifactRef(artifact), status: artifact.status })),
    unresolvedFindingRefs,
  });
  const createdAt = isoDate(input.now ?? new Date(), "Director plan time");
  const planId = input.planId === undefined
    ? directorRecordId("director-plan", {
        goal,
        stateHash,
        capabilitySnapshotHash,
        budget,
        permissions,
        approvals,
      })
    : identifier(input.planId, "planId");
  const availableDurationMs = budget.limitDurationMs === undefined || budget.spentDurationMs === undefined
    ? undefined
    : budget.limitDurationMs - budget.spentDurationMs;

  return sealDirectorPlanRecord({
    schemaVersion: 1,
    recordKind: "research_director_plan",
    planId,
    createdAt,
    mode,
    goal,
    stateHash,
    capabilitySnapshotHash,
    artifactRefs: Object.freeze(artifactRefs),
    staleArtifactRefs: Object.freeze(staleArtifactRefs),
    unresolvedFindingRefs: Object.freeze(unresolvedFindingRefs),
    actions: Object.freeze(actions),
    readyBatches: Object.freeze(batches),
    blockedBoundaries: Object.freeze(blockedBoundaries),
    budgetProjection: Object.freeze({
      availableUnits: budget.limitUnits - budget.spentUnits,
      plannedUnits: actions
        .filter((action) => action.blockedBoundaryIds.length === 0)
        .reduce((sum, action) => sum + action.estimatedCostUnits, 0),
      ...(availableDurationMs === undefined ? {} : { availableDurationMs }),
      plannedDurationMs: batches.reduce((sum, batch) => sum + batch.estimatedDurationMs, 0),
    }),
  });
}

export function createResearchDirectorDecision(
  input: CreateResearchDirectorDecisionInput,
): ResearchDirectorDecisionRecord {
  if (!input || typeof input !== "object") throw new TypeError("ResearchDirector decision input must be an object.");
  const plan = assertPlanRecord(input.plan);
  assertNoFixedStageFields(plan);
  const receipts = normalizeExecutionReceipts(input.receipts, plan);
  normalizeApprovalReceipts(input.approvals);
  const decision = decide(receipts, plan);
  const consumedReceiptIds = receipts.map((receipt) => receipt.receiptId).sort(compareText);
  const completedActionIds = uniqueSorted(receipts
    .filter((receipt) => receipt.status === "succeeded")
    .map((receipt) => receipt.actionId));
  const retryActionIds = uniqueSorted(receipts
    .filter((receipt) => receipt.status === "blocked"
      || (receipt.status === "failed" && receipt.error?.retryable === true))
    .map((receipt) => receipt.actionId));
  const discardedActionIds = uniqueSorted(receipts
    .filter((receipt) => receipt.status === "cancelled"
      || (receipt.status === "failed" && receipt.error?.retryable === false)
      || receipt.outcome === "candidate_rejected")
    .map((receipt) => receipt.actionId));
  const receivedActionIds = new Set(receipts.map((receipt) => receipt.actionId));
  const pendingActionIds = plan.actions
    .filter((action) => action.blockedBoundaryIds.length === 0 && !receivedActionIds.has(action.actionId))
    .map((action) => action.actionId);
  const nextActionIds = decision === "recover"
    ? retryActionIds
    : decision === "branch" || decision === "rescan" || decision === "revise"
      ? uniqueSorted(pendingActionIds)
      : [];
  const outputArtifactRefs = mergeRefs(receipts.map((receipt) => receipt.outputArtifactRefs));
  const createdAt = isoDate(input.now ?? new Date(), "Director decision time");
  const decisionId = input.decisionId === undefined
    ? directorRecordId("director-decision", {
        planId: plan.planId,
        receipts: receipts.map((receipt) => ({
          receiptId: receipt.receiptId,
          status: receipt.status,
          outcome: receipt.outcome ?? null,
          retryable: receipt.error?.retryable ?? null,
        })),
      })
    : identifier(input.decisionId, "decisionId");

  return sealDirectorDecisionRecord({
    schemaVersion: 1,
    recordKind: "research_director_decision",
    decisionId,
    planId: plan.planId,
    createdAt,
    decision,
    rationale: decisionRationale(decision, receipts, pendingActionIds.length),
    consumedReceiptIds: Object.freeze(consumedReceiptIds),
    completedActionIds: Object.freeze(completedActionIds),
    retryActionIds: Object.freeze(retryActionIds),
    discardedActionIds: Object.freeze(discardedActionIds),
    nextActionIds: Object.freeze(nextActionIds),
    outputArtifactRefs: Object.freeze(outputArtifactRefs),
    findingRefs: plan.unresolvedFindingRefs,
    blockedBoundaries: plan.blockedBoundaries,
    actualCostUnits: receipts.reduce((sum, receipt) => sum + receipt.costUnits, 0),
    actualDurationMs: receipts.reduce((sum, receipt) => sum + receipt.durationMs, 0),
  });
}

function addAdvanceActions(input: {
  mutable: MutablePlan;
  capabilities: readonly ResearchDirectorCapability[];
  activeByKind: ReadonlyMap<ResearchArtifactKind, readonly ResearchArtifactEnvelope[]>;
}): void {
  for (const capability of input.capabilities) {
    if (capability.produces.length === 0) continue;
    if (capability.produces.every((kind) => (input.activeByKind.get(kind)?.length ?? 0) > 0)) continue;
    const action = createMutableAction(capability, "advance", { capabilityId: capability.capabilityId });
    input.mutable.actions.set(action.actionId, action);
  }
}

function addRepairActions(input: {
  mutable: MutablePlan;
  stale: readonly ResearchArtifactEnvelope[];
  unresolvedFindings: readonly ResearchArtifactEnvelope[];
  latestByKey: ReadonlyMap<string, ResearchArtifactEnvelope>;
  producers: ReadonlyMap<ResearchArtifactKind, readonly ResearchDirectorCapability[]>;
}): void {
  for (const artifact of input.stale) {
    const ref = toResearchArtifactRef(artifact);
    const capability = input.producers.get(artifact.kind)?.[0];
    if (!capability) {
      addBoundary(input.mutable, {
        kind: "missing_capability",
        detail: `No capability can recompute stale artifact ${fullRefKey(ref)}.`,
        artifactRefs: [ref],
        findingRefs: [],
      });
      continue;
    }
    const action = createMutableAction(capability, "recompute", { capabilityId: capability.capabilityId, target: ref });
    action.targetArtifactRefs.set(fullRefKey(ref), ref);
    input.mutable.actions.set(action.actionId, action);
  }

  for (const finding of input.unresolvedFindings) {
    const findingRef = toResearchArtifactRef(finding);
    const affected = findingAffectedRefs(finding);
    if (affected.length === 0) {
      addBoundary(input.mutable, {
        kind: "missing_dependency",
        detail: `Finding ${fullRefKey(findingRef)} has no affected artifact reference to revise.`,
        artifactRefs: [],
        findingRefs: [findingRef],
      });
      continue;
    }
    for (const target of affected) {
      const latestTarget = input.latestByKey.get(researchArtifactKey(target));
      const effectiveTarget = latestTarget === undefined ? target : toResearchArtifactRef(latestTarget);
      // Claim-graph nodes are valid edge targets but have no stored envelope
      // and therefore no producer capability — the boundary below reports
      // that honestly instead of a raw Map miss.
      const capability = effectiveTarget.kind === "claim"
        ? undefined
        : input.producers.get(effectiveTarget.kind)?.[0];
      if (!capability) {
        addBoundary(input.mutable, {
          kind: "missing_capability",
          detail: `No capability can revise artifact ${fullRefKey(effectiveTarget)} for finding ${fullRefKey(findingRef)}.`,
          artifactRefs: [effectiveTarget],
          findingRefs: [findingRef],
        });
        continue;
      }
      const equivalent = [...input.mutable.actions.values()].find((candidate) =>
        candidate.capability.capabilityId === capability.capabilityId
        && candidate.targetArtifactRefs.has(fullRefKey(effectiveTarget)));
      const action = equivalent ?? createMutableAction(capability, "revise", {
        capabilityId: capability.capabilityId,
        target: effectiveTarget,
      });
      action.targetArtifactRefs.set(fullRefKey(effectiveTarget), effectiveTarget);
      action.findingRefs.set(fullRefKey(findingRef), findingRef);
      if (!equivalent) input.mutable.actions.set(action.actionId, action);
    }
  }
}

function linkArtifactAndCapabilityDependencies(input: {
  mutable: MutablePlan;
  activeByKind: ReadonlyMap<ResearchArtifactKind, readonly ResearchArtifactEnvelope[]>;
  capabilities: readonly ResearchDirectorCapability[];
  latestByKey: ReadonlyMap<string, ResearchArtifactEnvelope>;
}): void {
  const capabilitiesById = new Map(input.capabilities.map((capability) => [capability.capabilityId, capability]));
  const actionsByCapability = groupActionsByCapability(input.mutable.actions);
  const actionsByProducedKind = groupActionsByProducedKind(input.mutable.actions);
  const actionsByTarget = groupActionsByTarget(input.mutable.actions);

  for (const action of input.mutable.actions.values()) {
    for (const kind of action.capability.accepts) {
      const active = input.activeByKind.get(kind) ?? [];
      for (const artifact of active) {
        const ref = toResearchArtifactRef(artifact);
        action.inputArtifactRefs.set(fullRefKey(ref), ref);
      }
      if (active.length > 0) continue;
      const matchingTargets = [...action.targetArtifactRefs.values()].filter((ref) => ref.kind === kind);
      if (matchingTargets.length > 0) {
        for (const ref of matchingTargets) action.inputArtifactRefs.set(fullRefKey(ref), ref);
        continue;
      }
      const producers = (actionsByProducedKind.get(kind) ?? [])
        .filter((producer) => producer.actionId !== action.actionId);
      if (producers.length === 0) {
        blockAction(input.mutable, action, {
          kind: "missing_dependency",
          detail: `Action ${action.actionId} requires artifact kind ${kind}, but no active artifact or planned producer exists.`,
          capabilityId: action.capability.capabilityId,
          actionId: action.actionId,
          artifactRefs: [],
          findingRefs: [...action.findingRefs.values()],
        });
      } else {
        producers.forEach((producer) => action.dependsOnActionIds.add(producer.actionId));
      }
    }

    for (const dependencyId of action.capability.dependsOnCapabilityIds ?? []) {
      const dependency = capabilitiesById.get(dependencyId);
      if (!dependency) continue;
      const satisfied = dependency.produces.length > 0
        && dependency.produces.every((kind) => (input.activeByKind.get(kind)?.length ?? 0) > 0);
      if (satisfied) continue;
      const producers = actionsByCapability.get(dependencyId) ?? [];
      if (producers.length === 0) {
        blockAction(input.mutable, action, {
          kind: "missing_dependency",
          detail: `Action ${action.actionId} requires capability ${dependencyId}, which has no satisfied output or planned action.`,
          capabilityId: action.capability.capabilityId,
          actionId: action.actionId,
          artifactRefs: [],
          findingRefs: [...action.findingRefs.values()],
        });
      } else {
        producers.forEach((producer) => action.dependsOnActionIds.add(producer.actionId));
      }
    }

    for (const target of action.targetArtifactRefs.values()) {
      const targetArtifact = input.latestByKey.get(researchArtifactKey(target));
      if (!targetArtifact) continue;
      for (const parent of targetArtifact.parents) {
        const parentAction = actionsByTarget.get(fullRefKey(parent.artifact));
        if (parentAction && parentAction.actionId !== action.actionId) {
          action.dependsOnActionIds.add(parentAction.actionId);
        } else {
          const parentArtifact = input.latestByKey.get(researchArtifactKey(parent.artifact));
          if (parentArtifact?.status === "active") {
            const ref = toResearchArtifactRef(parentArtifact);
            action.inputArtifactRefs.set(fullRefKey(ref), ref);
          }
        }
      }
    }
    action.dependsOnActionIds.delete(action.actionId);
  }
}

function applyCapabilityBoundaries(input: {
  mutable: MutablePlan;
  approvals: ReturnType<typeof normalizeApprovalReceipts>;
  permissions: ReturnType<typeof normalizePermissions>;
}): void {
  for (const action of input.mutable.actions.values()) {
    const capability = action.capability;
    if (!capability.available) {
      blockAction(input.mutable, action, {
        kind: "capability_unavailable",
        detail: capability.unavailableReason ?? `Capability ${capability.capabilityId} is unavailable.`,
        capabilityId: capability.capabilityId,
        actionId: action.actionId,
        artifactRefs: [...action.targetArtifactRefs.values()],
        findingRefs: [...action.findingRefs.values()],
      });
    }
    if (!capabilityIsAllowed(capability.capabilityId, input.permissions)) {
      blockAction(input.mutable, action, {
        kind: "permission_denied",
        detail: `Capability ${capability.capabilityId} is outside the supplied permission snapshot.`,
        capabilityId: capability.capabilityId,
        actionId: action.actionId,
        artifactRefs: [...action.targetArtifactRefs.values()],
        findingRefs: [...action.findingRefs.values()],
      });
    }
    const confirmationBoundary = inferConfirmationBoundary(capability);
    if (confirmationBoundary === undefined) continue;
    const approval = approvalFor(capability.capabilityId, confirmationBoundary, input.approvals);
    if (!approval || approval.status !== "approved") {
      blockAction(input.mutable, action, {
        kind: approval?.status === "denied" ? "confirmation_denied" : "confirmation_required",
        detail: approval?.status === "denied"
          ? `Confirmation ${confirmationBoundary} was denied for capability ${capability.capabilityId}.`
          : `Capability ${capability.capabilityId} requires explicit ${confirmationBoundary} confirmation.`,
        capabilityId: capability.capabilityId,
        actionId: action.actionId,
        confirmationBoundary,
        artifactRefs: [...action.targetArtifactRefs.values()],
        findingRefs: [...action.findingRefs.values()],
      });
    }
  }
}

function applyCostBudget(
  mutable: MutablePlan,
  batches: readonly ResearchDirectorBatch[],
  availableUnits: number,
): void {
  let remaining = availableUnits;
  for (const batch of batches) {
    for (const actionId of batch.actionIds) {
      const action = mutable.actions.get(actionId);
      if (!action || action.blockedBoundaryIds.size > 0) continue;
      if (action.capability.estimatedCostUnits <= remaining) {
        remaining -= action.capability.estimatedCostUnits;
        continue;
      }
      blockAction(mutable, action, {
        kind: "budget_exceeded",
        detail: `Action ${action.actionId} projects ${action.capability.estimatedCostUnits} units with only ${remaining} remaining.`,
        capabilityId: action.capability.capabilityId,
        actionId: action.actionId,
        artifactRefs: [...action.targetArtifactRefs.values()],
        findingRefs: [...action.findingRefs.values()],
      });
    }
  }
}

function applyDurationBudget(
  mutable: MutablePlan,
  batches: readonly ResearchDirectorBatch[],
  availableDurationMs: number,
): void {
  let remaining = availableDurationMs;
  for (const batch of batches) {
    const fitting: MutableAction[] = [];
    for (const actionId of batch.actionIds) {
      const action = mutable.actions.get(actionId);
      if (!action) continue;
      if (action.capability.estimatedDurationMs <= remaining) {
        fitting.push(action);
      } else {
        blockAction(mutable, action, {
          kind: "duration_exceeded",
          detail: `Action ${actionId} projects ${action.capability.estimatedDurationMs} ms with only ${remaining} ms remaining.`,
          capabilityId: action.capability.capabilityId,
          actionId,
          artifactRefs: [...action.targetArtifactRefs.values()],
          findingRefs: [...action.findingRefs.values()],
        });
      }
    }
    if (fitting.length > 0) remaining -= Math.max(...fitting.map((action) => action.capability.estimatedDurationMs));
  }
}

function cascadeBlockedDependencies(mutable: MutablePlan): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const action of mutable.actions.values()) {
      if (action.blockedBoundaryIds.size > 0) continue;
      const blockedDependency = [...action.dependsOnActionIds]
        .map((id) => mutable.actions.get(id))
        .find((dependency) => dependency && dependency.blockedBoundaryIds.size > 0);
      if (!blockedDependency) continue;
      blockAction(mutable, action, {
        kind: "missing_dependency",
        detail: `Action ${action.actionId} depends on blocked action ${blockedDependency.actionId}.`,
        capabilityId: action.capability.capabilityId,
        actionId: action.actionId,
        artifactRefs: [...action.targetArtifactRefs.values()],
        findingRefs: [...action.findingRefs.values()],
      });
      changed = true;
    }
  }
}

function createReadyBatches(actions: ReadonlyMap<string, MutableAction>): ResearchDirectorBatch[] {
  const eligible = [...actions.values()]
    .filter((action) => action.blockedBoundaryIds.size === 0)
    .sort(compareMutableActions);
  const eligibleIds = new Set(eligible.map((action) => action.actionId));
  const completed = new Set<string>();
  const batches: ResearchDirectorBatch[] = [];
  while (completed.size < eligible.length) {
    const ready = eligible.filter((action) => !completed.has(action.actionId)
      && [...action.dependsOnActionIds].filter((id) => eligibleIds.has(id)).every((id) => completed.has(id)));
    if (ready.length === 0) throw new TypeError("Director action graph contains an unresolved dependency cycle.");
    const parallel = ready.filter((action) => action.capability.concurrencySafe);
    const selected = parallel.length > 0 ? parallel : [ready[0]!];
    selected.forEach((action) => completed.add(action.actionId));
    const batchNumber = String(batches.length + 1).padStart(3, "0");
    batches.push(Object.freeze({
      batchId: `batch-${batchNumber}`,
      actionIds: Object.freeze(selected.map((action) => action.actionId).sort(compareText)),
      concurrencySafe: selected.every((action) => action.capability.concurrencySafe),
      estimatedCostUnits: selected.reduce((sum, action) => sum + action.capability.estimatedCostUnits, 0),
      estimatedDurationMs: Math.max(...selected.map((action) => action.capability.estimatedDurationMs)),
    }));
  }
  return batches;
}

function freezeActions(actions: ReadonlyMap<string, MutableAction>): ResearchDirectorAction[] {
  return [...actions.values()].sort(compareMutableActions).map((action) => {
    const confirmationBoundary = inferConfirmationBoundary(action.capability);
    return Object.freeze({
      actionId: action.actionId,
      capabilityId: action.capability.capabilityId,
      toolName: action.capability.toolName,
      operation: action.capability.operation,
      intent: action.intent,
      inputArtifactRefs: Object.freeze([...action.inputArtifactRefs.values()].sort(compareRefs)),
      targetArtifactRefs: Object.freeze([...action.targetArtifactRefs.values()].sort(compareRefs)),
      findingRefs: Object.freeze([...action.findingRefs.values()].sort(compareRefs)),
      produces: action.capability.produces,
      dependsOnActionIds: Object.freeze([...action.dependsOnActionIds].sort(compareText)),
      concurrencySafe: action.capability.concurrencySafe,
      estimatedCostUnits: action.capability.estimatedCostUnits,
      estimatedDurationMs: action.capability.estimatedDurationMs,
      ...(confirmationBoundary === undefined ? {} : { confirmationBoundary }),
      blockedBoundaryIds: Object.freeze([...action.blockedBoundaryIds].sort(compareText)),
    });
  });
}

function decide(
  receipts: readonly ResearchDirectorExecutionReceipt[],
  plan: ResearchDirectorPlanRecord,
): ResearchDirectorDecisionKind {
  if (receipts.some((receipt) => receipt.status === "failed" && receipt.error?.retryable === true)
    || receipts.some((receipt) => receipt.status === "blocked")) return "recover";
  if (receipts.some((receipt) => receipt.status === "failed" && receipt.error?.retryable === false)) return "eliminate";
  if (receipts.some((receipt) => receipt.outcome === "artifact_revision_required")) return "revise";
  if (receipts.some((receipt) => receipt.outcome === "evidence_incomplete")) return "rescan";
  if (receipts.some((receipt) => receipt.outcome === "candidate_rejected")) return "eliminate";
  if (receipts.some((receipt) => receipt.outcome === "candidate_supported")) return "branch";
  if (receipts.some((receipt) => receipt.status === "cancelled"
    || receipt.outcome === "objective_satisfied")) return "stop";
  const received = new Set(receipts.map((receipt) => receipt.actionId));
  if (plan.actions.some((action) => action.blockedBoundaryIds.length === 0 && !received.has(action.actionId))) return "branch";
  return "stop";
}

function decisionRationale(
  decision: ResearchDirectorDecisionKind,
  receipts: readonly ResearchDirectorExecutionReceipt[],
  pendingCount: number,
): string {
  const details: Record<ResearchDirectorDecisionKind, string> = {
    branch: `Continue along dependency-safe alternatives; ${pendingCount} planned action(s) remain.`,
    eliminate: "Stop investing in the rejected or non-recoverable alternative recorded by the receipts.",
    rescan: "Refresh the evidence boundary before choosing another research action.",
    revise: "Revise the affected artifact contract before resuming dependent work.",
    recover: "Retry only blocked or explicitly retryable failed actions after resolving their recorded boundary.",
    stop: "No further action is justified by the current receipts and plan boundary.",
  };
  return `${details[decision]} Consumed ${receipts.length} execution receipt(s).`;
}

function findUnresolvedFindings(latest: readonly ResearchArtifactEnvelope[]): ResearchArtifactEnvelope[] {
  const resolved = new Set<string>();
  for (const artifact of latest) {
    if (artifact.kind !== "revision_decision" || artifact.status !== "active" || !isRecord(artifact.payload)) continue;
    const decisions = artifact.payload.decisions;
    if (!Array.isArray(decisions)) continue;
    for (const decision of decisions) {
      if (!isRecord(decision) || !isArtifactRef(decision.findingRef)) continue;
      resolved.add(fullRefKey(decision.findingRef));
    }
  }
  return latest.filter((artifact) => artifact.kind === "finding" && artifact.status === "active"
    && isRecord(artifact.payload) && artifact.payload.assessment === "concern"
    && !resolved.has(fullRefKey(toResearchArtifactRef(artifact))));
}

function findingAffectedRefs(finding: ResearchArtifactEnvelope): ResearchArtifactRef[] {
  if (!isRecord(finding.payload) || !Array.isArray(finding.payload.affectedArtifactRefs)) return [];
  return uniqueRefs(
    finding.payload.affectedArtifactRefs.filter(isArtifactRef),
    `finding ${finding.artifactId} affectedArtifactRefs`,
  );
}

function mergeArtifacts(
  artifacts: readonly ResearchArtifactEnvelope[],
  findings: readonly ResearchArtifactEnvelope[],
): ResearchArtifactEnvelope[] {
  const byKey = new Map<string, ResearchArtifactEnvelope>();
  for (const artifact of [...artifacts, ...findings]) {
    if (!artifact || typeof artifact !== "object") throw new TypeError("ResearchDirector artifacts must be envelopes.");
    const key = researchArtifactKey(artifact);
    const existing = byKey.get(key);
    if (existing && existing.contentHash !== artifact.contentHash) {
      throw new TypeError(`Artifact ${key} is supplied with conflicting content hashes.`);
    }
    byKey.set(key, artifact);
  }
  return [...byKey.values()].sort((left, right) => compareText(researchArtifactKey(left), researchArtifactKey(right)));
}

function groupActiveArtifactsByKind(
  artifacts: readonly ResearchArtifactEnvelope[],
): Map<ResearchArtifactKind, ResearchArtifactEnvelope[]> {
  const result = new Map<ResearchArtifactKind, ResearchArtifactEnvelope[]>();
  for (const artifact of artifacts) {
    if (artifact.status !== "active") continue;
    const values = result.get(artifact.kind) ?? [];
    values.push(artifact);
    result.set(artifact.kind, values);
  }
  return result;
}

function producersByKind(
  capabilities: readonly ResearchDirectorCapability[],
  permissions: ReturnType<typeof normalizePermissions>,
  approvals: ReturnType<typeof normalizeApprovalReceipts>,
): Map<ResearchArtifactKind, ResearchDirectorCapability[]> {
  const result = new Map<ResearchArtifactKind, ResearchDirectorCapability[]>();
  for (const capability of capabilities) {
    for (const kind of capability.produces) {
      const values = result.get(kind) ?? [];
      values.push(capability);
      result.set(kind, values);
    }
  }
  for (const values of result.values()) {
    values.sort((left, right) => {
      const score = (capability: ResearchDirectorCapability): number => {
        const boundary = inferConfirmationBoundary(capability);
        const confirmed = boundary === undefined
          || approvalFor(capability.capabilityId, boundary, approvals)?.status === "approved";
        return Number(capability.available) * 4
          + Number(capabilityIsAllowed(capability.capabilityId, permissions)) * 2
          + Number(confirmed);
      };
      const leftScore = score(left);
      const rightScore = score(right);
      return rightScore - leftScore || compareText(left.capabilityId, right.capabilityId);
    });
  }
  return result;
}

function createMutableAction(
  capability: ResearchDirectorCapability,
  intent: ResearchDirectorActionIntent,
  identity: unknown,
): MutableAction {
  return {
    actionId: directorRecordId(`action-${intent}`, identity),
    capability,
    intent,
    inputArtifactRefs: new Map(),
    targetArtifactRefs: new Map(),
    findingRefs: new Map(),
    dependsOnActionIds: new Set(),
    blockedBoundaryIds: new Set(),
  };
}

function addBoundary(
  mutable: MutablePlan,
  value: Omit<ResearchDirectorBlockedBoundary, "boundaryId">,
): ResearchDirectorBlockedBoundary {
  const normalized = Object.freeze({
    ...value,
    artifactRefs: Object.freeze([...value.artifactRefs].sort(compareRefs)),
    findingRefs: Object.freeze([...value.findingRefs].sort(compareRefs)),
  });
  const boundaryId = directorRecordId("boundary", normalized);
  const boundary = Object.freeze({ boundaryId, ...normalized });
  mutable.boundaries.set(boundaryId, boundary);
  return boundary;
}

function blockAction(
  mutable: MutablePlan,
  action: MutableAction,
  value: Omit<ResearchDirectorBlockedBoundary, "boundaryId">,
): void {
  const boundary = addBoundary(mutable, value);
  action.blockedBoundaryIds.add(boundary.boundaryId);
}

function groupActionsByCapability(
  actions: ReadonlyMap<string, MutableAction>,
): Map<string, MutableAction[]> {
  const result = new Map<string, MutableAction[]>();
  for (const action of actions.values()) {
    const values = result.get(action.capability.capabilityId) ?? [];
    values.push(action);
    result.set(action.capability.capabilityId, values);
  }
  return result;
}

function groupActionsByProducedKind(
  actions: ReadonlyMap<string, MutableAction>,
): Map<ResearchArtifactKind, MutableAction[]> {
  const result = new Map<ResearchArtifactKind, MutableAction[]>();
  for (const action of actions.values()) {
    for (const kind of action.capability.produces) {
      const values = result.get(kind) ?? [];
      values.push(action);
      result.set(kind, values);
    }
  }
  return result;
}

function groupActionsByTarget(actions: ReadonlyMap<string, MutableAction>): Map<string, MutableAction> {
  const result = new Map<string, MutableAction>();
  for (const action of actions.values()) {
    for (const ref of action.targetArtifactRefs.values()) result.set(fullRefKey(ref), action);
  }
  return result;
}

function compareMutableActions(left: MutableAction, right: MutableAction): number {
  return compareText(left.actionId, right.actionId);
}

function compareBoundaries(left: ResearchDirectorBlockedBoundary, right: ResearchDirectorBlockedBoundary): number {
  return compareText(left.boundaryId, right.boundaryId);
}

function mergeRefs(groups: readonly (readonly ResearchArtifactRef[])[]): ResearchArtifactRef[] {
  const refs = new Map<string, ResearchArtifactRef>();
  for (const group of groups) for (const ref of group) refs.set(fullRefKey(ref), ref);
  return [...refs.values()].sort(compareRefs);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArtifactRef(value: unknown): value is ResearchArtifactRef {
  return isRecord(value)
    && typeof value.artifactId === "string"
    && typeof value.revision === "number"
    && typeof value.kind === "string"
    && typeof value.contentHash === "string";
}

export function assertNoFixedStageFields(value: unknown): void {
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!isRecord(entry)) return;
    for (const [key, nested] of Object.entries(entry)) {
      if (key === "currentStage" || key === "nextStageId") {
        throw new TypeError(`Director records must not contain fixed stage field ${key}.`);
      }
      visit(nested);
    }
  };
  visit(value);
}

export function hasApprovedDirectorReceipt(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.approvals)) return false;
  return value.approvals.some((receipt) => isRecord(receipt) && receipt.status === "approved");
}
