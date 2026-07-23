export type ResearchLiteratureSourceSettings = {
  enabled: boolean;
  mailto: string;
};

export type ResearchArxivSourceSettings = {
  enabled: boolean;
};

export type ResearchOpenReviewSourceSettings = {
  enabled: boolean;
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
      // Optional at the renderer boundary so settings saved before arXiv
      // support remain readable. The settings UI normalizes it to enabled
      // before a save.
      arxiv?: ResearchArxivSourceSettings;
      // Optional at the renderer boundary so settings saved before OpenReview
      // support remain readable. The settings UI normalizes it to enabled
      // before a save.
      openreview?: ResearchOpenReviewSourceSettings;
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
  queryVariantId?: string;
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
  updatedAt?: string;
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
  queryVariantId?: string;
  status: 'ok' | 'error' | 'disabled';
  partial?: boolean;
  retrievedAt: string;
  queryUrl?: string;
  resultCount: number;
  totalMatches?: number;
  coverage: string;
  error?: string;
  // A source can succeed while applying a narrower query than the overall
  // intent permits. Keep that fact alongside source-local warnings so the
  // renderer can show the actual retrieval conditions without guessing.
  warnings?: string[];
  applied?: {
    dateField?: 'submitted';
    sort?: string;
    classifications?: string[];
  };
  rateLimit?: ResearchSourceRateLimit;
};

export type ResearchSourceRateLimit = {
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
  retryAfterSeconds?: number;
  costUsd?: number;
  remainingUsd?: number;
};

export type ResearchCoverage = {
  status: 'complete' | 'partial' | 'failed';
  resultCount: number;
  warnings: string[];
  // Optional here only to support artifacts emitted before multi-source
  // coverage accounting. New artifacts populate all three arrays.
  requestedSourceIds?: string[];
  successfulSourceIds?: string[];
  failedSourceIds?: string[];
};

type ResearchArtifactBase = {
  schemaVersion: 1;
  artifactId: string;
  createdAt: string;
  intent: { text: string };
  papers: ResearchPaper[];
  edges: ResearchRelationEdge[];
  sources: ResearchSourceStatus[];
  coverage: ResearchCoverage;
  presentation?: { autoOpen?: boolean };
};

export type LiteratureSearchPlan = {
  query: string;
  limit: number;
  fromYear?: number;
  toYear?: number;
  sort: string;
  sourceIds: string[];
  classifications?: Array<{
    scheme: 'arxiv';
    include: string[];
  }>;
  queryVariants?: SearchQueryVariant[];
};

export type SearchQueryVariant = {
  id: string;
  query: string;
  requestLimit: number;
  category?: SearchQueryVariantCategory;
  rationale?: string;
};

export type SearchQueryVariantCategory =
  | 'primary'
  | 'synonym'
  | 'abbreviation'
  | 'historical_term'
  | 'adjacent_field';

export type ResearchTerminologyCandidateKind =
  | 'observed_keyword'
  | 'observed_topic'
  | 'adjacent_field';

export type ResearchTerminologyProviderField =
  | 'keywords'
  | 'topics'
  | 'primary_topic.subfield'
  | 'primary_topic.field'
  | 'topics.subfield'
  | 'topics.field';

export type ResearchTerminologyEvidence = {
  supportingPaperId: string;
  queryVariantId?: string;
  retrievalUrl: string;
  retrievedAt: string;
  providerScore?: number;
  providerId: 'openalex';
  providerRecordId: string;
  providerUrl: string;
  providerField: ResearchTerminologyProviderField;
};

export type ResearchTerminologyObservationTruncation = {
  supportingPaperId: string;
  queryVariantId?: string;
  providerField: 'keywords' | 'topics';
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

export type ResearchTerminologyInference = {
  basis: 'multi_paper_taxonomy_contrast';
  level: 'subfield' | 'field';
  coreRecordId: string;
  coreText: string;
  minimumSupportingPapers: 2;
};

export type ResearchTerminologyCandidate = {
  id: string;
  text: string;
  kind: ResearchTerminologyCandidateKind;
  supportingPaperIds: string[];
  evidence: ResearchTerminologyEvidence[];
  totalEvidenceCount: number;
  evidenceTruncated: boolean;
  observationTruncation?: ResearchTerminologyObservationTruncation[];
  inference?: ResearchTerminologyInference;
};

export type ResearchTerminologySummary = {
  candidates: ResearchTerminologyCandidate[];
  sourcePaperIds: string[];
  totalCandidateCount: number;
  truncated: boolean;
};

/** Existing discovery artifact. Keep this shape stable for persisted results. */
export type LiteratureSearchArtifact = ResearchArtifactBase & {
  kind: 'literature_search';
  plan: LiteratureSearchPlan;
  queryAudit?: ResearchSourceStatus[];
  terminology?: ResearchTerminologySummary;
};

export type LiteratureExpansionDirection = 'references' | 'citations';

export type LiteratureExpansionDirectionResult = {
  direction: LiteratureExpansionDirection;
  status: 'ok' | 'partial' | 'error' | 'unavailable';
  queryUrl?: string;
  error?: string;
  resultCount: number;
  totalMatches?: number;
  requestedCount?: number;
  resolvedCount?: number;
  truncated: boolean;
  warnings?: string[];
};

export type LiteratureExpansionPlan = {
  seed: {
    openAlexId?: string;
    doi?: string;
    title?: string;
    year?: number;
    authors?: string[];
  };
  directions: LiteratureExpansionDirection[];
  limitPerDirection: number;
  sourceIds: ['openalex'];
};

/**
 * Directed, seed-centred citation expansion. The paper referenced by
 * `seedPaperId` is always included in `papers`, even when both directions
 * fail, so the panel can explain partial coverage without losing context.
 */
export type LiteratureExpansionArtifact = ResearchArtifactBase & {
  kind: 'literature_expansion';
  plan: LiteratureExpansionPlan;
  seedPaperId: string;
  directions: LiteratureExpansionDirectionResult[];
};

export type ResearchArtifact = LiteratureSearchArtifact | LiteratureExpansionArtifact;

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
  writeMode?: 'connector_import' | 'read_only';
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

export type ZoteroCloudSyncResult = {
  status: 'updated' | 'unchanged' | 'unavailable';
  checkedAt: string;
  provider: ZoteroCloudStatus;
  sinceVersion?: number;
  libraryVersion?: number;
  itemVersions: Record<string, number>;
  collectionVersions: Record<string, number>;
  deleted: { items: string[]; collections: string[]; searches: string[] };
  retryAfterSeconds?: number;
  backoffSeconds?: number;
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
  if (!isResearchArtifactBase(value)) return false;
  if (value.kind === 'literature_search') {
    const paperIds = new Set(value.papers.flatMap((paper) => (
      isRecord(paper) && isNonEmptyString(paper.id) ? [paper.id] : []
    )));
    return isLiteratureSearchPlan(value.plan)
      && (value.queryAudit === undefined
        || (Array.isArray(value.queryAudit) && value.queryAudit.every(isResearchSourceStatus)))
      && (value.terminology === undefined || isResearchTerminologySummary(value.terminology, paperIds));
  }
  if (value.kind !== 'literature_expansion') return false;
  if (!isLiteratureExpansionPlan(value.plan)
    || !isNonEmptyString(value.seedPaperId)
    || !value.papers.some((paper) => isRecord(paper) && paper.id === value.seedPaperId)
    || !Array.isArray(value.directions)
    || !value.directions.every(isLiteratureExpansionDirectionResult)) {
    return false;
  }
  const plannedDirections = new Set(value.plan.directions);
  const reportedDirections = new Set(value.directions.map((direction) => direction.direction));
  return plannedDirections.size === value.plan.directions.length
    && reportedDirections.size === value.directions.length
    && plannedDirections.size === reportedDirections.size
    && [...plannedDirections].every((direction) => reportedDirections.has(direction));
}

function isResearchArtifactBase(value: unknown): value is Record<string, unknown> & {
  schemaVersion: 1;
  kind: string;
  artifactId: string;
  papers: unknown[];
  edges: unknown[];
  sources: unknown[];
} {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.kind !== 'string'
    || !isNonEmptyString(value.artifactId)
    || !isNonEmptyString(value.createdAt)
    || !isRecord(value.intent)
    || typeof value.intent.text !== 'string'
    || !Array.isArray(value.papers)
    || !value.papers.every(isResearchPaper)
    || !Array.isArray(value.edges)
    || !value.edges.every(isResearchRelationEdge)
    || !Array.isArray(value.sources)
    || !value.sources.every(isResearchSourceStatus)
    || !isResearchCoverage(value.coverage)) {
    return false;
  }
  return value.presentation === undefined
    || (isRecord(value.presentation)
      && (value.presentation.autoOpen === undefined || typeof value.presentation.autoOpen === 'boolean'));
}

function isLiteratureSearchPlan(value: unknown): value is LiteratureSearchPlan {
  return isRecord(value)
    && typeof value.query === 'string'
    && isPositiveFiniteNumber(value.limit)
    && (value.fromYear === undefined || isFiniteNumber(value.fromYear))
    && (value.toYear === undefined || isFiniteNumber(value.toYear))
    && typeof value.sort === 'string'
    && isStringArray(value.sourceIds)
    && (value.classifications === undefined
      || (Array.isArray(value.classifications) && value.classifications.every(isSearchClassification)))
    && (value.queryVariants === undefined
      || (Array.isArray(value.queryVariants)
        && value.queryVariants.length >= 1
        && value.queryVariants.length <= 4
        && value.queryVariants.every(isSearchQueryVariant)));
}

function isSearchQueryVariant(value: unknown): value is SearchQueryVariant {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.query)
    || !isPositiveFiniteNumber(value.requestLimit)
    || (value.category !== undefined && !isSearchQueryVariantCategory(value.category))
    || !isOptionalString(value.rationale)) {
    return false;
  }
  if (value.category === undefined) return true;
  return value.id === 'primary'
    ? value.category === 'primary'
    : value.category !== 'primary';
}

function isSearchQueryVariantCategory(value: unknown): value is SearchQueryVariantCategory {
  return value === 'primary'
    || value === 'synonym'
    || value === 'abbreviation'
    || value === 'historical_term'
    || value === 'adjacent_field';
}

function isResearchTerminologySummary(value: unknown, paperIds: ReadonlySet<string>): value is ResearchTerminologySummary {
  if (!isRecord(value)
    || !Array.isArray(value.candidates)
    || !isStringArray(value.sourcePaperIds)
    || !hasUniqueStrings(value.sourcePaperIds)
    || !value.sourcePaperIds.every((paperId) => paperIds.has(paperId))
    || !isNonNegativeInteger(value.totalCandidateCount)
    || value.totalCandidateCount < value.candidates.length
    || typeof value.truncated !== 'boolean') {
    return false;
  }
  const sourcePaperIds = new Set(value.sourcePaperIds);
  if (!value.candidates.every((candidate) => (
    isResearchTerminologyCandidate(candidate, paperIds, sourcePaperIds)
  ))) return false;
  const retainedEvidencePaperIds = new Set(value.candidates.flatMap((candidate) => (
    candidate.evidence.map((evidence) => evidence.supportingPaperId)
  )));
  return sourcePaperIds.size === retainedEvidencePaperIds.size
    && [...sourcePaperIds].every((paperId) => retainedEvidencePaperIds.has(paperId));
}

function isResearchTerminologyCandidate(
  value: unknown,
  paperIds: ReadonlySet<string>,
  sourcePaperIds: ReadonlySet<string>,
): value is ResearchTerminologyCandidate {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.text)
    || !isResearchTerminologyCandidateKind(value.kind)
    || !isStringArray(value.supportingPaperIds)
    || value.supportingPaperIds.length === 0
    || !hasUniqueStrings(value.supportingPaperIds)
    || !value.supportingPaperIds.every((paperId) => paperIds.has(paperId) && sourcePaperIds.has(paperId))
    || !Array.isArray(value.evidence)
    || value.evidence.length === 0
    || !isNonNegativeInteger(value.totalEvidenceCount)
    || value.totalEvidenceCount < value.evidence.length
    || typeof value.evidenceTruncated !== 'boolean'
    || value.evidenceTruncated !== (value.totalEvidenceCount > value.evidence.length)
    || (value.observationTruncation !== undefined && !Array.isArray(value.observationTruncation))) {
    return false;
  }
  // Keep the narrowed discriminant in a local value for callbacks below.
  const candidateKind = value.kind;
  const supportingPaperIds = new Set(value.supportingPaperIds);
  if (!value.evidence.every((evidence) => (
    isResearchTerminologyEvidence(evidence, candidateKind, supportingPaperIds)
  ))) {
    return false;
  }
  const evidencedPaperIds = new Set(value.evidence.map((evidence) => (
    isRecord(evidence) && isNonEmptyString(evidence.supportingPaperId) ? evidence.supportingPaperId : ''
  )));
  if (supportingPaperIds.size !== evidencedPaperIds.size
    || ![...supportingPaperIds].every((paperId) => evidencedPaperIds.has(paperId))) return false;
  if (value.observationTruncation !== undefined
    && !value.observationTruncation.every((entry) => (
      isResearchTerminologyObservationTruncation(entry, candidateKind, supportingPaperIds)
    ))) {
    return false;
  }
  return value.kind === 'adjacent_field'
    ? isResearchTerminologyInference(value.inference)
    : value.inference === undefined;
}

function isResearchTerminologyCandidateKind(value: unknown): value is ResearchTerminologyCandidateKind {
  return value === 'observed_keyword' || value === 'observed_topic' || value === 'adjacent_field';
}

function isResearchTerminologyEvidence(
  value: unknown,
  kind: ResearchTerminologyCandidateKind,
  supportingPaperIds: ReadonlySet<string>,
): value is ResearchTerminologyEvidence {
  return isRecord(value)
    && isNonEmptyString(value.supportingPaperId)
    && supportingPaperIds.has(value.supportingPaperId)
    && isOptionalString(value.queryVariantId)
    && isPublicResearchUrl(value.retrievalUrl)
    && isNonEmptyString(value.retrievedAt)
    && (value.providerScore === undefined || isProviderScore(value.providerScore))
    && value.providerId === 'openalex'
    && isNonEmptyString(value.providerRecordId)
    && isPublicResearchUrl(value.providerUrl)
    && isResearchTerminologyProviderField(value.providerField)
    && terminologyFieldMatchesKind(kind, value.providerField);
}

function isResearchTerminologyObservationTruncation(
  value: unknown,
  kind: ResearchTerminologyCandidateKind,
  supportingPaperIds: ReadonlySet<string>,
): value is ResearchTerminologyObservationTruncation {
  return isRecord(value)
    && isNonEmptyString(value.supportingPaperId)
    && supportingPaperIds.has(value.supportingPaperId)
    && isOptionalString(value.queryVariantId)
    && (value.providerField === 'keywords' || value.providerField === 'topics')
    && (kind === 'observed_keyword' ? value.providerField === 'keywords' : value.providerField === 'topics')
    && isProviderScore(value.scoreThreshold)
    && value.perPaperLimit === 8
    && isNonNegativeInteger(value.sourceRecordCount)
    && isNonNegativeInteger(value.validRecordCount)
    && isNonNegativeInteger(value.eligibleCount)
    && isNonNegativeInteger(value.retainedCount)
    && isNonNegativeInteger(value.filteredByScoreCount)
    && isNonNegativeInteger(value.invalidRecordCount)
    && typeof value.truncatedByLimit === 'boolean';
}

function isResearchTerminologyInference(value: unknown): value is ResearchTerminologyInference {
  return isRecord(value)
    && value.basis === 'multi_paper_taxonomy_contrast'
    && (value.level === 'subfield' || value.level === 'field')
    && isNonEmptyString(value.coreRecordId)
    && isNonEmptyString(value.coreText)
    && value.minimumSupportingPapers === 2;
}

function isResearchTerminologyProviderField(value: unknown): value is ResearchTerminologyProviderField {
  return value === 'keywords'
    || value === 'topics'
    || value === 'primary_topic.subfield'
    || value === 'primary_topic.field'
    || value === 'topics.subfield'
    || value === 'topics.field';
}

function terminologyFieldMatchesKind(
  kind: ResearchTerminologyCandidateKind,
  field: ResearchTerminologyProviderField,
): boolean {
  if (kind === 'observed_keyword') return field === 'keywords';
  if (kind === 'observed_topic') return field === 'topics';
  return field === 'primary_topic.subfield'
    || field === 'primary_topic.field'
    || field === 'topics.subfield'
    || field === 'topics.field';
}

function isLiteratureExpansionPlan(value: unknown): value is LiteratureExpansionPlan {
  if (!isRecord(value) || !isRecord(value.seed)) return false;
  const hasStableSeedIdentity = isNonEmptyString(value.seed.openAlexId) || isNonEmptyString(value.seed.doi);
  return hasStableSeedIdentity
    && (value.seed.title === undefined || typeof value.seed.title === 'string')
    && (value.seed.year === undefined || isFiniteNumber(value.seed.year))
    && (value.seed.authors === undefined || isStringArray(value.seed.authors))
    && Array.isArray(value.directions)
    && value.directions.length >= 1
    && value.directions.length <= 2
    && value.directions.every(isLiteratureExpansionDirection)
    && isPositiveFiniteNumber(value.limitPerDirection)
    && Array.isArray(value.sourceIds)
    && value.sourceIds.length === 1
    && value.sourceIds[0] === 'openalex';
}

function isLiteratureExpansionDirection(value: unknown): value is LiteratureExpansionDirection {
  return value === 'references' || value === 'citations';
}

function isLiteratureExpansionDirectionResult(value: unknown): value is LiteratureExpansionDirectionResult {
  if (!isRecord(value)) return false;
  return isLiteratureExpansionDirection(value.direction)
    && (value.status === 'ok' || value.status === 'partial' || value.status === 'error' || value.status === 'unavailable')
    && isNonNegativeFiniteNumber(value.resultCount)
    && typeof value.truncated === 'boolean'
    && (value.queryUrl === undefined || typeof value.queryUrl === 'string')
    && (value.error === undefined || typeof value.error === 'string')
    && (value.totalMatches === undefined || isNonNegativeFiniteNumber(value.totalMatches))
    && (value.requestedCount === undefined || isNonNegativeFiniteNumber(value.requestedCount))
    && (value.resolvedCount === undefined || isNonNegativeFiniteNumber(value.resolvedCount))
    && (value.warnings === undefined || isStringArray(value.warnings));
}

function isResearchCoverage(value: unknown): value is ResearchCoverage {
  return isRecord(value)
    && (value.status === 'complete' || value.status === 'partial' || value.status === 'failed')
    && isNonNegativeFiniteNumber(value.resultCount)
    && isStringArray(value.warnings)
    && isOptionalStringArray(value.requestedSourceIds)
    && isOptionalStringArray(value.successfulSourceIds)
    && isOptionalStringArray(value.failedSourceIds);
}

function isResearchPaper(value: unknown): value is ResearchPaper {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && typeof value.title === 'string'
    && isStringArray(value.authors)
    && isNonNegativeFiniteNumber(value.citedByCount)
    && Array.isArray(value.topics)
    && value.topics.every(isResearchTopic)
    && isNonEmptyString(value.sourceId)
    && (value.identity === undefined || isRecord(value.identity))
    && (value.year === undefined || isFiniteNumber(value.year))
    && isOptionalString(value.publicationDate)
    && isOptionalString(value.updatedAt)
    && isOptionalString(value.type)
    && isOptionalString(value.venue)
    && isOptionalString(value.doi)
    && isOptionalString(value.url)
    && (value.isOpenAccess === undefined || typeof value.isOpenAccess === 'boolean')
    && isOptionalString(value.abstract)
    && isOptionalStringArray(value.referencedWorkIds)
    && isOptionalStringArray(value.sourceIds)
    && (value.provenance === undefined
      || (Array.isArray(value.provenance) && value.provenance.every(isResearchPaperProvenance)));
}

function isResearchTopic(value: unknown): value is ResearchTopic {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && typeof value.name === 'string'
    && (value.score === undefined || isFiniteNumber(value.score));
}

function isResearchPaperProvenance(value: unknown): value is ResearchPaperProvenance {
  return isRecord(value)
    && isNonEmptyString(value.sourceId)
    && isNonEmptyString(value.retrievedAt)
    && isOptionalString(value.sourceRecordId)
    && isOptionalString(value.queryVariantId)
    && (value.rank === undefined || isNonNegativeFiniteNumber(value.rank))
    && isOptionalString(value.queryUrl);
}

function isResearchRelationEdge(value: unknown): value is ResearchRelationEdge {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.source)
    && isNonEmptyString(value.target)
    && (value.type === 'citation' || value.type === 'shared_topic')
    && isNonNegativeFiniteNumber(value.weight)
    && typeof value.inferred === 'boolean'
    && isOptionalStringArray(value.evidence);
}

function isResearchSourceStatus(value: unknown): value is ResearchSourceStatus {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && typeof value.name === 'string'
    && isOptionalString(value.queryVariantId)
    && (value.status === 'ok' || value.status === 'error' || value.status === 'disabled')
    && (value.partial === undefined || typeof value.partial === 'boolean')
    && isNonEmptyString(value.retrievedAt)
    && isNonNegativeFiniteNumber(value.resultCount)
    && typeof value.coverage === 'string'
    && isOptionalString(value.queryUrl)
    && (value.totalMatches === undefined || isNonNegativeFiniteNumber(value.totalMatches))
    && isOptionalStringArray(value.warnings)
    && isOptionalString(value.error)
    && (value.applied === undefined || isResearchSourceApplied(value.applied))
    && (value.rateLimit === undefined || isResearchSourceRateLimit(value.rateLimit));
}

function isResearchSourceRateLimit(value: unknown): value is ResearchSourceRateLimit {
  return isRecord(value)
    && isOptionalNonNegativeNumber(value.limit)
    && isOptionalNonNegativeNumber(value.remaining)
    && isOptionalNonNegativeNumber(value.resetSeconds)
    && isOptionalNonNegativeNumber(value.retryAfterSeconds)
    && isOptionalNonNegativeNumber(value.costUsd)
    && isOptionalNonNegativeNumber(value.remainingUsd);
}

function isResearchSourceApplied(value: unknown): boolean {
  return isRecord(value)
    && (value.dateField === undefined || value.dateField === 'submitted')
    && isOptionalString(value.sort)
    && isOptionalStringArray(value.classifications);
}

function isSearchClassification(value: unknown): boolean {
  return isRecord(value)
    && value.scheme === 'arxiv'
    && isStringArray(value.include);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeFiniteNumber(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeFiniteNumber(value) && Number.isInteger(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProviderScore(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function hasUniqueStrings(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function isPublicResearchUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return [...parsed.searchParams.keys()].every((key) => !SENSITIVE_RETRIEVAL_QUERY_PARAMETERS.has(
      normalizeRetrievalQueryParameter(key),
    ));
  } catch {
    return false;
  }
}

const SENSITIVE_RETRIEVAL_QUERY_PARAMETERS = new Set([
  'accesskey',
  'accesstoken',
  'apikey',
  'auth',
  'authorization',
  'bearertoken',
  'clientsecret',
  'credential',
  'email',
  'key',
  'mailto',
  'password',
  'secret',
  'signature',
  'sig',
  'token',
  'xapikey',
]);

function normalizeRetrievalQueryParameter(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
