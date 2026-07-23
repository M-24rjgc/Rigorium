import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;
const tempDirs = [];

vi.mock('./projects.js', () => ({
  validateWorkspacePath: async (value) => {
    const projectPath = typeof value === 'string' ? value.trim() : '';
    if (!projectPath) return { valid: false, error: 'A project path is required.' };
    const forbidden = process.platform === 'win32' ? 'C:\\Windows' : '/';
    if (projectPath === forbidden) return { valid: false, error: 'Invalid project path.' };
    return { valid: true, resolvedPath: projectPath };
  },
}));

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const paper = {
  id: 'W1',
  identity: { openAlexId: 'https://openalex.org/W1' },
  title: 'A project literature paper',
  authors: ['Ada Lovelace'],
  year: 2025,
  citedByCount: 7,
  topics: [],
  referencedWorkIds: [],
  sourceId: 'openalex',
  sourceIds: ['openalex'],
  provenance: [{
    sourceId: 'openalex',
    sourceRecordId: 'W1',
    rank: 1,
    retrievedAt: '2026-07-23T00:00:00.000Z',
  }],
};

describe('project literature map routes', () => {
  it('reads, updates, restores node state and seed, and freezes only confirmed snapshots', async () => {
    const projectPath = await projectRoot();
    const { request } = await createLiteratureMapApp();

    const initial = await request(`/api/research/literature-map?projectPath=${encodeURIComponent(projectPath)}`);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ map: null, lastDiff: null, seedPaperId: null });

    const created = await request('/api/research/literature-map/update', {
      method: 'POST',
      body: JSON.stringify({
        projectPath,
        mapId: 'project-literature-map',
        update: { origin: 'search', papers: [paper] },
      }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.map.mapId).toBe('project-literature-map');
    expect(created.body.map.nodes).toHaveLength(1);
    expect(created.body.map.nodes[0].paper.provenance).toEqual(paper.provenance);

    const refreshed = await request('/api/research/literature-map/update', {
      method: 'POST',
      body: JSON.stringify({
        projectPath,
        mapId: 'project-literature-map',
        update: {
          origin: 'monitor',
          papers: [{
            ...paper,
            provenance: [{
              ...paper.provenance[0],
              queryVariantId: 'monitor-refresh',
              rank: 2,
            }],
          }],
        },
      }),
    });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body.map.nodes[0].paper.provenance).toEqual([
      paper.provenance[0],
      {
        ...paper.provenance[0],
        queryVariantId: 'monitor-refresh',
        rank: 2,
      },
    ]);

    const node = await request('/api/research/literature-map/nodes/W1', {
      method: 'PATCH',
      body: JSON.stringify({
        projectPath,
        mapId: 'project-literature-map',
        state: { status: 'core', position: { x: 128, y: 96, pinned: true } },
      }),
    });
    expect(node.status).toBe(200);
    expect(node.body.map.nodes[0]).toMatchObject({
      id: 'W1',
      status: 'core',
      position: { x: 128, y: 96, pinned: true },
    });

    const irrelevant = await request('/api/research/literature-map/nodes/W1', {
      method: 'PATCH',
      body: JSON.stringify({
        projectPath,
        mapId: 'project-literature-map',
        expectedRevision: node.body.map.revision,
        state: { status: 'irrelevant' },
      }),
    });
    expect(irrelevant.status).toBe(200);
    expect(irrelevant.body.map.nodes[0].status).toBe('irrelevant');

    const staleNode = await request('/api/research/literature-map/nodes/W1', {
      method: 'PATCH',
      body: JSON.stringify({
        projectPath,
        mapId: 'project-literature-map',
        expectedRevision: node.body.map.revision,
        state: { status: 'core' },
      }),
    });
    expect(staleNode.status).toBe(409);
    expect(staleNode.body.code).toBe('revision_conflict');

    const seed = await request('/api/research/literature-map/seed', {
      method: 'PUT',
      body: JSON.stringify({ projectPath, mapId: 'project-literature-map', seedPaperId: 'W1' }),
    });
    expect(seed.status).toBe(200);
    expect(seed.body.seedPaperId).toBe('W1');

    const reloaded = await request(`/api/research/literature-map?projectPath=${encodeURIComponent(projectPath)}`);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.seedPaperId).toBe('W1');
    expect(reloaded.body.map.nodes[0]).toMatchObject({
      status: 'irrelevant',
      position: { x: 128, y: 96, pinned: true },
    });
    expect(reloaded.body.map.nodes[0].paper.provenance).toEqual([
      paper.provenance[0],
      {
        ...paper.provenance[0],
        queryVariantId: 'monitor-refresh',
        rank: 2,
      },
    ]);

    const rejectedFreeze = await request('/api/research/literature-map/snapshots', {
      method: 'POST',
      body: JSON.stringify({ projectPath, snapshotId: 'reviewed-v1', confirmed: false }),
    });
    expect(rejectedFreeze.status).toBe(409);
    expect(rejectedFreeze.body.code).toBe('snapshot_confirmation_required');

    const frozen = await request('/api/research/literature-map/snapshots', {
      method: 'POST',
      body: JSON.stringify({ projectPath, snapshotId: 'reviewed-v1', confirmed: true }),
    });
    expect(frozen.status).toBe(201);
    expect(frozen.body.snapshot).toMatchObject({ snapshotId: 'reviewed-v1', sourceMapId: 'project-literature-map' });
    expect(frozen.body.snapshot.nodes[0].paper.provenance.map((entry) => entry.rank)).toEqual([1, 2]);
  });

  it('requires a valid project path and does not allow a forbidden workspace root', async () => {
    const { request } = await createLiteratureMapApp();
    const missing = await request('/api/research/literature-map');
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('invalid_project_root');

    const forbidden = process.platform === 'win32' ? 'C:\\Windows' : '/';
    const rejected = await request(`/api/research/literature-map?projectPath=${encodeURIComponent(forbidden)}`);
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('invalid_project_root');
  });

  it('refreshes static Agent or plugin source results through the map orchestrator', async () => {
    const projectPath = await projectRoot();
    const { request } = await createLiteratureMapApp();
    const refreshedPaper = {
      ...paper,
      id: 'W2',
      identity: { doi: '10.1000/refresh' },
      title: 'A refreshed literature paper',
      provenance: [{
        ...paper.provenance[0],
        sourceId: 'agent-search',
        sourceRecordId: 'agent-W2',
      }],
    };

    const result = await request('/api/research/literature-map/refresh', {
      method: 'POST',
      body: JSON.stringify({
        projectPath,
        mapId: 'project-refresh-map',
        maxConcurrency: 1,
        budget: { maxProviderCalls: 1, maxCost: 1 },
        sources: [{
          id: 'agent-search',
          coverage: 'Agent search results for the active research project.',
          cost: 1,
          papers: [refreshedPaper],
        }, {
          id: 'deferred-provider',
          coverage: 'A deferred provider that must not run under this budget.',
          papers: [{ ...paper, id: 'W3' }],
        }],
      }),
    });

    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.cancelled).toBe(false);
    expect(result.body.created).toBe(true);
    expect(result.body.persisted).toBe(true);
    expect(result.body.map).toMatchObject({ mapId: 'project-refresh-map' });
    expect(result.body.map.nodes).toHaveLength(1);
    expect(result.body.map.nodes[0]).toMatchObject({
      id: 'W2',
      paper: { title: 'A refreshed literature paper' },
      origins: ['monitor'],
    });
    expect(result.body.diff.nodes.added).toEqual(['W2']);
    expect(result.body.sources.map((source) => source.state)).toEqual(['succeeded', 'skipped']);
    expect(result.body.sources[0]).toMatchObject({
      sourceId: 'agent-search',
      coverage: 'Agent search results for the active research project.',
      paperCount: 1,
    });
    expect(result.body.sources[1]).toMatchObject({
      sourceId: 'deferred-provider',
      state: 'skipped',
      reason: 'budget_exhausted',
    });
    expect(result.body.budget).toMatchObject({
      maxProviderCalls: 1,
      maxCost: 1,
      scheduledProviderCalls: 1,
      scheduledCost: 1,
    });
    expect(result.body.candidateReview).toEqual({
      reviewRequired: true,
      newCandidatePaperIds: ['W2'],
      pendingCandidatePaperIds: ['W2'],
      updatedExistingPaperIds: [],
      classificationPolicy: 'new_nodes_candidate_existing_state_preserved',
      zoteroWritePerformed: false,
      snapshotCreated: false,
      destructiveMapChangePerformed: false,
    });
    expect(result.body.bridgeAnalysis).toMatchObject({
      kind: 'literature_bridge_analysis',
      sourceRevision: result.body.map.revision,
      bridges: [],
    });
  });

  it('reports bridge papers from the persisted revision without mutating the map', async () => {
    const projectPath = await projectRoot();
    const { request } = await createLiteratureMapApp();
    const papers = ['A', 'B', 'C'].map((id) => ({
      ...paper,
      id,
      identity: { openAlexId: `https://openalex.org/${id}` },
      title: `Paper ${id}`,
      provenance: [{ ...paper.provenance[0], sourceRecordId: id }],
    }));
    const created = await request('/api/research/literature-map/update', {
      method: 'POST',
      body: JSON.stringify({
        projectPath,
        mapId: 'project-bridge-map',
        update: {
          origin: 'search',
          papers,
          edges: [
            { id: 'a-b', source: 'A', target: 'B', type: 'citation', weight: 1, inferred: false },
            { id: 'b-c', source: 'B', target: 'C', type: 'citation', weight: 1, inferred: false },
          ],
        },
      }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const analysis = await request(
      `/api/research/literature-map/bridges?projectPath=${encodeURIComponent(projectPath)}`,
    );
    expect(analysis.status, JSON.stringify(analysis.body)).toBe(200);
    expect(analysis.body).toMatchObject({
      kind: 'literature_bridge_analysis',
      mapId: 'project-bridge-map',
      sourceRevision: created.body.map.revision,
      relationPolicy: 'observed_citations',
      graphProjection: 'undirected',
    });
    expect(analysis.body.bridges).toEqual([
      expect.objectContaining({
        paperId: 'B',
        componentIncrease: 1,
        directNeighborPaperIds: ['A', 'C'],
        supportingRelations: [
          expect.objectContaining({ edgeId: 'citation:A:B', inferred: false }),
          expect.objectContaining({ edgeId: 'citation:B:C', inferred: false }),
        ],
      }),
    ]);

    const reloaded = await request(`/api/research/literature-map?projectPath=${encodeURIComponent(projectPath)}`);
    expect(reloaded.body.map.revision).toBe(created.body.map.revision);
    const invalidPolicy = await request(
      `/api/research/literature-map/bridges?projectPath=${encodeURIComponent(projectPath)}&relationPolicy=centrality`,
    );
    expect(invalidPolicy.status).toBe(400);
    expect(invalidPolicy.body.code).toBe('invalid_input');
  });

  it('rejects refresh payloads outside the read-only refresh contract and preserves revision conflicts', async () => {
    const projectPath = await projectRoot();
    const { request } = await createLiteratureMapApp();

    const rejectedWrite = await request('/api/research/literature-map/refresh', {
      method: 'POST',
      body: JSON.stringify({
        projectPath,
        mapId: 'project-refresh-map',
        sources: [{
          id: 'agent-search',
          papers: [paper],
          tombstonePaperIds: ['W1'],
        }],
      }),
    });
    expect(rejectedWrite.status).toBe(400);
    expect(rejectedWrite.body.code).toBe('invalid_input');

    const duplicateSource = await request('/api/research/literature-map/refresh', {
      method: 'POST',
      body: JSON.stringify({
        projectPath,
        mapId: 'project-refresh-map',
        sources: [
          { id: 'agent-search', papers: [paper] },
          { id: 'agent-search', papers: [{ ...paper, id: 'W2' }] },
        ],
      }),
    });
    expect(duplicateSource.status).toBe(400);
    expect(duplicateSource.body.code).toBe('invalid_input');

    const excessiveConcurrency = await request('/api/research/literature-map/refresh', {
      method: 'POST',
      body: JSON.stringify({
        projectPath,
        mapId: 'project-refresh-map',
        maxConcurrency: 17,
        sources: [{ id: 'agent-search', papers: [paper] }],
      }),
    });
    expect(excessiveConcurrency.status).toBe(400);
    expect(excessiveConcurrency.body.code).toBe('invalid_input');

    const forbidden = process.platform === 'win32' ? 'C:\\Windows' : '/';
    const forbiddenProject = await request('/api/research/literature-map/refresh', {
      method: 'POST',
      body: JSON.stringify({
        projectPath: forbidden,
        mapId: 'project-refresh-map',
        sources: [{ id: 'agent-search', papers: [paper] }],
      }),
    });
    expect(forbiddenProject.status).toBe(400);
    expect(forbiddenProject.body.code).toBe('invalid_project_root');

    const created = await request('/api/research/literature-map/refresh', {
      method: 'POST',
      body: JSON.stringify({
        projectPath,
        mapId: 'project-refresh-map',
        sources: [{ id: 'agent-search', papers: [paper] }],
      }),
    });
    expect(created.status).toBe(201);

    const stale = await request('/api/research/literature-map/refresh', {
      method: 'POST',
      body: JSON.stringify({
        projectPath,
        mapId: 'project-refresh-map',
        expectedRevision: created.body.map.revision - 1,
        sources: [{ id: 'agent-search', papers: [{ ...paper, id: 'W4' }] }],
      }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('revision_conflict');

    const reloaded = await request(`/api/research/literature-map?projectPath=${encodeURIComponent(projectPath)}`);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.map.revision).toBe(created.body.map.revision);
    expect(reloaded.body.map.nodes.map((node) => node.id)).toEqual(['W1']);
  });
});

async function projectRoot() {
  const directory = await mkdtemp(join(tmpdir(), 'rigorium-literature-map-route-'));
  tempDirs.push(directory);
  return directory;
}

async function createLiteratureMapApp() {
  const { default: literatureMapRoutes } = await import('./literatureMap.js');
  const app = express();
  app.use(express.json());
  app.use('/api/research/literature-map', literatureMapRoutes);
  return { request: (path, init) => requestJson(app, path, init) };
}

async function requestJson(app, path, init = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      ...init,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

void assert;
