import {
  assertNoFixedStageFields,
  createResearchDirectorDecision,
  createResearchDirectorPlan,
  type CreateResearchDirectorDecisionInput,
  type CreateResearchDirectorPlanInput,
  type ResearchDirectorDecisionRecord,
  type ResearchDirectorPlanRecord,
} from "../../research/director/index.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";

export type ResearchDirectorToolInput =
  | Readonly<{
    action: "plan";
    request: Omit<CreateResearchDirectorPlanInput, "now">;
  }>
  | Readonly<{
    action: "decide";
    request: Omit<CreateResearchDirectorDecisionInput, "now">;
  }>;

export type ResearchDirectorToolResult =
  | Readonly<{ action: "plan"; plan: ResearchDirectorPlanRecord }>
  | Readonly<{ action: "decide"; decision: ResearchDirectorDecisionRecord }>;

export type CreateResearchDirectorToolOptions = Readonly<{
  maxResultBytes?: number;
}>;

export function createResearchDirectorTool(
  options: CreateResearchDirectorToolOptions = {},
): RigoriumToolDefinition<ResearchDirectorToolInput, ResearchDirectorToolResult> {
  return {
    name: "research_director",
    title: "Plan and Reconcile Research Actions",
    description: `Create an auditable capability-driven research action plan, or reconcile structured execution receipts into a branch, eliminate, rescan, revise, recover, or stop decision.

The planner reads a goal, the latest artifact DAG, stale descendants, unresolved findings, budget and permission snapshots, explicit approval receipts, and a capability snapshot. It emits dependency-safe batches while isolating unavailable, denied, over-budget, or confirmation-gated actions. The decision action consumes receipts produced after the existing AgentLoop and ToolRuntime execute real tools. This Director is read-only: it never invokes another tool, duplicates the scheduler, bypasses downstream permission checks, or advances a fixed workflow stage. Zotero writes, exports, snapshots, final-title confirmation, and automatic budget actions require explicit approval receipts before they become ready.`,
    kind: "custom",
    inputSchema: researchDirectorInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 4_000_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresUserInteraction: () => false,
    isOpenWorld: () => false,
    validateInput: async (input) => validateInput(input),
    execute: async (input, context) => {
      try {
        requireActionInput(input);
        const result = input.action === "plan"
          ? Object.freeze({
              action: "plan" as const,
              plan: createResearchDirectorPlan({ ...input.request, now: context.now?.() }),
            })
          : Object.freeze({
              action: "decide" as const,
              decision: createResearchDirectorDecision({ ...input.request, now: context.now?.() }),
            });
        assertNoFixedStageFields(result);
        return formatOutput(result);
      } catch (error) {
        throw new RigoriumToolRuntimeError(
          "invalid_tool_input",
          `Invalid research director action: ${messageOf(error)}`,
        );
      }
    },
  };
}

async function validateInput(input: ResearchDirectorToolInput): Promise<RigoriumToolValidationResult> {
  try {
    requireActionInput(input);
    const validationDate = new Date("2000-01-01T00:00:00.000Z");
    const result = input.action === "plan"
      ? createResearchDirectorPlan({ ...input.request, now: validationDate })
      : createResearchDirectorDecision({ ...input.request, now: validationDate });
    assertNoFixedStageFields(result);
    return { ok: true, input };
  } catch (error) {
    const issue: RigoriumToolValidationIssue = {
      path: "$",
      code: "invalid_schema",
      message: messageOf(error),
    };
    return { ok: false, issues: [issue] };
  }
}

function requireActionInput(value: unknown): asserts value is ResearchDirectorToolInput {
  if (!isRecord(value) || !["plan", "decide"].includes(String(value.action)) || !isRecord(value.request)) {
    throw new TypeError("research_director requires action=plan|decide and a request object.");
  }
}

function researchDirectorInputSchema() {
  return {
    type: "object" as const,
    additionalProperties: false,
    required: ["action", "request"],
    properties: {
      action: { type: "string", enum: ["plan", "decide"] },
      request: {
        type: "object",
        additionalProperties: true,
      },
    },
  };
}

function formatOutput(
  result: ResearchDirectorToolResult,
): RigoriumToolExecutionOutput<ResearchDirectorToolResult> {
  const lines = result.action === "plan"
    ? [
        "Research Director plan",
        `Plan: ${result.plan.planId}`,
        `Mode: ${result.plan.mode}`,
        `Actions: ${result.plan.actions.length}`,
        `Ready batches: ${result.plan.readyBatches.length}`,
        `Blocked boundaries: ${result.plan.blockedBoundaries.length}`,
      ]
    : [
        "Research Director decision",
        `Decision: ${result.decision.decision}`,
        `Plan: ${result.decision.planId}`,
        `Receipts: ${result.decision.consumedReceiptIds.length}`,
        `Next actions: ${result.decision.nextActionIds.length}`,
      ];
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "json", value: result },
    ],
    data: result,
    metadata: result.action === "plan"
      ? {
          action: result.action,
          planId: result.plan.planId,
          mode: result.plan.mode,
          actionCount: result.plan.actions.length,
          readyBatchCount: result.plan.readyBatches.length,
          blockedBoundaryCount: result.plan.blockedBoundaries.length,
        }
      : {
          action: result.action,
          decisionId: result.decision.decisionId,
          planId: result.decision.planId,
          decision: result.decision.decision,
          receiptCount: result.decision.consumedReceiptIds.length,
        },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
