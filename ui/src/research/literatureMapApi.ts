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
  return Number.isSafeInteger(value) && value >= 1;
}
