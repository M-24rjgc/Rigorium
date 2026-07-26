import express from 'express';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;
const originalDesktopMode = process.env.RIGORIUM_DESKTOP;

const mocks = vi.hoisted(() => {
  class TestZoteroInputError extends Error {}

  class TestZoteroLocalApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  return {
    createZoteroLibraryProvider: vi.fn(),
    createZoteroCloudProvider: vi.fn(),
    readResearchSettings: vi.fn(),
    writeResearchSettings: vi.fn(),
    validateWorkspacePath: vi.fn(),
    createZoteroCloudTransport: vi.fn(),
    isAuthorizedDesktopZoteroCloudRequest: vi.fn(),
    ZoteroInputError: TestZoteroInputError,
    ZoteroLocalApiError: TestZoteroLocalApiError,
  };
});

vi.mock('./projects.js', () => ({
  validateWorkspacePath: mocks.validateWorkspacePath,
}));

vi.mock('../../../src/research/index.ts', () => ({
  createZoteroLibraryProvider: mocks.createZoteroLibraryProvider,
  createZoteroCloudProvider: mocks.createZoteroCloudProvider,
  readResearchSettings: mocks.readResearchSettings,
  writeResearchSettings: mocks.writeResearchSettings,
  ZoteroInputError: mocks.ZoteroInputError,
  ZoteroLocalApiError: mocks.ZoteroLocalApiError,
}));

vi.mock('./zoteroCloudTransport.js', () => ({
  createZoteroCloudTransport: mocks.createZoteroCloudTransport,
  isAuthorizedDesktopZoteroCloudRequest: mocks.isAuthorizedDesktopZoteroCloudRequest,
}));

const projectPath = '/workspace/research-project';

beforeEach(() => {
  process.env.RIGORIUM_DESKTOP = '0';
  mocks.validateWorkspacePath.mockReset();
  mocks.validateWorkspacePath.mockImplementation(async (value) => ({
    valid: typeof value === 'string' && value.trim().length > 0,
    resolvedPath: typeof value === 'string' ? value.trim() : undefined,
  }));
  mocks.readResearchSettings.mockReset();
  mocks.readResearchSettings.mockImplementation(async (input = {}) => snapshot(baseSettings(), input.projectRoot));
  mocks.writeResearchSettings.mockReset();
  mocks.writeResearchSettings.mockImplementation(async (input) => snapshot(input.settings, input.projectRoot));
  mocks.createZoteroLibraryProvider.mockReset();
  mocks.createZoteroLibraryProvider.mockReturnValue(localProvider());
  mocks.createZoteroCloudProvider.mockReset();
  mocks.createZoteroCloudProvider.mockReturnValue(cloudProvider());
  mocks.createZoteroCloudTransport.mockReset();
  mocks.createZoteroCloudTransport.mockReturnValue({ request: vi.fn() });
  mocks.isAuthorizedDesktopZoteroCloudRequest.mockReset();
  mocks.isAuthorizedDesktopZoteroCloudRequest.mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  if (originalDesktopMode === undefined) delete process.env.RIGORIUM_DESKTOP;
  else process.env.RIGORIUM_DESKTOP = originalDesktopMode;
});

describe('research routes', () => {
  it('reads and writes research settings at global and project scope', async () => {
    const globalSettings = baseSettings();
    const projectSettings = baseSettings({ citationStyle: 'ieee' });
    mocks.readResearchSettings.mockImplementation(async (input = {}) => (
      input.projectRoot ? snapshot(projectSettings, input.projectRoot) : snapshot(globalSettings)
    ));
    mocks.writeResearchSettings.mockImplementation(async (input) => snapshot(input.settings, input.projectRoot));
    const { request } = await createResearchApp();

    const global = await request('/api/research/settings');
    expect(global.status).toBe(200);
    expect(global.body.global.citation.style).toBe('apa');

    const project = await request(`/api/research/settings?projectPath=${encodeURIComponent(projectPath)}`);
    expect(project.status).toBe(200);
    expect(project.body.projectOverride).toMatchObject({ enabled: true, path: `${projectPath}/.rigorium/research/settings.json` });
    expect(project.body.effective.citation.style).toBe('ieee');

    const savedGlobal = await request('/api/research/settings', {
      method: 'PUT',
      body: JSON.stringify({ scope: 'global', settings: globalSettings }),
    });
    expect(savedGlobal.status).toBe(200);
    expect(mocks.writeResearchSettings).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'global',
      settings: globalSettings,
    }));

    const savedProject = await request('/api/research/settings', {
      method: 'PUT',
      body: JSON.stringify({
        scope: 'project',
        projectPath,
        projectOverrideEnabled: false,
        settings: projectSettings,
      }),
    });
    expect(savedProject.status).toBe(200);
    expect(mocks.writeResearchSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: 'project',
      projectRoot: projectPath,
      projectOverrideEnabled: false,
      settings: projectSettings,
    }));
  });

  it('reports disabled Zotero and preserves the Local API read-only mode', async () => {
    mocks.readResearchSettings.mockResolvedValueOnce(snapshot(baseSettings({ zoteroEnabled: false })));
    const { request } = await createResearchApp();

    const disabled = await request('/api/research/zotero/status');
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({
      provider: 'zotero',
      available: false,
      disabled: true,
      error: 'Zotero integration is disabled in Research Settings.',
    });
    expect(mocks.createZoteroLibraryProvider).not.toHaveBeenCalled();

    mocks.readResearchSettings.mockResolvedValueOnce(snapshot(baseSettings()));
    mocks.createZoteroLibraryProvider.mockReturnValueOnce(localProvider({
      getStatus: vi.fn().mockResolvedValue({
        provider: 'zotero',
        available: true,
        apiReady: true,
        connectorReady: false,
        writeMode: 'read_only',
        checkedAt: '2026-07-23T00:00:00.000Z',
      }),
    }));

    const readOnly = await request('/api/research/zotero/status');
    expect(readOnly.status).toBe(200);
    expect(readOnly.body).toMatchObject({
      provider: 'zotero',
      apiReady: true,
      connectorReady: false,
      writeMode: 'read_only',
    });
  });

  it('passes a Zotero item page offset through the read-only provider', async () => {
    const provider = localProvider({
      listItems: vi.fn().mockResolvedValue({
        items: [{ key: 'ITEM101', title: 'Paged evidence' }],
        total: 151,
        start: 100,
        nextStart: 125,
        truncated: true,
      }),
    });
    mocks.createZoteroLibraryProvider.mockReturnValue(provider);
    const { request } = await createResearchApp();

    const response = await request('/api/research/zotero/items?collectionKey=COLL1&limit=25&start=100');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      provider: 'zotero',
      available: true,
      collectionKey: 'COLL1',
      total: 151,
      start: 100,
      nextStart: 125,
      truncated: true,
    });
    expect(provider.listItems).toHaveBeenCalledWith({
      collectionKey: 'COLL1',
      query: undefined,
      limit: 25,
      start: 100,
    });
  });

  it('keeps a requested item page traceable when Zotero is unavailable and rejects invalid offsets', async () => {
    const provider = localProvider({
      listItems: vi.fn().mockRejectedValue(new Error('Zotero Local API is offline.')),
    });
    mocks.createZoteroLibraryProvider.mockReturnValue(provider);
    const { request } = await createResearchApp();

    const unavailable = await request('/api/research/zotero/items?collectionKey=COLL1&start=100');
    expect(unavailable.status).toBe(200);
    expect(unavailable.body).toEqual({
      provider: 'zotero',
      available: false,
      error: 'Zotero Local API is offline.',
      collectionKey: 'COLL1',
      items: [],
      total: 0,
      start: 100,
      truncated: false,
    });

    const invalid = await request('/api/research/zotero/items?start=-1');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('Zotero item pagination start must be a non-negative integer.');
    expect(provider.listItems).toHaveBeenCalledTimes(1);
  });

  it('pages tag suggestions only through the read-only provider and preserves an unavailable query', async () => {
    const provider = localProvider({
      listTags: vi.fn().mockResolvedValue({
        tags: ['Evidence', 'Methods'],
        total: 101,
        start: 50,
        nextStart: 100,
        truncated: true,
      }),
    });
    mocks.createZoteroLibraryProvider.mockReturnValue(provider);
    const { request } = await createResearchApp();

    const response = await request('/api/research/zotero/tags?collectionKey=COLL1&q=method&limit=50&start=50');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      provider: 'zotero',
      available: true,
      collectionKey: 'COLL1',
      tags: ['Evidence', 'Methods'],
      total: 101,
      start: 50,
      nextStart: 100,
      truncated: true,
    });
    expect(provider.listTags).toHaveBeenCalledWith({
      collectionKey: 'COLL1',
      query: 'method',
      limit: 50,
      start: 50,
    });

    provider.listTags.mockRejectedValueOnce(new Error('Zotero Local API is offline.'));
    const unavailable = await request('/api/research/zotero/tags?collectionKey=COLL1&q=method');
    expect(unavailable.status).toBe(200);
    expect(unavailable.body).toEqual({
      provider: 'zotero',
      available: false,
      error: 'Zotero Local API is offline.',
      collectionKey: 'COLL1',
      tags: [],
      total: 0,
      start: 0,
      truncated: false,
      query: 'method',
    });
  });

  it('keeps the attachment file route private and traceable to an explicit desktop request', async () => {
    const provider = localProvider({
      getAttachmentFile: vi.fn().mockResolvedValue({
        attachmentKey: 'ATTACH1',
        fileUrl: 'file:///C:/Users/Ada/Zotero/storage/ATTACH1/paper.pdf',
      }),
    });
    mocks.createZoteroLibraryProvider.mockReturnValue(provider);
    const { request } = await createResearchApp();

    mocks.isAuthorizedDesktopZoteroCloudRequest.mockReturnValue(false);
    const rendererAttempt = await request('/api/research/zotero/items/ATTACH1/file');
    expect(rendererAttempt.status).toBe(401);
    expect(rendererAttempt.body).toEqual({ error: 'Unauthorized.' });
    expect(rendererAttempt.headers.get('cache-control')).toBe('no-store');
    expect(provider.getAttachmentFile).not.toHaveBeenCalled();

    mocks.isAuthorizedDesktopZoteroCloudRequest.mockReturnValue(true);
    const desktopRequest = await request('/api/research/zotero/items/ATTACH1/file', {
      headers: { 'x-rigorium-zotero-cloud-session': 'desktop-only' },
    });
    expect(desktopRequest.status).toBe(200);
    expect(desktopRequest.headers.get('cache-control')).toBe('no-store');
    expect(desktopRequest.body).toEqual({
      provider: 'zotero',
      available: true,
      attachmentKey: 'ATTACH1',
      fileUrl: 'file:///C:/Users/Ada/Zotero/storage/ATTACH1/paper.pdf',
    });
    expect(provider.getAttachmentFile).toHaveBeenCalledWith('ATTACH1');

    const invalid = await request('/api/research/zotero/items/bad-key/file', {
      headers: { 'x-rigorium-zotero-cloud-session': 'desktop-only' },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'Invalid Zotero item key.' });
    expect(provider.getAttachmentFile).toHaveBeenCalledTimes(1);

    provider.getAttachmentFile.mockRejectedValueOnce(new Error('Zotero Local API is offline.'));
    const unavailable = await request('/api/research/zotero/items/ATTACH1/file', {
      headers: { 'x-rigorium-zotero-cloud-session': 'desktop-only' },
    });
    expect(unavailable.status).toBe(200);
    expect(unavailable.body).toEqual({
      provider: 'zotero',
      available: false,
      error: 'Zotero Local API is offline.',
      itemKey: 'ATTACH1',
      attachmentKey: 'ATTACH1',
    });
  });

  it('previews cloud writes but rejects an unconfirmed cloud execution', async () => {
    const plan = { planId: 'plan-1', requiresConfirmation: true };
    const provider = cloudProvider({ createWritePlan: vi.fn().mockResolvedValue(plan) });
    mocks.createZoteroCloudProvider.mockReturnValueOnce(provider);
    const { request } = await createResearchApp();

    const preview = await request('/api/research/zotero/cloud/writes/preview', {
      method: 'POST',
      body: JSON.stringify({
        projectPath: '/workspace/cloud-preview',
        intent: { kind: 'tags', itemKey: 'ITEM1', operation: 'add', tags: ['reviewed'] },
      }),
    });
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({ plan });
    expect(provider.createWritePlan).toHaveBeenCalledWith({
      kind: 'tags', itemKey: 'ITEM1', operation: 'add', tags: ['reviewed'],
    });

    const rejected = await request('/api/research/zotero/cloud/writes/confirm', {
      method: 'POST',
      body: JSON.stringify({ plan, confirmed: false }),
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe('Zotero cloud writes require explicit confirmation.');
    expect(provider.executeWritePlan).not.toHaveBeenCalled();
  });

  it('rejects a Zotero import before reading settings or contacting the connector', async () => {
    const { request } = await createResearchApp();

    const rejected = await request('/api/research/zotero/import', {
      method: 'POST',
      body: JSON.stringify({
        papers: [{ id: 'W1', title: 'A paper', authors: [], citedByCount: 0 }],
      }),
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe('Zotero import requires explicit confirmation.');
    expect(mocks.readResearchSettings).not.toHaveBeenCalled();
    expect(mocks.createZoteroLibraryProvider).not.toHaveBeenCalled();
  });

  it('keeps full-text and export failure states traceable to the requested item', async () => {
    const provider = localProvider({
      getAttachmentFullText: vi.fn().mockRejectedValue(new mocks.ZoteroLocalApiError('Attachment is unavailable.', 404)),
      exportItem: vi.fn().mockRejectedValue(new Error('Zotero Local API is offline.')),
    });
    mocks.createZoteroLibraryProvider.mockReturnValue(provider);
    const { request } = await createResearchApp();

    const fullText = await request('/api/research/zotero/items/ATTACH1/fulltext');
    expect(fullText.status).toBe(404);
    expect(fullText.body).toEqual({
      provider: 'zotero',
      available: true,
      error: 'Attachment is unavailable.',
      itemKey: 'ATTACH1',
      attachmentKey: 'ATTACH1',
      content: '',
    });

    const exported = await request('/api/research/zotero/items/ITEM1/export?format=bibtex&style=ieee');
    expect(exported.status).toBe(200);
    expect(exported.body).toEqual({
      provider: 'zotero',
      available: false,
      error: 'Zotero Local API is offline.',
      itemKey: 'ITEM1',
      format: 'bibtex',
      style: 'ieee',
      content: '',
    });
  });
});

function baseSettings({ zoteroEnabled = true, citationStyle = 'apa' } = {}) {
  return {
    schemaVersion: 1,
    literature: {
      enabled: true,
      sources: {
        openalex: { enabled: true, mailto: '' },
        arxiv: { enabled: true },
        crossref: { enabled: true, mailto: '' },
        openreview: { enabled: true },
      },
      search: { defaultLimit: 12, fromYear: null, toYear: null, sort: 'relevance' },
      budget: { maxResultsPerSearch: 25, requestTimeoutMs: 20_000 },
      map: { autoOpen: true, autoUpdate: true, showTopicEdges: true },
    },
    zotero: {
      enabled: zoteroEnabled,
      baseUrl: 'http://127.0.0.1:23119',
      useSelectedCollection: true,
      collectionKey: null,
      collectionName: null,
      cloud: { enabled: true, libraryType: 'user', libraryId: null },
    },
    citation: { style: citationStyle, includeDoi: true },
    privacy: { allowRemoteMetadataSearch: true, allowRemoteFullText: false },
  };
}

function snapshot(settings, activeProjectPath) {
  const clone = structuredClone(settings);
  return {
    global: clone,
    effective: structuredClone(settings),
    projectOverride: activeProjectPath
      ? { enabled: true, path: `${activeProjectPath}/.rigorium/research/settings.json`, settings: structuredClone(settings) }
      : null,
    paths: {
      global: '/rigorium-home/research/settings.json',
      ...(activeProjectPath ? { project: `${activeProjectPath}/.rigorium/research/settings.json` } : {}),
    },
  };
}

function localProvider(overrides = {}) {
  return {
    getStatus: vi.fn().mockResolvedValue({
      provider: 'zotero',
      available: true,
      apiReady: true,
      connectorReady: true,
      writeMode: 'connector_import',
      checkedAt: '2026-07-23T00:00:00.000Z',
    }),
    listTags: vi.fn(),
    getAttachmentFullText: vi.fn(),
    getAttachmentFile: vi.fn(),
    exportItem: vi.fn(),
    importPapers: vi.fn(),
    ...overrides,
  };
}

function cloudProvider(overrides = {}) {
  return {
    getStatus: vi.fn(),
    probeIncrementalSync: vi.fn(),
    createWritePlan: vi.fn(),
    executeWritePlan: vi.fn(),
    ...overrides,
  };
}

async function createResearchApp() {
  const { default: researchRoutes } = await import('./research.js');
  const app = express();
  app.use(express.json());
  app.use('/api/research', researchRoutes);
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
    return { status: response.status, headers: response.headers, body: await response.json() };
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}
