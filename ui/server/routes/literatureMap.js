import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import express from 'express';
import { validateWorkspacePath } from './projects.js';
import {
  LiteratureMapRepositoryError,
  MAX_LITERATURE_MAP_EDGES,
  MAX_LITERATURE_MAP_NODES,
  freezeProjectLiveLiteratureMap,
  getProjectLiteratureMapPaths,
  loadProjectLiveLiteratureMap,
  setProjectLiveLiteratureMapNodeState,
  updateProjectLiveLiteratureMap,
} from '../../../src/research/literature/mapRepository.ts';
import { analyzeLiteratureMapBridges } from '../../../src/research/literature/bridgeDetection.ts';
import { refreshProjectLiteratureMap } from '../../../src/research/literature/mapRefresh.ts';
import {
  createMaintenanceProviderFromPayload,
  createZoteroMaintenanceProvider,
  readProjectLiteratureMaintenanceAudits,
  runProjectLiteratureMaintenance,
} from '../../../src/research/literature/maintenance.ts';
import { createZoteroLibraryProvider } from '../../../src/research/library/zoteroProvider.ts';
import { readResearchSettings } from '../../../src/research/settings.ts';
import { createLiteratureSearchTool } from '../../../src/tool/builtin/literatureSearch.ts';

const router = express.Router();
const MAP_SEED_STATE_FILE = 'literature-map-ui-state.json';
const MAX_REFRESH_SOURCES = 32;
const MAX_REFRESH_CONCURRENCY = 16;
const MAX_REFRESH_PROVIDER_COST = 1_000_000;
const MAX_REFRESH_TOTAL_COST = 1_000_000;

class LiteratureMapHttpError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'LiteratureMapHttpError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.use(express.json({ limit: '1mb' }));

/** Read the live project map without creating a repository or sidecar state. */
router.get('/', async (req, res) => {
  try {
    const projectRoot = await validatedProjectRoot(req.query.projectPath);
    const document = await loadProjectLiveLiteratureMap({ projectRoot });
    if (!document) {
      return res.json({ map: null, lastDiff: null, seedPaperId: null });
    }
    const seedPaperId = await loadSeedPaperId(projectRoot, document.map.mapId);
    return res.json({ map: document.map, lastDiff: document.lastDiff, seedPaperId });
  } catch (error) {
    return respondError(res, error);
  }
});

/** Compute traceable bridge papers without changing the live map. */
router.get('/bridges', async (req, res) => {
  try {
    const projectRoot = await validatedProjectRoot(req.query.projectPath);
    const document = await loadProjectLiveLiteratureMap({ projectRoot });
    if (!document) {
      throw new LiteratureMapHttpError('live_map_not_found', 'Cannot analyze bridges before a literature map exists.', 404);
    }
    return res.json(analyzeLiteratureMapBridges(document.map, {
      relationPolicy: requestedBridgeRelationPolicy(req.query.relationPolicy),
    }));
  } catch (error) {
    return respondError(res, error);
  }
});

/** Merge a search, Zotero, or monitor result into the one map owned by a project. */
router.post('/update', async (req, res) => {
  try {
    const projectRoot = await validatedProjectRoot(req.body?.projectPath);
    const result = await updateProjectLiveLiteratureMap({
      projectRoot,
      mapId: requiredIdentifier(req.body?.mapId, 'mapId'),
      update: requestedMapUpdate(req.body?.update),
      ...(requestedRevision(req.body?.expectedRevision) !== undefined
        ? { expectedRevision: requestedRevision(req.body?.expectedRevision) }
        : {}),
    });
    const seedPaperId = await loadSeedPaperId(projectRoot, result.map.mapId);
    return res.status(result.created ? 201 : 200).json({ ...result, seedPaperId });
  } catch (error) {
    return respondError(res, error);
  }
});

/**
 * Merge read-only Agent or plugin discovery results through the refresh
 * orchestrator. This deliberately accepts no map state, tombstones, or Zotero
 * operation; the only write is the orchestrator's normal incremental map merge.
 */
router.post('/refresh', async (req, res) => {
  const requestAbort = requestAbortSignal(req, res);
  try {
    const request = requestedRefreshRequest(req.body);
    const projectRoot = await validatedProjectRoot(request.projectPath);
    const result = await refreshProjectLiteratureMap({
      projectRoot,
      mapId: request.mapId,
      providers: request.sources.map(refreshProviderForSource),
      ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
      ...(request.budget === undefined ? {} : { budget: request.budget }),
      ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
      signal: requestAbort.signal,
    });
    if (req.aborted) return undefined;

    const mapResult = result.map;
    return res.status(mapResult?.created ? 201 : 200).json({
      cancelled: result.cancelled,
      sources: result.sources,
      budget: result.budget,
      candidateReview: result.candidateReview,
      bridgeAnalysis: result.bridgeAnalysis ?? null,
      map: mapResult?.map ?? null,
      diff: mapResult?.diff ?? null,
      created: mapResult?.created ?? false,
      persisted: mapResult?.persisted ?? false,
    });
  } catch (error) {
    return respondError(res, error);
  } finally {
    requestAbort.dispose();
  }
});

/**
 * Run candidate-only automatic maintenance and retain a source/failure audit.
 * The endpoint has no Zotero write or snapshot operation in its input shape.
 */
router.post('/maintenance', async (req, res) => {
  const requestAbort = requestAbortSignal(req, res);
  try {
    const request = requestedMaintenanceRequest(req.body);
    const projectRoot = await validatedProjectRoot(request.projectPath);
    const providers = request.sources.map((source) => createMaintenanceProviderFromPayload({
      id: source.id,
      coverage: source.coverage,
      cost: source.cost,
      error: source.error,
      payload: {
        ...(source.papers === undefined ? {} : { papers: source.papers }),
        ...(source.edges === undefined ? {} : { edges: source.edges }),
        ...(source.coverage === undefined ? {} : { coverage: source.coverage }),
      },
    }));
    if (request.query) {
      const searchTool = createLiteratureSearchTool();
      const searchOutput = await searchTool.execute({ query: request.query }, {
        sessionId: `literature-maintenance-${Date.now()}`,
        turnId: `literature-maintenance-${Date.now()}`,
        cwd: projectRoot,
        permissionMode: 'default',
        permissionContext: { cwd: projectRoot, mode: 'default', canPrompt: false, bypassAvailable: false, additionalWorkingDirectories: [], rules: { allow: [], deny: [], ask: [] } },
        abortSignal: requestAbort.signal,
        now: () => new Date(),
        env: process.env,
      });
      const artifact = searchOutput.data;
      if (!artifact || typeof artifact !== 'object' || artifact.kind !== 'literature_search') {
        throw new LiteratureMapHttpError('invalid_input', 'The literature search did not return a usable artifact.', 502);
      }
      providers.unshift(createMaintenanceProviderFromPayload({
        id: `search:${artifact.artifactId || Date.now()}`,
        coverage: `Natural-language literature search returned ${Array.isArray(artifact.papers) ? artifact.papers.length : 0} candidates.`,
        payload: { papers: artifact.papers || [], edges: artifact.edges || [] },
      }));
    }
    if (request.trigger === 'zotero_changed' && providers.length === 0) {
      const settings = await readResearchSettings({ projectRoot });
      if (!settings.effective.zotero.enabled) {
        throw new LiteratureMapHttpError('setup_required', 'Zotero is disabled in Research Settings.', 409);
      }
      const provider = createZoteroLibraryProvider({
        baseUrl: settings.effective.zotero.baseUrl,
      });
      providers.push(createZoteroMaintenanceProvider({
        provider,
        collectionKey: request.zoteroCollectionKey || settings.effective.zotero.collectionKey || undefined,
      }));
    }
    const result = await runProjectLiteratureMaintenance({
      projectRoot,
      mapId: request.mapId,
      trigger: request.trigger,
      providers,
      ...(request.intent === undefined ? {} : { intent: request.intent }),
      ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
      ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
      ...(request.budget === undefined ? {} : { budget: request.budget }),
      signal: requestAbort.signal,
    });
    if (req.aborted) return undefined;
    const mapResult = result.refresh.map;
    return res.status(mapResult?.created ? 201 : 200).json({
      ...result,
      sources: result.refresh.sources,
      budget: result.refresh.budget,
      map: mapResult?.map ?? null,
      diff: mapResult?.diff ?? null,
      created: mapResult?.created ?? false,
      persisted: mapResult?.persisted ?? false,
      bridgeAnalysis: result.refresh.bridgeAnalysis ?? null,
    });
  } catch (error) {
    return respondError(res, error);
  } finally {
    requestAbort.dispose();
  }
});

/** Read the append-only automatic-maintenance audit for a project. */
router.get('/maintenance/audit', async (req, res) => {
  try {
    const projectRoot = await validatedProjectRoot(req.query.projectPath);
    const limit = req.query.limit === undefined ? undefined : requestedAuditLimit(req.query.limit);
    return res.json(await readProjectLiteratureMaintenanceAudits({ projectRoot, ...(limit === undefined ? {} : { limit }) }));
  } catch (error) {
    return respondError(res, error);
  }
});

/** Persist a user-selected literature classification and/or graph coordinate. */
router.patch('/nodes/:paperId', async (req, res) => {
  try {
    const projectRoot = await validatedProjectRoot(req.body?.projectPath);
    const result = await setProjectLiveLiteratureMapNodeState({
      projectRoot,
      mapId: requiredIdentifier(req.body?.mapId, 'mapId'),
      paperId: requiredIdentifier(req.params.paperId, 'paperId'),
      state: requestedNodeState(req.body?.state),
      ...(requestedRevision(req.body?.expectedRevision) !== undefined
        ? { expectedRevision: requestedRevision(req.body?.expectedRevision) }
        : {}),
    });
    const seedPaperId = await loadSeedPaperId(projectRoot, result.map.mapId);
    return res.json({ ...result, seedPaperId });
  } catch (error) {
    return respondError(res, error);
  }
});

/**
 * A seed is UI state, not a literature classification. Keep it in a small
 * project-local sidecar so setting a seed never rewrites a user's core label.
 */
router.put('/seed', async (req, res) => {
  try {
    const projectRoot = await validatedProjectRoot(req.body?.projectPath);
    const mapId = requiredIdentifier(req.body?.mapId, 'mapId');
    const document = await loadProjectLiveLiteratureMap({ projectRoot });
    if (!document) {
      throw new LiteratureMapHttpError('live_map_not_found', 'Cannot set a seed before a literature map exists.', 404);
    }
    if (document.map.mapId !== mapId) {
      throw new LiteratureMapHttpError('map_id_mismatch', 'The requested map ID does not match this project map.', 409);
    }
    const requestedSeed = req.body?.seedPaperId;
    const seedPaperId = requestedSeed === null
      ? null
      : resolveMapNodeId(document.map, requiredIdentifier(requestedSeed, 'seedPaperId'));
    await writeSeedPaperId(projectRoot, mapId, seedPaperId);
    return res.json({ map: document.map, seedPaperId });
  } catch (error) {
    return respondError(res, error);
  }
});

/** Freeze an immutable map snapshot. The repository independently enforces confirmed: true. */
router.post('/snapshots', async (req, res) => {
  try {
    if (req.body?.confirmed !== true) {
      throw new LiteratureMapHttpError(
        'snapshot_confirmation_required',
        'A frozen literature-map snapshot requires confirmed: true.',
        409,
      );
    }
    const projectRoot = await validatedProjectRoot(req.body?.projectPath);
    const result = await freezeProjectLiveLiteratureMap({
      projectRoot,
      snapshotId: requiredIdentifier(req.body?.snapshotId, 'snapshotId'),
      confirmed: true,
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondError(res, error);
  }
});

async function validatedProjectRoot(value) {
  const projectPath = typeof value === 'string' ? value.trim() : '';
  if (!projectPath) {
    throw new LiteratureMapHttpError('invalid_project_root', 'A project path is required for a project literature map.');
  }
  const validation = await validateWorkspacePath(projectPath);
  if (!validation.valid || !validation.resolvedPath) {
    throw new LiteratureMapHttpError('invalid_project_root', validation.error || 'Invalid project path.');
  }
  return validation.resolvedPath;
}

function requiredIdentifier(value, name) {
  if (typeof value !== 'string') {
    throw new LiteratureMapHttpError('invalid_input', `${name} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 4096 || normalized.includes('\u0000')) {
    throw new LiteratureMapHttpError('invalid_input', `${name} must be a non-empty string.`);
  }
  return normalized;
}

function requestedMapUpdate(value) {
  if (!isRecord(value)) {
    throw new LiteratureMapHttpError('invalid_input', 'A literature map update is required.');
  }
  if (value.origin !== 'search' && value.origin !== 'zotero' && value.origin !== 'monitor') {
    throw new LiteratureMapHttpError('invalid_input', 'update.origin must be search, zotero, or monitor.');
  }
  const update = { origin: value.origin };
  for (const key of ['papers', 'edges', 'tombstonePaperIds', 'restorePaperIds']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key])) {
      throw new LiteratureMapHttpError('invalid_input', `update.${key} must be an array when supplied.`);
    }
    update[key] = value[key];
  }
  return update;
}

function requestedRefreshRequest(value) {
  if (!isRecord(value)) {
    throw new LiteratureMapHttpError('invalid_input', 'A literature map refresh request is required.');
  }
  assertOnlyKeys(value, [
    'projectPath',
    'mapId',
    'sources',
    'maxConcurrency',
    'budget',
    'expectedRevision',
  ], 'refresh request');
  return {
    projectPath: value.projectPath,
    mapId: requiredIdentifier(value.mapId, 'mapId'),
    sources: requestedRefreshSources(value.sources),
    ...(value.maxConcurrency === undefined ? {} : { maxConcurrency: requestedRefreshConcurrency(value.maxConcurrency) }),
    ...(value.budget === undefined ? {} : { budget: requestedRefreshBudget(value.budget) }),
    ...(value.expectedRevision === undefined ? {} : { expectedRevision: requestedRevision(value.expectedRevision) }),
  };
}

function requestedMaintenanceRequest(value) {
  if (!isRecord(value)) {
    throw new LiteratureMapHttpError('invalid_input', 'A literature map maintenance request is required.');
  }
  assertOnlyKeys(value, [
    'projectPath',
    'mapId',
    'trigger',
    'intent',
    'query',
    'sources',
    'zoteroCollectionKey',
    'maxConcurrency',
    'budget',
    'expectedRevision',
  ], 'maintenance request');
  const triggers = ['search', 'zotero_changed', 'new_papers', 'natural_language', 'manual'];
  if (!triggers.includes(value.trigger)) {
    throw new LiteratureMapHttpError('invalid_input', 'trigger must be search, zotero_changed, new_papers, natural_language, or manual.');
  }
  const sources = value.sources === undefined ? [] : requestedMaintenanceSources(value.sources);
  const query = value.query === undefined ? undefined : requestedRefreshCoverage(value.query, 'query');
  if (sources.length === 0 && !query && value.trigger !== 'zotero_changed') {
    throw new LiteratureMapHttpError('invalid_input', 'sources are required unless trigger is zotero_changed.');
  }
  const intent = value.intent === undefined ? undefined : requestedRefreshCoverage(value.intent, 'intent');
  const zoteroCollectionKey = value.zoteroCollectionKey === undefined
    ? undefined
    : requiredIdentifier(value.zoteroCollectionKey, 'zoteroCollectionKey');
  return {
    projectPath: value.projectPath,
    mapId: requiredIdentifier(value.mapId, 'mapId'),
    trigger: value.trigger,
    ...(intent === undefined ? {} : { intent }),
    ...(query === undefined ? {} : { query }),
    sources,
    ...(zoteroCollectionKey === undefined ? {} : { zoteroCollectionKey }),
    ...(value.maxConcurrency === undefined ? {} : { maxConcurrency: requestedRefreshConcurrency(value.maxConcurrency) }),
    ...(value.budget === undefined ? {} : { budget: requestedRefreshBudget(value.budget) }),
    ...(value.expectedRevision === undefined ? {} : { expectedRevision: requestedRevision(value.expectedRevision) }),
  };
}

function requestedMaintenanceSources(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REFRESH_SOURCES) {
    throw new LiteratureMapHttpError('invalid_input', `sources must contain between 1 and ${MAX_REFRESH_SOURCES} entries.`);
  }
  const sourceIds = new Set();
  return value.map((source, index) => {
    const location = `sources[${index}]`;
    if (!isRecord(source)) throw new LiteratureMapHttpError('invalid_input', `${location} must be an object.`);
    assertOnlyKeys(source, ['id', 'papers', 'edges', 'coverage', 'cost', 'error'], location);
    const id = requiredIdentifier(source.id, `${location}.id`);
    if (sourceIds.has(id)) throw new LiteratureMapHttpError('invalid_input', `sources must not repeat source ID ${id}.`);
    sourceIds.add(id);
    const papers = source.papers === undefined ? undefined : requestedRefreshPapers(source.papers, `${location}.papers`);
    const edges = source.edges === undefined ? undefined : requestedRefreshEdges(source.edges, `${location}.edges`);
    const coverage = source.coverage === undefined ? undefined : requestedRefreshCoverage(source.coverage, `${location}.coverage`);
    const cost = source.cost === undefined ? undefined : requestedRefreshCost(source.cost, `${location}.cost`);
    const error = source.error === undefined ? undefined : requestedRefreshCoverage(source.error, `${location}.error`);
    return {
      id,
      ...(papers === undefined ? {} : { papers }),
      ...(edges === undefined ? {} : { edges }),
      ...(coverage === undefined ? {} : { coverage }),
      ...(cost === undefined ? {} : { cost }),
      ...(error === undefined ? {} : { error }),
    };
  });
}

function requestedAuditLimit(value) {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new LiteratureMapHttpError('invalid_input', 'limit must be an integer between 1 and 200.');
  }
  return parsed;
}

function requestedRefreshSources(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REFRESH_SOURCES) {
    throw new LiteratureMapHttpError(
      'invalid_input',
      `sources must contain between 1 and ${MAX_REFRESH_SOURCES} read-only source payloads.`,
    );
  }

  const sourceIds = new Set();
  let paperCount = 0;
  let edgeCount = 0;
  let totalCost = 0;
  return value.map((source, index) => {
    const location = `sources[${index}]`;
    if (!isRecord(source)) {
      throw new LiteratureMapHttpError('invalid_input', `${location} must be an object.`);
    }
    assertOnlyKeys(source, ['id', 'papers', 'edges', 'coverage', 'cost'], location);
    const id = requiredIdentifier(source.id, `${location}.id`);
    if (sourceIds.has(id)) {
      throw new LiteratureMapHttpError('invalid_input', `sources must not repeat source ID ${id}.`);
    }
    sourceIds.add(id);

    const papers = source.papers === undefined ? undefined : requestedRefreshPapers(source.papers, `${location}.papers`);
    const edges = source.edges === undefined ? undefined : requestedRefreshEdges(source.edges, `${location}.edges`);
    paperCount += papers?.length ?? 0;
    edgeCount += edges?.length ?? 0;
    if (paperCount > MAX_LITERATURE_MAP_NODES || edgeCount > MAX_LITERATURE_MAP_EDGES) {
      throw new LiteratureMapHttpError(
        'invalid_input',
        `Refresh input exceeds ${MAX_LITERATURE_MAP_NODES} papers or ${MAX_LITERATURE_MAP_EDGES} edges.`,
      );
    }

    const coverage = source.coverage === undefined
      ? undefined
      : requestedRefreshCoverage(source.coverage, `${location}.coverage`);
    const cost = source.cost === undefined ? undefined : requestedRefreshCost(source.cost, `${location}.cost`);
    totalCost += cost ?? 1;
    if (totalCost > MAX_REFRESH_TOTAL_COST) {
      throw new LiteratureMapHttpError(
        'invalid_input',
        `The total refresh source cost must not exceed ${MAX_REFRESH_TOTAL_COST}.`,
      );
    }
    return {
      id,
      ...(papers === undefined ? {} : { papers }),
      ...(edges === undefined ? {} : { edges }),
      ...(coverage === undefined ? {} : { coverage }),
      ...(cost === undefined ? {} : { cost }),
    };
  });
}

function refreshProviderForSource(source) {
  return {
    id: source.id,
    ...(source.coverage === undefined ? {} : { coverage: source.coverage }),
    ...(source.cost === undefined ? {} : { cost: source.cost }),
    refresh: async () => {
      if (source.error) throw new Error(source.error);
      return ({
      ...(source.papers === undefined ? {} : { papers: source.papers }),
      ...(source.edges === undefined ? {} : { edges: source.edges }),
      ...(source.coverage === undefined ? {} : { coverage: source.coverage }),
      });
    },
  };
}

function requestedRefreshConcurrency(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REFRESH_CONCURRENCY) {
    throw new LiteratureMapHttpError(
      'invalid_input',
      `maxConcurrency must be an integer between 1 and ${MAX_REFRESH_CONCURRENCY}.`,
    );
  }
  return value;
}

function requestedRefreshBudget(value) {
  if (!isRecord(value)) {
    throw new LiteratureMapHttpError('invalid_input', 'budget must be an object when supplied.');
  }
  assertOnlyKeys(value, ['maxProviderCalls', 'maxCost'], 'budget');
  const budget = {};
  if (value.maxProviderCalls !== undefined) {
    if (!Number.isSafeInteger(value.maxProviderCalls) || value.maxProviderCalls < 0
      || value.maxProviderCalls > MAX_REFRESH_SOURCES) {
      throw new LiteratureMapHttpError(
        'invalid_input',
        `budget.maxProviderCalls must be a non-negative integer no greater than ${MAX_REFRESH_SOURCES}.`,
      );
    }
    budget.maxProviderCalls = value.maxProviderCalls;
  }
  if (value.maxCost !== undefined) {
    if (!Number.isFinite(value.maxCost) || value.maxCost < 0 || value.maxCost > MAX_REFRESH_TOTAL_COST) {
      throw new LiteratureMapHttpError(
        'invalid_input',
        `budget.maxCost must be a non-negative finite number no greater than ${MAX_REFRESH_TOTAL_COST}.`,
      );
    }
    budget.maxCost = value.maxCost;
  }
  return budget;
}

function requestedRefreshCost(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > MAX_REFRESH_PROVIDER_COST) {
    throw new LiteratureMapHttpError(
      'invalid_input',
      `${name} must be a non-negative finite number no greater than ${MAX_REFRESH_PROVIDER_COST}.`,
    );
  }
  return value;
}

function requestedRefreshCoverage(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4096 || value.includes('\u0000')) {
    throw new LiteratureMapHttpError('invalid_input', `${name} must be a non-empty string.`);
  }
  return value.trim();
}

function requestedRefreshPapers(value, location) {
  if (!Array.isArray(value)) {
    throw new LiteratureMapHttpError('invalid_input', `${location} must be an array when supplied.`);
  }
  if (value.length > MAX_LITERATURE_MAP_NODES) {
    throw new LiteratureMapHttpError('invalid_input', `${location} exceeds the literature-map paper limit.`);
  }
  value.forEach((paper, index) => {
    if (!isRecord(paper)) {
      throw new LiteratureMapHttpError('invalid_input', `${location}[${index}] must be an object.`);
    }
  });
  return value;
}

function requestedRefreshEdges(value, location) {
  if (!Array.isArray(value)) {
    throw new LiteratureMapHttpError('invalid_input', `${location} must be an array when supplied.`);
  }
  if (value.length > MAX_LITERATURE_MAP_EDGES) {
    throw new LiteratureMapHttpError('invalid_input', `${location} exceeds the literature-map edge limit.`);
  }
  value.forEach((edge, index) => {
    if (!isRecord(edge)) {
      throw new LiteratureMapHttpError('invalid_input', `${location}[${index}] must be an object.`);
    }
  });
  return value;
}

function assertOnlyKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new LiteratureMapHttpError('invalid_input', `${location} does not allow ${key}.`);
    }
  }
}

function requestAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortIfResponseClosed = () => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', abortIfResponseClosed);
  return {
    signal: controller.signal,
    dispose: () => {
      req.off('aborted', abort);
      res.off('close', abortIfResponseClosed);
    },
  };
}

function requestedNodeState(value) {
  if (!isRecord(value)) {
    throw new LiteratureMapHttpError('invalid_input', 'A node state update is required.');
  }
  const state = {};
  if (value.status !== undefined) {
    if (!['candidate', 'relevant', 'core', 'irrelevant', 'excluded'].includes(value.status)) {
      throw new LiteratureMapHttpError('invalid_input', 'The requested literature-map node status is invalid.');
    }
    state.status = value.status;
  }
  if (value.position !== undefined) {
    if (!isRecord(value.position)
      || !Number.isFinite(value.position.x)
      || !Number.isFinite(value.position.y)
      || (value.position.pinned !== undefined && typeof value.position.pinned !== 'boolean')) {
      throw new LiteratureMapHttpError('invalid_input', 'The requested literature-map node position is invalid.');
    }
    state.position = {
      x: value.position.x,
      y: value.position.y,
      ...(value.position.pinned === undefined ? {} : { pinned: value.position.pinned }),
    };
  }
  if (state.status === undefined && state.position === undefined) {
    throw new LiteratureMapHttpError('invalid_input', 'A node status or position is required.');
  }
  return state;
}

function requestedRevision(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LiteratureMapHttpError('invalid_input', 'expectedRevision must be a non-negative integer.');
  }
  return value;
}

function requestedBridgeRelationPolicy(value) {
  if (value === undefined) return 'observed_citations';
  if (value !== 'observed_citations' && value !== 'all_active_relations') {
    throw new LiteratureMapHttpError(
      'invalid_input',
      'relationPolicy must be observed_citations or all_active_relations.',
    );
  }
  return value;
}

function resolveMapNodeId(map, paperId) {
  const node = map.nodes.find((candidate) => candidate.id === paperId || candidate.aliases.includes(paperId));
  if (!node) {
    throw new LiteratureMapHttpError('node_not_found', 'The requested literature-map node does not exist.', 404);
  }
  return node.id;
}

async function loadSeedPaperId(projectRoot, mapId) {
  const filePath = seedStatePath(projectRoot);
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new LiteratureMapHttpError('corrupt_seed_state', 'The persisted literature-map seed state is invalid.', 500);
  }
  if (!isRecord(document)
    || document.schemaVersion !== 1
    || document.kind !== 'literature_map_ui_state'
    || typeof document.mapId !== 'string'
    || (document.seedPaperId !== null && typeof document.seedPaperId !== 'string')) {
    throw new LiteratureMapHttpError('invalid_seed_state', 'The persisted literature-map seed state is invalid.', 500);
  }
  return document.mapId === mapId ? document.seedPaperId : null;
}

async function writeSeedPaperId(projectRoot, mapId, seedPaperId) {
  const paths = getProjectLiteratureMapPaths({ projectRoot });
  const filePath = seedStatePath(paths.projectRoot);
  await mkdir(paths.researchDir, { recursive: true });
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  assertWithinProject(paths.projectRoot, tempPath);
  const body = `${JSON.stringify({
    schemaVersion: 1,
    kind: 'literature_map_ui_state',
    mapId,
    seedPaperId,
  })}\n`;
  await writeFile(tempPath, body, { encoding: 'utf8', flag: 'wx' });
  await rename(tempPath, filePath);
}

function seedStatePath(projectRoot) {
  const paths = getProjectLiteratureMapPaths({ projectRoot });
  const filePath = join(paths.researchDir, MAP_SEED_STATE_FILE);
  assertWithinProject(paths.projectRoot, filePath);
  return filePath;
}

function assertWithinProject(projectRoot, candidate) {
  const root = resolve(projectRoot);
  const target = resolve(candidate);
  const segment = relative(root, target);
  if (segment === '' || segment === '..' || segment.startsWith(`..${sep}`) || isAbsolute(segment)) {
    throw new LiteratureMapHttpError('path_violation', 'Literature map state must remain within its project.', 400);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function respondError(res, error) {
  if (error instanceof LiteratureMapHttpError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  if (error instanceof LiteratureMapRepositoryError) {
    const status = repositoryErrorStatus(error.code);
    return res.status(status).json({ error: error.message, code: error.code });
  }
  const message = error instanceof Error ? error.message : String(error);
  return res.status(500).json({ error: message || 'Unable to process the literature map request.', code: 'internal_error' });
}

function repositoryErrorStatus(code) {
  if (code === 'live_map_not_found' || code === 'node_not_found') return 404;
  if (code === 'revision_conflict' || code === 'live_map_exists' || code === 'map_id_mismatch'
    || code === 'snapshot_confirmation_required' || code === 'snapshot_exists') return 409;
  if (code === 'io_error' || code === 'file_too_large' || code === 'corrupt_json' || code === 'invalid_schema'
    || code === 'node_limit_exceeded' || code === 'edge_limit_exceeded') return 500;
  return 400;
}

export default router;
