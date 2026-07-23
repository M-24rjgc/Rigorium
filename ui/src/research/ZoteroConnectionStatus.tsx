import { Cloud, RefreshCw, RotateCw, ServerOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { cn } from '../lib/utils';
import { getZoteroConnectionStatus } from './zoteroConnectionApi';
import { getZoteroCloudStatus, probeZoteroCloudSync } from './zoteroCloudApi';
import type { ZoteroCloudStatus, ZoteroCloudSyncResult, ZoteroStatus } from './types';

type ZoteroConnectionStatusProps = {
  projectPath?: string;
  className?: string;
  autoLoad?: boolean;
};

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export function ZoteroConnectionStatus({
  projectPath,
  className,
  autoLoad = true,
}: ZoteroConnectionStatusProps) {
  const [localStatus, setLocalStatus] = useState<ZoteroStatus | null>(null);
  const [cloudStatus, setCloudStatus] = useState<ZoteroCloudStatus | null>(null);
  const [syncResult, setSyncResult] = useState<ZoteroCloudSyncResult | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    setLoadState('loading');
    setSyncResult(null);
    const options = projectPath ? { projectPath } : {};
    const [local, cloud] = await Promise.allSettled([
      getZoteroConnectionStatus(options),
      getZoteroCloudStatus(options),
    ]);
    const checkedAt = new Date().toISOString();
    setLocalStatus(local.status === 'fulfilled' ? local.value : unavailableLocalStatus(local.reason, checkedAt));
    setCloudStatus(cloud.status === 'fulfilled' ? cloud.value : unavailableCloudStatus(cloud.reason, checkedAt));
    setLoadState(local.status === 'fulfilled' && cloud.status === 'fulfilled' ? 'ready' : 'error');
  }, [projectPath]);

  useEffect(() => {
    if (!autoLoad) return;
    void refresh();
  }, [autoLoad, refresh]);

  const probeSync = useCallback(async () => {
    if (!cloudStatus?.available) return;
    setSyncing(true);
    try {
      const result = await probeZoteroCloudSync({
        ...(projectPath ? { projectPath } : {}),
        ...(cloudStatus.libraryVersion === undefined ? {} : { sinceVersion: cloudStatus.libraryVersion }),
      });
      setSyncResult(result);
      setCloudStatus(result.provider);
    } catch (error) {
      const checkedAt = new Date().toISOString();
      setCloudStatus(unavailableCloudStatus(error, checkedAt));
      setSyncResult(null);
    } finally {
      setSyncing(false);
    }
  }, [cloudStatus, projectPath]);

  const local = localStatus ?? idleLocalStatus();
  const cloud = cloudStatus ?? idleCloudStatus();
  const canProbeSync = Boolean(cloudStatus?.available) && !syncing;

  return (
    <section
      aria-label="Zotero connection status"
      className={cn('rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950', className)}
      data-testid="zotero-connection-status"
    >
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
          <Cloud aria-hidden="true" className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[12px] font-semibold text-neutral-900 dark:text-neutral-100">Zotero</h3>
          <p className="text-[10px] text-neutral-500 dark:text-neutral-400">{connectionSummary(local, cloud)}</p>
        </div>
        <button
          aria-label="Refresh Zotero status"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-neutral-200 text-neutral-600 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
          disabled={loadState === 'loading'}
          onClick={() => void refresh()}
          title="Refresh Zotero status"
          type="button"
        >
          <RefreshCw aria-hidden="true" className={cn('h-3.5 w-3.5', loadState === 'loading' && 'animate-spin')} />
        </button>
        <button
          aria-label="Check Zotero changes"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-neutral-200 text-neutral-600 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
          disabled={!canProbeSync}
          onClick={() => void probeSync()}
          title="Check Zotero changes"
          type="button"
        >
          <RotateCw aria-hidden="true" className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
        </button>
      </div>

      <div className="mt-3 grid gap-2">
        <StatusRow
          label="Desktop"
          status={localStatusLabel(local)}
          detail={local.error || localCollectionDetail(local)}
          tone={local.connectorReady ? 'success' : local.disabled ? 'neutral' : 'warning'}
          testId="zotero-local-status"
        />
        <StatusRow
          label="Cloud"
          status={cloudStatusLabel(cloud)}
          detail={cloud.error || cloudLibraryDetail(cloud)}
          tone={cloud.available ? (cloud.writable ? 'success' : 'warning') : cloud.status === 'unconfigured' ? 'neutral' : 'warning'}
          testId="zotero-cloud-status"
        />
      </div>

      {syncResult ? (
        <p className="mt-2 min-w-0 break-words text-[10px] leading-4 text-neutral-500 dark:text-neutral-400" data-testid="zotero-sync-result">
          {syncResultLabel(syncResult)}
        </p>
      ) : null}
    </section>
  );
}

function StatusRow({
  label,
  status,
  detail,
  tone,
  testId,
}: {
  label: string;
  status: string;
  detail?: string;
  tone: 'success' | 'warning' | 'neutral';
  testId: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md border border-neutral-100 px-2 py-1.5 dark:border-neutral-800" data-testid={testId}>
      <ServerOff aria-hidden="true" className={cn(
        'mt-0.5 h-3.5 w-3.5 shrink-0',
        tone === 'success' ? 'text-emerald-600 dark:text-emerald-300' : tone === 'warning' ? 'text-amber-600 dark:text-amber-300' : 'text-neutral-400',
      )} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-[10px] font-medium text-neutral-700 dark:text-neutral-200">{label}</span>
          <span className="min-w-0 truncate text-[10px] text-neutral-500 dark:text-neutral-400">{status}</span>
        </div>
        {detail ? <p className="mt-0.5 min-w-0 break-words text-[10px] leading-4 text-neutral-500 dark:text-neutral-400">{detail}</p> : null}
      </div>
    </div>
  );
}

function idleLocalStatus(): ZoteroStatus {
  return {
    provider: 'zotero',
    available: false,
    apiReady: false,
    connectorReady: false,
    checkedAt: new Date(0).toISOString(),
  };
}

function idleCloudStatus(): ZoteroCloudStatus {
  return {
    provider: 'zotero-cloud',
    status: 'unconfigured',
    configured: false,
    available: false,
    writable: false,
    checkedAt: new Date(0).toISOString(),
  };
}

function unavailableLocalStatus(error: unknown, checkedAt: string): ZoteroStatus {
  return {
    ...idleLocalStatus(),
    checkedAt,
    error: error instanceof Error ? error.message : String(error),
  };
}

function unavailableCloudStatus(error: unknown, checkedAt: string): ZoteroCloudStatus {
  return {
    ...idleCloudStatus(),
    status: 'error',
    checkedAt,
    error: error instanceof Error ? error.message : String(error),
  };
}

function connectionSummary(local: ZoteroStatus, cloud: ZoteroCloudStatus): string {
  if (local.connectorReady && cloud.available) return 'Desktop and cloud available';
  if (local.connectorReady) return 'Desktop available';
  if (cloud.available) return 'Cloud available';
  return 'Checking local and cloud connections';
}

function localStatusLabel(status: ZoteroStatus): string {
  if (status.disabled) return 'Disabled';
  if (status.connectorReady) return 'Connected';
  if (status.apiReady) return 'API available';
  return 'Unavailable';
}

function cloudStatusLabel(status: ZoteroCloudStatus): string {
  const labels: Record<ZoteroCloudStatus['status'], string> = {
    unconfigured: 'Unconfigured',
    ready: 'Connected',
    read_only: 'Read only',
    offline: 'Offline',
    rate_limited: 'Rate limited',
    error: 'Unavailable',
  };
  return labels[status.status];
}

function localCollectionDetail(status: ZoteroStatus): string | undefined {
  if (!status.selectedCollection?.name) return undefined;
  return status.selectedCollection.libraryName
    ? `${status.selectedCollection.libraryName}: ${status.selectedCollection.name}`
    : status.selectedCollection.name;
}

function cloudLibraryDetail(status: ZoteroCloudStatus): string | undefined {
  if (!status.library) return undefined;
  const version = status.libraryVersion === undefined ? '' : ` v${status.libraryVersion}`;
  return `${status.library.path}${version}`;
}

function syncResultLabel(result: ZoteroCloudSyncResult): string {
  if (result.status === 'unavailable') return result.provider.error || 'Change check unavailable';
  const changes = Object.keys(result.itemVersions).length
    + Object.keys(result.collectionVersions).length
    + result.deleted.items.length
    + result.deleted.collections.length
    + result.deleted.searches.length;
  return result.status === 'unchanged'
    ? 'No Zotero changes found'
    : `${changes} Zotero changes found`;
}

export default ZoteroConnectionStatus;
