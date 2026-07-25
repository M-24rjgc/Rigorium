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
  type: 'citation' | 'shared_topic' | 'topic_similarity';
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

export type ResearchDirectionCueKind =
  | 'interest'
  | 'question'
  | 'paper'
  | 'algorithm'
  | 'data'
  | 'experiment_observation';

export type ResearchDirectionCue = {
  id: string;
  kind: ResearchDirectionCueKind;
  text: string;
  sourceReference?: string;
};

export type ResearchDirectionDraft = {
  id: string;
  statement: string;
  cueIds: string[];
  terminologyIds?: string[];
  constraintIds?: string[];
};

export type ResearchDirectionCandidate = {
  id: string;
  summary: string;
  cueIds: string[];
  terminologyIds: string[];
  constraintIds: string[];
  hypotheses: ResearchDirectionDraft[];
  contributions: ResearchDirectionDraft[];
  provisionalTitle: {
    status: 'proposed' | 'downgraded' | 'rejected';
    text?: string;
    origin: 'agent_seed' | 'summary_fallback';
    reasonCodes: string[];
    confirmation: {
      status: 'pending';
      confirmed: false;
      requiresExplicitUserAction: true;
      projectNameUpdate: {
        status: 'not_ready';
        requiresExplicitUserAction: true;
      };
    };
  };
};

export type ResearchDirectionSeedArtifact = {
  schemaVersion: 1;
  kind: 'research_direction_seed';
  artifactId: string;
  createdAt: string;
  input: {
    cues: ResearchDirectionCue[];
    terminology?: Array<{ id: string; text: string; cueIds: string[]; status?: 'observed' | 'inferred' }>;
    constraints?: Array<{
      id: string;
      kind: 'venue' | 'time' | 'data' | 'compute' | 'ethics' | 'baseline' | 'evaluation';
      label: string;
      status: 'satisfied' | 'unknown' | 'blocked';
      required?: boolean;
      cueIds: string[];
    }>;
    candidates: Array<{
      id: string;
      summary: string;
      cueIds: string[];
      terminologyIds?: string[];
      constraintIds?: string[];
      hypotheses?: ResearchDirectionDraft[];
      contributions?: ResearchDirectionDraft[];
      titleSeed?: string;
      neutralTitle?: string;
    }>;
  };
  result: {
    cues: ResearchDirectionCue[];
    terminology: Array<{ id: string; text: string; cueIds: string[]; status?: 'observed' | 'inferred' }>;
    constraints: NonNullable<ResearchDirectionSeedArtifact['input']['constraints']>;
    constraintCoverage: {
      status: 'not_provided' | 'unresolved' | 'specified';
      suppliedConstraintIds: string[];
      unresolvedConstraintIds: string[];
    };
    candidateDirections: ResearchDirectionCandidate[];
  };
  presentation?: { autoOpen?: boolean };
};

export type ResearchDirectionEvidence = {
  id: string;
  paperId: string;
  role: 'prior_art' | 'gap' | 'method' | 'result' | 'limitation' | 'data' | 'baseline' | 'evaluation' | 'ethics' | 'venue';
  statement: string;
  strength?: 'direct' | 'indirect';
};

export type ResearchDirectionTrace = {
  evidenceIds: string[];
  paperIds: string[];
  constraintIds: string[];
};

export type ResearchDirectionAssessmentInput = {
  candidates: Array<{
    id: string;
    summary: string;
    titleSeed?: string;
    evidenceIds?: string[];
    caveats?: Array<{
      id: string;
      summary: string;
      severity: 'low' | 'medium' | 'high';
      evidenceIds?: string[];
    }>;
    hypotheses?: Array<{
      id: string;
      statement: string;
      failureCriterion?: string;
      evidenceIds?: string[];
      evaluationConstraintId?: string;
      baselineConstraintIds?: string[];
    }>;
    constraintIds?: string[];
    targetConferenceIds?: string[];
  }>;
  evidence?: ResearchDirectionEvidence[];
  constraints?: Array<{
    id: string;
    kind: 'venue' | 'time' | 'data' | 'compute' | 'ethics' | 'baseline' | 'evaluation';
    label: string;
    status: 'satisfied' | 'unknown' | 'blocked';
    required?: boolean;
    evidenceIds?: string[];
  }>;
  targetConferences?: Array<{
    id: string;
    name: string;
    deadline?: string;
    status: 'satisfied' | 'unknown' | 'blocked';
    evidenceIds?: string[];
  }>;
};

export type ResearchDirectionAssessment = {
  rank: number;
  directionId: string;
  summary: string;
  score: ResearchDirectionTrace & {
    total: number;
    evidence: number;
    feasibility: number;
    testability: number;
    gapOpportunity: number;
    caveatPenalty: number;
    blockerPenalty: number;
  };
  novelty: ResearchDirectionTrace & { status: 'gap_evidenced' | 'not_established' };
  caveats: Array<ResearchDirectionTrace & {
    id: string;
    summary: string;
    severity: 'low' | 'medium' | 'high';
    status: 'cited' | 'needs_evidence';
  }>;
  falsifiableHypotheses: Array<ResearchDirectionTrace & {
    id: string;
    statement: string;
    failureCriterion?: string;
    status: 'ready' | 'needs_evidence' | 'needs_design' | 'blocked';
  }>;
  targetConferences: Array<ResearchDirectionTrace & {
    id: string;
    name: string;
    deadline?: string;
    status: 'satisfied' | 'unknown' | 'blocked';
  }>;
  unmetEvidenceGaps: Array<ResearchDirectionTrace & {
    code: string;
    severity: 'required' | 'advisory';
    hypothesisId?: string;
    caveatId?: string;
    relatedId?: string;
  }>;
  minimumViability: {
    status: 'viable' | 'needs_evidence' | 'blocked';
    reasons: Array<ResearchDirectionTrace & {
      code: string;
      status: 'supported' | 'unproven' | 'blocked';
      relatedId?: string;
    }>;
  };
  provisionalTitle: ResearchDirectionTrace & {
    status: 'accepted' | 'downgraded' | 'rejected';
    text?: string;
    reasonCodes: string[];
  };
  conclusions: Array<ResearchDirectionTrace & {
    code: string;
    status: 'supported' | 'unproven' | 'blocked';
    relatedId?: string;
  }>;
};

export type ResearchDirectionAssessmentSnapshot = {
  input: ResearchDirectionAssessmentInput;
  result: {
    limits: Record<string, number>;
    rankedDirectionIds: string[];
    assessments: ResearchDirectionAssessment[];
  };
};

export type ResearchDirectionAssessmentArtifact = ResearchDirectionAssessmentSnapshot & {
  schemaVersion: 1;
  kind: 'direction_assessment';
  artifactId: string;
  createdAt: string;
  presentation?: { autoOpen?: boolean };
};

export type ResearchTitleConfirmationSnapshot = {
  input: {
    directionId: string;
    candidateTitle: string;
    evidence: ResearchDirectionEvidence[];
    neutralTitle?: string;
    confirmed?: boolean;
  };
  result: {
    directionId: string;
    title: ResearchDirectionTrace & {
      status: 'accepted' | 'downgraded' | 'rejected';
      text?: string;
      reasonCodes: string[];
    };
    confirmation: {
      status: 'pending' | 'confirmed';
      confirmed: boolean;
      projectNameUpdate: {
        status: 'not_ready' | 'ready_for_explicit_project_action';
        name?: string;
        requiresExplicitUserAction: true;
      };
    };
  };
};

export type ResearchTitleConfirmationArtifact = ResearchTitleConfirmationSnapshot & {
  schemaVersion: 1;
  kind: 'research_title_confirmation';
  artifactId: string;
  createdAt: string;
  presentation?: { autoOpen?: boolean };
};

export const RESEARCH_DIRECTION_LIFECYCLE_STAGE_IDS = [
  'cue_classification',
  'terminology',
  'constraints',
  'evidence_gap_analysis',
  'candidate_comparison',
  'novelty_value_rescan',
  'feasibility_ethics_evaluation',
  'falsifiable_hypotheses_contributions',
  'minimum_viability',
  'provisional_title',
  'project_name_confirmation',
] as const;

export type ResearchDirectionLifecycleStageId = typeof RESEARCH_DIRECTION_LIFECYCLE_STAGE_IDS[number];
export type ResearchDirectionLifecycleStageStatus = 'not_started' | 'needs_input' | 'needs_evidence' | 'blocked' | 'awaiting_confirmation' | 'complete';

export type ResearchDirectionLifecycleState = {
  schemaVersion: 1;
  kind: 'research_direction_lifecycle';
  revision: number;
  createdAt: string;
  updatedAt: string;
  seedInput: ResearchDirectionSeedArtifact['input'];
  seed: ResearchDirectionSeedArtifact['result'];
  assessment?: ResearchDirectionAssessmentSnapshot;
  selectedDirectionId?: string;
  titleConfirmation?: ResearchTitleConfirmationSnapshot;
  checklist: {
    items: Array<{
      id: ResearchDirectionLifecycleStageId;
      status: ResearchDirectionLifecycleStageStatus;
      candidateId?: string;
      evidenceIds: string[];
      constraintIds: string[];
      reasonCodes: string[];
    }>;
    completedStageIds: ResearchDirectionLifecycleStageId[];
    nextStageId?: ResearchDirectionLifecycleStageId;
    status: 'in_progress' | 'blocked' | 'awaiting_title_confirmation' | 'ready_for_explicit_project_name_action';
    projectNameAction: {
      status: 'not_ready' | 'ready_for_explicit_project_action';
      name?: string;
      requiresExplicitUserAction: true;
    };
  };
};

export type ResearchDirectionLifecycleArtifact = {
  schemaVersion: 1;
  kind: 'research_direction_lifecycle';
  artifactId: string;
  createdAt: string;
  operation: 'loaded' | 'saved';
  path?: string;
  created?: boolean;
  persisted?: boolean;
  state?: ResearchDirectionLifecycleState;
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

export type LiteratureResearchArtifact = LiteratureSearchArtifact | LiteratureExpansionArtifact;

/**
 * The original literature artifact contract remains paper-shaped for callers
 * that render maps or inspect `papers`. Direction seeds are a separate panel
 * artifact and are only widened at the panel boundary.
 */
export type ResearchArtifact = LiteratureResearchArtifact;

export type ResearchPanelArtifact =
  | LiteratureResearchArtifact
  | ResearchDirectionSeedArtifact
  | ResearchDirectionAssessmentArtifact
  | ResearchTitleConfirmationArtifact
  | ResearchDirectionLifecycleArtifact;

/**
 * UI-only summary of a completed research tool call. It deliberately keeps
 * the tool's structured identifiers and counters, rather than mirroring a
 * backend artifact contract or treating arbitrary output text as state.
 */
export const RESEARCH_CONFIRMATION_BOUNDARIES = [
  'artifact_invalidation',
  'export',
  'final_title',
  'remote_execution',
  'snapshot',
  'zotero_write',
] as const;

export type ResearchConfirmationBoundary = typeof RESEARCH_CONFIRMATION_BOUNDARIES[number];

export type ResearchToolActivityDetailKey =
  | 'action'
  | 'analysis_id'
  | 'artifact_id'
  | 'count'
  | 'decision'
  | 'job_id'
  | 'job_status'
  | 'operation'
  | 'plan_id'
  | 'revision'
  | 'status';

export type ResearchToolActivity = {
  schemaVersion: 1;
  kind: 'research_tool_activity';
  artifactId: string;
  createdAt: string;
  toolName: string;
  status: 'complete' | 'attention' | 'requires_confirmation';
  details: Array<{
    key: ResearchToolActivityDetailKey;
    value: string;
  }>;
  confirmationBoundaries: ResearchConfirmationBoundary[];
};

export type ResearchPanelEntry = ResearchPanelArtifact | ResearchToolActivity;

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

export type ZoteroTagsResult = {
  provider?: 'zotero';
  available?: boolean;
  disabled?: boolean;
  error?: string;
  collectionKey?: string;
  tags: string[];
  total: number;
  start: number;
  nextStart?: number;
  truncated: boolean;
  query?: string;
};

/** The renderer receives only an outcome, never the attachment's local path. */
export type ZoteroAttachmentOpenResult = {
  opened: boolean;
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

export function isResearchArtifact(value: unknown): value is ResearchPanelArtifact {
  if (isResearchDirectionSeedArtifact(value)) return true;
  if (isResearchDirectionAssessmentArtifact(value)) return true;
  if (isResearchTitleConfirmationArtifact(value)) return true;
  if (isResearchDirectionLifecycleArtifact(value)) return true;
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

export function isResearchPanelEntry(value: unknown): value is ResearchPanelEntry {
  return isResearchArtifact(value) || isResearchToolActivity(value);
}

export function isResearchToolActivity(value: unknown): value is ResearchToolActivity {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== 'research_tool_activity'
    || !isNonEmptyString(value.artifactId)
    || !isNonEmptyString(value.createdAt)
    || !isNonEmptyString(value.toolName)
    || (value.status !== 'complete' && value.status !== 'attention' && value.status !== 'requires_confirmation')
    || !Array.isArray(value.details)
    || !value.details.every(isResearchToolActivityDetail)
    || !Array.isArray(value.confirmationBoundaries)
    || !value.confirmationBoundaries.every(isResearchConfirmationBoundary)) {
    return false;
  }
  return new Set(value.confirmationBoundaries).size === value.confirmationBoundaries.length;
}

function isResearchToolActivityDetail(value: unknown): value is ResearchToolActivity['details'][number] {
  return isRecord(value)
    && typeof value.key === 'string'
    && [
      'action',
      'analysis_id',
      'artifact_id',
      'count',
      'decision',
      'job_id',
      'job_status',
      'operation',
      'plan_id',
      'revision',
      'status',
    ].includes(value.key)
    && isNonEmptyString(value.value);
}

function isResearchConfirmationBoundary(value: unknown): value is ResearchConfirmationBoundary {
  return typeof value === 'string' && RESEARCH_CONFIRMATION_BOUNDARIES.includes(
    value as ResearchConfirmationBoundary,
  );
}

export function isResearchDirectionSeedArtifact(value: unknown): value is ResearchDirectionSeedArtifact {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== 'research_direction_seed'
    || !isNonEmptyString(value.artifactId)
    || !isNonEmptyString(value.createdAt)
    || !isRecord(value.input)
    || !isRecord(value.result)
    || !Array.isArray(value.input.cues)
    || !value.input.cues.every(isResearchDirectionCue)
    || !Array.isArray(value.input.candidates)
    || !value.input.candidates.every(isResearchDirectionCandidateInput)
    || !Array.isArray(value.result.cues)
    || !value.result.cues.every(isResearchDirectionCue)
    || !Array.isArray(value.result.terminology)
    || !value.result.terminology.every(isResearchDirectionTerminology)
    || !Array.isArray(value.result.constraints)
    || !value.result.constraints.every(isResearchDirectionConstraint)
    || !isResearchDirectionConstraintCoverage(value.result.constraintCoverage)
    || !Array.isArray(value.result.candidateDirections)
    || !value.result.candidateDirections.every(isResearchDirectionCandidate)
    || (value.presentation !== undefined
      && (!isRecord(value.presentation)
        || (value.presentation.autoOpen !== undefined && typeof value.presentation.autoOpen !== 'boolean')))) {
    return false;
  }
  return value.input.cues.length > 0
    && value.input.candidates.length > 0
    && value.result.cues.length > 0
    && value.result.candidateDirections.length > 0;
}

function isResearchDirectionCue(value: unknown): value is ResearchDirectionCue {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && (value.kind === 'interest'
      || value.kind === 'question'
      || value.kind === 'paper'
      || value.kind === 'algorithm'
      || value.kind === 'data'
      || value.kind === 'experiment_observation')
    && isNonEmptyString(value.text)
    && isOptionalString(value.sourceReference);
}

function isResearchDirectionTerminology(value: unknown): value is ResearchDirectionSeedArtifact['result']['terminology'][number] {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.text)
    && isStringArray(value.cueIds)
    && hasUniqueStrings(value.cueIds)
    && (value.status === undefined || value.status === 'observed' || value.status === 'inferred');
}

function isResearchDirectionConstraint(value: unknown): value is NonNullable<ResearchDirectionSeedArtifact['input']['constraints']>[number] {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && (value.kind === 'venue'
      || value.kind === 'time'
      || value.kind === 'data'
      || value.kind === 'compute'
      || value.kind === 'ethics'
      || value.kind === 'baseline'
      || value.kind === 'evaluation')
    && isNonEmptyString(value.label)
    && (value.status === 'satisfied' || value.status === 'unknown' || value.status === 'blocked')
    && (value.required === undefined || typeof value.required === 'boolean')
    && isStringArray(value.cueIds)
    && hasUniqueStrings(value.cueIds);
}

function isResearchDirectionConstraintCoverage(value: unknown): value is ResearchDirectionSeedArtifact['result']['constraintCoverage'] {
  return isRecord(value)
    && (value.status === 'not_provided' || value.status === 'unresolved' || value.status === 'specified')
    && isStringArray(value.suppliedConstraintIds)
    && isStringArray(value.unresolvedConstraintIds)
    && hasUniqueStrings(value.suppliedConstraintIds)
    && hasUniqueStrings(value.unresolvedConstraintIds);
}

function isResearchDirectionDraft(value: unknown): value is ResearchDirectionDraft {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.statement)
    && isStringArray(value.cueIds)
    && hasUniqueStrings(value.cueIds)
    && (value.terminologyIds === undefined || (isStringArray(value.terminologyIds) && hasUniqueStrings(value.terminologyIds)))
    && (value.constraintIds === undefined || (isStringArray(value.constraintIds) && hasUniqueStrings(value.constraintIds)));
}

function isResearchDirectionCandidateInput(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.summary)
    && isStringArray(value.cueIds)
    && hasUniqueStrings(value.cueIds)
    && (value.terminologyIds === undefined || (isStringArray(value.terminologyIds) && hasUniqueStrings(value.terminologyIds)))
    && (value.constraintIds === undefined || (isStringArray(value.constraintIds) && hasUniqueStrings(value.constraintIds)))
    && (value.hypotheses === undefined || (Array.isArray(value.hypotheses) && value.hypotheses.every(isResearchDirectionDraft)))
    && (value.contributions === undefined || (Array.isArray(value.contributions) && value.contributions.every(isResearchDirectionDraft)))
    && isOptionalString(value.titleSeed)
    && isOptionalString(value.neutralTitle);
}

function isResearchDirectionCandidate(value: unknown): value is ResearchDirectionCandidate {
  if (!isResearchDirectionCandidateInput(value)
    || !Array.isArray(value.hypotheses)
    || !Array.isArray(value.contributions)
    || !isRecord(value.provisionalTitle)
    || !isStringArray(value.provisionalTitle.reasonCodes)
    || !isRecord(value.provisionalTitle.confirmation)
    || !isRecord(value.provisionalTitle.confirmation.projectNameUpdate)) return false;
  return isNonEmptyString(value.provisionalTitle.text)
    || value.provisionalTitle.status === 'rejected';
}

export function isResearchDirectionAssessmentArtifact(value: unknown): value is ResearchDirectionAssessmentArtifact {
  return isDirectionArtifactEnvelope(value, 'direction_assessment')
    && isResearchDirectionAssessmentSnapshot(value);
}

export function isResearchTitleConfirmationArtifact(value: unknown): value is ResearchTitleConfirmationArtifact {
  return isDirectionArtifactEnvelope(value, 'research_title_confirmation')
    && isResearchTitleConfirmationSnapshot(value);
}

export function isResearchDirectionLifecycleArtifact(value: unknown): value is ResearchDirectionLifecycleArtifact {
  if (!isDirectionArtifactEnvelope(value, 'research_direction_lifecycle')
    || (value.operation !== 'loaded' && value.operation !== 'saved')
    || (value.path !== undefined && !isNonEmptyString(value.path))
    || (value.created !== undefined && typeof value.created !== 'boolean')
    || (value.persisted !== undefined && typeof value.persisted !== 'boolean')
    || (value.state !== undefined && !isResearchDirectionLifecycleState(value.state))) {
    return false;
  }
  return value.operation === 'loaded'
    || (isNonEmptyString(value.path)
      && typeof value.created === 'boolean'
      && typeof value.persisted === 'boolean'
      && isResearchDirectionLifecycleState(value.state));
}

function isDirectionArtifactEnvelope(value: unknown, kind: string): value is Record<string, unknown> & {
  schemaVersion: 1;
  kind: string;
  artifactId: string;
  createdAt: string;
} {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.kind === kind
    && isNonEmptyString(value.artifactId)
    && isNonEmptyString(value.createdAt)
    && (value.presentation === undefined
      || (isRecord(value.presentation)
        && (value.presentation.autoOpen === undefined || typeof value.presentation.autoOpen === 'boolean')));
}

function isResearchDirectionAssessmentSnapshot(value: unknown): value is ResearchDirectionAssessmentSnapshot {
  if (!isRecord(value)
    || !isResearchDirectionAssessmentInput(value.input)
    || !isRecord(value.result)
    || !isRecord(value.result.limits)
    || Object.keys(value.result.limits).length === 0
    || !Object.values(value.result.limits).every(isNonNegativeFiniteNumber)
    || !isStringArray(value.result.rankedDirectionIds)
    || !hasUniqueStrings(value.result.rankedDirectionIds)
    || !Array.isArray(value.result.assessments)
    || value.result.assessments.length === 0
    || value.result.assessments.length > 24
    || !value.result.assessments.every(isResearchDirectionAssessment)) {
    return false;
  }
  const assessmentIds = value.result.assessments.map((assessment) => assessment.directionId);
  const rankedDirectionIds = value.result.rankedDirectionIds;
  return hasUniqueStrings(assessmentIds)
    && assessmentIds.length === rankedDirectionIds.length
    && value.result.assessments.every((assessment, index) => assessment.rank === index + 1)
    && assessmentIds.every((id, index) => rankedDirectionIds[index] === id);
}

function isResearchDirectionAssessmentInput(value: unknown): value is ResearchDirectionAssessmentInput {
  return isRecord(value)
    && Array.isArray(value.candidates)
    && value.candidates.length > 0
    && value.candidates.length <= 24
    && value.candidates.every(isResearchDirectionAssessmentCandidateInput)
    && (value.evidence === undefined
      || (Array.isArray(value.evidence) && value.evidence.length <= 320 && value.evidence.every(isResearchDirectionEvidence)))
    && (value.constraints === undefined
      || (Array.isArray(value.constraints) && value.constraints.length <= 64 && value.constraints.every(isResearchDirectionAssessmentConstraint)))
    && (value.targetConferences === undefined
      || (Array.isArray(value.targetConferences) && value.targetConferences.length <= 16 && value.targetConferences.every(isResearchDirectionTargetConferenceInput)));
}

function isResearchDirectionAssessmentCandidateInput(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.summary)
    && isOptionalString(value.titleSeed)
    && isOptionalUniqueStringArray(value.evidenceIds)
    && isOptionalUniqueStringArray(value.constraintIds)
    && isOptionalUniqueStringArray(value.targetConferenceIds)
    && (value.caveats === undefined
      || (Array.isArray(value.caveats) && value.caveats.length <= 12 && value.caveats.every(isResearchDirectionCaveatInput)))
    && (value.hypotheses === undefined
      || (Array.isArray(value.hypotheses) && value.hypotheses.length <= 8 && value.hypotheses.every(isResearchDirectionHypothesisInput)));
}

function isResearchDirectionCaveatInput(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.summary)
    && (value.severity === 'low' || value.severity === 'medium' || value.severity === 'high')
    && isOptionalUniqueStringArray(value.evidenceIds);
}

function isResearchDirectionHypothesisInput(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.statement)
    && isOptionalString(value.failureCriterion)
    && isOptionalString(value.evaluationConstraintId)
    && isOptionalUniqueStringArray(value.evidenceIds)
    && isOptionalUniqueStringArray(value.baselineConstraintIds);
}

function isResearchDirectionEvidence(value: unknown): value is ResearchDirectionEvidence {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.paperId)
    && (value.role === 'prior_art'
      || value.role === 'gap'
      || value.role === 'method'
      || value.role === 'result'
      || value.role === 'limitation'
      || value.role === 'data'
      || value.role === 'baseline'
      || value.role === 'evaluation'
      || value.role === 'ethics'
      || value.role === 'venue')
    && isNonEmptyString(value.statement)
    && (value.strength === undefined || value.strength === 'direct' || value.strength === 'indirect');
}

function isResearchDirectionAssessmentConstraint(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && (value.kind === 'venue'
      || value.kind === 'time'
      || value.kind === 'data'
      || value.kind === 'compute'
      || value.kind === 'ethics'
      || value.kind === 'baseline'
      || value.kind === 'evaluation')
    && isNonEmptyString(value.label)
    && (value.status === 'satisfied' || value.status === 'unknown' || value.status === 'blocked')
    && (value.required === undefined || typeof value.required === 'boolean')
    && isOptionalUniqueStringArray(value.evidenceIds);
}

function isResearchDirectionTargetConferenceInput(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.name)
    && isOptionalString(value.deadline)
    && (value.status === 'satisfied' || value.status === 'unknown' || value.status === 'blocked')
    && isOptionalUniqueStringArray(value.evidenceIds);
}

function isResearchDirectionAssessment(value: unknown): value is ResearchDirectionAssessment {
  return isRecord(value)
    && isPositiveFiniteNumber(value.rank)
    && Number.isInteger(value.rank)
    && isNonEmptyString(value.directionId)
    && isNonEmptyString(value.summary)
    && isResearchDirectionScore(value.score)
    && isRecord(value.novelty)
    && (value.novelty.status === 'gap_evidenced' || value.novelty.status === 'not_established')
    && isResearchDirectionTrace(value.novelty)
    && Array.isArray(value.caveats)
    && value.caveats.every(isAssessedResearchDirectionCaveat)
    && Array.isArray(value.falsifiableHypotheses)
    && value.falsifiableHypotheses.every(isAssessedResearchDirectionHypothesis)
    && Array.isArray(value.targetConferences)
    && value.targetConferences.every(isAssessedResearchDirectionTargetConference)
    && Array.isArray(value.unmetEvidenceGaps)
    && value.unmetEvidenceGaps.every(isResearchDirectionEvidenceGap)
    && isResearchDirectionMinimumViability(value.minimumViability)
    && isResearchDirectionProvisionalTitle(value.provisionalTitle)
    && Array.isArray(value.conclusions)
    && value.conclusions.every(isResearchDirectionConclusion);
}

function isResearchDirectionScore(value: unknown): boolean {
  return isRecord(value)
    && isResearchDirectionTrace(value)
    && isFiniteNumber(value.total)
    && isFiniteNumber(value.evidence)
    && isFiniteNumber(value.feasibility)
    && isFiniteNumber(value.testability)
    && isFiniteNumber(value.gapOpportunity)
    && isFiniteNumber(value.caveatPenalty)
    && isFiniteNumber(value.blockerPenalty);
}

function isResearchDirectionTrace(value: unknown): value is Record<string, unknown> & ResearchDirectionTrace {
  return isRecord(value)
    && isStringArray(value.evidenceIds)
    && hasUniqueStrings(value.evidenceIds)
    && isStringArray(value.paperIds)
    && hasUniqueStrings(value.paperIds)
    && isStringArray(value.constraintIds)
    && hasUniqueStrings(value.constraintIds);
}

function isAssessedResearchDirectionCaveat(value: unknown): boolean {
  return isRecord(value)
    && isResearchDirectionTrace(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.summary)
    && (value.severity === 'low' || value.severity === 'medium' || value.severity === 'high')
    && (value.status === 'cited' || value.status === 'needs_evidence');
}

function isAssessedResearchDirectionHypothesis(value: unknown): boolean {
  return isRecord(value)
    && isResearchDirectionTrace(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.statement)
    && isOptionalString(value.failureCriterion)
    && (value.status === 'ready' || value.status === 'needs_evidence' || value.status === 'needs_design' || value.status === 'blocked');
}

function isAssessedResearchDirectionTargetConference(value: unknown): boolean {
  return isRecord(value)
    && isResearchDirectionTrace(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.name)
    && isOptionalString(value.deadline)
    && (value.status === 'satisfied' || value.status === 'unknown' || value.status === 'blocked');
}

function isResearchDirectionEvidenceGap(value: unknown): boolean {
  return isRecord(value)
    && isResearchDirectionTrace(value)
    && isNonEmptyString(value.code)
    && (value.severity === 'required' || value.severity === 'advisory')
    && isOptionalString(value.hypothesisId)
    && isOptionalString(value.caveatId)
    && isOptionalString(value.relatedId);
}

function isResearchDirectionConclusion(value: unknown): boolean {
  return isRecord(value)
    && isResearchDirectionTrace(value)
    && isNonEmptyString(value.code)
    && (value.status === 'supported' || value.status === 'unproven' || value.status === 'blocked')
    && isOptionalString(value.relatedId);
}

function isResearchDirectionMinimumViability(value: unknown): boolean {
  return isRecord(value)
    && (value.status === 'viable' || value.status === 'needs_evidence' || value.status === 'blocked')
    && Array.isArray(value.reasons)
    && value.reasons.every(isResearchDirectionConclusion);
}

function isResearchDirectionProvisionalTitle(value: unknown): value is ResearchDirectionAssessment['provisionalTitle'] {
  if (!isRecord(value)
    || !isResearchDirectionTrace(value)
    || (value.status !== 'accepted' && value.status !== 'downgraded' && value.status !== 'rejected')
    || !isStringArray(value.reasonCodes)
    || !isOptionalString(value.text)) {
    return false;
  }
  return value.status === 'rejected' || isNonEmptyString(value.text);
}

function isResearchTitleConfirmationSnapshot(value: unknown): value is ResearchTitleConfirmationSnapshot {
  if (!isRecord(value)
    || !isRecord(value.input)
    || !isNonEmptyString(value.input.directionId)
    || !isNonEmptyString(value.input.candidateTitle)
    || !Array.isArray(value.input.evidence)
    || value.input.evidence.length > 48
    || !value.input.evidence.every(isResearchDirectionEvidence)
    || !isOptionalString(value.input.neutralTitle)
    || (value.input.confirmed !== undefined && typeof value.input.confirmed !== 'boolean')
    || !isRecord(value.result)
    || value.result.directionId !== value.input.directionId
    || !isResearchDirectionProvisionalTitle(value.result.title)
    || !isResearchTitleConfirmation(value.result.confirmation, value.result.title.text)) {
    return false;
  }
  return true;
}

function isResearchTitleConfirmation(value: unknown, title: unknown): boolean {
  if (!isRecord(value)
    || (value.status !== 'pending' && value.status !== 'confirmed')
    || typeof value.confirmed !== 'boolean'
    || value.confirmed !== (value.status === 'confirmed')
    || !isResearchProjectNameAction(value.projectNameUpdate)) {
    return false;
  }
  return value.confirmed
    ? value.projectNameUpdate.status === 'ready_for_explicit_project_action'
      && isNonEmptyString(title)
      && value.projectNameUpdate.name === title
    : value.projectNameUpdate.status === 'not_ready';
}

function isResearchProjectNameAction(value: unknown): value is {
  status: 'not_ready' | 'ready_for_explicit_project_action';
  name?: string;
  requiresExplicitUserAction: true;
} {
  return isRecord(value)
    && (value.status === 'not_ready' || value.status === 'ready_for_explicit_project_action')
    && isOptionalString(value.name)
    && value.requiresExplicitUserAction === true
    && (value.status === 'not_ready' || isNonEmptyString(value.name));
}

function isResearchDirectionLifecycleState(value: unknown): value is ResearchDirectionLifecycleState {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== 'research_direction_lifecycle'
    || !isPositiveFiniteNumber(value.revision)
    || !Number.isInteger(value.revision)
    || !isNonEmptyString(value.createdAt)
    || !isNonEmptyString(value.updatedAt)
    || !isResearchDirectionSeedInputValue(value.seedInput)
    || !isResearchDirectionSeedResultValue(value.seed)
    || (value.assessment !== undefined && !isResearchDirectionAssessmentSnapshot(value.assessment))
    || (value.selectedDirectionId !== undefined && !isNonEmptyString(value.selectedDirectionId))
    || (value.titleConfirmation !== undefined && !isResearchTitleConfirmationSnapshot(value.titleConfirmation))
    || !isResearchDirectionLifecycleChecklist(value.checklist)) {
    return false;
  }
  const candidateIds = new Set(value.seed.candidateDirections.map((candidate) => candidate.id));
  if (value.selectedDirectionId !== undefined && !candidateIds.has(value.selectedDirectionId)) return false;
  if (value.assessment?.result.assessments.some((assessment) => !candidateIds.has(assessment.directionId))) return false;
  return value.titleConfirmation === undefined
    || (value.selectedDirectionId !== undefined
      && value.titleConfirmation.input.directionId === value.selectedDirectionId
      && value.titleConfirmation.result.directionId === value.selectedDirectionId);
}

function isResearchDirectionSeedInputValue(value: unknown): value is ResearchDirectionSeedArtifact['input'] {
  return isRecord(value)
    && Array.isArray(value.cues)
    && value.cues.length > 0
    && value.cues.every(isResearchDirectionCue)
    && Array.isArray(value.candidates)
    && value.candidates.length > 0
    && value.candidates.every(isResearchDirectionCandidateInput)
    && (value.terminology === undefined
      || (Array.isArray(value.terminology) && value.terminology.every(isResearchDirectionTerminology)))
    && (value.constraints === undefined
      || (Array.isArray(value.constraints) && value.constraints.every(isResearchDirectionConstraint)));
}

function isResearchDirectionSeedResultValue(value: unknown): value is ResearchDirectionSeedArtifact['result'] {
  return isRecord(value)
    && Array.isArray(value.cues)
    && value.cues.length > 0
    && value.cues.every(isResearchDirectionCue)
    && Array.isArray(value.terminology)
    && value.terminology.every(isResearchDirectionTerminology)
    && Array.isArray(value.constraints)
    && value.constraints.every(isResearchDirectionConstraint)
    && isResearchDirectionConstraintCoverage(value.constraintCoverage)
    && Array.isArray(value.candidateDirections)
    && value.candidateDirections.length > 0
    && value.candidateDirections.every(isResearchDirectionCandidate);
}

function isResearchDirectionLifecycleChecklist(value: unknown): boolean {
  if (!isRecord(value)
    || !Array.isArray(value.items)
    || value.items.length !== RESEARCH_DIRECTION_LIFECYCLE_STAGE_IDS.length
    || !value.items.every(isResearchDirectionLifecycleStage)
    || !isStringArray(value.completedStageIds)
    || !hasUniqueStrings(value.completedStageIds)
    || (value.nextStageId !== undefined && !isResearchDirectionLifecycleStageId(value.nextStageId))
    || (value.status !== 'in_progress'
      && value.status !== 'blocked'
      && value.status !== 'awaiting_title_confirmation'
      && value.status !== 'ready_for_explicit_project_name_action')
    || !isResearchProjectNameAction(value.projectNameAction)) {
    return false;
  }
  const itemIds = value.items.map((item) => item.id);
  const completedIds = value.items.filter((item) => item.status === 'complete').map((item) => item.id);
  const reportedCompletedIds = value.completedStageIds;
  const nextItem = value.items.find((item) => item.status !== 'complete');
  return itemIds.every((id, index) => id === RESEARCH_DIRECTION_LIFECYCLE_STAGE_IDS[index])
    && completedIds.length === reportedCompletedIds.length
    && completedIds.every((id, index) => reportedCompletedIds[index] === id)
    && value.nextStageId === nextItem?.id;
}

function isResearchDirectionLifecycleStage(value: unknown): boolean {
  return isRecord(value)
    && isResearchDirectionLifecycleStageId(value.id)
    && (value.status === 'not_started'
      || value.status === 'needs_input'
      || value.status === 'needs_evidence'
      || value.status === 'blocked'
      || value.status === 'awaiting_confirmation'
      || value.status === 'complete')
    && isOptionalString(value.candidateId)
    && isStringArray(value.evidenceIds)
    && hasUniqueStrings(value.evidenceIds)
    && isStringArray(value.constraintIds)
    && hasUniqueStrings(value.constraintIds)
    && isStringArray(value.reasonCodes)
    && hasUniqueStrings(value.reasonCodes);
}

function isResearchDirectionLifecycleStageId(value: unknown): value is ResearchDirectionLifecycleStageId {
  return typeof value === 'string'
    && (RESEARCH_DIRECTION_LIFECYCLE_STAGE_IDS as readonly string[]).includes(value);
}

function isOptionalUniqueStringArray(value: unknown): boolean {
  return value === undefined || (isStringArray(value) && hasUniqueStrings(value));
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
    && (value.type === 'citation' || value.type === 'shared_topic' || value.type === 'topic_similarity')
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
