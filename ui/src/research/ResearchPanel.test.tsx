import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n/config';
import { ResearchPanelProvider } from '../contexts/ResearchPanelContext';
import { authenticatedFetch } from '../utils/api';
import ResearchPanel from './ResearchPanel';
import { directedEdgeEndpoints, RESEARCH_CITATION_MARKER_BUFFER } from './graphGeometry';
import {
  isResearchArtifact,
  type ResearchArtifact,
  type ResearchSettings,
  type ZoteroCloudWriteIntent,
  type ZoteroCloudWritePlan,
  type ZoteroPaperMatch,
} from './types';

vi.mock('../utils/api', () => ({ authenticatedFetch: vi.fn() }));

let cloudPreview: ReturnType<typeof vi.fn>;
let cloudConfirm: ReturnType<typeof vi.fn>;
let libraryImport: ReturnType<typeof vi.fn>;

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
  options: { settings?: ResearchSettings; unavailableError?: string } = {},
) {
  const effectiveSettings = options.settings ?? researchSettings;
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
    if (url.startsWith('/api/research/zotero/items?')) {
      if (options.unavailableError) {
        return jsonResponse({ provider: 'zotero', available: false, error: options.unavailableError, items: [], total: 0, truncated: false });
      }
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

describe('ResearchPanel', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.mocked(authenticatedFetch).mockReset();
    installFetchMock();
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
      value: { importPapers: libraryImport },
    });
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

    fireEvent.click(screen.getByRole('button', { name: /Papers|论文/i }));
    expect(screen.getAllByLabelText('Sources: OpenAlex, Crossref').length).toBeGreaterThan(0);

    const panelRoot = container.firstElementChild as HTMLElement;
    expect(panelRoot.className).toContain('min-w-0');
    expect(panelRoot.className).toContain('overflow-x-hidden');
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

    fireEvent.click(screen.getByRole('button', { name: /Papers|论文/i }));
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
    expect(screen.getByText('Seed paper', { exact: true })).not.toBeNull();
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

    const seedNode = screen.getByTestId('research-graph-node-Wseed');
    expect(seedNode.getAttribute('data-seed')).toBe('true');
    expect(screen.getByTestId('research-graph-node-Wreference').getAttribute('data-seed')).toBe('false');
    const referenceEdge = screen.getByTestId('research-edge-citation:Wseed:Wreference');
    expect(referenceEdge.getAttribute('data-source')).toBe('Wseed');
    expect(referenceEdge.getAttribute('data-target')).toBe('Wreference');
    expect(referenceEdge.getAttribute('marker-end')).toContain('research-arrow');
    const citationEdge = screen.getByTestId('research-edge-citation:Wciting:Wseed');
    expect(citationEdge.getAttribute('data-source')).toBe('Wciting');
    expect(citationEdge.getAttribute('data-target')).toBe('Wseed');
    expect(container.textContent).not.toContain('Shared topic (inferred)');

    fireEvent.click(screen.getByRole('button', { name: /Papers|文献/i }));
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

    fireEvent.click(screen.getByRole('button', { name: /Papers|论文/i }));
    expect((await screen.findAllByText(/In collection|已在 Collection/i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Possible Zotero match|可能的 Zotero 匹配/i)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Second research paper/i }));
    const heuristicSaveButton = screen.getByRole('button', { name: /Save to Zotero|收藏到 Zotero/i }) as HTMLButtonElement;
    expect(heuristicSaveButton.disabled).toBe(false);

    const matchCall = vi.mocked(authenticatedFetch).mock.calls.find(([url]) => url === '/api/research/zotero/match');
    expect(requestBody(matchCall)).toContain('"collectionKey":"COLL1"');

    fireEvent.click(screen.getByRole('button', { name: /^(Collection|收藏夹)$/i }));
    expect(await screen.findByText('Saved collection paper')).not.toBeNull();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => (
      String(url).startsWith('/api/research/zotero/items?') && String(url).includes('collectionKey=COLL1')
    ))).toBe(true);
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
    fireEvent.click(screen.getByRole('button', { name: /^(Collection|收藏夹)$/i }));
    expect((await screen.findAllByText('Zotero Desktop is not running.')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/No items found|没有找到文献/i)).toBeNull();
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

    fireEvent.click(screen.getByRole('button', { name: /^(Collection|收藏夹)$/i }));
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

    fireEvent.click(screen.getByRole('button', { name: /^(Collection|收藏夹)$/i }));
    await screen.findByText('Saved collection paper');
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).includes('/fulltext'))).toBe(false);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).includes('/export'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Show details for Saved collection paper/i }));
    expect(await screen.findByText('Metadata')).not.toBeNull();
    expect(screen.getByText('10.1000/example')).not.toBeNull();
    expect(screen.getByText('Research')).not.toBeNull();
    expect(screen.getByText('Reading note')).not.toBeNull();
    expect(screen.getByText('article.pdf')).not.toBeNull();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).startsWith('/api/research/zotero/items/ZITEM1?'))).toBe(true);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).includes('/fulltext'))).toBe(false);

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

    fireEvent.click(screen.getByRole('button', { name: /^(Collection|收藏夹)$/i }));
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

    fireEvent.click(screen.getByRole('button', { name: /^(Collection|收藏夹)$/i }));
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
});
