import { randomUUID } from "node:crypto";
import { normalizeArxiv, normalizeDoi } from "../identity.js";
import type {
  LibraryProvider,
  ResearchPaper,
  ResearchRelationEdge,
  ZoteroLibraryItem,
} from "../types.js";
import {
  refreshProjectLiteratureMap,
  type LiteratureMapRefreshBudget,
  type LiteratureMapRefreshPayload,
  type LiteratureMapRefreshProvider,
  type LiteratureMapRefreshResult,
} from "./mapRefresh.js";
import {
  appendProjectLiteratureMaintenanceAudit,
  loadProjectLiteratureMaintenanceAudits,
  getProjectLiteratureMaintenanceAuditPath,
  type LiteratureMaintenanceAuditRecord,
} from "./maintenanceRepository.js";

export type LiteratureMaintenanceTrigger =
  | "search"
  | "zotero_changed"
  | "new_papers"
  | "natural_language"
  | "manual";

export type LiteratureMaintenanceProvider = LiteratureMapRefreshProvider;

export type LiteratureMaintenanceInput = Readonly<{
  projectRoot: string;
  mapId: string;
  trigger: LiteratureMaintenanceTrigger;
  providers: readonly LiteratureMaintenanceProvider[];
  intent?: string;
  expectedRevision?: number;
  signal?: AbortSignal;
  maxConcurrency?: number;
  budget?: LiteratureMapRefreshBudget;
  now?: () => Date;
  maxAudits?: number;
}>;

export type LiteratureMaintenanceResult = Readonly<{
  schemaVersion: 1;
  kind: "literature_map_maintenance";
  maintenanceId: string;
  createdAt: string;
  trigger: LiteratureMaintenanceTrigger;
  intent?: string;
  refresh: LiteratureMapRefreshResult;
  candidateReview: LiteratureMapRefreshResult["candidateReview"];
  safety: {
    zoteroWritePerformed: false;
    snapshotCreated: false;
    destructiveMapChangePerformed: false;
    pendingReviewRequired: boolean;
  };
  audit: {
    path: string;
    persisted: boolean;
  };
}>;

export type LiteratureMaintenanceAuditReadResult = Readonly<{
  path: string;
  audits: LiteratureMaintenanceAuditRecord[];
}>;

/**
 * Runs one bounded maintenance pass and records its complete source outcome.
 * The only state write is the project's incremental live-map file plus the
 * append-only maintenance audit. Zotero, snapshots, and user classifications
 * are never mutated by this function.
 */
export async function runProjectLiteratureMaintenance(
  input: LiteratureMaintenanceInput,
): Promise<LiteratureMaintenanceResult> {
  const projectRoot = requireText(input.projectRoot, "projectRoot");
  const mapId = requireText(input.mapId, "mapId");
  const providers = normalizeProviders(input.providers);
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const maintenanceId = `literature-maintenance-${randomUUID()}`;
  const refresh = await refreshProjectLiteratureMap({
    projectRoot,
    mapId,
    providers,
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
    ...(input.budget === undefined ? {} : { budget: input.budget }),
    now,
    origin: maintenanceOrigin(input.trigger),
  });
  const completedAt = now().toISOString();
  const sourceAudits = refresh.sources.map((source) => ({ ...source }));
  const errors = refresh.sources
    .filter((source) => source.state === "failed" && source.error)
    .map((source) => `${source.sourceId}: ${source.error}`);
  const audit: LiteratureMaintenanceAuditRecord = {
    schemaVersion: 1,
    kind: "literature_map_maintenance_audit",
    maintenanceId,
    trigger: input.trigger,
    ...(input.intent ? { intent: boundedText(input.intent, "intent", 16_000) } : {}),
    startedAt,
    completedAt,
    cancelled: refresh.cancelled,
    sourceAudits,
    candidateReview: { ...refresh.candidateReview },
    ...(refresh.map ? {
      map: {
        mapId: refresh.map.map.mapId,
        fromRevision: refresh.map.diff.fromRevision,
        toRevision: refresh.map.diff.toRevision,
        persisted: refresh.map.persisted,
      },
    } : {}),
    errors,
  };
  const persistedAudit = await appendProjectLiteratureMaintenanceAudit({
    projectRoot,
    audit,
    ...(input.maxAudits === undefined ? {} : { maxAudits: input.maxAudits }),
  });
  return {
    schemaVersion: 1,
    kind: "literature_map_maintenance",
    maintenanceId,
    createdAt: completedAt,
    trigger: input.trigger,
    ...(input.intent ? { intent: boundedText(input.intent, "intent", 16_000) } : {}),
    refresh,
    candidateReview: refresh.candidateReview,
    safety: {
      zoteroWritePerformed: false,
      snapshotCreated: false,
      destructiveMapChangePerformed: false,
      pendingReviewRequired: refresh.candidateReview.reviewRequired,
    },
    audit: { path: persistedAudit.path, persisted: persistedAudit.persisted },
  };
}

export async function readProjectLiteratureMaintenanceAudits(input: {
  projectRoot: string;
  limit?: number;
}): Promise<LiteratureMaintenanceAuditReadResult> {
  return {
    path: getProjectLiteratureMaintenanceAuditPath({ projectRoot: input.projectRoot }),
    audits: await loadProjectLiteratureMaintenanceAudits(input),
  };
}

/** Build a deterministic read-only provider from an already retrieved source result. */
export function createMaintenanceProviderFromPayload(input: {
  id: string;
  payload?: LiteratureMapRefreshPayload;
  coverage?: string;
  cost?: number;
  error?: string;
}): LiteratureMaintenanceProvider {
  const id = requireText(input.id, "provider.id");
  return {
    id,
    ...(input.coverage ? { coverage: input.coverage } : {}),
    ...(input.cost === undefined ? {} : { cost: input.cost }),
    refresh: async () => {
      if (input.error) throw new Error(input.error);
      return input.payload ?? {};
    },
  };
}

/**
 * Adapt the official Zotero Local API provider to maintenance. This adapter
 * only reads top-level library items and emits candidates; it never calls the
 * Connector import endpoint or any cloud write method.
 */
export function createZoteroMaintenanceProvider(input: {
  provider: LibraryProvider;
  collectionKey?: string;
  maxItems?: number;
  pageSize?: number;
  now?: () => Date;
}): LiteratureMaintenanceProvider {
  const maxItems = boundedInteger(input.maxItems ?? 500, 1, 2_000, "maxItems");
  const pageSize = boundedInteger(input.pageSize ?? 100, 1, 100, "pageSize");
  const now = input.now ?? (() => new Date());
  return {
    id: "zotero",
    coverage: "Zotero top-level library metadata read through the official Local API; no Zotero writes are performed.",
    refresh: async () => {
      const papers: ResearchPaper[] = [];
      let start = 0;
      let truncated = false;
      while (papers.length < maxItems) {
        const page = await input.provider.listItems({
          ...(input.collectionKey ? { collectionKey: input.collectionKey } : {}),
          limit: Math.min(pageSize, maxItems - papers.length),
          start,
        });
        const retrievedAt = now().toISOString();
        papers.push(...page.items.map((item) => zoteroItemToResearchPaper(item, retrievedAt)));
        if (page.nextStart === undefined || page.items.length === 0) break;
        start = page.nextStart;
        if (papers.length >= maxItems) truncated = true;
      }
      if (papers.length >= maxItems) truncated = true;
      return {
        papers,
        coverage: `${papers.length} Zotero items read${truncated ? ` (capped at ${maxItems}; more items may exist)` : ""}.`,
      };
    },
  };
}

export function zoteroItemToResearchPaper(item: ZoteroLibraryItem, retrievedAt: string): ResearchPaper {
  const doi = normalizeDoi(item.doi ?? item.identity.doi);
  const arxiv = normalizeArxiv(item.arxiv ?? item.identity.arxiv ?? item.identity.other?.arxiv);
  const identity = {
    ...item.identity,
    zoteroKey: item.key,
    ...(doi ? { doi } : {}),
    ...(arxiv ? { arxiv } : {}),
  };
  return {
    id: `zotero:${item.key}`,
    identity,
    title: item.title || `Zotero item ${item.key}`,
    authors: [...item.creators],
    ...(item.year === undefined ? {} : { year: item.year }),
    ...(doi ? { doi } : {}),
    ...(item.url ? { url: item.url } : {}),
    citedByCount: 0,
    topics: [],
    referencedWorkIds: [],
    sourceId: "zotero",
    sourceIds: ["zotero"],
    provenance: [{
      sourceId: "zotero",
      sourceRecordId: item.key,
      rank: 1,
      retrievedAt,
    }],
  };
}

function normalizeProviders(value: readonly LiteratureMaintenanceProvider[]): LiteratureMaintenanceProvider[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("providers must contain at least one source.");
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

function maintenanceOrigin(trigger: LiteratureMaintenanceTrigger): "search" | "zotero" | "monitor" {
  if (trigger === "search") return "search";
  if (trigger === "zotero_changed") return "zotero";
  return "monitor";
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\u0000") || value.length > 4_096) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || normalized.includes("\u0000")) {
    throw new TypeError(`${label} must be non-empty text within ${maximum} characters.`);
  }
  return normalized;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
