import assert from "node:assert/strict";
import test from "node:test";
import {
  createResearchArtifact,
  toResearchArtifactRef,
  type ResearchArtifactEnvelope,
  type ResearchArtifactKind,
  type ResearchArtifactParent,
  type ResearchArtifactRef,
  type ResearchArtifactStatus,
} from "../../../src/research/artifacts/index.js";
import {
  assertNoFixedStageFields,
  createResearchDirectorDecision,
  createResearchDirectorPlan,
  type CreateResearchDirectorPlanInput,
  type ResearchDirectorApprovalReceipt,
  type ResearchDirectorCapability,
  type ResearchDirectorExecutionOutcome,
  type ResearchDirectorExecutionReceipt,
  type ResearchDirectorPlanRecord,
} from "../../../src/research/director/index.js";

const NOW = new Date("2026-07-25T10:00:00.000Z");

test("Director starts from a broad direction and resumes from midstream artifacts without fixed stages", () => {
  const capabilities = pipelineCapabilities();
  const broad = plan({ artifacts: [], capabilities });
  assert.equal(broad.mode, "advance");
  assert.deepEqual(broad.actions.map((action) => action.capabilityId).sort(), ["design", "run", "search"]);
  assert.equal(broad.readyBatches.length, 3);
  assert.deepEqual(capabilityIds(broad, broad.readyBatches[0]!.actionIds), ["search"]);
  assert.deepEqual(capabilityIds(broad, broad.readyBatches[1]!.actionIds), ["design"]);
  assert.deepEqual(capabilityIds(broad, broad.readyBatches[2]!.actionIds), ["run"]);

  const repeated = plan({ artifacts: [], capabilities });
  assert.equal(repeated.planId, broad.planId);
  assert.equal(repeated.auditHash, broad.auditHash);
  const tighterBudget = plan({
    artifacts: [],
    capabilities,
    budget: { limitUnits: 2, spentUnits: 0 },
  });
  assert.notEqual(tighterBudget.planId, broad.planId);

  const evidence = artifact("evidence_pack", "evidence-midstream");
  const midstream = plan({ artifacts: [evidence], capabilities });
  assert.deepEqual(midstream.actions.map((action) => action.capabilityId).sort(), ["design", "run"]);
  assert.deepEqual(capabilityIds(midstream, midstream.readyBatches[0]!.actionIds), ["design"]);
  assert.equal(midstream.actions.some((action) => action.capabilityId === "search"), false);
  assert.doesNotThrow(() => assertNoFixedStageFields(midstream));
});

test("Director recomputes only latest stale artifacts and preserves stale-parent ordering", () => {
  const evidence = artifact("evidence_pack", "evidence-active");
  const unaffected = artifact("candidate_portfolio", "portfolio-unaffected");
  const oldBrief = artifact("research_brief", "brief-versioned", "superseded", [], 1);
  const staleBrief = artifact("research_brief", "brief-versioned", "stale", [{
    relation: "uses",
    artifact: toResearchArtifactRef(evidence),
  }], 2);
  const staleMethod = artifact("method_spec", "method-stale", "stale", [{
    relation: "derived_from",
    artifact: toResearchArtifactRef(staleBrief),
  }]);
  const capabilities = [
    capability("search", [], ["evidence_pack"]),
    capability("portfolio", [], ["candidate_portfolio"]),
    capability("design", ["evidence_pack"], ["research_brief"]),
    capability("method", ["research_brief"], ["method_spec"], { dependencies: ["design"] }),
  ];
  const result = plan({
    artifacts: [evidence, unaffected, oldBrief, staleBrief, staleMethod],
    capabilities,
  });

  assert.equal(result.mode, "repair");
  assert.equal(result.actions.length, 2);
  assert.deepEqual(result.staleArtifactRefs.map((ref) => `${ref.artifactId}@${ref.revision}`).sort(), [
    "brief-versioned@2",
    "method-stale@1",
  ]);
  assert.equal(result.actions.some((action) => action.capabilityId === "search"), false);
  assert.equal(result.actions.some((action) => action.capabilityId === "portfolio"), false);
  const briefAction = result.actions.find((action) => action.capabilityId === "design")!;
  const methodAction = result.actions.find((action) => action.capabilityId === "method")!;
  assert.deepEqual(methodAction.dependsOnActionIds, [briefAction.actionId]);
  assert.deepEqual(result.readyBatches[0]!.actionIds, [briefAction.actionId]);
  assert.deepEqual(result.readyBatches[1]!.actionIds, [methodAction.actionId]);
});

test("Director routes unresolved findings to affected artifact producers and ignores resolved findings", () => {
  const manuscript = artifact("manuscript_version", "manuscript-active");
  const manuscriptRef = toResearchArtifactRef(manuscript);
  const finding = createResearchArtifact({
    kind: "finding",
    artifactId: "finding-revise-manuscript",
    payload: {
      kind: "finding",
      assessment: "concern",
      affectedArtifactRefs: [manuscriptRef],
    },
    producer: { kind: "tool", toolName: "research_review" },
    now: NOW,
  });
  const write = capability("write", [], ["manuscript_version"]);
  const unresolved = plan({ artifacts: [manuscript, finding], capabilities: [write] });
  assert.equal(unresolved.mode, "repair");
  assert.equal(unresolved.unresolvedFindingRefs.length, 1);
  assert.equal(unresolved.actions.length, 1);
  assert.equal(unresolved.actions[0]!.intent, "revise");
  assert.deepEqual(unresolved.actions[0]!.findingRefs, [toResearchArtifactRef(finding)]);
  assert.deepEqual(unresolved.actions[0]!.targetArtifactRefs, [manuscriptRef]);

  const resolution = createResearchArtifact({
    kind: "revision_decision",
    artifactId: "decision-resolved-finding",
    payload: {
      kind: "revision_decision",
      decisions: [{ findingRef: toResearchArtifactRef(finding), disposition: "dismiss" }],
    },
    producer: { kind: "tool", toolName: "research_review" },
    now: NOW,
  });
  const resolved = plan({ artifacts: [manuscript, finding, resolution], capabilities: [write] });
  assert.equal(resolved.unresolvedFindingRefs.length, 0);
  assert.equal(resolved.actions.length, 0);
});

test("Director batches independent concurrency-safe actions and isolates unsafe actions", () => {
  const result = plan({
    artifacts: [],
    capabilities: [
      capability("alpha", [], ["evidence_pack"]),
      capability("beta", [], ["candidate_portfolio"]),
      capability("serial", [], ["challenge_report"], { concurrencySafe: false }),
    ],
  });
  assert.equal(result.readyBatches.length, 2);
  assert.deepEqual(capabilityIds(result, result.readyBatches[0]!.actionIds), ["alpha", "beta"]);
  assert.equal(result.readyBatches[0]!.concurrencySafe, true);
  assert.deepEqual(capabilityIds(result, result.readyBatches[1]!.actionIds), ["serial"]);
  assert.equal(result.readyBatches[1]!.concurrencySafe, false);
});

test("Director enforces confirmation, permission, availability, and budget boundaries", () => {
  const gatedCapabilities = [
    capability("zotero-write", [], ["evidence_pack"], { operation: "zotero_write" }),
    capability("paper-export", [], ["candidate_portfolio"], { operation: "export_pdf" }),
    capability("capture", [], ["implementation_snapshot"], { operation: "capture_snapshot" }),
    capability("title", [], ["research_brief"], { operation: "confirm_final_title" }),
    capability("auto-budget", [], ["experiment_spec"], { operation: "budget_auto_run" }),
  ];
  const gated = plan({ artifacts: [], capabilities: gatedCapabilities });
  assert.equal(gated.readyBatches.length, 0);
  assert.deepEqual(
    gated.blockedBoundaries
      .filter((boundary) => boundary.kind === "confirmation_required")
      .map((boundary) => boundary.confirmationBoundary)
      .sort(),
    ["budget_auto", "export", "final_title", "snapshot", "zotero_write"],
  );

  const approved = plan({
    artifacts: [],
    capabilities: gatedCapabilities,
    approvals: gatedCapabilities.map((entry, index): ResearchDirectorApprovalReceipt => ({
      receiptId: `approval-${index}`,
      boundary: ["zotero_write", "export", "snapshot", "final_title", "budget_auto"][index] as ResearchDirectorApprovalReceipt["boundary"],
      capabilityId: entry.capabilityId,
      status: "approved",
      decidedBy: "user",
      decidedAt: NOW.toISOString(),
    })),
  });
  assert.equal(approved.actions.every((action) => action.blockedBoundaryIds.length === 0), true);
  assert.equal(approved.readyBatches.length, 1);

  const denied = plan({
    artifacts: [],
    capabilities: [capability("denied-capability", [], ["evidence_pack"])],
    permissions: {
      defaultAccess: "allow",
      deniedCapabilityIds: ["denied-capability"],
    },
  });
  assert.equal(denied.blockedBoundaries.some((boundary) => boundary.kind === "permission_denied"), true);

  const unavailable = plan({
    artifacts: [],
    capabilities: [capability("offline", [], ["evidence_pack"], {
      available: false,
      unavailableReason: "Connector health check failed.",
    })],
  });
  assert.equal(unavailable.blockedBoundaries.some((boundary) => boundary.kind === "capability_unavailable"), true);

  const overBudget = plan({
    artifacts: [],
    capabilities: [capability("expensive", [], ["evidence_pack"], { cost: 6 })],
    budget: { limitUnits: 5, spentUnits: 0 },
  });
  assert.equal(overBudget.blockedBoundaries.some((boundary) => boundary.kind === "budget_exceeded"), true);

  const durationLimited = plan({
    artifacts: [],
    capabilities: [
      capability("short", [], ["evidence_pack"], { durationMs: 10 }),
      capability("long", [], ["candidate_portfolio"], { durationMs: 100 }),
    ],
    budget: { limitUnits: 10, spentUnits: 0, limitDurationMs: 50, spentDurationMs: 0 },
  });
  assert.deepEqual(capabilityIds(durationLimited, durationLimited.readyBatches[0]!.actionIds), ["short"]);
  assert.equal(durationLimited.blockedBoundaries.some((boundary) => boundary.kind === "duration_exceeded"
    && boundary.capabilityId === "long"), true);
});

test("Director fails closed when same-time approval receipts conflict", () => {
  const result = plan({
    artifacts: [],
    capabilities: [capability("exporter", [], ["render_run"], { operation: "export_pdf" })],
    approvals: [
      {
        receiptId: "approve-export",
        boundary: "export",
        capabilityId: "exporter",
        status: "approved",
        decidedBy: "user",
        decidedAt: NOW.toISOString(),
      },
      {
        receiptId: "deny-export",
        boundary: "export",
        capabilityId: "exporter",
        status: "denied",
        decidedBy: "user",
        decidedAt: NOW.toISOString(),
      },
    ],
  });
  assert.equal(result.readyBatches.length, 0);
  assert.equal(result.blockedBoundaries.some((boundary) => boundary.kind === "confirmation_denied"
    && boundary.confirmationBoundary === "export"), true);
});

test("Director maps structured receipts to every supported decision", () => {
  const sourcePlan = plan({
    artifacts: [],
    capabilities: [capability("single", [], ["evidence_pack"])],
  });
  const cases: readonly [ResearchDirectorExecutionOutcome | "retryable_failure", string][] = [
    ["candidate_supported", "branch"],
    ["candidate_rejected", "eliminate"],
    ["evidence_incomplete", "rescan"],
    ["artifact_revision_required", "revise"],
    ["retryable_failure", "recover"],
    ["objective_satisfied", "stop"],
  ];
  for (const [outcome, expected] of cases) {
    const receipt = outcome === "retryable_failure"
      ? executionReceipt(sourcePlan, {
          status: "failed",
          error: { code: "transient", message: "Temporary failure.", retryable: true },
        })
      : executionReceipt(sourcePlan, { status: "succeeded", outcome });
    const decision = createResearchDirectorDecision({ plan: sourcePlan, receipts: [receipt], now: NOW });
    assert.equal(decision.decision, expected, outcome);
    assert.doesNotThrow(() => assertNoFixedStageFields(decision));
  }
});

test("Director recovers only the failed action after partial execution", () => {
  const sourcePlan = plan({
    artifacts: [],
    capabilities: [
      capability("left", [], ["evidence_pack"]),
      capability("right", [], ["candidate_portfolio"]),
    ],
  });
  const left = sourcePlan.actions.find((action) => action.capabilityId === "left")!;
  const right = sourcePlan.actions.find((action) => action.capabilityId === "right")!;
  const receipts: ResearchDirectorExecutionReceipt[] = [
    executionReceipt(sourcePlan, { actionId: left.actionId, status: "succeeded", outcome: "progressed" }),
    executionReceipt(sourcePlan, {
      actionId: right.actionId,
      status: "failed",
      error: { code: "worker_lost", message: "Worker disconnected.", retryable: true },
    }),
  ];
  const decision = createResearchDirectorDecision({ plan: sourcePlan, receipts, now: NOW });
  assert.equal(decision.decision, "recover");
  assert.deepEqual(decision.completedActionIds, [left.actionId]);
  assert.deepEqual(decision.retryActionIds, [right.actionId]);
  assert.deepEqual(decision.nextActionIds, [right.actionId]);
});

test("Director rejects a plan whose audited content was changed", () => {
  const sourcePlan = plan({
    artifacts: [],
    capabilities: [capability("single", [], ["evidence_pack"])],
  });
  const tampered = {
    ...sourcePlan,
    goal: { objective: "Changed after the plan was sealed." },
  } as ResearchDirectorPlanRecord;
  assert.throws(
    () => createResearchDirectorDecision({ plan: tampered, receipts: [], now: NOW }),
    /auditHash does not match/iu,
  );
});

test("fixed-stage fields are rejected recursively", () => {
  assert.throws(
    () => assertNoFixedStageFields({ nested: [{ currentStage: "review" }] }),
    /must not contain fixed stage field currentStage/iu,
  );
  assert.throws(
    () => assertNoFixedStageFields({ nested: { nextStageId: "publish" } }),
    /must not contain fixed stage field nextStageId/iu,
  );
});

function plan(overrides: Partial<CreateResearchDirectorPlanInput>): ResearchDirectorPlanRecord {
  return createResearchDirectorPlan({
    goal: {
      objective: "Find and validate a defensible research direction.",
      successCriteria: ["Every conclusion remains traceable to versioned evidence."],
    },
    artifacts: [],
    capabilities: [],
    budget: { limitUnits: 100, spentUnits: 0, limitDurationMs: 1_000_000, spentDurationMs: 0 },
    permissions: { defaultAccess: "allow" },
    now: NOW,
    ...overrides,
  });
}

function pipelineCapabilities(): ResearchDirectorCapability[] {
  return [
    capability("search", [], ["evidence_pack"]),
    capability("design", ["evidence_pack"], ["research_brief"], { dependencies: ["search"] }),
    capability("run", ["research_brief"], ["run_attempt"], { dependencies: ["design"] }),
  ];
}

function capability(
  capabilityId: string,
  accepts: readonly ResearchArtifactKind[],
  produces: readonly ResearchArtifactKind[],
  options: Readonly<{
    dependencies?: readonly string[];
    operation?: string;
    concurrencySafe?: boolean;
    available?: boolean;
    unavailableReason?: string;
    cost?: number;
    durationMs?: number;
  }> = {},
): ResearchDirectorCapability {
  return {
    capabilityId,
    toolName: `tool_${capabilityId.replace(/-/gu, "_")}`,
    operation: options.operation ?? "execute",
    available: options.available ?? true,
    ...(options.unavailableReason === undefined ? {} : { unavailableReason: options.unavailableReason }),
    concurrencySafe: options.concurrencySafe ?? true,
    accepts,
    produces,
    dependsOnCapabilityIds: options.dependencies ?? [],
    estimatedCostUnits: options.cost ?? 1,
    estimatedDurationMs: options.durationMs ?? 100,
  };
}

function artifact<TKind extends ResearchArtifactKind>(
  kind: TKind,
  artifactId: string,
  status: ResearchArtifactStatus = "active",
  parents: readonly ResearchArtifactParent[] = [],
  revision = 1,
): ResearchArtifactEnvelope<TKind, Readonly<{ kind: TKind }>> {
  return createResearchArtifact({
    kind,
    artifactId,
    revision,
    status,
    payload: Object.freeze({ kind }),
    producer: { kind: "tool", toolName: "fixture" },
    parents,
    now: NOW,
  });
}

function capabilityIds(planRecord: ResearchDirectorPlanRecord, actionIds: readonly string[]): string[] {
  const actions = new Map(planRecord.actions.map((action) => [action.actionId, action.capabilityId]));
  return actionIds.map((id) => actions.get(id)!).sort();
}

function executionReceipt(
  planRecord: ResearchDirectorPlanRecord,
  overrides: Readonly<{
    actionId?: string;
    status: ResearchDirectorExecutionReceipt["status"];
    outcome?: ResearchDirectorExecutionOutcome;
    error?: ResearchDirectorExecutionReceipt["error"];
  }>,
): ResearchDirectorExecutionReceipt {
  const action = overrides.actionId === undefined
    ? planRecord.actions[0]!
    : planRecord.actions.find((candidate) => candidate.actionId === overrides.actionId)!;
  return {
    receiptId: `receipt-${action.capabilityId}`,
    planId: planRecord.planId,
    actionId: action.actionId,
    capabilityId: action.capabilityId,
    status: overrides.status,
    ...(overrides.outcome === undefined ? {} : { outcome: overrides.outcome }),
    outputArtifactRefs: [],
    costUnits: 1,
    durationMs: 100,
    completedAt: NOW.toISOString(),
    ...(overrides.error === undefined ? {} : { error: overrides.error }),
  };
}
