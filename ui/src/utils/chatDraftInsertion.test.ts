import { describe, expect, it } from 'vitest';
import { appendChatDraftText, isChatDraftInsertDetail } from './chatDraftInsertion';

describe('chat draft insertion', () => {
  it('appends structured content without sending or replacing an existing draft', () => {
    expect(appendChatDraftText('Compare these papers.', '[Research paper]\nTitle: Example'))
      .toBe('Compare these papers.\n\n[Research paper]\nTitle: Example');
    expect(appendChatDraftText('', '  citation  ')).toBe('citation');
  });

  it('rejects empty, oversized, and malformed event details', () => {
    expect(isChatDraftInsertDetail({ text: 'citation', source: 'research' })).toBe(true);
    expect(isChatDraftInsertDetail({ text: '' })).toBe(false);
    expect(isChatDraftInsertDetail({ text: 'x'.repeat(12_001) })).toBe(false);
    expect(isChatDraftInsertDetail('citation')).toBe(false);
  });
});
