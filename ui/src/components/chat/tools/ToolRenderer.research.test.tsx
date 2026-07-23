import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ResearchPanelProvider, useResearchPanel } from '../../../contexts/ResearchPanelContext';
import type { ResearchArtifact, ResearchDirectionSeedArtifact } from '../../../research/types';
import {
  directionAssessmentArtifact,
  directionLifecycleArtifact,
  titleConfirmationArtifact,
} from '../../../research/directionArtifacts.fixtures';
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

const directionArtifact: ResearchDirectionSeedArtifact = {
  schemaVersion: 1,
  kind: 'research_direction_seed',
  artifactId: 'tool-renderer-direction-artifact',
  createdAt: '2026-07-23T00:00:00.000Z',
  input: {
    cues: [{ id: 'interest', kind: 'interest', text: 'Reliable model evaluation' }],
    candidates: [{
      id: 'evaluation-under-shift',
      summary: 'Evaluate calibration under distribution shift.',
      cueIds: ['interest'],
    }],
  },
  result: {
    cues: [{ id: 'interest', kind: 'interest', text: 'Reliable model evaluation' }],
    terminology: [],
    constraints: [],
    constraintCoverage: { status: 'not_provided', suppliedConstraintIds: [], unresolvedConstraintIds: [] },
    candidateDirections: [{
      id: 'evaluation-under-shift',
      summary: 'Evaluate calibration under distribution shift.',
      cueIds: ['interest'],
      terminologyIds: [],
      constraintIds: [],
      hypotheses: [],
      contributions: [],
      provisionalTitle: {
        status: 'proposed',
        text: 'Provisional: Evaluating calibration under distribution shift',
        origin: 'summary_fallback',
        reasonCodes: ['provisional'],
        confirmation: {
          status: 'pending',
          confirmed: false,
          requiresExplicitUserAction: true,
          projectNameUpdate: { status: 'not_ready', requiresExplicitUserAction: true },
        },
      },
    }],
  },
  presentation: { autoOpen: true },
};

function Probe() {
  const panel = useResearchPanel();
  return <span data-testid="research-state">{panel.isOpen ? 'open' : 'closed'}:{panel.artifact?.artifactId || 'none'}:{panel.artifactProjectPath || 'none'}:{panel.selectedPaperId || 'none'}</span>;
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

  it('publishes a research direction seed without treating it as a paper selection', async () => {
    render(
      <ResearchPanelProvider>
        <ToolRenderer
          toolName="research_direction_seed"
          toolInput={{ cues: ['Reliable model evaluation'] }}
          toolResult={{ content: 'done', isError: false, toolUseResult: directionArtifact }}
          toolId="call-research-direction"
          mode="result"
          selectedProject={{ name: 'project', displayName: 'Project', fullPath: 'D:/project' }}
        />
        <Probe />
      </ResearchPanelProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('research-state').textContent).toContain('open:tool-renderer-direction-artifact:D:/project:none');
    });
  });

  it.each([
    ['direction_assess', directionAssessmentArtifact],
    ['research_title_confirm', titleConfirmationArtifact],
    ['research_direction_lifecycle', directionLifecycleArtifact],
  ])('publishes %s as one non-literature research panel artifact', async (toolName, resultArtifact) => {
    render(
      <ResearchPanelProvider>
        <ToolRenderer
          toolName={toolName}
          toolInput={{}}
          toolResult={{ content: 'done', isError: false, toolUseResult: resultArtifact }}
          toolId={`call-${toolName}`}
          mode="result"
          selectedProject={{ name: 'project', displayName: 'Project', fullPath: 'D:/project' }}
        />
        <Probe />
      </ResearchPanelProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('research-state').textContent).toBe(`open:${resultArtifact.artifactId}:D:/project:none`);
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
      expect(screen.getByTestId('research-state').textContent).toBe('closed:none:none:none');
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
      expect(screen.getByTestId('research-state').textContent).toBe('closed:none:none:none');
    });
  });
});
