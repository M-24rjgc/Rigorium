import { Activity, BookOpen, Check, RefreshCw, Search, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
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

/** Compact bilingual controls for explicit, candidate-only maintenance runs. */
export function LiteratureMaintenancePanel({ projectPath, mapId, onCompleted }: LiteratureMaintenancePanelProps) {
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LiteratureMapMaintenanceResult | null>(null);
  const [audits, setAudits] = useState<LiteratureMapMaintenanceAudit[]>([]);

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
