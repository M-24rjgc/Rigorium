import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

function Probe() {
  const panel = useResearchPanel();
  return <span data-testid="research-state">{panel.isOpen ? 'open' : 'closed'}:{panel.artifact?.artifactId || 'none'}:{panel.artifactProjectPath || 'none'}</span>;
}

describe('ToolRenderer literature integration', () => {
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
});
