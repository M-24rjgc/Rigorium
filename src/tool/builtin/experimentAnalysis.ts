import {
  createExperimentAnalysisReport,
  validateExperimentAnalysisInput,
  type ExperimentAnalysisInput,
  type ExperimentAnalysisReport,
} from "../../research/experimentation/analysis/index.js";
import {
  ExperimentRepositoryError,
  loadExperimentManifest,
} from "../../research/experimentation/index.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";

type ExperimentAnalysisLedgerFields = "runAttempts" | "metricObservations" | "baselineObservations";

export type ExperimentAnalysisToolInput = Omit<
  ExperimentAnalysisInput,
  "producer" | "now" | ExperimentAnalysisLedgerFields
> & Partial<Pick<ExperimentAnalysisInput, ExperimentAnalysisLedgerFields>>;

const LEDGER_INPUT_KEYS = [
  "runAttempts",
  "metricObservations",
  "baselineObservations",
  "trialDescriptors",
] as const;

export type CreateExperimentAnalysisToolOptions = Readonly<{
  maxResultBytes?: number;
}>;

export function createExperimentAnalysisTool(
  options: CreateExperimentAnalysisToolOptions = {},
): RigoriumToolDefinition<ExperimentAnalysisToolInput, ExperimentAnalysisReport> {
  return {
    name: "experiment_analysis",
    title: "Analyze Project Experiments",
    description: `Analyze immutable experiment runs and metric observations without launching work or writing files.

The current Project ledger is used automatically when it exists. Otherwise, legacy callers may provide run, metric, baseline, and legacy descriptor arrays. The tool selects the latest run revisions, excludes unlinked or unsuccessful measurements with explicit diagnostics, reports repeated-run statistics and baseline provenance, summarizes ablations and robustness slices, compares routes and Pareto fronts, and returns bounded deterministic-grid suggestions labeled proposed_not_executed. Figure and table records require caller-supplied file hashes. Optuna remains excluded when unavailable.`,
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
        const report = createExperimentAnalysisReport(await withRuntimeMetadata(input, context));
        return formatOutput(report);
      } catch (error) {
        throw new RigoriumToolRuntimeError("invalid_tool_input", `Experiment analysis failed: ${messageOf(error)}`);
      }
    },
  };
}

async function validateToolInput(
  input: unknown,
  context: RigoriumToolRuntimeContext,
): Promise<RigoriumToolValidationResult> {
  try {
    validateExperimentAnalysisInput(await withRuntimeMetadata(input as ExperimentAnalysisToolInput, context));
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

async function withRuntimeMetadata(
  input: ExperimentAnalysisToolInput,
  context: RigoriumToolRuntimeContext,
): Promise<ExperimentAnalysisInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("experiment_analysis input must be an object.");
  }
  if ("producer" in input || "now" in input) {
    throw new TypeError("experiment_analysis does not accept producer or now; runtime metadata is host-controlled.");
  }
  const manifest = await loadProjectLedger(context.cwd);
  if (manifest) {
    for (const key of LEDGER_INPUT_KEYS) {
      if (key in input) {
        throw new TypeError(`experiment_analysis uses the persisted Project ledger and does not accept caller ${key}.`);
      }
    }
    return {
      ...input,
      runAttempts: manifest.runAttempts,
      metricObservations: manifest.metricObservations,
      baselineObservations: manifest.baselineObservations,
      producer: Object.freeze({ kind: "tool", id: "experimentation-analysis", toolName: "experiment_analysis" }),
      ...(context.now === undefined ? {} : { now: context.now() }),
    } as ExperimentAnalysisInput;
  }
  for (const key of ["runAttempts", "metricObservations", "baselineObservations"] as const) {
    if (!(key in input)) {
      throw new TypeError(`experiment_analysis requires ${key} when the current Project has no persisted experiment ledger.`);
    }
  }
  return {
    ...input,
    producer: Object.freeze({ kind: "tool", id: "experimentation-analysis", toolName: "experiment_analysis" }),
    ...(context.now === undefined ? {} : { now: context.now() }),
  } as ExperimentAnalysisInput;
}

async function loadProjectLedger(projectRoot: string) {
  try {
    return await loadExperimentManifest({ projectRoot });
  } catch (error) {
    // Legacy array input remains usable in hosts that do not materialize a Project directory.
    if (error instanceof ExperimentRepositoryError && error.code === "invalid_project_root") return undefined;
    throw error;
  }
}

function formatOutput(report: ExperimentAnalysisReport): RigoriumToolExecutionOutput<ExperimentAnalysisReport> {
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
    required: ["objectives"],
    properties: {
      runAttempts: { type: "array", items: { type: "object" }, description: "Versioned RunAttempt envelopes." },
      metricObservations: { type: "array", items: { type: "object" }, description: "MetricObservation envelopes." },
      baselineObservations: { type: "array", items: { type: "object" }, description: "Reported or observed baseline envelopes." },
      trialDescriptors: { type: "array", items: { type: "object" }, description: "Legacy-only route, parameter, slice, cost, and wall-time metadata when no Project ledger exists." },
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
