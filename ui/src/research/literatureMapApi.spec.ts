import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../utils/api';
import { updateProjectLiteratureMap } from './literatureMapApi';

vi.mock('../utils/api', () => ({ authenticatedFetch: vi.fn() }));

describe('literature map API', () => {
  afterEach(() => vi.mocked(authenticatedFetch).mockReset());

  it('normalizes legacy paper fields before sending a project-map update', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(JSON.stringify({
      map: { mapId: 'project-literature-map', revision: 1, nodes: [] },
      seedPaperId: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await updateProjectLiteratureMap('D:/project', 'project-literature-map', {
      origin: 'search',
      papers: [{
        id: 'W1',
        title: 'Legacy paper',
        authors: ['Ada Lovelace'],
        citedByCount: 2,
        topics: [],
        sourceId: 'openalex',
        provenance: [
          {
            sourceId: 'openalex',
            sourceRecordId: 'W1',
            rank: undefined,
            retrievedAt: '2026-07-23T00:00:00.000Z',
          },
          {
            sourceId: 'openalex',
            sourceRecordId: 'W1',
            rank: 4,
            retrievedAt: '2026-07-23T00:00:00.000Z',
          },
        ],
      }],
    });

    const [, init] = vi.mocked(authenticatedFetch).mock.calls[0] ?? [];
    const body = JSON.parse(String(init && typeof init === 'object' && 'body' in init ? init.body : ''));
    expect(body.update.papers[0]).toMatchObject({
      identity: {},
      referencedWorkIds: [],
      sourceIds: ['openalex'],
    });
    expect(body.update.papers[0].provenance.map((entry: { rank: number }) => entry.rank)).toEqual([1, 4]);
  });
});
