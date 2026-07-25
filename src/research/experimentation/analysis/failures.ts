import { EXPERIMENT_FAILURE_CATEGORIES, type RunAttempt } from "../contracts.js";
import type {
  AnalysisDataIssue,
  FailureTaxonomy,
  FailureTaxonomyEntry,
  FailureTaxonomyKey,
} from "./contracts.js";

const TAXONOMY_ORDER: readonly FailureTaxonomyKey[] = Object.freeze([
  "succeeded",
  ...EXPERIMENT_FAILURE_CATEGORIES,
  "cancelled_without_failure",
  "recovery_required",
  "incomplete",
]);

export function createFailureTaxonomy(
  runAttempts: readonly RunAttempt[],
  dataIssues: readonly AnalysisDataIssue[],
): FailureTaxonomy {
  const groups = new Map<FailureTaxonomyKey, RunAttempt[]>();
  for (const attempt of runAttempts) {
    const key = taxonomyKey(attempt);
    const group = groups.get(key) ?? [];
    group.push(attempt);
    groups.set(key, group);
  }
  const entries: FailureTaxonomyEntry[] = [];
  for (const category of TAXONOMY_ORDER) {
    const attempts = groups.get(category);
    if (!attempts || attempts.length === 0) continue;
    entries.push(Object.freeze({
      category,
      count: attempts.length,
      retryableCount: attempts.filter((attempt) => attempt.payload.failure?.retryable === true).length,
      attemptIds: Object.freeze(attempts.map((attempt) => attempt.payload.attemptId)
        .sort((left, right) => left.localeCompare(right, "en"))),
    }));
  }
  return Object.freeze({
    totalAttempts: runAttempts.length,
    entries: Object.freeze(entries),
    dataIssues: Object.freeze([...dataIssues]),
  });
}

function taxonomyKey(attempt: RunAttempt): FailureTaxonomyKey {
  switch (attempt.payload.status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return attempt.payload.failure?.category ?? "unknown";
    case "cancelled":
      return attempt.payload.failure?.category ?? "cancelled_without_failure";
    case "recovery_required":
      return "recovery_required";
    case "prepared":
    case "queued":
    case "running":
      return "incomplete";
  }
}
