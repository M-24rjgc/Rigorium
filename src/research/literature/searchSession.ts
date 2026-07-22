import type {
  LiteratureExpansionArtifact,
  LiteratureExpansionPlan,
  LiteratureSearchArtifact,
  ResearchCoverage,
  ResearchSourceStatus,
  SearchIntent,
  SearchPlan,
  SearchQueryVariant,
} from "../types.js";

/**
 * An opaque planner label. The session only uses explicit dependencies; it
 * deliberately does not prescribe a research workflow or stage taxonomy.
 */
export type LiteratureSearchSessionStageId = string;

export type LiteratureSearchSessionSearchTask = {
  id: string;
  kind: "search";
  /** Whether this is a recall-oriented query or an answer-oriented question. */
  queryKind: "broad" | "question";
  /** Natural-language purpose retained from the agent's externally built plan. */
  intent: SearchIntent;
  /**
   * Optional opaque planner label. It is recorded for audit only; dependencies
   * control scheduling so callers can model any multi-stage shape they need.
   */
  stageId?: LiteratureSearchSessionStageId;
  dependsOn?: string[];
  plan: SearchPlan;
};

export type LiteratureSearchSessionExpansionTask = {
  id: string;
  kind: "expansion";
  /** Natural-language purpose retained from the agent's externally built plan. */
  intent: SearchIntent;
  stageId?: LiteratureSearchSessionStageId;
  dependsOn?: string[];
  plan: LiteratureExpansionPlan;
};

export type LiteratureSearchSessionTask =
  | LiteratureSearchSessionSearchTask
  | LiteratureSearchSessionExpansionTask;

/**
 * A declarative plan supplied by an agent or another planner. This module does
 * not turn free text into tasks, select seeds, or infer dependencies.
 */
export type LiteratureSearchSessionPlan = {
  sessionId: string;
  intent: SearchIntent;
  /**
   * Total retrieval result slots. Search variants share a task's slots and an
   * expansion consumes one slot per direction. Seed hydration is not a slot.
   */
  totalResultBudget: number;
  maxConcurrentTasks: number;
  tasks: LiteratureSearchSessionTask[];
};

export type LiteratureSearchSessionTaskContext = {
  sessionId: string;
  taskId: string;
  taskIndex: number;
  stageId?: LiteratureSearchSessionStageId;
  signal?: AbortSignal;
  now: () => Date;
  budget: {
    requestedResultSlots: number;
    allocatedResultSlots: number;
    remainingBeforeStart: number;
  };
};

/**
 * Tool adapters are deliberately injected. A caller can bridge existing
 * literature_search and literature_expand tools without this module owning
 * settings, network access, persistence, or Zotero mutation.
 */
export type LiteratureSearchSessionExecutors = {
  search?: (
    task: LiteratureSearchSessionSearchTask,
    plan: SearchPlan,
    context: LiteratureSearchSessionTaskContext,
  ) => Promise<LiteratureSearchArtifact>;
  expansion?: (
    task: LiteratureSearchSessionExpansionTask,
    plan: LiteratureExpansionPlan,
    context: LiteratureSearchSessionTaskContext,
  ) => Promise<LiteratureExpansionArtifact>;
};

export type LiteratureSearchSessionRunOptions = {
  signal?: AbortSignal;
  /** Injectable clock keeps artifact ordering and tests reproducible. */
  now?: () => Date;
};

export type LiteratureSearchSessionTaskState = "succeeded" | "failed" | "excluded" | "cancelled";

export type LiteratureSearchSessionTaskReasonCode =
  | "budget_exhausted"
  | "dependency_not_satisfied"
  | "executor_unavailable"
  | "executor_failed"
  | "cancelled"
  | "no_runnable_task";

export type LiteratureSearchSessionTaskReason = {
  code: LiteratureSearchSessionTaskReasonCode;
  message: string;
};

export type LiteratureSearchSessionBudgetAudit = {
  requestedResultSlots: number;
  allocatedResultSlots: number;
  remainingBeforeStart?: number;
};

export type LiteratureSearchSessionSearchRequestAudit = {
  kind: "search";
  queryVariantId: string;
  query: string;
  requestedResultSlots: number;
  allocatedResultSlots: number;
  status: "scheduled" | "excluded";
  exclusionReason?: LiteratureSearchSessionTaskReasonCode;
};

export type LiteratureSearchSessionExpansionRequestAudit = {
  kind: "expansion";
  seed: LiteratureExpansionPlan["seed"];
  directions: LiteratureExpansionPlan["directions"];
  requestedResultSlotsPerDirection: number;
  allocatedResultSlotsPerDirection: number;
  status: "scheduled" | "excluded";
  exclusionReason?: LiteratureSearchSessionTaskReasonCode;
};

export type LiteratureSearchSessionRequestAudit =
  | LiteratureSearchSessionSearchRequestAudit
  | LiteratureSearchSessionExpansionRequestAudit;

/** A source attempt copied from an existing artifact's source/query audit. */
export type LiteratureSearchSessionSourceAudit = {
  taskId: string;
  taskIndex: number;
  taskKind: LiteratureSearchSessionTask["kind"];
  queryVariantId?: string;
  query?: string;
  /** Keeps provider URL, time, applied constraints, coverage, warnings, and errors. */
  source: ResearchSourceStatus;
};

export type LiteratureSearchSessionTaskResult = {
  taskId: string;
  taskIndex: number;
  taskKind: LiteratureSearchSessionTask["kind"];
  intent: SearchIntent;
  stageId?: LiteratureSearchSessionStageId;
  state: LiteratureSearchSessionTaskState;
  budget: LiteratureSearchSessionBudgetAudit;
  requests: LiteratureSearchSessionRequestAudit[];
  effectivePlan?: SearchPlan | LiteratureExpansionPlan;
  startedAt?: string;
  completedAt?: string;
  coverage?: ResearchCoverage;
  sources: LiteratureSearchSessionSourceAudit[];
  artifact?: LiteratureSearchArtifact | LiteratureExpansionArtifact;
  reason?: LiteratureSearchSessionTaskReason;
};

export type LiteratureSearchSessionArtifactResult = {
  taskId: string;
  taskIndex: number;
  taskKind: LiteratureSearchSessionTask["kind"];
  artifact: LiteratureSearchArtifact | LiteratureExpansionArtifact;
};

export type LiteratureSearchSessionCoverage = {
  status: "complete" | "partial" | "failed";
  /** Sum across retained task artifacts; papers are intentionally not cross-task deduplicated here. */
  resultCount: number;
  successfulTaskIds: string[];
  failedTaskIds: string[];
  excludedTaskIds: string[];
  cancelledTaskIds: string[];
  warnings: string[];
};

export type LiteratureSearchSessionStopReason =
  | "all_tasks_settled"
  | "budget_exhausted"
  | "no_successful_tasks"
  | "cancelled";

export type LiteratureSearchSessionStatus = "complete" | "partial" | "failed" | "cancelled";

export type LiteratureSearchSessionResult = {
  schemaVersion: 1;
  kind: "literature_search_session";
  sessionId: string;
  createdAt: string;
  intent: SearchIntent;
  plan: LiteratureSearchSessionPlan;
  status: LiteratureSearchSessionStatus;
  stopReason: LiteratureSearchSessionStopReason;
  budget: {
    totalResultBudget: number;
    allocatedResultSlots: number;
    remainingResultSlots: number;
    maxConcurrentTasks: number;
  };
  tasks: LiteratureSearchSessionTaskResult[];
  artifacts: LiteratureSearchSessionArtifactResult[];
  /** Sorted by plan task order, query variant, source ID, and retrieval time. */
  sourceAudit: LiteratureSearchSessionSourceAudit[];
  coverage: LiteratureSearchSessionCoverage;
};

type ActiveTask = {
  index: number;
  task: LiteratureSearchSessionTask;
  effectivePlan: SearchPlan | LiteratureExpansionPlan;
  budget: LiteratureSearchSessionBudgetAudit;
  startedAt: string;
  promise: Promise<CompletedTask>;
};

type CompletedTask = {
  index: number;
  result: LiteratureSearchSessionTaskResult;
};

type NextTaskEvent =
  | { kind: "completed"; value: CompletedTask }
  | { kind: "aborted" };

/**
 * Execute the planner-provided task graph with bounded parallelism. The only
 * scheduling semantics are caller-declared dependencies and a global result
 * slot budget; this is not a research-state machine.
 */
export async function runLiteratureSearchSession(
  plan: LiteratureSearchSessionPlan,
  executors: LiteratureSearchSessionExecutors,
  options: LiteratureSearchSessionRunOptions = {},
): Promise<LiteratureSearchSessionResult> {
  validateSessionPlan(plan);

  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const taskIndexById = new Map(plan.tasks.map((task, index) => [task.id, index]));
  const taskResults: Array<LiteratureSearchSessionTaskResult | undefined> = Array.from({ length: plan.tasks.length });
  const pending = new Set(plan.tasks.map((_, index) => index));
  const active = new Map<number, ActiveTask>();
  let allocatedResultSlots = 0;

  if (options.signal?.aborted) {
    cancelPendingTasks(plan, pending, taskResults, "The session was cancelled before any task started.");
    return finalizeSessionResult(plan, createdAt, taskResults, allocatedResultSlots, true);
  }

  while (pending.size > 0 || active.size > 0) {
    if (options.signal?.aborted) {
      cancelPendingTasks(plan, pending, taskResults, "The session was cancelled before this task started.");
      cancelActiveTasks(active, taskResults, "The session was cancelled while this task was running.", now().toISOString());
      active.clear();
      break;
    }

    excludeDependencyBlockedTasks(plan, pending, taskResults, taskIndexById);

    while (!options.signal?.aborted && active.size < plan.maxConcurrentTasks) {
      const nextIndex = nextReadyTaskIndex(plan, pending, taskResults, taskIndexById);
      if (nextIndex === undefined) break;

      const task = plan.tasks[nextIndex];
      if (!task) throw new Error(`Search session task index ${nextIndex} is missing.`);
      const remainingBeforeStart = plan.totalResultBudget - allocatedResultSlots;
      const allocation = allocateTaskBudget(task, remainingBeforeStart);
      pending.delete(nextIndex);

      if (!allocation) {
        taskResults[nextIndex] = skippedTaskResult(task, nextIndex, {
          code: "budget_exhausted",
          message: "The session result budget did not have enough slots for this task.",
        }, {
          requestedResultSlots: requestedResultSlots(task),
          allocatedResultSlots: 0,
          remainingBeforeStart,
        });
        continue;
      }

      allocatedResultSlots += allocation.allocatedResultSlots;
      const startedAt = now().toISOString();
      const activeTask: ActiveTask = {
        index: nextIndex,
        task,
        effectivePlan: allocation.effectivePlan,
        budget: {
          requestedResultSlots: requestedResultSlots(task),
          allocatedResultSlots: allocation.allocatedResultSlots,
          remainingBeforeStart,
        },
        startedAt,
        promise: executeTask(
          plan.sessionId,
          task,
          nextIndex,
          allocation.effectivePlan,
          {
            requestedResultSlots: requestedResultSlots(task),
            allocatedResultSlots: allocation.allocatedResultSlots,
            remainingBeforeStart,
          },
          startedAt,
          executors,
          options.signal,
          now,
        ),
      };
      active.set(nextIndex, activeTask);
    }

    if (options.signal?.aborted) continue;
    if (active.size === 0) {
      if (pending.size === 0) break;

      // A validated acyclic graph reaches this branch only after all remaining
      // tasks have been made terminal. Keep an auditable fallback if an adapter
      // mutates input data during execution.
      for (const index of [...pending].sort((left, right) => left - right)) {
        const task = plan.tasks[index];
        if (!task) continue;
        pending.delete(index);
        taskResults[index] = skippedTaskResult(task, index, {
          code: "no_runnable_task",
          message: "The task could not become runnable from the declared dependency graph.",
        }, {
          requestedResultSlots: requestedResultSlots(task),
          allocatedResultSlots: 0,
        });
      }
      break;
    }

    const next = await waitForNextTask(active, options.signal);
    if (next.kind === "aborted") {
      cancelPendingTasks(plan, pending, taskResults, "The session was cancelled before this task started.");
      cancelActiveTasks(active, taskResults, "The session was cancelled while this task was running.", now().toISOString());
      active.clear();
      break;
    }

    active.delete(next.value.index);
    taskResults[next.value.index] = next.value.result;
  }

  return finalizeSessionResult(
    plan,
    createdAt,
    taskResults,
    allocatedResultSlots,
    options.signal?.aborted === true,
  );
}

async function executeTask(
  sessionId: string,
  task: LiteratureSearchSessionTask,
  taskIndex: number,
  effectivePlan: SearchPlan | LiteratureExpansionPlan,
  budget: LiteratureSearchSessionBudgetAudit,
  startedAt: string,
  executors: LiteratureSearchSessionExecutors,
  signal: AbortSignal | undefined,
  now: () => Date,
): Promise<CompletedTask> {
  const context: LiteratureSearchSessionTaskContext = {
    sessionId,
    taskId: task.id,
    taskIndex,
    ...(task.stageId ? { stageId: task.stageId } : {}),
    ...(signal ? { signal } : {}),
    now,
    budget: {
      requestedResultSlots: budget.requestedResultSlots,
      allocatedResultSlots: budget.allocatedResultSlots,
      remainingBeforeStart: budget.remainingBeforeStart ?? 0,
    },
  };

  try {
    const artifact = task.kind === "search"
      ? await executeSearchTask(task, effectivePlan, executors, context)
      : await executeExpansionTask(task, effectivePlan, executors, context);
    const completedAt = now().toISOString();
    const requests = requestAudit(task, effectivePlan);
    const sources = sourceAuditForArtifact(task, taskIndex, artifact, requests);
    return {
      index: taskIndex,
      result: {
        taskId: task.id,
        taskIndex,
        taskKind: task.kind,
        intent: task.intent,
        ...(task.stageId ? { stageId: task.stageId } : {}),
        state: "succeeded",
        budget,
        requests,
        effectivePlan,
        startedAt,
        completedAt,
        coverage: artifact.coverage,
        sources,
        artifact,
      },
    };
  } catch (error) {
    const completedAt = now().toISOString();
    const cancelled = signal?.aborted === true;
    const reason: LiteratureSearchSessionTaskReason = cancelled
      ? { code: "cancelled", message: "The session was cancelled while this task was running." }
      : error instanceof MissingExecutorError
        ? { code: "executor_unavailable", message: error.message }
        : { code: "executor_failed", message: errorMessage(error) };
    return {
      index: taskIndex,
      result: {
        taskId: task.id,
        taskIndex,
        taskKind: task.kind,
        intent: task.intent,
        ...(task.stageId ? { stageId: task.stageId } : {}),
        state: cancelled ? "cancelled" : "failed",
        budget,
        requests: requestAudit(task, effectivePlan),
        effectivePlan,
        startedAt,
        completedAt,
        sources: [],
        reason,
      },
    };
  }
}

async function executeSearchTask(
  task: LiteratureSearchSessionSearchTask,
  effectivePlan: SearchPlan | LiteratureExpansionPlan,
  executors: LiteratureSearchSessionExecutors,
  context: LiteratureSearchSessionTaskContext,
): Promise<LiteratureSearchArtifact> {
  if (!executors.search) throw new MissingExecutorError("No search executor was supplied for this session.");
  const artifact = await executors.search(task, effectivePlan as SearchPlan, context);
  if (!artifact || artifact.kind !== "literature_search") {
    throw new Error("The search executor did not return a LiteratureSearchArtifact.");
  }
  return artifact;
}

async function executeExpansionTask(
  task: LiteratureSearchSessionExpansionTask,
  effectivePlan: SearchPlan | LiteratureExpansionPlan,
  executors: LiteratureSearchSessionExecutors,
  context: LiteratureSearchSessionTaskContext,
): Promise<LiteratureExpansionArtifact> {
  if (!executors.expansion) throw new MissingExecutorError("No expansion executor was supplied for this session.");
  const artifact = await executors.expansion(task, effectivePlan as LiteratureExpansionPlan, context);
  if (!artifact || artifact.kind !== "literature_expansion") {
    throw new Error("The expansion executor did not return a LiteratureExpansionArtifact.");
  }
  return artifact;
}

class MissingExecutorError extends Error {}

function allocateTaskBudget(
  task: LiteratureSearchSessionTask,
  remainingResultSlots: number,
): { allocatedResultSlots: number; effectivePlan: SearchPlan | LiteratureExpansionPlan } | undefined {
  if (remainingResultSlots <= 0) return undefined;
  if (task.kind === "search") {
    const allocatedResultSlots = Math.min(task.plan.limit, remainingResultSlots);
    if (allocatedResultSlots < 1) return undefined;
    return {
      allocatedResultSlots,
      effectivePlan: capSearchPlan(task.plan, allocatedResultSlots),
    };
  }

  const directionCount = task.plan.directions.length;
  const limitPerDirection = Math.min(task.plan.limitPerDirection, Math.floor(remainingResultSlots / directionCount));
  if (limitPerDirection < 1) return undefined;
  return {
    allocatedResultSlots: limitPerDirection * directionCount,
    effectivePlan: { ...task.plan, limitPerDirection },
  };
}

function capSearchPlan(plan: SearchPlan, totalLimit: number): SearchPlan {
  if (!plan.queryVariants || plan.queryVariants.length === 0) {
    return { ...plan, limit: totalLimit };
  }

  const allocatedVariants = allocateQueryVariantLimits(plan.queryVariants, totalLimit);
  return {
    ...plan,
    limit: totalLimit,
    queryVariants: allocatedVariants,
  };
}

function allocateQueryVariantLimits(variants: SearchQueryVariant[], totalLimit: number): SearchQueryVariant[] {
  const eligible = variants.slice(0, Math.min(variants.length, totalLimit));
  const limits = eligible.map(() => 1);
  let remaining = totalLimit - limits.length;

  while (remaining > 0) {
    let changed = false;
    for (let index = 0; index < eligible.length && remaining > 0; index += 1) {
      const variant = eligible[index];
      const current = limits[index] ?? 0;
      if (!variant || current >= variant.requestLimit) continue;
      limits[index] = current + 1;
      remaining -= 1;
      changed = true;
    }
    if (!changed) break;
  }

  return eligible.map((variant, index) => ({
    ...variant,
    requestLimit: limits[index] ?? 1,
  }));
}

function requestedResultSlots(task: LiteratureSearchSessionTask): number {
  return task.kind === "search"
    ? task.plan.limit
    : task.plan.limitPerDirection * task.plan.directions.length;
}

function nextReadyTaskIndex(
  plan: LiteratureSearchSessionPlan,
  pending: Set<number>,
  results: Array<LiteratureSearchSessionTaskResult | undefined>,
  taskIndexById: Map<string, number>,
): number | undefined {
  for (const index of [...pending].sort((left, right) => left - right)) {
    const task = plan.tasks[index];
    if (!task) continue;
    const dependencies = task.dependsOn ?? [];
    if (dependencies.every((dependencyId) => results[taskIndexById.get(dependencyId) ?? -1]?.state === "succeeded")) {
      return index;
    }
  }
  return undefined;
}

function excludeDependencyBlockedTasks(
  plan: LiteratureSearchSessionPlan,
  pending: Set<number>,
  results: Array<LiteratureSearchSessionTaskResult | undefined>,
  taskIndexById: Map<string, number>,
): void {
  for (const index of [...pending].sort((left, right) => left - right)) {
    const task = plan.tasks[index];
    if (!task) continue;
    const dependency = (task.dependsOn ?? []).find((dependencyId) => {
      const dependencyIndex = taskIndexById.get(dependencyId);
      const result = dependencyIndex === undefined ? undefined : results[dependencyIndex];
      return result !== undefined && result.state !== "succeeded";
    });
    if (!dependency) continue;
    const dependencyIndex = taskIndexById.get(dependency);
    const dependencyState = dependencyIndex === undefined ? "unknown" : results[dependencyIndex]?.state ?? "unknown";
    pending.delete(index);
    results[index] = skippedTaskResult(task, index, {
      code: "dependency_not_satisfied",
      message: `The task was not run because dependency ${dependency} ended as ${dependencyState}.`,
    }, {
      requestedResultSlots: requestedResultSlots(task),
      allocatedResultSlots: 0,
    });
  }
}

function cancelPendingTasks(
  plan: LiteratureSearchSessionPlan,
  pending: Set<number>,
  results: Array<LiteratureSearchSessionTaskResult | undefined>,
  message: string,
): void {
  for (const index of [...pending].sort((left, right) => left - right)) {
    const task = plan.tasks[index];
    if (!task) continue;
    pending.delete(index);
    results[index] = skippedTaskResult(task, index, { code: "cancelled", message }, {
      requestedResultSlots: requestedResultSlots(task),
      allocatedResultSlots: 0,
    }, "cancelled");
  }
}

function cancelActiveTasks(
  active: Map<number, ActiveTask>,
  results: Array<LiteratureSearchSessionTaskResult | undefined>,
  message: string,
  completedAt: string,
): void {
  for (const item of active.values()) {
    results[item.index] = {
      taskId: item.task.id,
      taskIndex: item.index,
      taskKind: item.task.kind,
      intent: item.task.intent,
      ...(item.task.stageId ? { stageId: item.task.stageId } : {}),
      state: "cancelled",
      budget: item.budget,
      requests: requestAudit(item.task, item.effectivePlan),
      effectivePlan: item.effectivePlan,
      startedAt: item.startedAt,
      completedAt,
      sources: [],
      reason: { code: "cancelled", message },
    };
  }
}

function skippedTaskResult(
  task: LiteratureSearchSessionTask,
  taskIndex: number,
  reason: LiteratureSearchSessionTaskReason,
  budget: LiteratureSearchSessionBudgetAudit,
  state: "excluded" | "cancelled" = "excluded",
): LiteratureSearchSessionTaskResult {
  return {
    taskId: task.id,
    taskIndex,
    taskKind: task.kind,
    intent: task.intent,
    ...(task.stageId ? { stageId: task.stageId } : {}),
    state,
    budget,
    requests: requestAudit(task, undefined, reason.code),
    sources: [],
    reason,
  };
}

function requestAudit(
  task: LiteratureSearchSessionTask,
  effectivePlan: SearchPlan | LiteratureExpansionPlan | undefined,
  exclusionReason?: LiteratureSearchSessionTaskReasonCode,
): LiteratureSearchSessionRequestAudit[] {
  if (task.kind === "expansion") {
    const effective = effectivePlan as LiteratureExpansionPlan | undefined;
    return [{
      kind: "expansion",
      seed: task.plan.seed,
      directions: [...task.plan.directions],
      requestedResultSlotsPerDirection: task.plan.limitPerDirection,
      allocatedResultSlotsPerDirection: effective?.limitPerDirection ?? 0,
      status: effective ? "scheduled" : "excluded",
      ...(effective ? {} : { exclusionReason: exclusionReason ?? "budget_exhausted" }),
    }];
  }

  const effective = effectivePlan as SearchPlan | undefined;
  const effectiveVariants = new Map((effective ? queryVariantsForPlan(effective) : []).map((variant) => [variant.id, variant]));
  return queryVariantsForPlan(task.plan).map((variant) => {
    const allocated = effectiveVariants.get(variant.id);
    return {
      kind: "search" as const,
      queryVariantId: variant.id,
      query: variant.query,
      requestedResultSlots: variant.requestLimit,
      allocatedResultSlots: allocated?.requestLimit ?? 0,
      status: allocated ? "scheduled" as const : "excluded" as const,
      ...(allocated ? {} : { exclusionReason: exclusionReason ?? "budget_exhausted" }),
    };
  });
}

function queryVariantsForPlan(plan: SearchPlan): SearchQueryVariant[] {
  if (plan.queryVariants && plan.queryVariants.length > 0) return plan.queryVariants;
  return [{ id: "primary", query: plan.query, requestLimit: plan.limit, category: "primary" }];
}

function sourceAuditForArtifact(
  task: LiteratureSearchSessionTask,
  taskIndex: number,
  artifact: LiteratureSearchArtifact | LiteratureExpansionArtifact,
  requests: LiteratureSearchSessionRequestAudit[],
): LiteratureSearchSessionSourceAudit[] {
  const queryByVariantId = new Map(
    requests
      .filter((request): request is LiteratureSearchSessionSearchRequestAudit => request.kind === "search")
      .map((request) => [request.queryVariantId, request.query]),
  );
  const sourceAttempts = artifact.kind === "literature_search" && artifact.queryAudit && artifact.queryAudit.length > 0
    ? artifact.queryAudit
    : artifact.sources;

  return sourceAttempts
    .map((source) => ({
      taskId: task.id,
      taskIndex,
      taskKind: task.kind,
      ...(source.queryVariantId ? { queryVariantId: source.queryVariantId } : {}),
      ...(source.queryVariantId && queryByVariantId.get(source.queryVariantId)
        ? { query: queryByVariantId.get(source.queryVariantId) }
        : {}),
      source,
    }))
    .sort(compareSourceAudit);
}

function compareSourceAudit(left: LiteratureSearchSessionSourceAudit, right: LiteratureSearchSessionSourceAudit): number {
  return compareNumber(left.taskIndex, right.taskIndex)
    || compareText(left.queryVariantId ?? "", right.queryVariantId ?? "")
    || compareText(left.source.id, right.source.id)
    || compareText(left.source.retrievedAt, right.source.retrievedAt)
    || compareText(left.source.name, right.source.name)
    || compareText(left.source.status, right.source.status)
    || compareNumber(left.source.resultCount, right.source.resultCount)
    || compareText(left.source.coverage, right.source.coverage)
    || compareText(left.source.error ?? "", right.source.error ?? "");
}

function waitForNextTask(active: Map<number, ActiveTask>, signal: AbortSignal | undefined): Promise<NextTaskEvent> {
  const completion = Promise.race([...active.values()].map((item) => item.promise));
  if (!signal) return completion.then((value) => ({ kind: "completed", value }));
  if (signal.aborted) return Promise.resolve({ kind: "aborted" });

  return new Promise((resolve) => {
    const onAbort = () => {
      cleanup();
      resolve({ kind: "aborted" });
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void completion.then((value) => {
      cleanup();
      resolve({ kind: "completed", value });
    });
  });
}

function finalizeSessionResult(
  plan: LiteratureSearchSessionPlan,
  createdAt: string,
  rawTaskResults: Array<LiteratureSearchSessionTaskResult | undefined>,
  allocatedResultSlots: number,
  aborted: boolean,
): LiteratureSearchSessionResult {
  const tasks = rawTaskResults.map((result, index) => {
    if (result) return result;
    const task = plan.tasks[index];
    if (!task) throw new Error(`Search session task index ${index} is missing.`);
    return skippedTaskResult(task, index, {
      code: "no_runnable_task",
      message: "The task did not reach a terminal scheduler state.",
    }, {
      requestedResultSlots: requestedResultSlots(task),
      allocatedResultSlots: 0,
    });
  });
  const artifacts = tasks
    .filter((task): task is LiteratureSearchSessionTaskResult & { artifact: LiteratureSearchArtifact | LiteratureExpansionArtifact } => Boolean(task.artifact))
    .map((task) => ({ taskId: task.taskId, taskIndex: task.taskIndex, taskKind: task.taskKind, artifact: task.artifact }));
  const sourceAudit = tasks.flatMap((task) => task.sources).sort(compareSourceAudit);
  const coverage = buildCoverage(tasks);
  const status = sessionStatus(tasks, aborted);
  const stopReason = sessionStopReason(tasks, status);

  return {
    schemaVersion: 1,
    kind: "literature_search_session",
    sessionId: plan.sessionId,
    createdAt,
    intent: plan.intent,
    plan,
    status,
    stopReason,
    budget: {
      totalResultBudget: plan.totalResultBudget,
      allocatedResultSlots,
      remainingResultSlots: plan.totalResultBudget - allocatedResultSlots,
      maxConcurrentTasks: plan.maxConcurrentTasks,
    },
    tasks,
    artifacts,
    sourceAudit,
    coverage,
  };
}

function buildCoverage(tasks: LiteratureSearchSessionTaskResult[]): LiteratureSearchSessionCoverage {
  const successfulTaskIds = tasks.filter((task) => task.state === "succeeded").map((task) => task.taskId);
  const failedTaskIds = tasks.filter((task) => task.state === "failed").map((task) => task.taskId);
  const excludedTaskIds = tasks.filter((task) => task.state === "excluded").map((task) => task.taskId);
  const cancelledTaskIds = tasks.filter((task) => task.state === "cancelled").map((task) => task.taskId);
  const successfulCoverage = tasks
    .filter((task): task is LiteratureSearchSessionTaskResult & { coverage: ResearchCoverage } => Boolean(task.coverage))
    .map((task) => task.coverage);
  const warnings = uniqueSorted([
    ...successfulCoverage.flatMap((coverage) => coverage.warnings),
    ...tasks
      .filter((task) => task.state !== "succeeded")
      .flatMap((task) => task.reason ? [`${task.taskId}: ${task.reason.message}`] : []),
  ]);
  const hasExcludedRequest = tasks.some((task) => task.requests.some((request) => request.status === "excluded"));
  const status = successfulTaskIds.length === 0
    ? "failed"
    : failedTaskIds.length > 0
        || excludedTaskIds.length > 0
        || cancelledTaskIds.length > 0
        || hasExcludedRequest
        || successfulCoverage.some((coverage) => coverage.status !== "complete")
      ? "partial"
      : "complete";

  return {
    status,
    resultCount: successfulCoverage.reduce((sum, coverage) => sum + coverage.resultCount, 0),
    successfulTaskIds,
    failedTaskIds,
    excludedTaskIds,
    cancelledTaskIds,
    warnings,
  };
}

function sessionStatus(
  tasks: LiteratureSearchSessionTaskResult[],
  aborted: boolean,
): LiteratureSearchSessionStatus {
  if (aborted || tasks.some((task) => task.state === "cancelled")) return "cancelled";
  if (tasks.length === 0) return "complete";
  if (tasks.every((task) => (
    task.state === "succeeded"
    && task.coverage?.status === "complete"
    && task.requests.every((request) => request.status === "scheduled")
  ))) return "complete";
  if (tasks.every((task) => task.state !== "succeeded")) return "failed";
  return "partial";
}

function sessionStopReason(
  tasks: LiteratureSearchSessionTaskResult[],
  status: LiteratureSearchSessionStatus,
): LiteratureSearchSessionStopReason {
  if (status === "cancelled") return "cancelled";
  if (tasks.some((task) => (
    task.reason?.code === "budget_exhausted"
    || task.requests.some((request) => request.exclusionReason === "budget_exhausted")
  ))) return "budget_exhausted";
  if (!tasks.some((task) => task.state === "succeeded")) return "no_successful_tasks";
  return "all_tasks_settled";
}

function validateSessionPlan(plan: LiteratureSearchSessionPlan): void {
  if (!isNonEmptyText(plan.sessionId)) throw new Error("Literature search session requires a non-empty sessionId.");
  if (!isNonEmptyText(plan.intent?.text)) throw new Error("Literature search session requires a non-empty intent.");
  if (!isNonNegativeInteger(plan.totalResultBudget)) {
    throw new Error("Literature search session totalResultBudget must be a non-negative integer.");
  }
  if (!isPositiveInteger(plan.maxConcurrentTasks)) {
    throw new Error("Literature search session maxConcurrentTasks must be a positive integer.");
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error("Literature search session requires at least one task.");
  }

  const taskIds = new Set<string>();
  for (const task of plan.tasks) {
    if (!isNonEmptyText(task.id)) throw new Error("Every literature search session task requires a non-empty id.");
    if (taskIds.has(task.id)) throw new Error(`Duplicate literature search session task id: ${task.id}.`);
    taskIds.add(task.id);
    if (!isNonEmptyText(task.intent?.text)) throw new Error(`Task ${task.id} requires a non-empty intent.`);
    if (task.kind === "search") validateSearchTask(task);
    else validateExpansionTask(task);
  }

  for (const task of plan.tasks) {
    const dependencies = task.dependsOn ?? [];
    const seenDependencies = new Set<string>();
    for (const dependency of dependencies) {
      if (!taskIds.has(dependency)) throw new Error(`Task ${task.id} depends on unknown task ${dependency}.`);
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself.`);
      if (seenDependencies.has(dependency)) throw new Error(`Task ${task.id} repeats dependency ${dependency}.`);
      seenDependencies.add(dependency);
    }
  }
  assertAcyclicDependencies(plan);
}

function validateSearchTask(task: LiteratureSearchSessionSearchTask): void {
  if (!isNonEmptyText(task.plan?.query)) throw new Error(`Search task ${task.id} requires a non-empty query.`);
  if (!isPositiveInteger(task.plan.limit)) throw new Error(`Search task ${task.id} requires a positive plan limit.`);
  if (task.plan.fromYear !== undefined && !isPositiveInteger(task.plan.fromYear)) {
    throw new Error(`Search task ${task.id} has an invalid fromYear.`);
  }
  if (task.plan.toYear !== undefined && !isPositiveInteger(task.plan.toYear)) {
    throw new Error(`Search task ${task.id} has an invalid toYear.`);
  }
  if (task.plan.fromYear !== undefined && task.plan.toYear !== undefined && task.plan.fromYear > task.plan.toYear) {
    throw new Error(`Search task ${task.id} has fromYear after toYear.`);
  }
  if (!task.plan.queryVariants || task.plan.queryVariants.length === 0) return;

  const variantIds = new Set<string>();
  let allocatedSlots = 0;
  for (const variant of task.plan.queryVariants) {
    if (!isNonEmptyText(variant.id) || !isNonEmptyText(variant.query) || !isPositiveInteger(variant.requestLimit)) {
      throw new Error(`Search task ${task.id} has an invalid query variant.`);
    }
    if (variantIds.has(variant.id)) throw new Error(`Search task ${task.id} repeats query variant ${variant.id}.`);
    variantIds.add(variant.id);
    allocatedSlots += variant.requestLimit;
  }
  if (allocatedSlots !== task.plan.limit) {
    throw new Error(`Search task ${task.id} query variant slots must equal its plan limit.`);
  }
}

function validateExpansionTask(task: LiteratureSearchSessionExpansionTask): void {
  if (!isPositiveInteger(task.plan?.limitPerDirection)) {
    throw new Error(`Expansion task ${task.id} requires a positive limitPerDirection.`);
  }
  if (!Array.isArray(task.plan.directions) || task.plan.directions.length === 0) {
    throw new Error(`Expansion task ${task.id} requires at least one direction.`);
  }
  if (new Set(task.plan.directions).size !== task.plan.directions.length) {
    throw new Error(`Expansion task ${task.id} repeats an expansion direction.`);
  }
}

function assertAcyclicDependencies(plan: LiteratureSearchSessionPlan): void {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) throw new Error(`Literature search session dependencies contain a cycle at ${taskId}.`);
    visiting.add(taskId);
    const task = byId.get(taskId);
    for (const dependency of task?.dependsOn ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of plan.tasks) visit(task.id);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function errorMessage(error: unknown): string {
  if (error instanceof MissingExecutorError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
