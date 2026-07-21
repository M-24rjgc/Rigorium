import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Check,
  ExternalLink,
  FolderTree,
  Library,
  Network,
  RefreshCw,
  Search,
  Star,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../utils/api';
import { cn } from '../lib/utils';
import { useResearchPanel } from '../contexts/ResearchPanelContext';
import type {
  ResearchArtifact,
  ResearchPaper,
  ResearchRelationEdge,
  ResearchSettingsSnapshot,
  ZoteroItemsResult,
  ZoteroLibraryItem,
  ZoteroPaperMatch,
  ZoteroStatus,
} from './types';

type ResearchPanelProps = {
  artifact: ResearchArtifact;
  projectPath?: string;
};

type ZoteroBinding = {
  collectionKey?: string;
  collectionName?: string;
  useSelectedCollection: boolean;
  error?: string;
};

export default function ResearchPanel({ artifact, projectPath }: ResearchPanelProps) {
  const { t } = useTranslation();
  const { selectedPaperId, selectPaper } = useResearchPanel();
  const [view, setView] = useState<'map' | 'papers' | 'collection'>('map');
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroStatus | null>(null);
  const [zoteroLoading, setZoteroLoading] = useState(false);
  const [zoteroBinding, setZoteroBinding] = useState<ZoteroBinding | null>(null);
  const [paperMatches, setPaperMatches] = useState<ZoteroPaperMatch[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchesError, setMatchesError] = useState<string | null>(null);
  const [collectionItems, setCollectionItems] = useState<ZoteroItemsResult | null>(null);
  const [collectionLoading, setCollectionLoading] = useState(false);
  const [collectionError, setCollectionError] = useState<string | null>(null);
  const [collectionQuery, setCollectionQuery] = useState('');
  const [confirmingPaper, setConfirmingPaper] = useState<ResearchPaper | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const selectedPaper = useMemo(
    () => artifact.papers.find((paper) => paper.id === selectedPaperId) ?? artifact.papers[0] ?? null,
    [artifact.papers, selectedPaperId],
  );
  const selectedPaperUrl = useMemo(() => safeExternalUrl(selectedPaper?.url), [selectedPaper?.url]);
  const matchByPaperId = useMemo(
    () => new Map(paperMatches.map((match) => [match.paperId, match])),
    [paperMatches],
  );
  const selectedMatch = selectedPaper ? matchByPaperId.get(selectedPaper.id) : undefined;
  const fixedCollectionKey = zoteroBinding && !zoteroBinding.useSelectedCollection
    ? zoteroBinding.collectionKey
    : undefined;
  const selectedExactMatch = selectedMatch?.matched && selectedMatch.confidence === 'exact';
  const connectorTargetName = zoteroStatus?.selectedCollection?.name || 'My Library';

  useEffect(() => {
    if (selectedPaperId && artifact.papers.some((paper) => paper.id === selectedPaperId)) return;
    if (artifact.papers[0]) selectPaper(artifact.papers[0].id);
  }, [artifact.artifactId, artifact.papers, selectPaper, selectedPaperId]);

  const loadZoteroStatus = useCallback(async () => {
    setZoteroLoading(true);
    try {
      const params = new URLSearchParams();
      if (projectPath) params.set('projectPath', projectPath);
      const response = await authenticatedFetch(`/api/research/zotero/status${params.size ? `?${params}` : ''}`, {
        suppressServerErrorToast: true,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Failed to check Zotero.');
      setZoteroStatus(body as ZoteroStatus);
    } catch (error) {
      setZoteroStatus({
        provider: 'zotero',
        available: false,
        apiReady: false,
        connectorReady: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setZoteroLoading(false);
    }
  }, [projectPath]);

  const loadZoteroBinding = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (projectPath) params.set('projectPath', projectPath);
      const response = await authenticatedFetch(`/api/research/settings${params.size ? `?${params}` : ''}`, {
        suppressServerErrorToast: true,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Failed to load Zotero collection binding.');
      const settings = (body as ResearchSettingsSnapshot).effective.zotero;
      setZoteroBinding({
        useSelectedCollection: settings.useSelectedCollection,
        ...(settings.collectionKey ? { collectionKey: settings.collectionKey } : {}),
        ...(settings.collectionName ? { collectionName: settings.collectionName } : {}),
      });
    } catch (error) {
      setZoteroBinding({
        useSelectedCollection: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [projectPath]);

  useEffect(() => {
    void loadZoteroStatus();
    void loadZoteroBinding();
  }, [loadZoteroBinding, loadZoteroStatus]);

  const loadPaperMatches = useCallback(async () => {
    if (artifact.papers.length === 0) {
      setPaperMatches([]);
      return;
    }
    setMatchesLoading(true);
    setMatchesError(null);
    try {
      const response = await authenticatedFetch('/api/research/zotero/match', {
        method: 'POST',
        body: JSON.stringify({
          projectPath,
          collectionKey: fixedCollectionKey,
          papers: artifact.papers,
        }),
        suppressServerErrorToast: true,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Failed to match papers against Zotero.');
      if (body.available === false) throw new Error(body.error || 'Zotero is unavailable.');
      const matches = Array.isArray(body) ? body : Array.isArray(body.matches) ? body.matches : null;
      if (!matches) throw new Error('Zotero returned an invalid paper match result.');
      setPaperMatches((matches as ZoteroPaperMatch[]).map((match) => (
        fixedCollectionKey ? match : { ...match, inCollection: undefined }
      )));
    } catch (error) {
      setPaperMatches([]);
      setMatchesError(error instanceof Error ? error.message : String(error));
    } finally {
      setMatchesLoading(false);
    }
  }, [artifact.papers, fixedCollectionKey, projectPath]);

  useEffect(() => {
    if (!zoteroStatus?.apiReady || !zoteroBinding) {
      setPaperMatches([]);
      return;
    }
    void loadPaperMatches();
  }, [loadPaperMatches, zoteroBinding, zoteroStatus?.apiReady]);

  const loadCollectionItems = useCallback(async (queryText = '') => {
    if (!fixedCollectionKey) {
      setCollectionItems(null);
      setCollectionError(null);
      return;
    }
    setCollectionLoading(true);
    setCollectionError(null);
    try {
      const params = new URLSearchParams({
        collectionKey: fixedCollectionKey,
        limit: '50',
      });
      if (projectPath) params.set('projectPath', projectPath);
      if (queryText.trim()) params.set('q', queryText.trim());
      const response = await authenticatedFetch(`/api/research/zotero/items?${params}`, {
        suppressServerErrorToast: true,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Failed to load the bound Zotero collection.');
      if (body.available === false) throw new Error(body.error || 'Zotero is unavailable.');
      if (!Array.isArray(body.items)) throw new Error('Zotero returned an invalid item list.');
      setCollectionItems(body as ZoteroItemsResult);
    } catch (error) {
      setCollectionItems(null);
      setCollectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCollectionLoading(false);
    }
  }, [fixedCollectionKey, projectPath]);

  useEffect(() => {
    if (view !== 'collection') return;
    setCollectionQuery('');
    void loadCollectionItems();
  }, [loadCollectionItems, view]);

  const importIntoZotero = useCallback(async () => {
    if (!confirmingPaper) return;
    setImporting(true);
    setImportMessage(null);
    try {
      const response = await authenticatedFetch('/api/research/zotero/import', {
        method: 'POST',
        body: JSON.stringify({
          confirmed: true,
          projectPath,
          papers: [confirmingPaper],
        }),
        suppressServerErrorToast: true,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Zotero import failed.');
      setImportMessage({
        kind: 'success',
        text: t('researchPanel.importSuccess', { defaultValue: 'Saved to Zotero.' }),
      });
      setConfirmingPaper(null);
      await loadPaperMatches();
      if (view === 'collection') await loadCollectionItems(collectionQuery);
    } catch (error) {
      setImportMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setImporting(false);
    }
  }, [collectionQuery, confirmingPaper, loadCollectionItems, loadPaperMatches, projectPath, t, view]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-neutral-50/70 dark:bg-neutral-950">
      <div className="shrink-0 border-b border-neutral-200 bg-white px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex items-start gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300">
            <Search className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-[13px] font-medium leading-5 text-neutral-900 dark:text-neutral-100">
              {artifact.plan.query}
            </p>
            <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('researchPanel.resultSummary', {
                defaultValue: '{{papers}} papers · {{edges}} relationships',
                papers: artifact.papers.length,
                edges: artifact.edges.length,
              })}
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-900">
          {(['map', 'papers', 'collection'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setView(tab)}
              className={cn(
                'rounded-md px-2 py-1.5 text-[12px] font-medium transition',
                view === tab
                  ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200',
              )}
            >
              {tab === 'map'
                ? t('researchPanel.map', { defaultValue: 'Map' })
                : tab === 'papers'
                  ? t('researchPanel.papers', { defaultValue: 'Papers' })
                  : t('researchPanel.collection', { defaultValue: 'Collection' })}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {artifact.coverage.warnings.length > 0 ? (
          <div className="m-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[11px] leading-4 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{artifact.coverage.warnings.join(' ')}</span>
          </div>
        ) : null}

        {view === 'map' ? (
          <div className="space-y-3 p-3">
            <LiteratureGraph
              papers={artifact.papers}
              edges={artifact.edges}
              selectedPaperId={selectedPaper?.id ?? null}
              onSelectPaper={selectPaper}
            />
            <RelationshipLegend />
          </div>
        ) : view === 'papers' ? (
          <PaperList
            papers={artifact.papers}
            selectedPaperId={selectedPaper?.id ?? null}
            onSelectPaper={selectPaper}
            matches={matchByPaperId}
          />
        ) : (
          <CollectionLibrary
            binding={zoteroBinding}
            result={collectionItems}
            loading={collectionLoading}
            error={collectionError}
            query={collectionQuery}
            onQueryChange={setCollectionQuery}
            onSearch={() => void loadCollectionItems(collectionQuery)}
            onRefresh={() => void loadCollectionItems(collectionQuery)}
          />
        )}

        <div className="border-t border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            {t('researchPanel.sources', { defaultValue: 'Sources and coverage' })}
          </h3>
          <div className="mt-2 space-y-2">
            {artifact.sources.map((source) => (
              <div key={source.id} className="rounded-lg border border-neutral-200 p-2.5 dark:border-neutral-800">
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'h-2 w-2 rounded-full',
                    source.status === 'ok' ? 'bg-emerald-500' : 'bg-amber-500',
                  )} />
                  <span className="text-[12px] font-medium text-neutral-800 dark:text-neutral-200">{source.name}</span>
                  <span className="ml-auto text-[10px] text-neutral-400">{source.resultCount}</span>
                </div>
                <p className="mt-1 text-[10px] leading-4 text-neutral-500 dark:text-neutral-400">{source.coverage}</p>
                <p className="mt-1 text-[10px] text-neutral-400">{new Date(source.retrievedAt).toLocaleString()}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
        {selectedPaper ? (
          <div className="space-y-2.5">
            <div>
              <p className="line-clamp-2 text-[12px] font-medium leading-5 text-neutral-900 dark:text-neutral-100">
                {selectedPaper.title}
              </p>
              <p className="mt-0.5 line-clamp-1 text-[10px] text-neutral-500 dark:text-neutral-400">
                {[selectedPaper.authors.slice(0, 3).join(', '), selectedPaper.year, selectedPaper.venue].filter(Boolean).join(' · ')}
              </p>
            </div>

            <div className="flex items-center gap-2">
              {selectedPaperUrl ? (
                <a
                  href={selectedPaperUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-[11px] font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t('researchPanel.openPaper', { defaultValue: 'Open' })}
                </a>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setImportMessage(null);
                  setConfirmingPaper(selectedPaper);
                }}
                disabled={!zoteroStatus?.connectorReady || zoteroLoading || matchesLoading || Boolean(selectedExactMatch)}
                className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-2.5 text-[11px] font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-neutral-300 dark:disabled:bg-neutral-800"
              >
                {selectedExactMatch ? <Check className="h-3.5 w-3.5" /> : <Star className="h-3.5 w-3.5" />}
                {selectedExactMatch && selectedMatch?.inCollection
                    ? t('researchPanel.inCollection', { defaultValue: 'In collection' })
                    : selectedExactMatch
                      ? t('researchPanel.inZotero', { defaultValue: 'In Zotero' })
                      : t('researchPanel.saveToZotero', { defaultValue: 'Save to Zotero' })}
              </button>
              <button
                type="button"
                onClick={() => void loadZoteroStatus()}
                disabled={zoteroLoading}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                aria-label={t('researchPanel.refreshZotero', { defaultValue: 'Refresh Zotero status' })}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', zoteroLoading && 'animate-spin')} />
              </button>
            </div>

            <div className="text-[10px] leading-4 text-neutral-500 dark:text-neutral-400">
              {zoteroStatus?.connectorReady
                ? t('researchPanel.zoteroTarget', {
                    defaultValue: 'Target: {{name}}',
                    name: connectorTargetName,
                  })
                : zoteroStatus?.error || t('researchPanel.zoteroUnavailable', { defaultValue: 'Start Zotero to enable saving.' })}
            </div>

            {selectedMatch ? <PaperStatusBadge match={selectedMatch} /> : null}
            {matchesError ? (
              <div className="text-[10px] leading-4 text-amber-600 dark:text-amber-300">{matchesError}</div>
            ) : null}

            {importMessage ? (
              <div className={cn(
                'rounded-md px-2.5 py-2 text-[11px]',
                importMessage.kind === 'success'
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
              )}>
                {importMessage.text}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-[11px] text-neutral-500">{t('researchPanel.noPapers', { defaultValue: 'No papers were returned.' })}</p>
        )}
      </div>

      {confirmingPaper ? (
        <div className="absolute inset-0 z-20 flex items-end bg-black/25 p-3 backdrop-blur-[1px]">
          <div className="w-full rounded-xl border border-neutral-200 bg-white p-3 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
            <div className="flex items-start gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                <Star className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-semibold text-neutral-900 dark:text-neutral-100">
                  {t('researchPanel.confirmImportTitle', { defaultValue: 'Write to Zotero?' })}
                </p>
                <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
                  {confirmingPaper.title}
                </p>
                <p className="mt-1 text-[10px] text-neutral-400">
                  {t('researchPanel.confirmImportTarget', {
                    defaultValue: 'This modifies {{name}}.',
                    name: connectorTargetName,
                  })}
                </p>
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingPaper(null)}
                disabled={importing}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-neutral-200 px-3 text-[11px] font-medium text-neutral-700 dark:border-neutral-700 dark:text-neutral-200"
              >
                <X className="h-3.5 w-3.5" />
                {t('researchPanel.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                type="button"
                onClick={() => void importIntoZotero()}
                disabled={importing}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-indigo-600 px-3 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
              >
                {importing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {t('researchPanel.confirm', { defaultValue: 'Confirm import' })}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LiteratureGraph({
  papers,
  edges,
  selectedPaperId,
  onSelectPaper,
}: {
  papers: ResearchPaper[];
  edges: ResearchRelationEdge[];
  selectedPaperId: string | null;
  onSelectPaper: (paperId: string) => void;
}) {
  const positions = useMemo(() => {
    const centerX = 320;
    const centerY = 180;
    const radiusX = 245;
    const radiusY = 125;
    return new Map(papers.map((paper, index) => {
      const angle = papers.length <= 1 ? 0 : (Math.PI * 2 * index) / papers.length - Math.PI / 2;
      return [paper.id, {
        x: papers.length <= 1 ? centerX : centerX + Math.cos(angle) * radiusX,
        y: papers.length <= 1 ? centerY : centerY + Math.sin(angle) * radiusY,
      }];
    }));
  }, [papers]);

  if (papers.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center rounded-xl border border-dashed border-neutral-300 text-[11px] text-neutral-400 dark:border-neutral-700">
        No graph data
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900/70">
      <svg viewBox="0 0 640 360" className="h-auto w-full" role="img" aria-label="Literature relationship map">
        <defs>
          <marker id="research-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" className="fill-indigo-400" />
          </marker>
        </defs>
        {edges.map((edge) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) return null;
          return (
            <line
              key={edge.id}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke={edge.type === 'citation' ? '#818cf8' : '#a3a3a3'}
              strokeWidth={edge.type === 'citation' ? 1.8 : 1.1}
              strokeDasharray={edge.inferred ? '5 5' : undefined}
              opacity={edge.type === 'citation' ? 0.78 : 0.48}
              markerEnd={edge.type === 'citation' ? 'url(#research-arrow)' : undefined}
            >
              <title>{edge.type === 'citation' ? 'Citation' : `Shared topic: ${edge.evidence?.join(', ') || ''}`}</title>
            </line>
          );
        })}
        {papers.map((paper) => {
          const position = positions.get(paper.id)!;
          const selected = paper.id === selectedPaperId;
          const nodeRadius = Math.max(9, Math.min(18, 9 + Math.log10(paper.citedByCount + 1) * 2.6));
          return (
            <g
              key={paper.id}
              transform={`translate(${position.x}, ${position.y})`}
              className="cursor-pointer"
              onClick={() => onSelectPaper(paper.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelectPaper(paper.id);
              }}
            >
              <circle
                r={nodeRadius + (selected ? 5 : 2)}
                fill={selected ? '#c7d2fe' : '#e5e7eb'}
                opacity={selected ? 0.8 : 0.55}
              />
              <circle r={nodeRadius} fill={selected ? '#4f46e5' : '#6366f1'} stroke="white" strokeWidth="2" />
              <text y={nodeRadius + 15} textAnchor="middle" fontSize="9" fill="currentColor" className="fill-neutral-600 dark:fill-neutral-300">
                {shortTitle(paper.title, 28)}
              </text>
              <title>{`${paper.title}\n${paper.citedByCount} citations`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function RelationshipLegend() {
  return (
    <div className="flex flex-wrap gap-3 px-1 text-[10px] text-neutral-500 dark:text-neutral-400">
      <span className="inline-flex items-center gap-1.5"><span className="h-px w-5 bg-indigo-400" /> Citation</span>
      <span className="inline-flex items-center gap-1.5"><span className="w-5 border-t border-dashed border-neutral-400" /> Shared topic (inferred)</span>
      <span className="ml-auto inline-flex items-center gap-1"><Network className="h-3 w-3" /> Node size = citations</span>
    </div>
  );
}

function CollectionLibrary({
  binding,
  result,
  loading,
  error,
  query,
  onQueryChange,
  onSearch,
  onRefresh,
}: {
  binding: ZoteroBinding | null;
  result: ZoteroItemsResult | null;
  loading: boolean;
  error: string | null;
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();

  if (!binding) {
    return (
      <div className="flex min-h-48 items-center justify-center gap-2 px-4 text-[11px] text-neutral-500">
        <RefreshCw className="h-4 w-4 animate-spin" />
        {t('researchPanel.loadingCollectionBinding', { defaultValue: 'Loading collection…' })}
      </div>
    );
  }

  if (binding.error) {
    return <div className="px-4 py-6 text-[11px] leading-4 text-red-600 dark:text-red-300">{binding.error}</div>;
  }

  if (binding.useSelectedCollection || !binding.collectionKey) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-4 text-center">
        <FolderTree className="h-6 w-6 text-neutral-300 dark:text-neutral-700" />
        <p className="text-[12px] font-medium text-neutral-700 dark:text-neutral-300">
          {t('researchPanel.noBoundCollection', { defaultValue: 'No Zotero collection is bound.' })}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-neutral-950">
      <div className="border-b border-neutral-200 p-3 dark:border-neutral-800">
        <div className="flex min-w-0 items-center gap-2">
          <FolderTree className="h-4 w-4 shrink-0 text-indigo-500" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-neutral-800 dark:text-neutral-200">
            {binding.collectionName || binding.collectionKey}
          </span>
          {result ? <span className="shrink-0 text-[10px] text-neutral-400">{result.total}</span> : null}
        </div>
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            onSearch();
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
            <input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t('researchPanel.searchCollection', { defaultValue: 'Search collection' })}
              aria-label={t('researchPanel.searchCollection', { defaultValue: 'Search collection' })}
              className="h-8 w-full rounded-md border border-neutral-200 bg-white pl-8 pr-2 text-[11px] text-neutral-800 outline-none focus:border-indigo-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50"
            aria-label={t('researchPanel.searchCollectionAction', { defaultValue: 'Search collection' })}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            aria-label={t('researchPanel.refreshCollection', { defaultValue: 'Refresh collection' })}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </form>
      </div>

      {error ? (
        <div className="px-3 py-5 text-[11px] leading-4 text-red-600 dark:text-red-300">{error}</div>
      ) : loading && !result ? (
        <div className="flex min-h-40 items-center justify-center gap-2 text-[11px] text-neutral-500">
          <RefreshCw className="h-4 w-4 animate-spin" />
          {t('researchPanel.loadingCollection', { defaultValue: 'Loading collection…' })}
        </div>
      ) : result?.items.length ? (
        <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {result.items.map((item) => <CollectionItemRow key={item.key} item={item} />)}
        </div>
      ) : (
        <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-4 text-center">
          <BookOpen className="h-6 w-6 text-neutral-300 dark:text-neutral-700" />
          <span className="text-[11px] text-neutral-500">
            {t('researchPanel.noCollectionItems', { defaultValue: 'No items found.' })}
          </span>
        </div>
      )}

      {result?.truncated ? (
        <div className="border-t border-neutral-200 px-3 py-2 text-[10px] text-amber-600 dark:border-neutral-800 dark:text-amber-300">
          {t('researchPanel.collectionTruncated', { defaultValue: 'Showing the first {{count}} matching items.', count: result.items.length })}
        </div>
      ) : null}
    </div>
  );
}

function CollectionItemRow({ item }: { item: ZoteroLibraryItem }) {
  const { t } = useTranslation();
  const url = safeExternalUrl(item.url);
  return (
    <div className="flex min-w-0 items-start gap-2.5 px-3 py-3">
      <Library className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-[12px] font-medium leading-4 text-neutral-800 dark:text-neutral-200">
          {item.title || t('researchPanel.untitledItem', { defaultValue: 'Untitled item' })}
        </p>
        <p className="mt-1 line-clamp-1 text-[10px] text-neutral-500 dark:text-neutral-400">
          {[item.creators.slice(0, 2).join(', '), item.year, item.itemType].filter(Boolean).join(' · ')}
        </p>
        {item.tags.length > 0 ? (
          <p className="mt-1 line-clamp-1 text-[10px] text-neutral-400">{item.tags.slice(0, 4).join(' · ')}</p>
        ) : null}
      </div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          aria-label={t('researchPanel.openCollectionItem', { defaultValue: 'Open {{title}}', title: item.title })}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : null}
    </div>
  );
}

function PaperStatusBadge({ match }: { match: ZoteroPaperMatch }) {
  const { t } = useTranslation();
  if (!match.matched) return null;
  const heuristic = match.confidence === 'heuristic';
  const label = heuristic
    ? t('researchPanel.possibleZoteroMatch', { defaultValue: 'Possible Zotero match' })
    : match.inCollection
      ? t('researchPanel.inCollection', { defaultValue: 'In collection' })
      : t('researchPanel.inZotero', { defaultValue: 'In Zotero' });
  return (
    <span className={cn(
      'inline-flex w-fit items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
      heuristic
        ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300'
        : match.inCollection
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'
          : 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300',
    )}>
      {heuristic ? <Search className="h-3 w-3" /> : <Check className="h-3 w-3" />}
      {label}
    </span>
  );
}

function PaperList({
  papers,
  selectedPaperId,
  onSelectPaper,
  matches,
}: {
  papers: ResearchPaper[];
  selectedPaperId: string | null;
  onSelectPaper: (paperId: string) => void;
  matches: Map<string, ZoteroPaperMatch>;
}) {
  return (
    <div className="divide-y divide-neutral-200 bg-white dark:divide-neutral-800 dark:bg-neutral-950">
      {papers.map((paper, index) => (
        <button
          key={paper.id}
          type="button"
          onClick={() => onSelectPaper(paper.id)}
          className={cn(
            'flex w-full items-start gap-2.5 px-3 py-3 text-left transition hover:bg-neutral-50 dark:hover:bg-neutral-900',
            paper.id === selectedPaperId && 'bg-indigo-50/70 dark:bg-indigo-950/20',
          )}
        >
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[10px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-[12px] font-medium leading-4 text-neutral-800 dark:text-neutral-200">{paper.title}</span>
            <span className="mt-1 block text-[10px] text-neutral-500 dark:text-neutral-400">
              {[paper.authors.slice(0, 2).join(', '), paper.year, `${paper.citedByCount} cited`].filter(Boolean).join(' · ')}
            </span>
            {matches.get(paper.id) ? (
              <span className="mt-1.5 block"><PaperStatusBadge match={matches.get(paper.id)!} /></span>
            ) : null}
          </span>
          <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-300" />
        </button>
      ))}
    </div>
  );
}

function shortTitle(title: string, maxLength: number): string {
  return title.length > maxLength ? `${title.slice(0, maxLength - 1)}…` : title;
}

function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}
