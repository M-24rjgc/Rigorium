import type { ResearchArtifact, ResearchPaper } from '../types';

export const LITERATURE_MAP_VIEW_IDS = ['network', 'topics', 'timeline', 'tree', 'table'] as const;

export type LiteratureMapView = (typeof LITERATURE_MAP_VIEW_IDS)[number];

export type LiteratureMapRelationKind =
  | 'citation'
  | 'shared_topic'
  | 'topic_similarity'
  | 'bibliographic_coupling'
  | 'co_citation';

export type LiteratureMapRelationProvenance =
  | 'artifact_edge'
  | 'referenced_work_ids'
  | 'derived_topic_similarity'
  | 'derived_bibliographic_coupling'
  | 'derived_co_citation';

export type LiteratureMapRelation = {
  id: string;
  source: string;
  target: string;
  kind: LiteratureMapRelationKind;
  inferred: boolean;
  weight: number;
  evidence: string[];
  provenance: LiteratureMapRelationProvenance;
};

export type LiteratureMapNode = {
  id: string;
  paper: ResearchPaper;
  year: number | null;
};

export type LiteratureMapTopic = {
  id: string;
  name: string;
  score: number | null;
  paperIds: string[];
};

export type LiteratureMapTimelineBucket = {
  year: number;
  paperIds: string[];
};

export type LiteratureMapModel = {
  artifactId: string | null;
  seedPaperId: string | null;
  nodes: LiteratureMapNode[];
  nodeById: ReadonlyMap<string, LiteratureMapNode>;
  relations: LiteratureMapRelation[];
  topics: LiteratureMapTopic[];
  timeline: LiteratureMapTimelineBucket[];
  undatedPaperIds: string[];
};

export type LiteratureMapPoint = { x: number; y: number };

export type LiteratureMapTreeNode = {
  paperId: string;
  parentId: string | null;
  depth: number;
  direction: 'root' | 'references' | 'cited_by';
  relationId?: string;
};

export type LiteratureMapTree = {
  rootId: string | null;
  nodes: LiteratureMapTreeNode[];
  unconnectedPaperIds: string[];
};

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 520;

type LiteratureMapArtifact = Extract<ResearchArtifact, {
  kind: 'literature_search' | 'literature_expansion';
}>;

/**
 * Converts persisted research records into UI-only projections. It never
 * reaches outside the artifact: every inferred relation has explicit local
 * evidence and every citation keeps its source direction.
 */
export function buildLiteratureMapModel(artifact: ResearchArtifact | null | undefined): LiteratureMapModel {
  const literatureArtifact = isLiteratureMapArtifact(artifact) ? artifact : undefined;
  const papers = literatureArtifact?.papers ?? [];
  const nodes = papers.map((paper) => ({
    id: paper.id,
    paper,
    year: researchPaperYear(paper),
  }));
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const relationByKey = new Map<string, LiteratureMapRelation>();

  for (const edge of literatureArtifact?.edges ?? []) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) continue;
    const kind = artifactRelationKind(edge.type);
    if (!kind) continue;
    upsertRelation(relationByKey, {
      id: `artifact:${edge.id}`,
      source: edge.source,
      target: edge.target,
      kind,
      inferred: kind !== 'citation' || edge.inferred,
      weight: finitePositive(edge.weight, 1),
      evidence: uniqueStrings(edge.evidence),
      provenance: 'artifact_edge',
    });
  }

  const papersByReferenceId = new Map<string, string[]>();
  const coCitationEvidence = new Map<string, { source: string; target: string; citingPaperIds: string[] }>();

  for (const node of nodes) {
    const referenceIds = uniqueStrings(node.paper.referencedWorkIds);
    const localReferences = referenceIds.filter((referenceId) => nodeById.has(referenceId) && referenceId !== node.id);

    for (const referenceId of referenceIds) {
      const citingPapers = papersByReferenceId.get(referenceId) ?? [];
      citingPapers.push(node.id);
      papersByReferenceId.set(referenceId, citingPapers);
    }

    for (const referenceId of localReferences) {
      upsertRelation(relationByKey, {
        id: `reference:${node.id}:${referenceId}`,
        source: node.id,
        target: referenceId,
        kind: 'citation',
        inferred: false,
        weight: 1,
        evidence: ['referencedWorkIds'],
        provenance: 'referenced_work_ids',
      });
    }

    forEachPair(localReferences, (first, second) => {
      const [source, target] = first.localeCompare(second) <= 0 ? [first, second] : [second, first];
      const key = undirectedKey('co_citation', source, target);
      const existing = coCitationEvidence.get(key) ?? { source, target, citingPaperIds: [] };
      existing.citingPaperIds.push(node.id);
      coCitationEvidence.set(key, existing);
    });
  }

  for (const relation of deriveTopicSimilarityRelations(nodes, relationByKey)) {
    upsertRelation(relationByKey, relation);
  }

  for (const [referenceId, paperIds] of papersByReferenceId) {
    forEachPair(uniqueStrings(paperIds), (first, second) => {
      const key = undirectedKey('bibliographic_coupling', first, second);
      const existing = relationByKey.get(key);
      if (existing) {
        existing.weight += 1;
        existing.evidence = uniqueStrings([...existing.evidence, referenceId]);
        return;
      }
      relationByKey.set(key, {
        id: `coupling:${first}:${second}`,
        source: first,
        target: second,
        kind: 'bibliographic_coupling',
        inferred: true,
        weight: 1,
        evidence: [referenceId],
        provenance: 'derived_bibliographic_coupling',
      });
    });
  }

  for (const [key, coCitation] of coCitationEvidence) {
    const { source, target, citingPaperIds } = coCitation;
    relationByKey.set(key, {
      id: `co-citation:${source}:${target}`,
      source,
      target,
      kind: 'co_citation',
      inferred: true,
      weight: citingPaperIds.length,
      evidence: uniqueStrings(citingPaperIds),
      provenance: 'derived_co_citation',
    });
  }

  return {
    artifactId: literatureArtifact?.artifactId ?? null,
    seedPaperId: literatureArtifact?.kind === 'literature_expansion' ? literatureArtifact.seedPaperId : null,
    nodes,
    nodeById,
    relations: [...relationByKey.values()].sort(compareRelations),
    topics: projectTopics(nodes),
    timeline: projectTimeline(nodes),
    undatedPaperIds: nodes.filter((node) => node.year === null).map((node) => node.id),
  };
}

function isLiteratureMapArtifact(
  artifact: ResearchArtifact | null | undefined,
): artifact is LiteratureMapArtifact {
  return artifact?.kind === 'literature_search' || artifact?.kind === 'literature_expansion';
}

function artifactRelationKind(type: string): LiteratureMapRelationKind | undefined {
  if (type === 'citation' || type === 'shared_topic' || type === 'topic_similarity') return type;
  return undefined;
}

export function filterLiteratureMapModel(
  model: LiteratureMapModel,
  visiblePaperIds: ReadonlySet<string>,
): LiteratureMapModel {
  const nodes = model.nodes.filter((node) => visiblePaperIds.has(node.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  return {
    ...model,
    nodes,
    nodeById,
    relations: model.relations.filter((relation) => (
      nodeById.has(relation.source) && nodeById.has(relation.target)
    )),
    topics: model.topics
      .map((topic) => ({ ...topic, paperIds: topic.paperIds.filter((paperId) => nodeById.has(paperId)) }))
      .filter((topic) => topic.paperIds.length > 0),
    timeline: model.timeline
      .map((bucket) => ({ ...bucket, paperIds: bucket.paperIds.filter((paperId) => nodeById.has(paperId)) }))
      .filter((bucket) => bucket.paperIds.length > 0),
    undatedPaperIds: model.undatedPaperIds.filter((paperId) => nodeById.has(paperId)),
  };
}

/** A deterministic hash layout that does not move existing nodes when data grows. */
export function stableNodePosition(paperId: string): LiteratureMapPoint {
  const primary = hashText(paperId);
  const secondary = hashText(`${paperId}:secondary`);
  return {
    x: 58 + (primary % (CANVAS_WIDTH - 116)),
    y: 52 + (secondary % (CANVAS_HEIGHT - 104)),
  };
}

export function boundedNodePosition(position: LiteratureMapPoint): LiteratureMapPoint {
  return {
    x: clamp(position.x, 28, CANVAS_WIDTH - 28),
    y: clamp(position.y, 28, CANVAS_HEIGHT - 28),
  };
}

export function literatureMapCanvasSize(): { width: number; height: number } {
  return { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
}

export function literatureMapNodeRadius(paper: ResearchPaper): number {
  return clamp(8 + Math.log10(Math.max(0, paper.citedByCount) + 1) * 2.4, 8, 16);
}

/**
 * A tree is a projection of only observed citation directions. Inferred topic,
 * coupling, and co-citation links are intentionally not allowed into it.
 */
export function buildCitationTree(
  model: LiteratureMapModel,
  requestedRootId: string | null | undefined,
  maximumDepth = 4,
): LiteratureMapTree {
  const rootId = requestedRootId && model.nodeById.has(requestedRootId)
    ? requestedRootId
    : model.seedPaperId && model.nodeById.has(model.seedPaperId)
      ? model.seedPaperId
      : model.nodes[0]?.id ?? null;
  if (!rootId) return { rootId: null, nodes: [], unconnectedPaperIds: [] };

  const neighbors = new Map<string, Array<{
    paperId: string;
    direction: 'references' | 'cited_by';
    relationId: string;
  }>>();
  for (const relation of model.relations) {
    if (relation.kind !== 'citation' || relation.inferred) continue;
    addNeighbor(neighbors, relation.source, {
      paperId: relation.target,
      direction: 'references',
      relationId: relation.id,
    });
    addNeighbor(neighbors, relation.target, {
      paperId: relation.source,
      direction: 'cited_by',
      relationId: relation.id,
    });
  }

  const nodes: LiteratureMapTreeNode[] = [{
    paperId: rootId,
    parentId: null,
    depth: 0,
    direction: 'root',
  }];
  const visited = new Set([rootId]);
  for (let cursor = 0; cursor < nodes.length; cursor += 1) {
    const current = nodes[cursor];
    if (current.depth >= maximumDepth) continue;
    const orderedNeighbors = [...(neighbors.get(current.paperId) ?? [])]
      .sort((left, right) => comparePaperIds(model, left.paperId, right.paperId));
    for (const neighbor of orderedNeighbors) {
      if (visited.has(neighbor.paperId)) continue;
      visited.add(neighbor.paperId);
      nodes.push({
        paperId: neighbor.paperId,
        parentId: current.paperId,
        depth: current.depth + 1,
        direction: neighbor.direction,
        relationId: neighbor.relationId,
      });
    }
  }

  return {
    rootId,
    nodes,
    unconnectedPaperIds: model.nodes
      .map((node) => node.id)
      .filter((paperId) => !visited.has(paperId)),
  };
}

export function shortenLiteratureTitle(title: string, maximumLength: number): string {
  if (title.length <= maximumLength) return title;
  return `${title.slice(0, Math.max(1, maximumLength - 1))}\u2026`;
}

function upsertRelation(
  relationByKey: Map<string, LiteratureMapRelation>,
  relation: LiteratureMapRelation,
): void {
  const key = relation.kind === 'citation'
    ? `${relation.kind}:${relation.source}->${relation.target}`
    : undirectedKey(relation.kind, relation.source, relation.target);
  const existing = relationByKey.get(key);
  if (!existing) {
    relationByKey.set(key, relation.kind === 'citation' ? relation : normalizeUndirectedRelation(relation));
    return;
  }
  if (existing.provenance !== 'artifact_edge' && relation.provenance === 'artifact_edge') {
    relationByKey.set(key, relation.kind === 'citation' ? relation : normalizeUndirectedRelation(relation));
    return;
  }
  existing.weight = Math.max(existing.weight, relation.weight);
  existing.evidence = uniqueStrings([...existing.evidence, ...relation.evidence]);
}

/**
 * Uses only exact provider topic IDs already present on the final artifact.
 * This is an inferred, undirected similarity cue, never a citation claim.
 */
function deriveTopicSimilarityRelations(
  nodes: LiteratureMapNode[],
  relationByKey: ReadonlyMap<string, LiteratureMapRelation>,
): LiteratureMapRelation[] {
  const topicIdsByPaper = new Map<string, Set<string>>();
  const paperIdsByTopic = new Map<string, string[]>();

  for (const node of nodes) {
    const topicIds = new Set<string>();
    for (const topic of node.paper.topics ?? []) {
      const topicId = typeof topic.id === 'string' ? topic.id.trim().toLocaleLowerCase() : '';
      if (topicId) topicIds.add(topicId);
    }
    topicIdsByPaper.set(node.id, topicIds);
    for (const topicId of topicIds) {
      const paperIds = paperIdsByTopic.get(topicId) ?? [];
      paperIds.push(node.id);
      paperIdsByTopic.set(topicId, paperIds);
    }
  }

  const sharedTopicsByPair = new Map<string, { source: string; target: string; topicIds: string[] }>();
  for (const [topicId, paperIds] of [...paperIdsByTopic.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    forEachPair(uniqueStrings(paperIds).sort((left, right) => left.localeCompare(right)), (first, second) => {
      const [source, target] = first.localeCompare(second) <= 0 ? [first, second] : [second, first];
      const key = undirectedKey('topic_similarity', source, target);
      const existing = sharedTopicsByPair.get(key) ?? { source, target, topicIds: [] };
      existing.topicIds.push(topicId);
      sharedTopicsByPair.set(key, existing);
    });
  }

  const relations: LiteratureMapRelation[] = [];
  for (const [key, pair] of [...sharedTopicsByPair.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (hasCitationOrTopicRelation(relationByKey, pair.source, pair.target, key)) continue;
    const sourceTopics = topicIdsByPaper.get(pair.source) ?? new Set<string>();
    const targetTopics = topicIdsByPaper.get(pair.target) ?? new Set<string>();
    const unionSize = new Set([...sourceTopics, ...targetTopics]).size;
    const topicIds = uniqueStrings(pair.topicIds).sort((left, right) => left.localeCompare(right));
    if (unionSize === 0 || topicIds.length === 0) continue;
    relations.push({
      id: `topic-similarity:${pair.source}:${pair.target}`,
      source: pair.source,
      target: pair.target,
      kind: 'topic_similarity',
      inferred: true,
      weight: topicIds.length / unionSize,
      evidence: topicIds.map((topicId) => `topic:${topicId}`),
      provenance: 'derived_topic_similarity',
    });
  }
  return relations;
}

function hasCitationOrTopicRelation(
  relationByKey: ReadonlyMap<string, LiteratureMapRelation>,
  source: string,
  target: string,
  topicSimilarityKey: string,
): boolean {
  return relationByKey.has(`citation:${source}->${target}`)
    || relationByKey.has(`citation:${target}->${source}`)
    || relationByKey.has(undirectedKey('shared_topic', source, target))
    || relationByKey.has(topicSimilarityKey);
}

function normalizeUndirectedRelation(relation: LiteratureMapRelation): LiteratureMapRelation {
  return relation.source.localeCompare(relation.target) <= 0
    ? relation
    : { ...relation, source: relation.target, target: relation.source };
}

function projectTopics(nodes: LiteratureMapNode[]): LiteratureMapTopic[] {
  const byId = new Map<string, LiteratureMapTopic>();
  for (const node of nodes) {
    for (const topic of node.paper.topics ?? []) {
      const id = topic.id?.trim() || topic.name.trim().toLocaleLowerCase();
      if (!id || !topic.name.trim()) continue;
      const existing = byId.get(id) ?? {
        id,
        name: topic.name.trim(),
        score: typeof topic.score === 'number' && Number.isFinite(topic.score) ? topic.score : null,
        paperIds: [],
      };
      existing.paperIds.push(node.id);
      if (existing.score === null && typeof topic.score === 'number' && Number.isFinite(topic.score)) {
        existing.score = topic.score;
      }
      byId.set(id, existing);
    }
  }
  return [...byId.values()]
    .map((topic) => ({ ...topic, paperIds: uniqueStrings(topic.paperIds) }))
    .sort((left, right) => right.paperIds.length - left.paperIds.length || left.name.localeCompare(right.name));
}

function projectTimeline(nodes: LiteratureMapNode[]): LiteratureMapTimelineBucket[] {
  const byYear = new Map<number, string[]>();
  for (const node of nodes) {
    if (node.year === null) continue;
    const paperIds = byYear.get(node.year) ?? [];
    paperIds.push(node.id);
    byYear.set(node.year, paperIds);
  }
  return [...byYear.entries()]
    .map(([year, paperIds]) => ({ year, paperIds: uniqueStrings(paperIds) }))
    .sort((left, right) => right.year - left.year);
}

function researchPaperYear(paper: ResearchPaper): number | null {
  if (typeof paper.year === 'number' && Number.isFinite(paper.year) && paper.year >= 1000 && paper.year <= 3000) {
    return Math.trunc(paper.year);
  }
  const match = /^([12]\d{3})-/u.exec(paper.publicationDate ?? '');
  return match ? Number(match[1]) : null;
}

function compareRelations(left: LiteratureMapRelation, right: LiteratureMapRelation): number {
  const kinds: LiteratureMapRelationKind[] = [
    'citation',
    'shared_topic',
    'topic_similarity',
    'bibliographic_coupling',
    'co_citation',
  ];
  return kinds.indexOf(left.kind) - kinds.indexOf(right.kind)
    || left.source.localeCompare(right.source)
    || left.target.localeCompare(right.target)
    || left.id.localeCompare(right.id);
}

function comparePaperIds(model: LiteratureMapModel, leftId: string, rightId: string): number {
  const left = model.nodeById.get(leftId)?.paper.title ?? leftId;
  const right = model.nodeById.get(rightId)?.paper.title ?? rightId;
  return left.localeCompare(right) || leftId.localeCompare(rightId);
}

function addNeighbor<T>(map: Map<string, T[]>, key: string, value: T): void {
  const entries = map.get(key) ?? [];
  entries.push(value);
  map.set(key, entries);
}

function forEachPair(values: string[], visit: (first: string, second: string) => void): void {
  for (let firstIndex = 0; firstIndex < values.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < values.length; secondIndex += 1) {
      visit(values[firstIndex], values[secondIndex]);
    }
  }
}

function undirectedKey(kind: Exclude<LiteratureMapRelationKind, 'citation'>, first: string, second: string): string {
  const [source, target] = first.localeCompare(second) <= 0 ? [first, second] : [second, first];
  return `${kind}:${source}:${target}`;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0))];
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
