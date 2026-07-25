import { describe, expect, it } from 'vitest';
import { detectResearchPanelActivation } from './activation';

describe('detectResearchPanelActivation', () => {
  const now = new Date('2026-07-26T00:00:00.000Z');

  it.each([
    'Capture an experiment snapshot, export the PDF, write it to Zotero, and confirm the final title.',
    '为这个实验创建快照，导出 PDF，写入 Zotero，并确认最终标题。',
  ])('recognizes research intents and confirmation boundaries in %s', (query) => {
    const activation = detectResearchPanelActivation(query, now);

    expect(activation).not.toBeNull();
    expect(activation?.intents).toEqual(expect.arrayContaining(['experiment', 'literature']));
    expect(activation?.confirmationBoundaries).toEqual([
      'export',
      'final_title',
      'snapshot',
      'zotero_write',
    ]);
    expect(activation?.activatedAt).toBe(now.toISOString());
  });

  it('does not open the research panel for ordinary chat', () => {
    expect(detectResearchPanelActivation('Can you help me word this email?', now)).toBeNull();
    expect(detectResearchPanelActivation('Run the unit tests and analyze this code.', now)).toBeNull();
    expect(detectResearchPanelActivation('运行单元测试并分析这段代码。', now)).toBeNull();
  });

  it('does not treat reading a paper PDF as an export request', () => {
    const activation = detectResearchPanelActivation('Read this paper PDF and summarize its citations.', now);

    expect(activation?.intents).toContain('literature');
    expect(activation?.confirmationBoundaries).not.toContain('export');
  });

  it('marks an explicit Slurm launch as remote execution', () => {
    const activation = detectResearchPanelActivation('Run this experiment on the Slurm cluster.', now);

    expect(activation?.intents).toContain('experiment');
    expect(activation?.confirmationBoundaries).toContain('remote_execution');
  });
});
