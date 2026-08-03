import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  FolderTree,
  Library,
  Paperclip,
  PenLine,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { authenticatedFetch } from '../utils/api';
import { CHAT_DRAFT_INSERT_EVENT } from '../utils/chatDraftInsertion';
import { cn } from '../lib/utils';
import { useResearchPanel } from '../contexts/ResearchPanelContext';
import type { ResearchPanelActivation } from './activation';
import {
  copyZoteroExportText,
  downloadZoteroExportText,
  getZoteroAttachmentFullText,
  getZoteroItemDetails,
  getZoteroItemExport,
  getZoteroTags,
} from './zoteroItemApi';
import { confirmZoteroCloudWrite, importPapersIntoZotero, previewZoteroCloudWrite } from './zoteroCloudApi';
import ZoteroConnectionStatus from './ZoteroConnectionStatus';
import {
  LiteratureMap,
  stableNodePosition,
  type LiteratureMapActionRequest,
  type LiteratureMapPaperState,
  type LiteratureMapPoint,
} from './literature-map';
import {
  loadProjectLiteratureMap,
  setProjectLiteratureMapNodeState,
  setProjectLiteratureMapSeed,
  updateProjectLiteratureMap,
  type ProjectLiteratureMapNodeStatus,
  type LiteratureMapMaintenanceResult,
} from './literatureMapApi';
import LiteratureMaintenancePanel from './LiteratureMaintenancePanel';
import type {
  ResearchPanelEntry,
  ResearchToolActivity,
  ResearchConfirmationBoundary,
  LiteratureResearchArtifact,
  LiteratureSearchArtifact,
  LiteratureExpansionDirectionResult,
  ResearchDirectionAssessmentArtifact,
  ResearchDirectionLifecycleArtifact,
  ResearchDirectionLifecycleStageStatus,
  ResearchDirectionSeedArtifact,
  ResearchTitleConfirmationArtifact,
  ResearchPaper,
  ResearchPaperProvenance,
  ResearchSettingsSnapshot,
  ResearchSourceStatus,
  ResearchTerminologyCandidate,
  ResearchTerminologySummary,
  ZoteroAttachmentFullTextResult,
  ZoteroCloudWriteIntent,
  ZoteroCloudWritePlan,
  ZoteroCloudWriteResult,
  ZoteroExportFormat,
  ZoteroItemDetailsResult,
  ZoteroItemsResult,
  ZoteroLibraryAttachment,
  ZoteroLibraryItem,
  ZoteroLibraryNote,
  ZoteroPaperMatch,
  ZoteroStatus,
  ZoteroTagsResult,
} from './types';

type ResearchPanelProps = {
  artifact?: ResearchPanelEntry | null;
  activation?: ResearchPanelActivation | null;
  projectPath?: string;
};

type ZoteroBinding = {
  collectionKey?: string;
  collectionName?: string;
  useSelectedCollection: boolean;
  error?: string;
};

const PROJECT_LITERATURE_MAP_ID = 'project-literature-map';
const LITERATURE_RESEARCH_VIEWS = ['map', 'papers', 'collection'] as const;

type LiteratureResearchView = typeof LITERATURE_RESEARCH_VIEWS[number];

type LiteratureMapPersistence = {
  projectPath: string;
  mapId: string;
  revision: number;
};

type ZoteroMapSyncNotice = {
  kind: 'success' | 'warning' | 'error';
  text: string;
};

export default function ResearchPanel({ artifact, activation, projectPath }: ResearchPanelProps) {
  if (!artifact) {
    return <ResearchActivationPanel activation={activation ?? null} />;
  }
  if (artifact.kind === 'research_tool_activity') {
    return <ResearchToolActivityPanel activity={artifact} />;
  }
  if (artifact.kind === 'research_direction_seed') {
    return <ResearchDirectionPanel artifact={artifact} />;
  }
  if (artifact.kind === 'direction_assessment') {
    return <ResearchDirectionAssessmentPanel artifact={artifact} />;
  }
  if (artifact.kind === 'research_title_confirmation') {
    return <ResearchTitleConfirmationPanel artifact={artifact} />;
  }
  if (artifact.kind === 'research_direction_lifecycle') {
    return <ResearchDirectionLifecyclePanel artifact={artifact} />;
  }
  return <LiteratureResearchPanel artifact={artifact} projectPath={projectPath} />;
}

function ResearchActivationPanel({ activation }: { activation: ResearchPanelActivation | null }) {
  const { t } = useTranslation();
  const intents = activation?.intents ?? [];
  const boundaries = activation?.confirmationBoundaries ?? [];
  return (
    <div data-testid="research-intent-activation" data-tour-id="tour-research" className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-neutral-50/70 dark:bg-neutral-950">
      <section className="border-b border-neutral-200 bg-white px-4 py-4 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex items-start gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300">
            <Search className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
              {t('researchPanel.activation.title', { defaultValue: 'Research workspace' })}
            </h2>
            <p className="mt-0.5 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
              {t('researchPanel.activation.pending', { defaultValue: 'Research context is ready for the current request.' })}
            </p>
          </div>
        </div>
      </section>
      {intents.length > 0 ? (
        <section className="border-b border-neutral-200 px-4 py-3 dark:border-neutral-800" aria-label={t('researchPanel.activation.intentLabel', { defaultValue: 'Research intent' })}>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            {t('researchPanel.activation.intentLabel', { defaultValue: 'Research intent' })}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {intents.map((intent) => (
              <span key={intent} className="rounded border border-indigo-100 bg-indigo-50 px-2 py-1 text-[10px] font-medium text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-300">
                {researchIntentLabel(intent, t)}
              </span>
            ))}
          </div>
        </section>
      ) : null}
      <ConfirmationBoundaryNotice boundaries={boundaries} status="complete" />
    </div>
  );
}

function ResearchToolActivityPanel({ activity }: { activity: ResearchToolActivity }) {
  const { t } = useTranslation();
  const statusStyle = activity.status === 'complete'
    ? 'text-emerald-700 dark:text-emerald-300'
    : activity.status === 'requires_confirmation'
      ? 'text-amber-700 dark:text-amber-300'
      : 'text-rose-700 dark:text-rose-300';
  return (
    <div data-testid={`research-tool-activity-${activity.toolName}`} className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-neutral-50/70 dark:bg-neutral-950">
      <section className="border-b border-neutral-200 bg-white px-4 py-4 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex items-start gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
            <FileText className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
              {researchToolLabel(activity.toolName, t)}
            </h2>
            <p className={cn('mt-0.5 text-[11px] font-medium', statusStyle)}>
              {researchActivityStatusLabel(activity.status, t)}
            </p>
          </div>
        </div>
      </section>
      {activity.details.length > 0 ? (
        <dl className="divide-y divide-neutral-200 bg-white dark:divide-neutral-800 dark:bg-neutral-950">
          {activity.details.map((detail) => (
            <div key={`${detail.key}:${detail.value}`} className="flex min-w-0 items-center justify-between gap-3 px-4 py-2.5">
              <dt className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                {researchActivityDetailLabel(detail.key, t)}
              </dt>
              <dd className="min-w-0 break-all text-right text-[11px] text-neutral-700 dark:text-neutral-300">
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <ConfirmationBoundaryNotice boundaries={activity.confirmationBoundaries} status={activity.status} />
    </div>
  );
}

function ConfirmationBoundaryNotice({
  boundaries,
  status,
}: {
  boundaries: ResearchConfirmationBoundary[];
  status: ResearchToolActivity['status'];
}) {
  const { t } = useTranslation();
  if (boundaries.length === 0) return null;
  return (
    <section
      data-testid="research-confirmation-boundaries"
      role={status === 'requires_confirmation' ? 'alert' : 'status'}
      className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold">
            {status === 'requires_confirmation'
              ? t('researchPanel.confirmation.required', { defaultValue: 'Confirmation required' })
              : t('researchPanel.confirmation.boundary', { defaultValue: 'Confirmation boundary' })}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {boundaries.map((boundary) => (
              <span key={boundary} className="rounded border border-amber-300/70 bg-white/50 px-1.5 py-0.5 text-[10px] font-medium dark:border-amber-700/80 dark:bg-black/10">
                {researchConfirmationBoundaryLabel(boundary, t)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function researchIntentLabel(intent: ResearchPanelActivation['intents'][number], t: TFunction): string {
  return t(`researchPanel.activation.intents.${intent}`, {
    defaultValue: intent === 'analysis'
      ? 'Analysis'
      : intent === 'direction'
        ? 'Direction'
        : intent === 'experiment'
          ? 'Experiment'
          : intent === 'literature'
            ? 'Literature'
            : 'Manuscript',
  });
}

function researchToolLabel(toolName: string, t: TFunction): string {
  const defaults: Record<string, string> = {
    experiment_analysis: 'Experiment analysis',
    experiment_control: 'Experiment control',
    experiment_remote: 'Remote experiment',
    manuscript_latex: 'Manuscript',
    research_artifacts: 'Research artifacts',
    research_brief: 'Research brief',
    research_design: 'Research design',
    research_director: 'Research director',
    research_method: 'Research method',
    research_review: 'Research review',
  };
  return t(`researchPanel.activity.tools.${toolName}`, { defaultValue: defaults[toolName] ?? 'Research activity' });
}

function researchActivityStatusLabel(status: ResearchToolActivity['status'], t: TFunction): string {
  return t(`researchPanel.activity.status.${status}`, {
    defaultValue: status === 'complete'
      ? 'Completed'
      : status === 'requires_confirmation'
        ? 'Awaiting confirmation'
        : 'Needs attention',
  });
}

function researchActivityDetailLabel(key: ResearchToolActivity['details'][number]['key'], t: TFunction): string {
  const defaults: Record<ResearchToolActivity['details'][number]['key'], string> = {
    action: 'Action',
    analysis_id: 'Analysis',
    artifact_id: 'Artifact',
    count: 'Count',
    decision: 'Decision',
    job_id: 'Job',
    job_status: 'Job status',
    operation: 'Operation',
    plan_id: 'Plan',
    revision: 'Revision',
    status: 'Status',
  };
  return t(`researchPanel.activity.details.${key}`, { defaultValue: defaults[key] });
}

function researchConfirmationBoundaryLabel(boundary: ResearchConfirmationBoundary, t: TFunction): string {
  const defaults: Record<ResearchConfirmationBoundary, string> = {
    artifact_invalidation: 'Artifact invalidation',
    export: 'Export',
    final_title: 'Final title',
    remote_execution: 'Remote execution',
    snapshot: 'Snapshot',
    zotero_write: 'Zotero write',
  };
  return t(`researchPanel.confirmation.boundaries.${boundary}`, { defaultValue: defaults[boundary] });
}

function LiteratureResearchPanel({ artifact, projectPath }: {
  artifact: LiteratureResearchArtifact;
  projectPath?: string;
}) {
  const { t } = useTranslation();
  const { selectedPaperId, selectPaper } = useResearchPanel();
  const [view, setView] = useState<LiteratureResearchView>('map');
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroStatus | null>(null);
  const [zoteroLoading, setZoteroLoading] = useState(false);
  const [zoteroBinding, setZoteroBinding] = useState<ZoteroBinding | null>(null);
  const [paperMatches, setPaperMatches] = useState<ZoteroPaperMatch[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchesError, setMatchesError] = useState<string | null>(null);
  const [collectionItems, setCollectionItems] = useState<ZoteroItemsResult | null>(null);
  const [collectionLoading, setCollectionLoading] = useState(false);
  const [collectionError, setCollectionError] = useState<string | null>(null);
  const [collectionMapSyncNotice, setCollectionMapSyncNotice] = useState<ZoteroMapSyncNotice | null>(null);
  const [collectionQuery, setCollectionQuery] = useState('');
  const [confirmingPaper, setConfirmingPaper] = useState<ResearchPaper | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [mapSeedPaperId, setMapSeedPaperId] = useState<string | null>(null);
  const [mapPaperStates, setMapPaperStates] = useState<Record<string, LiteratureMapPaperState[]>>({});
  const [mapPinnedPositions, setMapPinnedPositions] = useState<Record<string, LiteratureMapPoint>>({});
  const [mapPersistenceError, setMapPersistenceError] = useState<string | null>(null);
  const mapPersistenceRef = useRef<LiteratureMapPersistence | null>(null);
  const mapPersistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mapLoadGenerationRef = useRef(0);
  const collectionLoadGenerationRef = useRef(0);
  const artifactSeedPaperId = artifact.kind === 'literature_expansion' ? artifact.seedPaperId : null;
  const expansionSeedPaper = useMemo(
    () => artifact.kind === 'literature_expansion'
      ? artifact.papers.find((paper) => paper.id === artifact.seedPaperId) ?? null
      : null,
    [artifact],
  );

  const selectedPaper = useMemo(
    () => artifact.papers.find((paper) => paper.id === selectedPaperId) ?? expansionSeedPaper ?? artifact.papers[0] ?? null,
    [artifact.papers, expansionSeedPaper, selectedPaperId],
  );
  const selectedPaperUrl = useMemo(() => safeExternalUrl(selectedPaper?.url), [selectedPaper?.url]);
  const sourceNameById = useMemo(
    () => new Map(artifact.sources.map((source) => [source.id, source.name] as const)),
    [artifact.sources],
  );
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

  const handleViewKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentView: LiteratureResearchView) => {
    const currentIndex = LITERATURE_RESEARCH_VIEWS.indexOf(currentView);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % LITERATURE_RESEARCH_VIEWS.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + LITERATURE_RESEARCH_VIEWS.length) % LITERATURE_RESEARCH_VIEWS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = LITERATURE_RESEARCH_VIEWS.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextView = LITERATURE_RESEARCH_VIEWS[nextIndex];
    setView(nextView);
    document.getElementById(`research-panel-${nextView}-tab`)?.focus();
  };

  useEffect(() => {
    const paperIds = new Set(artifact.papers.map((paper) => paper.id));
    setMapSeedPaperId(artifactSeedPaperId);
    setMapPaperStates((current) => Object.fromEntries(
      Object.entries(current).filter(([paperId]) => paperIds.has(paperId)),
    ));
    setMapPinnedPositions((current) => Object.fromEntries(
      Object.entries(current).filter(([paperId]) => paperIds.has(paperId)),
    ));
    setCollectionMapSyncNotice(null);
  }, [artifact.artifactId, artifact.papers, artifactSeedPaperId, projectPath]);

  useEffect(() => {
    const generation = mapLoadGenerationRef.current + 1;
    mapLoadGenerationRef.current = generation;
    if (!projectPath) {
      mapPersistenceRef.current = null;
      setMapPersistenceError(null);
      return;
    }

    let cancelled = false;
    const synchronizeProjectMap = async () => {
      setMapPersistenceError(null);
      mapPersistenceRef.current = {
        projectPath,
        mapId: PROJECT_LITERATURE_MAP_ID,
        revision: 0,
      };
      try {
        const loaded = await loadProjectLiteratureMap(projectPath);
        if (cancelled || mapLoadGenerationRef.current !== generation) return;

        const mapId = loaded.map?.mapId ?? PROJECT_LITERATURE_MAP_ID;
        const merged = await updateProjectLiteratureMap(
          projectPath,
          mapId,
          { origin: 'search', papers: artifact.papers, edges: artifact.edges },
          loaded.map ? { expectedRevision: loaded.map.revision } : undefined,
        );
        if (cancelled || mapLoadGenerationRef.current !== generation) return;

        const map = merged.map;
        mapPersistenceRef.current = { projectPath, mapId: map.mapId, revision: map.revision };
        const visibleIds = new Set(artifact.papers.map((paper) => paper.id));
        const states: Record<string, LiteratureMapPaperState[]> = {};
        const positions: Record<string, LiteratureMapPoint> = {};
        for (const node of map.nodes) {
          if (!visibleIds.has(node.id)) continue;
          const state = mapStatusToPaperState(node.status);
          if (state) states[node.id] = [state];
          if (node.position.pinned) positions[node.id] = {
            x: node.position.x,
            y: node.position.y,
          };
        }
        setMapPaperStates(states);
        setMapPinnedPositions(positions);
        const persistedSeed = merged.seedPaperId ?? loaded.seedPaperId;
        const resolvedSeed = persistedSeed && visibleIds.has(persistedSeed)
          ? persistedSeed
          : artifactSeedPaperId && visibleIds.has(artifactSeedPaperId)
            ? artifactSeedPaperId
            : null;
        setMapSeedPaperId(resolvedSeed);

        if (!persistedSeed && resolvedSeed) {
          const seeded = await setProjectLiteratureMapSeed(projectPath, map.mapId, resolvedSeed);
          if (!cancelled && mapLoadGenerationRef.current === generation) {
            setMapSeedPaperId(seeded.seedPaperId);
          }
        }
      } catch (error) {
        if (cancelled || mapLoadGenerationRef.current !== generation) return;
        mapPersistenceRef.current = null;
        setMapPersistenceError(error instanceof Error ? error.message : String(error));
      }
    };

    void synchronizeProjectMap();
    return () => {
      cancelled = true;
    };
  }, [artifact.artifactId, artifact.edges, artifact.papers, artifactSeedPaperId, projectPath]);

  const enqueueMapPersistence = useCallback((operation: () => Promise<void>) => {
    const next = mapPersistenceQueueRef.current.then(operation, operation);
    mapPersistenceQueueRef.current = next.catch(() => undefined);
    void next.catch((error) => {
      setMapPersistenceError(error instanceof Error ? error.message : String(error));
    });
    return next;
  }, []);

  const refreshProjectMapAfterConflict = useCallback(async (persistence: LiteratureMapPersistence) => {
    const latest = await loadProjectLiteratureMap(persistence.projectPath);
    if (!latest.map) {
      mapPersistenceRef.current = null;
      return;
    }
    mapPersistenceRef.current = {
      projectPath: persistence.projectPath,
      mapId: latest.map.mapId,
      revision: latest.map.revision,
    };
    const paperIds = new Set(artifact.papers.map((paper) => paper.id));
    const states: Record<string, LiteratureMapPaperState[]> = {};
    const positions: Record<string, LiteratureMapPoint> = {};
    for (const node of latest.map.nodes) {
      if (!paperIds.has(node.id)) continue;
      const state = mapStatusToPaperState(node.status);
      if (state) states[node.id] = [state];
      if (node.position.pinned) positions[node.id] = { x: node.position.x, y: node.position.y };
    }
    setMapPaperStates(states);
    setMapPinnedPositions(positions);
    setMapSeedPaperId(latest.seedPaperId && paperIds.has(latest.seedPaperId) ? latest.seedPaperId : null);
  }, [artifact.papers]);

  const mergeZoteroCollectionItemsIntoProjectMap = useCallback(async (
    items: ZoteroLibraryItem[],
    truncated: boolean,
  ) => {
    if (!projectPath) return;
    const normalized = normalizeZoteroCollectionItems(items, new Date().toISOString());
    if (normalized.papers.length === 0) {
      setCollectionMapSyncNotice({
        kind: 'warning',
        text: zoteroMapSyncNoMergeText(normalized.skipped, truncated),
      });
      return;
    }

    try {
      await enqueueMapPersistence(async () => {
        let persistence = mapPersistenceRef.current;
        if (!persistence || persistence.projectPath !== projectPath) {
          const loaded = await loadProjectLiteratureMap(projectPath);
          persistence = {
            projectPath,
            mapId: loaded.map?.mapId ?? PROJECT_LITERATURE_MAP_ID,
            revision: loaded.map?.revision ?? 0,
          };
          mapPersistenceRef.current = persistence;
        }

        const update = { origin: 'zotero' as const, papers: normalized.papers };
        try {
          const result = await updateProjectLiteratureMap(
            projectPath,
            persistence.mapId,
            update,
            { expectedRevision: persistence.revision },
          );
          mapPersistenceRef.current = {
            projectPath,
            mapId: result.map.mapId,
            revision: result.map.revision,
          };
        } catch (error) {
          if (!isLiteratureMapRevisionConflict(error)) throw error;
          const latest = await loadProjectLiteratureMap(projectPath);
          if (!latest.map) throw error;
          const result = await updateProjectLiteratureMap(
            projectPath,
            latest.map.mapId,
            update,
            { expectedRevision: latest.map.revision },
          );
          mapPersistenceRef.current = {
            projectPath,
            mapId: result.map.mapId,
            revision: result.map.revision,
          };
        }
      });
      setCollectionMapSyncNotice({
        kind: normalized.skipped > 0 || truncated ? 'warning' : 'success',
        text: zoteroMapSyncSuccessText(normalized.papers.length, normalized.skipped, truncated),
      });
    } catch (error) {
      setCollectionMapSyncNotice({
        kind: 'error',
        text: `Zotero collection loaded, but its project-map merge failed; existing project map state was retained. ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [enqueueMapPersistence, projectPath]);

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
    const generation = collectionLoadGenerationRef.current + 1;
    collectionLoadGenerationRef.current = generation;
    if (!fixedCollectionKey) {
      setCollectionItems(null);
      setCollectionError(null);
      setCollectionMapSyncNotice(null);
      return;
    }
    setCollectionLoading(true);
    setCollectionError(null);
    setCollectionMapSyncNotice(null);
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
      if (collectionLoadGenerationRef.current !== generation) return;
      const result = body as ZoteroItemsResult;
      setCollectionItems(result);
      await mergeZoteroCollectionItemsIntoProjectMap(result.items, result.truncated === true);
    } catch (error) {
      if (collectionLoadGenerationRef.current !== generation) return;
      setCollectionError(error instanceof Error ? error.message : String(error));
      setCollectionMapSyncNotice({
        kind: 'warning',
        text: 'Zotero collection could not be loaded; the project map was not changed.',
      });
    } finally {
      if (collectionLoadGenerationRef.current === generation) setCollectionLoading(false);
    }
  }, [fixedCollectionKey, mergeZoteroCollectionItemsIntoProjectMap, projectPath]);

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
      await importPapersIntoZotero([confirmingPaper], { projectPath });
      setImportMessage({
        kind: 'success',
        text: t('researchPanel.importSuccess', { defaultValue: 'Saved to Zotero.' }),
      });
      setMapPaperStates((current) => updateMapPaperState(current, confirmingPaper.id, 'favorite', true));
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

  const persistMapNodeState = useCallback((paperId: string, state: {
    status?: ProjectLiteratureMapNodeStatus;
    position?: { x: number; y: number; pinned: boolean };
  }) => {
    if (!projectPath || !mapPersistenceRef.current) return;
    setMapPersistenceError(null);
    enqueueMapPersistence(async () => {
      const persistence = mapPersistenceRef.current;
      if (!persistence || persistence.projectPath !== projectPath) return;
      try {
        const result = await setProjectLiteratureMapNodeState(
          projectPath,
          persistence.mapId,
          paperId,
          state,
          { expectedRevision: persistence.revision },
        );
        mapPersistenceRef.current = {
          projectPath,
          mapId: result.map.mapId,
          revision: result.map.revision,
        };
      } catch (error) {
        if (isLiteratureMapRevisionConflict(error)) {
          await refreshProjectMapAfterConflict(persistence);
          throw new Error('The literature map changed elsewhere; the latest state was reloaded.');
        }
        throw error;
      }
    });
  }, [enqueueMapPersistence, projectPath, refreshProjectMapAfterConflict]);

  const persistMapSeed = useCallback((seedPaperId: string | null) => {
    if (!projectPath || !mapPersistenceRef.current) return;
    setMapPersistenceError(null);
    enqueueMapPersistence(async () => {
      const persistence = mapPersistenceRef.current;
      if (!persistence || persistence.projectPath !== projectPath) return;
      const result = await setProjectLiteratureMapSeed(projectPath, persistence.mapId, seedPaperId);
      mapPersistenceRef.current = {
        projectPath,
        mapId: result.map.mapId,
        revision: result.map.revision,
      };
    });
  }, [enqueueMapPersistence, projectPath]);

  const handleMapPaperAction = useCallback((request: LiteratureMapActionRequest) => {
    const paper = artifact.papers.find((candidate) => candidate.id === request.paperId);
    if (!paper) return;
    if (request.action === 'set_seed') {
      const nextSeed = mapSeedPaperId === paper.id ? null : paper.id;
      setMapSeedPaperId(nextSeed);
      persistMapSeed(nextSeed);
      return;
    }
    if (request.action === 'add_to_chat') {
      window.dispatchEvent(new CustomEvent(CHAT_DRAFT_INSERT_EVENT, {
        detail: { text: formatLiteratureChatReference(paper), source: 'research-literature' },
      }));
      return;
    }
    if (request.action === 'favorite') {
      const match = matchByPaperId.get(paper.id);
      if (match?.matched && match.confidence === 'exact') {
        setMapPaperStates((current) => updateMapPaperState(current, paper.id, 'favorite', true));
        return;
      }
      if (!zoteroStatus?.connectorReady) {
        setImportMessage({
          kind: 'error',
          text: zoteroStatus?.error || t('researchPanel.zoteroUnavailable', { defaultValue: 'Start Zotero to enable saving.' }),
        });
        return;
      }
      setImportMessage(null);
      setConfirmingPaper(paper);
      return;
    }

    const state = mapStateForAction(request.action);
    if (!state) return;
    const active = mapPaperStates[paper.id]?.includes(state) ?? false;
    setMapPaperStates((current) => {
      let next = current;
      if (state === 'core' || state === 'relevant' || state === 'irrelevant') {
        next = updateMapPaperState(next, paper.id, 'core', false);
        next = updateMapPaperState(next, paper.id, 'relevant', false);
        next = updateMapPaperState(next, paper.id, 'irrelevant', false);
      }
      return updateMapPaperState(next, paper.id, state, !active);
    });
    persistMapNodeState(paper.id, {
      status: active ? 'candidate' : state as Exclude<LiteratureMapPaperState, 'favorite'>,
    });
  }, [artifact.papers, mapPaperStates, mapSeedPaperId, matchByPaperId, persistMapNodeState, persistMapSeed, t, zoteroStatus]);

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden bg-neutral-50/70 dark:bg-neutral-950">
      <div className="shrink-0 border-b border-neutral-200 bg-white px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex items-start gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300">
            <Search className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            {artifact.kind === 'literature_expansion' ? (
              <>
                <p className="text-[13px] font-medium leading-5 text-neutral-900 dark:text-neutral-100">
                  {t('researchPanel.citationExpansion', { defaultValue: 'Citation expansion' })}
                </p>
                <p data-testid="research-expansion-seed" className="mt-0.5 line-clamp-2 break-words text-[11px] leading-4 text-neutral-600 dark:text-neutral-300">
                  {t('researchPanel.expansionSeed', {
                    defaultValue: 'Seed: {{title}}',
                    title: expansionSeedPaper?.title || artifact.plan.seed.title || artifact.seedPaperId,
                  })}
                </p>
              </>
            ) : (
              <p className="line-clamp-2 text-[13px] font-medium leading-5 text-neutral-900 dark:text-neutral-100">
                {artifact.plan.query}
              </p>
            )}
            <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('researchPanel.resultSummary', {
                defaultValue: '{{papers}} papers · {{edges}} relationships',
                papers: artifact.papers.length,
                edges: artifact.edges.length,
              })}
            </p>
          </div>
        </div>
        <div
          className="mt-3 grid grid-cols-3 rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-900"
          role="tablist"
          aria-label={t('researchPanel.views', { defaultValue: 'Research views' })}
        >
          {LITERATURE_RESEARCH_VIEWS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`research-panel-${tab}-tab`}
              aria-controls={`research-panel-${tab}-tabpanel`}
              aria-selected={view === tab}
              tabIndex={view === tab ? 0 : -1}
              onClick={() => setView(tab)}
              onKeyDown={(event) => handleViewKeyDown(event, tab)}
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

      <div
        id={`research-panel-${view}-tabpanel`}
        role="tabpanel"
        aria-labelledby={`research-panel-${view}-tab`}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <CoverageSummary artifact={artifact} sourceNameById={sourceNameById} />
        {artifact.kind === 'literature_search' ? (
          <>
            <QueryAuditSummary artifact={artifact} sourceNameById={sourceNameById} />
            <TerminologySummary terminology={artifact.terminology} />
          </>
        ) : null}
        {artifact.kind === 'literature_expansion' ? (
          <CitationExpansionSummary directions={artifact.directions} />
        ) : null}

        {view === 'map' ? (
          <div>
            <LiteratureMaintenancePanel
              projectPath={projectPath}
              mapId={PROJECT_LITERATURE_MAP_ID}
              onCompleted={async (maintenance: LiteratureMapMaintenanceResult) => {
                if (!projectPath || !maintenance.map) return;
                mapPersistenceRef.current = {
                  projectPath,
                  mapId: maintenance.map.mapId,
                  revision: maintenance.map.revision,
                };
                const states: Record<string, LiteratureMapPaperState[]> = {};
                const positions: Record<string, LiteratureMapPoint> = {};
                for (const node of maintenance.map.nodes) {
                  const state = mapStatusToPaperState(node.status);
                  if (state) states[node.id] = [state];
                  if (node.position.pinned) positions[node.id] = { x: node.position.x, y: node.position.y };
                }
                setMapPaperStates(states);
                setMapPinnedPositions(positions);
              }}
            />
            <div className="p-3">
            {mapPersistenceError ? (
              <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200" role="alert">
                {mapPersistenceError}
              </div>
            ) : null}
            <LiteratureMap
              artifact={artifact}
              selectedPaperId={selectedPaper?.id ?? null}
              seedPaperId={mapSeedPaperId}
              paperStates={mapPaperStates}
              pinnedPositions={mapPinnedPositions}
              onSelectPaper={selectPaper}
              onPaperAction={handleMapPaperAction}
              onPinnedPositionChange={(paperId, position) => {
                setMapPinnedPositions((current) => {
                  if (position) return { ...current, [paperId]: position };
                  if (!current[paperId]) return current;
                  const next = { ...current };
                  delete next[paperId];
                  return next;
                });
                persistMapNodeState(paperId, {
                  position: position
                    ? { x: position.x, y: position.y, pinned: true }
                    : { ...stableNodePosition(paperId), pinned: false },
                });
              }}
            />
            </div>
          </div>
        ) : view === 'papers' ? (
          <PaperList
            papers={artifact.papers}
            selectedPaperId={selectedPaper?.id ?? null}
            seedPaperId={mapSeedPaperId}
            onSelectPaper={selectPaper}
            matches={matchByPaperId}
            sourceNameById={sourceNameById}
          />
        ) : (
          <>
            <div className="p-3 pb-0">
              <ZoteroConnectionStatus projectPath={projectPath} />
            </div>
            <CollectionLibrary
              binding={zoteroBinding}
              result={collectionItems}
              loading={collectionLoading}
              error={collectionError}
              mapSyncNotice={collectionMapSyncNotice}
              projectPath={projectPath}
              query={collectionQuery}
              onQueryChange={setCollectionQuery}
              onSearch={() => void loadCollectionItems(collectionQuery)}
              onRefresh={() => void loadCollectionItems(collectionQuery)}
            />
          </>
        )}

        <SourceCoverageList sources={artifact.sources} sourceNameById={sourceNameById} />
      </div>

      <div className="min-w-0 shrink-0 overflow-x-hidden border-t border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
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

            <PaperProvenance paper={selectedPaper} sourceNameById={sourceNameById} />

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

function CitationExpansionSummary({ directions }: { directions: LiteratureExpansionDirectionResult[] }) {
  const { t } = useTranslation();
  if (directions.length === 0) return null;

  return (
    <section data-testid="research-expansion-directions" className="min-w-0 overflow-x-hidden border-b border-neutral-200 bg-white px-3 py-2.5 dark:border-neutral-800 dark:bg-neutral-950">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {t('researchPanel.expansionDirections', { defaultValue: 'Citation directions' })}
      </h3>
      <div className="mt-2 grid min-w-0 gap-2">
        {directions.map((result) => {
          const queryUrl = safeExternalUrl(result.queryUrl);
          const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
          const metrics = [
            t('researchPanel.expansionReturnedCount', { defaultValue: '{{count}} returned', count: result.resultCount }),
            typeof result.totalMatches === 'number'
              ? t('researchPanel.expansionTotalCount', { defaultValue: '{{count}} total', count: result.totalMatches })
              : null,
            typeof result.requestedCount === 'number'
              ? t('researchPanel.expansionRequestedCount', { defaultValue: '{{count}} requested', count: result.requestedCount })
              : null,
            typeof result.resolvedCount === 'number'
              ? t('researchPanel.expansionResolvedCount', { defaultValue: '{{count}} resolved', count: result.resolvedCount })
              : null,
          ].filter((metric): metric is string => Boolean(metric));
          return (
            <div
              key={result.direction}
              data-testid={`research-expansion-direction-${result.direction}`}
              className="min-w-0 rounded-lg border border-neutral-200 bg-neutral-50/70 px-2.5 py-2 dark:border-neutral-800 dark:bg-neutral-900/60"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium text-neutral-800 dark:text-neutral-200">
                  {result.direction === 'references'
                    ? t('researchPanel.expansionReferences', { defaultValue: 'References' })
                    : t('researchPanel.expansionCitations', { defaultValue: 'Citations' })}
                </span>
                <span className={cn('rounded border px-1.5 py-0.5 text-[9px] font-semibold', expansionDirectionStatusClass(result.status))}>
                  {expansionDirectionStatusLabel(result.status, t)}
                </span>
                {result.truncated ? (
                  <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200">
                    {t('researchPanel.expansionTruncated', { defaultValue: 'Truncated' })}
                  </span>
                ) : null}
                {queryUrl ? (
                  <a href={queryUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-indigo-600 hover:underline dark:text-indigo-300">
                    {t('researchPanel.sourceQuery', { defaultValue: 'Query' })}
                    <ArrowUpRight className="h-3 w-3" />
                  </a>
                ) : null}
              </div>
              <p className="mt-1 min-w-0 break-words text-[10px] leading-4 text-neutral-500 dark:text-neutral-400">
                {metrics.join(' · ')}
              </p>
              {result.error ? (
                <p className="mt-1 min-w-0 break-words text-[10px] leading-4 text-red-700 dark:text-red-300">
                  <span className="font-medium">{t('researchPanel.expansionError', { defaultValue: 'Error:' })}</span> {result.error}
                </p>
              ) : null}
              {warnings.length > 0 ? (
                <p className="mt-1 min-w-0 break-words text-[10px] leading-4 text-amber-700 dark:text-amber-300">
                  {warnings.join(' ')}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function expansionDirectionStatusLabel(
  status: LiteratureExpansionDirectionResult['status'],
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (status === 'ok') return t('researchPanel.expansionStatusOk', { defaultValue: 'Complete' });
  if (status === 'partial') return t('researchPanel.expansionStatusPartial', { defaultValue: 'Partial' });
  if (status === 'unavailable') return t('researchPanel.expansionStatusUnavailable', { defaultValue: 'Unavailable' });
  return t('researchPanel.expansionStatusError', { defaultValue: 'Failed' });
}

function expansionDirectionStatusClass(status: LiteratureExpansionDirectionResult['status']): string {
  if (status === 'ok') return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-300';
  if (status === 'partial') return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200';
  if (status === 'unavailable') return 'border-neutral-200 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300';
  return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300';
}

function CoverageSummary({
  artifact,
  sourceNameById,
}: {
  artifact: LiteratureResearchArtifact;
  sourceNameById: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
  const requestedSourceIds = resolvedCoverageSourceIds(artifact, 'requestedSourceIds');
  const successfulSourceIds = resolvedCoverageSourceIds(artifact, 'successfulSourceIds');
  // Older artifacts classified every non-successful source as failed. A
  // disabled source was never queried, however, so keep it separate from an
  // actual request failure when presenting the coverage summary.
  const unappliedSourceIds = resolvedUnappliedSourceIds(artifact);
  const unappliedSourceIdSet = new Set(unappliedSourceIds);
  const failedSourceIds = resolvedCoverageSourceIds(artifact, 'failedSourceIds')
    .filter((sourceId) => !unappliedSourceIdSet.has(sourceId));
  const status = artifact.coverage.status;
  const onlyUnapplied = status === 'failed'
    && successfulSourceIds.length === 0
    && failedSourceIds.length === 0
    && unappliedSourceIds.length > 0;
  const statusLabel = onlyUnapplied
    ? t('researchPanel.coverageUnapplied', { defaultValue: 'No sources applied' })
    : status === 'complete'
      ? t('researchPanel.coverageComplete', { defaultValue: 'Coverage complete' })
      : status === 'partial'
        ? t('researchPanel.coveragePartial', { defaultValue: 'Partial coverage' })
        : t('researchPanel.coverageFailed', { defaultValue: 'Coverage failed' });
  const statusClassName = onlyUnapplied
    ? 'border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200'
    : status === 'complete'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200'
    : status === 'partial'
      ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200'
      : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200';
  const failedNames = failedSourceIds.map((sourceId) => sourceDisplayName(sourceId, sourceNameById));
  const unappliedNames = unappliedSourceIds.map((sourceId) => sourceDisplayName(sourceId, sourceNameById));

  return (
    <section
      data-testid="research-coverage-summary"
      className={cn('m-3 min-w-0 rounded-lg border p-2.5 text-[11px] leading-4', statusClassName)}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 font-semibold">
          {status === 'complete' ? <Check className="h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
          {statusLabel}
        </span>
        <span className="text-current/75">
          {t('researchPanel.coverageCounts', {
            defaultValue: '{{successful}} successful · {{failed}} failed · {{unapplied}} not applied · {{requested}} requested sources',
            successful: successfulSourceIds.length,
            failed: failedSourceIds.length,
            unapplied: unappliedSourceIds.length,
            requested: requestedSourceIds.length,
          })}
        </span>
      </div>
      {failedNames.length > 0 ? (
        <p className="mt-1.5 break-words font-medium">
          {t('researchPanel.failedSources', {
            defaultValue: 'Failed sources: {{sources}}',
            sources: failedNames.join(', '),
          })}
        </p>
      ) : null}
      {unappliedNames.length > 0 ? (
        <p className="mt-1.5 break-words font-medium">
          {t('researchPanel.unappliedSources', {
            defaultValue: 'Not applied: {{sources}}',
            sources: unappliedNames.join(', '),
          })}
        </p>
      ) : null}
      {artifact.coverage.warnings.length > 0 ? (
        <div className="border-current/15 mt-2 flex min-w-0 gap-1.5 border-t pt-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{artifact.coverage.warnings.join(' ')}</span>
        </div>
      ) : null}
    </section>
  );
}

function SourceCoverageList({
  sources,
  sourceNameById,
}: {
  sources: ResearchSourceStatus[];
  sourceNameById: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();

  return (
    <section className="min-w-0 border-t border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        {t('researchPanel.sources', { defaultValue: 'Sources and coverage' })}
      </h3>
      {sources.length === 0 ? (
        <p className="mt-2 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
          {t('researchPanel.noSources', { defaultValue: 'No source status was returned.' })}
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {sources.map((source) => {
            const queryUrl = safeExternalUrl(source.queryUrl);
            const rateLimited = isRateLimitedSource(source);
            const appliedDetails = [
              source.applied?.dateField
                ? t('researchPanel.sourceAppliedDateField', { defaultValue: 'Date: {{field}}', field: source.applied.dateField })
                : null,
              source.applied?.sort
                ? t('researchPanel.sourceAppliedSort', { defaultValue: 'Sort: {{sort}}', sort: source.applied.sort })
                : null,
              source.applied?.classifications?.length
                ? t('researchPanel.sourceAppliedClassifications', {
                  defaultValue: 'Categories: {{classifications}}',
                  classifications: source.applied.classifications.join(', '),
                })
                : null,
            ].filter((detail): detail is string => Boolean(detail));
            const rateLimitDetails = sourceRateLimitDetails(source, t);
            const warnings = Array.isArray(source.warnings) ? source.warnings.filter(Boolean) : [];
            const statusLabel = source.status === 'ok'
              ? t('researchPanel.sourceAvailable', { defaultValue: 'Available' })
              : source.status === 'disabled'
                ? t('researchPanel.sourceNotApplied', { defaultValue: 'Not applied' })
                : t('researchPanel.sourceFailed', { defaultValue: 'Failed' });
            return (
              <div
                key={source.id}
                data-testid={`research-source-${source.id}`}
                className="min-w-0 rounded-lg border border-neutral-200 p-2.5 dark:border-neutral-800"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    source.status === 'ok'
                      ? 'bg-emerald-500'
                      : source.status === 'disabled'
                        ? 'bg-neutral-400'
                        : 'bg-red-500',
                  )} />
                  <span className="min-w-0 break-words text-[12px] font-medium text-neutral-800 dark:text-neutral-200">
                    {sourceDisplayName(source.id, sourceNameById)}
                  </span>
                  <span className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-medium',
                    source.status === 'ok'
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                      : source.status === 'disabled'
                        ? 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                        : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300',
                  )}>
                    {statusLabel}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-neutral-400">
                    {t('researchPanel.sourceResults', { defaultValue: '{{count}} results', count: source.resultCount })}
                  </span>
                </div>
                <p className="mt-1 break-words text-[10px] leading-4 text-neutral-500 dark:text-neutral-400">{source.coverage}</p>
                {appliedDetails.length > 0 ? (
                  <div
                    data-testid={`research-source-applied-${source.id}`}
                    className="mt-1 flex min-w-0 gap-1.5 break-words text-[10px] leading-4 text-neutral-500 dark:text-neutral-400"
                  >
                    <span className="shrink-0 font-medium text-neutral-600 dark:text-neutral-300">
                      {t('researchPanel.sourceApplied', { defaultValue: 'Applied:' })}
                    </span>
                    <span className="min-w-0 break-words">{appliedDetails.join(' · ')}</span>
                  </div>
                ) : null}
                {rateLimitDetails.length > 0 ? (
                  <div
                    data-testid={`research-source-rate-limit-${source.id}`}
                    className="mt-1 flex min-w-0 gap-1.5 break-words text-[10px] leading-4 text-neutral-500 dark:text-neutral-400"
                  >
                    <span className="shrink-0 font-medium text-neutral-600 dark:text-neutral-300">
                      {t('researchPanel.sourceRateLimitDetails', { defaultValue: 'Rate limit:' })}
                    </span>
                    <span className="min-w-0 break-words">{rateLimitDetails.join(' · ')}</span>
                  </div>
                ) : null}
                {source.error ? (
                  <p className="mt-1 break-words text-[10px] leading-4 text-red-700 dark:text-red-300" role="alert">
                    <span className="font-medium">{t('researchPanel.sourceError', { defaultValue: 'Error:' })}</span> {source.error}
                  </p>
                ) : null}
                {rateLimited ? (
                  <p className="mt-1 break-words text-[10px] leading-4 text-amber-700 dark:text-amber-300">
                    {t('researchPanel.sourceRateLimited', { defaultValue: 'Rate limited. This source may have incomplete coverage.' })}
                  </p>
                ) : null}
                {warnings.length > 0 ? (
                  <div
                    data-testid={`research-source-warnings-${source.id}`}
                    className="mt-1 flex min-w-0 gap-1.5 text-[10px] leading-4 text-amber-700 dark:text-amber-300"
                    role="status"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{warnings.join(' ')}</span>
                  </div>
                ) : null}
                <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-neutral-400">
                  <span className="min-w-0 break-words">
                    {t('researchPanel.sourceRetrievedAt', {
                      defaultValue: 'Retrieved: {{time}}',
                      time: formatResearchTimestamp(source.retrievedAt),
                    })}
                  </span>
                  {queryUrl ? (
                    <a
                      href={queryUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 font-medium text-indigo-600 hover:underline dark:text-indigo-300"
                    >
                      {t('researchPanel.sourceQuery', { defaultValue: 'Query' })}
                    </a>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function QueryAuditSummary({
  artifact,
  sourceNameById,
}: {
  artifact: LiteratureSearchArtifact;
  sourceNameById: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
  const audit = artifact.queryAudit ?? [];
  const variants = artifact.plan.queryVariants ?? [];
  const variantById = new Map(variants.map((variant) => [variant.id, variant] as const));
  if (audit.length === 0) return null;

  return (
    <section
      data-testid="research-query-audit"
      className="mx-3 mb-3 min-w-0 rounded-lg border border-neutral-200 bg-white p-2.5 dark:border-neutral-800 dark:bg-neutral-950"
    >
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          {t('researchPanel.queryRuns', { defaultValue: 'Query runs' })}
        </h3>
        <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300">
          {audit.length}
        </span>
      </div>
      <div className="mt-2 space-y-2">
        {audit.map((run, index) => {
          const variant = run.queryVariantId ? variantById.get(run.queryVariantId) : undefined;
          const queryUrl = safeExternalUrl(run.queryUrl);
          const statusLabel = run.status === 'ok'
            ? t('researchPanel.sourceAvailable', { defaultValue: 'Available' })
            : run.status === 'disabled'
              ? t('researchPanel.sourceNotApplied', { defaultValue: 'Not applied' })
              : t('researchPanel.sourceFailed', { defaultValue: 'Failed' });
          const variantLabel = run.queryVariantId === 'primary'
            ? t('researchPanel.queryPrimary', { defaultValue: 'Primary query' })
            : t('researchPanel.queryAlternative', { defaultValue: 'Alternative query' });
          const categoryLabel = variant?.category
            ? t(`researchPanel.queryCategory.${variant.category}`, { defaultValue: variant.category })
            : null;
          const rateLimitDetails = sourceRateLimitDetails(run, t);
          return (
            <div
              key={`${run.queryVariantId ?? 'query'}:${run.id}:${index}`}
              data-testid={`research-query-run-${run.queryVariantId ?? index}-${run.id}`}
              className="min-w-0 rounded-md border border-neutral-200 p-2 dark:border-neutral-800"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
                <span className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  run.status === 'ok' ? 'bg-emerald-500' : run.status === 'disabled' ? 'bg-neutral-400' : 'bg-red-500',
                )} />
                <span className="font-medium text-neutral-700 dark:text-neutral-200">{variantLabel}</span>
                {categoryLabel ? (
                  <span
                    data-testid={`research-query-category-${variant?.category}`}
                    className="rounded bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-200"
                  >
                    {categoryLabel}
                  </span>
                ) : null}
                <span className="min-w-0 break-words text-neutral-500 dark:text-neutral-400">
                  {sourceDisplayName(run.id, sourceNameById)}
                </span>
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300">
                  {statusLabel}
                </span>
                <span className="ml-auto shrink-0 text-neutral-400">
                  {t('researchPanel.queryRunCounts', {
                    defaultValue: '{{requested}} requested · {{returned}} returned',
                    requested: variant?.requestLimit ?? run.resultCount,
                    returned: run.resultCount,
                  })}
                </span>
              </div>
              <p className="mt-1 break-words text-[11px] font-medium leading-4 text-neutral-700 dark:text-neutral-200">
                {variant?.query ?? artifact.plan.query}
              </p>
              {variant?.rationale ? (
                <p className="mt-0.5 break-words text-[10px] leading-4 text-neutral-500 dark:text-neutral-400">
                  {t('researchPanel.queryRationale', { defaultValue: 'Reason: {{reason}}', reason: variant.rationale })}
                </p>
              ) : null}
              {run.error ? (
                <p className="mt-0.5 break-words text-[10px] leading-4 text-red-700 dark:text-red-300" role="alert">
                  {run.error}
                </p>
              ) : null}
              {rateLimitDetails.length > 0 ? (
                <p
                  data-testid={`research-query-rate-limit-${run.queryVariantId ?? index}-${run.id}`}
                  className="mt-0.5 break-words text-[10px] leading-4 text-neutral-500 dark:text-neutral-400"
                >
                  {t('researchPanel.sourceRateLimitInline', {
                    defaultValue: 'Rate limit: {{details}}',
                    details: rateLimitDetails.join(' · '),
                  })}
                </p>
              ) : null}
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-neutral-400">
                <span className="min-w-0 break-words">{formatResearchTimestamp(run.retrievedAt)}</span>
                {queryUrl ? (
                  <a
                    href={queryUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-300"
                  >
                    {t('researchPanel.queryOpen', { defaultValue: 'Open query' })}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TerminologySummary({ terminology }: { terminology?: ResearchTerminologySummary }) {
  const { t } = useTranslation();
  if (!terminology || terminology.candidates.length === 0) return null;
  const kinds: ResearchTerminologyCandidate['kind'][] = [
    'observed_keyword',
    'observed_topic',
    'adjacent_field',
  ];

  return (
    <section
      data-testid="research-terminology-summary"
      className="mx-3 mb-3 min-w-0 rounded-lg border border-neutral-200 bg-white p-2.5 dark:border-neutral-800 dark:bg-neutral-950"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          {t('researchPanel.terminologyTitle', { defaultValue: 'Observed terminology' })}
        </h3>
        <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300">
          {terminology.candidates.length}
          {terminology.truncated
            ? t('researchPanel.terminologyTruncatedSuffix', { defaultValue: ' of {{total}}', total: terminology.totalCandidateCount })
            : null}
        </span>
      </div>
      <p className="mt-1.5 break-words text-[10px] leading-4 text-neutral-500 dark:text-neutral-400">
        {t('researchPanel.terminologyDisclaimer', {
          defaultValue: 'Observed OpenAlex metadata and taxonomy only. These are not synonyms or author keywords, and no search was run automatically.',
        })}
      </p>
      <div className="mt-2 space-y-3">
        {kinds.map((kind) => {
          const candidates = terminology.candidates.filter((candidate) => candidate.kind === kind);
          if (candidates.length === 0) return null;
          return (
            <div key={kind} data-testid={`research-terminology-group-${kind}`} className="min-w-0">
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                {terminologyKindLabel(kind, t)}
              </h4>
              <div className="mt-1.5 space-y-1.5">
                {candidates.map((candidate, index) => (
                  <TerminologyCandidateCard key={candidate.id} candidate={candidate} index={index} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TerminologyCandidateCard({
  candidate,
  index,
}: {
  candidate: ResearchTerminologyCandidate;
  index: number;
}) {
  const { t } = useTranslation();
  const maxScore = candidate.evidence.reduce<number | undefined>((best, evidence) => (
    evidence.providerScore === undefined || (best !== undefined && best >= evidence.providerScore)
      ? best
      : evidence.providerScore
  ), undefined);
  const filteredByScoreCount = (candidate.observationTruncation ?? [])
    .reduce((total, observation) => total + observation.filteredByScoreCount, 0);
  const truncatedObservationCount = (candidate.observationTruncation ?? [])
    .filter((observation) => observation.truncatedByLimit).length;

  return (
    <div
      data-testid={`research-terminology-candidate-${candidate.kind}-${index}`}
      className="min-w-0 rounded-md border border-neutral-200 p-2 dark:border-neutral-800"
    >
      <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
        <span className="min-w-0 flex-1 break-words text-[11px] font-medium leading-4 text-neutral-800 dark:text-neutral-200">
          {candidate.text}
        </span>
        <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300">
          {t('researchPanel.terminologySupport', {
            defaultValue: '{{papers}} papers · {{evidence}} evidence',
            papers: candidate.supportingPaperIds.length,
            evidence: candidate.totalEvidenceCount,
          })}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[10px] leading-4 text-neutral-500 dark:text-neutral-400">
        {maxScore !== undefined ? (
          <span>{t('researchPanel.terminologyScore', { defaultValue: 'OpenAlex score {{score}}', score: maxScore.toFixed(3) })}</span>
        ) : null}
        {filteredByScoreCount > 0 ? (
          <span>{t('researchPanel.terminologyFiltered', { defaultValue: '{{count}} low-score records excluded', count: filteredByScoreCount })}</span>
        ) : null}
        {candidate.evidenceTruncated || truncatedObservationCount > 0 ? (
          <span className="text-amber-700 dark:text-amber-300">
            {t('researchPanel.terminologyEvidenceTruncated', { defaultValue: 'Evidence truncated' })}
          </span>
        ) : null}
      </div>
      {candidate.inference ? (
        <p data-testid={`research-terminology-inference-${index}`} className="mt-1 break-words text-[10px] leading-4 text-indigo-700 dark:text-indigo-300">
          {t('researchPanel.terminologyInference', {
            defaultValue: 'Taxonomy contrast at {{level}} level against core {{core}}; requires at least {{minimum}} independent papers.',
            level: candidate.inference.level,
            core: candidate.inference.coreText,
            minimum: candidate.inference.minimumSupportingPapers,
          })}
        </p>
      ) : null}
      <details className="mt-1.5 min-w-0 text-[10px]">
        <summary className="cursor-pointer select-none font-medium text-indigo-600 dark:text-indigo-300">
          {t('researchPanel.terminologyEvidence', { defaultValue: 'Evidence details' })}
        </summary>
        <div className="mt-1 space-y-1">
          {candidate.evidence.map((evidence, evidenceIndex) => {
            const providerUrl = safeExternalUrl(evidence.providerUrl);
            const retrievalUrl = safeExternalUrl(evidence.retrievalUrl);
            return (
              <div
                key={`${evidence.providerRecordId}:${evidence.supportingPaperId}:${evidence.queryVariantId ?? ''}:${evidence.providerField}:${evidenceIndex}`}
                className="min-w-0 rounded bg-neutral-50 p-1.5 leading-4 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400"
              >
                <p className="break-words">
                  {t('researchPanel.terminologyEvidenceLine', {
                    defaultValue: '{{field}} · {{time}}',
                    field: terminologyProviderFieldLabel(evidence.providerField, t),
                    time: formatResearchTimestamp(evidence.retrievedAt),
                  })}
                </p>
                <div className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5">
                  {providerUrl ? (
                    <a href={providerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-300">
                      {t('researchPanel.terminologyOpenAlexRecord', { defaultValue: 'OpenAlex record' })}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                  {retrievalUrl ? (
                    <a href={retrievalUrl} target="_blank" rel="noreferrer" className="font-medium text-indigo-600 hover:underline dark:text-indigo-300">
                      {t('researchPanel.terminologyRetrieval', { defaultValue: 'Retrieval query' })}
                    </a>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}

function PaperProvenance({
  paper,
  sourceNameById,
}: {
  paper: ResearchPaper;
  sourceNameById: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
  const provenance = paperProvenanceEntries(paper);
  if (paperSourceIds(paper).length === 0) return null;

  return (
    <div data-testid={`paper-provenance-${paper.id}`} className="min-w-0 rounded-md bg-neutral-50 px-2 py-1.5 dark:bg-neutral-900/70">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-medium text-neutral-500 dark:text-neutral-400">
          {t('researchPanel.paperSources', { defaultValue: 'Sources' })}
        </span>
        <PaperSourceBadges paper={paper} sourceNameById={sourceNameById} compact={false} />
      </div>
      {provenance.length > 0 ? (
        <div className="mt-1.5 space-y-1 border-t border-neutral-200 pt-1.5 text-[10px] leading-4 text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          {provenance.map((entry, index) => {
            const queryUrl = safeExternalUrl(entry.queryUrl);
            return (
              <div key={`${entry.sourceId}:${entry.sourceRecordId ?? index}`} className="min-w-0 break-words">
                <span className="font-medium text-neutral-600 dark:text-neutral-300">{sourceDisplayName(entry.sourceId, sourceNameById)}</span>
                {entry.sourceRecordId ? <span> · {t('researchPanel.sourceRecord', { defaultValue: 'Record {{id}}', id: entry.sourceRecordId })}</span> : null}
                {typeof entry.rank === 'number' ? <span> · {t('researchPanel.sourceRank', { defaultValue: 'Rank {{rank}}', rank: entry.rank })}</span> : null}
                {entry.retrievedAt ? <span> · {formatResearchTimestamp(entry.retrievedAt)}</span> : null}
                {queryUrl ? (
                  <a href={queryUrl} target="_blank" rel="noreferrer" className="ml-1 font-medium text-indigo-600 hover:underline dark:text-indigo-300">
                    {t('researchPanel.sourceQuery', { defaultValue: 'Query' })}
                  </a>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function PaperSourceBadges({
  paper,
  sourceNameById,
  compact,
}: {
  paper: ResearchPaper;
  sourceNameById: ReadonlyMap<string, string>;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const sourceIds = paperSourceIds(paper);
  const visibleSourceIds = compact ? sourceIds.slice(0, 2) : sourceIds.slice(0, 3);
  const remainingCount = sourceIds.length - visibleSourceIds.length;
  const sourceNames = sourceIds.map((sourceId) => sourceDisplayName(sourceId, sourceNameById));

  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-1"
      aria-label={t('researchPanel.paperSourceList', { defaultValue: 'Sources: {{sources}}', sources: sourceNames.join(', ') })}
    >
      {visibleSourceIds.map((sourceId) => (
        <span
          key={sourceId}
          className="inline-flex max-w-full items-center rounded border border-indigo-100 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-300"
          title={sourceDisplayName(sourceId, sourceNameById)}
        >
          <span className="truncate">{sourceDisplayName(sourceId, sourceNameById)}</span>
        </span>
      ))}
      <span
        className="text-[10px] text-neutral-500 dark:text-neutral-400"
        title={t('researchPanel.paperSourceCount', { defaultValue: '{{count}} sources', count: sourceIds.length })}
      >
        {sourceIds.length}
      </span>
      {remainingCount > 0 ? (
        <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
          {t('researchPanel.moreSources', { defaultValue: '+{{count}}', count: remainingCount })}
        </span>
      ) : null}
    </span>
  );
}

function CollectionLibrary({
  binding,
  result,
  loading,
  error,
  mapSyncNotice,
  projectPath,
  query,
  onQueryChange,
  onSearch,
  onRefresh,
}: {
  binding: ZoteroBinding | null;
  result: ZoteroItemsResult | null;
  loading: boolean;
  error: string | null;
  mapSyncNotice: ZoteroMapSyncNotice | null;
  projectPath?: string;
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
        {mapSyncNotice ? (
          <div
            data-testid="zotero-map-sync-notice"
            role={mapSyncNotice.kind === 'error' ? 'alert' : 'status'}
            className={cn(
              'mt-2 rounded-md border px-2.5 py-2 text-[10px] leading-4',
              mapSyncNotice.kind === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-200'
                : mapSyncNotice.kind === 'error'
                  ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200'
                  : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200',
            )}
          >
            {mapSyncNotice.text}
          </div>
        ) : null}
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
          {result.items.map((item) => (
            <CollectionItemRow
              key={item.key}
              item={item}
              projectPath={projectPath}
              collectionKey={binding.collectionKey}
            />
          ))}
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

type ZoteroItemDetailsState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data?: ZoteroItemDetailsResult;
  error?: string;
};

type ZoteroAttachmentTextState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data?: ZoteroAttachmentFullTextResult;
  error?: string;
  visible?: boolean;
};

type ZoteroAttachmentOpenState = {
  status: 'idle' | 'loading' | 'opened' | 'error';
  error?: string;
};

type ZoteroTagCatalogState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data?: ZoteroTagsResult;
  error?: string;
  loadingMore?: boolean;
};

type ZoteroExportAction = `${ZoteroExportFormat}:${'copy' | 'download'}`;
const ZOTERO_TAG_SUGGESTIONS_STEP = 24;

type ZoteroNoteEditorState =
  | { mode: 'create'; text: string }
  | { mode: 'update'; noteKey: string; text: string }
  | null;

function CollectionItemRow({
  item,
  projectPath,
  collectionKey,
}: {
  item: ZoteroLibraryItem;
  projectPath?: string;
  collectionKey?: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [detailsState, setDetailsState] = useState<ZoteroItemDetailsState>({ status: 'idle' });
  const [attachmentTextByKey, setAttachmentTextByKey] = useState<Record<string, ZoteroAttachmentTextState>>({});
  const [attachmentOpenByKey, setAttachmentOpenByKey] = useState<Record<string, ZoteroAttachmentOpenState>>({});
  const [exportAction, setExportAction] = useState<ZoteroExportAction | null>(null);
  const [exportMessage, setExportMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [tagCatalog, setTagCatalog] = useState<ZoteroTagCatalogState>({ status: 'idle' });
  const [visibleTagCount, setVisibleTagCount] = useState(ZOTERO_TAG_SUGGESTIONS_STEP);
  const [noteEditor, setNoteEditor] = useState<ZoteroNoteEditorState>(null);
  const [cloudPlan, setCloudPlan] = useState<ZoteroCloudWritePlan | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudMessage, setCloudMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const url = safeExternalUrl(item.url);
  const itemTitle = item.title || t('researchPanel.untitledItem', { defaultValue: 'Untitled item' });
  const detail = detailsState.data?.detail;
  const detailItem = detail?.item ?? item;
  const detailTags = detail?.tags ?? detailItem.tags ?? item.tags;
  const detailNotes = detail?.notes ?? [];
  const detailAttachments = detail?.attachments ?? [];

  const loadDetails = useCallback(() => {
    setDetailsState({ status: 'loading' });
    void getZoteroItemDetails(item.key, { projectPath })
      .then((data) => {
        if (!data.detail) throw new Error('Zotero returned no item detail.');
        setDetailsState({ status: 'ready', data });
      })
      .catch((error) => {
        setDetailsState({
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [item.key, projectPath]);

  const toggleDetails = useCallback(() => {
    if (expanded) {
      setExpanded(false);
      return;
    }

    setExpanded(true);
    if (detailsState.status === 'loading' || detailsState.status === 'ready') return;
    loadDetails();
  }, [detailsState.status, expanded, loadDetails]);

  const readAttachmentText = useCallback((attachment: ZoteroLibraryAttachment) => {
    const current = attachmentTextByKey[attachment.key];
    if (current?.status === 'loading') return;
    if (current?.status === 'ready') {
      setAttachmentTextByKey((previous) => ({
        ...previous,
        [attachment.key]: { ...current, visible: !current.visible },
      }));
      return;
    }

    setAttachmentTextByKey((previous) => ({
      ...previous,
      [attachment.key]: { status: 'loading' },
    }));
    void getZoteroAttachmentFullText(attachment.key, { projectPath })
      .then((data) => {
        if (!data.content?.trim()) {
          throw new Error(data.error || 'No indexed full text is available for this attachment.');
        }
        setAttachmentTextByKey((previous) => ({
          ...previous,
          [attachment.key]: { status: 'ready', data, visible: true },
        }));
      })
      .catch((error) => {
        setAttachmentTextByKey((previous) => ({
          ...previous,
          [attachment.key]: {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      });
  }, [attachmentTextByKey, projectPath]);

  const openAttachmentFile = useCallback((attachment: ZoteroLibraryAttachment) => {
    const openAttachment = window.rigoriumZoteroLibrary?.openAttachment;
    if (!openAttachment) {
      setAttachmentOpenByKey((previous) => ({
        ...previous,
        [attachment.key]: {
          status: 'error',
          error: t('researchPanel.attachmentOpenUnavailable', {
            defaultValue: 'Opening local attachments requires the Rigorium desktop app.',
          }),
        },
      }));
      return;
    }
    setAttachmentOpenByKey((previous) => ({
      ...previous,
      [attachment.key]: { status: 'loading' },
    }));
    void openAttachment(attachment.key, { projectPath })
      .then((result) => {
        if (!result?.opened) throw new Error('Zotero did not open the attachment.');
        setAttachmentOpenByKey((previous) => ({
          ...previous,
          [attachment.key]: { status: 'opened' },
        }));
      })
      .catch((error) => {
        setAttachmentOpenByKey((previous) => ({
          ...previous,
          [attachment.key]: {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      });
  }, [projectPath, t]);

  const runExport = useCallback((format: ZoteroExportFormat, action: 'copy' | 'download') => {
    const activeAction: ZoteroExportAction = `${format}:${action}`;
    setExportAction(activeAction);
    setExportMessage(null);
    void getZoteroItemExport(item.key, format, { projectPath })
      .then(async (data) => {
        if (!data.content?.trim()) throw new Error(data.error || 'Zotero returned an empty export.');
        if (action === 'copy') {
          await copyZoteroExportText(data.content);
        } else {
          downloadZoteroExportText(data.content, exportFilename(item, format));
        }
        setExportMessage({
          kind: 'success',
          text: action === 'copy'
            ? t('researchPanel.exportCopied', { defaultValue: '{{format}} copied.', format: exportFormatName(format) })
            : t('researchPanel.exportDownloaded', { defaultValue: '{{format}} downloaded.', format: exportFormatName(format) }),
        });
      })
      .catch((error) => {
        setExportMessage({
          kind: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setExportAction(null));
  }, [item, projectPath, t]);

  const previewCloudWrite = useCallback((intent: ZoteroCloudWriteIntent) => {
    setCloudBusy(true);
    setCloudMessage(null);
    void previewZoteroCloudWrite(intent, { projectPath })
      .then((plan) => setCloudPlan(plan))
      .catch((error) => {
        setCloudMessage({
          kind: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setCloudBusy(false));
  }, [projectPath]);

  const confirmCloudWrite = useCallback(() => {
    if (!cloudPlan) return;
    setCloudBusy(true);
    setCloudMessage(null);
    void confirmZoteroCloudWrite(cloudPlan, { projectPath })
      .then((result: ZoteroCloudWriteResult) => {
        setCloudPlan(null);
        if (result.status === 'succeeded' || result.status === 'partial') {
          setTagEditorOpen(false);
          setNoteEditor(null);
          setCloudMessage({
            kind: 'success',
            text: result.status === 'partial'
              ? t('researchPanel.cloudWritePartial', { defaultValue: 'Some Zotero changes were applied. Review the result before continuing.' })
              : t('researchPanel.cloudWriteSucceeded', { defaultValue: 'Zotero changes were applied.' }),
          });
          loadDetails();
          return;
        }
        const conflict = result.conflict;
        setCloudMessage({
          kind: 'error',
          text: result.status === 'conflict'
            ? t('researchPanel.cloudWriteConflict', { defaultValue: 'Zotero changed remotely. Review the latest item and preview again.' })
            : result.error || t('researchPanel.cloudWriteFailed', { defaultValue: 'Zotero could not apply this change.' }),
        });
        if (conflict?.kind === 'note' && conflict.remoteHtml) {
          const remoteHtml = conflict.remoteHtml;
          setNoteEditor((current) => current?.mode === 'update'
            ? { ...current, text: plainZoteroHtml(remoteHtml) }
            : current);
        }
      })
      .catch((error) => {
        setCloudMessage({
          kind: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setCloudBusy(false));
  }, [cloudPlan, loadDetails, projectPath, t]);

  const loadTagCatalog = useCallback(() => {
    setTagCatalog({ status: 'loading' });
    void getZoteroTags({ collectionKey, projectPath, limit: 100 })
      .then((data) => setTagCatalog({ status: 'ready', data }))
      .catch((error) => setTagCatalog({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }));
  }, [collectionKey, projectPath]);

  const loadMoreTagCatalog = useCallback(() => {
    const nextStart = tagCatalog.data?.nextStart;
    if (tagCatalog.status !== 'ready' || nextStart === undefined || tagCatalog.loadingMore) return;
    setTagCatalog((previous) => ({ ...previous, loadingMore: true, error: undefined }));
    void getZoteroTags({ collectionKey, projectPath, limit: 100, start: nextStart })
      .then((nextPage) => {
        setVisibleTagCount((current) => current + ZOTERO_TAG_SUGGESTIONS_STEP);
        setTagCatalog((previous) => ({
          status: 'ready',
          data: {
            ...nextPage,
            tags: mergeZoteroTagSuggestions(previous.data?.tags ?? [], nextPage.tags),
            total: Math.max(previous.data?.total ?? 0, nextPage.total),
            start: previous.data?.start ?? 0,
          },
          loadingMore: false,
        }));
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setTagCatalog((previous) => previous.data
          ? { ...previous, status: 'ready', loadingMore: false, error: message }
          : { status: 'error', error: message });
      });
  }, [collectionKey, projectPath, tagCatalog.data?.nextStart, tagCatalog.loadingMore, tagCatalog.status]);

  const startTagEditor = useCallback(() => {
    setCloudMessage(null);
    setTagDraft(detailTags.join(', '));
    setVisibleTagCount(ZOTERO_TAG_SUGGESTIONS_STEP);
    setTagEditorOpen(true);
    setNoteEditor(null);
    if (tagCatalog.status !== 'ready') loadTagCatalog();
  }, [detailTags, loadTagCatalog, tagCatalog.status]);

  const addTagSuggestion = useCallback((tag: string) => {
    const tags = tagDraft.split(',').map((value) => value.trim()).filter(Boolean);
    if (!tags.some((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase())) tags.push(tag);
    setTagDraft(tags.join(', '));
  }, [tagDraft]);

  const showMoreTagSuggestions = useCallback(() => {
    if ((tagCatalog.data?.tags.length ?? 0) > visibleTagCount) {
      setVisibleTagCount((current) => current + ZOTERO_TAG_SUGGESTIONS_STEP);
      return;
    }
    loadMoreTagCatalog();
  }, [loadMoreTagCatalog, tagCatalog.data?.tags.length, visibleTagCount]);

  const previewTagReplacement = useCallback(() => {
    previewCloudWrite({
      kind: 'tags',
      itemKey: item.key,
      operation: 'replace',
      tags: tagDraft.split(',').map((tag) => tag.trim()).filter(Boolean),
    });
  }, [item.key, previewCloudWrite, tagDraft]);

  const startCreateNote = useCallback(() => {
    setCloudMessage(null);
    setTagEditorOpen(false);
    setNoteEditor({ mode: 'create', text: '' });
  }, []);

  const startUpdateNote = useCallback((note: ZoteroLibraryNote) => {
    setCloudMessage(null);
    setTagEditorOpen(false);
    setNoteEditor({ mode: 'update', noteKey: note.key, text: plainNoteText(note) });
  }, []);

  const previewNote = useCallback(() => {
    if (!noteEditor) return;
    const html = zoteroNoteHtml(noteEditor.text);
    previewCloudWrite(noteEditor.mode === 'create'
      ? { kind: 'note', operation: 'create', parentItemKey: item.key, html }
      : { kind: 'note', operation: 'update', noteKey: noteEditor.noteKey, html });
  }, [item.key, noteEditor, previewCloudWrite]);

  const previewDeleteNote = useCallback((note: ZoteroLibraryNote) => {
    setCloudMessage(null);
    previewCloudWrite({ kind: 'note', operation: 'delete', noteKey: note.key });
  }, [previewCloudWrite]);

  return (
    <div className="min-w-0 bg-white dark:bg-neutral-950">
      <div className="flex min-w-0 items-start gap-1.5 px-3 py-3">
        <button
          type="button"
          onClick={toggleDetails}
          aria-expanded={expanded}
          aria-controls={`zotero-item-details-${item.key}`}
          aria-label={expanded
            ? t('researchPanel.hideCollectionItemDetails', { defaultValue: 'Hide details for {{title}}', title: itemTitle })
            : t('researchPanel.showCollectionItemDetails', { defaultValue: 'Show details for {{title}}', title: itemTitle })}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
        >
          {expanded ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400" />}
          <Library className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 block text-[12px] font-medium leading-4 text-neutral-800 dark:text-neutral-200">
              {itemTitle}
            </span>
            <span className="mt-1 line-clamp-1 block text-[10px] text-neutral-500 dark:text-neutral-400">
              {[item.creators.slice(0, 2).join(', '), item.year, item.itemType].filter(Boolean).join(' · ')}
            </span>
            {item.tags.length > 0 ? (
              <span className="mt-1 line-clamp-1 block text-[10px] text-neutral-400">{item.tags.slice(0, 4).join(' · ')}</span>
            ) : null}
          </span>
        </button>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            aria-label={t('researchPanel.openCollectionItem', { defaultValue: 'Open {{title}}', title: itemTitle })}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}
      </div>

      {expanded ? (
        <div id={`zotero-item-details-${item.key}`} className="border-t border-neutral-100 px-3 pb-3 pt-2.5 dark:border-neutral-800">
          {detailsState.status === 'loading' ? (
            <div className="flex items-center gap-2 py-2 text-[10px] text-neutral-500">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              {t('researchPanel.loadingItemDetails', { defaultValue: 'Loading item details…' })}
            </div>
          ) : null}
          {detailsState.error ? (
            <div className="mb-2 rounded-md bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
              {detailsState.error}
            </div>
          ) : null}
          {detailsState.status !== 'loading' ? (
            <div className="space-y-3">
              <ZoteroItemMetadata item={detailItem} />
              <ZoteroItemTags tags={detailTags} onEdit={startTagEditor} />
              {tagEditorOpen ? (
                <ZoteroTagEditor
                  value={tagDraft}
                  busy={cloudBusy}
                  catalog={tagCatalog}
                  onChange={setTagDraft}
                  onCancel={() => setTagEditorOpen(false)}
                  onPreview={previewTagReplacement}
                  onAddSuggestion={addTagSuggestion}
                  visibleTagCount={visibleTagCount}
                  onMoreSuggestions={showMoreTagSuggestions}
                />
              ) : null}
              <ZoteroItemNotes
                notes={detailNotes}
                onCreate={startCreateNote}
                onEdit={startUpdateNote}
                onDelete={previewDeleteNote}
              />
              {noteEditor ? (
                <ZoteroNoteEditor
                  editor={noteEditor}
                  busy={cloudBusy}
                  onChange={(text) => setNoteEditor((current) => current ? { ...current, text } : current)}
                  onCancel={() => setNoteEditor(null)}
                  onPreview={previewNote}
                />
              ) : null}
              <ZoteroItemAttachments
                attachments={detailAttachments}
                states={attachmentTextByKey}
                openStates={attachmentOpenByKey}
                onReadFullText={readAttachmentText}
                onOpenFile={openAttachmentFile}
              />
              <ZoteroItemExports
                busyAction={exportAction}
                message={exportMessage}
                onExport={runExport}
              />
              {cloudMessage ? (
                <p className={cn(
                  'text-[10px] leading-4',
                  cloudMessage.kind === 'success' ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300',
                )} role="status">
                  {cloudMessage.text}
                </p>
              ) : null}
              {cloudPlan ? (
                <ZoteroCloudWritePreview
                  plan={cloudPlan}
                  busy={cloudBusy}
                  onCancel={() => setCloudPlan(null)}
                  onConfirm={confirmCloudWrite}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ZoteroItemMetadata({ item }: { item: ZoteroLibraryItem }) {
  const { t } = useTranslation();
  const entries = [
    [t('researchPanel.zoteroMetadataType', { defaultValue: 'Type' }), item.itemType],
    [t('researchPanel.zoteroMetadataAuthors', { defaultValue: 'Authors' }), item.creators.join(', ')],
    [t('researchPanel.zoteroMetadataDate', { defaultValue: 'Date' }), item.date || item.year?.toString()],
    [t('researchPanel.zoteroMetadataDoi', { defaultValue: 'DOI' }), item.doi],
    [t('researchPanel.zoteroMetadataArxiv', { defaultValue: 'arXiv' }), item.arxiv],
    [t('researchPanel.zoteroMetadataPmid', { defaultValue: 'PMID' }), item.pmid],
    [t('researchPanel.zoteroMetadataUrl', { defaultValue: 'URL' }), item.url],
    [t('researchPanel.zoteroMetadataKey', { defaultValue: 'Zotero key' }), item.key],
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()));

  return (
    <section>
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
        {t('researchPanel.zoteroMetadata', { defaultValue: 'Metadata' })}
      </h4>
      <dl className="mt-1.5 grid gap-x-2 gap-y-1 text-[10px] leading-4">
        {entries.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
            <dt className="text-neutral-400">{label}</dt>
            <dd className="break-words text-neutral-600 dark:text-neutral-300">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ZoteroItemTags({ tags, onEdit }: { tags: string[]; onEdit: () => void }) {
  const { t } = useTranslation();
  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
          {t('researchPanel.zoteroTags', { defaultValue: 'Tags' })}
        </h4>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          aria-label={t('researchPanel.editZoteroTags', { defaultValue: 'Edit Zotero tags' })}
          title={t('researchPanel.editZoteroTags', { defaultValue: 'Edit Zotero tags' })}
        >
          <PenLine className="h-3.5 w-3.5" />
        </button>
      </div>
      {tags.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span key={tag} className="rounded-md bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              {tag}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-[10px] text-neutral-400">{t('researchPanel.noZoteroTags', { defaultValue: 'No tags.' })}</p>
      )}
    </section>
  );
}

function ZoteroItemNotes({
  notes,
  onCreate,
  onEdit,
  onDelete,
}: {
  notes: ZoteroLibraryNote[];
  onCreate: () => void;
  onEdit: (note: ZoteroLibraryNote) => void;
  onDelete: (note: ZoteroLibraryNote) => void;
}) {
  const { t } = useTranslation();
  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
          {t('researchPanel.zoteroNotes', { defaultValue: 'Notes' })}
        </h4>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          aria-label={t('researchPanel.addZoteroNote', { defaultValue: 'Add Zotero note' })}
          title={t('researchPanel.addZoteroNote', { defaultValue: 'Add Zotero note' })}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {notes.length > 0 ? (
        <div className="mt-1.5 space-y-1.5">
          {notes.map((note) => {
            const noteText = plainNoteText(note);
            return (
              <details key={note.key} className="rounded-md border border-neutral-200 px-2 py-1.5 text-[10px] dark:border-neutral-800">
                <summary className="cursor-pointer font-medium text-neutral-600 dark:text-neutral-300">
                  {note.title || noteText || t('researchPanel.untitledNote', { defaultValue: 'Untitled note' })}
                </summary>
                <p className="mt-1 whitespace-pre-wrap break-words leading-4 text-neutral-500 dark:text-neutral-400">
                  {noteText || t('researchPanel.emptyNote', { defaultValue: 'This note is empty.' })}
                </p>
                <div className="mt-1.5 flex justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => onEdit(note)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                    aria-label={t('researchPanel.editZoteroNote', { defaultValue: 'Edit Zotero note' })}
                    title={t('researchPanel.editZoteroNote', { defaultValue: 'Edit Zotero note' })}
                  >
                    <PenLine className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(note)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                    aria-label={t('researchPanel.deleteZoteroNote', { defaultValue: 'Delete Zotero note' })}
                    title={t('researchPanel.deleteZoteroNote', { defaultValue: 'Delete Zotero note' })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </details>
            );
          })}
        </div>
      ) : (
        <p className="mt-1 text-[10px] text-neutral-400">{t('researchPanel.noZoteroNotes', { defaultValue: 'No notes.' })}</p>
      )}
    </section>
  );
}

function ZoteroTagEditor({
  value,
  busy,
  catalog,
  onChange,
  onCancel,
  onPreview,
  onAddSuggestion,
  visibleTagCount,
  onMoreSuggestions,
}: {
  value: string;
  busy: boolean;
  catalog: ZoteroTagCatalogState;
  onChange: (value: string) => void;
  onCancel: () => void;
  onPreview: () => void;
  onAddSuggestion: (tag: string) => void;
  visibleTagCount: number;
  onMoreSuggestions: () => void;
}) {
  const { t } = useTranslation();
  const visibleTags = catalog.data?.tags.slice(0, visibleTagCount) ?? [];
  const canShowMore = (catalog.data?.tags.length ?? 0) > visibleTags.length;
  const canLoadMore = catalog.data?.nextStart !== undefined;
  return (
    <section className="rounded-md border border-indigo-200 bg-indigo-50/50 p-2 dark:border-indigo-900/70 dark:bg-indigo-950/20">
      <label className="block text-[10px] font-medium text-neutral-600 dark:text-neutral-300">
        {t('researchPanel.editZoteroTags', { defaultValue: 'Edit Zotero tags' })}
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1.5 h-8 w-full rounded-md border border-neutral-200 bg-white px-2 text-[10px] text-neutral-700 outline-none focus:border-indigo-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          aria-label={t('researchPanel.editZoteroTags', { defaultValue: 'Edit Zotero tags' })}
        />
      </label>
      {catalog.status === 'loading' ? (
        <p className="mt-1.5 flex items-center gap-1 text-[10px] text-neutral-500" role="status">
          <RefreshCw className="h-3 w-3 animate-spin" />
          {t('researchPanel.loadingZoteroTags', { defaultValue: 'Loading saved tags…' })}
        </p>
      ) : null}
      {catalog.error ? (
        <p className="mt-1.5 text-[10px] leading-4 text-amber-700 dark:text-amber-300" role="status">
          {t('researchPanel.zoteroTagsUnavailable', {
            defaultValue: 'Saved tags are unavailable: {{error}}',
            error: catalog.error,
          })}
        </p>
      ) : null}
      {catalog.status === 'ready' && visibleTags.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1" data-testid="zotero-tag-suggestions">
          {visibleTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => onAddSuggestion(tag)}
              disabled={busy}
              className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-indigo-200 bg-white px-1.5 text-[10px] text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-900 dark:bg-neutral-900 dark:text-indigo-300 dark:hover:bg-indigo-950/30"
              aria-label={t('researchPanel.addZoteroTag', { defaultValue: 'Add Zotero tag {{tag}}', tag })}
              title={t('researchPanel.addZoteroTag', { defaultValue: 'Add Zotero tag {{tag}}', tag })}
            >
              <Plus className="h-3 w-3 shrink-0" />
              <span className="truncate">{tag}</span>
            </button>
          ))}
        </div>
      ) : null}
      {catalog.status === 'ready' && (canShowMore || canLoadMore) ? (
        <button
          type="button"
          onClick={onMoreSuggestions}
          disabled={busy || catalog.loadingMore}
          className="mt-1.5 inline-flex h-6 items-center gap-1 text-[10px] font-medium text-indigo-700 hover:underline disabled:opacity-50 dark:text-indigo-300"
        >
          {catalog.loadingMore ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
          {canShowMore
            ? t('researchPanel.showMoreZoteroTags', { defaultValue: 'Show more saved tags' })
            : t('researchPanel.loadMoreZoteroTags', { defaultValue: 'Load more saved tags' })}
        </button>
      ) : null}
      <div className="mt-2 flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} disabled={busy} className="inline-flex h-7 items-center rounded-md border border-neutral-200 px-2 text-[10px] font-medium text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
          {t('researchPanel.cancel', { defaultValue: 'Cancel' })}
        </button>
        <button type="button" onClick={onPreview} disabled={busy} className="inline-flex h-7 items-center rounded-md bg-indigo-600 px-2 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {busy ? <RefreshCw className="h-3 w-3 animate-spin" /> : <PenLine className="h-3 w-3" />}
          {t('researchPanel.previewZoteroChange', { defaultValue: 'Preview change' })}
        </button>
      </div>
    </section>
  );
}

function ZoteroNoteEditor({
  editor,
  busy,
  onChange,
  onCancel,
  onPreview,
}: {
  editor: Exclude<ZoteroNoteEditorState, null>;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onPreview: () => void;
}) {
  const { t } = useTranslation();
  const creating = editor.mode === 'create';
  return (
    <section className="rounded-md border border-indigo-200 bg-indigo-50/50 p-2 dark:border-indigo-900/70 dark:bg-indigo-950/20">
      <label className="block text-[10px] font-medium text-neutral-600 dark:text-neutral-300">
        {creating
          ? t('researchPanel.addZoteroNote', { defaultValue: 'Add Zotero note' })
          : t('researchPanel.editZoteroNote', { defaultValue: 'Edit Zotero note' })}
        <textarea
          value={editor.text}
          onChange={(event) => onChange(event.target.value)}
          rows={5}
          className="mt-1.5 block w-full resize-y rounded-md border border-neutral-200 bg-white p-2 text-[10px] leading-4 text-neutral-700 outline-none focus:border-indigo-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          aria-label={creating
            ? t('researchPanel.addZoteroNote', { defaultValue: 'Add Zotero note' })
            : t('researchPanel.editZoteroNote', { defaultValue: 'Edit Zotero note' })}
        />
      </label>
      <div className="mt-2 flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} disabled={busy} className="inline-flex h-7 items-center rounded-md border border-neutral-200 px-2 text-[10px] font-medium text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
          {t('researchPanel.cancel', { defaultValue: 'Cancel' })}
        </button>
        <button type="button" onClick={onPreview} disabled={busy} className="inline-flex h-7 items-center rounded-md bg-indigo-600 px-2 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {busy ? <RefreshCw className="h-3 w-3 animate-spin" /> : <PenLine className="h-3 w-3" />}
          {t('researchPanel.previewZoteroChange', { defaultValue: 'Preview change' })}
        </button>
      </div>
    </section>
  );
}

function mergeZoteroTagSuggestions(existing: string[], incoming: string[]): string[] {
  const tags = new Map<string, string>();
  for (const tag of [...existing, ...incoming]) {
    const normalized = tag.trim();
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (!tags.has(key)) tags.set(key, normalized);
  }
  return [...tags.values()];
}

function ZoteroCloudWritePreview({
  plan,
  busy,
  onCancel,
  onConfirm,
}: {
  plan: ZoteroCloudWritePlan;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const isTags = plan.kind === 'tags';
  const addedTags = isTags ? (plan.afterTags ?? []).filter((tag) => !(plan.beforeTags ?? []).includes(tag)) : [];
  const removedTags = isTags ? (plan.beforeTags ?? []).filter((tag) => !(plan.afterTags ?? []).includes(tag)) : [];
  const summary = isTags
    ? t('researchPanel.zoteroTagChangeSummary', { defaultValue: 'Replace tags for this item.' })
    : plan.operation === 'create'
      ? t('researchPanel.zoteroCreateNoteSummary', { defaultValue: 'Create a note on this item.' })
      : plan.operation === 'update'
        ? t('researchPanel.zoteroUpdateNoteSummary', { defaultValue: 'Replace the selected Zotero note.' })
        : t('researchPanel.zoteroDeleteNoteSummary', { defaultValue: 'Delete the selected Zotero note.' });
  return (
    <section className="rounded-md border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-900 dark:bg-amber-950/30">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
        <div className="min-w-0 flex-1">
          <h4 className="text-[10px] font-semibold text-amber-900 dark:text-amber-100">
            {t('researchPanel.confirmZoteroCloudChange', { defaultValue: 'Confirm Zotero change' })}
          </h4>
          <p className="mt-1 text-[10px] leading-4 text-amber-800 dark:text-amber-200">{summary}</p>
          {isTags ? (
            <div className="mt-1.5 space-y-1 text-[10px] leading-4">
              {addedTags.length > 0 ? <p className="text-emerald-700 dark:text-emerald-300">+ {addedTags.join(', ')}</p> : null}
              {removedTags.length > 0 ? <p className="text-red-700 dark:text-red-300">- {removedTags.join(', ')}</p> : null}
              {addedTags.length === 0 && removedTags.length === 0 ? <p className="text-neutral-600 dark:text-neutral-300">{t('researchPanel.noZoteroChange', { defaultValue: 'No field changes.' })}</p> : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-2.5 flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} disabled={busy} className="inline-flex h-7 items-center rounded-md border border-amber-300 px-2 text-[10px] font-medium text-amber-900 dark:border-amber-800 dark:text-amber-100">
          {t('researchPanel.cancel', { defaultValue: 'Cancel' })}
        </button>
        <button type="button" onClick={onConfirm} disabled={busy} className="inline-flex h-7 items-center gap-1 rounded-md bg-amber-700 px-2 text-[10px] font-medium text-white hover:bg-amber-600 disabled:opacity-50">
          {busy ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          {t('researchPanel.confirmZoteroCloudChange', { defaultValue: 'Confirm Zotero change' })}
        </button>
      </div>
    </section>
  );
}

function ZoteroItemAttachments({
  attachments,
  states,
  openStates,
  onReadFullText,
  onOpenFile,
}: {
  attachments: ZoteroLibraryAttachment[];
  states: Record<string, ZoteroAttachmentTextState>;
  openStates: Record<string, ZoteroAttachmentOpenState>;
  onReadFullText: (attachment: ZoteroLibraryAttachment) => void;
  onOpenFile: (attachment: ZoteroLibraryAttachment) => void;
}) {
  const { t } = useTranslation();
  return (
    <section>
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
        {t('researchPanel.zoteroAttachments', { defaultValue: 'Attachments' })}
      </h4>
      {attachments.length > 0 ? (
        <div className="mt-1.5 space-y-1.5">
          {attachments.map((attachment) => {
            const state = states[attachment.key] ?? { status: 'idle' };
            const openState = openStates[attachment.key] ?? { status: 'idle' };
            return (
              <div key={attachment.key} className="rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
                <div className="flex min-w-0 items-start gap-1.5">
                  <Paperclip className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] font-medium text-neutral-700 dark:text-neutral-200">{attachment.title || attachment.key}</p>
                    <p className="mt-0.5 text-[10px] text-neutral-400">
                      {[attachment.contentType, attachment.linkMode].filter(Boolean).join(' · ') || t('researchPanel.zoteroAttachment', { defaultValue: 'Attachment' })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onOpenFile(attachment)}
                      disabled={openState.status === 'loading'}
                      className="inline-flex h-6 items-center gap-1 rounded-md border border-neutral-200 px-1.5 text-[10px] font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                      aria-label={t('researchPanel.openAttachmentFile', { defaultValue: 'Open file for {{title}}', title: attachment.title || attachment.key })}
                      title={t('researchPanel.openAttachmentFile', { defaultValue: 'Open file for {{title}}', title: attachment.title || attachment.key })}
                    >
                      {openState.status === 'loading' ? <RefreshCw className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
                      {openState.status === 'loading'
                        ? t('researchPanel.openingAttachment', { defaultValue: 'Opening…' })
                        : t('researchPanel.openAttachment', { defaultValue: 'Open file' })}
                    </button>
                    <button
                      type="button"
                      onClick={() => onReadFullText(attachment)}
                      disabled={state.status === 'loading'}
                      className="inline-flex h-6 items-center gap-1 rounded-md border border-neutral-200 px-1.5 text-[10px] font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                      aria-label={state.status === 'ready' && state.visible
                        ? t('researchPanel.hideAttachmentFullText', { defaultValue: 'Hide full text for {{title}}', title: attachment.title || attachment.key })
                        : t('researchPanel.readAttachmentFullText', { defaultValue: 'Read full text for {{title}}', title: attachment.title || attachment.key })}
                    >
                      {state.status === 'loading' ? <RefreshCw className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
                      {state.status === 'ready' && state.visible
                        ? t('researchPanel.hideFullText', { defaultValue: 'Hide text' })
                        : t('researchPanel.readFullText', { defaultValue: 'Read text' })}
                    </button>
                  </div>
                </div>
                {openState.status === 'opened' ? (
                  <p className="mt-1.5 text-[10px] leading-4 text-emerald-700 dark:text-emerald-300" role="status">
                    {t('researchPanel.attachmentOpened', { defaultValue: 'Local attachment opened.' })}
                  </p>
                ) : null}
                {openState.error ? (
                  <p className="mt-1.5 text-[10px] leading-4 text-amber-700 dark:text-amber-300" role="status">{openState.error}</p>
                ) : null}
                {state.error ? (
                  <p className="mt-1.5 text-[10px] leading-4 text-amber-700 dark:text-amber-300">{state.error}</p>
                ) : null}
                {state.status === 'ready' && state.visible && state.data?.content ? (
                  <div className="mt-2 rounded-md bg-neutral-50 p-2 dark:bg-neutral-900">
                    <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[10px] leading-4 text-neutral-600 dark:text-neutral-300">
                      {state.data.content}
                    </pre>
                    {state.data.truncated ? (
                      <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                        {t('researchPanel.fullTextTruncated', { defaultValue: 'Only indexed text currently available is shown.' })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-1 text-[10px] text-neutral-400">{t('researchPanel.noZoteroAttachments', { defaultValue: 'No attachments.' })}</p>
      )}
    </section>
  );
}

function ZoteroItemExports({
  busyAction,
  message,
  onExport,
}: {
  busyAction: ZoteroExportAction | null;
  message: { kind: 'success' | 'error'; text: string } | null;
  onExport: (format: ZoteroExportFormat, action: 'copy' | 'download') => void;
}) {
  const { t } = useTranslation();
  const buttons: Array<{ format: ZoteroExportFormat; action: 'copy' | 'download'; label: string }> = [
    { format: 'bibtex', action: 'copy', label: t('researchPanel.copyBibtex', { defaultValue: 'Copy BibTeX' }) },
    { format: 'bibtex', action: 'download', label: t('researchPanel.downloadBibtex', { defaultValue: 'Download BibTeX' }) },
    { format: 'csl-json', action: 'copy', label: t('researchPanel.copyCslJson', { defaultValue: 'Copy CSL-JSON' }) },
    { format: 'csl-json', action: 'download', label: t('researchPanel.downloadCslJson', { defaultValue: 'Download CSL-JSON' }) },
  ];

  return (
    <section>
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
        {t('researchPanel.zoteroExports', { defaultValue: 'Citation export' })}
      </h4>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {buttons.map((button) => {
          const action = `${button.format}:${button.action}` as ZoteroExportAction;
          const loading = busyAction === action;
          return (
            <button
              key={action}
              type="button"
              onClick={() => onExport(button.format, button.action)}
              disabled={busyAction !== null}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-neutral-200 px-2 text-[10px] font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              {loading ? <RefreshCw className="h-3 w-3 animate-spin" /> : button.action === 'copy' ? <Copy className="h-3 w-3" /> : <Download className="h-3 w-3" />}
              {button.label}
            </button>
          );
        })}
      </div>
      {message ? (
        <p className={cn(
          'mt-1.5 text-[10px] leading-4',
          message.kind === 'success' ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300',
        )} role="status">
          {message.text}
        </p>
      ) : null}
    </section>
  );
}

function plainNoteText(note: ZoteroLibraryNote): string {
  return plainZoteroHtml(note.text || note.html || '');
}

function plainZoteroHtml(source: string): string {
  return source
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function zoteroNoteHtml(text: string): string {
  const escaped = text
    .trim()
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
  return escaped ? `<p>${escaped.replace(/\r?\n/gu, '<br>')}</p>` : '';
}

function exportFormatName(format: ZoteroExportFormat): string {
  return format === 'bibtex' ? 'BibTeX' : 'CSL-JSON';
}

function exportFilename(item: ZoteroLibraryItem, format: ZoteroExportFormat): string {
  const extension = format === 'bibtex' ? 'bib' : 'json';
  const stem = (item.title || item.key)
    .replace(/[<>:"/\\|?*]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80) || item.key;
  return `${stem}.${extension}`;
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
  seedPaperId,
  onSelectPaper,
  matches,
  sourceNameById,
}: {
  papers: ResearchPaper[];
  selectedPaperId: string | null;
  seedPaperId: string | null;
  onSelectPaper: (paperId: string) => void;
  matches: Map<string, ZoteroPaperMatch>;
  sourceNameById: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
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
            <span className="flex min-w-0 items-start gap-1.5">
              <span className="line-clamp-2 min-w-0 flex-1 text-[12px] font-medium leading-4 text-neutral-800 dark:text-neutral-200">{paper.title}</span>
              {paper.id === seedPaperId ? (
                <span data-testid={`research-paper-seed-${paper.id}`} className="shrink-0 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200">
                  {t('researchPanel.seedBadge', { defaultValue: 'Seed' })}
                </span>
              ) : null}
            </span>
            <span className="mt-1 block text-[10px] text-neutral-500 dark:text-neutral-400">
              {[paper.authors.slice(0, 2).join(', '), paper.year, `${paper.citedByCount} cited`].filter(Boolean).join(' · ')}
            </span>
            <span className="mt-1.5 block min-w-0">
              <PaperSourceBadges paper={paper} sourceNameById={sourceNameById} compact />
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

function mapStateForAction(action: LiteratureMapActionRequest['action']): LiteratureMapPaperState | null {
  if (action === 'mark_core') return 'core';
  if (action === 'mark_relevant') return 'relevant';
  if (action === 'mark_irrelevant') return 'irrelevant';
  if (action === 'exclude') return 'excluded';
  return null;
}

function mapStatusToPaperState(status: ProjectLiteratureMapNodeStatus): LiteratureMapPaperState | null {
  if (status === 'core' || status === 'relevant' || status === 'irrelevant' || status === 'excluded') return status;
  return null;
}

function isLiteratureMapRevisionConflict(error: unknown): boolean {
  return error instanceof Error && /changed elsewhere|revision conflict|revision/iu.test(error.message);
}

function updateMapPaperState(
  current: Record<string, LiteratureMapPaperState[]>,
  paperId: string,
  state: LiteratureMapPaperState,
  enabled: boolean,
): Record<string, LiteratureMapPaperState[]> {
  const previous = current[paperId] ?? [];
  const nextStates = enabled
    ? [...new Set([...previous, state])]
    : previous.filter((candidate) => candidate !== state);
  if (nextStates.length === previous.length && nextStates.every((candidate, index) => candidate === previous[index])) {
    return current;
  }
  if (nextStates.length === 0) {
    const next = { ...current };
    delete next[paperId];
    return next;
  }
  return { ...current, [paperId]: nextStates };
}

function normalizeZoteroCollectionItems(
  items: unknown[],
  retrievedAt: string,
): { papers: ResearchPaper[]; skipped: number } {
  const papers: ResearchPaper[] = [];
  const seenIds = new Set<string>();
  let skipped = 0;
  for (const [index, item] of items.entries()) {
    const paper = normalizeZoteroCollectionItem(item, index + 1, retrievedAt);
    if (!paper || seenIds.has(paper.id)) {
      skipped += 1;
      continue;
    }
    seenIds.add(paper.id);
    papers.push(paper);
  }
  return { papers, skipped };
}

function normalizeZoteroCollectionItem(
  item: unknown,
  rank: number,
  retrievedAt: string,
): ResearchPaper | null {
  if (!isZoteroMapRecord(item)) return null;
  const key = normalizeZoteroMapText(item.key, 512);
  const title = normalizeZoteroMapText(item.title, 4_096);
  if (!key || !title) return null;

  const identitySource = isZoteroMapRecord(item.identity) ? item.identity : {};
  const doi = normalizeZoteroMapText(item.doi, 512) ?? normalizeZoteroMapText(identitySource.doi, 512);
  const arxiv = normalizeZoteroMapText(item.arxiv, 512) ?? normalizeZoteroMapText(identitySource.arxiv, 512);
  const pmid = normalizeZoteroMapText(item.pmid, 512) ?? normalizeZoteroMapText(identitySource.pmid, 512);
  const url = safeExternalUrl(normalizeZoteroMapText(item.url, 4_096));
  const authors = Array.isArray(item.creators)
    ? uniqueZoteroMapText(item.creators, 512, 50)
    : [];
  const year = normalizeZoteroMapYear(item.year);

  return {
    id: `zotero:${key}`,
    identity: {
      zoteroKey: key,
      ...(doi ? { doi } : {}),
      ...(arxiv ? { arxiv } : {}),
      ...(pmid ? { pmid } : {}),
    },
    title,
    authors,
    ...(year !== undefined ? { year } : {}),
    ...(doi ? { doi } : {}),
    ...(url ? { url } : {}),
    citedByCount: 0,
    topics: [],
    referencedWorkIds: [],
    sourceId: 'zotero',
    sourceIds: ['zotero'],
    provenance: [{
      sourceId: 'zotero',
      sourceRecordId: key,
      rank,
      retrievedAt,
    }],
  };
}

function isZoteroMapRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeZoteroMapText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized || normalized.includes('\u0000')) return undefined;
  return normalized.slice(0, maximumLength);
}

function uniqueZoteroMapText(values: unknown[], maximumLength: number, maximumItems: number): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const text = normalizeZoteroMapText(value, maximumLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
    if (normalized.length >= maximumItems) break;
  }
  return normalized;
}

function normalizeZoteroMapYear(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 1
    && value <= 9_999
    ? value
    : undefined;
}

function zoteroMapSyncSuccessText(merged: number, skipped: number, truncated: boolean): string {
  const messages = [`${merged} Zotero item${merged === 1 ? '' : 's'} merged into the project map.`];
  if (skipped > 0) {
    messages.push(`${skipped} collection item${skipped === 1 ? ' was' : 's were'} skipped because ${skipped === 1 ? 'it could' : 'they could'} not be normalized.`);
  }
  if (truncated) messages.push('Zotero returned a partial collection; only the loaded items were merged.');
  return messages.join(' ');
}

function zoteroMapSyncNoMergeText(skipped: number, truncated: boolean): string {
  const messages = ['No Zotero collection items could be normalized; the project map was not changed.'];
  if (skipped > 0) {
    messages.push(`${skipped} collection item${skipped === 1 ? ' was' : 's were'} skipped because ${skipped === 1 ? 'it could' : 'they could'} not be normalized.`);
  }
  if (truncated) messages.push('Zotero returned a partial collection; only the loaded items were retained.');
  return messages.join(' ');
}

function ResearchDirectionPanel({ artifact }: { artifact: ResearchDirectionSeedArtifact }) {
  const { t } = useTranslation();
  const [selectedCandidateId, setSelectedCandidateId] = useState(
    artifact.result.candidateDirections[0]?.id ?? null,
  );
  const candidate = artifact.result.candidateDirections.find((item) => item.id === selectedCandidateId)
    ?? artifact.result.candidateDirections[0]
    ?? null;

  const insertCandidateDraft = () => {
    if (!candidate) return;
    const title = candidate.provisionalTitle.text ?? t('researchPanel.directionNoTitle', { defaultValue: 'No title proposed' });
    const text = [
      '[Research direction candidate]',
      `Candidate: ${candidate.id}`,
      `Summary: ${candidate.summary}`,
      `Provisional title: ${title}`,
      candidate.hypotheses.length > 0
        ? `Hypotheses:\n${candidate.hypotheses.map((item) => `- ${item.statement}`).join('\n')}`
        : null,
      candidate.contributions.length > 0
        ? `Contribution drafts:\n${candidate.contributions.map((item) => `- ${item.statement}`).join('\n')}`
        : null,
      candidate.constraintIds.length > 0 ? `Constraint IDs: ${candidate.constraintIds.join(', ')}` : null,
      'Title confirmation: pending explicit user action',
    ].filter((line): line is string => Boolean(line)).join('\n');
    window.dispatchEvent(new CustomEvent(CHAT_DRAFT_INSERT_EVENT, {
      detail: { text, source: 'research-direction' },
    }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-neutral-50/70 dark:bg-neutral-950" data-testid="research-direction-panel">
      <header className="shrink-0 border-b border-neutral-200 bg-white px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950">
        <p className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
          {t('researchPanel.directionTitle', { defaultValue: 'Research direction candidates / 研究方向候选' })}
        </p>
        <p className="mt-1 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
          {t('researchPanel.directionSubtitle', { defaultValue: 'Traceable starting points from the current conversation. / 来自当前对话的可追溯起点。' })}
        </p>
      </header>

      <section className="shrink-0 border-b border-neutral-200 px-3 py-3 dark:border-neutral-800" aria-labelledby="research-direction-cues">
        <h2 id="research-direction-cues" className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {t('researchPanel.directionCues', { defaultValue: 'Starting cues / 起始线索' })}
        </h2>
        <ul className="mt-2 space-y-1.5">
          {artifact.result.cues.map((cue) => (
            <li key={cue.id} className="text-[11px] leading-4 text-neutral-700 dark:text-neutral-300">
              <span className="font-medium text-neutral-500 dark:text-neutral-400">{cue.kind}</span>
              <span className="mx-1 text-neutral-300 dark:text-neutral-700">/</span>
              {cue.text}
            </li>
          ))}
        </ul>
      </section>

      <section className="min-h-0 flex-1 px-3 py-3" aria-labelledby="research-direction-candidates">
        <div className="flex items-center justify-between gap-2">
          <h2 id="research-direction-candidates" className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {t('researchPanel.directionCandidates', { defaultValue: 'Candidates / 候选方向' })}
          </h2>
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">{artifact.result.candidateDirections.length}</span>
        </div>
        <div className="mt-2 space-y-1.5" role="tablist" aria-label="Research direction candidates / 研究方向候选">
          {artifact.result.candidateDirections.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={item.id === candidate?.id}
              onClick={() => setSelectedCandidateId(item.id)}
              className={cn(
                'flex w-full items-start justify-between gap-2 border px-2.5 py-2 text-left text-[11px] transition',
                item.id === candidate?.id
                  ? 'border-neutral-900 bg-white text-neutral-900 dark:border-neutral-200 dark:bg-neutral-900 dark:text-neutral-100'
                  : 'border-neutral-200 bg-transparent text-neutral-600 hover:bg-white dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900',
              )}
            >
              <span className="min-w-0">
                <span className="block font-medium">{item.id}</span>
                <span className="mt-0.5 block line-clamp-2 leading-4">{item.summary}</span>
              </span>
              <ChevronRight aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            </button>
          ))}
        </div>
      </section>

      {candidate ? (
        <section className="shrink-0 border-t border-neutral-200 bg-white px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950" aria-labelledby="research-direction-detail">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 id="research-direction-detail" className="text-[12px] font-semibold text-neutral-900 dark:text-neutral-100">{candidate.id}</h2>
              <p className="mt-1 text-[11px] leading-4 text-neutral-600 dark:text-neutral-300">{candidate.summary}</p>
            </div>
            <span className="shrink-0 text-[10px] text-amber-700 dark:text-amber-300">
              {candidate.provisionalTitle.status === 'rejected'
                ? t('researchPanel.directionTitleRejected', { defaultValue: 'Title needs revision' })
                : t('researchPanel.directionTitlePending', { defaultValue: 'Provisional / 待确认' })}
            </span>
          </div>
          <p className="mt-2 border-l-2 border-amber-300 pl-2 text-[11px] leading-4 text-neutral-700 dark:border-amber-700 dark:text-neutral-300">
            {candidate.provisionalTitle.text ?? t('researchPanel.directionNoTitle', { defaultValue: 'No title proposed' })}
          </p>
          {candidate.hypotheses.length > 0 ? (
            <div className="mt-3">
              <h3 className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                {t('researchPanel.directionHypotheses', { defaultValue: 'Hypotheses / 假设' })}
              </h3>
              <ul className="mt-1 space-y-1 text-[11px] leading-4 text-neutral-700 dark:text-neutral-300">
                {candidate.hypotheses.map((item) => <li key={item.id}>- {item.statement}</li>)}
              </ul>
            </div>
          ) : null}
          {candidate.contributions.length > 0 ? (
            <div className="mt-3">
              <h3 className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                {t('researchPanel.directionContributions', { defaultValue: 'Contribution drafts / 贡献草案' })}
              </h3>
              <ul className="mt-1 space-y-1 text-[11px] leading-4 text-neutral-700 dark:text-neutral-300">
                {candidate.contributions.map((item) => <li key={item.id}>- {item.statement}</li>)}
              </ul>
            </div>
          ) : null}
          <button
            type="button"
            onClick={insertCandidateDraft}
            className="mt-3 inline-flex h-8 items-center gap-1.5 border border-neutral-300 px-2.5 text-[11px] font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
          >
            <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
            {t('researchPanel.directionJoinConversation', { defaultValue: 'Add to conversation / 加入对话' })}
          </button>
          <p className="mt-2 text-[10px] leading-4 text-neutral-500 dark:text-neutral-500">
            {t('researchPanel.directionConfirmationNote', { defaultValue: 'Project name changes remain unavailable until you explicitly confirm a title. / 项目名变更必须在你明确确认标题后进行。' })}
          </p>
        </section>
      ) : null}
    </div>
  );
}

function ResearchDirectionAssessmentPanel({ artifact }: { artifact: ResearchDirectionAssessmentArtifact }) {
  const { t } = useTranslation();
  const [selectedDirectionId, setSelectedDirectionId] = useState(
    artifact.result.rankedDirectionIds[0] ?? artifact.result.assessments[0]?.directionId ?? null,
  );
  const assessment = artifact.result.assessments.find((item) => item.directionId === selectedDirectionId)
    ?? artifact.result.assessments[0]
    ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-neutral-50/70 dark:bg-neutral-950" data-testid="research-direction-assessment-panel">
      <header className="shrink-0 border-b border-neutral-200 bg-white px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950">
        <p className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
          {t('researchPanel.assessmentTitle')}
        </p>
        <p className="mt-1 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
          {t('researchPanel.assessmentSubtitle')}
        </p>
      </header>

      <section className="shrink-0 border-b border-neutral-200 px-3 py-3 dark:border-neutral-800" aria-labelledby="research-assessment-ranking">
        <div className="flex items-center justify-between gap-2">
          <h2 id="research-assessment-ranking" className="text-[11px] font-semibold text-neutral-600 dark:text-neutral-300">
            {t('researchPanel.assessmentRanking')}
          </h2>
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">{artifact.result.assessments.length}</span>
        </div>
        <div className="mt-2 space-y-1.5" role="tablist" aria-label={t('researchPanel.assessmentRanking')}>
          {artifact.result.assessments.map((item) => (
            <button
              key={item.directionId}
              type="button"
              role="tab"
              aria-selected={item.directionId === assessment?.directionId}
              onClick={() => setSelectedDirectionId(item.directionId)}
              className={cn(
                'grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-2 border px-2.5 py-2 text-left text-[11px] transition',
                item.directionId === assessment?.directionId
                  ? 'border-neutral-900 bg-white text-neutral-900 dark:border-neutral-200 dark:bg-neutral-900 dark:text-neutral-100'
                  : 'border-neutral-200 text-neutral-600 hover:bg-white dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900',
              )}
            >
              <span className="font-semibold">#{item.rank}</span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{item.directionId}</span>
                <span className="mt-0.5 block line-clamp-2 leading-4">{item.summary}</span>
              </span>
              <span className="font-mono text-[10px] tabular-nums">{item.score.total}</span>
            </button>
          ))}
        </div>
      </section>

      {assessment ? (
        <section className="min-h-0 flex-1 px-3 py-3" aria-labelledby="research-assessment-detail">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="research-assessment-detail" className="text-[12px] font-semibold text-neutral-900 dark:text-neutral-100">
                {assessment.summary}
              </h2>
              <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                {t('researchPanel.assessmentScore', { score: assessment.score.total })}
              </p>
            </div>
            <span className={cn('shrink-0 text-[10px] font-medium', directionStatusTone(assessment.minimumViability.status))}>
              {t(`researchPanel.minimumViability.${assessment.minimumViability.status}`)}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden border border-neutral-200 bg-neutral-200 text-[10px] dark:border-neutral-800 dark:bg-neutral-800">
            <DirectionMetric label={t('researchPanel.assessmentEvidence')} value={assessment.score.evidence} />
            <DirectionMetric label={t('researchPanel.assessmentFeasibility')} value={assessment.score.feasibility} />
            <DirectionMetric label={t('researchPanel.assessmentTestability')} value={assessment.score.testability} />
            <DirectionMetric label={t('researchPanel.assessmentGap')} value={assessment.score.gapOpportunity} />
          </div>

          <div className="mt-3 border-l-2 border-amber-300 pl-2 dark:border-amber-700">
            <p className="text-[10px] font-medium text-amber-800 dark:text-amber-200">
              {t(`researchPanel.provisionalTitleStatus.${assessment.provisionalTitle.status}`)}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-neutral-700 dark:text-neutral-300">
              {assessment.provisionalTitle.text ?? t('researchPanel.directionNoTitle')}
            </p>
          </div>

          <DirectionEvidenceList
            title={t('researchPanel.assessmentEvidenceGaps')}
            emptyLabel={t('researchPanel.assessmentNoEvidenceGaps')}
            items={assessment.unmetEvidenceGaps.map((gap) => ({
              id: `${gap.code}:${gap.relatedId ?? gap.hypothesisId ?? gap.caveatId ?? ''}`,
              label: t(`researchPanel.reason.${gap.code}`, { defaultValue: gap.code.replace(/_/g, ' ') }),
              detail: gap.evidenceIds.length > 0
                ? t('researchPanel.assessmentEvidenceCount', { count: gap.evidenceIds.length })
                : undefined,
            }))}
          />
          <DirectionEvidenceList
            title={t('researchPanel.assessmentHypotheses')}
            emptyLabel={t('researchPanel.assessmentNoHypotheses')}
            items={assessment.falsifiableHypotheses.map((hypothesis) => ({
              id: hypothesis.id,
              label: hypothesis.statement,
              detail: t(`researchPanel.hypothesisStatus.${hypothesis.status}`),
            }))}
          />
        </section>
      ) : null}
    </div>
  );
}

function ResearchTitleConfirmationPanel({ artifact }: { artifact: ResearchTitleConfirmationArtifact }) {
  const { t } = useTranslation();
  const { title, confirmation } = artifact.result;
  const ready = confirmation.projectNameUpdate.status === 'ready_for_explicit_project_action';

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-neutral-50/70 dark:bg-neutral-950" data-testid="research-title-confirmation-panel">
      <header className="shrink-0 border-b border-neutral-200 bg-white px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950">
        <p className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
          {t('researchPanel.titleConfirmationTitle')}
        </p>
        <p className="mt-1 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
          {t('researchPanel.titleConfirmationSubtitle')}
        </p>
      </header>
      <section className="px-3 py-3" aria-labelledby="research-title-confirmation-result">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="research-title-confirmation-result" className="text-[11px] font-semibold text-neutral-600 dark:text-neutral-300">
              {artifact.result.directionId}
            </h2>
            <p className="mt-2 border-l-2 border-amber-300 pl-2 text-[12px] leading-5 text-neutral-900 dark:border-amber-700 dark:text-neutral-100">
              {title.text ?? t('researchPanel.directionNoTitle')}
            </p>
          </div>
          <span className={cn('shrink-0 text-[10px] font-medium', confirmation.confirmed ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300')}>
            {t(`researchPanel.titleConfirmationStatus.${confirmation.status}`)}
          </span>
        </div>
        <dl className="mt-4 divide-y divide-neutral-200 border-y border-neutral-200 text-[11px] dark:divide-neutral-800 dark:border-neutral-800">
          <DirectionDefinitionRow label={t('researchPanel.titleEvidence')} value={t('researchPanel.assessmentEvidenceCount', { count: title.evidenceIds.length })} />
          <DirectionDefinitionRow label={t('researchPanel.titleReviewStatus')} value={t(`researchPanel.provisionalTitleStatus.${title.status}`)} />
          <DirectionDefinitionRow
            label={t('researchPanel.projectNameAction')}
            value={ready ? t('researchPanel.projectNameActionReady') : t('researchPanel.projectNameActionNotReady')}
          />
        </dl>
        <p className="mt-3 text-[10px] leading-4 text-neutral-500 dark:text-neutral-400" data-testid="research-title-project-action-note">
          {t('researchPanel.projectNameExplicitNote')}
        </p>
      </section>
    </div>
  );
}

function ResearchDirectionLifecyclePanel({ artifact }: { artifact: ResearchDirectionLifecycleArtifact }) {
  const { t } = useTranslation();
  const state = artifact.state;

  if (!state) {
    return (
      <div className="flex h-full flex-col bg-neutral-50/70 dark:bg-neutral-950" data-testid="research-direction-lifecycle-panel">
        <header className="border-b border-neutral-200 bg-white px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950">
          <p className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">{t('researchPanel.lifecycleTitle')}</p>
        </header>
        <div className="px-3 py-4 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
          {t('researchPanel.lifecycleEmpty')}
        </div>
      </div>
    );
  }

  const selectedAssessment = state.selectedDirectionId
    ? state.assessment?.result.assessments.find((item) => item.directionId === state.selectedDirectionId)
    : undefined;
  const title = state.titleConfirmation?.result.title;
  const completed = state.checklist.completedStageIds.length;
  const total = state.checklist.items.length;
  const projectNameReady = state.checklist.projectNameAction.status === 'ready_for_explicit_project_action';

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-neutral-50/70 dark:bg-neutral-950" data-testid="research-direction-lifecycle-panel">
      <header className="shrink-0 border-b border-neutral-200 bg-white px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">{t('researchPanel.lifecycleTitle')}</p>
            <p className="mt-1 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
              {artifact.operation === 'saved' ? t('researchPanel.lifecycleSaved') : t('researchPanel.lifecycleLoaded')}
            </p>
          </div>
          <span className="shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400">
            {t('researchPanel.lifecycleRevision', { revision: state.revision })}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden bg-neutral-200 dark:bg-neutral-800" aria-hidden="true">
            <div className="h-full bg-emerald-600" style={{ width: `${Math.round((completed / total) * 100)}%` }} />
          </div>
          <span className="shrink-0 text-[10px] tabular-nums text-neutral-500 dark:text-neutral-400">
            {t('researchPanel.lifecycleCompleted', { completed, total })}
          </span>
        </div>
      </header>

      <section className="shrink-0 border-b border-neutral-200 px-3 py-3 dark:border-neutral-800" aria-labelledby="research-lifecycle-selection">
        <h2 id="research-lifecycle-selection" className="text-[11px] font-semibold text-neutral-600 dark:text-neutral-300">
          {t('researchPanel.lifecycleSelectedDirection')}
        </h2>
        <p className="mt-1 text-[12px] leading-5 text-neutral-900 dark:text-neutral-100">
          {selectedAssessment?.summary ?? state.selectedDirectionId ?? t('researchPanel.lifecycleNoSelection')}
        </p>
        {selectedAssessment ? (
          <p className="mt-1 text-[10px] text-neutral-500 dark:text-neutral-400">
            {t('researchPanel.assessmentScore', { score: selectedAssessment.score.total })}
            {' / '}
            {t(`researchPanel.minimumViability.${selectedAssessment.minimumViability.status}`)}
          </p>
        ) : null}
        {title ? (
          <p className="mt-2 border-l-2 border-amber-300 pl-2 text-[11px] leading-4 text-neutral-700 dark:border-amber-700 dark:text-neutral-300">
            {title.text ?? t('researchPanel.directionNoTitle')}
            <span className="ml-1 text-[10px] text-neutral-500 dark:text-neutral-400">
              ({t(`researchPanel.provisionalTitleStatus.${title.status}`)})
            </span>
          </p>
        ) : null}
      </section>

      <section className="min-h-0 flex-1 px-3 py-3" aria-labelledby="research-lifecycle-checklist">
        <div className="flex items-center justify-between gap-2">
          <h2 id="research-lifecycle-checklist" className="text-[11px] font-semibold text-neutral-600 dark:text-neutral-300">
            {t('researchPanel.lifecycleChecklist')}
          </h2>
          <span className={cn('text-[10px] font-medium', directionStatusTone(state.checklist.status))}>
            {t(`researchPanel.lifecycleStatus.${state.checklist.status}`)}
          </span>
        </div>
        <ol className="mt-2 divide-y divide-neutral-200 border-y border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800" data-testid="research-direction-lifecycle-checklist">
          {state.checklist.items.map((item, index) => (
            <li key={item.id} className="grid min-h-10 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 py-2 text-[11px]">
              <span className={cn('flex h-4 w-4 items-center justify-center', directionStatusTone(item.status))}>
                {item.status === 'complete'
                  ? <Check aria-hidden="true" className="h-3.5 w-3.5" />
                  : item.status === 'blocked'
                    ? <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
                    : <span className="font-mono text-[9px] tabular-nums">{index + 1}</span>}
              </span>
              <span className="min-w-0">
                <span className="block leading-4 text-neutral-700 dark:text-neutral-300">
                  {t(`researchPanel.lifecycleStage.${item.id}`)}
                </span>
                {item.reasonCodes.length > 0 ? (
                  <span className="mt-0.5 block truncate text-[9px] text-neutral-400 dark:text-neutral-500">
                    {item.reasonCodes.map((reason) => t(`researchPanel.reason.${reason}`, { defaultValue: reason.replace(/_/g, ' ') })).join(' / ')}
                  </span>
                ) : null}
              </span>
              <span className={cn('shrink-0 text-[9px]', directionStatusTone(item.status))}>
                {t(`researchPanel.lifecycleStageStatus.${item.status}`)}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="shrink-0 border-t border-neutral-200 bg-white px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950" data-testid="research-lifecycle-project-action">
        <div className="flex items-start justify-between gap-3 text-[11px]">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">{t('researchPanel.projectNameAction')}</span>
          <span className={projectNameReady ? 'text-emerald-700 dark:text-emerald-300' : 'text-neutral-500 dark:text-neutral-400'}>
            {projectNameReady ? t('researchPanel.projectNameActionReady') : t('researchPanel.projectNameActionNotReady')}
          </span>
        </div>
        {projectNameReady && state.checklist.projectNameAction.name ? (
          <p className="mt-1 text-[11px] leading-4 text-neutral-900 dark:text-neutral-100">
            {state.checklist.projectNameAction.name}
          </p>
        ) : null}
        <p className="mt-2 text-[10px] leading-4 text-neutral-500 dark:text-neutral-400">
          {t('researchPanel.projectNameExplicitNote')}
        </p>
      </section>
    </div>
  );
}

function DirectionMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-2 bg-white px-2.5 py-2 dark:bg-neutral-950">
      <span className="text-neutral-500 dark:text-neutral-400">{label}</span>
      <span className="font-mono tabular-nums text-neutral-900 dark:text-neutral-100">{value}</span>
    </div>
  );
}

function DirectionEvidenceList({ title, emptyLabel, items }: {
  title: string;
  emptyLabel: string;
  items: Array<{ id: string; label: string; detail?: string }>;
}) {
  return (
    <div className="mt-3">
      <h3 className="text-[10px] font-semibold text-neutral-500 dark:text-neutral-400">{title}</h3>
      {items.length > 0 ? (
        <ul className="mt-1.5 space-y-1.5 text-[11px] leading-4 text-neutral-700 dark:text-neutral-300">
          {items.map((item) => (
            <li key={item.id} className="border-l border-neutral-300 pl-2 dark:border-neutral-700">
              <span className="block">{item.label}</span>
              {item.detail ? <span className="block text-[9px] text-neutral-400 dark:text-neutral-500">{item.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : <p className="mt-1.5 text-[10px] text-neutral-400 dark:text-neutral-500">{emptyLabel}</p>}
    </div>
  );
}

function DirectionDefinitionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-h-10 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-center gap-3 py-2">
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="min-w-0 text-right text-neutral-900 dark:text-neutral-100">{value}</dd>
    </div>
  );
}

function directionStatusTone(status: ResearchDirectionLifecycleStageStatus | 'in_progress' | 'awaiting_title_confirmation' | 'ready_for_explicit_project_name_action' | 'viable'): string {
  if (status === 'complete' || status === 'viable' || status === 'ready_for_explicit_project_name_action') {
    return 'text-emerald-700 dark:text-emerald-300';
  }
  if (status === 'blocked') return 'text-red-700 dark:text-red-300';
  if (status === 'needs_input' || status === 'needs_evidence' || status === 'awaiting_confirmation' || status === 'awaiting_title_confirmation') {
    return 'text-amber-700 dark:text-amber-300';
  }
  return 'text-neutral-500 dark:text-neutral-400';
}

function formatLiteratureChatReference(paper: ResearchPaper): string {
  const identity = paper.identity && typeof paper.identity === 'object' ? paper.identity : {};
  const identifiers = [
    paper.doi ? `DOI: ${singleLineReferenceValue(paper.doi, 256)}` : null,
    typeof identity.arxiv === 'string' ? `arXiv: ${singleLineReferenceValue(identity.arxiv, 256)}` : null,
    typeof identity.openReview === 'string' ? `OpenReview: ${singleLineReferenceValue(identity.openReview, 256)}` : null,
    `Paper ID: ${singleLineReferenceValue(paper.id, 512)}`,
  ].filter((value): value is string => Boolean(value));
  return [
    '[Research paper]',
    `Title: ${singleLineReferenceValue(paper.title, 1_000)}`,
    paper.authors.length > 0 ? `Authors: ${paper.authors.slice(0, 20).map((author) => singleLineReferenceValue(author, 160)).join('; ')}` : null,
    paper.year !== undefined ? `Year: ${paper.year}` : null,
    paper.venue ? `Venue: ${singleLineReferenceValue(paper.venue, 300)}` : null,
    ...identifiers,
  ].filter((value): value is string => Boolean(value)).join('\n');
}

function singleLineReferenceValue(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
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

function resolvedCoverageSourceIds(
  artifact: LiteratureResearchArtifact,
  field: 'requestedSourceIds' | 'successfulSourceIds' | 'failedSourceIds',
): string[] {
  const reported = artifact.coverage[field];
  if (Array.isArray(reported)) return uniqueSourceIds(reported);
  if (field === 'requestedSourceIds') {
    const planned = uniqueSourceIds(artifact.plan.sourceIds);
    return planned.length > 0 ? planned : uniqueSourceIds(artifact.sources.map((source) => source.id));
  }
  if (field === 'successfulSourceIds') {
    return uniqueSourceIds(artifact.sources.filter((source) => source.status === 'ok').map((source) => source.id));
  }
  return uniqueSourceIds(artifact.sources.filter((source) => source.status === 'error').map((source) => source.id));
}

function resolvedUnappliedSourceIds(artifact: LiteratureResearchArtifact): string[] {
  return uniqueSourceIds(artifact.sources
    .filter((source) => source.status === 'disabled')
    .map((source) => source.id));
}

function paperSourceIds(paper: ResearchPaper): string[] {
  return uniqueSourceIds([
    ...(Array.isArray(paper.sourceIds) ? paper.sourceIds : []),
    paper.sourceId,
    ...paperProvenanceEntries(paper).map((entry) => entry.sourceId),
  ]);
}

function paperProvenanceEntries(paper: ResearchPaper): ResearchPaperProvenance[] {
  return (Array.isArray(paper.provenance) ? paper.provenance : []).filter((entry) => (
    Boolean(entry && typeof entry.sourceId === 'string' && entry.sourceId.trim())
  ));
}

function uniqueSourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((sourceId): sourceId is string => (
    typeof sourceId === 'string' && sourceId.trim().length > 0
  )))];
}

function sourceDisplayName(sourceId: string, sourceNameById: ReadonlyMap<string, string>): string {
  const reportedName = sourceNameById.get(sourceId)?.trim();
  if (reportedName) return reportedName;
  if (sourceId.toLocaleLowerCase() === 'openalex') return 'OpenAlex';
  if (sourceId.toLocaleLowerCase() === 'crossref') return 'Crossref';
  if (sourceId.toLocaleLowerCase() === 'arxiv') return 'arXiv';
  return sourceId.replace(/[-_]+/gu, ' ');
}

function sourceRateLimitDetails(source: ResearchSourceStatus, t: TFunction): string[] {
  const rateLimit = source.rateLimit;
  if (!rateLimit) return [];
  return [
    rateLimit.limit !== undefined || rateLimit.remaining !== undefined
      ? t('researchPanel.sourceRateLimitQuota', {
        defaultValue: '{{remaining}} / {{limit}} requests remaining',
        remaining: rateLimit.remaining ?? '—',
        limit: rateLimit.limit ?? '—',
      })
      : null,
    rateLimit.resetSeconds !== undefined
      ? t('researchPanel.sourceRateLimitReset', {
        defaultValue: 'reset in {{seconds}}s',
        seconds: rateLimit.resetSeconds,
      })
      : null,
    rateLimit.retryAfterSeconds !== undefined
      ? t('researchPanel.sourceRateLimitRetry', {
        defaultValue: 'retry after {{seconds}}s',
        seconds: rateLimit.retryAfterSeconds,
      })
      : null,
    rateLimit.costUsd !== undefined
      ? t('researchPanel.sourceRateLimitCost', {
        defaultValue: 'cost ${{amount}}',
        amount: formatResearchUsd(rateLimit.costUsd),
      })
      : null,
    rateLimit.remainingUsd !== undefined
      ? t('researchPanel.sourceRateLimitRemainingUsd', {
        defaultValue: '${{amount}} remaining',
        amount: formatResearchUsd(rateLimit.remainingUsd),
      })
      : null,
  ].filter((detail): detail is string => Boolean(detail));
}

function terminologyKindLabel(kind: ResearchTerminologyCandidate['kind'], t: TFunction): string {
  if (kind === 'observed_keyword') {
    return t('researchPanel.terminologyObservedKeywords', { defaultValue: 'Observed OpenAlex keywords' });
  }
  if (kind === 'observed_topic') {
    return t('researchPanel.terminologyObservedTopics', { defaultValue: 'Observed OpenAlex topics' });
  }
  return t('researchPanel.terminologyAdjacentFields', { defaultValue: 'Taxonomy-adjacent fields' });
}

function terminologyProviderFieldLabel(
  field: ResearchTerminologyCandidate['evidence'][number]['providerField'],
  t: TFunction,
): string {
  if (field === 'keywords') return t('researchPanel.terminologyFieldKeywords', { defaultValue: 'keywords' });
  if (field === 'topics') return t('researchPanel.terminologyFieldTopics', { defaultValue: 'topics' });
  if (field.endsWith('.subfield')) {
    return t('researchPanel.terminologyFieldSubfield', { defaultValue: 'topic taxonomy subfield' });
  }
  return t('researchPanel.terminologyFieldField', { defaultValue: 'topic taxonomy field' });
}

function formatResearchUsd(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}

function isRateLimitedSource(source: ResearchSourceStatus): boolean {
  const detail = `${source.error ?? ''} ${source.coverage ?? ''}`.toLocaleLowerCase();
  return /\brate[ -]?limit|too many requests|\b429\b/u.test(detail);
}

function formatResearchTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
