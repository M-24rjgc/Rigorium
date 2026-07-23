import {
  Ban,
  Check,
  CircleDot,
  GitFork,
  MessageSquarePlus,
  Network,
  Pin,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Star,
  Table2,
  Tags,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { ResearchArtifact, ResearchPaper } from '../types';
import {
  LITERATURE_MAP_VIEW_IDS,
  boundedNodePosition,
  buildCitationTree,
  buildLiteratureMapModel,
  filterLiteratureMapModel,
  literatureMapCanvasSize,
  literatureMapNodeRadius,
  shortenLiteratureTitle,
  stableNodePosition,
  type LiteratureMapPoint,
  type LiteratureMapRelation,
  type LiteratureMapRelationKind,
  type LiteratureMapTree,
  type LiteratureMapView,
} from './projections';

export type LiteratureMapAction =
  | 'set_seed'
  | 'mark_core'
  | 'mark_relevant'
  | 'mark_irrelevant'
  | 'exclude'
  | 'favorite'
  | 'add_to_chat';

export type LiteratureMapActionRequest = {
  action: LiteratureMapAction;
  paperId: string;
};

export type LiteratureMapPaperState = 'core' | 'relevant' | 'irrelevant' | 'excluded' | 'favorite';

export type LiteratureMapLabels = {
  network: string;
  topics: string;
  timeline: string;
  tree: string;
  table: string;
  filter: string;
  empty: string;
  noMatches: string;
  noTopics: string;
  noTimeline: string;
  noCitationTree: string;
};

export type LiteratureMapProps = {
  artifact: ResearchArtifact | null | undefined;
  selectedPaperId?: string | null;
  initialView?: LiteratureMapView;
  error?: string | null;
  labels?: Partial<LiteratureMapLabels>;
  pinnedPositions?: Readonly<Record<string, LiteratureMapPoint>>;
  paperStates?: Readonly<Record<string, readonly LiteratureMapPaperState[]>>;
  seedPaperId?: string | null;
  className?: string;
  onSelectPaper?: (paperId: string) => void;
  onPaperAction?: (request: LiteratureMapActionRequest) => void;
  onPinnedPositionChange?: (paperId: string, position: LiteratureMapPoint | null) => void;
};

const DEFAULT_LABELS: LiteratureMapLabels = {
  network: 'Network / 网络',
  topics: 'Topics / 主题',
  timeline: 'Timeline / 时间线',
  tree: 'Tree / 树状',
  table: 'Table / 表格',
  filter: 'Filter papers / 筛选文献',
  empty: 'No literature records are available yet. / 暂无可视化文献记录。',
  noMatches: 'No papers match the current filter. / 没有匹配当前筛选的文献。',
  noTopics: 'No source topics are available. / 没有可用的来源主题。',
  noTimeline: 'No publication years are available. / 没有可用的发表年份。',
  noCitationTree: 'No observed citation links are available. / 没有可用的真实引用关系。',
};

const RELATION_KIND_LABELS: Record<LiteratureMapRelationKind, string> = {
  citation: 'Citation / 引用',
  shared_topic: 'Shared topic (inferred) / 共同主题（推断）',
  topic_similarity: 'Topic similarity (inferred) / 主题相似（推断）',
  bibliographic_coupling: 'Bibliographic coupling (derived) / 文献耦合（派生）',
  co_citation: 'Co-citation (derived) / 共被引（派生）',
};

const RELATION_FILTERS: Array<{ kind: LiteratureMapRelationKind; label: string }> = [
  { kind: 'citation', label: 'Citations / 引用' },
  { kind: 'shared_topic', label: 'Topics / 主题推断' },
  { kind: 'topic_similarity', label: 'Similarity / 主题相似' },
  { kind: 'bibliographic_coupling', label: 'Coupling / 耦合' },
  { kind: 'co_citation', label: 'Co-citation / 共被引' },
];

const ACTIONS: Array<{ action: LiteratureMapAction; label: string; Icon: typeof Pin }> = [
  { action: 'set_seed', label: 'Set seed / 设为种子', Icon: Pin },
  { action: 'mark_core', label: 'Mark core / 标为核心', Icon: CircleDot },
  { action: 'mark_relevant', label: 'Mark relevant / 标为相关', Icon: Check },
  { action: 'mark_irrelevant', label: 'Mark irrelevant / 标为不相关', Icon: X },
  { action: 'exclude', label: 'Exclude / 排除', Icon: Ban },
  { action: 'favorite', label: 'Favorite / 收藏', Icon: Star },
  { action: 'add_to_chat', label: 'Add to chat / 加入对话', Icon: MessageSquarePlus },
];

type RelationVisibility = Record<LiteratureMapRelationKind, boolean>;

type ActiveDrag = {
  paperId: string;
  pointerId: number;
};

export function LiteratureMap({
  artifact,
  selectedPaperId,
  initialView = 'network',
  error,
  labels: labelOverrides,
  pinnedPositions = {},
  paperStates = {},
  seedPaperId,
  className,
  onSelectPaper,
  onPaperAction,
  onPinnedPositionChange,
}: LiteratureMapProps) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const model = useMemo(() => buildLiteratureMapModel(artifact), [artifact]);
  const resolvedSeedPaperId = seedPaperId !== undefined
    ? (seedPaperId && model.nodeById.has(seedPaperId) ? seedPaperId : null)
    : model.seedPaperId;
  const [view, setView] = useState<LiteratureMapView>(initialView);
  const [filter, setFilter] = useState('');
  const [zoom, setZoom] = useState(1);
  const [uncontrolledSelectedPaperId, setUncontrolledSelectedPaperId] = useState<string | null>(null);
  const [localPins, setLocalPins] = useState<Record<string, LiteratureMapPoint>>({});
  const [relationVisibility, setRelationVisibility] = useState<RelationVisibility>({
    citation: true,
    shared_topic: true,
    topic_similarity: true,
    bibliographic_coupling: true,
    co_citation: true,
  });
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  const latestDragPoint = useRef<LiteratureMapPoint | null>(null);
  const dragMoved = useRef(false);
  const suppressNextNodeClick = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const markerId = `literature-map-arrow-${useId().replace(/[^a-z0-9_-]/giu, '')}`;
  const { width: canvasWidth, height: canvasHeight } = literatureMapCanvasSize();

  useEffect(() => {
    setUncontrolledSelectedPaperId(null);
    setLocalPins({});
    setFilter('');
    setZoom(1);
  }, [model.artifactId]);

  const resolvedSelectedPaperId = selectedPaperId !== undefined
    ? (selectedPaperId && model.nodeById.has(selectedPaperId) ? selectedPaperId : null)
    : uncontrolledSelectedPaperId && model.nodeById.has(uncontrolledSelectedPaperId)
      ? uncontrolledSelectedPaperId
      : resolvedSeedPaperId && model.nodeById.has(resolvedSeedPaperId)
        ? resolvedSeedPaperId
        : model.nodes[0]?.id ?? null;
  const selectedNode = resolvedSelectedPaperId ? model.nodeById.get(resolvedSelectedPaperId) ?? null : null;
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visiblePaperIds = useMemo(() => new Set(model.nodes
    .filter((node) => matchesPaperFilter(node.paper, normalizedFilter))
    .map((node) => node.id)), [model.nodes, normalizedFilter]);
  const filteredModel = useMemo(
    () => filterLiteratureMapModel(model, visiblePaperIds),
    [model, visiblePaperIds],
  );
  const relationCountByKind = useMemo(() => countRelations(filteredModel.relations), [filteredModel.relations]);
  const tree = useMemo(
    () => buildCitationTree(filteredModel, resolvedSelectedPaperId),
    [filteredModel, resolvedSelectedPaperId],
  );
  const pinnedById = { ...pinnedPositions, ...localPins };
  const selectedPinned = selectedNode ? pinnedById[selectedNode.id] : undefined;

  const selectPaper = (paperId: string) => {
    setUncontrolledSelectedPaperId(paperId);
    onSelectPaper?.(paperId);
  };

  const viewBox = zoomViewBox(canvasWidth, canvasHeight, zoom);
  const pointerToCanvasPoint = (event: ReactPointerEvent<SVGSVGElement>): LiteratureMapPoint | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return boundedNodePosition({
      x: viewBox.x + ((event.clientX - rect.left) / rect.width) * viewBox.width,
      y: viewBox.y + ((event.clientY - rect.top) / rect.height) * viewBox.height,
    });
  };

  const onNodePointerDown = (event: ReactPointerEvent<SVGGElement>, paperId: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    latestDragPoint.current = null;
    dragMoved.current = false;
    setActiveDrag({ paperId, pointerId: event.pointerId });
  };

  const onNetworkPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    const point = pointerToCanvasPoint(event);
    if (!point) return;
    latestDragPoint.current = point;
    dragMoved.current = true;
    setLocalPins((current) => ({ ...current, [activeDrag.paperId]: point }));
  };

  const finishNodeDrag = () => {
    if (!activeDrag) return;
    suppressNextNodeClick.current = dragMoved.current;
    if (dragMoved.current && latestDragPoint.current) {
      onPinnedPositionChange?.(activeDrag.paperId, latestDragPoint.current);
    }
    setActiveDrag(null);
    latestDragPoint.current = null;
  };

  const unpinSelected = () => {
    if (!selectedNode) return;
    setLocalPins((current) => {
      const next = { ...current };
      delete next[selectedNode.id];
      return next;
    });
    onPinnedPositionChange?.(selectedNode.id, null);
  };

  const emptyMessage = error || (normalizedFilter ? labels.noMatches : labels.empty);
  const hasNoRecords = !artifact || model.nodes.length === 0;

  return (
    <section
      aria-label="Literature map / 文献地图"
      className={`flex h-[clamp(360px,52vh,620px)] min-h-[360px] w-full flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950${className ? ` ${className}` : ''}`}
      data-testid="literature-map"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <div aria-label="Literature map views / 文献地图视图" className="flex min-w-0 items-center gap-1" role="tablist">
          {LITERATURE_MAP_VIEW_IDS.map((viewId) => {
            const Icon = viewIcon(viewId);
            const label = labels[viewId];
            return (
              <button
                key={viewId}
                aria-controls="literature-map-surface"
                aria-selected={view === viewId}
                className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[10px] font-medium ${view === viewId
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                  : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900'}`}
                onClick={() => setView(viewId)}
                role="tab"
                type="button"
              >
                <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
        <label className="relative ml-auto flex min-w-[180px] flex-1 items-center sm:max-w-[280px]">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-neutral-400" />
          <input
            aria-label={labels.filter}
            className="h-7 w-full rounded-md border border-neutral-200 bg-white pl-7 pr-2 text-[11px] text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-indigo-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            onChange={(event) => setFilter(event.target.value)}
            placeholder={labels.filter}
            type="search"
            value={filter}
          />
        </label>
      </div>

      {hasNoRecords || (normalizedFilter && filteredModel.nodes.length === 0) ? (
        <EmptyMapState error={error} message={emptyMessage} />
      ) : (
        <>
          {error ? (
            <p className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[10px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-200 px-3 py-1.5 text-[10px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            <span>{filteredModel.nodes.length} papers / 文献</span>
            <span>{filteredModel.relations.length} relationships / 关系</span>
            {view === 'network' ? (
              <fieldset className="ml-auto flex flex-wrap items-center gap-2" aria-label="Relationship filters / 关系筛选">
                <legend className="sr-only">Relationship filters / 关系筛选</legend>
                <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
                {RELATION_FILTERS.map(({ kind, label }) => (
                  <label key={kind} className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap">
                    <input
                      checked={relationVisibility[kind]}
                      className="h-3 w-3 accent-indigo-600"
                      onChange={(event) => setRelationVisibility((current) => ({ ...current, [kind]: event.target.checked }))}
                      type="checkbox"
                    />
                    <span>{label} ({relationCountByKind[kind]})</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
          {selectedNode && (onPaperAction || selectedPinned) ? (
            <div className="flex shrink-0 items-center gap-1 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
              <p className="min-w-0 flex-1 truncate text-[10px] text-neutral-500 dark:text-neutral-400">
                {shortenLiteratureTitle(selectedNode.paper.title, 72)}
              </p>
              {onPaperAction ? ACTIONS.map(({ action, label, Icon }) => {
                const active = literatureMapActionActive(
                  action,
                  selectedNode.id,
                  resolvedSeedPaperId,
                  paperStates[selectedNode.id] ?? [],
                );
                return (
                  <button
                    key={action}
                    aria-label={label}
                    aria-pressed={active}
                    className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900 ${active
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950/50 dark:text-indigo-200'
                      : 'border-neutral-200 dark:border-neutral-700'}`}
                    onClick={() => onPaperAction({ action, paperId: selectedNode.id })}
                    title={label}
                    type="button"
                  >
                    <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                );
              }) : null}
              {selectedPinned ? (
                <button
                  aria-label="Unpin node / 取消固定节点"
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-neutral-200 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                  onClick={unpinSelected}
                  title="Unpin node / 取消固定节点"
                  type="button"
                >
                  <Pin aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="min-h-0 flex-1" id="literature-map-surface" role="tabpanel">
            {view === 'network' ? (
              <NetworkView
                canvasHeight={canvasHeight}
                canvasWidth={canvasWidth}
                markerId={markerId}
                model={filteredModel}
                onNodePointerDown={onNodePointerDown}
                onNodeClick={(paperId) => {
                  if (suppressNextNodeClick.current) {
                    suppressNextNodeClick.current = false;
                    return;
                  }
                  selectPaper(paperId);
                }}
                onNodeSelect={selectPaper}
                onPointerMove={onNetworkPointerMove}
                onPointerUp={finishNodeDrag}
                pinnedById={pinnedById}
                paperStates={paperStates}
                relationVisibility={relationVisibility}
                selectedPaperId={resolvedSelectedPaperId}
                seedPaperId={resolvedSeedPaperId}
                svgRef={svgRef}
                viewBox={viewBox}
                zoom={zoom}
                onResetZoom={() => setZoom(1)}
                onZoomIn={() => setZoom((value) => Math.min(2.25, Number((value + 0.25).toFixed(2))))}
                onZoomOut={() => setZoom((value) => Math.max(0.75, Number((value - 0.25).toFixed(2))))}
              />
            ) : null}
            {view === 'topics' ? <TopicsView model={filteredModel} onNodeSelect={selectPaper} labels={labels} /> : null}
            {view === 'timeline' ? <TimelineView model={filteredModel} onNodeSelect={selectPaper} labels={labels} /> : null}
            {view === 'tree' ? <TreeView model={filteredModel} onNodeSelect={selectPaper} selectedPaperId={resolvedSelectedPaperId} tree={tree} labels={labels} markerId={markerId} /> : null}
            {view === 'table' ? <TableView model={filteredModel} onNodeSelect={selectPaper} selectedPaperId={resolvedSelectedPaperId} /> : null}
          </div>
        </>
      )}
    </section>
  );
}

function EmptyMapState({ error, message }: { error?: string | null; message: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center" role={error ? 'alert' : 'status'}>
      <Network aria-hidden="true" className="h-7 w-7 text-neutral-300 dark:text-neutral-700" />
      <p className={`max-w-md text-[11px] leading-5 ${error ? 'text-amber-700 dark:text-amber-300' : 'text-neutral-500 dark:text-neutral-400'}`}>
        {message}
      </p>
    </div>
  );
}

function NetworkView({
  canvasHeight,
  canvasWidth,
  markerId,
  model,
  onNodeClick,
  onNodePointerDown,
  onNodeSelect,
  onPointerMove,
  onPointerUp,
  pinnedById,
  paperStates,
  relationVisibility,
  selectedPaperId,
  seedPaperId,
  svgRef,
  viewBox,
  zoom,
  onResetZoom,
  onZoomIn,
  onZoomOut,
}: {
  canvasHeight: number;
  canvasWidth: number;
  markerId: string;
  model: ReturnType<typeof buildLiteratureMapModel>;
  onNodeClick: (paperId: string) => void;
  onNodePointerDown: (event: ReactPointerEvent<SVGGElement>, paperId: string) => void;
  onNodeSelect: (paperId: string) => void;
  onPointerMove: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerUp: () => void;
  pinnedById: Readonly<Record<string, LiteratureMapPoint>>;
  paperStates: Readonly<Record<string, readonly LiteratureMapPaperState[]>>;
  relationVisibility: RelationVisibility;
  selectedPaperId: string | null;
  seedPaperId: string | null;
  svgRef: RefObject<SVGSVGElement>;
  viewBox: { x: number; y: number; width: number; height: number };
  zoom: number;
  onResetZoom: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}) {
  const positions = useMemo(() => new Map(model.nodes.map((node) => [
    node.id,
    pinnedById[node.id] ? boundedNodePosition(pinnedById[node.id]) : stableNodePosition(node.id),
  ] as const)), [model.nodes, pinnedById]);
  const visibleRelations = model.relations.filter((relation) => relationVisibility[relation.kind]);

  return (
    <div className="relative h-full min-h-0 bg-neutral-50/70 dark:bg-neutral-950">
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-neutral-200 bg-white/95 p-1 shadow-sm dark:border-neutral-700 dark:bg-neutral-900/95">
        <button aria-label="Zoom out / 缩小" className="inline-flex h-6 w-6 items-center justify-center rounded text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800" onClick={onZoomOut} title="Zoom out / 缩小" type="button">
          <ZoomOut aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
        <span className="w-9 text-center text-[9px] text-neutral-500" data-testid="literature-map-zoom">{Math.round(zoom * 100)}%</span>
        <button aria-label="Zoom in / 放大" className="inline-flex h-6 w-6 items-center justify-center rounded text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800" onClick={onZoomIn} title="Zoom in / 放大" type="button">
          <ZoomIn aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
        <button aria-label="Reset zoom / 重置缩放" className="inline-flex h-6 w-6 items-center justify-center rounded text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800" onClick={onResetZoom} title="Reset zoom / 重置缩放" type="button">
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>
      <svg
        ref={svgRef}
        aria-label="Literature network / 文献网络"
        className="h-full w-full touch-none"
        data-testid="literature-map-network"
        onPointerCancel={onPointerUp}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="img"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      >
        <defs>
          <marker id={markerId} markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#4f46e5" />
          </marker>
        </defs>
        <rect fill="transparent" height={canvasHeight} width={canvasWidth} x="0" y="0" />
        {visibleRelations.map((relation) => {
          const source = positions.get(relation.source);
          const target = positions.get(relation.target);
          const sourcePaper = model.nodeById.get(relation.source)?.paper;
          const targetPaper = model.nodeById.get(relation.target)?.paper;
          if (!source || !target || !sourcePaper || !targetPaper) return null;
          const endpoints = relation.kind === 'citation'
            ? directedEndpoints(source, target, literatureMapNodeRadius(sourcePaper), literatureMapNodeRadius(targetPaper))
            : { source, target };
          const style = relationStyle(relation);
          return (
            <line
              key={relation.id}
              data-inferred={relation.inferred ? 'true' : 'false'}
              data-relation-kind={relation.kind}
              data-source={relation.source}
              data-target={relation.target}
              data-testid={`literature-map-edge-${relation.id}`}
              markerEnd={relation.kind === 'citation' ? `url(#${markerId})` : undefined}
              opacity={style.opacity}
              stroke={style.stroke}
              strokeDasharray={style.dash}
              strokeWidth={style.width}
              x1={endpoints.source.x}
              x2={endpoints.target.x}
              y1={endpoints.source.y}
              y2={endpoints.target.y}
            >
              <title>{relationTitle(relation)}</title>
            </line>
          );
        })}
        {model.nodes.map((node) => {
          const position = positions.get(node.id)!;
          const radius = literatureMapNodeRadius(node.paper);
          const selected = node.id === selectedPaperId;
          const seeded = node.id === seedPaperId;
          const pinned = Boolean(pinnedById[node.id]);
          const states = paperStates[node.id] ?? [];
          const palette = literatureMapNodePalette(states, selected, seeded);
          return (
            <g
              key={node.id}
              aria-label={node.paper.title}
              className="cursor-grab active:cursor-grabbing"
              data-pinned={pinned ? 'true' : 'false'}
              data-paper-states={states.join(' ')}
              data-seed={seeded ? 'true' : 'false'}
              data-selected={selected ? 'true' : 'false'}
              data-testid={`literature-map-node-${node.id}`}
              onClick={() => onNodeClick(node.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onNodeSelect(node.id);
                }
              }}
              onPointerDown={(event) => onNodePointerDown(event, node.id)}
              role="button"
              tabIndex={0}
              transform={`translate(${position.x}, ${position.y})`}
            >
              <circle fill={palette.halo} opacity={states.includes('excluded') ? '0.45' : '0.95'} r={radius + (selected || seeded ? 5 : 3)} />
              <circle fill={palette.fill} opacity={states.includes('excluded') ? '0.48' : '1'} r={radius} stroke={palette.stroke} strokeDasharray={states.includes('excluded') ? '3 2' : undefined} strokeWidth={selected || seeded ? '2.5' : '2'} />
              {pinned ? <circle cx={radius - 3} cy={-radius + 3} fill="#0f172a" r="3" /> : null}
              {selected || seeded ? (
                <text fill="currentColor" fontSize="11" textAnchor="middle" y={radius + 17}>
                  {shortenLiteratureTitle(node.paper.title, 26)}
                </text>
              ) : null}
              <title>{`${node.paper.title}\n${node.paper.citedByCount} citations`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function TopicsView({
  model,
  onNodeSelect,
  labels,
}: {
  model: ReturnType<typeof buildLiteratureMapModel>;
  onNodeSelect: (paperId: string) => void;
  labels: LiteratureMapLabels;
}) {
  if (model.topics.length === 0) return <ProjectionEmpty icon={Tags} message={labels.noTopics} />;
  return (
    <div className="grid h-full min-h-0 auto-rows-min grid-cols-1 gap-px overflow-y-auto bg-neutral-200 dark:bg-neutral-800 md:grid-cols-2">
      {model.topics.map((topic) => (
        <section key={topic.id} className="min-w-0 bg-white px-3 py-2.5 dark:bg-neutral-950" data-testid={`literature-map-topic-${topic.id}`}>
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="min-w-0 flex-1 truncate text-[12px] font-semibold text-neutral-800 dark:text-neutral-100">{topic.name}</h3>
            <span className="shrink-0 text-[10px] text-neutral-400">{topic.paperIds.length}</span>
          </div>
          {topic.score !== null ? <p className="mt-0.5 text-[10px] text-neutral-400">score {formatScore(topic.score)}</p> : null}
          <div className="mt-2 flex flex-wrap gap-1">
            {topic.paperIds.map((paperId) => {
              const paper = model.nodeById.get(paperId)?.paper;
              if (!paper) return null;
              return (
                <button
                  key={paperId}
                  className="max-w-full truncate rounded border border-neutral-200 px-1.5 py-1 text-left text-[10px] text-neutral-600 hover:border-teal-500 hover:text-teal-700 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-teal-500 dark:hover:text-teal-300"
                  onClick={() => onNodeSelect(paperId)}
                  title={paper.title}
                  type="button"
                >
                  {shortenLiteratureTitle(paper.title, 42)}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function TimelineView({
  model,
  onNodeSelect,
  labels,
}: {
  model: ReturnType<typeof buildLiteratureMapModel>;
  onNodeSelect: (paperId: string) => void;
  labels: LiteratureMapLabels;
}) {
  if (model.timeline.length === 0) return <ProjectionEmpty icon={GitFork} message={labels.noTimeline} />;
  return (
    <div className="h-full min-h-0 overflow-y-auto px-3 py-3">
      <div className="space-y-0">
        {model.timeline.map((bucket) => (
          <section key={bucket.year} className="grid grid-cols-[68px_minmax(0,1fr)] border-l-2 border-teal-600 pb-3 last:pb-0" data-testid={`literature-map-year-${bucket.year}`}>
            <div className="-ml-[9px] flex items-start gap-2 bg-white pr-2 text-[12px] font-semibold text-teal-700 dark:bg-neutral-950 dark:text-teal-300">
              <span aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-teal-600 bg-white dark:bg-neutral-950" />
              <span>{bucket.year}</span>
            </div>
            <div className="min-w-0 space-y-1">
              {bucket.paperIds.map((paperId) => {
                const paper = model.nodeById.get(paperId)?.paper;
                if (!paper) return null;
                return (
                  <button key={paperId} className="block w-full truncate text-left text-[11px] text-neutral-700 hover:text-teal-700 dark:text-neutral-200 dark:hover:text-teal-300" onClick={() => onNodeSelect(paperId)} title={paper.title} type="button">
                    {paper.title}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      {model.undatedPaperIds.length > 0 ? (
        <p className="mt-4 border-t border-neutral-200 pt-2 text-[10px] text-neutral-400 dark:border-neutral-800">
          {model.undatedPaperIds.length} undated papers / 篇无日期文献
        </p>
      ) : null}
    </div>
  );
}

function TreeView({
  model,
  onNodeSelect,
  selectedPaperId,
  tree,
  labels,
  markerId,
}: {
  model: ReturnType<typeof buildLiteratureMapModel>;
  onNodeSelect: (paperId: string) => void;
  selectedPaperId: string | null;
  tree: LiteratureMapTree;
  labels: LiteratureMapLabels;
  markerId: string;
}) {
  const positions = useMemo(() => treePositions(tree), [tree]);
  if (!tree.rootId || tree.nodes.length <= 1) return <ProjectionEmpty icon={GitFork} message={labels.noCitationTree} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <svg aria-label="Citation tree / 引用树" className="min-h-0 flex-1 bg-neutral-50/70 dark:bg-neutral-950" data-testid="literature-map-tree" role="img" viewBox="0 0 800 520">
        <defs>
          <marker id={`${markerId}-tree`} markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#0f766e" />
          </marker>
        </defs>
        {tree.nodes.filter((node) => node.parentId).map((node) => {
          const parent = node.parentId ? positions.get(node.parentId) : undefined;
          const child = positions.get(node.paperId);
          if (!parent || !child) return null;
          const forward = node.direction === 'references';
          return (
            <line
              key={`${node.parentId}:${node.paperId}`}
              markerEnd={`url(#${markerId}-tree)`}
              stroke={forward ? '#4f46e5' : '#0f766e'}
              strokeWidth="1.7"
              x1={forward ? parent.x : child.x}
              x2={forward ? child.x : parent.x}
              y1={forward ? parent.y : child.y}
              y2={forward ? child.y : parent.y}
            >
              <title>{forward ? 'References / 引用文献' : 'Cited by / 被引用'}</title>
            </line>
          );
        })}
        {tree.nodes.map((node) => {
          const point = positions.get(node.paperId);
          const paper = model.nodeById.get(node.paperId)?.paper;
          if (!point || !paper) return null;
          const selected = node.paperId === selectedPaperId;
          const root = node.direction === 'root';
          return (
            <g
              key={node.paperId}
              aria-label={paper.title}
              className="cursor-pointer"
              data-testid={`literature-map-tree-node-${node.paperId}`}
              onClick={() => onNodeSelect(node.paperId)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onNodeSelect(node.paperId);
              }}
              role="button"
              tabIndex={0}
              transform={`translate(${point.x}, ${point.y})`}
            >
              <circle fill={selected ? '#4f46e5' : root ? '#d97706' : node.direction === 'references' ? '#6366f1' : '#0f766e'} r={root || selected ? 13 : 10} stroke="white" strokeWidth="2" />
              {root || selected ? <text fill="currentColor" fontSize="10" textAnchor="middle" y="28">{shortenLiteratureTitle(paper.title, 20)}</text> : null}
              <title>{paper.title}</title>
            </g>
          );
        })}
      </svg>
      {tree.unconnectedPaperIds.length > 0 ? (
        <div className="shrink-0 border-t border-neutral-200 px-3 py-1.5 text-[10px] text-neutral-400 dark:border-neutral-800">
          {tree.unconnectedPaperIds.length} unconnected papers / 篇未连接文献
        </div>
      ) : null}
    </div>
  );
}

function TableView({
  model,
  onNodeSelect,
  selectedPaperId,
}: {
  model: ReturnType<typeof buildLiteratureMapModel>;
  onNodeSelect: (paperId: string) => void;
  selectedPaperId: string | null;
}) {
  const [sortBy, setSortBy] = useState<'title' | 'year' | 'cited'>('cited');
  const sortedNodes = useMemo(() => [...model.nodes].sort((left, right) => {
    if (sortBy === 'title') return left.paper.title.localeCompare(right.paper.title);
    if (sortBy === 'year') return (right.year ?? -Infinity) - (left.year ?? -Infinity) || left.paper.title.localeCompare(right.paper.title);
    return right.paper.citedByCount - left.paper.citedByCount || left.paper.title.localeCompare(right.paper.title);
  }), [model.nodes, sortBy]);
  return (
    <div className="h-full min-h-0 overflow-auto">
      <table className="w-full min-w-[560px] border-collapse text-left text-[11px]">
        <thead className="sticky top-0 z-10 bg-neutral-50 text-[10px] text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
          <tr>
            <SortableHeading active={sortBy === 'title'} label="Title / 标题" onClick={() => setSortBy('title')} />
            <SortableHeading active={sortBy === 'year'} label="Year / 年份" onClick={() => setSortBy('year')} />
            <SortableHeading active={sortBy === 'cited'} label="Cited / 被引" onClick={() => setSortBy('cited')} />
            <th className="px-3 py-2 font-medium">Topics / 主题</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
          {sortedNodes.map((node) => (
            <tr key={node.id} className={node.id === selectedPaperId ? 'bg-indigo-50/70 dark:bg-indigo-950/20' : 'hover:bg-neutral-50 dark:hover:bg-neutral-900'} data-testid={`literature-map-row-${node.id}`}>
              <td className="max-w-[320px] px-3 py-2">
                <button className="block w-full truncate text-left font-medium text-neutral-800 hover:text-indigo-700 dark:text-neutral-100 dark:hover:text-indigo-300" onClick={() => onNodeSelect(node.id)} title={node.paper.title} type="button">
                  {node.paper.title}
                </button>
                <p className="mt-0.5 truncate text-[10px] text-neutral-400">{node.paper.authors.slice(0, 2).join(', ')}</p>
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-neutral-600 dark:text-neutral-300">{node.year ?? 'Unknown / 未知'}</td>
              <td className="whitespace-nowrap px-3 py-2 text-neutral-600 dark:text-neutral-300">{node.paper.citedByCount.toLocaleString()}</td>
              <td className="max-w-[220px] px-3 py-2 text-neutral-500 dark:text-neutral-400">{node.paper.topics.slice(0, 3).map((topic) => topic.name).join(', ') || 'None / 无'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortableHeading({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <th className="px-3 py-2 font-medium">
      <button className={`inline-flex items-center gap-1 ${active ? 'text-indigo-700 dark:text-indigo-300' : 'hover:text-neutral-800 dark:hover:text-neutral-100'}`} onClick={onClick} type="button">
        {label}
      </button>
    </th>
  );
}

function ProjectionEmpty({ icon: Icon, message }: { icon: typeof Network; message: string }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center px-6 text-center">
      <div className="max-w-sm">
        <Icon aria-hidden="true" className="mx-auto h-6 w-6 text-neutral-300 dark:text-neutral-700" />
        <p className="mt-2 text-[11px] leading-5 text-neutral-500 dark:text-neutral-400">{message}</p>
      </div>
    </div>
  );
}

function viewIcon(view: LiteratureMapView): typeof Network {
  if (view === 'topics') return Tags;
  if (view === 'timeline') return GitFork;
  if (view === 'tree') return GitFork;
  if (view === 'table') return Table2;
  return Network;
}

function literatureMapActionActive(
  action: LiteratureMapAction,
  paperId: string,
  seedPaperId: string | null,
  states: readonly LiteratureMapPaperState[],
): boolean {
  if (action === 'set_seed') return paperId === seedPaperId;
  if (action === 'mark_core') return states.includes('core');
  if (action === 'mark_relevant') return states.includes('relevant');
  if (action === 'mark_irrelevant') return states.includes('irrelevant');
  if (action === 'exclude') return states.includes('excluded');
  if (action === 'favorite') return states.includes('favorite');
  return false;
}

function literatureMapNodePalette(
  states: readonly LiteratureMapPaperState[],
  selected: boolean,
  seeded: boolean,
): { fill: string; halo: string; stroke: string } {
  if (selected) return { fill: '#4f46e5', halo: '#c7d2fe', stroke: '#312e81' };
  if (seeded) return { fill: '#d97706', halo: '#fef3c7', stroke: '#92400e' };
  if (states.includes('core')) return { fill: '#be123c', halo: '#ffe4e6', stroke: '#881337' };
  if (states.includes('relevant')) return { fill: '#047857', halo: '#d1fae5', stroke: '#064e3b' };
  if (states.includes('irrelevant') || states.includes('excluded')) {
    return { fill: '#737373', halo: '#e5e5e5', stroke: '#404040' };
  }
  return { fill: '#0f766e', halo: '#e5e7eb', stroke: '#ffffff' };
}

function matchesPaperFilter(paper: ResearchPaper, filter: string): boolean {
  if (!filter) return true;
  const searchable = [
    paper.title,
    ...paper.authors,
    paper.year?.toString(),
    paper.venue,
    paper.doi,
    ...paper.topics.map((topic) => topic.name),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
  return searchable.includes(filter);
}

function countRelations(relations: LiteratureMapRelation[]): Record<LiteratureMapRelationKind, number> {
  const count: Record<LiteratureMapRelationKind, number> = {
    citation: 0,
    shared_topic: 0,
    topic_similarity: 0,
    bibliographic_coupling: 0,
    co_citation: 0,
  };
  for (const relation of relations) count[relation.kind] += 1;
  return count;
}

function relationStyle(relation: LiteratureMapRelation): { stroke: string; width: number; dash?: string; opacity: number } {
  if (relation.kind === 'citation') return { stroke: '#4f46e5', width: 1.8, opacity: 0.86 };
  if (relation.kind === 'shared_topic') return { stroke: '#0f766e', width: 1.25, dash: '5 4', opacity: 0.62 };
  if (relation.kind === 'topic_similarity') return { stroke: '#be123c', width: 1.1 + Math.min(relation.weight, 1) * 0.8, dash: '1 5', opacity: 0.64 };
  if (relation.kind === 'bibliographic_coupling') return { stroke: '#d97706', width: 1.2 + Math.min(relation.weight, 3) * 0.25, dash: '2 4', opacity: 0.66 };
  return { stroke: '#0284c7', width: 1.2 + Math.min(relation.weight, 3) * 0.25, dash: '7 3', opacity: 0.66 };
}

function relationTitle(relation: LiteratureMapRelation): string {
  const evidence = relation.evidence.length > 0 ? `\nEvidence: ${relation.evidence.join(', ')}` : '';
  return `${RELATION_KIND_LABELS[relation.kind]}${evidence}`;
}

function directedEndpoints(
  source: LiteratureMapPoint,
  target: LiteratureMapPoint,
  sourceRadius: number,
  targetRadius: number,
): { source: LiteratureMapPoint; target: LiteratureMapPoint } {
  const distance = Math.hypot(target.x - source.x, target.y - source.y);
  if (!Number.isFinite(distance) || distance < 1) return { source, target };
  const unitX = (target.x - source.x) / distance;
  const unitY = (target.y - source.y) / distance;
  return {
    source: { x: source.x + unitX * Math.min(sourceRadius, distance / 2), y: source.y + unitY * Math.min(sourceRadius, distance / 2) },
    target: { x: target.x - unitX * Math.min(targetRadius + 7, distance / 2), y: target.y - unitY * Math.min(targetRadius + 7, distance / 2) },
  };
}

function zoomViewBox(width: number, height: number, zoom: number): { x: number; y: number; width: number; height: number } {
  const nextWidth = width / zoom;
  const nextHeight = height / zoom;
  return {
    x: (width - nextWidth) / 2,
    y: (height - nextHeight) / 2,
    width: nextWidth,
    height: nextHeight,
  };
}

function treePositions(tree: LiteratureMapTree): Map<string, LiteratureMapPoint> {
  const byDepth = new Map<number, typeof tree.nodes>();
  for (const node of tree.nodes) {
    const level = byDepth.get(node.depth) ?? [];
    level.push(node);
    byDepth.set(node.depth, level);
  }
  const positions = new Map<string, LiteratureMapPoint>();
  for (const [depth, level] of byDepth) {
    level.forEach((node, index) => {
      positions.set(node.paperId, {
        x: 70 + Math.min(depth, 4) * 170,
        y: ((index + 1) * 520) / (level.length + 1),
      });
    });
  }
  return positions;
}

function formatScore(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default LiteratureMap;
