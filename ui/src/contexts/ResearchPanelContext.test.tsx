import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResearchArtifact } from '../research/types';
import { ResearchPanelProvider, useResearchPanel } from './ResearchPanelContext';

const artifact = (id: string): ResearchArtifact => ({
  schemaVersion: 1,
  kind: 'literature_search',
  artifactId: id,
  createdAt: '2026-07-22T00:00:00.000Z',
  intent: { text: 'research agents' },
  plan: { query: 'research agents', limit: 1, sort: 'relevance', sourceIds: ['openalex'] },
  papers: [],
  edges: [],
  sources: [],
  coverage: { status: 'complete', resultCount: 0, warnings: [] },
  presentation: { autoOpen: true },
});

function Harness() {
  const panel = useResearchPanel();
  return (
    <div>
      <span data-testid="state">{panel.isOpen ? 'open' : 'closed'}:{panel.artifact?.artifactId || 'none'}</span>
      <button onClick={() => panel.ingestArtifact(artifact('one'), 'D:/project')}>ingest one</button>
      <button onClick={panel.closePanel}>close</button>
      <button onClick={() => panel.ingestArtifact(artifact('two'), 'D:/project')}>ingest two</button>
    </div>
  );
}

describe('ResearchPanelContext', () => {
  afterEach(() => cleanup());

  it('uses a closed no-op panel when a legacy surface renders without the provider', () => {
    render(<Harness />);
    expect(screen.getByTestId('state').textContent).toBe('closed:none');
    fireEvent.click(screen.getByText('ingest one'));
    expect(screen.getByTestId('state').textContent).toBe('closed:none');
  });

  it('opens for a new artifact, stays closed for the same artifact, and reopens for the next artifact', () => {
    render(<ResearchPanelProvider><Harness /></ResearchPanelProvider>);
    fireEvent.click(screen.getByText('ingest one'));
    expect(screen.getByTestId('state').textContent).toContain('open:one');
    fireEvent.click(screen.getByText('close'));
    expect(screen.getByTestId('state').textContent).toContain('closed:one');
    fireEvent.click(screen.getByText('ingest one'));
    expect(screen.getByTestId('state').textContent).toContain('closed:one');
    fireEvent.click(screen.getByText('ingest two'));
    expect(screen.getByTestId('state').textContent).toContain('open:two');
  });
});
