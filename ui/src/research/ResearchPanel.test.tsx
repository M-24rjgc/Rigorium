import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n/config';
import { ResearchPanelProvider } from '../contexts/ResearchPanelContext';
import { authenticatedFetch } from '../utils/api';
import ResearchPanel from './ResearchPanel';
import type { ResearchArtifact, ResearchSettings, ZoteroPaperMatch } from './types';

vi.mock('../utils/api', () => ({ authenticatedFetch: vi.fn() }));

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
    if (url === '/api/research/zotero/import') return jsonResponse({ importedCount: 1 });
    return jsonResponse({ error: `Unexpected request: ${url}` }, 500);
  });
}

describe('ResearchPanel', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.mocked(authenticatedFetch).mockReset();
    installFetchMock();
  });

  it('renders real source data, a non-empty graph, and requires confirmation before Zotero import', async () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <ResearchPanelProvider>
          <ResearchPanel artifact={artifact} projectPath="D:/project" />
        </ResearchPanelProvider>
      </I18nextProvider>,
    );

    expect(screen.getByText('OpenAlex')).not.toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelectorAll('svg line').length).toBeGreaterThan(0);
    const saveButton = screen.getByRole('button', { name: /Save to Zotero|收藏到 Zotero/i }) as HTMLButtonElement;
    await waitFor(() => expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => url === '/api/research/zotero/match')).toBe(true));
    await waitFor(() => expect(saveButton.disabled).toBe(false));

    fireEvent.click(saveButton);
    expect(screen.getByText(/Write to Zotero|确认写入 Zotero/)).not.toBeNull();
    expect(screen.getByText(/This modifies Desktop Selection|这会修改 Desktop Selection/i)).not.toBeNull();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => url === '/api/research/zotero/import')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Confirm import|确认写入/ }));
    await waitFor(() => expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => url === '/api/research/zotero/import')).toBe(true));
    const importCall = vi.mocked(authenticatedFetch).mock.calls.find(([url]) => url === '/api/research/zotero/import');
    expect(importCall?.[0]).toBe('/api/research/zotero/import');
    expect(requestBody(importCall)).toContain('"confirmed":true');
    expect(requestBody(importCall)).not.toContain('collectionKey');
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
});
