import { authenticatedFetch } from '../utils/api';
import type { ZoteroStatus } from './types';

const ZOTERO_STATUS_ROUTE = '/api/research/zotero/status';

export type ZoteroConnectionOptions = {
  projectPath?: string;
};

/** Reads the local Zotero connector state. It never changes Zotero data. */
export async function getZoteroConnectionStatus(
  options: ZoteroConnectionOptions = {},
): Promise<ZoteroStatus> {
  const params = new URLSearchParams();
  if (options.projectPath?.trim()) params.set('projectPath', options.projectPath.trim());
  const response = await authenticatedFetch(`${ZOTERO_STATUS_ROUTE}${params.size ? `?${params}` : ''}`, {
    suppressServerErrorToast: true,
  });
  const body = await response.json().catch(() => null) as { error?: unknown } | ZoteroStatus | null;
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : 'Failed to check Zotero.';
    throw new Error(message);
  }
  if (!body || typeof body !== 'object' || !('provider' in body) || body.provider !== 'zotero') {
    throw new Error('Zotero returned an invalid status response.');
  }
  return body as ZoteroStatus;
}
