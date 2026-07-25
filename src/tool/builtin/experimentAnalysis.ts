import {
  createExperimentAnalysisReport,
  validateExperimentAnalysisInput,
  type ExperimentAnalysisInput,
  type ExperimentAnalysisReport,
} from "../../research/experimentation/analysis/index.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolValidationIssue, PilotDeckToolValidationResult } from "../protocol/schema.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";

export type ExperimentAnalysisToolInput = Omit<ExperimentAnalysisInput, "producer" | "now">;

export type CreateExperimentAnalysisToolOptions = Readonly<{
  maxResultBytes?: number;
}>;

export function createExperimentAnalysisTool(
  options: CreateExperimentAnalysisToolOptions = {},
): PilotDeckToolDefinition<ExperimentAnalysisToolInput, ExperimentAnalysisReport> {
  return {
    name: "experiment_analysis",
    title: "Analyze Project Experiments",
    description: `Analyze immutable experiment runs and metric observations without launching work or writing files.

The tool selects the latest run revisions, excludes unlinked or unsuccessful measurements with explicit diagnostics, reports repeated-run statistics and baseline provenance, summarizes ablations and robustness slices, compares routes and Pareto fronts, and returns bounded deterministic-grid suggestions labeled proposed_not_executed. Figure and table records require caller-supplied file hashes. Optuna remains excluded when unavailable.`,
    kind: "custom",
    inputSchema: experimentAnalysisInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 4_000_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    requiresUserInteraction: () => false,
    isOpenWorld: () => false,
    validateInput: async (input, context) => validateToolInput(input, context),
    execute: async (input, context) => {
      try {
        const report = createExperimentAnalysisReport(withRuntimeMetadata(input, context));
        return formatOutput(report);
      } catch (error) {
        throw new PilotDeckToolRuntimeError("invalid_tool_input", `Experiment analysis failed: ${messageOf(error)}`);
      }
    },
  };
}

function validateToolInput(
  input: unknown,
  context: PilotDeckToolRuntimeContext,
): PilotDeckToolValidationResult {
  try {
    validateExperimentAnalysisInput(withRuntimeMetadata(input as ExperimentAnalysisToolInput, context));
    return { ok: true, input };
  } catch (error) {
    const issue: PilotDeckToolValidationIssue = {
      path: "$",
      code: "invalid_schema",
      message: messageOf(error),
    };
    return { ok: false, issues: [issue] };
  }
}

function withRuntimeMetadata(
  input: ExperimentAnalysisToolInput,
  context: PilotDeckToolRuntimeContext,
): ExperimentAnalysisInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("experiment_analysis input must be an object.");
  }
  if ("producer" in input || "now" in input) {
    throw new TypeError("experiment_analysis does not accept producer or now; runtime metadata is host-controlled.");
  }
  return {
    ...input,
    producer: Object.freeze({ kind: "tool", id: "experimentation-analysis", toolName: "experiment_analysis" }),
    ...(context.now === undefined ? {} : { now: context.now() }),
  };
}

function formatOutput(report: ExperimentAnalysisReport): PilotDeckToolExecutionOutput<ExperimentAnalysisReport> {
  const lines = [
    `Experiment analysis: ${report.analysisId}`,
    `Valid aggregates: ${report.aggregates.length}`,
    `Data issues: ${report.failures.dataIssues.length}`,
    `Pareto frontier: ${report.pareto.frontierRouteIds.join(", ") || "none"}`,
    `Optimization proposals: ${report.optimization.proposals.length}`,
    `Early stop: ${report.optimization.earlyStop.status}`,
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }, { type: "json", value: report }],
    data: report,
    metadata: {
      analysisId: report.analysisId,
      contentHash: report.contentHash,
      aggregateCount: report.aggregates.length,
      dataIssueCount: report.failures.dataIssues.length,
      proposalCount: report.optimization.proposals.length,
    },
  };
}

function experimentAnalysisInputSchema() {
  return {
    type: "object" as const,
    additionalProperties: false,
    required: ["runAttempts", "metricObservations", "baselineObservations", "objectives"],
    properties: {
      runAttempts: { type: "array", items: { type: "object" }, description: "Versioned RunAttempt envelopes." },
      metricObservations: { type: "array", items: { type: "object" }, description: "MetricObservation envelopes." },
      baselineObservations: { type: "array", items: { type: "object" }, description: "Reported or observed baseline envelopes." },
      trialDescriptors: { type: "array", items: { type: "object" }, description: "Caller-supplied route, parameter, slice, cost, and wall-time metadata." },
      objectives: { type: "array", minItems: 1, items: { type: "object" } },
      ablationFactors: { type: "array", items: { type: "object" } },
      robustnessDimensions: { type: "array", items: { type: "object" } },
      earlyStop: { type: "object" },
      budget: { type: "object" },
      searchSpace: { type: "object" },
      figureTable: { type: "object", description: "Caller-supplied figure/table file hashes and provenance." },
      confidenceLevel: { type: "number", enum: [0.95] },
      analysisId: { type: "string" },
    },
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
