import { ResearchOrchestrator } from "../../research/director/ResearchOrchestrator.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult, RigoriumToolInputSchema } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";

/**
 * research_plan — the production entry point of the belief-driven
 * orchestration loop (Phase 4).
 *
 * Reads the project's claim graph + artifact DAG, computes beliefs, and
 * returns the next actions ranked by expected information gain per unit cost
 * (with anomaly boosting, belief reconciliation, and venue/style context).
 * Fully offline — no LLM calls. The agent executes the recommended actions
 * (literature_search, run_experiment, review, …) with the project tools;
 * evidence lands back in the artifact DAG and the next plan re-ranks from the
 * revised belief state. This is the anti-pipeline: no fixed stage order, and
 * stop is a first-class recommendation.
 */

export type ResearchPlanToolInput = Readonly<{
  action: "plan";
  /** Write the markdown summary to `<project>/.rigorium/research/claims/summary.md`. */
  persistSummary?: boolean;
}>;

export type PlannedResearchAction = Readonly<{
  type: string;
  claimId?: string;
  score: number;
  expectedInformationGain: number;
  costUnits: number;
  rationale: string;
}>;

export type ResearchPlanToolResult = Readonly<{
  action: "plan";
  computedAt: string;
  actions: readonly PlannedResearchAction[];
  shouldStop: boolean;
  stopReason?: string;
  revisions: readonly { claimId: string; from: string; to: string; reason: string }[];
  backtracking: boolean;
  anomalyDetected: boolean;
  /** Anomaly strength (0..1) — a paradigm-shift signal. */
  anomalyScore: number;
  venue?: { id: string; displayName: string; styleProfileReady: boolean };
  beliefCount: number;
  /** Human/agent-readable plan summary (memory-friendly). */
  summaryMarkdown: string;
  /** Where the summary was persisted, when requested. */
  summaryPath?: string;
}>;

export type CreateResearchPlanToolOptions = Readonly<{
  maxResultBytes?: number;
  orchestratorFactory?: (projectRoot: string) => ResearchOrchestrator;
}>;

export function createResearchPlanTool(
  options: CreateResearchPlanToolOptions = {},
): RigoriumToolDefinition<ResearchPlanToolInput, ResearchPlanToolResult> {
  return {
    name: "research_plan",
    title: "Compute the Belief-Driven Research Plan",
    description: `Compute the next research actions from the project's claim graph and artifact evidence, ranked by expected information gain per unit cost.

Use action=plan to get: (1) the current belief state (confidence/uncertainty per claim, evidence counts), (2) ranked next actions — literature_search, run_experiment, review, principle_revision — each with score, expected gain, cost, and rationale, (3) whether the loop recommends stopping (no action clears the gain-per-cost bar), (4) belief revisions since the last plan (backtracking ledger), (5) the project's venue context (template + style-profile readiness). No LLM calls: the plan is computed offline from the project's own evidence.

Use it at the start of a research turn and after each executed action: execute the top actions with the project's tools (literature_search, claim_monitor, experiment_control, research_review, ...), land evidence artifacts with supports/challenges edges, then plan again — the loop re-ranks from the revised beliefs. Set persistSummary=true to write the summary markdown into the project's research state.`,
    kind: "custom",
    inputSchema: researchPlanInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 2_000_000,
    isReadOnly: (input) => input.persistSummary !== true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => false,
    validateInput: async (input) => validateInput(input),
    execute: async (input, context) => {
      const projectRoot = context.cwd;
      const orchestrator = options.orchestratorFactory
        ? options.orchestratorFactory(projectRoot)
        : new ResearchOrchestrator({ projectRoot });
      const plan = await orchestrator.planNextActions();
      let summaryPath: string | undefined;
      if (input.persistSummary === true) {
        summaryPath = await orchestrator.writeSummary(plan.summaryMarkdown);
      }
      const result: ResearchPlanToolResult = Object.freeze({
        action: "plan",
        computedAt: plan.computedAt,
        actions: plan.actions,
        shouldStop: plan.shouldStop,
        ...(plan.stopReason ? { stopReason: plan.stopReason } : {}),
        revisions: plan.revisions,
        backtracking: plan.backtracking,
        anomalyDetected: plan.anomalyDetected,
        anomalyScore: plan.anomalyScore,
        ...(plan.venue ? { venue: plan.venue } : {}),
        beliefCount: plan.beliefs.length,
        summaryMarkdown: plan.summaryMarkdown,
        ...(summaryPath ? { summaryPath } : {}),
      });
      return {
        content: [{ type: "text", text: plan.summaryMarkdown }],
        data: result,
      };
    },
  };
}

async function validateInput(input: ResearchPlanToolInput): Promise<RigoriumToolValidationResult> {
  if (!input || input.action !== "plan") {
    return { ok: false, issues: [issue("research_plan only supports action=plan")] };
  }
  return { ok: true, input };
}

function issue(message: string): RigoriumToolValidationIssue {
  return { path: "", code: "invalid_type", message };
}

function researchPlanInputSchema(): RigoriumToolInputSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["plan"] },
      persistSummary: { type: "boolean" },
    },
  };
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
