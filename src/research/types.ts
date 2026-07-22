export type ResearchSettingsScope = "global" | "project";

/**
 * Cloud library selection is intentionally non-secret. The API credential is
 * supplied by a process-local transport and never belongs in research settings.
 */
export type ZoteroCloudLibraryType = "user" | "group";

export type ZoteroCloudSettings = {
  enabled: boolean;
  libraryType: ZoteroCloudLibraryType;
  /** Required for group libraries. A user-library ID is resolved from the credential. */
  libraryId: string | null;
};

export type ResearchSettings = {
  schemaVersion: 1;
  literature: {
    enabled: boolean;
    sources: {
      openalex: {
        enabled: boolean;
        mailto: string;
      };
      crossref: {
        enabled: boolean;
        /** Optional address used only to opt into Crossref's documented polite pool. */
        mailto: string;
      };
    };
    search: {
      defaultLimit: number;
      fromYear: number | null;
      toYear: number | null;
      sort: "relevance" | "cited_by_count" | "publication_date";
    };
    budget: {
      maxResultsPerSearch: number;
      requestTimeoutMs: number;
    };
    map: {
      autoOpen: boolean;
      autoUpdate: boolean;
      showTopicEdges: boolean;
    };
  };
  zotero: {
    enabled: boolean;
    baseUrl: string;
    useSelectedCollection: boolean;
    /**
     * A project may pin its working collection instead of relying on whatever
     * collection happens to be selected in the Zotero desktop app.
     */
    collectionKey: string | null;
    collectionName: string | null;
    cloud: ZoteroCloudSettings;
  };
  citation: {
    style: "apa" | "chicago-author-date" | "ieee" | "mla";
    includeDoi: boolean;
  };
  privacy: {
    allowRemoteMetadataSearch: boolean;
    allowRemoteFullText: boolean;
  };
};

export type ResearchSettingsSnapshot = {
  global: ResearchSettings;
  projectOverride: {
    enabled: boolean;
    path: string;
    settings: ResearchSettings;
  } | null;
  effective: ResearchSettings;
  paths: {
    global: string;
    project?: string;
  };
};

export type SearchIntent = {
  text: string;
};

export type SearchPlan = {
  query: string;
  limit: number;
  fromYear?: number;
  toYear?: number;
  sort: "relevance" | "cited_by_count" | "publication_date";
  sourceIds: string[];
};

/**
 * A paper can be returned by more than one metadata provider. This records
 * only the retrieval context needed to audit or reproduce that result; it is
 * deliberately not a copy of the provider's raw response.
 */
export type ResearchPaperProvenance = {
  sourceId: string;
  sourceRecordId?: string;
  /** One-based position in this source's response for the submitted plan. */
  rank: number;
  retrievedAt: string;
  queryUrl?: string;
};

export type PaperIdentity = {
  openAlexId?: string;
  doi?: string;
  arxiv?: string;
  openReview?: string;
  pmid?: string;
  pmcid?: string;
  zoteroKey?: string;
  other?: Record<string, string>;
};

export type ResearchTopic = {
  id: string;
  name: string;
  score?: number;
};

export type ResearchPaper = {
  id: string;
  identity: PaperIdentity;
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
  referencedWorkIds: string[];
  /**
   * The primary record used for compatibility with existing consumers. When
   * OpenAlex participates in a merged candidate it remains the primary
   * source so its citation-edge IDs remain stable.
   */
  sourceId: string;
  /** All providers that contributed to this merged candidate, in stable order. */
  sourceIds: string[];
  /** One audited source record per contributing provider record. */
  provenance: ResearchPaperProvenance[];
};

export type ResearchRelationEdge = {
  id: string;
  source: string;
  target: string;
  type: "citation" | "shared_topic";
  weight: number;
  inferred: boolean;
  evidence?: string[];
};

export type ResearchSourceStatus = {
  id: string;
  name: string;
  status: "ok" | "error" | "disabled";
  retrievedAt: string;
  queryUrl?: string;
  resultCount: number;
  totalMatches?: number;
  coverage: string;
  error?: string;
};

export type ResearchArtifact = {
  schemaVersion: 1;
  kind: "literature_search";
  artifactId: string;
  createdAt: string;
  intent: SearchIntent;
  plan: SearchPlan;
  papers: ResearchPaper[];
  edges: ResearchRelationEdge[];
  sources: ResearchSourceStatus[];
  coverage: {
    status: "complete" | "partial" | "failed";
    resultCount: number;
    warnings: string[];
    requestedSourceIds: string[];
    successfulSourceIds: string[];
    failedSourceIds: string[];
  };
  presentation: {
    autoOpen: boolean;
  };
};

export type LiteratureSearchResult = {
  papers: ResearchPaper[];
  edges: ResearchRelationEdge[];
  source: ResearchSourceStatus;
};

export interface LiteratureSource {
  readonly id: string;
  readonly name: string;
  search(plan: SearchPlan, options?: { signal?: AbortSignal; now?: () => Date }): Promise<LiteratureSearchResult>;
}

export type ZoteroCollectionTarget = {
  id?: string;
  key?: string;
  name: string;
  libraryId?: string | number;
  libraryName?: string;
  editable?: boolean;
  parentKey?: string;
  itemCount?: number;
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
  identity: PaperIdentity;
};

/**
 * A child record is intentionally only a small, path-free summary. Attachment
 * file locations are local-machine data and must never be returned merely by
 * opening an item's details.
 */
export type ZoteroChild = {
  key: string;
  itemType: string;
  title: string;
  parentItem?: string;
};

export type ZoteroAttachment = ZoteroChild & {
  itemType: "attachment";
  contentType?: string;
  linkMode?: string;
  filename?: string;
  dateModified?: string;
};

export type ZoteroNote = ZoteroChild & {
  itemType: "note";
  html: string;
  text: string;
};

export type ZoteroItemDetail = {
  /** A normalized summary suitable for matching and listing. */
  item: ZoteroLibraryItem;
  /** Kept at the detail root for simple rendering and backwards compatibility. */
  tags: string[];
  /**
   * The item's original bibliographic fields, after local-path fields have
   * been removed. This keeps the detail view useful for fields outside the
   * compact library-list schema without exposing attachment locations.
   */
  data: Record<string, unknown>;
  children: ZoteroChild[];
  attachments: ZoteroAttachment[];
  notes: ZoteroNote[];
};

export type ZoteroAttachmentFullText = {
  attachmentKey: string;
  content: string;
  /** True when the explicit full-text response exceeded the provider cap. */
  truncated: boolean;
  indexedPages?: number;
  totalPages?: number;
  indexedChars?: number;
  /** Character count before the provider applies its response cap. */
  totalChars: number;
  version?: number;
};

export type ZoteroCitationStyle = "apa" | "chicago-author-date" | "ieee" | "mla";

export type ZoteroItemExportFormat = "bibtex" | "csl-json";

export type ZoteroItemExport = {
  itemKey: string;
  format: ZoteroItemExportFormat;
  style: ZoteroCitationStyle;
  /** Official Local API export response: BibTeX or formatted CSL-JSON text. */
  content: string;
  /** Official CSL-formatted in-text citation, when supported by the style. */
  citation?: string;
  /** Official CSL-formatted bibliography entry, when supported by the style. */
  bibliography?: string;
};

export type ZoteroCollectionsResult = {
  collections: ZoteroCollectionTarget[];
  total: number;
  truncated: boolean;
};

export type ZoteroListItemsInput = {
  collectionKey?: string;
  query?: string;
  limit?: number;
};

export type ZoteroItemsResult = {
  collection?: ZoteroCollectionTarget;
  items: ZoteroLibraryItem[];
  total: number;
  truncated: boolean;
  query?: string;
};

export type ZoteroPaperMatchReason = "zotero_key" | "doi" | "arxiv" | "pmid" | "title";

export type ZoteroPaperMatch = {
  paperId: string;
  matched: boolean;
  confidence: "exact" | "heuristic" | "none";
  reasons: ZoteroPaperMatchReason[];
  item?: ZoteroLibraryItem;
  inCollection?: boolean;
};

export type LibraryProviderStatus = {
  provider: "zotero";
  available: boolean;
  apiReady: boolean;
  connectorReady: boolean;
  checkedAt: string;
  selectedCollection?: ZoteroCollectionTarget;
  error?: string;
};

export type LibraryImportResult = {
  provider: "zotero";
  importedCount: number;
  session: string;
  selectedCollection?: ZoteroCollectionTarget;
  response?: unknown;
};

export interface LibraryProvider {
  readonly id: "zotero";
  getStatus(): Promise<LibraryProviderStatus>;
  getSelectedCollection(): Promise<ZoteroCollectionTarget | undefined>;
  listCollections(): Promise<ZoteroCollectionsResult>;
  listItems(input?: ZoteroListItemsInput): Promise<ZoteroItemsResult>;
  getItemDetails(itemKey: string): Promise<ZoteroItemDetail>;
  getAttachmentFullText(attachmentKey: string): Promise<ZoteroAttachmentFullText>;
  exportItem(input: {
    itemKey: string;
    format: ZoteroItemExportFormat;
    style: ZoteroCitationStyle;
  }): Promise<ZoteroItemExport>;
  matchPapers(input: { papers: ResearchPaper[]; collectionKey?: string }): Promise<ZoteroPaperMatch[]>;
  importPapers(input: { papers: ResearchPaper[]; confirmed: boolean }): Promise<LibraryImportResult>;
}

export type ZoteroCloudStatusKind =
  | "unconfigured"
  | "ready"
  | "read_only"
  | "offline"
  | "rate_limited"
  | "error";

export type ZoteroCloudLibrary = {
  type: ZoteroCloudLibraryType;
  id: string;
  path: string;
};

export type ZoteroCloudStatus = {
  provider: "zotero-cloud";
  status: ZoteroCloudStatusKind;
  configured: boolean;
  available: boolean;
  writable: boolean;
  checkedAt: string;
  library?: ZoteroCloudLibrary;
  libraryVersion?: number;
  retryAfterSeconds?: number;
  backoffSeconds?: number;
  error?: string;
};

/**
 * The caller owns authentication. This contract deliberately carries only a
 * relative Zotero Web API path, HTTP data, and an already-authorized response.
 */
export type ZoteroCloudTransportRequest = {
  path: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
};

export type ZoteroCloudTransportResponse = {
  status: number;
  headers?: Headers | Record<string, string | undefined>;
  body?: unknown;
};

export interface ZoteroCloudTransport {
  request(input: ZoteroCloudTransportRequest): Promise<ZoteroCloudTransportResponse>;
}

export type ZoteroCloudVersions = Record<string, number>;

export type ZoteroCloudDeleted = {
  items: string[];
  collections: string[];
  searches: string[];
};

export type ZoteroCloudSyncResult = {
  status: "updated" | "unchanged" | "unavailable";
  checkedAt: string;
  provider: ZoteroCloudStatus;
  sinceVersion?: number;
  libraryVersion?: number;
  itemVersions: ZoteroCloudVersions;
  collectionVersions: ZoteroCloudVersions;
  deleted: ZoteroCloudDeleted;
  retryAfterSeconds?: number;
  backoffSeconds?: number;
};

export type ZoteroCloudTagOperation = "replace" | "add" | "remove";

export type ZoteroCloudTagWriteIntent = {
  kind: "tags";
  itemKey: string;
  operation: ZoteroCloudTagOperation;
  tags: string[];
};

export type ZoteroCloudCreateNoteIntent = {
  kind: "note";
  operation: "create";
  parentItemKey: string;
  html: string;
};

export type ZoteroCloudUpdateNoteIntent = {
  kind: "note";
  operation: "update";
  noteKey: string;
  html: string;
};

export type ZoteroCloudDeleteNoteIntent = {
  kind: "note";
  operation: "delete";
  noteKey: string;
};

export type ZoteroCloudWriteIntent =
  | ZoteroCloudTagWriteIntent
  | ZoteroCloudCreateNoteIntent
  | ZoteroCloudUpdateNoteIntent
  | ZoteroCloudDeleteNoteIntent;

type ZoteroCloudWritePlanBase = {
  planId: string;
  preparedAt: string;
  library: ZoteroCloudLibrary;
  libraryVersion: number;
  requiresConfirmation: true;
};

export type ZoteroCloudTagWritePlan = ZoteroCloudWritePlanBase & {
  kind: "tags";
  itemKey: string;
  itemVersion: number;
  operation: ZoteroCloudTagOperation;
  requestedTags: string[];
  beforeTags: string[];
  afterTags: string[];
};

export type ZoteroCloudCreateNoteWritePlan = ZoteroCloudWritePlanBase & {
  kind: "note";
  operation: "create";
  parentItemKey: string;
  parentItemVersion: number;
  html: string;
};

export type ZoteroCloudUpdateNoteWritePlan = ZoteroCloudWritePlanBase & {
  kind: "note";
  operation: "update";
  noteKey: string;
  noteVersion: number;
  beforeHtml: string;
  html: string;
};

export type ZoteroCloudDeleteNoteWritePlan = ZoteroCloudWritePlanBase & {
  kind: "note";
  operation: "delete";
  noteKey: string;
  noteVersion: number;
  beforeHtml: string;
};

export type ZoteroCloudWritePlan =
  | ZoteroCloudTagWritePlan
  | ZoteroCloudCreateNoteWritePlan
  | ZoteroCloudUpdateNoteWritePlan
  | ZoteroCloudDeleteNoteWritePlan;

export type ZoteroCloudWriteConflict =
  | {
      kind: "tags";
      itemKey: string;
      originalVersion: number;
      currentVersion?: number;
      baseTags: string[];
      localTags: string[];
      remoteTags: string[];
      reason: "unsafe_rebase" | "retry_exhausted";
    }
  | {
      kind: "note";
      operation: "create" | "update" | "delete";
      noteKey?: string;
      originalVersion?: number;
      currentVersion?: number;
      baseHtml?: string;
      localHtml?: string;
      remoteHtml?: string;
      reason: "remote_changed" | "library_changed";
    };

export type ZoteroCloudBatchWriteSuccess = {
  index: number;
  key?: string;
  version?: number;
};

export type ZoteroCloudBatchWriteFailure = {
  index: number;
  code?: number;
  key?: string;
  message: string;
};

export type ZoteroCloudWriteResult = {
  planId: string;
  status:
    | "confirmation_required"
    | "succeeded"
    | "partial"
    | "conflict"
    | "forbidden"
    | "not_found"
    | "locked"
    | "precondition_required"
    | "rate_limited"
    | "error";
  executed: boolean;
  libraryVersion?: number;
  successful: ZoteroCloudBatchWriteSuccess[];
  unchanged: ZoteroCloudBatchWriteSuccess[];
  failed: ZoteroCloudBatchWriteFailure[];
  retryCount: 0 | 1;
  retryAfterSeconds?: number;
  backoffSeconds?: number;
  conflict?: ZoteroCloudWriteConflict;
  error?: string;
};

export type ZoteroCloudExecuteWritePlanInput = {
  plan: ZoteroCloudWritePlan;
  confirmed: boolean;
};

export interface ZoteroCloudProvider {
  getStatus(): Promise<ZoteroCloudStatus>;
  probeIncrementalSync(input?: { sinceVersion?: number }): Promise<ZoteroCloudSyncResult>;
  createWritePlan(intent: ZoteroCloudWriteIntent): Promise<ZoteroCloudWritePlan>;
  executeWritePlan(input: ZoteroCloudExecuteWritePlanInput): Promise<ZoteroCloudWriteResult>;
}
