import type { ResearchRelationType } from "../types.js";
import type {
  LiteratureMapEdge,
  LiteratureMapNode,
  LiveLiteratureMap,
} from "./mapMaintenance.js";

export const LITERATURE_BRIDGE_ALGORITHM = "tarjan_articulation_points" as const;

export type LiteratureBridgeRelationPolicy = "observed_citations" | "all_active_relations";

export type LiteratureBridgeRelationEvidence = Readonly<{
  edgeId: string;
  sourcePaperId: string;
  targetPaperId: string;
  relationType: ResearchRelationType;
  inferred: boolean;
  evidence: readonly string[];
}>;

export type LiteratureBridgeSeparatedGroup = Readonly<{
  size: number;
  /** A deterministic, bounded sample for inspection without quadratic reports. */
  representativePaperIds: readonly string[];
}>;

export type LiteratureBridgePaper = Readonly<{
  paperId: string;
  aliases: readonly string[];
  title: string;
  sourceComponentSize: number;
  componentIncrease: number;
  separatedPairCount: number;
  possiblePairCount: number;
  separatedPairFraction: number;
  directNeighborPaperIds: readonly string[];
  separatedGroups: readonly LiteratureBridgeSeparatedGroup[];
  supportingRelations: readonly LiteratureBridgeRelationEvidence[];
}>;

export type LiteratureBridgeAnalysis = Readonly<{
  schemaVersion: 1;
  kind: "literature_bridge_analysis";
  mapId: string;
  sourceRevision: number;
  relationPolicy: LiteratureBridgeRelationPolicy;
  graphProjection: "undirected";
  algorithm: typeof LITERATURE_BRIDGE_ALGORITHM;
  provenance: Readonly<{
    source: "live_literature_map";
    evaluatedPaperCount: number;
    evaluatedRelationCount: number;
    evaluatedRelationIds: readonly string[];
    excludedTombstonePaperCount: number;
    excludedTombstoneRelationCount: number;
    excludedByRelationPolicyCount: number;
    skippedInvalidRelationIds: readonly string[];
  }>;
  bridges: readonly LiteratureBridgePaper[];
}>;

export type AnalyzeLiteratureMapBridgesOptions = Readonly<{
  /** Defaults to observed citations so an inferred similarity never becomes a citation claim. */
  relationPolicy?: LiteratureBridgeRelationPolicy;
}>;

type ActiveGraph = Readonly<{
  nodeById: ReadonlyMap<string, LiteratureMapNode>;
  adjacency: ReadonlyMap<string, ReadonlySet<string>>;
  relations: readonly LiteratureMapEdge[];
  relationsByPaperId: ReadonlyMap<string, readonly LiteratureMapEdge[]>;
  excludedTombstonePaperCount: number;
  excludedTombstoneRelationCount: number;
  excludedByRelationPolicyCount: number;
  skippedInvalidRelationIds: readonly string[];
}>;

/**
 * Finds papers whose removal separates an active relation component.
 *
 * The result is intentionally stricter than a generic centrality ranking: a
 * paper is reported only when it is an articulation point. The default graph
 * contains observed citations only, projected as undirected solely for the
 * connectivity calculation. Every supporting relation retains direction,
 * relation type, inference state, and provider evidence in the output.
 */
export function analyzeLiteratureMapBridges(
  map: LiveLiteratureMap,
  options: AnalyzeLiteratureMapBridgesOptions = {},
): LiteratureBridgeAnalysis {
  assertLiveMapIdentity(map);
  const relationPolicy = options.relationPolicy ?? "observed_citations";
  assertRelationPolicy(relationPolicy);
  const graph = buildActiveGraph(map, relationPolicy);
  const articulationPaperIds = findArticulationPoints(graph.adjacency);
  const bridges = [...articulationPaperIds]
    .map((paperId) => bridgeEvidence(paperId, graph))
    .sort(compareBridges);

  return {
    schemaVersion: 1,
    kind: "literature_bridge_analysis",
    mapId: map.mapId,
    sourceRevision: map.revision,
    relationPolicy,
    graphProjection: "undirected",
    algorithm: LITERATURE_BRIDGE_ALGORITHM,
    provenance: {
      source: "live_literature_map",
      evaluatedPaperCount: graph.nodeById.size,
      evaluatedRelationCount: graph.relations.length,
      evaluatedRelationIds: graph.relations.map((edge) => edge.id),
      excludedTombstonePaperCount: graph.excludedTombstonePaperCount,
      excludedTombstoneRelationCount: graph.excludedTombstoneRelationCount,
      excludedByRelationPolicyCount: graph.excludedByRelationPolicyCount,
      skippedInvalidRelationIds: graph.skippedInvalidRelationIds,
    },
    bridges,
  };
}

function buildActiveGraph(
  map: LiveLiteratureMap,
  relationPolicy: LiteratureBridgeRelationPolicy,
): ActiveGraph {
  const activeNodes = map.nodes.filter((node) => !node.tombstone);
  const nodeById = new Map(activeNodes.map((node) => [node.id, node] as const));
  const adjacency = new Map(activeNodes.map((node) => [node.id, new Set<string>()] as const));
  const relationsByPaperId = new Map<string, LiteratureMapEdge[]>();
  const relations: LiteratureMapEdge[] = [];
  const skippedInvalidRelationIds: string[] = [];
  let excludedTombstoneRelationCount = 0;
  let excludedByRelationPolicyCount = 0;

  for (const edge of [...map.edges].sort(compareEdges)) {
    if (edge.tombstone) {
      excludedTombstoneRelationCount += 1;
      continue;
    }
    if (!relationAllowed(edge, relationPolicy)) {
      excludedByRelationPolicyCount += 1;
      continue;
    }
    if (edge.source === edge.target || !nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      skippedInvalidRelationIds.push(edge.id);
      continue;
    }
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
    addRelation(relationsByPaperId, edge.source, edge);
    addRelation(relationsByPaperId, edge.target, edge);
    relations.push(edge);
  }

  return {
    nodeById,
    adjacency,
    relations,
    relationsByPaperId,
    excludedTombstonePaperCount: map.nodes.length - activeNodes.length,
    excludedTombstoneRelationCount,
    excludedByRelationPolicyCount,
    skippedInvalidRelationIds,
  };
}

function findArticulationPoints(adjacency: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const discovery = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string>();
  const articulation = new Set<string>();
  let time = 0;

  const visit = (paperId: string): void => {
    time += 1;
    discovery.set(paperId, time);
    low.set(paperId, time);
    let childCount = 0;

    for (const neighborId of sortedNeighbors(adjacency, paperId)) {
      if (!discovery.has(neighborId)) {
        parent.set(neighborId, paperId);
        childCount += 1;
        visit(neighborId);
        low.set(paperId, Math.min(requireNumber(low, paperId), requireNumber(low, neighborId)));
        if (!parent.has(paperId) && childCount > 1) articulation.add(paperId);
        if (parent.has(paperId) && requireNumber(low, neighborId) >= requireNumber(discovery, paperId)) {
          articulation.add(paperId);
        }
      } else if (parent.get(paperId) !== neighborId) {
        low.set(paperId, Math.min(requireNumber(low, paperId), requireNumber(discovery, neighborId)));
      }
    }
  };

  for (const paperId of [...adjacency.keys()].sort(compareText)) {
    if (!discovery.has(paperId)) visit(paperId);
  }
  return articulation;
}

function bridgeEvidence(paperId: string, graph: ActiveGraph): LiteratureBridgePaper {
  const node = graph.nodeById.get(paperId);
  if (!node) throw new Error(`Bridge paper ${paperId} is not present in the active map.`);
  const sourceComponent = connectedPaperIds(graph.adjacency, paperId);
  const remainingPaperIds = sourceComponent.filter((candidate) => candidate !== paperId);
  const remaining = new Set(remainingPaperIds);
  const separatedGroups: string[][] = [];

  while (remaining.size > 0) {
    const seed = [...remaining].sort(compareText)[0];
    if (!seed) break;
    const group = connectedPaperIds(graph.adjacency, seed, paperId)
      .filter((candidate) => remaining.has(candidate))
      .sort(compareText);
    for (const member of group) remaining.delete(member);
    separatedGroups.push(group);
  }

  separatedGroups.sort((left, right) => right.length - left.length || compareText(left[0] ?? "", right[0] ?? ""));
  const separatedPairCount = countSeparatedPairs(separatedGroups.map((group) => group.length));
  const possiblePairCount = chooseTwo(remainingPaperIds.length);
  const supportingRelations = (graph.relationsByPaperId.get(paperId) ?? [])
    .map(relationEvidence)
    .sort((left, right) => compareText(left.edgeId, right.edgeId));

  return {
    paperId,
    aliases: [...node.aliases],
    title: node.paper.title,
    sourceComponentSize: sourceComponent.length,
    componentIncrease: Math.max(0, separatedGroups.length - 1),
    separatedPairCount,
    possiblePairCount,
    separatedPairFraction: possiblePairCount === 0 ? 0 : separatedPairCount / possiblePairCount,
    directNeighborPaperIds: sortedNeighbors(graph.adjacency, paperId),
    separatedGroups: separatedGroups.map((group) => ({
      size: group.length,
      representativePaperIds: group.slice(0, 3),
    })),
    supportingRelations,
  };
}

function connectedPaperIds(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  startPaperId: string,
  excludedPaperId?: string,
): string[] {
  if (startPaperId === excludedPaperId || !adjacency.has(startPaperId)) return [];
  const visited = new Set<string>([startPaperId]);
  const queue = [startPaperId];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) continue;
    for (const neighbor of sortedNeighbors(adjacency, current)) {
      if (neighbor === excludedPaperId || visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }
  return [...visited].sort(compareText);
}

function relationAllowed(edge: LiteratureMapEdge, policy: LiteratureBridgeRelationPolicy): boolean {
  return policy === "all_active_relations" || (edge.type === "citation" && edge.inferred === false);
}

function relationEvidence(edge: LiteratureMapEdge): LiteratureBridgeRelationEvidence {
  return {
    edgeId: edge.id,
    sourcePaperId: edge.source,
    targetPaperId: edge.target,
    relationType: edge.type,
    inferred: edge.inferred,
    evidence: [...(edge.evidence ?? [])],
  };
}

function addRelation(target: Map<string, LiteratureMapEdge[]>, paperId: string, edge: LiteratureMapEdge): void {
  const relations = target.get(paperId) ?? [];
  relations.push(edge);
  target.set(paperId, relations);
}

function sortedNeighbors(adjacency: ReadonlyMap<string, ReadonlySet<string>>, paperId: string): string[] {
  return [...(adjacency.get(paperId) ?? [])].sort(compareText);
}

function requireNumber(values: ReadonlyMap<string, number>, key: string): number {
  const value = values.get(key);
  if (value === undefined) throw new Error(`Missing graph traversal value for ${key}.`);
  return value;
}

function countSeparatedPairs(groupSizes: readonly number[]): number {
  let pairs = 0;
  let prior = 0;
  for (const size of groupSizes) {
    pairs += prior * size;
    prior += size;
  }
  return pairs;
}

function chooseTwo(value: number): number {
  return value < 2 ? 0 : value * (value - 1) / 2;
}

function compareBridges(left: LiteratureBridgePaper, right: LiteratureBridgePaper): number {
  return right.separatedPairFraction - left.separatedPairFraction
    || right.componentIncrease - left.componentIncrease
    || compareText(left.paperId, right.paperId);
}

function compareEdges(left: LiteratureMapEdge, right: LiteratureMapEdge): number {
  return compareText(left.id, right.id)
    || compareText(left.source, right.source)
    || compareText(left.target, right.target);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function assertLiveMapIdentity(map: LiveLiteratureMap): void {
  if (!map || map.kind !== "live" || map.schemaVersion !== 1 || typeof map.mapId !== "string" || !map.mapId.trim()) {
    throw new TypeError("A valid live literature map is required for bridge analysis.");
  }
  if (!Number.isSafeInteger(map.revision) || map.revision < 0 || !Array.isArray(map.nodes) || !Array.isArray(map.edges)) {
    throw new TypeError("A valid live literature map is required for bridge analysis.");
  }
}

function assertRelationPolicy(value: string): asserts value is LiteratureBridgeRelationPolicy {
  if (value !== "observed_citations" && value !== "all_active_relations") {
    throw new TypeError("relationPolicy must be observed_citations or all_active_relations.");
  }
}
