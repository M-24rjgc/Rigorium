import type { ResearchPaper, ResearchRelationEdge } from "../types.js";
import type { LiteratureMapOrigin } from "./mapMaintenance.js";
import { analyzeLiteratureMapBridges } from "./bridgeDetection.js";
import type { LiteratureBridgeAnalysis } from "./bridgeDetection.js";
import { updateProjectLiveLiteratureMap } from "./mapRepository.js";
import type { ProjectLiveLiteratureMapResult } from "./mapRepository.js";

export const DEFAULT_LITERATURE_MAP_REFRESH_CONCURRENCY = 3;

export type LiteratureMapRefreshPayload = Readonly<{
  papers?: ResearchPaper[];
  edges?: ResearchRelationEdge[];
  /** What this successful provider result can and cannot cover. */
  coverage?: string;
}>;

export type LiteratureMapRefreshProviderContext = Readonly<{
  projectRoot: string;
  mapId: string;
  signal?: AbortSignal;
  now: () => Date;
}>;

/**
 * A provider is deliberately read-only. It can return discovered papers and
 * relationships, but cannot request Zotero writes, tombstones, or node state.
 */
export type LiteratureMapRefreshProvider = Readonly<{
  id: string;
  /** Retained even when the provider fails before it can return a payload. */
  coverage?: string;
  /** A caller-defined relative request-cost used by maxCost. Defaults to 1. */
  cost?: number;
  refresh: (context: LiteratureMapRefreshProviderContext) => Promise<LiteratureMapRefreshPayload>;
}>;

export type LiteratureMapRefreshBudget = Readonly<{
  /** Limits provider invocations in input order. */
  maxProviderCalls?: number;
  /** Limits the sum of provider costs in input order. */
  maxCost?: number;
}>;

export type LiteratureMapRefreshSourceState = "succeeded" | "failed" | "cancelled" | "skipped";

/** An auditable outcome for one configured provider. */
export type LiteratureMapRefreshSourceAudit = Readonly<{
  sourceId: string;
  state: LiteratureMapRefreshSourceState;
  coverage: string;
  cost: number;
  startedAt?: string;
  completedAt: string;
  paperCount?: number;
  edgeCount?: number;
  error?: string;
  reason?: "budget_exhausted" | "cancelled";
}>;

export type LiteratureMapRefreshResult = Readonly<{
  cancelled: boolean;
  /** Ordered by configured provider, including skipped and cancelled sources. */
  sources: LiteratureMapRefreshSourceAudit[];
  budget: Readonly<{
    maxProviderCalls?: number;
    maxCost?: number;
    scheduledProviderCalls: number;
    scheduledCost: number;
  }>;
  candidateReview: LiteratureMapCandidateReview;
  /** Undefined when no successful provider returned papers or relations. */
  map?: ProjectLiveLiteratureMapResult;
  /** Computed only from the committed live-map revision. */
  bridgeAnalysis?: LiteratureBridgeAnalysis;
}>;

export type LiteratureMapCandidateReview = Readonly<{
  reviewRequired: boolean;
  newCandidatePaperIds: readonly string[];
  pendingCandidatePaperIds: readonly string[];
  updatedExistingPaperIds: readonly string[];
  classificationPolicy: "new_nodes_candidate_existing_state_preserved";
  zoteroWritePerformed: false;
  snapshotCreated: false;
  destructiveMapChangePerformed: false;
}>;

export type RefreshProjectLiteratureMapInput = Readonly<{
  projectRoot: string;
  mapId: string;
  providers: readonly LiteratureMapRefreshProvider[];
  expectedRevision?: number;
  signal?: AbortSignal;
  maxConcurrency?: number;
  budget?: LiteratureMapRefreshBudget;
  /** Origin applied to the incremental map merge. Defaults to monitor. */
  origin?: LiteratureMapOrigin;
  /** Injectable clock keeps provider audit timestamps deterministic in tests. */
  now?: () => Date;
}>;

type ScheduledProvider = Readonly<{
  index: number;
  provider: LiteratureMapRefreshProvider;
  cost: number;
}>;

/**
 * Runs read-only provider refreshes under explicit budgets, then commits every
 * successful payload through the project's existing incremental map repository.
 * The repository merge preserves user classification and pinned coordinates.
 */
export async function refreshProjectLiteratureMap(
  input: RefreshProjectLiteratureMapInput,
): Promise<LiteratureMapRefreshResult> {
  const projectRoot = requireText(input.projectRoot, "projectRoot");
  const mapId = requireText(input.mapId, "mapId");
  assertExpectedRevision(input.expectedRevision);
  const providers = normalizeProviders(input.providers);
  const maxConcurrency = requirePositiveInteger(
    input.maxConcurrency ?? DEFAULT_LITERATURE_MAP_REFRESH_CONCURRENCY,
    "maxConcurrency",
  );
  const budget = normalizeBudget(input.budget);
  const now = input.now ?? (() => new Date());
  const audits: Array<LiteratureMapRefreshSourceAudit | undefined> = Array.from({ length: providers.length });
  const payloads: Array<LiteratureMapRefreshPayload | undefined> = Array.from({ length: providers.length });
  const scheduled: ScheduledProvider[] = [];
  let scheduledCost = 0;

  for (const [index, provider] of providers.entries()) {
    const cost = providerCost(provider);
    const exceedsCallBudget = budget.maxProviderCalls !== undefined
      && scheduled.length >= budget.maxProviderCalls;
    const exceedsCostBudget = budget.maxCost !== undefined && scheduledCost + cost > budget.maxCost;
    if (exceedsCallBudget || exceedsCostBudget) {
      audits[index] = skippedAudit(provider, cost, now().toISOString());
      continue;
    }
    scheduled.push({ index, provider, cost });
    scheduledCost += cost;
  }

  if (!input.signal?.aborted && scheduled.length > 0) {
    const queue = [...scheduled];
    const workerCount = Math.min(maxConcurrency, scheduled.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (!input.signal?.aborted) {
        const scheduledProvider = queue.shift();
        if (!scheduledProvider) return;
        if (input.signal?.aborted) {
          queue.unshift(scheduledProvider);
          return;
        }
        const outcome = await refreshProvider(scheduledProvider, projectRoot, mapId, input.signal, now);
        audits[scheduledProvider.index] = outcome.audit;
        payloads[scheduledProvider.index] = outcome.payload;
      }
    }));
  }

  for (const scheduledProvider of scheduled) {
    if (audits[scheduledProvider.index]) continue;
    audits[scheduledProvider.index] = cancelledAudit(scheduledProvider.provider, scheduledProvider.cost, now().toISOString());
  }

  const sources = audits.map((audit, index) => {
    if (audit) return audit;
    const provider = providers[index];
    if (!provider) throw new Error(`Refresh provider at index ${index} is missing.`);
    return cancelledAudit(provider, providerCost(provider), now().toISOString());
  });
  const successfulPayloads = payloads.filter((payload): payload is LiteratureMapRefreshPayload => Boolean(payload));
  const actionablePayloads = successfulPayloads.filter(hasMapRecords);
  const map = actionablePayloads.length === 0
    ? undefined
    : await updateProjectLiveLiteratureMap({
      projectRoot,
      mapId,
      update: {
        origin: input.origin ?? "monitor",
        papers: actionablePayloads.flatMap((payload) => payload.papers ?? []),
        edges: actionablePayloads.flatMap((payload) => payload.edges ?? []),
      },
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      now: now(),
    });

  return {
    cancelled: input.signal?.aborted === true,
    sources,
    budget: {
      ...(budget.maxProviderCalls === undefined ? {} : { maxProviderCalls: budget.maxProviderCalls }),
      ...(budget.maxCost === undefined ? {} : { maxCost: budget.maxCost }),
      scheduledProviderCalls: scheduled.length,
      scheduledCost,
    },
    candidateReview: candidateReviewFor(map),
    ...(map ? { map } : {}),
    ...(map ? { bridgeAnalysis: analyzeLiteratureMapBridges(map.map) } : {}),
  };
}

async function refreshProvider(
  scheduled: ScheduledProvider,
  projectRoot: string,
  mapId: string,
  signal: AbortSignal | undefined,
  now: () => Date,
): Promise<{ audit: LiteratureMapRefreshSourceAudit; payload?: LiteratureMapRefreshPayload }> {
  const startedAt = now().toISOString();
  try {
    const payload = normalizePayload(await scheduled.provider.refresh({
      projectRoot,
      mapId,
      ...(signal ? { signal } : {}),
      now,
    }));
    const completedAt = now().toISOString();
    return {
      audit: {
        sourceId: scheduled.provider.id,
        state: "succeeded",
        coverage: payload.coverage ?? providerCoverage(scheduled.provider),
        cost: scheduled.cost,
        startedAt,
        completedAt,
        paperCount: payload.papers?.length ?? 0,
        edgeCount: payload.edges?.length ?? 0,
      },
      payload,
    };
  } catch (error) {
    const completedAt = now().toISOString();
    if (signal?.aborted) {
      return { audit: cancelledAudit(scheduled.provider, scheduled.cost, completedAt, startedAt) };
    }
    return {
      audit: {
        sourceId: scheduled.provider.id,
        state: "failed",
        coverage: providerCoverage(scheduled.provider),
        cost: scheduled.cost,
        startedAt,
        completedAt,
        error: errorMessage(error),
      },
    };
  }
}

function normalizeProviders(value: readonly LiteratureMapRefreshProvider[]): LiteratureMapRefreshProvider[] {
  if (!Array.isArray(value)) throw new TypeError("providers must be an array.");
  const ids = new Set<string>();
  return value.map((provider, index) => {
    if (!provider || typeof provider !== "object" || typeof provider.refresh !== "function") {
      throw new TypeError(`providers[${index}] must declare a refresh function.`);
    }
    const id = requireText(provider.id, `providers[${index}].id`);
    if (ids.has(id)) throw new TypeError(`providers must not repeat source ID ${id}.`);
    ids.add(id);
    return { ...provider, id };
  });
}

function normalizeBudget(value: LiteratureMapRefreshBudget | undefined): LiteratureMapRefreshBudget {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("budget must be an object when supplied.");
  }
  const maxProviderCalls = value.maxProviderCalls;
  const maxCost = value.maxCost;
  if (maxProviderCalls !== undefined && (!Number.isSafeInteger(maxProviderCalls) || maxProviderCalls < 0)) {
    throw new TypeError("budget.maxProviderCalls must be a non-negative integer.");
  }
  if (maxCost !== undefined && (!Number.isFinite(maxCost) || maxCost < 0)) {
    throw new TypeError("budget.maxCost must be a non-negative finite number.");
  }
  return {
    ...(maxProviderCalls === undefined ? {} : { maxProviderCalls }),
    ...(maxCost === undefined ? {} : { maxCost }),
  };
}

function normalizePayload(value: LiteratureMapRefreshPayload): LiteratureMapRefreshPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A refresh provider must return an object payload.");
  }
  const allowedKeys = new Set(["papers", "edges", "coverage"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`A read-only refresh provider payload does not allow ${key}.`);
    }
  }
  if (value.papers !== undefined && !Array.isArray(value.papers)) {
    throw new TypeError("A refresh provider payload papers field must be an array.");
  }
  if (value.edges !== undefined && !Array.isArray(value.edges)) {
    throw new TypeError("A refresh provider payload edges field must be an array.");
  }
  if (value.coverage !== undefined && (typeof value.coverage !== "string" || !value.coverage.trim())) {
    throw new TypeError("A refresh provider payload coverage field must be a non-empty string.");
  }
  return value;
}

function hasMapRecords(payload: LiteratureMapRefreshPayload): boolean {
  return (payload.papers?.length ?? 0) > 0 || (payload.edges?.length ?? 0) > 0;
}

function candidateReviewFor(map: ProjectLiveLiteratureMapResult | undefined): LiteratureMapCandidateReview {
  const pendingCandidatePaperIds = map
    ? map.map.nodes
      .filter((node) => !node.tombstone
        && node.status === "candidate"
        && (node.origins.includes("monitor") || map.diff.nodes.added.includes(node.id)))
      .map((node) => node.id)
      .sort(compareText)
    : [];
  const newCandidatePaperIds = map
    ? map.diff.nodes.added
      .filter((paperId) => map.map.nodes.some((node) => node.id === paperId && node.status === "candidate"))
      .sort(compareText)
    : [];
  return {
    reviewRequired: pendingCandidatePaperIds.length > 0,
    newCandidatePaperIds,
    pendingCandidatePaperIds,
    updatedExistingPaperIds: map ? [...map.diff.nodes.updated].sort(compareText) : [],
    classificationPolicy: "new_nodes_candidate_existing_state_preserved",
    zoteroWritePerformed: false,
    snapshotCreated: false,
    destructiveMapChangePerformed: false,
  };
}

function providerCost(provider: LiteratureMapRefreshProvider): number {
  const cost = provider.cost ?? 1;
  if (!Number.isFinite(cost) || cost < 0) {
    throw new TypeError(`Provider ${provider.id} cost must be a non-negative finite number.`);
  }
  return cost;
}

function providerCoverage(provider: LiteratureMapRefreshProvider): string {
  const coverage = typeof provider.coverage === "string" ? provider.coverage.trim() : undefined;
  return coverage || `Provider ${provider.id} did not declare its coverage.`;
}

function skippedAudit(provider: LiteratureMapRefreshProvider, cost: number, completedAt: string): LiteratureMapRefreshSourceAudit {
  return {
    sourceId: provider.id,
    state: "skipped",
    coverage: providerCoverage(provider),
    cost,
    completedAt,
    reason: "budget_exhausted",
  };
}

function cancelledAudit(
  provider: LiteratureMapRefreshProvider,
  cost: number,
  completedAt: string,
  startedAt?: string,
): LiteratureMapRefreshSourceAudit {
  return {
    sourceId: provider.id,
    state: "cancelled",
    coverage: providerCoverage(provider),
    cost,
    ...(startedAt ? { startedAt } : {}),
    completedAt,
    reason: "cancelled",
  };
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 4_096 || value.includes("\u0000")) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function assertExpectedRevision(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("expectedRevision must be a non-negative integer.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}
