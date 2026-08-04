import { authenticatedFetch } from '../utils/api';
import type { ResearchPaper, ResearchRelationEdge } from './types';

const LITERATURE_MAP_API = '/api/research/literature-map';

export type ProjectLiteratureMapNodeStatus = 'candidate' | 'relevant' | 'core' | 'irrelevant' | 'excluded';

export type ProjectLiteratureMapNode = {
  id: string;
  aliases: string[];
  status: ProjectLiteratureMapNodeStatus;
  position: { x: number; y: number; pinned: boolean };
};

export type ProjectLiteratureMap = {
  mapId: string;
  revision: number;
  nodes: ProjectLiteratureMapNode[];
};

export type ProjectLiteratureMapUpdate = {
  origin: 'search' | 'zotero' | 'monitor';
  papers?: ResearchPaper[];
  edges?: ResearchRelationEdge[];
  tombstonePaperIds?: string[];
  restorePaperIds?: string[];
};

export type ProjectLiteratureMapReadResult = {
  map: ProjectLiteratureMap | null;
  lastDiff: unknown | null;
  seedPaperId: string | null;
};

export type ProjectLiteratureMapMutationResult = {
  map: ProjectLiteratureMap;
  seedPaperId: string | null;
  persisted?: boolean;
  created?: boolean;
};

export type LiteratureMapMaintenanceTrigger = 'search' | 'zotero_changed' | 'new_papers' | 'natural_language' | 'manual';

export type LiteratureMapMaintenanceSource = {
  id: string;
  papers?: ResearchPaper[];
  edges?: ResearchRelationEdge[];
  coverage?: string;
  cost?: number;
  error?: string;
};

export type LiteratureMapMaintenanceResult = {
  maintenanceId: string;
  trigger: LiteratureMapMaintenanceTrigger;
  candidateReview: {
    reviewRequired: boolean;
    newCandidatePaperIds: string[];
    pendingCandidatePaperIds: string[];
    updatedExistingPaperIds: string[];
    zoteroWritePerformed: false;
    snapshotCreated: false;
    destructiveMapChangePerformed: false;
  };
  safety: {
    zoteroWritePerformed: false;
    snapshotCreated: false;
    destructiveMapChangePerformed: false;
    pendingReviewRequired: boolean;
  };
  sources: Array<{
    sourceId: string;
    state: 'succeeded' | 'failed' | 'cancelled' | 'skipped';
    coverage: string;
    error?: string;
    reason?: string;
    paperCount?: number;
    edgeCount?: number;
  }>;
  map: ProjectLiteratureMap | null;
  diff: unknown | null;
  audit: { path: string; persisted: boolean };
  persisted?: boolean;
  created?: boolean;
};

export type LiteratureMapMaintenanceAudit = {
  maintenanceId: string;
  trigger: LiteratureMapMaintenanceTrigger;
  startedAt: string;
  completedAt: string;
  cancelled: boolean;
  sourceAudits: Array<Record<string, unknown>>;
  candidateReview: Record<string, unknown>;
  errors: string[];
};

export async function loadProjectLiteratureMap(projectPath: string): Promise<ProjectLiteratureMapReadResult> {
  const params = new URLSearchParams({ projectPath: requireProjectPath(projectPath) });
  return requestJson<ProjectLiteratureMapReadResult>(`${LITERATURE_MAP_API}?${params}`);
}

export async function updateProjectLiteratureMap(
  projectPath: string,
  mapId: string,
  update: ProjectLiteratureMapUpdate,
  options: { expectedRevision?: number } = {},
): Promise<ProjectLiteratureMapMutationResult> {
  return requestJson<ProjectLiteratureMapMutationResult>(`${LITERATURE_MAP_API}/update`, {
    method: 'POST',
    body: JSON.stringify({
      projectPath: requireProjectPath(projectPath),
      mapId: requireIdentifier(mapId, 'mapId'),
      update: normalizeMapUpdate(update),
      ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
    }),
  });
}

export async function setProjectLiteratureMapNodeState(
  projectPath: string,
  mapId: string,
  paperId: string,
  state: {
    status?: ProjectLiteratureMapNodeStatus;
    position?: { x: number; y: number; pinned: boolean };
  },
  options: { expectedRevision?: number } = {},
): Promise<ProjectLiteratureMapMutationResult> {
  return requestJson<ProjectLiteratureMapMutationResult>(
    `${LITERATURE_MAP_API}/nodes/${encodeURIComponent(requireIdentifier(paperId, 'paperId'))}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        projectPath: requireProjectPath(projectPath),
        mapId: requireIdentifier(mapId, 'mapId'),
        state,
        ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
      }),
    },
  );
}

export async function setProjectLiteratureMapSeed(
  projectPath: string,
  mapId: string,
  seedPaperId: string | null,
): Promise<ProjectLiteratureMapMutationResult> {
  return requestJson<ProjectLiteratureMapMutationResult>(`${LITERATURE_MAP_API}/seed`, {
    method: 'PUT',
    body: JSON.stringify({
      projectPath: requireProjectPath(projectPath),
      mapId: requireIdentifier(mapId, 'mapId'),
      seedPaperId: seedPaperId === null ? null : requireIdentifier(seedPaperId, 'seedPaperId'),
    }),
  });
}

export async function runProjectLiteratureMapMaintenance(
  projectPath: string,
  mapId: string,
  trigger: LiteratureMapMaintenanceTrigger,
  options: {
    intent?: string;
    query?: string;
    sources?: LiteratureMapMaintenanceSource[];
    zoteroCollectionKey?: string;
    expectedRevision?: number;
    maxConcurrency?: number;
    budget?: { maxProviderCalls?: number; maxCost?: number };
  } = {},
): Promise<LiteratureMapMaintenanceResult> {
  return requestJson<LiteratureMapMaintenanceResult>('/api/research/literature-map/maintenance', {
    method: 'POST',
    body: JSON.stringify({
      projectPath: requireProjectPath(projectPath),
      mapId: requireIdentifier(mapId, 'mapId'),
      trigger,
      ...(options.intent === undefined ? {} : { intent: options.intent }),
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.sources === undefined ? {} : { sources: options.sources }),
      ...(options.zoteroCollectionKey === undefined ? {} : { zoteroCollectionKey: options.zoteroCollectionKey }),
      ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
      ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    }),
  });
}

export async function loadProjectLiteratureMapMaintenanceAudits(
  projectPath: string,
  limit?: number,
): Promise<{ path: string; audits: LiteratureMapMaintenanceAudit[] }> {
  const params = new URLSearchParams({ projectPath: requireProjectPath(projectPath) });
  if (limit !== undefined) params.set('limit', String(limit));
  return requestJson<{ path: string; audits: LiteratureMapMaintenanceAudit[] }>(
    `/api/research/literature-map/maintenance/audit?${params}`,
  );
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, { ...init, suppressServerErrorToast: true });
  const body = await response.json().catch(() => null) as { error?: unknown } | T | null;
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : 'Literature map request failed.';
    throw new Error(message);
  }
  if (!body || typeof body !== 'object') throw new Error('Literature map returned an invalid response.');
  return body as T;
}

function requireProjectPath(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A project path is required for a literature map.');
  return value.trim();
}

function requireIdentifier(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function normalizeMapUpdate(update: ProjectLiteratureMapUpdate): ProjectLiteratureMapUpdate {
  if (!update.papers) return update;
  return {
    ...update,
    papers: update.papers.map((paper) => ({
      ...paper,
      identity: normalizePaperIdentity(paper.identity),
      referencedWorkIds: Array.isArray(paper.referencedWorkIds) ? [...paper.referencedWorkIds] : [],
      sourceIds: paper.sourceIds && paper.sourceIds.length > 0 ? [...paper.sourceIds] : [paper.sourceId],
      provenance: (paper.provenance ?? []).map((entry, index) => ({
        ...entry,
        rank: validProvenanceRank(entry.rank) ? entry.rank : index + 1,
      })),
    })),
  };
}

function normalizePaperIdentity(identity: ResearchPaper['identity']): NonNullable<ResearchPaper['identity']> {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return {};
  return identity;
}

function validProvenanceRank(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
