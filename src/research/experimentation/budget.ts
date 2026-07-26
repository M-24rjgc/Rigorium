import type {
  ExecutionGrantBudgetUsage,
  RunBudgetReservation,
} from "./contracts.js";

const EPSILON = 1e-9;

export function emptyExecutionGrantBudgetUsage(): ExecutionGrantBudgetUsage {
  return Object.freeze({
    reservedWallTimeMs: 0,
    consumedWallTimeMs: 0,
    reservedCostUsd: 0,
    consumedCostUsd: 0,
  });
}

export function executionGrantBudgetUsage(value: ExecutionGrantBudgetUsage | undefined): ExecutionGrantBudgetUsage {
  if (!value) return emptyExecutionGrantBudgetUsage();
  return Object.freeze({
    reservedWallTimeMs: nonNegativeInteger(value.reservedWallTimeMs),
    consumedWallTimeMs: nonNegativeInteger(value.consumedWallTimeMs),
    reservedCostUsd: nonNegativeNumber(value.reservedCostUsd),
    consumedCostUsd: nonNegativeNumber(value.consumedCostUsd),
  });
}

export function budgetReservationError(input: Readonly<{
  budget: Readonly<{ maxWallTimeMs?: number; maxCostUsd?: number }>;
  usage: ExecutionGrantBudgetUsage | undefined;
  reservation: RunBudgetReservation | undefined;
}>): string | undefined {
  const usage = executionGrantBudgetUsage(input.usage);
  const wallTimeMs = input.reservation?.wallTimeMs;
  if (input.budget.maxWallTimeMs !== undefined) {
    if (wallTimeMs === undefined) return "Execution grant requires an explicit wall-time reservation.";
    const remaining = input.budget.maxWallTimeMs - usage.consumedWallTimeMs - usage.reservedWallTimeMs;
    if (wallTimeMs > remaining) return "Execution grant does not have enough remaining wall-time budget for this reservation.";
  }
  const costUsd = input.reservation?.cost?.usd;
  if (input.budget.maxCostUsd !== undefined) {
    if (costUsd === undefined) return "Execution grant requires an explicit quoted cost reservation.";
    const remaining = input.budget.maxCostUsd - usage.consumedCostUsd - usage.reservedCostUsd;
    if (costUsd - remaining > EPSILON) return "Execution grant does not have enough remaining cost budget for this reservation.";
  }
  return undefined;
}

export function reserveExecutionGrantBudget(
  current: ExecutionGrantBudgetUsage | undefined,
  reservation: RunBudgetReservation | undefined,
): ExecutionGrantBudgetUsage {
  const usage = executionGrantBudgetUsage(current);
  return Object.freeze({
    reservedWallTimeMs: usage.reservedWallTimeMs + (reservation?.wallTimeMs ?? 0),
    consumedWallTimeMs: usage.consumedWallTimeMs,
    reservedCostUsd: usage.reservedCostUsd + (reservation?.cost?.usd ?? 0),
    consumedCostUsd: usage.consumedCostUsd,
  });
}

export function settleExecutionGrantWallTime(input: Readonly<{
  current: ExecutionGrantBudgetUsage | undefined;
  reservation: RunBudgetReservation | undefined;
  actualWallTimeMs: number;
}>): ExecutionGrantBudgetUsage {
  const usage = executionGrantBudgetUsage(input.current);
  const reservation = input.reservation?.wallTimeMs ?? 0;
  return Object.freeze({
    reservedWallTimeMs: Math.max(0, usage.reservedWallTimeMs - reservation),
    consumedWallTimeMs: usage.consumedWallTimeMs + nonNegativeInteger(input.actualWallTimeMs),
    reservedCostUsd: usage.reservedCostUsd,
    consumedCostUsd: usage.consumedCostUsd,
  });
}

export function settleExecutionGrantCost(input: Readonly<{
  current: ExecutionGrantBudgetUsage | undefined;
  reservation: RunBudgetReservation | undefined;
  actualCostUsd: number;
}>): ExecutionGrantBudgetUsage {
  const usage = executionGrantBudgetUsage(input.current);
  const reservation = input.reservation?.cost?.usd ?? 0;
  return Object.freeze({
    reservedWallTimeMs: usage.reservedWallTimeMs,
    consumedWallTimeMs: usage.consumedWallTimeMs,
    reservedCostUsd: Math.max(0, usage.reservedCostUsd - reservation),
    consumedCostUsd: usage.consumedCostUsd + nonNegativeNumber(input.actualCostUsd),
  });
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("Execution grant wall-time usage must be a non-negative integer.");
  }
  return value as number;
}

function nonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("Execution grant cost usage must be a finite non-negative number.");
  }
  return Object.is(value, -0) ? 0 : value;
}
