import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n/config';
import { ResearchPanelProvider } from '../contexts/ResearchPanelContext';
import { authenticatedFetch } from '../utils/api';
import { CHAT_DRAFT_INSERT_EVENT } from '../utils/chatDraftInsertion';
import ResearchPanel from './ResearchPanel';
import { directedEdgeEndpoints, RESEARCH_CITATION_MARKER_BUFFER } from './graphGeometry';
import {
  directionAssessmentArtifact,
  directionLifecycleArtifact,
  directionSeedArtifact,
  titleConfirmationArtifact,
} from './directionArtifacts.fixtures';
import {
  isResearchArtifact,
  type ResearchPanelArtifact,
  type ResearchArtifact,
  type ResearchSettings,
  type ZoteroCloudWriteIntent,
  type ZoteroCloudWritePlan,
  type ZoteroPaperMatch,
} from './types';

vi.mock('../utils/api', () => ({ authenticatedFetch: vi.fn() }));

const literatureMapApiMocks = vi.hoisted(() => ({
  loadProjectLiteratureMap: vi.fn(),
  updateProjectLiteratureMap: vi.fn(),
  setProjectLiteratureMapNodeState: vi.fn(),
  setProjectLiteratureMapSeed: vi.fn(),
  runProjectLiteratureMapMaintenance: vi.fn(),
  loadProjectLiteratureMapMaintenanceAudits: vi.fn(),
}));

vi.mock('./literatureMapApi', () => literatureMapApiMocks);

let cloudPreview: ReturnType<typeof vi.fn>;
let cloudConfirm: ReturnType<typeof vi.fn>;
let libraryImport: ReturnType<typeof vi.fn>;
let libraryOpenAttachment: ReturnType<typeof vi.fn>;

const artifact: ResearchArtifact = {
  schemaVersion: 1,
  kind: 'literature_search',
  artifactId: 'literature-panel-test',
  createdAt: '2026-07-22T00:00:00.000Z',
  intent: { text: 'research agents' },
  plan: { query: 'research agents', limit: 2, sort: 'relevance', sourceIds: ['openalex'] },
  papers: [
    {
      id: 'W1',
      title: 'First research paper',
      authors: ['Ada Lovelace'],
      year: 2025,
      url: 'https://example.test/first',
      citedByCount: 12,
      topics: [{ id: 'T1', name: 'Agents' }],
      sourceId: 'openalex',
    },
    {
      id: 'W2',
      title: 'Second research paper',
      authors: ['Grace Hopper'],
      year: 2024,
      citedByCount: 5,
      topics: [{ id: 'T1', name: 'Agents' }],
      sourceId: 'openalex',
    },
  ],
  edges: [{ id: 'edge', source: 'W1', target: 'W2', type: 'citation', weight: 1, inferred: false }],
  sources: [{
    id: 'openalex',
    name: 'OpenAlex',
    status: 'ok',
    retrievedAt: '2026-07-22T00:00:00.000Z',
    resultCount: 2,
    coverage: 'Ranked metadata results.',
  }],
  coverage: { status: 'complete', resultCount: 2, warnings: [] },
  presentation: { autoOpen: true },
};

const multiSourceArtifact: ResearchArtifact = {
  ...artifact,
  artifactId: 'literature-panel-multi-source-test',
  plan: { ...artifact.plan, sourceIds: ['openalex', 'crossref'] },
  papers: [
    {
      ...artifact.papers[0],
      sourceIds: ['openalex', 'crossref'],
      provenance: [
        {
          sourceId: 'openalex',
          sourceRecordId: 'W1',
          rank: 1,
          retrievedAt: '2026-07-22T00:00:00.000Z',
          queryUrl: 'https://api.openalex.org/works?search=research+agents',
        },
        {
          sourceId: 'crossref',
          sourceRecordId: '10.1000/first',
          rank: 4,
          retrievedAt: '2026-07-22T00:00:03.000Z',
          queryUrl: 'https://api.crossref.org/works?query=research+agents',
        },
      ],
    },
    artifact.papers[1],
  ],
  sources: [
    artifact.sources[0],
    {
      id: 'crossref',
      name: 'Crossref',
      status: 'error',
      retrievedAt: '2026-07-22T00:00:03.000Z',
      queryUrl: 'https://api.crossref.org/works?query=research+agents',
      resultCount: 0,
      coverage: 'Publisher metadata query was interrupted before all pages were read.',
      error: 'Crossref responded with HTTP 429 (rate limited).',
    },
  ],
  coverage: {
    status: 'partial',
    resultCount: 2,
    warnings: ['Crossref was rate limited; results may be incomplete.'],
    requestedSourceIds: ['openalex', 'crossref'],
    successfulSourceIds: ['openalex'],
    failedSourceIds: ['crossref'],
  },
};

const queryVariantArtifact: ResearchArtifact = {
  ...artifact,
  artifactId: 'literature-panel-query-variant-test',
  plan: {
    ...artifact.plan,
    queryVariants: [
      { id: 'primary', query: 'research agents', requestLimit: 2, category: 'primary' },
      {
        id: 'alternative-1',
        query: 'agentic systems',
        requestLimit: 2,
        category: 'adjacent_field',
        rationale: 'Common adjacent terminology',
      },
    ],
  },
  sources: [{
    ...artifact.sources[0],
    resultCount: 1,
    coverage: '1/2 query variants returned usable OpenAlex results.',
    warnings: ['Query variant alternative-1: HTTP 400'],
    rateLimit: {
      limit: 1000,
      remaining: 998,
      resetSeconds: 60,
      costUsd: 0.001,
      remainingUsd: 0.0998,
    },
  }],
  queryAudit: [
    {
      ...artifact.sources[0],
      queryVariantId: 'primary',
      queryUrl: 'https://api.openalex.org/works?search=research+agents',
      resultCount: 1,
      rateLimit: {
        limit: 1000,
        remaining: 998,
        resetSeconds: 60,
        costUsd: 0.001,
        remainingUsd: 0.0998,
      },
    },
    {
      ...artifact.sources[0],
      queryVariantId: 'alternative-1',
      status: 'error',
      queryUrl: 'https://api.openalex.org/works?search=agentic+systems',
      resultCount: 0,
      coverage: 'OpenAlex did not return usable results for this request.',
      error: 'OpenAlex API error (400): alternate unavailable',
    },
  ],
  coverage: {
    status: 'partial',
    resultCount: 1,
    warnings: ['Query variant alternative-1 failed.'],
    requestedSourceIds: ['openalex'],
    successfulSourceIds: ['openalex'],
    failedSourceIds: [],
  },
};

const terminologyArtifact: ResearchArtifact = {
  ...queryVariantArtifact,
  artifactId: 'literature-panel-terminology-test',
  terminology: {
    sourcePaperIds: ['W1', 'W2'],
    totalCandidateCount: 3,
    truncated: false,
    candidates: [
      {
        id: 'openalex:observed_keyword:https://openalex.org/keywords/agentic-systems',
        text: 'Agentic systems',
        kind: 'observed_keyword',
        supportingPaperIds: ['W1'],
        totalEvidenceCount: 1,
        evidenceTruncated: false,
        observationTruncation: [{
          supportingPaperId: 'W1',
          queryVariantId: 'primary',
          providerField: 'keywords',
          scoreThreshold: 0.3,
          perPaperLimit: 8,
          sourceRecordCount: 3,
          validRecordCount: 2,
          eligibleCount: 1,
          retainedCount: 1,
          filteredByScoreCount: 1,
          invalidRecordCount: 1,
          truncatedByLimit: false,
        }],
        evidence: [{
          supportingPaperId: 'W1',
          queryVariantId: 'primary',
          retrievalUrl: 'https://api.openalex.org/works?search=research+agents',
          retrievedAt: '2026-07-22T00:00:00.000Z',
          providerScore: 0.91,
          providerId: 'openalex',
          providerRecordId: 'https://openalex.org/keywords/agentic-systems',
          providerUrl: 'https://openalex.org/keywords/agentic-systems',
          providerField: 'keywords',
        }],
      },
      {
        id: 'openalex:observed_topic:https://openalex.org/T1',
        text: 'Autonomous research agents',
        kind: 'observed_topic',
        supportingPaperIds: ['W1'],
        totalEvidenceCount: 1,
        evidenceTruncated: false,
        evidence: [{
          supportingPaperId: 'W1',
          queryVariantId: 'primary',
          retrievalUrl: 'https://api.openalex.org/works?search=research+agents',
          retrievedAt: '2026-07-22T00:00:00.000Z',
          providerScore: 0.82,
          providerId: 'openalex',
          providerRecordId: 'https://openalex.org/T1',
          providerUrl: 'https://openalex.org/T1',
          providerField: 'topics',
        }],
      },
      {
        id: 'openalex:adjacent_field:https://openalex.org/subfields/1702',
        text: 'Artificial Intelligence',
        kind: 'adjacent_field',
        supportingPaperIds: ['W1', 'W2'],
        totalEvidenceCount: 2,
        evidenceTruncated: false,
        inference: {
          basis: 'multi_paper_taxonomy_contrast',
          level: 'subfield',
          coreRecordId: 'https://openalex.org/subfields/1708',
          coreText: 'Hardware and Architecture',
          minimumSupportingPapers: 2,
        },
        evidence: [
          {
            supportingPaperId: 'W1',
            queryVariantId: 'primary',
            retrievalUrl: 'https://api.openalex.org/works?search=research+agents',
            retrievedAt: '2026-07-22T00:00:00.000Z',
            providerScore: 0.77,
            providerId: 'openalex',
            providerRecordId: 'https://openalex.org/subfields/1702',
            providerUrl: 'https://openalex.org/subfields/1702',
            providerField: 'topics.subfield',
          },
          {
            supportingPaperId: 'W2',
            queryVariantId: 'alternative-1',
            retrievalUrl: 'https://api.openalex.org/works?search=agentic+systems',
            retrievedAt: '2026-07-22T00:00:01.000Z',
            providerScore: 0.73,
            providerId: 'openalex',
            providerRecordId: 'https://openalex.org/subfields/1702',
            providerUrl: 'https://openalex.org/subfields/1702',
            providerField: 'topics.subfield',
          },
        ],
      },
    ],
  },
};

const disabledArxivArtifact: ResearchArtifact = {
  ...artifact,
  artifactId: 'literature-panel-arxiv-disabled-test',
  plan: {
    ...artifact.plan,
    sourceIds: ['arxiv'],
    classifications: [{ scheme: 'arxiv', include: ['cs.AI'] }],
  },
  papers: [],
  edges: [],
  sources: [{
    id: 'arxiv',
    name: 'arXiv',
    status: 'disabled',
    retrievedAt: '2026-07-22T00:00:00.000Z',
    resultCount: 0,
    coverage: 'arXiv classification constraints were not searched because arXiv is disabled in Research Settings.',
    warnings: ['arXiv classification constraints were not applied because arXiv is disabled.'],
  }],
  coverage: {
    // This is how artifacts produced before the coverage fix represented a
    // disabled source: as a failed search despite no request being made.
    status: 'failed',
    resultCount: 0,
    warnings: [],
    requestedSourceIds: ['arxiv'],
    successfulSourceIds: [],
    failedSourceIds: ['arxiv'],
  },
};

const arxivArtifact: ResearchArtifact = {
  ...artifact,
  artifactId: 'literature-panel-arxiv-test',
  plan: {
    ...artifact.plan,
    sort: 'cited_by_count',
    sourceIds: ['arxiv'],
    classifications: [{ scheme: 'arxiv', include: ['cs.AI', 'cs.LG'] }],
  },
  papers: [{
    ...artifact.papers[0],
    id: 'arxiv:2607.00001',
    sourceId: 'arxiv',
    sourceIds: ['arxiv'],
    provenance: [{
      sourceId: 'arxiv',
      sourceRecordId: '2607.00001',
      rank: 1,
      retrievedAt: '2026-07-22T00:00:00.000Z',
    }],
  }],
  edges: [],
  sources: [{
    id: 'arxiv',
    name: 'arXiv',
    status: 'ok',
    retrievedAt: '2026-07-22T00:00:00.000Z',
    resultCount: 1,
    coverage: 'Preprint metadata and abstracts were returned.',
    warnings: ['arXiv does not expose cited-by counts; requested ranking was downgraded to relevance.'],
    applied: {
      sort: 'relevance:descending',
      classifications: ['cs.AI', 'cs.LG'],
    },
  }],
  coverage: {
    status: 'complete',
    resultCount: 1,
    warnings: [],
    requestedSourceIds: ['arxiv'],
    successfulSourceIds: ['arxiv'],
    failedSourceIds: [],
  },
};

const expansionArtifact: ResearchArtifact = {
  schemaVersion: 1,
  kind: 'literature_expansion',
  artifactId: 'literature-expansion-panel-test',
  createdAt: '2026-07-22T00:00:00.000Z',
  intent: { text: 'Expand the citation neighborhood of the seed paper.' },
  plan: {
    seed: { openAlexId: 'https://openalex.org/Wseed', title: 'Seed research paper', year: 2025 },
    directions: ['references', 'citations'],
    limitPerDirection: 20,
    sourceIds: ['openalex'],
  },
  seedPaperId: 'Wseed',
  papers: [
    {
      id: 'Wseed',
      title: 'Seed research paper',
      authors: ['Ada Lovelace'],
      year: 2025,
      citedByCount: 12,
      topics: [],
      sourceId: 'openalex',
    },
    {
      id: 'Wreference',
      title: 'Reference paper',
      authors: ['Grace Hopper'],
      year: 2024,
      citedByCount: 5,
      topics: [],
      sourceId: 'openalex',
    },
    {
      id: 'Wciting',
      title: 'Citing paper',
      authors: ['Katherine Johnson'],
      year: 2026,
      citedByCount: 1,
      topics: [],
      sourceId: 'openalex',
    },
  ],
  edges: [
    { id: 'citation:Wseed:Wreference', source: 'Wseed', target: 'Wreference', type: 'citation', weight: 1, inferred: false },
    { id: 'citation:Wciting:Wseed', source: 'Wciting', target: 'Wseed', type: 'citation', weight: 1, inferred: false },
  ],
  sources: [{
    id: 'openalex',
    name: 'OpenAlex',
    status: 'ok',
    retrievedAt: '2026-07-22T00:00:00.000Z',
    resultCount: 3,
    coverage: 'Citation expansion returned a seed and directed citation neighbors.',
  }],
  directions: [
    {
      direction: 'references',
      status: 'ok',
      resultCount: 1,
      requestedCount: 1,
      resolvedCount: 1,
      truncated: false,
    },
    {
      direction: 'citations',
      status: 'partial',
      resultCount: 1,
      totalMatches: 6600,
      truncated: true,
      error: 'Only the first page of citing papers was available.',
      warnings: ['More citing papers are available from OpenAlex.'],
    },
  ],
  coverage: {
    status: 'partial',
    resultCount: 3,
    warnings: ['Citation expansion has partial coverage.'],
    requestedSourceIds: ['openalex'],
    successfulSourceIds: ['openalex'],
    failedSourceIds: [],
  },
  presentation: { autoOpen: true },
};

const researchSettings: ResearchSettings = {
  schemaVersion: 1,
  literature: {
    enabled: true,
    sources: { openalex: { enabled: true, mailto: '' } },
    search: { defaultLimit: 12, fromYear: null, toYear: null, sort: 'relevance' },
    budget: { maxResultsPerSearch: 25, requestTimeoutMs: 20_000 },
    map: { autoOpen: true, autoUpdate: true, showTopicEdges: true },
  },
  zotero: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:23119',
    useSelectedCollection: false,
    collectionKey: 'COLL1',
    collectionName: 'Rigorium',
    cloud: { enabled: false, libraryType: 'user', libraryId: null },
  },
  citation: { style: 'apa', includeDoi: true },
  privacy: { allowRemoteMetadataSearch: true, allowRemoteFullText: false },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestBody(call: readonly unknown[] | undefined): string {
  const options = call?.[1];
  return String(options && typeof options === 'object' && 'body' in options ? options.body : '');
}

const unmatchedMatches: ZoteroPaperMatch[] = artifact.papers.map((paper) => ({
  paperId: paper.id,
  matched: false,
  confidence: 'none',
  reasons: [],
  inCollection: false,
}));

function installFetchMock(
  matches: ZoteroPaperMatch[] = unmatchedMatches,
  options: {
    settings?: ResearchSettings;
    unavailableError?: string;
    collectionResponse?: unknown;
    tagResponse?: unknown;
    tagResponses?: unknown[];
  } = {},
) {
  const effectiveSettings = options.settings ?? researchSettings;
  const tagResponses = options.tagResponses ?? (options.tagResponse === undefined ? [] : [options.tagResponse]);
  let tagResponseIndex = 0;
  vi.mocked(authenticatedFetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith('/api/research/zotero/status')) {
      return jsonResponse({
        provider: 'zotero',
        available: true,
        apiReady: true,
        connectorReady: true,
        checkedAt: '2026-07-22T00:00:00.000Z',
        selectedCollection: { name: 'Desktop Selection' },
      });
    }
    if (url.startsWith('/api/research/settings')) {
      return jsonResponse({ global: effectiveSettings, effective: effectiveSettings, projectOverride: null, paths: { global: 'settings.json' } });
    }
    if (url === '/api/research/zotero/match') {
      return options.unavailableError
        ? jsonResponse({ provider: 'zotero', available: false, error: options.unavailableError, matches })
        : jsonResponse({ provider: 'zotero', available: true, matches });
    }
    if (url.startsWith('/api/research/zotero/tags?')) {
      if (options.unavailableError) {
        return jsonResponse({ provider: 'zotero', available: false, error: options.unavailableError, tags: [], total: 0, start: 0, truncated: false });
      }
      if (tagResponses.length) return jsonResponse(tagResponses[Math.min(tagResponseIndex++, tagResponses.length - 1)]);
      return jsonResponse({
        provider: 'zotero',
        available: true,
        collectionKey: 'COLL1',
        tags: ['Evidence', 'Methods'],
        total: 2,
        start: 0,
        truncated: false,
      });
    }
    if (url.startsWith('/api/research/zotero/items?')) {
      if (options.unavailableError) {
        return jsonResponse({ provider: 'zotero', available: false, error: options.unavailableError, items: [], total: 0, truncated: false });
      }
      if (options.collectionResponse !== undefined) return jsonResponse(options.collectionResponse);
      return jsonResponse({
        provider: 'zotero',
        available: true,
        collection: { key: 'COLL1', name: 'Rigorium' },
        items: [{
          key: 'ZITEM1',
          itemType: 'journalArticle',
          title: 'Saved collection paper',
          creators: ['Katherine Johnson'],
          year: 2023,
          tags: ['Methods'],
          collectionKeys: ['COLL1'],
          identity: { zoteroKey: 'ZITEM1' },
        }],
        total: 1,
        truncated: false,
      });
    }
    if (url.startsWith('/api/research/zotero/items/ATTACHMENT1/fulltext')) {
      return jsonResponse({
        provider: 'zotero',
        available: true,
        attachmentKey: 'ATTACHMENT1',
        content: 'Indexed full text from the local Zotero attachment.',
        indexedPages: 1,
        totalPages: 1,
        indexedChars: 52,
      });
    }
    if (url.startsWith('/api/research/zotero/items/ATTACHMENT2/fulltext')) {
      return jsonResponse({
        provider: 'zotero',
        available: true,
        attachmentKey: 'ATTACHMENT2',
        content: '',
      });
    }
    if (url.startsWith('/api/research/zotero/items/ZITEM1/export')) {
      const format = new URL(`https://example.test${url}`).searchParams.get('format');
      return jsonResponse({
        provider: 'zotero',
        available: true,
        format,
        content: format === 'csl-json'
          ? '[{"id":"ZITEM1","title":"Saved collection paper"}]'
          : '@article{johnson2023saved,\n  title = {Saved collection paper}\n}',
        citation: 'Johnson (2023)',
        bibliography: 'Johnson. Saved collection paper. 2023.',
      });
    }
    if (url.startsWith('/api/research/zotero/items/ZITEM1')) {
      return jsonResponse({
        provider: 'zotero',
        available: true,
        itemKey: 'ZITEM1',
        detail: {
          item: {
            key: 'ZITEM1',
            itemType: 'journalArticle',
            title: 'Saved collection paper',
            creators: ['Katherine Johnson'],
            date: '2023-04-20',
            year: 2023,
            doi: '10.1000/example',
            tags: ['Methods'],
            collectionKeys: ['COLL1'],
            identity: { zoteroKey: 'ZITEM1' },
          },
          tags: ['Methods', 'Research'],
          attachments: [
            { key: 'ATTACHMENT1', itemType: 'attachment', title: 'article.pdf', contentType: 'application/pdf', linkMode: 'imported_file', parentItem: 'ZITEM1' },
            { key: 'ATTACHMENT2', itemType: 'attachment', title: 'scan.pdf', contentType: 'application/pdf', linkMode: 'imported_file', parentItem: 'ZITEM1' },
          ],
          notes: [{ key: 'NOTE1', itemType: 'note', title: 'Reading note', text: 'Local annotation retained in Zotero.', parentItem: 'ZITEM1' }],
          children: [],
        },
      });
    }
    return jsonResponse({ error: `Unexpected request: ${url}` }, 500);
  });
}

const PROJECT_LITERATURE_MAP_ID = 'project-literature-map';

function mapNodesFor(papers: ResearchArtifact['papers'] = artifact.papers) {
  return papers.map((paper, index) => ({
    id: paper.id,
    aliases: [paper.id],
    status: 'candidate' as const,
    position: { x: 120 + index * 100, y: 140, pinned: false },
  }));
}

function mapMutation(
  mapId = PROJECT_LITERATURE_MAP_ID,
  revision = 1,
  seedPaperId: string | null = null,
  nodes = mapNodesFor(),
) {
  return { map: { mapId, revision, nodes }, seedPaperId };
}

function installLiteratureMapMocks() {
  literatureMapApiMocks.loadProjectLiteratureMap.mockResolvedValue({
    map: null,
    lastDiff: null,
    seedPaperId: null,
  });
  literatureMapApiMocks.updateProjectLiteratureMap.mockImplementation(async (
    _projectPath: string,
    mapId: string,
    update: { papers?: ResearchArtifact['papers'] },
    options?: { expectedRevision?: number },
  ) => mapMutation(
    mapId,
    options?.expectedRevision === undefined ? 1 : options.expectedRevision,
    null,
    mapNodesFor(update.papers ?? []),
  ));
  literatureMapApiMocks.setProjectLiteratureMapNodeState.mockImplementation(async (
    _projectPath: string,
    mapId: string,
    _paperId: string,
    _state: unknown,
    options?: { expectedRevision?: number },
  ) => mapMutation(mapId, (options?.expectedRevision ?? 0) + 1));
  literatureMapApiMocks.setProjectLiteratureMapSeed.mockImplementation(async (
    _projectPath: string,
    mapId: string,
    seedPaperId: string | null,
  ) => mapMutation(mapId, 1, seedPaperId));
  literatureMapApiMocks.runProjectLiteratureMapMaintenance.mockResolvedValue({
    maintenanceId: 'maintenance-test',
    trigger: 'natural_language',
    candidateReview: {
      reviewRequired: false,
      newCandidatePaperIds: [],
      pendingCandidatePaperIds: [],
      updatedExistingPaperIds: [],
      zoteroWritePerformed: false,
      snapshotCreated: false,
      destructiveMapChangePerformed: false,
    },
    safety: {
      zoteroWritePerformed: false,
      snapshotCreated: false,
      destructiveMapChangePerformed: false,
      pendingReviewRequired: false,
    },
    sources: [],
    map: null,
    diff: null,
    audit: { path: 'maintenance-audit.json', persisted: true },
  });
  literatureMapApiMocks.loadProjectLiteratureMapMaintenanceAudits.mockResolvedValue({
    path: 'maintenance-audit.json',
    audits: [],
  });
}

describe('ResearchPanel', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.mocked(authenticatedFetch).mockReset();
    literatureMapApiMocks.loadProjectLiteratureMap.mockReset();
    literatureMapApiMocks.updateProjectLiteratureMap.mockReset();
    literatureMapApiMocks.setProjectLiteratureMapNodeState.mockReset();
    literatureMapApiMocks.setProjectLiteratureMapSeed.mockReset();
    literatureMapApiMocks.runProjectLiteratureMapMaintenance.mockReset();
    literatureMapApiMocks.loadProjectLiteratureMapMaintenanceAudits.mockReset();
    installFetchMock();
    installLiteratureMapMocks();
    cloudPreview = vi.fn().mockImplementation(async (intent: ZoteroCloudWriteIntent) => ({
      plan: intent.kind === 'tags'
        ? {
            planId: 'tag-plan-1', preparedAt: '2026-07-22T00:00:00.000Z', library: { type: 'user', id: '1', path: '/users/1' }, libraryVersion: 10,
            requiresConfirmation: true, kind: 'tags', operation: 'replace', itemKey: intent.itemKey, beforeTags: ['Methods', 'Research'], afterTags: intent.tags,
          }
        : {
            planId: 'note-plan-1', preparedAt: '2026-07-22T00:00:00.000Z', library: { type: 'user', id: '1', path: '/users/1' }, libraryVersion: 10,
            requiresConfirmation: true, kind: 'note', operation: intent.operation, parentItemKey: 'ZITEM1', noteKey: intent.noteKey,
          },
    }));
    cloudConfirm = vi.fn().mockImplementation(async (plan: ZoteroCloudWritePlan) => ({
      planId: plan.planId,
      status: 'succeeded',
      executed: true,
      libraryVersion: 11,
    }));
    libraryImport = vi.fn().mockResolvedValue({ importedCount: 1 });
    libraryOpenAttachment = vi.fn().mockResolvedValue({ opened: true });
    Object.defineProperty(window, 'rigoriumZoteroCloud', {
      configurable: true,
      value: {
        status: vi.fn(),
        sync: vi.fn(),
        preview: cloudPreview,
        confirm: cloudConfirm,
      },
    });
    Object.defineProperty(window, 'rigoriumZoteroLibrary', {
      configurable: true,
      value: { importPapers: libraryImport, openAttachment: libraryOpenAttachment },
    });
  });

  it('keeps literature views keyboard-accessible after assigning tab semantics', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    const mapTab = screen.getByRole('tab', { name: /Map|地图/i });
    expect(mapTab.getAttribute('aria-selected')).toBe('true');
    expect(mapTab.getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(mapTab, { key: 'ArrowRight' });
    const papersTab = screen.getByRole('tab', { name: /Papers|论文/i });
    expect(papersTab.getAttribute('aria-selected')).toBe('true');
    expect(papersTab.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(papersTab);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('research-panel-papers-tab');

    fireEvent.keyDown(papersTab, { key: 'End' });
    const collectionTab = screen.getByRole('tab', { name: /Collection|收藏夹/i });
    expect(collectionTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(collectionTab);
  });

  it('renders each explicit confirmation boundary for a research intent', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel activation={{
            query: 'Capture an experiment snapshot, export the PDF, write it to Zotero, and confirm the final title.',
            intents: ['experiment', 'literature', 'manuscript'],
            confirmationBoundaries: ['snapshot', 'export', 'zotero_write', 'final_title'],
            activatedAt: '2026-07-26T00:00:00.000Z',
          }} />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    const boundary = screen.getByTestId('research-confirmation-boundaries');
    expect(boundary.textContent).toContain('Snapshot');
    expect(boundary.textContent).toContain('Export');
    expect(boundary.textContent).toContain('Zotero write');
    expect(boundary.textContent).toContain('Final title');
  });

  it('renders real source data, a non-empty graph, and requires confirmation before Zotero import', async () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    expect(screen.getByTestId('research-source-openalex')).not.toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelectorAll('svg line').length).toBeGreaterThan(0);
    expect(screen.queryByText('Seed paper', { exact: true })).toBeNull();
    const saveButton = screen.getByRole('button', { name: /Save to Zotero|收藏到 Zotero/i }) as HTMLButtonElement;
    await waitFor(() => expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => url === '/api/research/zotero/match')).toBe(true));
    await waitFor(() => expect(saveButton.disabled).toBe(false));

    fireEvent.click(saveButton);
    expect(screen.getByText(/Write to Zotero|确认写入 Zotero/)).not.toBeNull();
    expect(screen.getByText(/This modifies Desktop Selection|这会修改 Desktop Selection/i)).not.toBeNull();
    expect(libraryImport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Confirm import|确认写入/ }));
    await waitFor(() => expect(libraryImport).toHaveBeenCalledTimes(1));
    expect(libraryImport).toHaveBeenCalledWith([expect.objectContaining({ id: 'W1' })], { projectPath: 'D:/project' });
  });

  it('selects map nodes without sending and inserts a structured reference only on explicit action', () => {
    const draftInsert = vi.fn();
    window.addEventListener(CHAT_DRAFT_INSERT_EVENT, draftInsert);

    try {
      render(
        <I18nextProvider i18n={i18n}>
          <ResearchPanelProvider>
            <ResearchPanel artifact={artifact} projectPath="D:/project" />
          </ResearchPanelProvider>
        </I18nextProvider>,
      );

      fireEvent.click(screen.getByTestId('literature-map-node-W2'));
      expect(draftInsert).not.toHaveBeenCalled();

      const markCore = screen.getByRole('button', { name: 'Mark core / 标为核心' });
      expect(markCore.getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(markCore);
      expect(markCore.getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByTestId('literature-map-node-W2').getAttribute('data-paper-states')).toContain('core');

      fireEvent.click(screen.getByRole('button', { name: 'Set seed / 设为种子' }));
      fireEvent.click(screen.getByRole('tab', { name: /Papers|论文/i }));
      expect(screen.getByTestId('research-paper-seed-W2').textContent).toContain('Seed');
      fireEvent.click(screen.getByRole('tab', { name: /Map|地图/i }));

      fireEvent.click(screen.getByRole('button', { name: 'Add to chat / 加入对话' }));
      expect(draftInsert).toHaveBeenCalledTimes(1);
      expect((draftInsert.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(expect.objectContaining({
        source: 'research-literature',
        text: expect.stringContaining('Title: Second research paper'),
      }));
    } finally {
      window.removeEventListener(CHAT_DRAFT_INSERT_EVENT, draftInsert);
    }
  });

  it('auto-merges the artifact and persists classification, seed, and pinned position changes', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    await waitFor(() => expect(literatureMapApiMocks.updateProjectLiteratureMap).toHaveBeenCalledWith(
      'D:/project',
      PROJECT_LITERATURE_MAP_ID,
      { origin: 'search', papers: artifact.papers, edges: artifact.edges },
      undefined,
    ));

    fireEvent.click(screen.getByTestId('literature-map-node-W2'));
    fireEvent.click(screen.getByRole('button', { name: /^Mark core/ }));
    await waitFor(() => expect(literatureMapApiMocks.setProjectLiteratureMapNodeState).toHaveBeenCalledWith(
      'D:/project',
      PROJECT_LITERATURE_MAP_ID,
      'W2',
      { status: 'core' },
      { expectedRevision: 1 },
    ));

    fireEvent.click(screen.getByRole('button', { name: /^Set seed/ }));
    await waitFor(() => expect(literatureMapApiMocks.setProjectLiteratureMapSeed).toHaveBeenCalledWith(
      'D:/project',
      PROJECT_LITERATURE_MAP_ID,
      'W2',
    ));

    const network = screen.getByTestId('literature-map-network');
    Object.defineProperty(network, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    });
    const node = screen.getByTestId('literature-map-node-W2');
    fireEvent.pointerDown(node, { button: 0, pointerId: 7 });
    fireEvent.pointerMove(network, { clientX: 260, clientY: 160, pointerId: 7 });
    fireEvent.pointerUp(network, { pointerId: 7 });

    await waitFor(() => expect(literatureMapApiMocks.setProjectLiteratureMapNodeState.mock.calls.length).toBe(2));
    const [, , , positionState, positionOptions] = literatureMapApiMocks.setProjectLiteratureMapNodeState.mock.calls[1] ?? [];
    expect(positionState).toEqual({ position: { x: expect.any(Number), y: expect.any(Number), pinned: true } });
    expect(positionOptions).toEqual({ expectedRevision: expect.any(Number) });
  });

  it('reloads the latest map after a revision conflict without replaying the local action', async () => {
    const initialNodes = mapNodesFor().map((node) => node.id === 'W2'
      ? { ...node, status: 'relevant' as const, position: { x: 44, y: 55, pinned: true } }
      : node);
    const latestNodes = mapNodesFor().map((node) => node.id === 'W2'
      ? { ...node, status: 'irrelevant' as const, position: { x: 333, y: 222, pinned: true } }
      : node);
    literatureMapApiMocks.loadProjectLiteratureMap
      .mockResolvedValueOnce({
        map: { mapId: PROJECT_LITERATURE_MAP_ID, revision: 4, nodes: initialNodes },
        lastDiff: null,
        seedPaperId: 'W2',
      })
      .mockResolvedValueOnce({
        map: { mapId: PROJECT_LITERATURE_MAP_ID, revision: 5, nodes: latestNodes },
        lastDiff: null,
        seedPaperId: 'W2',
      });
    literatureMapApiMocks.updateProjectLiteratureMap.mockResolvedValueOnce(
      mapMutation(PROJECT_LITERATURE_MAP_ID, 4, 'W2', initialNodes),
    );
    literatureMapApiMocks.setProjectLiteratureMapNodeState.mockRejectedValueOnce(
      new Error('The live literature map has changed since the requested revision.'),
    );

    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    await waitFor(() => expect(literatureMapApiMocks.updateProjectLiteratureMap).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('literature-map-node-W2').getAttribute('data-seed')).toBe('true'));
    fireEvent.click(screen.getByTestId('literature-map-node-W2'));
    fireEvent.click(screen.getByRole('button', { name: /^Mark core/ }));

    await waitFor(() => expect(screen.getByTestId('literature-map-node-W2').getAttribute('data-paper-states')).toContain('irrelevant'));
    expect(screen.getByTestId('literature-map-node-W2').getAttribute('transform')).toBe('translate(333, 222)');
    expect(literatureMapApiMocks.setProjectLiteratureMapNodeState).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toContain('latest state was reloaded');
    expect(literatureMapApiMocks.loadProjectLiteratureMap).toHaveBeenCalledTimes(2);
  });

  it('makes multi-source provenance and partial coverage explicit without relying on color', async () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={multiSourceArtifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    const coverage = screen.getByTestId('research-coverage-summary');
    expect(coverage.textContent).toContain('Partial coverage');
    expect(coverage.textContent).toContain('1 successful');
    expect(coverage.textContent).toContain('1 failed');
    expect(coverage.textContent).toContain('Failed sources: Crossref');

    const crossrefStatus = screen.getByTestId('research-source-crossref');
    expect(crossrefStatus.textContent).toContain('Failed');
    expect(crossrefStatus.textContent).toContain('Error:');
    expect(crossrefStatus.textContent).toContain('HTTP 429');
    expect(crossrefStatus.textContent).toContain('Rate limited.');
    expect(crossrefStatus.textContent).toContain('Retrieved:');

    const provenance = screen.getByTestId('paper-provenance-W1');
    expect(provenance.textContent).toContain('OpenAlex');
    expect(provenance.textContent).toContain('Crossref');
    expect(provenance.textContent).toContain('Record 10.1000/first');
    expect(provenance.textContent).toContain('Rank 4');

    fireEvent.click(screen.getByRole('tab', { name: /Papers|论文/i }));
    expect(screen.getAllByLabelText('Sources: OpenAlex, Crossref').length).toBeGreaterThan(0);

    const panelRoot = container.firstElementChild as HTMLElement;
    expect(panelRoot.className).toContain('min-w-0');
    expect(panelRoot.className).toContain('overflow-x-hidden');
  });

  it('shows every audited query variant and its real retrieval link', () => {
    expect(isResearchArtifact(queryVariantArtifact)).toBe(true);
    expect(isResearchArtifact({
      ...queryVariantArtifact,
      plan: {
        ...queryVariantArtifact.plan,
        queryVariants: [{
          id: 'primary',
          query: 'research agents',
          requestLimit: 2,
          category: 'unsupported_category',
        }],
      },
    })).toBe(false);
    expect(isResearchArtifact({
      ...queryVariantArtifact,
      plan: {
        ...queryVariantArtifact.plan,
        queryVariants: [{
          id: 'primary',
          query: 'research agents',
          requestLimit: 2,
          category: 'adjacent_field',
        }],
      },
    })).toBe(false);
    expect(isResearchArtifact({
      ...queryVariantArtifact,
      plan: {
        ...queryVariantArtifact.plan,
        queryVariants: [{
          id: 'alternative-1',
          query: 'agentic systems',
          requestLimit: 2,
          category: 'primary',
        }],
      },
    })).toBe(false);
    expect(isResearchArtifact({
      ...queryVariantArtifact,
      plan: {
        ...queryVariantArtifact.plan,
        queryVariants: [
          { id: 'primary', query: 'research agents', requestLimit: 2 },
          { id: 'alternative-1', query: 'agentic systems', requestLimit: 2 },
        ],
      },
    })).toBe(true);
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={queryVariantArtifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    const audit = screen.getByTestId('research-query-audit');
    expect(audit.textContent).toContain('Primary query');
    expect(audit.textContent).toContain('research agents');
    expect(audit.textContent).toContain('Alternative query');
    expect(audit.textContent).toContain('agentic systems');
    expect(screen.getByTestId('research-query-category-primary').textContent).toContain('Primary');
    expect(screen.getByTestId('research-query-category-adjacent_field').textContent).toContain('Adjacent field');
    expect(audit.textContent).toContain('Common adjacent terminology');
    expect(audit.textContent).toContain('OpenAlex API error (400)');
    expect(screen.getByTestId('research-query-rate-limit-primary-openalex').textContent).toContain('998 / 1000');
    expect(screen.getByTestId('research-source-rate-limit-openalex').textContent).toContain('998 / 1000');
    const links = screen.getAllByRole('link', { name: /Open query|打开查询/i });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://api.openalex.org/works?search=research+agents',
      'https://api.openalex.org/works?search=agentic+systems',
    ]);
  });

  it('validates and renders evidence-backed terminology without a search action', () => {
    expect(isResearchArtifact(terminologyArtifact)).toBe(true);

    const mismatchedField = structuredClone(terminologyArtifact) as any;
    mismatchedField.terminology.candidates[0].evidence[0].providerField = 'topics';
    expect(isResearchArtifact(mismatchedField)).toBe(false);

    const unknownSupportingPaper = structuredClone(terminologyArtifact) as any;
    unknownSupportingPaper.terminology.candidates[0].supportingPaperIds = ['missing-paper'];
    unknownSupportingPaper.terminology.candidates[0].evidence[0].supportingPaperId = 'missing-paper';
    expect(isResearchArtifact(unknownSupportingPaper)).toBe(false);

    const privateRetrievalUrl = structuredClone(terminologyArtifact) as any;
    privateRetrievalUrl.terminology.candidates[0].evidence[0].retrievalUrl = 'https://api.openalex.org/works?apiKey=secret';
    expect(isResearchArtifact(privateRetrievalUrl)).toBe(false);

    const inconsistentEvidenceTruncation = structuredClone(terminologyArtifact) as any;
    inconsistentEvidenceTruncation.terminology.candidates[0].totalEvidenceCount = 2;
    inconsistentEvidenceTruncation.terminology.candidates[0].evidenceTruncated = false;
    expect(isResearchArtifact(inconsistentEvidenceTruncation)).toBe(false);

    const staleTerminologySource = structuredClone(terminologyArtifact) as any;
    staleTerminologySource.terminology.candidates = staleTerminologySource.terminology.candidates.slice(0, 2);
    staleTerminologySource.terminology.totalCandidateCount = 2;
    expect(isResearchArtifact(staleTerminologySource)).toBe(false);

    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={terminologyArtifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    const summary = screen.getByTestId('research-terminology-summary');
    expect(summary.textContent).toContain('Observed terminology');
    expect(summary.textContent).toContain('not synonyms or author keywords');
    expect(screen.getByTestId('research-terminology-group-observed_keyword').textContent).toContain('Agentic systems');
    expect(screen.getByTestId('research-terminology-group-observed_topic').textContent).toContain('Autonomous research agents');
    expect(screen.getByTestId('research-terminology-group-adjacent_field').textContent).toContain('Artificial Intelligence');
    expect(screen.getByTestId('research-terminology-inference-0').textContent).toContain('Hardware and Architecture');
    expect(summary.textContent).toContain('1 low-score records excluded');
    expect(screen.queryByRole('button', { name: /search terminology|搜索术语/i })).toBeNull();

    fireEvent.click(screen.getAllByText(/Evidence details|展开证据/i)[0]);
    const openAlexRecord = screen.getAllByRole('link', { name: /OpenAlex record|OpenAlex 记录/i })[0];
    expect(openAlexRecord?.getAttribute('href')).toBe('https://openalex.org/keywords/agentic-systems');
    expect(openAlexRecord?.getAttribute('href')).not.toContain('api_key');
  });

  it('keeps a disabled source out of failure reporting while retaining real failure reporting', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={disabledArxivArtifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    const coverage = screen.getByTestId('research-coverage-summary');
    expect(coverage.textContent).toContain('No sources applied');
    expect(coverage.textContent).toContain('0 successful');
    expect(coverage.textContent).toContain('0 failed');
    expect(coverage.textContent).toContain('1 not applied');
    expect(coverage.textContent).toContain('Not applied: arXiv');
    expect(coverage.textContent).not.toContain('Coverage failed');
    expect(coverage.textContent).not.toContain('Failed sources:');

    const arxivStatus = screen.getByTestId('research-source-arxiv');
    expect(arxivStatus.textContent).toContain('Not applied');
    expect(arxivStatus.textContent).not.toContain('Failed');
    expect(screen.getByTestId('research-source-warnings-arxiv').textContent).toContain(
      'arXiv classification constraints were not applied because arXiv is disabled.',
    );
  });

  it('keeps legacy artifacts valid and shows arXiv provenance, applied constraints, and sort fallbacks', async () => {
    expect(isResearchArtifact(artifact)).toBe(true);
    expect(isResearchArtifact(arxivArtifact)).toBe(true);

    const legacy = render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );
    expect(screen.getByTestId('research-source-openalex')).not.toBeNull();
    legacy.unmount();

    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={arxivArtifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    const arxivStatus = screen.getByTestId('research-source-arxiv');
    expect(arxivStatus.textContent).toContain('arXiv');
    const applied = screen.getByTestId('research-source-applied-arxiv');
    expect(applied.textContent).toContain('Sort: relevance:descending');
    expect(applied.textContent).not.toContain('submittedDate');
    expect(applied.textContent).toContain('Categories: cs.AI, cs.LG');
    expect(applied.className).toContain('min-w-0');
    expect(applied.className).toContain('break-words');
    expect(screen.getByTestId('research-source-warnings-arxiv').textContent).toContain(
      'arXiv does not expose cited-by counts; requested ranking was downgraded to relevance.',
    );

    fireEvent.click(screen.getByRole('tab', { name: /Papers|论文/i }));
    expect(screen.getAllByLabelText('Sources: arXiv').length).toBeGreaterThan(0);
    expect(screen.getByTestId('paper-provenance-arxiv:2607.00001').textContent).toContain('arXiv');
  });

  it('renders a directed citation expansion around its seed without hiding partial-direction results', async () => {
    expect(isResearchArtifact(expansionArtifact)).toBe(true);
    expect(isResearchArtifact({
      ...expansionArtifact,
      seedPaperId: 'missing-seed',
    })).toBe(false);

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={expansionArtifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    expect(screen.getByTestId('research-expansion-seed').textContent).toContain('Seed research paper');
    const seedNode = screen.getByTestId('literature-map-node-Wseed');
    expect(seedNode.getAttribute('aria-label')).toBe('Seed research paper');
    expect(seedNode.getAttribute('data-seed')).toBe('true');
    const directions = screen.getByTestId('research-expansion-directions');
    expect(directions.textContent).toContain('References');
    expect(directions.textContent).toContain('Complete');
    expect(directions.textContent).toContain('1 returned');
    expect(directions.textContent).toContain('1 requested');
    expect(directions.textContent).toContain('1 resolved');
    expect(directions.textContent).toContain('Citations');
    expect(directions.textContent).toContain('Partial');
    expect(directions.textContent).toContain('6600 total');
    expect(directions.textContent).toContain('Truncated');
    expect(directions.textContent).toContain('Only the first page of citing papers was available.');
    expect(directions.className).toContain('min-w-0');

    expect(screen.getByTestId('literature-map-node-Wreference').getAttribute('data-seed')).toBe('false');
    const referenceEdge = screen.getByTestId('literature-map-edge-artifact:citation:Wseed:Wreference');
    expect(referenceEdge.getAttribute('data-source')).toBe('Wseed');
    expect(referenceEdge.getAttribute('data-target')).toBe('Wreference');
    expect(referenceEdge.getAttribute('marker-end')).toContain('literature-map-arrow');
    const citationEdge = screen.getByTestId('literature-map-edge-artifact:citation:Wciting:Wseed');
    expect(citationEdge.getAttribute('data-source')).toBe('Wciting');
    expect(citationEdge.getAttribute('data-target')).toBe('Wseed');
    expect(container.textContent).not.toContain('Shared topic (inferred)');

    fireEvent.click(screen.getByRole('tab', { name: /Papers|文献/i }));
    expect(screen.getByTestId('research-paper-seed-Wseed').textContent).toContain('Seed');
    expect(screen.getByText('Reference paper')).not.toBeNull();
    expect(screen.getByText('Citing paper')).not.toBeNull();
  });

  it('keeps a citation arrow endpoint outside the target node and marker buffer', () => {
    const targetRadius = 14;
    const endpoints = directedEdgeEndpoints(
      { x: 40, y: 90 },
      { x: 280, y: 210 },
      11,
      targetRadius,
    );
    const distanceFromTargetCenter = Math.hypot(280 - endpoints.target.x, 210 - endpoints.target.y);
    expect(distanceFromTargetCenter).toBeGreaterThanOrEqual(targetRadius + RESEARCH_CITATION_MARKER_BUFFER - 1e-8);
    expect(endpoints.source).not.toEqual({ x: 40, y: 90 });
  });

  it('marks matched papers and browses the collection bound in research settings', async () => {
    installFetchMock([
      {
        paperId: 'W1',
        matched: true,
        confidence: 'exact',
        reasons: ['doi'],
        inCollection: true,
        item: {
          key: 'Z1', itemType: 'journalArticle', title: 'First research paper', creators: ['Ada Lovelace'],
          tags: [], collectionKeys: ['COLL1'], identity: { zoteroKey: 'Z1' },
        },
      },
      {
        paperId: 'W2',
        matched: true,
        confidence: 'heuristic',
        reasons: ['title'],
        inCollection: false,
        item: {
          key: 'Z2', itemType: 'journalArticle', title: 'Second research paper', creators: ['Grace Hopper'],
          tags: [], collectionKeys: [], identity: { zoteroKey: 'Z2' },
        },
      },
    ]);

    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole('tab', { name: /Papers|论文/i }));
    expect((await screen.findAllByText(/In collection|已在 Collection/i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Possible Zotero match|可能的 Zotero 匹配/i)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Second research paper/i }));
    const heuristicSaveButton = screen.getByRole('button', { name: /Save to Zotero|收藏到 Zotero/i }) as HTMLButtonElement;
    expect(heuristicSaveButton.disabled).toBe(false);

    const matchCall = vi.mocked(authenticatedFetch).mock.calls.find(([url]) => url === '/api/research/zotero/match');
    expect(requestBody(matchCall)).toContain('"collectionKey":"COLL1"');

    fireEvent.click(screen.getByRole('tab', { name: /^(Collection|收藏夹)$/i }));
    expect(await screen.findByText('Saved collection paper')).not.toBeNull();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => (
      String(url).startsWith('/api/research/zotero/items?') && String(url).includes('collectionKey=COLL1')
    ))).toBe(true);
  });

  it('incrementally merges loaded Zotero collection items into the project map without writing user map state', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    await waitFor(() => expect(literatureMapApiMocks.updateProjectLiteratureMap).toHaveBeenCalledWith(
      'D:/project',
      PROJECT_LITERATURE_MAP_ID,
      { origin: 'search', papers: artifact.papers, edges: artifact.edges },
      undefined,
    ));

    fireEvent.click(screen.getByRole('tab', { name: /^(Collection|收藏夹)$/i }));
    await screen.findByText('Saved collection paper');

    await waitFor(() => expect(literatureMapApiMocks.updateProjectLiteratureMap).toHaveBeenCalledWith(
      'D:/project',
      PROJECT_LITERATURE_MAP_ID,
      {
        origin: 'zotero',
        papers: [expect.objectContaining({
          id: 'zotero:ZITEM1',
          identity: expect.objectContaining({ zoteroKey: 'ZITEM1' }),
          title: 'Saved collection paper',
          authors: ['Katherine Johnson'],
          year: 2023,
          sourceId: 'zotero',
          sourceIds: ['zotero'],
          referencedWorkIds: [],
        })],
      },
      { expectedRevision: 1 },
    ));
    const syncUpdate = literatureMapApiMocks.updateProjectLiteratureMap.mock.calls.find(([, , update]) => update.origin === 'zotero');
    expect(syncUpdate?.[2]).not.toHaveProperty('edges');
    expect(syncUpdate?.[2]).not.toHaveProperty('tombstonePaperIds');
    expect(syncUpdate?.[2]).not.toHaveProperty('restorePaperIds');
    expect(literatureMapApiMocks.setProjectLiteratureMapNodeState).not.toHaveBeenCalled();
    expect(literatureMapApiMocks.setProjectLiteratureMapSeed).not.toHaveBeenCalled();
    expect(screen.getByTestId('zotero-map-sync-notice').textContent).toContain('1 Zotero item merged into the project map.');
  });

  it('merges only normalizable Zotero collection items and traces partial collection results', async () => {
    installFetchMock(unmatchedMatches, {
      collectionResponse: {
        provider: 'zotero',
        available: true,
        collection: { key: 'COLL1', name: 'Rigorium' },
        items: [
          {
            key: 'ZMAP1',
            itemType: 'journalArticle',
            title: 'Map-ready Zotero paper',
            creators: ['Mary Jackson'],
            year: 2024,
            doi: '10.1000/zmap',
            url: 'https://example.test/zmap',
            tags: ['Methods'],
            collectionKeys: ['COLL1'],
            identity: { zoteroKey: 'ZMAP1', doi: '10.1000/zmap' },
          },
          {
            key: 'ZSKIP1',
            itemType: 'journalArticle',
            title: '   ',
            creators: [],
            tags: [],
            collectionKeys: ['COLL1'],
            identity: { zoteroKey: 'ZSKIP1' },
          },
        ],
        total: 3,
        truncated: true,
      },
    });
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    await waitFor(() => expect(literatureMapApiMocks.updateProjectLiteratureMap).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: /^(Collection|收藏夹)$/i }));
    await screen.findByText('Map-ready Zotero paper');

    await waitFor(() => {
      const syncUpdate = literatureMapApiMocks.updateProjectLiteratureMap.mock.calls.find(([, , update]) => update.origin === 'zotero');
      expect(syncUpdate?.[2].papers).toHaveLength(1);
    });
    const syncUpdate = literatureMapApiMocks.updateProjectLiteratureMap.mock.calls.find(([, , update]) => update.origin === 'zotero');
    expect(syncUpdate?.[2].papers?.[0]).toMatchObject({
      id: 'zotero:ZMAP1',
      identity: { zoteroKey: 'ZMAP1', doi: '10.1000/zmap' },
      provenance: [expect.objectContaining({ sourceId: 'zotero', sourceRecordId: 'ZMAP1', rank: 1 })],
    });
    const notice = screen.getByTestId('zotero-map-sync-notice');
    expect(notice.textContent).toContain('1 Zotero item merged into the project map.');
    expect(notice.textContent).toContain('1 collection item was skipped because it could not be normalized.');
    expect(notice.textContent).toContain('Zotero returned a partial collection; only the loaded items were merged.');
  });

  it('shows HTTP-200 Zotero availability failures instead of empty match and collection states', async () => {
    installFetchMock(unmatchedMatches, { unavailableError: 'Zotero Desktop is not running.' });
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    expect(await screen.findByText('Zotero Desktop is not running.')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /^(Collection|收藏夹)$/i }));
    expect((await screen.findAllByText('Zotero Desktop is not running.')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/No items found|没有找到文献/i)).toBeNull();
    expect(literatureMapApiMocks.updateProjectLiteratureMap.mock.calls.some(([, , update]) => update.origin === 'zotero')).toBe(false);
    expect(screen.getByTestId('zotero-map-sync-notice').textContent).toContain('Zotero collection could not be loaded; the project map was not changed.');

    fireEvent.click(screen.getByRole('tab', { name: /^(Papers|文献)$/i }));
    expect(screen.getAllByText('First research paper').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Second research paper').length).toBeGreaterThan(0);
  });

  it('ignores a stale fixed collection key while following the live Zotero selection', async () => {
    const dynamicSettings: ResearchSettings = {
      ...researchSettings,
      zotero: {
        ...researchSettings.zotero,
        useSelectedCollection: true,
        collectionKey: 'STALE1',
        collectionName: 'Stale binding',
      },
    };
    installFetchMock(unmatchedMatches, { settings: dynamicSettings });
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    await waitFor(() => expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => url === '/api/research/zotero/match')).toBe(true));
    const matchCall = vi.mocked(authenticatedFetch).mock.calls.find(([url]) => url === '/api/research/zotero/match');
    expect(requestBody(matchCall)).not.toContain('collectionKey');

    fireEvent.click(screen.getByRole('tab', { name: /^(Collection|收藏夹)$/i }));
    expect(await screen.findByText(/No Zotero collection is bound|尚未绑定 Zotero Collection/i)).not.toBeNull();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).startsWith('/api/research/zotero/items?'))).toBe(false);
  });

  it('loads Zotero details, full text, and citation exports only from explicit collection actions', async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole('tab', { name: /^(Collection|收藏夹)$/i }));
    await screen.findByText('Saved collection paper');
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).includes('/fulltext'))).toBe(false);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).includes('/export'))).toBe(false);
    expect(libraryOpenAttachment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Show details for Saved collection paper/i }));
    expect(await screen.findByText('Metadata')).not.toBeNull();
    expect(screen.getByText('10.1000/example')).not.toBeNull();
    expect(screen.getByText('Research')).not.toBeNull();
    expect(screen.getByText('Reading note')).not.toBeNull();
    expect(screen.getByText('article.pdf')).not.toBeNull();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).startsWith('/api/research/zotero/items/ZITEM1?'))).toBe(true);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).includes('/fulltext'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Open file for article.pdf/i }));
    await waitFor(() => expect(libraryOpenAttachment).toHaveBeenCalledWith(
      'ATTACHMENT1',
      { projectPath: 'D:/project' },
    ));
    expect(await screen.findByText('Local attachment opened.')).not.toBeNull();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).includes('/zotero/items/ATTACHMENT1/file'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Read full text for article.pdf/i }));
    expect(await screen.findByText('Indexed full text from the local Zotero attachment.')).not.toBeNull();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => (
      String(url).startsWith('/api/research/zotero/items/ATTACHMENT1/fulltext?')
      && String(url).includes('projectPath=D%3A%2Fproject')
    ))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Copy BibTeX' }));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith(expect.stringContaining('@article{johnson2023saved')));
    fireEvent.click(screen.getByRole('button', { name: 'Copy CSL-JSON' }));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith(expect.stringContaining('"id":"ZITEM1"')));
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).includes('/export?') && String(url).includes('format=bibtex'))).toBe(true);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).includes('/export?') && String(url).includes('format=csl-json'))).toBe(true);
  });

  it('keeps item metadata and other Zotero detail data visible when an attachment has no indexed full text', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole('tab', { name: /^(Collection|收藏夹)$/i }));
    await screen.findByText('Saved collection paper');
    fireEvent.click(screen.getByRole('button', { name: /Show details for Saved collection paper/i }));
    await screen.findByText('scan.pdf');

    fireEvent.click(screen.getByRole('button', { name: /Read full text for scan.pdf/i }));
    expect(await screen.findByText('No indexed full text is available for this attachment.')).not.toBeNull();
    expect(screen.getByText('10.1000/example')).not.toBeNull();
    expect(screen.getByText('Local annotation retained in Zotero.')).not.toBeNull();
  });

  it('previews Zotero cloud tag edits before an explicit confirmation writes them', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole('tab', { name: /^(Collection|收藏夹)$/i }));
    await screen.findByText('Saved collection paper');
    fireEvent.click(screen.getByRole('button', { name: /Show details for Saved collection paper/i }));
    await screen.findByText('Metadata');
    expect(cloudPreview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Zotero tags' }));
    const tagInput = screen.getByRole('textbox', { name: 'Edit Zotero tags' });
    fireEvent.change(tagInput, { target: { value: 'Methods, Verified' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    expect(await screen.findByRole('button', { name: 'Confirm Zotero change' })).not.toBeNull();

    expect(cloudPreview).toHaveBeenCalledWith(
      { kind: 'tags', itemKey: 'ZITEM1', operation: 'replace', tags: ['Methods', 'Verified'] },
      { projectPath: 'D:/project' },
    );
    expect(cloudConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Zotero change' }));
    expect(await screen.findByText('Zotero changes were applied.')).not.toBeNull();
    expect(cloudConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'tag-plan-1' }),
      { projectPath: 'D:/project' },
    );
  });

  it('browses saved Zotero tags only after tag editing is explicitly opened', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole('tab', { name: /^(Collection|收藏夹)$/i }));
    await screen.findByText('Saved collection paper');
    fireEvent.click(screen.getByRole('button', { name: /Show details for Saved collection paper/i }));
    await screen.findByText('Metadata');
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).includes('/zotero/tags?'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Zotero tags' }));
    expect(await screen.findByTestId('zotero-tag-suggestions')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Add Zotero tag Evidence' })).not.toBeNull();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).includes('/zotero/tags?'))).toBe(true);
    expect(cloudPreview).not.toHaveBeenCalled();
    expect(cloudConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Add Zotero tag Evidence' }));
    expect((screen.getByRole('textbox', { name: 'Edit Zotero tags' }) as HTMLInputElement).value).toContain('Evidence');
    expect(cloudPreview).not.toHaveBeenCalled();
    expect(cloudConfirm).not.toHaveBeenCalled();
  });

  it('loads the next Zotero tag page only after the user requests more suggestions', async () => {
    const firstPageTags = Array.from({ length: 24 }, (_, index) => `Tag ${index + 1}`);
    installFetchMock(unmatchedMatches, {
      tagResponses: [
        {
          provider: 'zotero',
          available: true,
          collectionKey: 'COLL1',
          tags: firstPageTags,
          total: 25,
          start: 0,
          nextStart: 24,
          truncated: true,
        },
        {
          provider: 'zotero',
          available: true,
          collectionKey: 'COLL1',
          tags: ['Tag 25'],
          total: 25,
          start: 24,
          truncated: false,
        },
      ],
    });
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole('tab', { name: /^(Collection|收藏夹)$/i }));
    await screen.findByText('Saved collection paper');
    fireEvent.click(screen.getByRole('button', { name: /Show details for Saved collection paper/i }));
    await screen.findByText('Metadata');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Zotero tags' }));
    await screen.findByRole('button', { name: 'Add Zotero tag Tag 24' });
    expect(screen.queryByRole('button', { name: 'Add Zotero tag Tag 25' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Load more saved tags' }));
    expect(await screen.findByRole('button', { name: 'Add Zotero tag Tag 25' })).not.toBeNull();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => (
      String(url).includes('/zotero/tags?') && String(url).includes('start=24')
    ))).toBe(true);
    expect(cloudPreview).not.toHaveBeenCalled();
    expect(cloudConfirm).not.toHaveBeenCalled();
  });

  it('validates and renders direction assessment, title confirmation, and lifecycle artifacts without rename controls', () => {
    const artifacts: ResearchPanelArtifact[] = [
      directionAssessmentArtifact,
      titleConfirmationArtifact,
      directionLifecycleArtifact,
    ];
    for (const item of artifacts) expect(isResearchArtifact(item)).toBe(true);

    const malformedLifecycle = structuredClone(directionLifecycleArtifact) as any;
    malformedLifecycle.state.checklist.items.pop();
    expect(isResearchArtifact(malformedLifecycle)).toBe(false);

    const malformedTitle = structuredClone(titleConfirmationArtifact) as any;
    malformedTitle.result.confirmation.projectNameUpdate.requiresExplicitUserAction = false;
    expect(isResearchArtifact(malformedTitle)).toBe(false);

    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={directionAssessmentArtifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );
    expect(screen.getByTestId('research-direction-assessment-panel').textContent).toContain('Assessment score 19');
    expect(screen.getByTestId('research-direction-assessment-panel').textContent).toContain('Evaluate calibration interventions under distribution shift.');
    expect(screen.queryByRole('button', { name: /rename|项目名称操作/i })).toBeNull();

    rerender(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={titleConfirmationArtifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );
    expect(screen.getByTestId('research-title-confirmation-panel').textContent).toContain('No Project name is changed here');
    expect(screen.getByTestId('research-title-project-action-note')).not.toBeNull();

    rerender(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={directionLifecycleArtifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );
    expect(screen.getByTestId('research-direction-lifecycle-checklist').querySelectorAll('li')).toHaveLength(11);
    expect(screen.getByTestId('research-direction-lifecycle-panel').textContent).toContain('Direction complete');
    expect(screen.getByTestId('research-lifecycle-project-action').textContent).toContain('No Project name is changed here');
    expect(screen.queryByRole('button', { name: /rename|项目名称操作/i })).toBeNull();

    expect(isResearchArtifact(directionSeedArtifact)).toBe(true);
  });
});
