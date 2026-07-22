import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiteratureSearchTool } from '../dist/src/tool/builtin/literatureSearch.js';

const query = process.argv.slice(2).join(' ').trim() || 'retrieval augmented generation';
const tool = createLiteratureSearchTool();
const startedAt = Date.now();
const result = await tool.execute({
  query,
  limit: 3,
  fromYear: 2024,
  toYear: new Date().getUTCFullYear() + 1,
}, {
  cwd: process.cwd(),
  env: { PILOT_HOME: join(tmpdir(), 'rigorium-literature-live-smoke') },
});

const artifact = result.data;
if (!artifact) throw new Error('The literature tool did not return a research artifact.');

const summary = {
  query,
  elapsedMs: Date.now() - startedAt,
  coverage: artifact.coverage,
  sources: artifact.sources.map((source) => ({
    id: source.id,
    status: source.status,
    resultCount: source.resultCount,
    totalMatches: source.totalMatches,
    error: source.error,
  })),
  papers: artifact.papers.map((paper) => ({
    title: paper.title,
    doi: paper.doi,
    arxiv: paper.identity.arxiv,
    sourceId: paper.sourceId,
    sourceIds: paper.sourceIds,
    provenanceCount: paper.provenance.length,
  })),
  relationshipCount: artifact.edges.length,
};

console.log(JSON.stringify(summary, null, 2));

const expectedSources = new Set(['openalex', 'arxiv', 'crossref']);
const returnedSources = new Map(artifact.sources.map((source) => [source.id, source]));
for (const sourceId of expectedSources) {
  if (returnedSources.get(sourceId)?.status !== 'ok') {
    throw new Error(`${sourceId} did not pass the live source smoke test.`);
  }
}
if (artifact.coverage.status !== 'complete' || artifact.papers.length === 0) {
  throw new Error('The live multi-source search did not return complete, non-empty coverage.');
}
