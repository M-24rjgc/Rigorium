import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { isResearchArtifact, type ResearchArtifact } from '../types';
import { LiteratureMap } from './LiteratureMap';

const artifact: ResearchArtifact = {
  schemaVersion: 1,
  kind: 'literature_expansion',
  artifactId: 'literature-map-component-test',
  createdAt: '2026-07-23T00:00:00.000Z',
  intent: { text: 'citation graph' },
  plan: {
    seed: { title: 'Seed paper', year: 2025 },
    directions: ['references', 'citations'],
    limitPerDirection: 10,
    sourceIds: ['openalex'],
  },
  seedPaperId: 'P1',
  directions: [
    { direction: 'references', status: 'ok', resultCount: 1, truncated: false },
    { direction: 'citations', status: 'ok', resultCount: 1, truncated: false },
  ],
  papers: [
    {
      id: 'P1',
      title: 'Seed paper',
      authors: ['Ada'],
      year: 2025,
      citedByCount: 12,
      topics: [{ id: 'agents', name: 'Agents' }],
      referencedWorkIds: ['P2', 'P3'],
      sourceId: 'openalex',
    },
    {
      id: 'P2',
      title: 'Reference paper',
      authors: ['Grace'],
      year: 2024,
      citedByCount: 8,
      topics: [{ id: 'agents', name: 'Agents' }],
      referencedWorkIds: ['EXTERNAL'],
      sourceId: 'openalex',
    },
    {
      id: 'P3',
      title: 'Citing paper',
      authors: ['Lin'],
      year: 2023,
      citedByCount: 2,
      topics: [{ id: 'systems', name: 'Systems' }],
      referencedWorkIds: ['P2', 'EXTERNAL'],
      sourceId: 'openalex',
    },
  ],
  edges: [
    { id: 'citation-p3-p1', source: 'P3', target: 'P1', type: 'citation', weight: 1, inferred: false },
    { id: 'shared-topic-p1-p2', source: 'P1', target: 'P2', type: 'shared_topic', weight: 0.8, inferred: true, evidence: ['Agents'] },
  ],
  sources: [{
    id: 'openalex',
    name: 'OpenAlex',
    status: 'ok',
    retrievedAt: '2026-07-23T00:00:00.000Z',
    resultCount: 3,
    coverage: 'Fixture data.',
  }],
  coverage: { status: 'complete', resultCount: 3, warnings: [] },
};

const providerTopicSimilarityArtifact: unknown = {
  schemaVersion: 1,
  kind: 'literature_search',
  artifactId: 'literature-map-topic-similarity-component-test',
  createdAt: '2026-07-23T00:00:00.000Z',
  intent: { text: 'topic similarity' },
  plan: { query: 'topic similarity', limit: 2, sort: 'relevance', sourceIds: ['openalex'] },
  papers: [
    {
      id: 'P1',
      title: 'Topic anchor',
      authors: ['Ada'],
      citedByCount: 3,
      topics: [
        { id: 'https://openalex.org/T1', name: 'Agents' },
        { id: 'https://openalex.org/T2', name: 'Systems' },
      ],
      referencedWorkIds: [],
      sourceId: 'openalex',
    },
    {
      id: 'P2',
      title: 'Topic neighbor',
      authors: ['Grace'],
      citedByCount: 2,
      topics: [
        { id: 'https://openalex.org/T1', name: 'Agents' },
        { id: 'https://openalex.org/T3', name: 'Evaluation' },
      ],
      referencedWorkIds: [],
      sourceId: 'openalex',
    },
  ],
  edges: [{
    id: 'provider-topic-p1-p2',
    source: 'P1',
    target: 'P2',
    type: 'topic_similarity',
    weight: 0.5,
    inferred: true,
    evidence: ['topic:https://openalex.org/t1'],
  }],
  sources: [{
    id: 'openalex',
    name: 'OpenAlex',
    status: 'ok',
    retrievedAt: '2026-07-23T00:00:00.000Z',
    resultCount: 2,
    coverage: 'Fixture data.',
  }],
  coverage: { status: 'complete', resultCount: 2, warnings: [] },
};

describe('LiteratureMap', () => {
  it('renders five projections from one real-shaped artifact and keeps inferred edges labeled', () => {
    const selectPaper = vi.fn();
    const action = vi.fn();
    render(<LiteratureMap artifact={artifact} onPaperAction={action} onSelectPaper={selectPaper} />);

    expect(screen.getByTestId('literature-map-network')).not.toBeNull();
    expect(screen.getByTestId('literature-map-edge-artifact:shared-topic-p1-p2').getAttribute('data-inferred')).toBe('true');
    expect(screen.getByTestId('literature-map-edge-artifact:citation-p3-p1').getAttribute('data-relation-kind')).toBe('citation');

    fireEvent.click(screen.getByTestId('literature-map-node-P2'));
    expect(selectPaper).toHaveBeenCalledWith('P2');
    fireEvent.click(screen.getByRole('button', { name: /Set seed/i }));
    expect(action).toHaveBeenCalledWith({ action: 'set_seed', paperId: 'P2' });

    fireEvent.click(screen.getByRole('tab', { name: /Topics/i }));
    expect(screen.getByTestId('literature-map-topic-agents')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Timeline/i }));
    expect(screen.getByTestId('literature-map-year-2025')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Tree/i }));
    expect(screen.getByTestId('literature-map-tree')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Table/i }));
    expect(screen.getByTestId('literature-map-row-P1')).not.toBeNull();
  });

  it('exposes zoom, relation filters, error, and empty states without persisting research mutations', () => {
    const { rerender } = render(<LiteratureMap artifact={artifact} />);

    fireEvent.click(screen.getByRole('button', { name: /Zoom in/i }));
    expect(screen.getByTestId('literature-map-zoom').textContent).toBe('125%');
    fireEvent.click(screen.getByLabelText(/Topics \/ 主题推断/i));
    expect(screen.queryByTestId('literature-map-edge-artifact:shared-topic-p1-p2')).toBeNull();

    rerender(<LiteratureMap artifact={artifact} error="Source timed out." />);
    expect(screen.getByRole('alert').textContent).toContain('Source timed out.');
    rerender(<LiteratureMap artifact={null} />);
    expect(screen.getByText(/No literature records/i)).not.toBeNull();
  });

  it('validates, renders, and filters a provider topic-similarity edge', () => {
    const artifact = JSON.parse(JSON.stringify(providerTopicSimilarityArtifact)) as unknown;
    expect(isResearchArtifact(artifact)).toBe(true);
    if (!isResearchArtifact(artifact)
      || (artifact.kind !== 'literature_search' && artifact.kind !== 'literature_expansion')) {
      throw new Error('Provider topic-similarity artifact should validate as literature data.');
    }

    const { unmount } = render(<LiteratureMap artifact={artifact} />);

    const edge = screen.getByTestId('literature-map-edge-artifact:provider-topic-p1-p2');
    expect(edge.getAttribute('data-relation-kind')).toBe('topic_similarity');
    expect(edge.getAttribute('data-inferred')).toBe('true');
    fireEvent.click(screen.getByLabelText(/Similarity \/ 主题相似/i));
    expect(screen.queryByTestId('literature-map-edge-artifact:provider-topic-p1-p2')).toBeNull();
    unmount();
  });

  it('uses supplied fixed positions without moving the rest of the projection', () => {
    render(<LiteratureMap artifact={artifact} pinnedPositions={{ P2: { x: 84, y: 116 } }} />);

    const pinnedNode = screen.getByTestId('literature-map-node-P2');
    expect(pinnedNode.getAttribute('data-pinned')).toBe('true');
    expect(pinnedNode.getAttribute('transform')).toBe('translate(84, 116)');
  });
});
