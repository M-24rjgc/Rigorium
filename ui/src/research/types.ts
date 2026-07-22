export type ResearchLiteratureSourceSettings = {
  enabled: boolean;
  mailto: string;
};

export type ResearchSettings = {
  schemaVersion: 1;
  literature: {
    enabled: boolean;
    sources: {
      openalex: ResearchLiteratureSourceSettings;
      // Optional at the renderer boundary so settings persisted before the
      // multi-source release remain readable. The settings UI normalizes it
      // to the enabled Crossref default before a save.
      crossref?: ResearchLiteratureSourceSettings;
    };
    search: {
      defaultLimit: number;
      fromYear: number | null;
      toYear: number | null;
      sort: 'relevance' | 'cited_by_count' | 'publication_date';
    };
    budget: { maxResultsPerSearch: number; requestTimeoutMs: number };
    map: { autoOpen: boolean; autoUpdate: boolean; showTopicEdges: boolean };
  };
  zotero: {
    enabled: boolean;
    baseUrl: string;
    useSelectedCollection: boolean;
    collectionKey: string | null;
    collectionName: string | null;
    cloud: {
      enabled: boolean;
      libraryType: 'user' | 'group';
      libraryId: string | null;
    };
  };
  citation: { style: 'apa' | 'chicago-author-date' | 'ieee' | 'mla'; includeDoi: boolean };
  privacy: { allowRemoteMetadataSearch: boolean; allowRemoteFullText: boolean };
};

export type ResearchTopic = { id: string; name: string; score?: number };

export type ResearchPaperProvenance = {
  sourceId: string;
  sourceRecordId?: string;
  rank?: number;
  retrievedAt: string;
  queryUrl?: string;
};

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
  // sourceId remains the primary source for existing artifacts. These fields
  // retain every contributing source after identity-based result merging.
  sourceIds?: string[];
  provenance?: ResearchPaperProvenance[];
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

export type ResearchSourceStatus = {
  id: string;
  name: string;
  status: 'ok' | 'error' | 'disabled';
  retrievedAt: string;
  queryUrl?: string;
  resultCount: number;
  totalMatches?: number;
  coverage: string;
  error?: string;
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
  sources: ResearchSourceStatus[];
  coverage: {
    status: 'complete' | 'partial' | 'failed';
    resultCount: number;
    warnings: string[];
    // Optional here only to support artifacts emitted before multi-source
    // coverage accounting. New search artifacts populate all three arrays.
    requestedSourceIds?: string[];
    successfulSourceIds?: string[];
    failedSourceIds?: string[];
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

export type ZoteroCollection = NonNullable<ZoteroStatus['selectedCollection']> & {
  parentKey?: string;
  itemCount?: number;
};

export type ZoteroCollectionsResult = {
  provider?: 'zotero';
  available?: boolean;
  disabled?: boolean;
  error?: string;
  collections: ZoteroCollection[];
  total: number;
  truncated: boolean;
};

export type ZoteroLibraryItem = {
  key: string;
  itemType: string;
  title: string;
  creators: string[];
  date?: string;
  year?: number;
  doi?: string;
  arxiv?: string;
  pmid?: string;
  url?: string;
  tags: string[];
  collectionKeys: string[];
  identity: Record<string, unknown>;
};

export type ZoteroLibraryNote = {
  key: string;
  itemType?: string;
  title?: string;
  html?: string;
  text?: string;
  parentItem?: string;
};

export type ZoteroLibraryAttachment = {
  key: string;
  itemType?: string;
  title: string;
  contentType?: string;
  linkMode?: string;
  filename?: string;
  dateModified?: string;
  parentItem?: string;
};

export type ZoteroItemDetailsResult = {
  provider?: 'zotero';
  available?: boolean;
  disabled?: boolean;
  error?: string;
  itemKey?: string;
  detail?: {
    item?: ZoteroLibraryItem;
    data?: Record<string, unknown>;
    tags?: string[];
    notes?: ZoteroLibraryNote[];
    attachments?: ZoteroLibraryAttachment[];
    children?: Array<ZoteroLibraryAttachment | ZoteroLibraryNote | Record<string, unknown>>;
  };
};

export type ZoteroAttachmentFullTextResult = {
  provider?: 'zotero';
  available?: boolean;
  disabled?: boolean;
  error?: string;
  attachmentKey?: string;
  content?: string;
  truncated?: boolean;
  indexedPages?: number;
  totalPages?: number;
  indexedChars?: number;
  totalChars?: number;
  version?: number;
};

export type ZoteroExportFormat = 'bibtex' | 'csl-json';

export type ZoteroItemExportResult = {
  provider?: 'zotero';
  available?: boolean;
  disabled?: boolean;
  error?: string;
  itemKey?: string;
  format?: ZoteroExportFormat;
  style?: 'apa' | 'chicago-author-date' | 'ieee' | 'mla';
  content?: string;
  citation?: string;
  bibliography?: string;
};

export type ZoteroCloudStatus = {
  provider: 'zotero-cloud';
  status: 'unconfigured' | 'ready' | 'read_only' | 'offline' | 'rate_limited' | 'error';
  configured: boolean;
  available: boolean;
  writable: boolean;
  checkedAt: string;
  library?: { type: 'user' | 'group'; id: string; path: string };
  libraryVersion?: number;
  retryAfterSeconds?: number;
  backoffSeconds?: number;
  error?: string;
};

export type ZoteroCloudWriteIntent =
  | { kind: 'tags'; itemKey: string; operation: 'replace' | 'add' | 'remove'; tags: string[] }
  | { kind: 'note'; operation: 'create'; parentItemKey: string; html: string }
  | { kind: 'note'; operation: 'update'; noteKey: string; html: string }
  | { kind: 'note'; operation: 'delete'; noteKey: string };

export type ZoteroCloudWritePlan = {
  planId: string;
  preparedAt: string;
  library: { type: 'user' | 'group'; id: string; path: string };
  libraryVersion: number;
  requiresConfirmation: true;
  kind: 'tags' | 'note';
  operation: 'replace' | 'add' | 'remove' | 'create' | 'update' | 'delete';
  itemKey?: string;
  parentItemKey?: string;
  noteKey?: string;
  beforeTags?: string[];
  afterTags?: string[];
  beforeHtml?: string;
  html?: string;
};

export type ZoteroCloudWriteResult = {
  planId: string;
  status: 'confirmation_required' | 'succeeded' | 'partial' | 'conflict' | 'forbidden' | 'not_found' | 'locked' | 'precondition_required' | 'rate_limited' | 'error';
  executed: boolean;
  libraryVersion?: number;
  error?: string;
  conflict?: {
    kind: 'tags' | 'note';
    reason: string;
    remoteTags?: string[];
    remoteHtml?: string;
  };
};

export type ZoteroItemsResult = {
  provider?: 'zotero';
  available?: boolean;
  disabled?: boolean;
  error?: string;
  collection?: ZoteroCollection;
  items: ZoteroLibraryItem[];
  total: number;
  truncated: boolean;
  query?: string;
};

export type ZoteroPaperMatch = {
  paperId: string;
  matched: boolean;
  confidence: 'exact' | 'heuristic' | 'none';
  reasons: Array<'zotero_key' | 'doi' | 'arxiv' | 'pmid' | 'title'>;
  item?: ZoteroLibraryItem;
  inCollection?: boolean;
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
