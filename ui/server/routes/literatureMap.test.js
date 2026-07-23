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
