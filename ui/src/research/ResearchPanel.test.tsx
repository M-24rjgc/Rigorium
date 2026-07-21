import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n/config';
import { ResearchPanelProvider } from '../contexts/ResearchPanelContext';
import { authenticatedFetch } from '../utils/api';
import ResearchPanel from './ResearchPanel';
import type { ResearchArtifact } from './types';

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

describe('ResearchPanel', () => {
  beforeEach(() => {
    vi.mocked(authenticatedFetch).mockReset();
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(JSON.stringify({
      provider: 'zotero',
      available: true,
      apiReady: true,
      connectorReady: true,
      checkedAt: '2026-07-22T00:00:00.000Z',
      selectedCollection: { name: 'Rigorium' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
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
    await waitFor(() => expect(saveButton.disabled).toBe(false));

    fireEvent.click(saveButton);
    expect(screen.getByText(/Write to Zotero|确认写入 Zotero/)).not.toBeNull();
    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledTimes(1);

    vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response(JSON.stringify({ importedCount: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm import|确认写入/ }));
    await waitFor(() => expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledTimes(2));
    const importCall = vi.mocked(authenticatedFetch).mock.calls[1];
    expect(importCall?.[0]).toBe('/api/research/zotero/import');
    expect(String(importCall?.[1]?.body)).toContain('"confirmed":true');
  });
});
