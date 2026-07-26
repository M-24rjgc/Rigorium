import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLiteratureMapMaintenanceTool } from '../../src/tool/builtin/literatureMaintenance.js';
import { createDefaultPermissionContext } from '../../src/permission/protocol/types.js';

test('literature map maintenance tool emits candidate-only result for static source payloads', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rigorium-maintenance-tool-'));
  try {
    const tool = createLiteratureMapMaintenanceTool();
    const result = await tool.execute({
      projectRoot,
      mapId: 'tool-map',
      trigger: 'new_papers',
      sources: [{
        id: 'search',
        coverage: 'fixture',
        papers: [{
          id: 'W-tool',
          identity: { openAlexId: 'https://openalex.org/W-tool' },
          title: 'Tool paper',
          authors: ['Ada Lovelace'],
          year: 2025,
          citedByCount: 0,
          topics: [],
          referencedWorkIds: [],
          sourceId: 'search',
          sourceIds: ['search'],
          provenance: [{ sourceId: 'search', sourceRecordId: 'W-tool', rank: 1, retrievedAt: '2026-07-23T00:00:00.000Z' }],
        }],
      }],
    }, {
      sessionId: 'test-session',
      turnId: 'test-turn',
      cwd: projectRoot,
      permissionMode: 'default',
      permissionContext: createDefaultPermissionContext({ cwd: projectRoot }),
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });
    assert.equal(result.data?.safety.zoteroWritePerformed, false);
    assert.equal(result.data?.candidateReview.pendingCandidatePaperIds[0], 'W-tool');
    assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /Zotero write/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
