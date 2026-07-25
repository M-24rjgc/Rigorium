import type {
  ResearchArtifactProducer,
  ResearchArtifactRef,
} from "../../artifacts/index.js";
import type {
  BaselineObservation,
  ExperimentFailureCategory,
  MetricDirection,
  MetricObservation,
  RunAttempt,
} from "../contracts.js";
import type {
  FigureTableArtifact,
  FigureTableItemInput,
} from "../../manuscript/index.js";

export const EXPERIMENT_ANALYSIS_SCHEMA_VERSION = 1 as const;
export const EXPERIMENT_ANALYSIS_CONFIDENCE_LEVEL = 0.95 as const;

export type AnalysisScalar = string | number | boolean;

export type TrialDescriptor = Readonly<{
  attemptId: string;
  routeId: string;
  parameters?: Readonly<Record<string, AnalysisScalar>>;
  slices?: Readonly<Record<string, AnalysisScalar>>;
  costUsd?: number;
  wallTimeMs?: number;
}>;

export type AnalysisObjective = Readonly<{
  experimentId: string;
  metricName: string;
  direction: Exclude<MetricDirection, "neutral">;
  split?: string;
  unit?: string;
}>;

export type AblationFactorSpec = Readonly<{
  name: string;
  controlValue: AnalysisScalar;
}>;

export type RobustnessDimensionSpec = Readonly<{
  name: string;
}>;

export type EarlyStopPolicy = Readonly<{
  objective: AnalysisObjective;
  routeId?: string;
  patience: number;
  minimumImprovement: number;
  minimumMeasuredRuns?: number;
}>;

export type AnalysisBudget = Readonly<{
  maxAttempts: number;
  maxWallTimeMs?: number;
  maxCostUsd?: number;
}>;

export type ParameterDomain = Readonly<{
  name: string;
  values: readonly AnalysisScalar[];
}>;

export type DeterministicSearchSpace = Readonly<{
  routeId: string;
  parameters: readonly ParameterDomain[];
  maxProposals?: number;
  estimatedWallTimeMsPerTrial?: number;
  estimatedCostUsdPerTrial?: number;
}>;

export type AnalysisFigureTableInput = Readonly<{
  items: readonly FigureTableItemInput[];
  artifactId?: string;
}>;

export type ExperimentAnalysisInput = Readonly<{
  runAttempts: readonly RunAttempt[];
  metricObservations: readonly MetricObservation[];
  baselineObservations: readonly BaselineObservation[];
  trialDescriptors?: readonly TrialDescriptor[];
  objectives: readonly AnalysisObjective[];
  ablationFactors?: readonly AblationFactorSpec[];
  robustnessDimensions?: readonly RobustnessDimensionSpec[];
  earlyStop?: EarlyStopPolicy;
  budget?: AnalysisBudget;
  searchSpace?: DeterministicSearchSpace;
  figureTable?: AnalysisFigureTableInput;
  confidenceLevel?: typeof EXPERIMENT_ANALYSIS_CONFIDENCE_LEVEL;
  analysisId?: string;
  producer?: ResearchArtifactProducer;
  now?: Date;
}>;

export type ConfidenceInterval =
  | Readonly<{
      status: "available";
      level: 0.95;
      lower: number;
      upper: number;
      method: "student_t_two_sided";
      assumptions: readonly string[];
    }>
  | Readonly<{
      status: "unavailable";
      level: 0.95;
      reason: "single_observation" | "zero_variance";
      method: "student_t_two_sided";
      assumptions: readonly string[];
    }>;

export type MetricAggregate = Readonly<{
  key: string;
  experimentId: string;
  routeId: string;
  metricName: string;
  direction: MetricDirection;
  split?: string;
  unit?: string;
  count: number;
  attemptIds: readonly string[];
  observationRefs: readonly ResearchArtifactRef[];
  mean: number;
  median: number;
  minimum: number;
  maximum: number;
  sampleStandardDeviation?: number;
  standardError?: number;
  confidenceInterval: ConfidenceInterval;
}>;

export type EffectSize =
  | Readonly<{
      status: "available";
      method: "hedges_g_one_sample" | "hedges_g_independent_groups";
      value: number;
      assumptions: readonly string[];
    }>
  | Readonly<{
      status: "unavailable";
      method: "hedges_g_one_sample" | "hedges_g_independent_groups";
      reason: "single_observation" | "zero_variance" | "insufficient_groups";
      assumptions: readonly string[];
    }>;

export type BaselineComparison = Readonly<{
  baselineRef: ResearchArtifactRef;
  provenance: "reported_not_rerun" | "observed_run";
  experimentId: string;
  routeId?: string;
  metricName: string;
  direction: MetricDirection;
  split?: string;
  unit?: string;
  baselineValue: number;
  status: "compared" | "missing_observed_measurements";
  observedCount: number;
  observedMean?: number;
  absoluteDifference?: number;
  relativeDifference?: number;
  assessment: "improved" | "worse" | "equal" | "not_assessed";
  effectSize: EffectSize;
}>;

export type RouteEffectComparison = Readonly<{
  objective: AnalysisObjective;
  leftRouteId: string;
  rightRouteId: string;
  leftCount: number;
  rightCount: number;
  meanDifference: number;
  effectSize: EffectSize;
}>;

export type AblationMatrix = Readonly<{
  factor: string;
  controlValue: AnalysisScalar;
  objective: AnalysisObjective;
  rows: readonly Readonly<{
    value: AnalysisScalar;
    count: number;
    mean: number;
    differenceFromControl?: number;
  }>[];
  assumptions: readonly string[];
}>;

export type RobustnessSlice = Readonly<{
  dimension: string;
  objective: AnalysisObjective;
  slices: readonly Readonly<{
    value: AnalysisScalar;
    count: number;
    mean: number;
    minimum: number;
    maximum: number;
  }>[];
  assumptions: readonly string[];
}>;

export type FailureTaxonomyKey =
  | ExperimentFailureCategory
  | "succeeded"
  | "cancelled_without_failure"
  | "recovery_required"
  | "incomplete";

export type FailureTaxonomyEntry = Readonly<{
  category: FailureTaxonomyKey;
  count: number;
  retryableCount: number;
  attemptIds: readonly string[];
}>;

export type AnalysisDataIssue = Readonly<{
  code:
    | "metric_missing_run"
    | "metric_from_unsuccessful_run"
    | "metric_not_listed_by_run"
    | "observed_baseline_missing_run"
    | "observed_baseline_missing_metric"
    | "observed_baseline_mismatch";
  artifactRef: ResearchArtifactRef;
  detail: string;
}>;

export type FailureTaxonomy = Readonly<{
  totalAttempts: number;
  entries: readonly FailureTaxonomyEntry[];
  dataIssues: readonly AnalysisDataIssue[];
}>;

export type EarlyStopAssessment = Readonly<{
  status: "not_requested" | "insufficient_data" | "continue" | "stop_recommended" | "budget_exhausted";
  objective?: AnalysisObjective;
  routeId?: string;
  measuredRuns: number;
  nonImprovingTail: number;
  bestObservedValue?: number;
  reason: string;
  assumptions: readonly string[];
}>;

export type BudgetAssessment = Readonly<{
  maxAttempts?: number;
  consumedAttempts: number;
  remainingAttempts?: number;
  maxWallTimeMs?: number;
  consumedWallTimeMs: number;
  remainingWallTimeMs?: number;
  maxCostUsd?: number;
  consumedCostUsd: number;
  remainingCostUsd?: number;
}>;

export type NextTrialProposal = Readonly<{
  proposalId: string;
  status: "proposed_not_executed";
  source: "deterministic_grid";
  routeId: string;
  parameters: Readonly<Record<string, AnalysisScalar>>;
  reason: string;
}>;

export type OptimizationPlan = Readonly<{
  backend: "deterministic_grid";
  optunaAdapter: "excluded_not_installed";
  budget: BudgetAssessment;
  earlyStop: EarlyStopAssessment;
  proposals: readonly NextTrialProposal[];
  blockedReasons: readonly string[];
}>;

export type RouteParetoPoint = Readonly<{
  routeId: string;
  objectives: readonly Readonly<{
    objective: AnalysisObjective;
    count: number;
    mean: number;
  }>[];
  dominatedBy: readonly string[];
  onFrontier: boolean;
}>;

export type RouteParetoComparison = Readonly<{
  objectives: readonly AnalysisObjective[];
  eligibleRouteCount: number;
  excludedRoutes: readonly Readonly<{ routeId: string; reason: string }>[];
  points: readonly RouteParetoPoint[];
  frontierRouteIds: readonly string[];
  assumptions: readonly string[];
}>;

export type ExperimentAnalysisReport = Readonly<{
  schemaVersion: 1;
  kind: "experiment_analysis";
  analysisId: string;
  createdAt: string;
  contentHash: string;
  inputRefs: readonly ResearchArtifactRef[];
  ignoredRunRevisionRefs: readonly ResearchArtifactRef[];
  assumptions: readonly string[];
  aggregates: readonly MetricAggregate[];
  baselineComparisons: readonly BaselineComparison[];
  routeEffects: readonly RouteEffectComparison[];
  ablations: readonly AblationMatrix[];
  robustness: readonly RobustnessSlice[];
  failures: FailureTaxonomy;
  optimization: OptimizationPlan;
  pareto: RouteParetoComparison;
  figureTableArtifact?: FigureTableArtifact;
  provenancePolicy: Readonly<{
    measurementsSynthesized: false;
    expectedConclusionsPromoted: false;
    filesWritten: false;
    figureFilesSuppliedByCaller: true;
  }>;
}>;
