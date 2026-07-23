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
      arxiv: {
        enabled: boolean;
      };
      crossref: {
        enabled: boolean;
        /** Optional address used only to opt into Crossref's documented polite pool. */
        mailto: string;
      };
      /** Optional for backward-compatible persisted settings; normalized settings always supply it. */
      openreview?: {
        enabled: boolean;
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

/**
 * A provider-specific narrowing constraint chosen by the agent from the
 * natural-language research goal. It remains structured so providers can
 * validate and audit it without exposing query grammar to users.
 */
export type SearchClassification = {
  scheme: "arxiv";
  include: string[];
};

/** A decision stage requested from a conference venue. */
export type SearchVenueStatus = "accepted" | "submission";

/**
 * One conference, journal, or track constraint selected by the agent from a
 * natural-language request. `openReviewVenueId` is an official OpenReview
 * venue identifier when the constraint can be checked against primary data.
 */
export type SearchVenueConstraint = {
  id: string;
  name: string;
  aliases?: string[];
  year?: number;
  track?: string;
  /** Requested decision stage. A non-OpenReview source must not claim it as verified. */
  status?: SearchVenueStatus;
  /** Legacy spelling retained for callers that already pass a boolean decision state. */
  accepted?: boolean;
  openReviewVenueId?: string;
};

/** A named, auditable set of venue constraints used by one search plan. */
export type SearchVenueSet = {
  id: string;
  name: string;
  venues: SearchVenueConstraint[];
};

/**
 * Venue evidence carried with an individual paper. `official` is reserved for
 * an OpenReview record returned through an explicit official venue ID; other
 * providers can only contribute `metadata` evidence and an unknown decision.
 */
export type ResearchVenueEvidence = {
  sourceId: string;
  evidence: "official" | "metadata";
  venue: string;
  year?: number;
  track?: string;
  status: SearchVenueStatus | "unknown";
  officialVenueId?: string;
};

/**
 * One concrete query formulation chosen by the agent for a single literature
 * search. The primary formulation remains in `SearchPlan.query` for existing
 * consumers; this list makes any broadened terminology reproducible.
 */
export type SearchQueryVariantCategory =
  | "primary"
  | "synonym"
  | "abbreviation"
  | "historical_term"
  | "adjacent_field";

export type SearchQueryVariant = {
  /** Stable artifact-local identifier assigned by the literature tool. */
  id: string;
  query: string;
  /** Per-source result cap allocated from the search's final candidate limit. */
  requestLimit: number;
  /** Optional reason category for this concrete query formulation. */
  category?: SearchQueryVariantCategory;
  /** Optional concise reason for using this alternative formulation. */
  rationale?: string;
};

export type SearchPlan = {
  query: string;
  limit: number;
  fromYear?: number;
  toYear?: number;
  sort: "relevance" | "cited_by_count" | "publication_date";
  classifications?: SearchClassification[];
  venueSet?: SearchVenueSet;
  sourceIds: string[];
  /** Executed query formulations, including the primary query when available. */
  queryVariants?: SearchQueryVariant[];
};

/**
 * A paper can be returned by more than one metadata provider. This records
 * only the retrieval context needed to audit or reproduce that result; it is
 * deliberately not a copy of the provider's raw response.
 */
export type ResearchPaperProvenance = {
  sourceId: string;
  sourceRecordId?: string;
  /** Artifact-local query variant that returned this source record. */
  queryVariantId?: string;
  /** One-based position in this source's response for the submitted plan. */
  rank: number;
  retrievedAt: string;
  queryUrl?: string;
};

export type PaperIdentity = {
  openAlexId?: string;
  doi?: string;
  arxiv?: string;
  /** Numeric version marker for the canonical arXiv identifier, for example 2. */
  arxivVersion?: number;
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
  /** Provider-reported metadata update time, distinct from publication date. */
  updatedAt?: string;
  type?: string;
  venue?: string;
  /** Per-source venue evidence. Never infer an accepted decision from arXiv metadata. */
  venueEvidence?: ResearchVenueEvidence[];
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

export type ResearchSourceApplied = {
  /** Source-specific date field used to implement the requested year range. */
  dateField?: "submitted";
  /** Source-specific ranking actually applied to the query. */
  sort?: string;
  /** Canonical source classifications added to the submitted query. */
  classifications?: string[];
  /** Venue constraints actually applied by this particular provider. */
  venueSet?: {
    id: string;
    name: string;
    constraintIds: string[];
    requestedStatuses?: SearchVenueStatus[];
    enforcement: "official" | "metadata";
  };
};

/**
 * Provider quota information captured with one retrieval attempt. Values are
 * provider-reported and deliberately remain separate from search coverage.
 */
export type ResearchSourceRateLimit = {
  limit?: number;
  remaining?: number;
  /** Seconds until the provider's reported quota reset. */
  resetSeconds?: number;
  /** Seconds requested by the provider before another attempt. */
  retryAfterSeconds?: number;
  costUsd?: number;
  remainingUsd?: number;
};

export type ResearchSourceStatus = {
  id: string;
  name: string;
  /** Present only for one query-source attempt in a query audit. */
  queryVariantId?: string;
  status: "ok" | "error" | "disabled";
  /** A successful response with known incomplete provider coverage. */
  partial?: boolean;
  retrievedAt: string;
  queryUrl?: string;
  resultCount: number;
  totalMatches?: number;
  coverage: string;
  /** Non-fatal source limitations or transformations included in coverage. */
  warnings?: string[];
  /** Provider-specific query constraints or ranking actually applied. */
  applied?: ResearchSourceApplied;
  /** Provider-reported quota state, when the response supplied it. */
  rateLimit?: ResearchSourceRateLimit;
  error?: string;
};

export type ResearchCoverage = {
  status: "complete" | "partial" | "failed";
  resultCount: number;
  warnings: string[];
  requestedSourceIds: string[];
  successfulSourceIds: string[];
  failedSourceIds: string[];
};

/** How a source was intentionally scheduled across query formulations. */
export type LiteratureSearchSourceExecutionScope = "per_query_variant" | "primary_query_only";

/**
 * A compact, derived view of coverage for one executed query formulation.
 * `successfulSourceIds` includes usable-but-partial sources; inspect
 * `partialSourceIds` before treating the formulation as complete.
 */
export type LiteratureSearchQueryVariantCoverage = {
  queryVariantId: string;
  query: string;
  category?: SearchQueryVariantCategory;
  expectedSourceIds: string[];
  attemptedSourceIds: string[];
  successfulSourceIds: string[];
  partialSourceIds: string[];
  failedSourceIds: string[];
  missingSourceIds: string[];
  /** Sum of provider records before cross-source and cross-query deduplication. */
  resultCount: number;
  status: ResearchCoverage["status"];
};

/**
 * The complementary source-oriented view of the same query-source audit.
 * A primary-only source is intentionally not missing from alternate queries.
 */
export type LiteratureSearchSourceCoverage = {
  sourceId: string;
  sourceName: string;
  scope: LiteratureSearchSourceExecutionScope;
  expectedQueryVariantIds: string[];
  attemptedQueryVariantIds: string[];
  successfulQueryVariantIds: string[];
  partialQueryVariantIds: string[];
  failedQueryVariantIds: string[];
  missingQueryVariantIds: string[];
  /** Sum of provider records before cross-source and cross-query deduplication. */
  resultCount: number;
  status: ResearchCoverage["status"];
};

/**
 * A deterministic projection of raw `queryAudit` rows. It keeps the original
 * rows authoritative while making source-by-variant coverage directly usable.
 */
export type LiteratureSearchCoverageAudit = {
  status: ResearchCoverage["status"];
  queryVariants: LiteratureSearchQueryVariantCoverage[];
  sources: LiteratureSearchSourceCoverage[];
  warnings: string[];
};

/**
 * A normalized provider-native terminology record held only while search
 * attempts are merged. It is intentionally distinct from ResearchPaper.topics
 * so multi-provider paper merging cannot manufacture terminology evidence.
 */
export type LiteratureTerminologyTaxonomyLevelRecord = {
  providerRecordId: string;
  text: string;
  providerUrl?: string;
};

export type LiteratureTerminologySourceRecord = {
  providerRecordId: string;
  text: string;
  providerUrl?: string;
  score?: number;
  subfield?: LiteratureTerminologyTaxonomyLevelRecord;
  field?: LiteratureTerminologyTaxonomyLevelRecord;
};

/** Raw-array accounting retained while malformed provider entries are removed. */
export type LiteratureTerminologySourceFieldCounts = {
  sourceRecordCount: number;
  invalidRecordCount: number;
};

/** Raw OpenAlex terminology metadata associated with one source work record. */
export type LiteratureTerminologySourceObservation = {
  providerId: "openalex";
  /** Provider work record before the candidate pool maps it to a final paper. */
  sourcePaperId: string;
  queryVariantId?: string;
  /** Sanitized provider request URL. */
  retrievalUrl: string;
  retrievedAt: string;
  isParatext: boolean;
  keywords: LiteratureTerminologySourceRecord[];
  topics: LiteratureTerminologySourceRecord[];
  fieldCounts: {
    keywords: LiteratureTerminologySourceFieldCounts;
    topics: LiteratureTerminologySourceFieldCounts;
  };
  primaryTopic?: LiteratureTerminologySourceRecord;
};

/** A provider-native observation retained after the final-pool identity map. */
export type LiteratureTerminologyObservation = Omit<LiteratureTerminologySourceObservation, "sourcePaperId"> & {
  supportingPaperId: string;
};

export type LiteratureTerminologyCandidateKind =
  | "observed_keyword"
  | "observed_topic"
  | "adjacent_field";

export type LiteratureTerminologyProviderField =
  | "keywords"
  | "topics"
  | "primary_topic.subfield"
  | "primary_topic.field"
  | "topics.subfield"
  | "topics.field";

export type LiteratureTerminologyEvidence = {
  supportingPaperId: string;
  queryVariantId?: string;
  retrievalUrl: string;
  retrievedAt: string;
  providerScore?: number;
  providerId: "openalex";
  providerRecordId: string;
  providerUrl: string;
  providerField: LiteratureTerminologyProviderField;
};

/** Per-paper provider filtering before an observed keyword or topic is retained. */
export type LiteratureTerminologyObservationTruncation = {
  supportingPaperId: string;
  queryVariantId?: string;
  providerField: "keywords" | "topics";
  scoreThreshold: number;
  perPaperLimit: 8;
  sourceRecordCount: number;
  validRecordCount: number;
  eligibleCount: number;
  retainedCount: number;
  filteredByScoreCount: number;
  invalidRecordCount: number;
  truncatedByLimit: boolean;
};

export type LiteratureTerminologyInference = {
  basis: "multi_paper_taxonomy_contrast";
  level: "subfield" | "field";
  coreRecordId: string;
  coreText: string;
  minimumSupportingPapers: 2;
};

export type LiteratureTerminologyCandidate = {
  /** `provider:kind:upstream-record-id`; never a text-derived identity. */
  id: string;
  text: string;
  kind: LiteratureTerminologyCandidateKind;
  supportingPaperIds: string[];
  evidence: LiteratureTerminologyEvidence[];
  totalEvidenceCount: number;
  evidenceTruncated: boolean;
  observationTruncation?: LiteratureTerminologyObservationTruncation[];
  inference?: LiteratureTerminologyInference;
};

export type LiteratureTerminology = {
  candidates: LiteratureTerminologyCandidate[];
  /** Final-pool papers with at least one retained terminology observation. */
  sourcePaperIds: string[];
  totalCandidateCount: number;
  truncated: boolean;
};

/** The original query-result artifact. Kept stable for existing consumers. */
export type LiteratureSearchArtifact = {
  schemaVersion: 1;
  kind: "literature_search";
  artifactId: string;
  createdAt: string;
  intent: SearchIntent;
  plan: SearchPlan;
  papers: ResearchPaper[];
  edges: ResearchRelationEdge[];
  sources: ResearchSourceStatus[];
  /** One source status per executed query variant, before source aggregation. */
  queryAudit?: ResearchSourceStatus[];
  /**
   * Derived source-by-query coverage emitted by current tools. Optional so
   * persisted schema-v1 artifacts created before this projection remain valid.
   */
  coverageAudit?: LiteratureSearchCoverageAudit;
  /** Evidence-backed OpenAlex terminology observations from the final paper pool. */
  terminology?: LiteratureTerminology;
  coverage: ResearchCoverage;
  presentation: {
    autoOpen: boolean;
  };
};

/** A strong identifier supplied by a selected literature node or its artifact. */
export type LiteratureExpansionSeed = {
  openAlexId?: string;
  doi?: string;
  /** Display-only context; it never participates in seed resolution. */
  title?: string;
  /** Display-only context; it never participates in seed resolution. */
  year?: number;
  /** Display-only context; it never participates in seed resolution. */
  authors?: string[];
};

export type LiteratureExpansionDirection = "references" | "citations";

export type LiteratureExpansionPlan = {
  seed: LiteratureExpansionSeed;
  directions: LiteratureExpansionDirection[];
  limitPerDirection: number;
  /** This first expansion slice intentionally uses only the existing OpenAlex adapter. */
  sourceIds: ["openalex"];
};

export type LiteratureExpansionDirectionStatus = "ok" | "partial" | "error" | "unavailable";

/**
 * Coverage for one directed expansion request. `truncated` is deliberate
 * pagination or budget truncation, whereas `partial` also covers records that
 * OpenAlex reported but could not hydrate.
 */
export type LiteratureExpansionDirectionResult = {
  direction: LiteratureExpansionDirection;
  status: LiteratureExpansionDirectionStatus;
  resultCount: number;
  totalMatches?: number;
  /** Number of reference identifiers supplied by the resolved seed. */
  requestedCount?: number;
  /** Number of supplied reference identifiers returned as full work records. */
  resolvedCount?: number;
  truncated: boolean;
  queryUrl?: string;
  warnings?: string[];
  error?: string;
};

/**
 * A graph neighborhood grown from a verified seed paper. Citation edge
 * orientation remains `citing work -> cited work` in both directions.
 */
export type LiteratureExpansionArtifact = {
  schemaVersion: 1;
  kind: "literature_expansion";
  artifactId: string;
  createdAt: string;
  intent: SearchIntent;
  plan: LiteratureExpansionPlan;
  /** Always identifies a resolved member of `papers`; seed resolution itself is not fuzzy. */
  seedPaperId: string;
  papers: ResearchPaper[];
  edges: ResearchRelationEdge[];
  sources: ResearchSourceStatus[];
  directions: LiteratureExpansionDirectionResult[];
  coverage: ResearchCoverage;
  presentation: {
    autoOpen: boolean;
  };
};

/** Any research artifact accepted by the renderer and persisted in a tool result. */
export type ResearchArtifact = LiteratureSearchArtifact | LiteratureExpansionArtifact;

export type LiteratureSearchResult = {
  papers: ResearchPaper[];
  edges: ResearchRelationEdge[];
  source: ResearchSourceStatus;
  /** Provider-native observations, kept outside merged ResearchPaper metadata. */
  terminologyObservations?: LiteratureTerminologySourceObservation[];
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
  /**
   * The Desktop Local API is read-only. `connector_import` only permits the
   * separately confirmed connector import flow; it does not imply item edits.
   */
  writeMode?: "connector_import" | "read_only";
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
