import type { PermissionResult } from "../../permission/index.js";
import {
  createMaintenanceProviderFromPayload,
  createZoteroMaintenanceProvider,
  runProjectLiteratureMaintenance,
  type LiteratureMaintenanceProvider,
  type LiteratureMaintenanceResult,
  type LiteratureMaintenanceTrigger,
} from "../../research/literature/maintenance.js";
import { createZoteroLibraryProvider } from "../../research/library/zoteroProvider.js";
import { readResearchSettings } from "../../research/settings.js";
import type { LiteratureSearchArtifact, ResearchPaper, ResearchRelationEdge } from "../../research/types.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";
import {
  createLiteratureSearchTool,
  type CreateLiteratureSearchToolOptions,
} from "./literatureSearch.js";

const MAX_SOURCES = 32;
const MAX_PAPERS = 2_000;
const MAX_EDGES = 10_000;

export type LiteratureMapMaintenanceSourceInput = Readonly<{
  id: string;
  papers?: ResearchPaper[];
  edges?: ResearchRelationEdge[];
  coverage?: string;
  cost?: number;
  error?: string;
}>;

export type LiteratureMapMaintenanceInput = Readonly<{
  projectRoot: string;
  mapId: string;
  trigger: LiteratureMaintenanceTrigger;
  intent?: string;
  query?: string;
  sources?: readonly LiteratureMapMaintenanceSourceInput[];
  zoteroCollectionKey?: string;
  expectedRevision?: number;
  maxConcurrency?: number;
  budget?: { maxProviderCalls?: number; maxCost?: number };
}>;

export type CreateLiteratureMapMaintenanceToolOptions = Readonly<{
  search?: CreateLiteratureSearchToolOptions;
  maxResultBytes?: number;
}>;

/**
 * Agent-facing bridge for automatic map maintenance. It accepts either
 * already-retrieved source payloads or a natural-language query, then stores
 * only map candidates and an auditable source/failure log. Zotero writes,
 * frozen snapshots, classifications, and tombstones remain outside this tool.
 */
export function createLiteratureMapMaintenanceTool(
  options: CreateLiteratureMapMaintenanceToolOptions = {},
): RigoriumToolDefinition<LiteratureMapMaintenanceInput, LiteratureMaintenanceResult> {
  const searchTool = createLiteratureSearchTool(options.search);
  return {
    name: "literature_map_maintenance",
    title: "Maintain Literature Map / 自动维护文献地图",
    description: `Run a bounded, auditable incremental literature-map maintenance pass.

Use this when a search result, Zotero library change, newly found paper, or natural-language research request should update the current Project's live map. New records remain candidate nodes, existing classifications and fixed positions are preserved, and source failures remain visible in the audit. This tool never writes to Zotero, never freezes a snapshot, never changes a node classification, and never applies tombstones automatically; those state changes require a separate explicit confirmation.`,
    kind: "custom",
    inputSchema: inputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 500_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: (input) => Boolean(input?.query || input?.trigger === "natural_language" || input?.trigger === "zotero_changed"),
    validateInput: async (input): Promise<RigoriumToolValidationResult> => validateInput(input),
    checkPermissions: async (input, context): Promise<PermissionResult> => {
      if (typeof input?.query === "string" && input.query.trim()) {
        return searchTool.checkPermissions?.({ query: input.query }, context)
          ?? { type: "passthrough" };
      }
      if (input?.trigger === "natural_language") {
        return searchTool.checkPermissions?.({ query: input.intent ?? "literature maintenance" }, context)
          ?? { type: "passthrough" };
      }
      return { type: "passthrough" };
    },
    execute: async (input, context) => {
      const normalized = normalizeInput(input);
      const providers: LiteratureMaintenanceProvider[] = normalized.sources?.map((source) =>
        createMaintenanceProviderFromPayload({
          id: source.id,
          coverage: source.coverage,
          cost: source.cost,
          error: source.error,
          payload: {
            ...(source.papers === undefined ? {} : { papers: source.papers }),
            ...(source.edges === undefined ? {} : { edges: source.edges }),
            ...(source.coverage === undefined ? {} : { coverage: source.coverage }),
          },
        }),
      ) ?? [];

      if (normalized.query || (normalized.trigger === "natural_language" && normalized.intent)) {
        const query = normalized.query ?? normalized.intent!;
        const output = await searchTool.execute(
          { query },
          childContext(context, normalized.projectRoot),
        );
        const artifact = requireLiteratureSearchArtifact(output.data);
        providers.unshift(createMaintenanceProviderFromPayload({
          id: `search:${artifact.artifactId}`,
          coverage: `Natural-language literature search '${artifact.plan.query}' returned ${artifact.papers.length} candidates.`,
          payload: { papers: artifact.papers, edges: artifact.edges },
        }));
      }

      if (normalized.trigger === "zotero_changed" && providers.length === 0) {
        const settingsSnapshot = await readResearchSettings({
          rigoriumHome: context.env?.RIGORIUM_HOME,
          projectRoot: normalized.projectRoot,
        });
        if (!settingsSnapshot.effective.zotero.enabled) {
          throw new RigoriumToolRuntimeError("setup_required", "Zotero is disabled in Research Settings.");
        }
        const zotero = createZoteroLibraryProvider({
          baseUrl: settingsSnapshot.effective.zotero.baseUrl,
          now: context.now,
        });
        providers.push(createZoteroMaintenanceProvider({
          provider: zotero,
          collectionKey: normalized.zoteroCollectionKey ?? settingsSnapshot.effective.zotero.collectionKey ?? undefined,
          now: context.now,
        }));
      }

      if (providers.length === 0) {
        throw new RigoriumToolRuntimeError(
          "invalid_tool_input",
          "Provide sources, a query, or trigger zotero_changed to run literature maintenance.",
        );
      }

      try {
        const result = await runProjectLiteratureMaintenance({
          projectRoot: normalized.projectRoot,
          mapId: normalized.mapId,
          trigger: normalized.trigger,
          providers,
          ...(normalized.intent ? { intent: normalized.intent } : {}),
          ...(normalized.expectedRevision === undefined ? {} : { expectedRevision: normalized.expectedRevision }),
          ...(normalized.maxConcurrency === undefined ? {} : { maxConcurrency: normalized.maxConcurrency }),
          ...(normalized.budget === undefined ? {} : { budget: normalized.budget }),
          ...(context.abortSignal ? { signal: context.abortSignal } : {}),
          now: context.now,
        });
        return formatOutput(result);
      } catch (error) {
        if (error instanceof RigoriumToolRuntimeError) throw error;
        throw new RigoriumToolRuntimeError(
          "tool_execution_failed",
          `Literature map maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

function inputSchema() {
  return {
    type: "object" as const,
    additionalProperties: false,
    required: ["projectRoot", "mapId", "trigger"],
    properties: {
      projectRoot: { type: "string", description: "Existing root directory of the current Project." },
      mapId: { type: "string", description: "Stable live literature-map ID." },
      trigger: { type: "string", enum: ["search", "zotero_changed", "new_papers", "natural_language", "manual"] },
      intent: { type: "string", maxLength: 16_000, description: "Why this maintenance pass is being requested." },
      query: { type: "string", maxLength: 4_000, description: "Natural-language literature query; executed through literature_search." },
      zoteroCollectionKey: { type: "string", maxLength: 128 },
      expectedRevision: { type: "integer", minimum: 0 },
      maxConcurrency: { type: "integer", minimum: 1, maximum: 16 },
      budget: {
        type: "object",
        additionalProperties: false,
        properties: {
          maxProviderCalls: { type: "integer", minimum: 0, maximum: MAX_SOURCES },
          maxCost: { type: "number", minimum: 0 },
        },
      },
      sources: {
        type: "array",
        maxItems: MAX_SOURCES,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string" },
            papers: { type: "array", maxItems: MAX_PAPERS },
            edges: { type: "array", maxItems: MAX_EDGES },
            coverage: { type: "string" },
            cost: { type: "number", minimum: 0 },
            error: { type: "string" },
          },
        },
      },
    },
  };
}

function validateInput(input: unknown): RigoriumToolValidationResult {
  try {
    normalizeInput(input);
    return { ok: true, input };
  } catch (error) {
    const issue: RigoriumToolValidationIssue = {
      path: "$",
      code: "invalid_schema",
      message: error instanceof Error ? error.message : String(error),
    };
    return { ok: false, issues: [issue] };
  }
}

function normalizeInput(input: unknown): LiteratureMapMaintenanceInput {
  if (!isRecord(input)) throw new Error("input must be an object.");
  const projectRoot = requiredText(input.projectRoot, "projectRoot", 4_096);
  const mapId = requiredText(input.mapId, "mapId", 4_096);
  const triggers: LiteratureMaintenanceTrigger[] = ["search", "zotero_changed", "new_papers", "natural_language", "manual"];
  if (!triggers.includes(input.trigger as LiteratureMaintenanceTrigger)) throw new Error("trigger is invalid.");
  if (input.intent !== undefined) boundedText(input.intent, "intent", 16_000);
  if (input.query !== undefined) boundedText(input.query, "query", 4_000);
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) {
    throw new Error("expectedRevision must be a non-negative integer.");
  }
  if (input.maxConcurrency !== undefined && (!Number.isSafeInteger(input.maxConcurrency) || input.maxConcurrency < 1 || input.maxConcurrency > 16)) {
    throw new Error("maxConcurrency must be an integer between 1 and 16.");
  }
  if (input.zoteroCollectionKey !== undefined) boundedText(input.zoteroCollectionKey, "zoteroCollectionKey", 128);
  const sources = normalizeSources(input.sources);
  const budget = normalizeBudget(input.budget);
  return {
    projectRoot,
    mapId,
    trigger: input.trigger as LiteratureMaintenanceTrigger,
    ...(input.intent === undefined ? {} : { intent: input.intent as string }),
    ...(input.query === undefined ? {} : { query: input.query as string }),
    ...(sources ? { sources } : {}),
    ...(input.zoteroCollectionKey === undefined ? {} : { zoteroCollectionKey: input.zoteroCollectionKey as string }),
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision as number }),
    ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency as number }),
    ...(budget ? { budget } : {}),
  };
}

function normalizeSources(value: unknown): LiteratureMapMaintenanceSourceInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SOURCES) throw new Error("sources must contain 1-32 entries.");
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`sources[${index}] must be an object.`);
    const id = requiredText(entry.id, `sources[${index}].id`, 4_096);
    if (ids.has(id)) throw new Error(`sources must not repeat source ID ${id}.`);
    ids.add(id);
    if (entry.papers !== undefined && (!Array.isArray(entry.papers) || entry.papers.length > MAX_PAPERS)) throw new Error(`sources[${index}].papers is invalid.`);
    if (entry.edges !== undefined && (!Array.isArray(entry.edges) || entry.edges.length > MAX_EDGES)) throw new Error(`sources[${index}].edges is invalid.`);
    if (entry.coverage !== undefined) boundedText(entry.coverage, `sources[${index}].coverage`, 4_096);
    if (entry.error !== undefined) boundedText(entry.error, `sources[${index}].error`, 4_096);
    if (entry.cost !== undefined && (!Number.isFinite(entry.cost) || entry.cost < 0)) throw new Error(`sources[${index}].cost is invalid.`);
    return {
      id,
      ...(entry.papers === undefined ? {} : { papers: entry.papers as ResearchPaper[] }),
      ...(entry.edges === undefined ? {} : { edges: entry.edges as ResearchRelationEdge[] }),
      ...(entry.coverage === undefined ? {} : { coverage: entry.coverage as string }),
      ...(entry.cost === undefined ? {} : { cost: entry.cost as number }),
      ...(entry.error === undefined ? {} : { error: entry.error as string }),
    };
  });
}

function normalizeBudget(value: unknown): LiteratureMapMaintenanceInput["budget"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("budget must be an object.");
  if (value.maxProviderCalls !== undefined && (!Number.isSafeInteger(value.maxProviderCalls) || value.maxProviderCalls < 0 || value.maxProviderCalls > MAX_SOURCES)) throw new Error("budget.maxProviderCalls is invalid.");
  if (value.maxCost !== undefined && (!Number.isFinite(value.maxCost) || value.maxCost < 0)) throw new Error("budget.maxCost is invalid.");
  return {
    ...(value.maxProviderCalls === undefined ? {} : { maxProviderCalls: value.maxProviderCalls as number }),
    ...(value.maxCost === undefined ? {} : { maxCost: value.maxCost as number }),
  };
}

function requireLiteratureSearchArtifact(value: unknown): LiteratureSearchArtifact {
  if (!isRecord(value) || value.kind !== "literature_search" || !Array.isArray(value.papers) || !Array.isArray(value.edges)) {
    throw new RigoriumToolRuntimeError("tool_execution_failed", "literature_search returned an invalid artifact.");
  }
  return value as unknown as LiteratureSearchArtifact;
}

function formatOutput(result: LiteratureMaintenanceResult): RigoriumToolExecutionOutput<LiteratureMaintenanceResult> {
  const states = result.refresh.sources.map((source) => `${source.sourceId} (${source.state})`).join(", ");
  const candidates = result.candidateReview.pendingCandidatePaperIds.length;
  const lines = [
    "Literature map maintenance / 文献地图自动维护",
    `Trigger / 触发: ${result.trigger}`,
    `Sources / 来源: ${states || "none / 无"}`,
    `Candidates pending review / 待审候选: ${candidates}`,
    `Map persisted / 活地图已写入: ${result.refresh.map?.persisted ? "yes / 是" : "no / 否"}`,
    `Audit / 审计: ${result.audit.path}`,
    "Zotero write / Zotero 写入: no / 否",
    "Snapshot or destructive change / 快照或破坏性变更: no / 否",
  ];
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "json", value: result },
    ],
    data: result,
    metadata: {
      trigger: result.trigger,
      candidateCount: candidates,
      sourceCount: result.refresh.sources.length,
      auditPersisted: result.audit.persisted,
    },
  };
}

function childContext(context: RigoriumToolRuntimeContext, cwd: string): RigoriumToolRuntimeContext {
  return { ...context, cwd };
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\u0000")) throw new Error(`${label} must be non-empty text.`);
  return value.trim();
}

function boundedText(value: unknown, label: string, maximum: number): string {
  return requiredText(value, label, maximum);
}

function positiveInteger(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
