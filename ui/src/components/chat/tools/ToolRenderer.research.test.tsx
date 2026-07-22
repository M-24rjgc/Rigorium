import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ResearchPanelProvider, useResearchPanel } from '../../../contexts/ResearchPanelContext';
import type { ResearchArtifact } from '../../../research/types';
import { ToolRenderer } from './ToolRenderer';

const artifact: ResearchArtifact = {
  schemaVersion: 1,
  kind: 'literature_search',
  artifactId: 'tool-renderer-artifact',
  createdAt: '2026-07-22T00:00:00.000Z',
  intent: { text: 'research agents' },
  plan: { query: 'research agents', limit: 1, sort: 'relevance', sourceIds: ['openalex'] },
  papers: [],
  edges: [],
  sources: [],
  coverage: { status: 'complete', resultCount: 0, warnings: [] },
  presentation: { autoOpen: true },
};

const expansionArtifact: ResearchArtifact = {
  schemaVersion: 1,
  kind: 'literature_expansion',
  artifactId: 'tool-renderer-expansion-artifact',
  createdAt: '2026-07-22T00:00:00.000Z',
  intent: { text: 'Expand the seed paper.' },
  plan: {
    seed: { openAlexId: 'https://openalex.org/Wseed', title: 'Seed paper' },
    directions: ['references', 'citations'],
    limitPerDirection: 20,
    sourceIds: ['openalex'],
  },
  seedPaperId: 'Wseed',
  papers: [{
    id: 'Wseed',
    title: 'Seed paper',
    authors: [],
    citedByCount: 0,
    topics: [],
    sourceId: 'openalex',
  }],
  edges: [],
  sources: [],
  directions: [
    { direction: 'references', status: 'unavailable', resultCount: 0, truncated: false },
    { direction: 'citations', status: 'unavailable', resultCount: 0, truncated: false },
  ],
  coverage: { status: 'failed', resultCount: 1, warnings: [] },
  presentation: { autoOpen: true },
};

function Probe() {
  const panel = useResearchPanel();
  return <span data-testid="research-state">{panel.isOpen ? 'open' : 'closed'}:{panel.artifact?.artifactId || 'none'}:{panel.artifactProjectPath || 'none'}</span>;
}

describe('ToolRenderer literature integration', () => {
  afterEach(() => cleanup());

  it('publishes a structured literature result to the research panel context', async () => {
    render(
      <ResearchPanelProvider>
        <ToolRenderer
          toolName="literature_search"
          toolInput={{ query: 'research agents' }}
          toolResult={{ content: 'done', isError: false, toolUseResult: artifact }}
          toolId="call-literature"
          mode="result"
          selectedProject={{ name: 'project', displayName: 'Project', fullPath: 'D:/project' }}
        />
        <Probe />
      </ResearchPanelProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('research-state').textContent).toContain('open:tool-renderer-artifact:D:/project');
    });
  });

  it('publishes a structured citation expansion to the same research panel context', async () => {
    render(
      <ResearchPanelProvider>
        <ToolRenderer
          toolName="literature_expand"
          toolInput={{ seed: { openAlexId: 'https://openalex.org/Wseed' }, directions: ['references', 'citations'] }}
          toolResult={{ content: 'done', isError: false, toolUseResult: expansionArtifact }}
          toolId="call-literature-expand"
          mode="result"
          selectedProject={{ name: 'project', displayName: 'Project', fullPath: 'D:/project' }}
        />
        <Probe />
      </ResearchPanelProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('research-state').textContent).toContain('open:tool-renderer-expansion-artifact:D:/project');
    });
  });

  it('rejects malformed search and expansion artifacts without ingesting or crashing', async () => {
    const malformedSearch = {
      ...artifact,
      artifactId: 'malformed-search',
      papers: [{ id: 'broken-search-paper', title: 'Missing renderer fields' }],
    };
    const malformedExpansion = {
      ...expansionArtifact,
      artifactId: 'malformed-expansion',
      coverage: undefined,
      papers: [{ id: 'Wseed' }],
    };

    const { rerender } = render(
      <ResearchPanelProvider>
        <ToolRenderer
          toolName="literature_search"
          toolInput={{ query: 'broken' }}
          toolResult={{ content: 'done', isError: false, toolUseResult: malformedSearch }}
          toolId="call-malformed-search"
          mode="result"
        />
        <Probe />
      </ResearchPanelProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('research-state').textContent).toBe('closed:none:none');
    });

    rerender(
      <ResearchPanelProvider>
        <ToolRenderer
          toolName="literature_expand"
          toolInput={{ seed: { openAlexId: 'https://openalex.org/Wseed' } }}
          toolResult={{ content: 'done', isError: false, toolUseResult: malformedExpansion }}
          toolId="call-malformed-expansion"
          mode="result"
        />
        <Probe />
      </ResearchPanelProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('research-state').textContent).toBe('closed:none:none');
    });
  });
});
