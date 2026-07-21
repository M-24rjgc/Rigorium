import express from 'express';
import fetch from 'node-fetch';
import { validateWorkspacePath } from './projects.js';
import {
  createZoteroLibraryProvider,
  readResearchSettings,
  writeResearchSettings,
  ZoteroInputError,
  ZoteroLocalApiError,
} from '../../../src/research/index.ts';

const router = express.Router();

router.get('/settings', async (req, res) => {
  try {
    const projectRoot = await validatedProjectRoot(req.query.projectPath);
    const snapshot = await readResearchSettings({
      pilotHome: process.env.PILOT_HOME,
      ...(projectRoot ? { projectRoot } : {}),
    });
    res.json(snapshot);
  } catch (error) {
    respondError(res, error);
  }
});

router.put('/settings', async (req, res) => {
  try {
    const scope = req.body?.scope === 'project' ? 'project' : req.body?.scope === 'global' ? 'global' : null;
    if (!scope) return res.status(400).json({ error: 'scope must be "global" or "project".' });
    const projectRoot = scope === 'project'
      ? await validatedProjectRoot(req.body?.projectPath, true)
      : await validatedProjectRoot(req.body?.projectPath);
    const snapshot = await writeResearchSettings({
      scope,
      settings: req.body?.settings,
      pilotHome: process.env.PILOT_HOME,
      ...(projectRoot ? { projectRoot } : {}),
      ...(scope === 'project' ? { projectOverrideEnabled: req.body?.projectOverrideEnabled !== false } : {}),
    });
    res.json(snapshot);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/zotero/status', async (req, res) => {
  try {
    const projectRoot = await validatedProjectRoot(req.query.projectPath);
    const snapshot = await readResearchSettings({
      pilotHome: process.env.PILOT_HOME,
      ...(projectRoot ? { projectRoot } : {}),
    });
    if (!snapshot.effective.zotero.enabled) {
      return res.json({
        provider: 'zotero',
        available: false,
        apiReady: false,
        connectorReady: false,
        checkedAt: new Date().toISOString(),
        disabled: true,
        error: 'Zotero integration is disabled in Research Settings.',
      });
    }
    const provider = createZoteroLibraryProvider({
      baseUrl: snapshot.effective.zotero.baseUrl,
      fetchImpl: fetch,
    });
    res.json(await provider.getStatus());
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/zotero/collections', async (req, res) => {
  try {
    const context = await zoteroContext(req.query.projectPath);
    if (!context.enabled) return res.json(disabledZoteroPayload({ collections: [], total: 0, truncated: false }));
    try {
      const result = await context.provider.listCollections();
      return res.json({
        provider: 'zotero',
        available: true,
        ...result,
        boundCollection: configuredCollection(context.settings),
      });
    } catch (error) {
      return res.json(unavailableZoteroPayload(error, { collections: [], total: 0, truncated: false }));
    }
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/zotero/items', async (req, res) => {
  try {
    const context = await zoteroContext(req.query.projectPath);
    const collectionKey = requestCollectionKey(req.query.collectionKey) || configuredCollectionKey(context.settings);
    const query = queryString(req.query.q);
    const limit = positiveInteger(req.query.limit, 50, 100);
    if (!context.enabled) {
      return res.json(disabledZoteroPayload({ collectionKey, items: [], total: 0, truncated: false }));
    }
    try {
      const result = await context.provider.listItems({ collectionKey, query, limit });
      return res.json({
        provider: 'zotero',
        available: true,
        collectionKey,
        collectionName: collectionKey === context.settings.collectionKey
          ? context.settings.collectionName
          : result.collection?.name,
        ...result,
      });
    } catch (error) {
      return res.json(unavailableZoteroPayload(error, { collectionKey, items: [], total: 0, truncated: false }));
    }
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/zotero/items/:itemKey/fulltext', async (req, res) => {
  try {
    const itemKey = requestZoteroItemKey(req.params.itemKey);
    const context = await zoteroContext(req.query.projectPath);
    if (!context.enabled) {
      return res.json(disabledZoteroPayload({ itemKey, attachmentKey: itemKey, content: '' }));
    }
    try {
      const fullText = await context.provider.getAttachmentFullText(itemKey);
      return res.json({ provider: 'zotero', available: true, ...fullText });
    } catch (error) {
      return respondZoteroReadFailure(res, error, { itemKey, attachmentKey: itemKey, content: '' });
    }
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/zotero/items/:itemKey/export', async (req, res) => {
  try {
    const itemKey = requestZoteroItemKey(req.params.itemKey);
    const context = await zoteroContext(req.query.projectPath);
    const format = requestZoteroExportFormat(req.query.format);
    const style = requestCitationStyle(req.query.style, context.citationStyle);
    if (!context.enabled) {
      return res.json(disabledZoteroPayload({ itemKey, format, style, content: '' }));
    }
    try {
      const exportResult = await context.provider.exportItem({ itemKey, format, style });
      return res.json({ provider: 'zotero', available: true, ...exportResult });
    } catch (error) {
      return respondZoteroReadFailure(res, error, { itemKey, format, style, content: '' });
    }
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/zotero/items/:itemKey', async (req, res) => {
  try {
    const itemKey = requestZoteroItemKey(req.params.itemKey);
    const context = await zoteroContext(req.query.projectPath);
    if (!context.enabled) {
      return res.json(disabledZoteroPayload({ itemKey, detail: null }));
    }
    try {
      const detail = await context.provider.getItemDetails(itemKey);
      return res.json({ provider: 'zotero', available: true, itemKey, detail });
    } catch (error) {
      return respondZoteroReadFailure(res, error, { itemKey, detail: null });
    }
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/zotero/match', async (req, res) => {
  try {
    const context = await zoteroContext(req.body?.projectPath);
    const papers = normalizePapers(req.body?.papers);
    const collectionKey = requestCollectionKey(req.body?.collectionKey) || configuredCollectionKey(context.settings);
    if (!context.enabled) {
      return res.json(disabledZoteroPayload({
        collectionKey,
        matches: papers.map((paper) => unmatchedPaper(paper.id, collectionKey)),
      }));
    }
    try {
      const matches = await context.provider.matchPapers({ papers, collectionKey });
      return res.json({ provider: 'zotero', available: true, collectionKey, matches });
    } catch (error) {
      return res.json(unavailableZoteroPayload(error, {
        collectionKey,
        matches: papers.map((paper) => unmatchedPaper(paper.id, collectionKey)),
      }));
    }
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/zotero/import', async (req, res) => {
  try {
    if (req.body?.confirmed !== true) {
      return res.status(409).json({ error: 'Zotero import requires explicit confirmation.' });
    }
    const projectRoot = await validatedProjectRoot(req.body?.projectPath);
    const snapshot = await readResearchSettings({
      pilotHome: process.env.PILOT_HOME,
      ...(projectRoot ? { projectRoot } : {}),
    });
    if (!snapshot.effective.zotero.enabled) {
      return res.status(409).json({ error: 'Zotero integration is disabled in Research Settings.' });
    }
    const papers = normalizePapers(req.body?.papers);
    const provider = createZoteroLibraryProvider({
      baseUrl: snapshot.effective.zotero.baseUrl,
      fetchImpl: fetch,
      timeoutMs: 10_000,
    });
    res.json(await provider.importPapers({ papers, confirmed: true }));
  } catch (error) {
    respondError(res, error);
  }
});

async function validatedProjectRoot(value, required = false) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    if (required) throw new Error('A project path is required for project-scoped settings.');
    return undefined;
  }
  const validation = await validateWorkspacePath(raw);
  if (!validation.valid || !validation.resolvedPath) {
    const error = new Error(validation.error || 'Invalid project path.');
    error.statusCode = 400;
    throw error;
  }
  return validation.resolvedPath;
}

async function zoteroContext(projectPath) {
  const projectRoot = await validatedProjectRoot(projectPath);
  const snapshot = await readResearchSettings({
    pilotHome: process.env.PILOT_HOME,
    ...(projectRoot ? { projectRoot } : {}),
  });
  return {
    enabled: snapshot.effective.zotero.enabled,
    settings: snapshot.effective.zotero,
    citationStyle: snapshot.effective.citation.style,
    provider: createZoteroLibraryProvider({
      baseUrl: snapshot.effective.zotero.baseUrl,
      fetchImpl: fetch,
      timeoutMs: 3_000,
    }),
  };
}

function configuredCollection(settings) {
  return !settings.useSelectedCollection && settings.collectionKey
    ? { key: settings.collectionKey, name: settings.collectionName || settings.collectionKey }
    : undefined;
}

function configuredCollectionKey(settings) {
  return !settings.useSelectedCollection && settings.collectionKey
    ? settings.collectionKey
    : undefined;
}

function disabledZoteroPayload(extra) {
  return {
    provider: 'zotero',
    available: false,
    disabled: true,
    error: 'Zotero integration is disabled in Research Settings.',
    ...extra,
  };
}

function unavailableZoteroPayload(error, extra) {
  return {
    provider: 'zotero',
    available: false,
    error: error instanceof Error ? error.message : String(error),
    ...extra,
  };
}

function respondZoteroReadFailure(res, error, extra) {
  if (error instanceof ZoteroInputError) {
    return res.status(400).json({
      provider: 'zotero',
      available: true,
      error: error.message,
      ...extra,
    });
  }
  if (error instanceof ZoteroLocalApiError && error.status === 404) {
    return res.status(404).json({
      provider: 'zotero',
      available: true,
      error: error.message,
      ...extra,
    });
  }
  return res.json(unavailableZoteroPayload(error, extra));
}

function unmatchedPaper(paperId, collectionKey) {
  return {
    paperId,
    matched: false,
    confidence: 'none',
    reasons: [],
    ...(collectionKey ? { inCollection: false } : {}),
  };
}

function queryString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requestCollectionKey(value) {
  const key = queryString(value);
  if (!key) return undefined;
  if (!/^[A-Za-z0-9]{1,32}$/u.test(key)) {
    const error = new Error('Invalid Zotero collection key.');
    error.statusCode = 400;
    throw error;
  }
  return key;
}

function requestZoteroItemKey(value) {
  const key = queryString(value);
  if (!key || !/^[A-Za-z0-9]{1,32}$/u.test(key)) {
    const error = new Error('Invalid Zotero item key.');
    error.statusCode = 400;
    throw error;
  }
  return key.toUpperCase();
}

function requestZoteroExportFormat(value) {
  if (value === 'bibtex' || value === 'csl-json') return value;
  const error = new Error('format must be "bibtex" or "csl-json".');
  error.statusCode = 400;
  throw error;
}

function requestCitationStyle(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'apa' || value === 'chicago-author-date' || value === 'ieee' || value === 'mla') return value;
  const error = new Error('Unsupported Zotero citation style.');
  error.statusCode = 400;
  throw error;
}

function positiveInteger(value, fallback, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(1, Math.round(parsed))) : fallback;
}

function normalizePapers(value) {
  if (!Array.isArray(value) || value.length === 0) {
    const error = new Error('Select at least one paper to import.');
    error.statusCode = 400;
    throw error;
  }
  return value.slice(0, 50).map((paper, index) => {
    if (!paper || typeof paper !== 'object' || typeof paper.title !== 'string' || !paper.title.trim()) {
      const error = new Error(`Paper ${index + 1} is missing a title.`);
      error.statusCode = 400;
      throw error;
    }
    const id = typeof paper.id === 'string' && paper.id.trim() ? paper.id.trim() : `import-${index + 1}`;
    return {
      id,
      identity: paper.identity && typeof paper.identity === 'object' ? paper.identity : {},
      title: paper.title.trim().slice(0, 2_000),
      authors: Array.isArray(paper.authors)
        ? paper.authors.filter((author) => typeof author === 'string').map((author) => author.trim()).filter(Boolean).slice(0, 100)
        : [],
      ...(Number.isInteger(paper.year) ? { year: paper.year } : {}),
      ...(typeof paper.venue === 'string' ? { venue: paper.venue.slice(0, 500) } : {}),
      ...(typeof paper.doi === 'string' ? { doi: paper.doi.slice(0, 300) } : {}),
      ...(typeof paper.url === 'string' ? { url: paper.url.slice(0, 2_000) } : {}),
      citedByCount: Number.isFinite(paper.citedByCount) ? paper.citedByCount : 0,
      topics: [],
      referencedWorkIds: [],
      sourceId: typeof paper.sourceId === 'string' ? paper.sourceId : 'research-panel',
    };
  });
}

function respondError(res, error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = Number.isInteger(error?.statusCode)
    ? error.statusCode
    : /requires|must|cannot|invalid|missing|disabled/i.test(message)
      ? 400
      : 502;
  res.status(status).json({ error: message });
}

export default router;
