export const CHAT_DRAFT_INSERT_EVENT = 'rigorium:insert-chat-draft';

export type ChatDraftInsertDetail = {
  text: string;
  source?: string;
};

const MAX_INSERT_CHARS = 12_000;

export function isChatDraftInsertDetail(value: unknown): value is ChatDraftInsertDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const detail = value as Record<string, unknown>;
  return typeof detail.text === 'string'
    && detail.text.trim().length > 0
    && detail.text.length <= MAX_INSERT_CHARS
    && (detail.source === undefined || (typeof detail.source === 'string' && detail.source.length <= 80));
}

export function appendChatDraftText(current: string, insertion: string): string {
  const text = insertion.trim();
  if (!text) return current;
  if (!current.trim()) return text;
  return `${current.replace(/\s+$/u, '')}\n\n${text}`;
}
