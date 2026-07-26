import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createMaintenanceProviderFromPayload,
  createZoteroMaintenanceProvider,
  readProjectLiteratureMaintenanceAudits,
  runProjectLiteratureMaintenance,
  zoteroItemToResearchPaper,
} from '../../src/research/literature/maintenance.js';
import type { ZoteroLibraryItem } from '../../src/research/types.js';

const time = () => new Date('2026-07-23T10:00:00.000Z');

function paper(id: string, doi?: string) {
  return {
    id,
    identity: doi ? { doi } : {},
    title: `Paper ${id}`,
    authors: ['Ada Lovelace'],
    year: 2025,
    ...(doi ? { doi } : {}),
    citedByCount: 1,
    topics: [],
    referencedWorkIds: [],
    sourceId: 'search',
    sourceIds: ['search'],
    provenance: [{ sourceId: 'search', sourceRecordId: id, rank: 1, retrievedAt: time().toISOString() }],
  };
}

async function projectRoot(name: string) {
  return mkdtemp(join(tmpdir(), `rigorium-maintenance-${name}-`));
}

test('maintenance merges search candidates, preserves map state, and persists source audit', async () => {
  const root = await projectRoot('candidate');
  try {
    const first = await runProjectLiteratureMaintenance({
      projectRoot: root,
      mapId: 'map-1',
      trigger: 'search',
      providers: [createMaintenanceProviderFromPayload({ id: 'search', payload: { papers: [paper('W1')] } })],
      now: time,
    });
    assert.equal(first.refresh.map?.map.nodes[0]?.status, 'candidate');
    assert.equal(first.safety.zoteroWritePerformed, false);
    assert.equal(first.candidateReview.pendingCandidatePaperIds[0], 'W1');

    const audits = await readProjectLiteratureMaintenanceAudits({ projectRoot: root });
    assert.equal(audits.audits.length, 1);
    assert.equal(audits.audits[0]?.sourceAudits[0]?.state, 'succeeded');
    const persisted = JSON.parse(await readFile(audits.path, 'utf8')) as { audits: unknown[] };
    assert.equal(persisted.audits.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('maintenance records failed providers without writing Zotero or destructive state', async () => {
  const root = await projectRoot('failure');
  try {
    const result = await runProjectLiteratureMaintenance({
      projectRoot: root,
      mapId: 'map-2',
      trigger: 'new_papers',
      providers: [createMaintenanceProviderFromPayload({ id: 'crossref', error: 'rate limited', coverage: 'DOI metadata' })],
      now: time,
    });
    assert.equal(result.refresh.map, undefined);
    assert.equal(result.refresh.sources[0]?.state, 'failed');
    assert.match(result.refresh.sources[0]?.error ?? '', /rate limited/);
    assert.equal(result.safety.snapshotCreated, false);
    assert.equal(result.safety.destructiveMapChangePerformed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Zotero maintenance adapter reads pages and normalizes strong identities', async () => {
  const item: ZoteroLibraryItem = {
    key: 'ABCD1234',
    itemType: 'journalArticle',
    title: 'Zotero paper',
    creators: ['Grace Hopper'],
    year: 2024,
    doi: 'https://doi.org/10.1000/XYZ',
    tags: [],
    collectionKeys: [],
    identity: {},
  };
  const calls: number[] = [];
  const provider = createZoteroMaintenanceProvider({
    provider: {
      id: 'zotero',
      getStatus: async () => { throw new Error('unused'); },
      getSelectedCollection: async () => undefined,
      listCollections: async () => ({ collections: [], total: 0, truncated: false }),
      listItems: async (input) => {
        const start = input?.start ?? 0;
        calls.push(start);
        return start === 0
          ? { items: [item], total: 2, start: 0, nextStart: 1, truncated: true }
          : { items: [{ ...item, key: 'EFGH5678', title: 'Second Zotero paper' }], total: 2, start: 1, truncated: false };
      },
      listTags: async () => ({ tags: [], total: 0, start: 0, truncated: false }),
      getItemDetails: async () => { throw new Error('unused'); },
      getAttachmentFullText: async () => { throw new Error('unused'); },
      getAttachmentFile: async () => { throw new Error('unused'); },
      exportItem: async () => { throw new Error('unused'); },
      matchPapers: async () => [],
      importPapers: async () => { throw new Error('writes must not be called'); },
    },
    now: time,
  });
  const payload = await provider.refresh({ projectRoot: 'D:/project', mapId: 'map-3', now: time });
  assert.deepEqual(calls, [0, 1]);
  assert.equal(payload.papers?.length, 2);
  assert.equal(payload.papers?.[0]?.identity.doi, '10.1000/xyz');
  assert.equal(payload.papers?.[0]?.identity.zoteroKey, 'ABCD1234');
  assert.equal(zoteroItemToResearchPaper(item, time().toISOString()).id, 'zotero:ABCD1234');
});
