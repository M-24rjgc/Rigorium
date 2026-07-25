import { describe, expect, it } from 'vitest';
import { createResearchToolActivity } from './toolActivity';

describe('createResearchToolActivity', () => {
  const now = new Date('2026-07-26T00:00:00.000Z');

  it('keeps snapshot, export, title, and Zotero confirmation boundaries distinct', () => {
    const snapshot = createResearchToolActivity({
      toolName: 'research_method',
      toolId: 'snapshot-1',
      input: { action: 'capture_snapshot' },
      result: { data: { action: 'capture_snapshot', artifactId: 'implementation-snapshot' } },
      now,
    });
    expect(snapshot?.confirmationBoundaries).toEqual(['snapshot']);

    const exportActivity = createResearchToolActivity({
      toolName: 'manuscript_latex',
      toolId: 'export-1',
      input: { operation: 'export_pdf' },
      result: { data: { operation: 'export_pdf', artifactId: 'paper-pdf' } },
      now,
    });
    expect(exportActivity?.confirmationBoundaries).toEqual(['export']);

    const title = createResearchToolActivity({
      toolName: 'research_title_confirm',
      toolId: 'title-1',
      input: {},
      result: { data: { status: 'pending' } },
      now,
    });
    expect(title?.confirmationBoundaries).toEqual(['final_title']);

    const director = createResearchToolActivity({
      toolName: 'research_director',
      toolId: 'director-1',
      input: {
        request: {
          destination: 'zotero',
          action: 'write',
          export: 'pdf',
          capture: 'snapshot',
          title: 'final_title',
        },
      },
      result: { data: { planId: 'plan-1' } },
      now,
    });
    expect(director?.confirmationBoundaries).toEqual(expect.arrayContaining([
      'zotero_write',
      'export',
      'snapshot',
      'final_title',
    ]));
    expect(director?.confirmationBoundaries).toHaveLength(4);
  });
});
