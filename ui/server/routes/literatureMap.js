import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import express from 'express';
import { validateWorkspacePath } from './projects.js';
import {
  LiteratureMapRepositoryError,
  freezeProjectLiveLiteratureMap,
  getProjectLiteratureMapPaths,
  loadProjectLiveLiteratureMap,
  setProjectLiveLiteratureMapNodeState,
  updateProjectLiveLiteratureMap,
} from '../../../src/research/literature/mapRepository.ts';

const router = express.Router();
const MAP_SEED_STATE_FILE = 'literature-map-ui-state.json';

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
