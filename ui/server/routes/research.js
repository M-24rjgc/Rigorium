import express from 'express';
import fetch from 'node-fetch';
import { validateWorkspacePath } from './projects.js';
import {
  createZoteroLibraryProvider,
  readResearchSettings,
  writeResearchSettings,
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
