export type ResearchSettings = {
  schemaVersion: 1;
  literature: {
    enabled: boolean;
    sources: { openalex: { enabled: boolean; mailto: string } };
    search: {
      defaultLimit: number;
      fromYear: number | null;
      toYear: number | null;
      sort: 'relevance' | 'cited_by_count' | 'publication_date';
    };
    budget: { maxResultsPerSearch: number; requestTimeoutMs: number };
    map: { autoOpen: boolean; autoUpdate: boolean; showTopicEdges: boolean };
  };
  zotero: { enabled: boolean; baseUrl: string; useSelectedCollection: boolean };
  citation: { style: 'apa' | 'chicago-author-date' | 'ieee' | 'mla'; includeDoi: boolean };
  privacy: { allowRemoteMetadataSearch: boolean; allowRemoteFullText: boolean };
};

export type ResearchTopic = { id: string; name: string; score?: number };

export type ResearchPaper = {
  id: string;
  identity?: Record<string, unknown>;
  title: string;
  authors: string[];
  year?: number;
  publicationDate?: string;
  type?: string;
  venue?: string;
  doi?: string;
  url?: string;
  citedByCount: number;
  isOpenAccess?: boolean;
  abstract?: string;
  topics: ResearchTopic[];
  referencedWorkIds?: string[];
  sourceId: string;
};

export type ResearchRelationEdge = {
  id: string;
  source: string;
  target: string;
  type: 'citation' | 'shared_topic';
  weight: number;
  inferred: boolean;
  evidence?: string[];
};

export type ResearchArtifact = {
  schemaVersion: 1;
  kind: 'literature_search';
  artifactId: string;
  createdAt: string;
  intent: { text: string };
  plan: {
    query: string;
    limit: number;
    fromYear?: number;
    toYear?: number;
    sort: string;
    sourceIds: string[];
  };
  papers: ResearchPaper[];
  edges: ResearchRelationEdge[];
  sources: Array<{
    id: string;
    name: string;
    status: 'ok' | 'error' | 'disabled';
    retrievedAt: string;
    queryUrl?: string;
    resultCount: number;
    totalMatches?: number;
    coverage: string;
    error?: string;
  }>;
  coverage: {
    status: 'complete' | 'partial' | 'failed';
    resultCount: number;
    warnings: string[];
  };
  presentation?: { autoOpen?: boolean };
};

export type ResearchSettingsSnapshot = {
  global: ResearchSettings;
  projectOverride: { enabled: boolean; path: string; settings: ResearchSettings } | null;
  effective: ResearchSettings;
  paths: { global: string; project?: string };
};

export type ZoteroStatus = {
  provider: 'zotero';
  available: boolean;
  apiReady: boolean;
  connectorReady: boolean;
  checkedAt: string;
  disabled?: boolean;
  selectedCollection?: {
    id?: string;
    key?: string;
    name: string;
    libraryId?: string | number;
    libraryName?: string;
    editable?: boolean;
  };
  error?: string;
};

export function isResearchArtifact(value: unknown): value is ResearchArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const artifact = value as Partial<ResearchArtifact>;
  return artifact.schemaVersion === 1
    && artifact.kind === 'literature_search'
    && typeof artifact.artifactId === 'string'
    && Array.isArray(artifact.papers)
    && Array.isArray(artifact.edges)
    && Array.isArray(artifact.sources);
}
