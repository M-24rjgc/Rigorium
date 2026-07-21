import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, CheckCircle2, FlaskConical, FolderTree, RefreshCw, Save, Search, ServerOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import type {
  ResearchSettings,
  ResearchSettingsSnapshot,
  ZoteroCollection,
  ZoteroCollectionsResult,
  ZoteroStatus,
} from '../../../../research/types';
import type { SettingsProject } from '../../types/types';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

type ResearchSettingsTabProps = {
  projects: SettingsProject[];
};

export default function ResearchSettingsTab({ projects }: ResearchSettingsTabProps) {
  const { t } = useTranslation('settings');
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const projectOptions = useMemo(() => projects.filter((project) => project.fullPath || project.path), [projects]);
  const [projectPath, setProjectPath] = useState(() => projectOptions[0]?.fullPath || projectOptions[0]?.path || '');
  const [snapshot, setSnapshot] = useState<ResearchSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<ResearchSettings | null>(null);
  const [projectOverrideEnabled, setProjectOverrideEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroStatus | null>(null);
  const [checkingZotero, setCheckingZotero] = useState(false);
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [collectionsResult, setCollectionsResult] = useState<ZoteroCollectionsResult | null>(null);
  const [collectionsError, setCollectionsError] = useState<string | null>(null);
  const [collectionFilter, setCollectionFilter] = useState('');

  useEffect(() => {
    if (projectPath || projectOptions.length === 0) return;
    setProjectPath(projectOptions[0]?.fullPath || projectOptions[0]?.path || '');
  }, [projectOptions, projectPath]);

  useEffect(() => {
    setZoteroStatus(null);
    setCollectionsOpen(false);
    setCollectionsResult(null);
    setCollectionsError(null);
    setCollectionFilter('');
  }, [projectPath, scope]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const params = new URLSearchParams();
      if (projectPath) params.set('projectPath', projectPath);
      const response = await authenticatedFetch(`/api/research/settings${params.size ? `?${params}` : ''}`, {
        suppressServerErrorToast: true,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Failed to load research settings.');
      setSnapshot(body as ResearchSettingsSnapshot);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!snapshot) return;
    if (scope === 'global') {
      setDraft(snapshot.global);
      return;
    }
    setDraft(snapshot.projectOverride?.settings ?? snapshot.effective);
    setProjectOverrideEnabled(snapshot.projectOverride?.enabled ?? false);
  }, [scope, snapshot]);

  const save = useCallback(async () => {
    if (!draft) return;
    if (scope === 'project' && !projectPath) {
      setMessage({ kind: 'error', text: t('research.noProject', { defaultValue: 'Select a project first.' }) });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const response = await authenticatedFetch('/api/research/settings', {
        method: 'PUT',
        body: JSON.stringify({
          scope,
          projectPath: projectPath || undefined,
          projectOverrideEnabled,
          settings: draft,
        }),
        suppressServerErrorToast: true,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Failed to save research settings.');
      setSnapshot(body as ResearchSettingsSnapshot);
      setMessage({ kind: 'success', text: t('research.saved', { defaultValue: 'Research settings saved.' }) });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }, [draft, projectOverrideEnabled, projectPath, scope, t]);

  const checkZotero = useCallback(async () => {
    setCheckingZotero(true);
    setZoteroStatus(null);
    try {
      const params = new URLSearchParams();
      if (scope === 'project' && projectPath) params.set('projectPath', projectPath);
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
      setCheckingZotero(false);
    }
  }, [projectPath, scope]);

  const loadCollections = useCallback(async () => {
    setCollectionsOpen(true);
    setCollectionsLoading(true);
    setCollectionsError(null);
    try {
      const params = new URLSearchParams();
      if (scope === 'project' && projectPath) params.set('projectPath', projectPath);
      const response = await authenticatedFetch(`/api/research/zotero/collections${params.size ? `?${params}` : ''}`, {
        suppressServerErrorToast: true,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Failed to load Zotero collections.');
      if (body.available === false) throw new Error(body.error || 'Zotero is unavailable.');
      if (!Array.isArray(body.collections)) throw new Error('Zotero returned an invalid collection list.');
      setCollectionsResult(body as ZoteroCollectionsResult);
    } catch (error) {
      setCollectionsError(error instanceof Error ? error.message : String(error));
    } finally {
      setCollectionsLoading(false);
    }
  }, [projectPath, scope]);

  const visibleCollections = useMemo(() => {
    const collections = collectionsResult?.collections ?? [];
    const query = collectionFilter.trim().toLocaleLowerCase();
    if (!query) return collections;
    return collections.filter((collection) => collection.name.toLocaleLowerCase().includes(query));
  }, [collectionFilter, collectionsResult]);

  const collectionIndex = useMemo(
    () => new Map((collectionsResult?.collections ?? []).flatMap((collection) => (
      collection.key ? [[collection.key, collection] as const] : []
    ))),
    [collectionsResult],
  );

  const bindCollection = useCallback((collection: ZoteroCollection) => {
    if (!collection.key) return;
    setDraft((current) => current ? {
      ...current,
      zotero: {
        ...current.zotero,
        useSelectedCollection: false,
        collectionKey: collection.key ?? null,
        collectionName: collection.name,
      },
    } : current);
  }, []);

  if (loading || !draft) {
    return (
      <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        {t('research.loading', { defaultValue: 'Loading research settings…' })}
      </div>
    );
  }

  const updateSearch = (value: Partial<ResearchSettings['literature']['search']>) => {
    setDraft((current) => current ? {
      ...current,
      literature: { ...current.literature, search: { ...current.literature.search, ...value } },
    } : current);
  };
  const updateBudget = (value: Partial<ResearchSettings['literature']['budget']>) => {
    setDraft((current) => current ? {
      ...current,
      literature: { ...current.literature, budget: { ...current.literature.budget, ...value } },
    } : current);
  };
  const updateMap = (value: Partial<ResearchSettings['literature']['map']>) => {
    setDraft((current) => current ? {
      ...current,
      literature: { ...current.literature, map: { ...current.literature.map, ...value } },
    } : current);
  };
  const updateOpenAlex = (value: Partial<ResearchSettings['literature']['sources']['openalex']>) => {
    setDraft((current) => current ? {
      ...current,
      literature: {
        ...current.literature,
        sources: {
          ...current.literature.sources,
          openalex: { ...current.literature.sources.openalex, ...value },
        },
      },
    } : current);
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('research.scope.title', { defaultValue: 'Configuration scope' })}
        description={t('research.scope.description', { defaultValue: 'Global defaults apply everywhere; project settings override them only for the selected project.' })}
      >
        <SettingsCard className="p-3">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            {(['global', 'project'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setScope(option)}
                className={`rounded-md px-3 py-2 text-xs font-medium transition ${scope === option ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {option === 'global'
                  ? t('research.scope.global', { defaultValue: 'Global defaults' })
                  : t('research.scope.project', { defaultValue: 'Project override' })}
              </button>
            ))}
          </div>
          {scope === 'project' ? (
            <div className="mt-3 space-y-3">
              <select
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              >
                {projectOptions.length === 0 ? <option value="">{t('research.noProjects', { defaultValue: 'No projects available' })}</option> : null}
                {projectOptions.map((project) => {
                  const value = project.fullPath || project.path || '';
                  return <option key={value} value={value}>{project.displayName || project.name}</option>;
                })}
              </select>
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                <div>
                  <div className="text-[13px] font-medium text-foreground">{t('research.scope.enableOverride', { defaultValue: 'Enable project override' })}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{t('research.scope.enableOverrideDescription', { defaultValue: 'When disabled, this project inherits global defaults.' })}</div>
                </div>
                <SettingsToggle
                  checked={projectOverrideEnabled}
                  onChange={setProjectOverrideEnabled}
                  ariaLabel={t('research.scope.enableOverride', { defaultValue: 'Enable project override' })}
                />
              </div>
            </div>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('research.sources.title', { defaultValue: 'Literature sources' })}>
        <SettingsCard divided>
          <SettingsRow
            label="OpenAlex"
            description={t('research.sources.openalexDescription', { defaultValue: 'Real academic metadata, topics, citation counts, and reference links.' })}
          >
            <SettingsToggle
              checked={draft.literature.sources.openalex.enabled}
              onChange={(enabled) => updateOpenAlex({ enabled })}
              ariaLabel="OpenAlex"
            />
          </SettingsRow>
          <SettingsRow
            label={t('research.sources.mailto', { defaultValue: 'OpenAlex contact email' })}
            description={t('research.sources.mailtoDescription', { defaultValue: 'Optional polite-pool identity for OpenAlex requests.' })}
          >
            <Input
              value={draft.literature.sources.openalex.mailto}
              onChange={(event) => updateOpenAlex({ mailto: event.target.value })}
              placeholder="name@example.com"
              className="w-64"
            />
          </SettingsRow>
          <SettingsRow label={t('research.remoteMetadata', { defaultValue: 'Allow remote metadata search' })}>
            <SettingsToggle
              checked={draft.privacy.allowRemoteMetadataSearch}
              onChange={(allowRemoteMetadataSearch) => setDraft((current) => current ? {
                ...current,
                privacy: { ...current.privacy, allowRemoteMetadataSearch },
              } : current)}
              ariaLabel={t('research.remoteMetadata', { defaultValue: 'Allow remote metadata search' })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('research.search.title', { defaultValue: 'Search defaults and budget' })}>
        <SettingsCard divided>
          <SettingsRow label={t('research.search.defaultLimit', { defaultValue: 'Default result count' })}>
            <Input
              type="number"
              min={1}
              max={draft.literature.budget.maxResultsPerSearch}
              value={draft.literature.search.defaultLimit}
              onChange={(event) => updateSearch({ defaultLimit: numberValue(event.target.value, 1) })}
              className="w-28"
            />
          </SettingsRow>
          <SettingsRow label={t('research.search.yearRange', { defaultValue: 'Default year range' })}>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                placeholder="From"
                value={draft.literature.search.fromYear ?? ''}
                onChange={(event) => updateSearch({ fromYear: nullableNumber(event.target.value) })}
                className="w-24"
              />
              <span className="text-muted-foreground">—</span>
              <Input
                type="number"
                placeholder="To"
                value={draft.literature.search.toYear ?? ''}
                onChange={(event) => updateSearch({ toYear: nullableNumber(event.target.value) })}
                className="w-24"
              />
            </div>
          </SettingsRow>
          <SettingsRow label={t('research.search.sort', { defaultValue: 'Default ranking' })}>
            <select
              value={draft.literature.search.sort}
              onChange={(event) => updateSearch({ sort: event.target.value as ResearchSettings['literature']['search']['sort'] })}
              className="h-9 w-44 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value="relevance">{t('research.search.relevance', { defaultValue: 'Relevance' })}</option>
              <option value="cited_by_count">{t('research.search.citations', { defaultValue: 'Citation count' })}</option>
              <option value="publication_date">{t('research.search.newest', { defaultValue: 'Newest first' })}</option>
            </select>
          </SettingsRow>
          <SettingsRow label={t('research.search.maxResults', { defaultValue: 'Maximum results per search' })}>
            <Input
              type="number"
              min={1}
              max={100}
              value={draft.literature.budget.maxResultsPerSearch}
              onChange={(event) => updateBudget({ maxResultsPerSearch: numberValue(event.target.value, 1) })}
              className="w-28"
            />
          </SettingsRow>
          <SettingsRow label={t('research.search.timeout', { defaultValue: 'Request timeout (seconds)' })}>
            <Input
              type="number"
              min={2}
              max={120}
              value={Math.round(draft.literature.budget.requestTimeoutMs / 1000)}
              onChange={(event) => updateBudget({ requestTimeoutMs: numberValue(event.target.value, 2) * 1000 })}
              className="w-28"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('research.map.title', { defaultValue: 'Research panel and map' })}>
        <SettingsCard divided>
          <SettingsRow label={t('research.map.autoOpen', { defaultValue: 'Open panel when results arrive' })}>
            <SettingsToggle checked={draft.literature.map.autoOpen} onChange={(autoOpen) => updateMap({ autoOpen })} ariaLabel="Auto open" />
          </SettingsRow>
          <SettingsRow label={t('research.map.autoUpdate', { defaultValue: 'Update map automatically' })}>
            <SettingsToggle checked={draft.literature.map.autoUpdate} onChange={(autoUpdate) => updateMap({ autoUpdate })} ariaLabel="Auto update" />
          </SettingsRow>
          <SettingsRow
            label={t('research.map.topicEdges', { defaultValue: 'Show shared-topic links' })}
            description={t('research.map.topicEdgesDescription', { defaultValue: 'These links are inferred and visually distinguished from real citations.' })}
          >
            <SettingsToggle checked={draft.literature.map.showTopicEdges} onChange={(showTopicEdges) => updateMap({ showTopicEdges })} ariaLabel="Shared topic links" />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Zotero"
        description={t('research.zotero.description', { defaultValue: 'Rigorium reads Zotero locally and only writes after an explicit confirmation.' })}
      >
        <SettingsCard divided>
          <SettingsRow label={t('research.zotero.enabled', { defaultValue: 'Enable Zotero integration' })}>
            <SettingsToggle
              checked={draft.zotero.enabled}
              onChange={(enabled) => setDraft((current) => current ? { ...current, zotero: { ...current.zotero, enabled } } : current)}
              ariaLabel="Zotero"
            />
          </SettingsRow>
          <SettingsRow label={t('research.zotero.baseUrl', { defaultValue: 'Local endpoint' })}>
            <Input
              value={draft.zotero.baseUrl}
              onChange={(event) => setDraft((current) => current ? {
                ...current,
                zotero: { ...current.zotero, baseUrl: event.target.value },
              } : current)}
              className="w-64 font-mono text-xs"
            />
          </SettingsRow>
          <SettingsRow label={t('research.zotero.selectedCollection', { defaultValue: 'Use the collection selected in Zotero' })}>
            <SettingsToggle
              checked={draft.zotero.useSelectedCollection}
              onChange={(useSelectedCollection) => setDraft((current) => current ? {
                ...current,
                zotero: { ...current.zotero, useSelectedCollection },
              } : current)}
              ariaLabel="Selected Zotero collection"
            />
          </SettingsRow>
          <SettingsRow
            label={t('research.zotero.collectionBinding', { defaultValue: 'Collection binding' })}
            description={draft.zotero.useSelectedCollection
              ? t('research.zotero.followSelection', { defaultValue: 'Follows the current Zotero selection.' })
              : t('research.zotero.fixedCollection', { defaultValue: 'Uses one fixed collection for this scope.' })}
          >
            <div className="flex min-w-0 items-center gap-2 text-sm">
              {!draft.zotero.useSelectedCollection && draft.zotero.collectionKey ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="max-w-64 truncate text-foreground">
                {draft.zotero.useSelectedCollection
                  ? zoteroStatus?.selectedCollection?.name || t('research.zotero.currentSelection', { defaultValue: 'Current Zotero selection' })
                  : draft.zotero.collectionName || t('research.zotero.noCollection', { defaultValue: 'No collection bound' })}
              </span>
            </div>
          </SettingsRow>
        </SettingsCard>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => void checkZotero()} disabled={checkingZotero}>
            {checkingZotero ? <RefreshCw className="animate-spin" /> : <FlaskConical />}
            {t('research.zotero.test', { defaultValue: 'Test Zotero' })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (collectionsOpen) {
                setCollectionsOpen(false);
                return;
              }
              if (collectionsResult) {
                setCollectionsOpen(true);
                return;
              }
              void loadCollections();
            }}
            disabled={collectionsLoading}
          >
            {collectionsLoading ? <RefreshCw className="animate-spin" /> : <FolderTree />}
            {t('research.zotero.browseCollections', { defaultValue: 'Browse collections' })}
          </Button>
          {zoteroStatus ? (
            <div className={`flex min-w-0 items-center gap-1.5 text-xs ${zoteroStatus.connectorReady ? 'text-emerald-600' : 'text-amber-600'}`}>
              {zoteroStatus.connectorReady ? <CheckCircle2 className="h-4 w-4" /> : <ServerOff className="h-4 w-4" />}
              <span className="truncate">
                {zoteroStatus.connectorReady
                  ? t('research.zotero.ready', { defaultValue: 'Ready · {{name}}', name: zoteroStatus.selectedCollection?.name || 'My Library' })
                  : zoteroStatus.error || t('research.zotero.notReady', { defaultValue: 'Zotero is not ready.' })}
              </span>
            </div>
          ) : null}
        </div>
        {collectionsOpen ? (
          <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background">
            <div className="flex items-center gap-2 border-b border-border p-2">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input
                value={collectionFilter}
                onChange={(event) => setCollectionFilter(event.target.value)}
                placeholder={t('research.zotero.filterCollections', { defaultValue: 'Filter collections' })}
                aria-label={t('research.zotero.filterCollections', { defaultValue: 'Filter collections' })}
                className="h-8 border-0 shadow-none focus-visible:ring-0"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void loadCollections()}
                disabled={collectionsLoading}
                aria-label={t('research.zotero.refreshCollections', { defaultValue: 'Refresh collections' })}
                className="h-8 w-8"
              >
                <RefreshCw className={collectionsLoading ? 'animate-spin' : ''} />
              </Button>
            </div>
            {collectionsError ? (
              <div className="px-3 py-4 text-xs text-red-600 dark:text-red-300">{collectionsError}</div>
            ) : visibleCollections.length > 0 ? (
              <div className="max-h-72 divide-y divide-border overflow-y-auto">
                {visibleCollections.map((collection) => {
                  const bound = !draft.zotero.useSelectedCollection && collection.key === draft.zotero.collectionKey;
                  const depth = collectionDepth(collection, collectionIndex);
                  return (
                    <button
                      key={collection.key || `${collection.libraryId ?? 'local'}:${collection.name}`}
                      type="button"
                      onClick={() => bindCollection(collection)}
                      disabled={!collection.key}
                      className={`flex min-h-11 w-full items-center gap-2 pr-3 text-left text-sm transition hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50 ${bound ? 'bg-emerald-50/70 dark:bg-emerald-950/20' : ''}`}
                      style={{ paddingLeft: `${12 + depth * 16}px` }}
                      aria-label={t('research.zotero.bindCollection', { defaultValue: 'Bind {{name}}', name: collection.name })}
                    >
                      <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-foreground">{collection.name}</span>
                      {typeof collection.itemCount === 'number' ? (
                        <span className="shrink-0 text-xs text-muted-foreground">{collection.itemCount}</span>
                      ) : null}
                      {bound ? <Check className="h-4 w-4 shrink-0 text-emerald-600" /> : null}
                    </button>
                  );
                })}
              </div>
            ) : collectionsLoading ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" />
                {t('research.zotero.loadingCollections', { defaultValue: 'Loading collections…' })}
              </div>
            ) : (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t('research.zotero.noCollections', { defaultValue: 'No collections found.' })}
              </div>
            )}
            {collectionsResult?.truncated ? (
              <div className="border-t border-border px-3 py-2 text-[11px] text-amber-600 dark:text-amber-300">
                {t('research.zotero.collectionsTruncated', { defaultValue: 'Only the first {{count}} collections are shown.', count: collectionsResult.collections.length })}
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t('research.citationPrivacy.title', { defaultValue: 'Citation and privacy' })}>
        <SettingsCard divided>
          <SettingsRow label={t('research.citationStyle', { defaultValue: 'Default citation style' })}>
            <select
              value={draft.citation.style}
              onChange={(event) => setDraft((current) => current ? {
                ...current,
                citation: { ...current.citation, style: event.target.value as ResearchSettings['citation']['style'] },
              } : current)}
              className="h-9 w-48 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value="apa">APA</option>
              <option value="chicago-author-date">Chicago Author-Date</option>
              <option value="ieee">IEEE</option>
              <option value="mla">MLA</option>
            </select>
          </SettingsRow>
          <SettingsRow label={t('research.includeDoi', { defaultValue: 'Include DOI when available' })}>
            <SettingsToggle
              checked={draft.citation.includeDoi}
              onChange={(includeDoi) => setDraft((current) => current ? {
                ...current,
                citation: { ...current.citation, includeDoi },
              } : current)}
              ariaLabel="Include DOI"
            />
          </SettingsRow>
          <SettingsRow
            label={t('research.remoteFullText', { defaultValue: 'Allow remote full-text processing' })}
            description={t('research.remoteFullTextDescription', { defaultValue: 'Off by default. Increment one only searches metadata.' })}
          >
            <SettingsToggle
              checked={draft.privacy.allowRemoteFullText}
              onChange={(allowRemoteFullText) => setDraft((current) => current ? {
                ...current,
                privacy: { ...current.privacy, allowRemoteFullText },
              } : current)}
              ariaLabel="Remote full text"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {message ? (
        <div className={`rounded-lg px-3 py-2 text-xs ${message.kind === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'}`}>
          {message.text}
        </div>
      ) : null}

      <div className="flex justify-end gap-2 border-t border-border pt-5">
        <Button variant="outline" onClick={() => void loadSettings()} disabled={saving}>
          <RefreshCw />
          {t('research.reload', { defaultValue: 'Reload' })}
        </Button>
        <Button onClick={() => void save()} disabled={saving || (scope === 'project' && !projectPath)}>
          {saving ? <RefreshCw className="animate-spin" /> : <Save />}
          {t('research.save', { defaultValue: 'Save research settings' })}
        </Button>
      </div>
    </div>
  );
}

function numberValue(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function nullableNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function collectionDepth(collection: ZoteroCollection, index: Map<string, ZoteroCollection>): number {
  let depth = 0;
  let parentKey = collection.parentKey;
  const visited = new Set<string>();
  while (parentKey && depth < 12 && !visited.has(parentKey)) {
    visited.add(parentKey);
    depth += 1;
    parentKey = index.get(parentKey)?.parentKey;
  }
  return depth;
}
