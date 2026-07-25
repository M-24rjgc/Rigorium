import type {
  AnalysisObjective,
  RouteParetoComparison,
  RouteParetoPoint,
} from "./contracts.js";
import {
  type AnalysisMeasurement,
  measurementsForObjective,
  routeIdsFromAnalysis,
} from "./measurements.js";
import { mean } from "./statistics.js";
import type { ValidatedExperimentAnalysisInput } from "./validation.js";

const PARETO_ASSUMPTIONS = Object.freeze([
  "Each route is represented by the arithmetic mean of its succeeded measurements for each objective.",
  "A route is eligible only when every declared objective has at least one measurement.",
  "Dominance follows each objective's declared minimize or maximize direction without uncertainty adjustment.",
]);

export function createRouteParetoComparison(
  input: ValidatedExperimentAnalysisInput,
  measurements: readonly AnalysisMeasurement[],
): RouteParetoComparison {
  const routeIds = routeIdsFromAnalysis(input, measurements);
  const incomplete: Array<{ routeId: string; reason: string }> = [];
  const eligible: Array<Omit<RouteParetoPoint, "dominatedBy" | "onFrontier">> = [];
  for (const routeId of routeIds) {
    const objectiveValues: Array<{ objective: AnalysisObjective; count: number; mean: number }> = [];
    const missing: string[] = [];
    for (const objective of input.objectives) {
      const matching = measurementsForObjective(measurements, objective, routeId);
      if (matching.length === 0) {
        missing.push(objectiveLabel(objective));
        continue;
      }
      objectiveValues.push(Object.freeze({
        objective,
        count: matching.length,
        mean: mean(matching.map((measurement) => measurement.metric.payload.value)),
      }));
    }
    if (missing.length > 0) {
      incomplete.push(Object.freeze({ routeId, reason: `Missing objectives: ${missing.join(", ")}.` }));
    } else {
      eligible.push(Object.freeze({ routeId, objectives: Object.freeze(objectiveValues) }));
    }
  }

  const points: RouteParetoPoint[] = eligible.map((point) => {
    const dominatedBy = eligible
      .filter((candidate) => candidate.routeId !== point.routeId && dominates(candidate, point))
      .map((candidate) => candidate.routeId)
      .sort((left, right) => left.localeCompare(right, "en"));
    return Object.freeze({
      ...point,
      dominatedBy: Object.freeze(dominatedBy),
      onFrontier: dominatedBy.length === 0,
    });
  });
  points.sort((left, right) => left.routeId.localeCompare(right.routeId, "en"));
  return Object.freeze({
    objectives: Object.freeze([...input.objectives]),
    eligibleRouteCount: points.length,
    excludedRoutes: Object.freeze(incomplete.sort((left, right) => left.routeId.localeCompare(right.routeId, "en"))),
    points: Object.freeze(points),
    frontierRouteIds: Object.freeze(points.filter((point) => point.onFrontier).map((point) => point.routeId)),
    assumptions: PARETO_ASSUMPTIONS,
  });
}

function dominates(
  candidate: Omit<RouteParetoPoint, "dominatedBy" | "onFrontier">,
  target: Omit<RouteParetoPoint, "dominatedBy" | "onFrontier">,
): boolean {
  let strictlyBetter = false;
  for (let index = 0; index < candidate.objectives.length; index += 1) {
    const candidateObjective = candidate.objectives[index]!;
    const targetObjective = target.objectives[index]!;
    const direction = candidateObjective.objective.direction;
    if (direction === "maximize") {
      if (candidateObjective.mean < targetObjective.mean) return false;
      if (candidateObjective.mean > targetObjective.mean) strictlyBetter = true;
    } else {
      if (candidateObjective.mean > targetObjective.mean) return false;
      if (candidateObjective.mean < targetObjective.mean) strictlyBetter = true;
    }
  }
  return strictlyBetter;
}

function objectiveLabel(objective: AnalysisObjective): string {
  const suffix = [objective.split, objective.unit].filter((value): value is string => value !== undefined).join("/");
  return `${objective.experimentId}:${objective.metricName}${suffix ? `:${suffix}` : ""}`;
}
