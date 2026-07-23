import { authenticatedFetch } from '../utils/api';
import type {
  ZoteroAttachmentFullTextResult,
  ZoteroExportFormat,
  ZoteroItemDetailsResult,
  ZoteroItemExportResult,
  ZoteroTagsResult,
} from './types';

const ZOTERO_ITEMS_ROUTE = '/api/research/zotero/items';
const ZOTERO_TAGS_ROUTE = '/api/research/zotero/tags';

type ItemRouteOptions = {
  projectPath?: string;
};

/**
 * The item detail endpoints live behind this small client so the panel does
 * not scatter route strings or query encoding throughout its row components.
 */
export async function getZoteroItemDetails(
  itemKey: string,
  options: ItemRouteOptions = {},
): Promise<ZoteroItemDetailsResult> {
  return getItemJson<ZoteroItemDetailsResult>(itemKey, '', options);
}

/**
 * This endpoint accepts an attachment key, never its parent bibliographic
 * item key.  Callers must invoke it from an explicit user action.
 */
export async function getZoteroAttachmentFullText(
  attachmentKey: string,
  options: ItemRouteOptions = {},
): Promise<ZoteroAttachmentFullTextResult> {
  return getItemJson<ZoteroAttachmentFullTextResult>(attachmentKey, '/fulltext', options);
}

export async function getZoteroItemExport(
  itemKey: string,
  format: ZoteroExportFormat,
  options: ItemRouteOptions = {},
): Promise<ZoteroItemExportResult> {
  return getItemJson<ZoteroItemExportResult>(itemKey, '/export', {
    ...options,
    format,
  });
}

/**
 * The tag catalog is a read-only suggestion source. Call it only after the
 * user explicitly opens tag editing.
 */
export async function getZoteroTags(
  options: ItemRouteOptions & {
    collectionKey?: string;
    query?: string;
    limit?: number;
    start?: number;
  } = {},
): Promise<ZoteroTagsResult> {
  const parameters = new URLSearchParams();
  if (options.projectPath) parameters.set('projectPath', options.projectPath);
  if (options.collectionKey) parameters.set('collectionKey', options.collectionKey);
  if (options.query) parameters.set('q', options.query);
  if (options.limit !== undefined) parameters.set('limit', String(options.limit));
  if (options.start !== undefined) parameters.set('start', String(options.start));
  const query = parameters.toString();
  return getZoteroJson<ZoteroTagsResult>(`${ZOTERO_TAGS_ROUTE}${query ? `?${query}` : ''}`);
}

export async function copyZoteroExportText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.className = 'fixed -left-[10000px] top-0 opacity-0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard access is unavailable.');
}

export function downloadZoteroExportText(value: string, filename: string): void {
  const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function getItemJson<T>(
  itemKey: string,
  suffix: string,
  options: ItemRouteOptions & { format?: ZoteroExportFormat },
): Promise<T> {
  return getZoteroJson<T>(buildItemUrl(itemKey, suffix, options));
}

async function getZoteroJson<T>(route: string): Promise<T> {
  const response = await authenticatedFetch(route, {
    suppressServerErrorToast: true,
  });
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : 'Zotero request failed.');
  }
  if (body && typeof body === 'object' && 'available' in body && body.available === false) {
    throw new Error(typeof body.error === 'string' ? body.error : 'Zotero is unavailable.');
  }
  return body as T;
}

function buildItemUrl(
  itemKey: string,
  suffix: string,
  options: ItemRouteOptions & { format?: ZoteroExportFormat },
): string {
  const parameters = new URLSearchParams();
  if (options.projectPath) parameters.set('projectPath', options.projectPath);
  if (options.format) parameters.set('format', options.format);
  const query = parameters.toString();
  return `${ZOTERO_ITEMS_ROUTE}/${encodeURIComponent(itemKey)}${suffix}${query ? `?${query}` : ''}`;
}
