import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ATTACHMENT_FILE_URL_CHARS = 16_384;

export function normalizeZoteroAttachmentKey(value) {
  if (typeof value !== 'string' || value !== value.trim() || !/^[A-Za-z0-9]{1,32}$/.test(value)) {
    throw new Error('The Zotero attachment key is invalid.');
  }
  return value.toUpperCase();
}

/** Converts a verified local Zotero file URL inside the trusted main process. */
export function localZoteroAttachmentPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ATTACHMENT_FILE_URL_CHARS) {
    throw new Error('Zotero returned an unsafe attachment path.');
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'file:'
      || (host && host !== 'localhost')
      || url.pathname.startsWith('//')
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
    ) {
      throw new Error('unsafe attachment URL');
    }
    const filePath = fileURLToPath(url);
    if (!isAbsolute(filePath) || /^(?:\\\\|\/\/)/.test(filePath)) {
      throw new Error('non-local attachment path');
    }
    return filePath;
  } catch {
    throw new Error('Zotero returned an unsafe attachment path.');
  }
}

/**
 * Keeps the file URL and decoded path inside Electron main. Callers receive
 * only a completion outcome that is safe to expose through preload.
 */
export async function openZoteroAttachment({ attachmentKey, requestAttachment, openPath }) {
  const key = normalizeZoteroAttachmentKey(attachmentKey);
  const result = await requestAttachment(key);
  if (!result || result.available !== true || typeof result.fileUrl !== 'string') {
    throw new Error('The Zotero attachment is unavailable.');
  }
  const openError = await openPath(localZoteroAttachmentPath(result.fileUrl));
  if (openError) throw new Error('Unable to open the Zotero attachment.');
  return { opened: true };
}
