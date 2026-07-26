import { canonicalJson, hashResearchArtifactContent } from "../../artifacts/index.js";
import type { RunAttempt } from "../contracts.js";
import type {
  AnalysisBudget,
  AnalysisScalar,
  BudgetAssessment,
  DeterministicSearchSpace,
  EarlyStopAssessment,
  NextTrialProposal,
  OptimizationPlan,
  TrialDescriptor,
} from "./contracts.js";
import {
  type AnalysisMeasurement,
  measurementsForObjective,
  runTimestamp,
} from "./measurements.js";
import { mean } from "./statistics.js";
import { analysisScalarKey, type ValidatedExperimentAnalysisInput } from "./validation.js";

const EARLY_STOP_ASSUMPTIONS = Object.freeze([
  "Measurements are ordered by recorded run completion time with attempt ID as a deterministic tie-breaker.",
  "Multiple matching observations in one run are reduced to that run's arithmetic mean.",
  "The recommendation is descriptive and never cancels or launches a run.",
]);

export function createOptimizationPlan(
  input: ValidatedExperimentAnalysisInput,
  measurements: readonly AnalysisMeasurement[],
): OptimizationPlan {
  const budget = assessBudget(input.budget, input.runAttempts, input.trialDescriptors);
  const exhausted = isBudgetExhausted(budget);
  const earlyStop = assessEarlyStop(input, measurements, exhausted);
  const { proposals, blockedReasons } = createProposals(
    input.searchSpace,
    input.trialDescriptors,
    budget,
    earlyStop,
  );
  return Object.freeze({
    backend: "deterministic_grid",
    optunaAdapter: "excluded_not_installed",
    budget,
    earlyStop,
    proposals,
    blockedReasons,
  });
}

export function assessBudget(
  budget: AnalysisBudget | undefined,
  attempts: readonly RunAttempt[],
  descriptors: readonly TrialDescriptor[],
): BudgetAssessment {
  const descriptorByAttempt = new Map(descriptors.map((descriptor) => [descriptor.attemptId, descriptor]));
  const consumedWallTimeMs = attempts.reduce((total, attempt) => {
    const supplied = descriptorByAttempt.get(attempt.payload.attemptId)?.wallTimeMs;
    if (supplied !== undefined) return total + supplied;
    if (!attempt.payload.startedAt || !attempt.payload.finishedAt) return total;
    return total + Math.max(0, Date.parse(attempt.payload.finishedAt) - Date.parse(attempt.payload.startedAt));
  }, 0);
  const consumedCostUsd = attempts.reduce(
    (total, attempt) => total + (descriptorByAttempt.get(attempt.payload.attemptId)?.costUsd ?? 0),
    0,
  );
  return Object.freeze({
    ...(budget === undefined ? {} : { maxAttempts: budget.maxAttempts }),
    consumedAttempts: attempts.length,
    ...(budget === undefined ? {} : { remainingAttempts: Math.max(0, budget.maxAttempts - attempts.length) }),
    ...(budget?.maxWallTimeMs === undefined ? {} : { maxWallTimeMs: budget.maxWallTimeMs }),
    consumedWallTimeMs,
    ...(budget?.maxWallTimeMs === undefined
      ? {}
      : { remainingWallTimeMs: Math.max(0, budget.maxWallTimeMs - consumedWallTimeMs) }),
    ...(budget?.maxCostUsd === undefined ? {} : { maxCostUsd: budget.maxCostUsd }),
    consumedCostUsd,
    ...(budget?.maxCostUsd === undefined
      ? {}
      : { remainingCostUsd: Math.max(0, budget.maxCostUsd - consumedCostUsd) }),
  });
}

function assessEarlyStop(
  input: ValidatedExperimentAnalysisInput,
  measurements: readonly AnalysisMeasurement[],
  budgetExhausted: boolean,
): EarlyStopAssessment {
  const policy = input.earlyStop;
  if (!policy) {
    return Object.freeze({
      status: budgetExhausted ? "budget_exhausted" : "not_requested",
      measuredRuns: 0,
      nonImprovingTail: 0,
      reason: budgetExhausted
        ? "At least one explicit experiment budget limit has been exhausted."
        : "No early-stop policy was supplied.",
      assumptions: EARLY_STOP_ASSUMPTIONS,
    });
  }

  const byAttempt = new Map<string, { run: RunAttempt; values: number[] }>();
  for (const measurement of measurementsForObjective(measurements, policy.objective, policy.routeId)) {
    const attemptId = measurement.run.payload.attemptId;
    const group = byAttempt.get(attemptId) ?? { run: measurement.run, values: [] };
    group.values.push(measurement.metric.payload.value);
    byAttempt.set(attemptId, group);
  }
  const sequence = [...byAttempt.values()]
    .sort((left, right) => Date.parse(runTimestamp(left.run)) - Date.parse(runTimestamp(right.run))
      || left.run.payload.attemptId.localeCompare(right.run.payload.attemptId, "en"))
    .map((group) => mean(group.values));
  const bestObservedValue = sequence.length === 0
    ? undefined
    : sequence.slice(1).reduce(
      (best, value) => policy.objective.direction === "maximize" ? Math.max(best, value) : Math.min(best, value),
      sequence[0]!,
    );
  const nonImprovingTail = countNonImprovingTail(sequence, policy.objective.direction, policy.minimumImprovement);
  const base = {
    objective: policy.objective,
    ...(policy.routeId === undefined ? {} : { routeId: policy.routeId }),
    measuredRuns: sequence.length,
    nonImprovingTail,
    ...(bestObservedValue === undefined ? {} : { bestObservedValue }),
    assumptions: EARLY_STOP_ASSUMPTIONS,
  };
  if (budgetExhausted) {
    return Object.freeze({
      status: "budget_exhausted",
      ...base,
      reason: "At least one explicit experiment budget limit has been exhausted.",
    });
  }
  const minimumMeasuredRuns = policy.minimumMeasuredRuns ?? policy.patience + 1;
  if (sequence.length < minimumMeasuredRuns) {
    return Object.freeze({
      status: "insufficient_data",
      ...base,
      reason: `Need ${minimumMeasuredRuns} measured runs before applying the early-stop policy.`,
    });
  }
  if (nonImprovingTail >= policy.patience) {
    return Object.freeze({
      status: "stop_recommended",
      ...base,
      reason: `${nonImprovingTail} trailing runs failed to improve by more than ${policy.minimumImprovement}.`,
    });
  }
  return Object.freeze({
    status: "continue",
    ...base,
    reason: `Only ${nonImprovingTail} trailing runs are non-improving; patience is ${policy.patience}.`,
  });
}

function countNonImprovingTail(
  values: readonly number[],
  direction: "minimize" | "maximize",
  minimumImprovement: number,
): number {
  if (values.length === 0) return 0;
  let qualifyingBest = values[0]!;
  let tail = 0;
  for (const value of values.slice(1)) {
    const improved = direction === "maximize"
      ? value > qualifyingBest + minimumImprovement
      : value < qualifyingBest - minimumImprovement;
    if (improved) {
      qualifyingBest = value;
      tail = 0;
    } else {
      tail += 1;
    }
  }
  return tail;
}

function createProposals(
  searchSpace: DeterministicSearchSpace | undefined,
  descriptors: readonly TrialDescriptor[],
  budget: BudgetAssessment,
  earlyStop: EarlyStopAssessment,
): Readonly<{ proposals: readonly NextTrialProposal[]; blockedReasons: readonly string[] }> {
  if (!searchSpace) {
    return Object.freeze({
      proposals: Object.freeze([]),
      blockedReasons: Object.freeze(["search_space_not_supplied"]),
    });
  }
  if (earlyStop.status === "budget_exhausted") {
    return Object.freeze({ proposals: Object.freeze([]), blockedReasons: Object.freeze(["budget_exhausted"]) });
  }
  if (earlyStop.status === "stop_recommended") {
    return Object.freeze({ proposals: Object.freeze([]), blockedReasons: Object.freeze(["early_stop_recommended"]) });
  }

  const requested = searchSpace.maxProposals ?? 20;
  const affordable = affordableProposalCount(searchSpace, budget, requested);
  if (affordable === 0) {
    return Object.freeze({
      proposals: Object.freeze([]),
      blockedReasons: Object.freeze(["budget_allows_no_additional_trials"]),
    });
  }
  const executed = executedCombinationKeys(searchSpace, descriptors);
  const proposals: NextTrialProposal[] = [];
  visitGrid(searchSpace, (parameters) => {
    const key = parameterCombinationKey(searchSpace, parameters);
    if (executed.has(key)) return true;
    const digest = hashResearchArtifactContent({ routeId: searchSpace.routeId, parameters }).slice("sha256:".length, 19);
    proposals.push(Object.freeze({
      proposalId: `proposal-${searchSpace.routeId}-${digest}`,
      status: "proposed_not_executed",
      source: "deterministic_grid",
      routeId: searchSpace.routeId,
      parameters: Object.freeze({ ...parameters }),
      reason: "Next unexecuted combination in the declared deterministic grid.",
    }));
    return proposals.length < affordable;
  });
  return Object.freeze({
    proposals: Object.freeze(proposals),
    blockedReasons: Object.freeze(proposals.length === 0 ? ["no_untried_combinations"] : []),
  });
}

function affordableProposalCount(
  searchSpace: DeterministicSearchSpace,
  budget: BudgetAssessment,
  requested: number,
): number {
  let count = requested;
  if (budget.remainingAttempts !== undefined) count = Math.min(count, budget.remainingAttempts);
  if (budget.remainingWallTimeMs !== undefined && searchSpace.estimatedWallTimeMsPerTrial !== undefined
    && searchSpace.estimatedWallTimeMsPerTrial > 0) {
    count = Math.min(count, Math.floor(budget.remainingWallTimeMs / searchSpace.estimatedWallTimeMsPerTrial));
  }
  if (budget.remainingCostUsd !== undefined && searchSpace.estimatedCostUsdPerTrial !== undefined
    && searchSpace.estimatedCostUsdPerTrial > 0) {
    count = Math.min(count, Math.floor(budget.remainingCostUsd / searchSpace.estimatedCostUsdPerTrial));
  }
  return Math.max(0, count);
}

function isBudgetExhausted(budget: BudgetAssessment): boolean {
  return (budget.maxAttempts !== undefined && budget.consumedAttempts >= budget.maxAttempts)
    || (budget.maxWallTimeMs !== undefined && budget.consumedWallTimeMs >= budget.maxWallTimeMs)
    || (budget.maxCostUsd !== undefined && budget.consumedCostUsd >= budget.maxCostUsd);
}

function executedCombinationKeys(
  searchSpace: DeterministicSearchSpace,
  descriptors: readonly TrialDescriptor[],
): Set<string> {
  const keys = new Set<string>();
  for (const descriptor of descriptors) {
    if (descriptor.routeId !== searchSpace.routeId || !descriptor.parameters) continue;
    if (!searchSpace.parameters.every((domain) => descriptor.parameters![domain.name] !== undefined)) continue;
    keys.add(parameterCombinationKey(searchSpace, descriptor.parameters));
  }
  return keys;
}

function parameterCombinationKey(
  searchSpace: DeterministicSearchSpace,
  parameters: Readonly<Record<string, AnalysisScalar>>,
): string {
  return canonicalJson(searchSpace.parameters.map((domain) => [
    domain.name,
    analysisScalarKey(parameters[domain.name]!),
  ]));
}

function visitGrid(
  searchSpace: DeterministicSearchSpace,
  visitor: (parameters: Readonly<Record<string, AnalysisScalar>>) => boolean,
): void {
  const current: Record<string, AnalysisScalar> = {};
  const visitDomain = (index: number): boolean => {
    if (index === searchSpace.parameters.length) return visitor(current);
    const domain = searchSpace.parameters[index]!;
    for (const value of domain.values) {
      current[domain.name] = value;
      if (!visitDomain(index + 1)) return false;
    }
    return true;
  };
  visitDomain(0);
}
