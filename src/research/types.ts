export type ResearchSettingsScope = "global" | "project";

export type ResearchSettings = {
  schemaVersion: 1;
  literature: {
    enabled: boolean;
    sources: {
      openalex: {
        enabled: boolean;
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
  sourceId: string;
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
  matchPapers(input: { papers: ResearchPaper[]; collectionKey?: string }): Promise<ZoteroPaperMatch[]>;
  importPapers(input: { papers: ResearchPaper[]; confirmed: boolean }): Promise<LibraryImportResult>;
}
