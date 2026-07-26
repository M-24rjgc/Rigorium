import { randomUUID } from "node:crypto";
import type { PermissionResult } from "../../permission/index.js";
import { normalizeDoi } from "../../research/identity.js";
import {
  normalizeOpenAlexWorkId,
} from "../../research/literature/openAlexExpansion.js";
import { normalizeArxivClassifications } from "../../research/literature/arxivSource.js";
import {
  runLiteratureSearchSession,
  type LiteratureSearchSessionExpansionTask,
  type LiteratureSearchSessionPlan,
  type LiteratureSearchSessionResult,
  type LiteratureSearchSessionSearchTask,
} from "../../research/literature/searchSession.js";
import { readResearchSettings } from "../../research/settings.js";
import type {
  LiteratureExpansionArtifact,
  LiteratureExpansionDirection,
  LiteratureExpansionPlan,
  LiteratureExpansionSeed,
  LiteratureSpecificQueryScope,
  LiteratureSearchArtifact,
  ResearchSettings,
  SearchClassification,
  SearchPlan,
  SearchVenueSet,
} from "../../research/types.js";
import {
  buildLiteratureSearchSemantics,
  createLiteratureSearchTool,
  normalizeVenueSet,
  type CreateLiteratureSearchToolOptions,
  type LiteratureSearchInput,
} from "./literatureSearch.js";
import {
  createLiteratureExpandTool,
  type CreateLiteratureExpandToolOptions,
  type LiteratureExpandInput,
} from "./literatureExpand.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult } from "../protocol/schema.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CONCURRENT_TASKS = 2;
const MAX_MAX_CONCURRENT_TASKS = 8;
const MAX_TOTAL_RESULT_BUDGET = 200;
const MAX_TASKS = 32;

export type LiteratureDeepSearchSearchTaskInput = {
  id: string;
  kind: "search";
  /** Explicit query-search mode. */
  mode?: "broad" | "specific";
  /** Backward-compatible alias: `question` maps to specific mode. */
  queryKind?: "broad" | "question";
  intent: string;
  stageId?: string;
  dependsOn?: string[];
  query: string;
  language?: string;
  specificity?: Partial<LiteratureSpecificQueryScope>;
  queryVariants?: LiteratureSearchInput["queryVariants"];
  limit?: number;
  fromYear?: number;
  toYear?: number;
  sort?: SearchPlan["sort"];
  classifications?: LiteratureSearchInput["classifications"];
  venueSet?: LiteratureSearchInput["venueSet"];
};

export type LiteratureDeepSearchExpansionTaskInput = {
  id: string;
  kind: "expansion";
  intent: string;
  stageId?: string;
  dependsOn?: string[];
  seed: LiteratureExpansionSeed;
  directions?: LiteratureExpansionDirection[];
  limitPerDirection?: number;
};

export type LiteratureDeepSearchTaskInput =
  | LiteratureDeepSearchSearchTaskInput
  | LiteratureDeepSearchExpansionTaskInput;

export type LiteratureDeepSearchInput = {
  /** Natural-language research goal retained in the session artifact. */
  intent: string;
  /** Optional stable caller label. A UUID-backed session ID is generated when omitted. */
  sessionId?: string;
  /** Declarative task graph. Dependencies are explicit and are never inferred. */
  tasks: LiteratureDeepSearchTaskInput[];
  /** Shared result-slot budget across all tasks. */
  totalResultBudget?: number;
  /** Maximum number of ready tasks that may run at once. */
  maxConcurrentTasks?: number;
  /** Wall-clock timeout for the whole session. Completed artifacts remain auditable. */
  timeoutMs?: number;
};

export type CreateLiteratureDeepSearchToolOptions = {
  search?: CreateLiteratureSearchToolOptions;
  expansion?: CreateLiteratureExpandToolOptions;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  defaultMaxConcurrentTasks?: number;
  maxConcurrentTasks?: number;
  maxTotalResultBudget?: number;
};

type DeepSearchValidationLimits = {
  maxTotalResultBudget: number;
  maxConcurrentTasks: number;
  maxTimeoutMs: number;
};

type DeepSearchInputGraphTask = {
  id: string;
  dependencies: Array<{ id: string; path: string }>;
};

/**
 * The completed scheduler result with the outer wall-clock decision retained
 * in-band, so a persisted JSON artifact remains reproducible without relying
 * on ToolRuntime metadata.
 */
export type LiteratureDeepSearchArtifact = LiteratureSearchSessionResult & {
  execution: {
    timeoutMs: number;
    timedOut: boolean;
  };
};

/**
 * Execute an agent-planned literature task graph through the existing search
 * and citation-expansion adapters. This tool owns orchestration only; it does
 * not infer a workflow, persist Zotero changes, or expose a slash command.
 */
export function createLiteratureDeepSearchTool(
  options: CreateLiteratureDeepSearchToolOptions = {},
): RigoriumToolDefinition<LiteratureDeepSearchInput, LiteratureDeepSearchArtifact> {
  const searchTool = createLiteratureSearchTool(options.search);
  const expansionTool = createLiteratureExpandTool(options.expansion);
  const maxTimeoutMs = boundedOption(options.maxTimeoutMs, MAX_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const defaultTimeoutMs = boundedOption(options.defaultTimeoutMs, DEFAULT_TIMEOUT_MS, 1, maxTimeoutMs);
  const maxConcurrentTasks = boundedOption(
    options.maxConcurrentTasks,
    MAX_MAX_CONCURRENT_TASKS,
    1,
    MAX_MAX_CONCURRENT_TASKS,
  );
  const defaultMaxConcurrentTasks = boundedOption(
    options.defaultMaxConcurrentTasks,
    DEFAULT_MAX_CONCURRENT_TASKS,
    1,
    maxConcurrentTasks,
  );
  const maxTotalResultBudget = boundedOption(
    options.maxTotalResultBudget,
    MAX_TOTAL_RESULT_BUDGET,
    1,
    MAX_TOTAL_RESULT_BUDGET,
  );
  const validationLimits: DeepSearchValidationLimits = {
    maxTotalResultBudget,
    maxConcurrentTasks,
    maxTimeoutMs,
  };

  return {
    name: "literature_deep_search",
    title: "Run Deep Literature Search",
    description: `Run a bounded, agent-planned academic literature session across independent searches and citation expansions.

Use this when a natural-language research goal needs several coordinated queries, explicit task dependencies, a shared result budget, bounded concurrency, or a time-limited pass. The input is structured task data selected by the agent; the user does not need to type a slash command. Each task retains its intent, effective plan, source attempts, coverage, and artifact so partial success remains auditable. This is metadata-only and never writes to Zotero.`,
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["intent", "tasks"],
      additionalProperties: false,
      properties: {
        intent: {
          type: "string",
          description: "Natural-language research goal for the complete session.",
        },
        sessionId: {
          type: "string",
          description: "Optional stable session label. A generated UUID is used when omitted.",
        },
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: MAX_TASKS,
          description: "Explicit search and citation-expansion tasks. Dependencies are listed in dependsOn.",
          items: {
            type: "object",
            required: ["id", "kind", "intent"],
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "Unique task ID within this session." },
              kind: { type: "string", enum: ["search", "expansion"] },
              mode: { type: "string", enum: ["broad", "specific"] },
              queryKind: { type: "string", enum: ["broad", "question"], description: "Deprecated alias; question maps to specific mode." },
              intent: { type: "string", description: "Why this task is part of the research goal." },
              stageId: { type: "string" },
              dependsOn: { type: "array", items: { type: "string" }, maxItems: MAX_TASKS },
              query: { type: "string" },
              language: { type: "string", description: "Declared BCP-47 language tag; never inferred." },
              specificity: {
                type: "object",
                additionalProperties: false,
                properties: {
                  focus: { type: "string" },
                  requiredConcepts: { type: "array", maxItems: 12, items: { type: "string" } },
                  excludedConcepts: { type: "array", maxItems: 12, items: { type: "string" } },
                },
              },
              queryVariants: {
                type: "array",
                maxItems: 3,
                items: {
                  type: "object",
                  required: ["query"],
                  additionalProperties: false,
                  properties: {
                    query: { type: "string" },
                    language: { type: "string" },
                    category: {
                      type: "string",
                      enum: ["synonym", "abbreviation", "historical_term", "adjacent_field"],
                    },
                    rationale: { type: "string" },
                    provenance: {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind"],
                      properties: {
                        kind: { type: "string", enum: ["agent_selected", "terminology_candidate", "translation"] },
                        artifactId: { type: "string" },
                        candidateIds: { type: "array", maxItems: 24, items: { type: "string" } },
                        sourceVariantId: { type: "string" },
                        sourceLanguage: { type: "string" },
                        method: { type: "string", enum: ["agent_selected", "user_supplied"] },
                      },
                    },
                  },
                },
              },
              limit: { type: "number" },
              fromYear: { type: "number" },
              toYear: { type: "number" },
              sort: { type: "string", enum: ["relevance", "cited_by_count", "publication_date"] },
              classifications: {
                type: "array",
                maxItems: 8,
                items: {
                  type: "object",
                  required: ["scheme", "include"],
                  additionalProperties: false,
                  properties: {
                    scheme: { type: "string", enum: ["arxiv"] },
                    include: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } },
                  },
                },
              },
              venueSet: {
                type: "object",
                required: ["id", "name", "venues"],
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  venues: {
                    type: "array",
                    minItems: 1,
                    maxItems: 12,
                    items: {
                      type: "object",
                      required: ["id", "name"],
                      additionalProperties: false,
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        aliases: { type: "array", maxItems: 8, items: { type: "string" } },
                        year: { type: "number" },
                        track: { type: "string" },
                        status: { type: "string", enum: ["accepted", "submission"] },
                        accepted: { type: "boolean" },
                        openReviewVenueId: { type: "string" },
                      },
                    },
                  },
                },
              },
              seed: {
                type: "object",
                additionalProperties: false,
                properties: {
                  openAlexId: { type: "string" },
                  doi: { type: "string" },
                  title: { type: "string" },
                  year: { type: "number" },
                  authors: { type: "array", maxItems: 50, items: { type: "string" } },
                },
              },
              directions: {
                type: "array",
                minItems: 1,
                maxItems: 2,
                items: { type: "string", enum: ["references", "citations"] },
              },
              limitPerDirection: { type: "number" },
            },
          },
        },
        totalResultBudget: {
          type: "integer",
          description: `Shared result-slot budget. Defaults to the requested task total and is capped at ${maxTotalResultBudget}.`,
        },
        maxConcurrentTasks: {
          type: "integer",
          description: `Maximum ready tasks to run concurrently. Defaults to ${defaultMaxConcurrentTasks} and is capped at ${maxConcurrentTasks}.`,
        },
        timeoutMs: {
          type: "integer",
          description: `Whole-session wall-clock timeout in milliseconds. Defaults to ${defaultTimeoutMs} and is capped at ${maxTimeoutMs}.`,
        },
      },
    },
    maxResultBytes: 500_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    validateInput: async (input): Promise<RigoriumToolValidationResult> => {
      const issues = validateDeepSearchInput(input, validationLimits);
      return issues.length === 0 ? { ok: true, input } : { ok: false, issues };
    },
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "ask",
      reason: {
        type: "tool",
        toolName: "literature_deep_search",
        message: "Deep academic literature search requires network access.",
      },
      request: {
        toolCallId: "",
        toolName: "literature_deep_search",
        inputSummary: "deep academic literature search",
        reason: {
          type: "tool",
          toolName: "literature_deep_search",
          message: "Deep academic literature search requires network access.",
        },
        options: [
          { id: "allow_once", label: "Allow search" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    execute: async (input, context) => {
      const issues = validateDeepSearchInput(input, validationLimits);
      if (issues.length > 0) {
        throw new RigoriumToolRuntimeError(
          "invalid_tool_input",
          issues.map((issue) => `${issue.path}: ${issue.message}`).join(" "),
          { issues },
        );
      }

      const settingsSnapshot = await readResearchSettings({
        rigoriumHome: context.env?.RIGORIUM_HOME,
        projectRoot: context.cwd,
      });
      const settings = settingsSnapshot.effective;
      if (!settings.literature.enabled) {
        throw new RigoriumToolRuntimeError(
          "setup_required",
          "Academic literature search is disabled in Research Settings.",
        );
      }
      if (!settings.privacy.allowRemoteMetadataSearch) {
        throw new RigoriumToolRuntimeError(
          "permission_denied",
          "Remote metadata search is disabled by Research Settings privacy controls.",
        );
      }

      const plan = buildSessionPlan(input, settings, {
        maxTotalResultBudget,
        defaultMaxConcurrentTasks,
        maxConcurrentTasks,
        defaultTimeoutMs,
        maxTimeoutMs,
      });
      const runControl = createRunControl(context.abortSignal, planTimeout(input.timeoutMs, defaultTimeoutMs, maxTimeoutMs));
      try {
        let session: LiteratureSearchSessionResult;
        try {
          session = await runLiteratureSearchSession(plan, {
            search: async (_task, effectivePlan, taskContext) => {
              const output = await searchTool.execute(
                searchInputFromPlan(effectivePlan),
                childContext(context, taskContext.signal, taskContext.now),
              );
              return requireArtifact< LiteratureSearchArtifact >(output.data, "literature_search");
            },
            expansion: async (_task, effectivePlan, taskContext) => {
              const output = await expansionTool.execute(
                expansionInputFromPlan(effectivePlan),
                childContext(context, taskContext.signal, taskContext.now),
              );
              return requireArtifact<LiteratureExpansionArtifact>(output.data, "literature_expansion");
            },
          }, {
            signal: runControl.signal,
            now: context.now,
          });
        } catch (error) {
          if (error instanceof RigoriumToolRuntimeError) throw error;
          throw new RigoriumToolRuntimeError(
            "invalid_tool_input",
            `Invalid literature search session plan: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        return formatToolOutput(session, {
          timeoutMs: runControl.timeoutMs,
          timedOut: runControl.timedOut(),
        });
      } finally {
        runControl.cleanup();
      }
    },
  };
}

function buildSessionPlan(
  input: LiteratureDeepSearchInput,
  settings: ResearchSettings,
  limits: {
    maxTotalResultBudget: number;
    defaultMaxConcurrentTasks: number;
    maxConcurrentTasks: number;
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
  },
): LiteratureSearchSessionPlan {
  const tasks = input.tasks.map((task) => {
    if (task.kind === "search") return buildSearchTask(task, settings);
    return buildExpansionTask(task, settings);
  });
  const requestedResultSlots = tasks.reduce(
    (total, task) => total + (task.kind === "search"
      ? task.plan.limit
      : task.plan.limitPerDirection * task.plan.directions.length),
    0,
  );
  const totalResultBudget = input.totalResultBudget === undefined
    ? Math.min(limits.maxTotalResultBudget, Math.max(1, requestedResultSlots))
    : input.totalResultBudget;
  const maxConcurrent = input.maxConcurrentTasks ?? limits.defaultMaxConcurrentTasks;
  const timeoutMs = input.timeoutMs ?? limits.defaultTimeoutMs;
  if (totalResultBudget > limits.maxTotalResultBudget) {
    throw new RigoriumToolRuntimeError(
      "invalid_tool_input",
      `totalResultBudget must be between 0 and ${limits.maxTotalResultBudget}.`,
    );
  }
  if (maxConcurrent < 1 || maxConcurrent > limits.maxConcurrentTasks) {
    throw new RigoriumToolRuntimeError(
      "invalid_tool_input",
      `maxConcurrentTasks must be between 1 and ${limits.maxConcurrentTasks}.`,
    );
  }
  if (timeoutMs < 1 || timeoutMs > limits.maxTimeoutMs) {
    throw new RigoriumToolRuntimeError(
      "invalid_tool_input",
      `timeoutMs must be between 1 and ${limits.maxTimeoutMs}.`,
    );
  }
  return {
    sessionId: input.sessionId?.trim() || `literature-session-${randomUUID()}`,
    intent: { text: input.intent.trim() },
    totalResultBudget,
    maxConcurrentTasks: maxConcurrent,
    tasks,
  };
}

function buildSearchTask(
  input: LiteratureDeepSearchSearchTaskInput,
  settings: ResearchSettings,
): LiteratureSearchSessionSearchTask {
  const query = input.query.trim();
  const limit = boundedSearchLimit(input.limit, settings);
  const mode = input.mode ?? (input.queryKind === "question" ? "specific" : input.queryKind ?? "broad");
  const legacyMode = input.queryKind === "question" ? "specific" : input.queryKind;
  if (input.mode && legacyMode && input.mode !== legacyMode) {
    throw new RigoriumToolRuntimeError("invalid_tool_input", "mode and queryKind must describe the same search mode.");
  }
  const specificity = input.specificity ?? (input.queryKind === "question"
    ? { focus: input.intent.trim() }
    : undefined);
  const semantics = buildLiteratureSearchSemantics({
    query,
    mode,
    language: input.language,
    specificity,
    queryVariants: input.queryVariants,
  }, limit);
  const queryVariants = semantics.queryVariants;
  let classifications: string[];
  try {
    classifications = normalizeArxivClassifications(input.classifications);
  } catch (error) {
    throw new RigoriumToolRuntimeError(
      "invalid_tool_input",
      "Invalid arXiv classifications: " + (error instanceof Error ? error.message : String(error)),
    );
  }
  let venueSet: SearchVenueSet | undefined;
  try {
    venueSet = normalizeVenueSet(input.venueSet);
  } catch (error) {
    throw new RigoriumToolRuntimeError(
      "invalid_tool_input",
      "Invalid venue set: " + (error instanceof Error ? error.message : String(error)),
    );
  }
  const normalizedClassifications: SearchClassification[] = classifications.length > 0
    ? [{ scheme: "arxiv", include: classifications }]
    : [];
  const fromYear = boundedSearchYear(input.fromYear, settings.literature.search.fromYear);
  const toYear = boundedSearchYear(input.toYear, settings.literature.search.toYear);
  if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) {
    throw new RigoriumToolRuntimeError("invalid_tool_input", "fromYear cannot be after toYear.");
  }
  return {
    id: input.id.trim(),
    kind: "search",
    queryKind: semantics.mode,
    intent: { text: input.intent.trim() },
    ...(input.stageId?.trim() ? { stageId: input.stageId.trim() } : {}),
    ...(input.dependsOn ? { dependsOn: input.dependsOn.map((dependency) => dependency.trim()) } : {}),
    plan: {
      query,
      mode: semantics.mode,
      ...(semantics.specificity ? { specificity: semantics.specificity } : {}),
      limit,
      ...(fromYear !== undefined ? { fromYear } : {}),
      ...(toYear !== undefined ? { toYear } : {}),
      sort: input.sort ?? settings.literature.search.sort,
      ...(normalizedClassifications.length > 0 ? { classifications: normalizedClassifications } : {}),
      ...(venueSet ? { venueSet } : {}),
      sourceIds: sourceIdsForSearch(settings, classifications, venueSet),
      queryVariants,
    },
  };
}

function buildExpansionTask(
  input: LiteratureDeepSearchExpansionTaskInput,
  settings: ResearchSettings,
): LiteratureSearchSessionExpansionTask {
  const seed = normalizeSeed(input.seed);
  const directions = normalizeDirections(input.directions);
  return {
    id: input.id.trim(),
    kind: "expansion",
    intent: { text: input.intent.trim() },
    ...(input.stageId?.trim() ? { stageId: input.stageId.trim() } : {}),
    ...(input.dependsOn ? { dependsOn: input.dependsOn.map((dependency) => dependency.trim()) } : {}),
    plan: {
      seed,
      directions,
      limitPerDirection: boundedSearchLimit(input.limitPerDirection, settings),
      sourceIds: ["openalex"],
    },
  };
}

function searchInputFromPlan(plan: SearchPlan): LiteratureSearchInput {
  const alternatives = plan.queryVariants?.slice(1).map((variant) => ({
    query: variant.query,
    ...(variant.language?.source === "declared" ? { language: variant.language.tag } : {}),
    ...(variant.category && variant.category !== "primary" ? { category: variant.category } : {}),
    ...(variant.rationale ? { rationale: variant.rationale } : {}),
    ...(variant.provenance ? { provenance: variant.provenance } : {}),
  }));
  return {
    query: plan.query,
    ...(plan.mode ? { mode: plan.mode } : {}),
    ...(plan.queryVariants?.[0]?.language?.source === "declared"
      ? { language: plan.queryVariants[0].language.tag }
      : {}),
    ...(plan.specificity ? { specificity: plan.specificity } : {}),
    ...(alternatives && alternatives.length > 0 ? { queryVariants: alternatives } : {}),
    limit: plan.limit,
    ...(plan.fromYear !== undefined ? { fromYear: plan.fromYear } : {}),
    ...(plan.toYear !== undefined ? { toYear: plan.toYear } : {}),
    sort: plan.sort,
    ...(plan.classifications ? { classifications: plan.classifications } : {}),
    ...(plan.venueSet ? { venueSet: plan.venueSet } : {}),
  };
}

function expansionInputFromPlan(plan: LiteratureExpansionPlan): LiteratureExpandInput {
  return {
    seed: plan.seed,
    directions: [...plan.directions],
    limitPerDirection: plan.limitPerDirection,
  };
}

function childContext(
  context: RigoriumToolRuntimeContext,
  signal: AbortSignal | undefined,
  now: () => Date,
): RigoriumToolRuntimeContext {
  return {
    ...context,
    ...(signal ? { abortSignal: signal } : { abortSignal: undefined }),
    now,
  };
}

function requireArtifact<T extends { kind: string }>(value: unknown, kind: T["kind"]): T {
  if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== kind) {
    throw new Error(`Literature adapter did not return a ${kind} artifact.`);
  }
  return value as T;
}

function formatToolOutput(
  session: LiteratureSearchSessionResult,
  details: { timeoutMs: number; timedOut: boolean },
): RigoriumToolExecutionOutput<LiteratureDeepSearchArtifact> {
  const artifact: LiteratureDeepSearchArtifact = {
    ...session,
    execution: details,
  };
  const lines = [
    `Deep literature search session: ${artifact.intent.text}`,
    `Session: ${artifact.sessionId}`,
    `Status: ${artifact.status} (${artifact.stopReason})`,
    `Tasks: ${artifact.tasks.length}; successful ${artifact.coverage.successfulTaskIds.length}; failed ${artifact.coverage.failedTaskIds.length}; excluded ${artifact.coverage.excludedTaskIds.length}; cancelled ${artifact.coverage.cancelledTaskIds.length}`,
    `Budget: ${artifact.budget.allocatedResultSlots}/${artifact.budget.totalResultBudget} result slots; max concurrency ${artifact.budget.maxConcurrentTasks}`,
    `Timeout: ${details.timeoutMs}ms${details.timedOut ? " (reached)" : ""}`,
    `Results: ${artifact.coverage.resultCount}`,
  ];
  if (artifact.coverage.warnings.length > 0) {
    lines.push(`Coverage warning: ${artifact.coverage.warnings.join(" ")}`);
  }
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "json", value: artifact },
    ],
    data: artifact,
    metadata: {
      sessionId: artifact.sessionId,
      status: artifact.status,
      stopReason: artifact.stopReason,
      resultCount: artifact.coverage.resultCount,
      taskCount: artifact.tasks.length,
      timeoutMs: details.timeoutMs,
      timedOut: details.timedOut,
    },
  };
}

function createRunControl(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timeoutMs: number;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let didTimeout = false;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error(`Literature search session timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timeoutMs,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function validateDeepSearchInput(
  value: unknown,
  limits: DeepSearchValidationLimits = {
    maxTotalResultBudget: MAX_TOTAL_RESULT_BUDGET,
    maxConcurrentTasks: MAX_MAX_CONCURRENT_TASKS,
    maxTimeoutMs: MAX_TIMEOUT_MS,
  },
): RigoriumToolValidationIssue[] {
  const issues: RigoriumToolValidationIssue[] = [];
  if (!isRecord(value)) {
    return [{ path: "$", code: "invalid_type", message: "must be an object." }];
  }
  if (!nonEmptyString(value.intent)) issues.push(issue("$.intent", "must be non-empty text."));
  if (value.sessionId !== undefined && !nonEmptyString(value.sessionId)) {
    issues.push(issue("$.sessionId", "must be non-empty text when provided."));
  }
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > MAX_TASKS) {
    issues.push(issue("$.tasks", `must contain between 1 and ${MAX_TASKS} tasks.`));
  }
  if (value.totalResultBudget !== undefined && !integerInRange(value.totalResultBudget, 0, limits.maxTotalResultBudget)) {
    issues.push(issue("$.totalResultBudget", `must be an integer between 0 and ${limits.maxTotalResultBudget}.`));
  }
  if (value.maxConcurrentTasks !== undefined && !integerInRange(value.maxConcurrentTasks, 1, limits.maxConcurrentTasks)) {
    issues.push(issue("$.maxConcurrentTasks", `must be an integer between 1 and ${limits.maxConcurrentTasks}.`));
  }
  if (value.timeoutMs !== undefined && !integerInRange(value.timeoutMs, 1, limits.maxTimeoutMs)) {
    issues.push(issue("$.timeoutMs", `must be an integer between 1 and ${limits.maxTimeoutMs}.`));
  }
  if (!Array.isArray(value.tasks)) return issues;
  const ids = new Set<string>();
  const graphTasks: DeepSearchInputGraphTask[] = [];
  value.tasks.forEach((rawTask, index) => {
    const path = `$.tasks[${index}]`;
    if (!isRecord(rawTask)) {
      issues.push(issue(path, "must be an object."));
      return;
    }
    const id = typeof rawTask.id === "string" ? rawTask.id.trim() : "";
    let hasUniqueId = false;
    if (!id) issues.push(issue(`${path}.id`, "must be non-empty text."));
    else if (ids.has(id)) issues.push(issue(`${path}.id`, `duplicates task ID '${id}'.`));
    else {
      ids.add(id);
      hasUniqueId = true;
    }
    if (rawTask.kind !== "search" && rawTask.kind !== "expansion") {
      issues.push(issue(`${path}.kind`, "must be search or expansion."));
    }
    if (!nonEmptyString(rawTask.intent)) issues.push(issue(`${path}.intent`, "must be non-empty text."));
    if (rawTask.stageId !== undefined && !nonEmptyString(rawTask.stageId)) {
      issues.push(issue(`${path}.stageId`, "must be non-empty text when provided."));
    }
    const dependencies: Array<{ id: string; path: string }> = [];
    if (rawTask.dependsOn !== undefined) {
      if (!Array.isArray(rawTask.dependsOn) || rawTask.dependsOn.some((dependency) => !nonEmptyString(dependency))) {
        issues.push(issue(`${path}.dependsOn`, "must be an array of non-empty task IDs."));
      } else if (rawTask.dependsOn.length > MAX_TASKS) {
        issues.push(issue(`${path}.dependsOn`, `must contain at most ${MAX_TASKS} task IDs.`));
      } else {
        const seenDependencies = new Set<string>();
        rawTask.dependsOn.forEach((rawDependency, dependencyIndex) => {
          const dependency = rawDependency.trim();
          const dependencyPath = `${path}.dependsOn[${dependencyIndex}]`;
          if (dependency === id) {
            issues.push(issue(dependencyPath, "cannot depend on its own task ID."));
          }
          if (seenDependencies.has(dependency)) {
            issues.push(issue(dependencyPath, `repeats dependency '${dependency}'.`));
            return;
          }
          seenDependencies.add(dependency);
          dependencies.push({ id: dependency, path: dependencyPath });
        });
      }
    }
    if (rawTask.kind === "search") {
      if (!nonEmptyString(rawTask.query)) issues.push(issue(`${path}.query`, "is required and must be non-empty text."));
      if (rawTask.mode !== undefined && rawTask.mode !== "broad" && rawTask.mode !== "specific") {
        issues.push(issue(`${path}.mode`, "must be broad or specific."));
      }
      if (rawTask.queryKind !== undefined && rawTask.queryKind !== "broad" && rawTask.queryKind !== "question") {
        issues.push(issue(`${path}.queryKind`, "must be broad or question."));
      }
      const legacyMode = rawTask.queryKind === "question" ? "specific" : rawTask.queryKind;
      if (rawTask.mode && legacyMode && rawTask.mode !== legacyMode) {
        issues.push(issue(`${path}.mode`, "must agree with queryKind when both are provided."));
      }
      if (rawTask.language !== undefined && !nonEmptyString(rawTask.language)) {
        issues.push(issue(`${path}.language`, "must be non-empty text when provided."));
      }
      if (rawTask.specificity !== undefined && !isRecord(rawTask.specificity)) {
        issues.push(issue(`${path}.specificity`, "must be an object when provided."));
      }
      const effectiveMode = rawTask.mode ?? legacyMode ?? "broad";
      if (effectiveMode === "specific" && rawTask.queryKind !== "question" && rawTask.specificity === undefined) {
        issues.push(issue(`${path}.specificity`, "is required for specific mode."));
      }
      if (effectiveMode === "broad" && rawTask.specificity !== undefined) {
        issues.push(issue(`${path}.specificity`, "is not allowed for broad mode."));
      }
      if (rawTask.limit !== undefined && !finitePositiveNumber(rawTask.limit)) {
        issues.push(issue(`${path}.limit`, "must be a positive finite number."));
      }
      if (rawTask.fromYear !== undefined && !finiteNumber(rawTask.fromYear)) {
        issues.push(issue(`${path}.fromYear`, "must be a finite number."));
      }
      if (rawTask.toYear !== undefined && !finiteNumber(rawTask.toYear)) {
        issues.push(issue(`${path}.toYear`, "must be a finite number."));
      }
      if (rawTask.sort !== undefined && !["relevance", "cited_by_count", "publication_date"].includes(rawTask.sort as string)) {
        issues.push(issue(`${path}.sort`, "must be relevance, cited_by_count, or publication_date."));
      }
    }
    if (rawTask.kind === "expansion") {
      if (!isRecord(rawTask.seed)) issues.push(issue(`${path}.seed`, "is required and must be an object."));
      else if (!nonEmptyString(rawTask.seed.openAlexId) && !nonEmptyString(rawTask.seed.doi)) {
        issues.push(issue(`${path}.seed`, "requires a non-empty openAlexId or doi."));
      }
      if (rawTask.limitPerDirection !== undefined && !finitePositiveNumber(rawTask.limitPerDirection)) {
        issues.push(issue(`${path}.limitPerDirection`, "must be a positive finite number."));
      }
      if (rawTask.directions !== undefined) {
        if (!Array.isArray(rawTask.directions) || rawTask.directions.length === 0 || rawTask.directions.some((direction) => direction !== "references" && direction !== "citations")) {
          issues.push(issue(`${path}.directions`, "must contain references and/or citations."));
        } else if (new Set(rawTask.directions).size !== rawTask.directions.length) {
          issues.push(issue(`${path}.directions`, "must not repeat expansion directions."));
        }
      }
    }
    if (hasUniqueId) graphTasks.push({ id, dependencies });
  });
  validateTaskGraph(graphTasks, ids, issues);
  return issues;
}

function validateTaskGraph(
  tasks: DeepSearchInputGraphTask[],
  taskIds: Set<string>,
  issues: RigoriumToolValidationIssue[],
): void {
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency.id)) {
        issues.push(issue(dependency.path, `references unknown task ID '${dependency.id}'.`));
      }
    }
  }

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) return;
    visiting.add(taskId);
    const task = tasksById.get(taskId);
    for (const dependency of task?.dependencies ?? []) {
      if (!tasksById.has(dependency.id) || dependency.id === taskId) continue;
      if (visiting.has(dependency.id)) {
        issues.push(issue(dependency.path, `creates a dependency cycle through '${dependency.id}'.`));
        continue;
      }
      visit(dependency.id);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
}

function issue(path: string, message: string): RigoriumToolValidationIssue {
  return { path, code: "invalid_schema", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finitePositiveNumber(value: unknown): value is number {
  return finiteNumber(value) && value > 0;
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function boundedSearchLimit(value: number | undefined, settings: ResearchSettings): number {
  const requested = value === undefined ? settings.literature.search.defaultLimit : Math.round(value);
  return Math.max(1, Math.min(settings.literature.budget.maxResultsPerSearch, requested));
}

function boundedSearchYear(value: number | undefined, fallback: number | null): number | undefined {
  const currentMax = new Date().getUTCFullYear() + 2;
  if (value === undefined) return fallback === null ? undefined : Math.max(1800, Math.min(currentMax, fallback));
  return Math.max(1800, Math.min(currentMax, Math.round(value)));
}

function sourceIdsForSearch(
  settings: ResearchSettings,
  classifications: string[],
  venueSet: SearchVenueSet | undefined,
): string[] {
  const sourceIds: string[] = [];
  if (settings.literature.sources.openalex.enabled) sourceIds.push("openalex");
  if (settings.literature.sources.arxiv.enabled || classifications.length > 0) sourceIds.push("arxiv");
  if (settings.literature.sources.crossref.enabled) sourceIds.push("crossref");
  const venueStatusRequested = venueSet?.venues.some((venue) => venue.status !== undefined) ?? false;
  const officialOpenReviewRequested = venueSet?.venues.some((venue) => Boolean(venue.openReviewVenueId)) ?? false;
  if (officialOpenReviewRequested || venueStatusRequested) sourceIds.push("openreview");
  return sourceIds;
}

function normalizeSeed(value: LiteratureExpansionSeed): LiteratureExpansionSeed {
  const openAlexId = normalizeOpenAlexWorkId(value.openAlexId);
  const doi = normalizeDoi(value.doi);
  if (value.openAlexId !== undefined && !openAlexId) {
    throw new RigoriumToolRuntimeError("invalid_tool_input", "seed.openAlexId must be an OpenAlex W identifier or canonical OpenAlex work URL.");
  }
  if (value.doi !== undefined && !doi) {
    throw new RigoriumToolRuntimeError("invalid_tool_input", "seed.doi must be a valid DOI.");
  }
  if (!openAlexId && !doi) {
    throw new RigoriumToolRuntimeError("invalid_tool_input", "Expansion tasks require seed.openAlexId or seed.doi as a valid strong identifier.");
  }
  return {
    ...(openAlexId ? { openAlexId } : {}),
    ...(doi ? { doi } : {}),
    ...(nonEmptyString(value.title) ? { title: value.title.trim().slice(0, 4_096) } : {}),
    ...(finiteNumber(value.year) ? { year: Math.round(value.year) } : {}),
    ...(Array.isArray(value.authors) ? { authors: value.authors.filter(nonEmptyString).map((author) => author.trim().slice(0, 512)).slice(0, 50) } : {}),
  };
}

function normalizeDirections(value: LiteratureExpansionDirection[] | undefined): LiteratureExpansionDirection[] {
  const directions: LiteratureExpansionDirection[] = value === undefined
    ? ["references", "citations"]
    : [...new Set(value)];
  if (directions.length === 0 || directions.some((direction) => direction !== "references" && direction !== "citations")) {
    throw new RigoriumToolRuntimeError("invalid_tool_input", "Expansion directions must contain references and/or citations.");
  }
  return directions;
}

function planTimeout(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}
