import {
  Activity,
  ArchiveRestore,
  ArchiveX,
  BookOpen,
  Camera,
  Check,
  GitBranch,
  History,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../utils/api';
import {
  loadProjectLiteratureMapMaintenanceAudits,
  runProjectLiteratureMapMaintenance,
  type LiteratureMapMaintenanceAudit,
  type LiteratureMapMaintenanceResult,
} from './literatureMapApi';

export type LiteratureMaintenancePanelProps = {
  projectPath?: string;
  mapId: string;
  onCompleted?: (result: LiteratureMapMaintenanceResult) => void | Promise<void>;
};

type MapDiff = {
  fromRevision: number;
  toRevision: number;
  nodes: { added: string[]; updated: string[]; tombstoned: string[]; restored: string[] };
  edges: { added: string[]; updated: string[]; tombstoned: string[]; restored: string[] };
  warnings: string[];
};

type BridgeAnalysis = {
  bridges: Array<{ paperId: string; title?: string }>;
  graph: { activePaperCount: number; activeRelationCount: number };
};

/** Compact bilingual controls for explicit, candidate-only maintenance runs. */
export function LiteratureMaintenancePanel({ projectPath, mapId, onCompleted }: LiteratureMaintenancePanelProps) {
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LiteratureMapMaintenanceResult | null>(null);
  const [audits, setAudits] = useState<LiteratureMapMaintenanceAudit[]>([]);
  const [mapOperation, setMapOperation] = useState<'bridges' | 'diff' | 'snapshot' | 'tombstone' | null>(null);
  const [mapOperationLoading, setMapOperationLoading] = useState(false);
  const [mapOperationError, setMapOperationError] = useState<string | null>(null);
  const [bridges, setBridges] = useState<BridgeAnalysis | null>(null);
  const [lastDiff, setLastDiff] = useState<MapDiff | null>(null);
  const [snapshotId, setSnapshotId] = useState('');
  const [snapshotCreated, setSnapshotCreated] = useState<string | null>(null);
  const [paperId, setPaperId] = useState('');
  const [tombstoneMode, setTombstoneMode] = useState<'tombstone' | 'restore'>('tombstone');
  const [mapMutationMessage, setMapMutationMessage] = useState<string | null>(null);

  const loadAudits = async () => {
    if (!projectPath) return;
    try {
      const response = await loadProjectLiteratureMapMaintenanceAudits(projectPath, 8);
      setAudits(response.audits);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  useEffect(() => {
    void loadAudits();
  }, [projectPath]);

  const run = async (trigger: 'natural_language' | 'zotero_changed') => {
    if (!projectPath || running) return;
    if (trigger === 'natural_language' && !query.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const next = await runProjectLiteratureMapMaintenance(projectPath, mapId, trigger, {
        ...(query.trim() && trigger === 'natural_language' ? { query: query.trim(), intent: query.trim() } : {}),
      });
      setResult(next);
      await onCompleted?.(next);
      await loadAudits();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setRunning(false);
    }
  };

  const runMapOperation = async (operation: () => Promise<void>) => {
    if (!projectPath || mapOperationLoading) return;
    setMapOperationLoading(true);
    setMapOperationError(null);
    try {
      await operation();
    } catch (nextError) {
      setMapOperationError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setMapOperationLoading(false);
    }
  };

  const loadBridges = () => runMapOperation(async () => {
    const params = new URLSearchParams({ projectPath: projectPath! });
    const next = await requestMapJson<BridgeAnalysis>(`/api/research/literature-map/bridges?${params}`);
    setBridges(next);
  });

  const loadDiff = () => runMapOperation(async () => {
    const params = new URLSearchParams({ projectPath: projectPath! });
    const next = await requestMapJson<{ lastDiff: MapDiff | null }>(`/api/research/literature-map?${params}`);
    setLastDiff(next.lastDiff);
  });

  const createSnapshot = () => runMapOperation(async () => {
    const id = snapshotId.trim();
    if (!id) throw new Error('Snapshot ID is required. / 请输入快照 ID。');
    const next = await requestMapJson<{ snapshot: { snapshotId: string } }>('/api/research/literature-map/snapshots', {
      method: 'POST',
      body: JSON.stringify({ projectPath, snapshotId: id, confirmed: true }),
    });
    setSnapshotCreated(next.snapshot.snapshotId);
  });

  const updateTombstone = () => runMapOperation(async () => {
    const id = paperId.trim();
    if (!id) throw new Error('Paper ID is required. / 请输入文献 ID。');
    const next = await requestMapJson<{ diff: MapDiff }>('/api/research/literature-map/update', {
      method: 'POST',
      body: JSON.stringify({
        projectPath,
        mapId,
        update: {
          origin: 'monitor',
          ...(tombstoneMode === 'tombstone' ? { tombstonePaperIds: [id] } : { restorePaperIds: [id] }),
        },
      }),
    });
    setLastDiff(next.diff);
    setMapMutationMessage(tombstoneMode === 'tombstone'
      ? `Tombstoned ${id} / 已标记移除 ${id}`
      : `Restored ${id} / 已恢复 ${id}`);
  });

  return (
    <section
      aria-label="Literature map maintenance / 文献地图自动维护"
      className="border-b border-neutral-200 bg-white px-3 py-2.5 dark:border-neutral-800 dark:bg-neutral-950"
      data-testid="literature-maintenance-panel"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Activity className="h-4 w-4 shrink-0 text-teal-600" aria-hidden="true" />
        <h3 className="text-[11px] font-semibold text-neutral-800 dark:text-neutral-100">
          Maintain map / 自动维护地图
        </h3>
        <span className="inline-flex items-center gap-1 text-[10px] text-neutral-500 dark:text-neutral-400">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Candidates only / 仅生成待审候选
        </span>
        <button
          type="button"
          aria-label="Reload maintenance audit / 重载维护审计"
          className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded border border-neutral-200 text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          onClick={() => void loadAudits()}
          disabled={running || !projectPath}
          title="Reload audit / 重载审计"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <label className="relative min-w-[180px] flex-1 sm:max-w-[420px]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" aria-hidden="true" />
          <input
            aria-label="Natural-language maintenance query / 自然语言维护查询"
            className="h-8 w-full rounded border border-neutral-200 bg-white pl-7 pr-2 text-[11px] text-neutral-800 outline-none focus:border-teal-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find new papers… / 查找新论文…"
            onKeyDown={(event) => {
              if (event.key === 'Enter') void run('natural_language');
            }}
          />
        </label>
        <button
          type="button"
          aria-label="Run natural-language maintenance / 运行自然语言维护"
          className="inline-flex h-8 items-center gap-1 rounded bg-teal-700 px-2.5 text-[10px] font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void run('natural_language')}
          disabled={running || !projectPath || !query.trim()}
        >
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          Search / 搜索
        </button>
        <button
          type="button"
          aria-label="Read Zotero changes / 读取 Zotero 变化"
          className="inline-flex h-8 items-center gap-1 rounded border border-neutral-300 px-2.5 text-[10px] font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          onClick={() => void run('zotero_changed')}
          disabled={running || !projectPath}
        >
          <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
          Zotero changes / Zotero 变化
        </button>
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1 border-t border-neutral-100 pt-2 dark:border-neutral-900" aria-label="Literature map operations / 文献图谱操作">
        <MapOperationButton
          active={mapOperation === 'bridges'}
          icon={GitBranch}
          label="Analyze bridge papers / 分析桥接文献"
          onClick={() => setMapOperation(mapOperation === 'bridges' ? null : 'bridges')}
        />
        <MapOperationButton
          active={mapOperation === 'diff'}
          icon={History}
          label="Inspect last map diff / 查看上次图谱差异"
          onClick={() => setMapOperation(mapOperation === 'diff' ? null : 'diff')}
        />
        <MapOperationButton
          active={mapOperation === 'snapshot'}
          icon={Camera}
          label="Create reviewed map snapshot / 创建已审阅图谱快照"
          onClick={() => setMapOperation(mapOperation === 'snapshot' ? null : 'snapshot')}
        />
        <MapOperationButton
          active={mapOperation === 'tombstone'}
          icon={ArchiveX}
          label="Tombstone or restore a paper / 标记移除或恢复文献"
          onClick={() => setMapOperation(mapOperation === 'tombstone' ? null : 'tombstone')}
        />
      </div>
      {mapOperation === 'bridges' ? (
        <div className="mt-2 flex min-w-0 items-center gap-2" data-testid="literature-map-bridge-controls">
          <button type="button" className="h-7 rounded border border-neutral-300 px-2 text-[10px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800" onClick={() => void loadBridges()} disabled={!projectPath || mapOperationLoading}>
            Analyze / 分析
          </button>
          {bridges ? <span className="min-w-0 truncate text-[10px] text-neutral-500">{bridges.bridges.length} bridge papers / 桥接文献 · {bridges.graph.activePaperCount} active / 活跃文献</span> : null}
        </div>
      ) : null}
      {mapOperation === 'diff' ? (
        <div className="mt-2 flex min-w-0 items-center gap-2" data-testid="literature-map-diff-controls">
          <button type="button" className="h-7 rounded border border-neutral-300 px-2 text-[10px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800" onClick={() => void loadDiff()} disabled={!projectPath || mapOperationLoading}>
            Load diff / 加载差异
          </button>
          {lastDiff ? <span className="min-w-0 truncate text-[10px] text-neutral-500">r{lastDiff.fromRevision} → r{lastDiff.toRevision} · {diffChangeCount(lastDiff)} changes / 项变化</span> : null}
        </div>
      ) : null}
      {mapOperation === 'snapshot' ? (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2" data-testid="literature-map-snapshot-controls">
          <input aria-label="Reviewed snapshot ID / 已审阅快照 ID" className="h-7 min-w-[180px] flex-1 rounded border border-neutral-200 bg-white px-2 text-[10px] text-neutral-800 outline-none focus:border-teal-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100" value={snapshotId} onChange={(event) => setSnapshotId(event.target.value)} placeholder="reviewed-2026-07-25" />
          <button type="button" className="inline-flex h-7 items-center gap-1 rounded bg-neutral-900 px-2 text-[10px] font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900" onClick={() => void createSnapshot()} disabled={!projectPath || mapOperationLoading || !snapshotId.trim()}>
            <Camera className="h-3.5 w-3.5" aria-hidden="true" />
            Confirm snapshot / 确认快照
          </button>
          {snapshotCreated ? <span className="text-[10px] text-emerald-700 dark:text-emerald-300">Created {snapshotCreated} / 已创建 {snapshotCreated}</span> : null}
        </div>
      ) : null}
      {mapOperation === 'tombstone' ? (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2" data-testid="literature-map-tombstone-controls">
          <div className="flex h-7 shrink-0 rounded border border-neutral-200 p-0.5 dark:border-neutral-700" role="group" aria-label="Map paper lifecycle action / 图谱文献生命周期操作">
            {(['tombstone', 'restore'] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={tombstoneMode === mode} className={`inline-flex items-center gap-1 rounded px-1.5 text-[10px] ${tombstoneMode === mode ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : 'text-neutral-500'}`} onClick={() => setTombstoneMode(mode)}>
                {mode === 'tombstone' ? <ArchiveX className="h-3 w-3" aria-hidden="true" /> : <ArchiveRestore className="h-3 w-3" aria-hidden="true" />}
                {mode === 'tombstone' ? 'Tombstone / 标记移除' : 'Restore / 恢复'}
              </button>
            ))}
          </div>
          <input aria-label="Literature map paper ID / 文献图谱文献 ID" className="h-7 min-w-[180px] flex-1 rounded border border-neutral-200 bg-white px-2 text-[10px] text-neutral-800 outline-none focus:border-teal-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100" value={paperId} onChange={(event) => setPaperId(event.target.value)} placeholder="Paper ID / 文献 ID" />
          <button type="button" className="h-7 rounded border border-neutral-300 px-2 text-[10px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800" onClick={() => void updateTombstone()} disabled={!projectPath || mapOperationLoading || !paperId.trim()}>
            Apply / 应用
          </button>
          {mapMutationMessage ? <span className="text-[10px] text-neutral-500">{mapMutationMessage}</span> : null}
        </div>
      ) : null}
      {mapOperationError ? (
        <p className="mt-2 flex min-w-0 gap-1.5 text-[10px] leading-4 text-red-700 dark:text-red-300" role="alert">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="break-words">{mapOperationError}</span>
        </p>
      ) : null}
      {running ? (
        <p className="mt-2 text-[10px] text-neutral-500 dark:text-neutral-400" role="status">Updating / 更新中…</p>
      ) : null}
      {error ? (
        <p className="mt-2 flex min-w-0 gap-1.5 text-[10px] leading-4 text-red-700 dark:text-red-300" role="alert">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="break-words">{error}</span>
        </p>
      ) : null}
      {result ? (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-neutral-100 pt-2 text-[10px] dark:border-neutral-900">
          <span className="inline-flex items-center gap-1 text-neutral-600 dark:text-neutral-300">
            <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
            {result.candidateReview.pendingCandidatePaperIds.length} pending / 待审
          </span>
          <span className="text-neutral-500 dark:text-neutral-400">
            {result.sources.filter((source) => source.state === 'failed').length} failed / 失败
          </span>
          <span className="text-neutral-500 dark:text-neutral-400">
            Audit {audits.length} / 审计 {audits.length}
          </span>
        </div>
      ) : null}
      {!result && audits.length > 0 ? (
        <p className="mt-2 text-[10px] text-neutral-500 dark:text-neutral-400">
          Last run / 上次运行: {audits[audits.length - 1]?.trigger}
        </p>
      ) : null}
    </section>
  );
}

export default LiteratureMaintenancePanel;

function MapOperationButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof GitBranch;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex h-7 w-7 items-center justify-center rounded border ${active ? 'border-teal-600 bg-teal-50 text-teal-700 dark:bg-teal-950/30 dark:text-teal-300' : 'border-neutral-200 text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800'}`}
      onClick={onClick}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

async function requestMapJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, { ...init, suppressServerErrorToast: true });
  const body = await response.json().catch(() => null) as T | { error?: unknown } | null;
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : 'Literature map operation failed. / 文献图谱操作失败。';
    throw new Error(message);
  }
  if (!body || typeof body !== 'object') throw new Error('Literature map returned an invalid response.');
  return body as T;
}

function diffChangeCount(diff: MapDiff): number {
  return Object.values(diff.nodes).reduce((total, entries) => total + entries.length, 0)
    + Object.values(diff.edges).reduce((total, entries) => total + entries.length, 0);
}
