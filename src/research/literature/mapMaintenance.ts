import { normalizeArxiv, normalizeDoi } from "../identity.js";
import type {
  PaperIdentity,
  ResearchPaper,
  ResearchPaperProvenance,
  ResearchRelationEdge,
  ResearchTopic,
  ResearchVenueEvidence,
} from "../types.js";

export type LiteratureMapOrigin = "search" | "zotero" | "monitor";
export type LiteratureMapNodeStatus = "candidate" | "relevant" | "core" | "excluded";

export type LiteratureMapPosition = {
  x: number;
  y: number;
  pinned: boolean;
};

export type LiteratureMapNode = {
  id: string;
  paper: ResearchPaper;
  aliases: string[];
  status: LiteratureMapNodeStatus;
  tombstone: boolean;
  position: LiteratureMapPosition;
  origins: LiteratureMapOrigin[];
  firstSeenAt: string;
  updatedAt: string;
};

export type LiteratureMapEdge = ResearchRelationEdge & {
  tombstone: boolean;
  firstSeenAt: string;
  updatedAt: string;
};

export type LiveLiteratureMap = {
  schemaVersion: 1;
  kind: "live";
  mapId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  nodes: LiteratureMapNode[];
  edges: LiteratureMapEdge[];
};

export type FrozenLiteratureMapSnapshot = {
  schemaVersion: 1;
  kind: "snapshot";
  snapshotId: string;
  sourceMapId: string;
  sourceRevision: number;
  frozenAt: string;
  nodes: LiteratureMapNode[];
  edges: LiteratureMapEdge[];
};

export type LiteratureMapUpdate = {
  papers?: ResearchPaper[];
  edges?: ResearchRelationEdge[];
  origin: LiteratureMapOrigin;
  tombstonePaperIds?: string[];
  restorePaperIds?: string[];
};

export type LiteratureMapDiff = {
  fromRevision: number;
  toRevision: number;
  nodes: {
    added: string[];
    updated: string[];
    tombstoned: string[];
    restored: string[];
  };
  edges: {
    added: string[];
    updated: string[];
    tombstoned: string[];
    restored: string[];
  };
  aliasesAdded: Array<{ alias: string; canonicalId: string }>;
  warnings: string[];
};

export type LiteratureMapUpdateResult = {
  map: LiveLiteratureMap;
  diff: LiteratureMapDiff;
};

export function createLiveLiteratureMap(input: {
  mapId: string;
  papers?: ResearchPaper[];
  edges?: ResearchRelationEdge[];
  origin?: LiteratureMapOrigin;
  now?: Date;
}): LiteratureMapUpdateResult {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const mapId = requireStableId(input.mapId, "map ID");
  const empty: LiveLiteratureMap = {
    schemaVersion: 1,
    kind: "live",
    mapId,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    nodes: [],
    edges: [],
  };
  return updateLiveLiteratureMap(empty, {
    origin: input.origin ?? "search",
    papers: input.papers,
    edges: input.edges,
  }, { now });
}

/**
 * Merge one incremental provider result without treating absent records as
 * deletions. Existing positions and user classifications remain untouched.
 */
export function updateLiveLiteratureMap(
  current: LiveLiteratureMap,
  update: LiteratureMapUpdate,
  options: { now?: Date } = {},
): LiteratureMapUpdateResult {
  validateLiveMap(current);
  const timestamp = (options.now ?? new Date()).toISOString();
  const diff = mutableDiff(current.revision);
  const nodes = current.nodes.map(cloneNode);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const identityIndex = buildIdentityIndex(nodes);

  for (const incoming of update.papers ?? []) {
    const canonicalId = resolvePaperId(incoming, identityIndex) ?? uniqueNodeId(incoming.id, nodeById);
    const existing = nodeById.get(canonicalId);
    if (existing) {
      const mergedPaper = mergePaper(existing.paper, incoming, canonicalId);
      const nextAliases = uniqueStrings([...existing.aliases, incoming.id]);
      const nextOrigins = uniqueOrigins([...existing.origins, update.origin]);
      for (const alias of nextAliases) {
        if (!existing.aliases.includes(alias)) {
          diff.aliasesAdded.push({ alias, canonicalId });
        }
      }
      if (!sameJson(existing.paper, mergedPaper)
        || !sameStringArray(existing.aliases, nextAliases)
        || !sameStringArray(existing.origins, nextOrigins)) {
        existing.paper = mergedPaper;
        existing.aliases = nextAliases;
        existing.origins = nextOrigins;
        existing.updatedAt = timestamp;
        diff.nodes.updated.push(existing.id);
      }
      indexNodeIdentity(existing, identityIndex);
      continue;
    }

    const aliases = uniqueStrings([incoming.id]);
    const node: LiteratureMapNode = {
      id: canonicalId,
      paper: { ...clonePaper(incoming), id: canonicalId },
      aliases,
      status: "candidate",
      tombstone: false,
      position: positionForNewNode(canonicalId, nodes, update.edges ?? [], identityIndex),
      origins: [update.origin],
      firstSeenAt: timestamp,
      updatedAt: timestamp,
    };
    nodes.push(node);
    nodeById.set(node.id, node);
    indexNodeIdentity(node, identityIndex);
    diff.nodes.added.push(node.id);
  }

  applyNodeTombstones(nodes, update.tombstonePaperIds ?? [], true, timestamp, identityIndex, diff);
  applyNodeTombstones(nodes, update.restorePaperIds ?? [], false, timestamp, identityIndex, diff);

  const edges: LiteratureMapEdge[] = current.edges.map(cloneEdge);
  const edgeByKey = new Map(edges.map((edge) => [edgeIdentity(edge), edge]));
  for (const incoming of update.edges ?? []) {
    const source = resolveRecordId(incoming.source, identityIndex);
    const target = resolveRecordId(incoming.target, identityIndex);
    if (!source || !target) {
      diff.warnings.push(`Skipped edge ${incoming.id}: one or both endpoints are not present in the map.`);
      continue;
    }
    if (source === target) continue;
    const normalized = normalizeEdge(incoming, source, target);
    const key = edgeIdentity(normalized);
    const existing = edgeByKey.get(key);
    const endpointTombstone = Boolean(nodeById.get(source)?.tombstone || nodeById.get(target)?.tombstone);
    if (!existing) {
      const edge: LiteratureMapEdge = {
        ...normalized,
        tombstone: endpointTombstone,
        firstSeenAt: timestamp,
        updatedAt: timestamp,
      };
      edges.push(edge);
      edgeByKey.set(key, edge);
      diff.edges.added.push(edge.id);
      continue;
    }
    const merged = mergeEdge(existing, normalized);
    const restored = existing.tombstone && !endpointTombstone;
    const tombstoned = !existing.tombstone && endpointTombstone;
    if (!sameJson(stripEdgeTimes(existing), { ...merged, tombstone: endpointTombstone })) {
      Object.assign(existing, merged, { tombstone: endpointTombstone, updatedAt: timestamp });
      diff.edges.updated.push(existing.id);
    }
    if (restored) diff.edges.restored.push(existing.id);
    if (tombstoned) diff.edges.tombstoned.push(existing.id);
  }

  synchronizeEndpointTombstones(edges, nodeById, timestamp, diff);
  normalizeDiff(diff);
  const changed = hasChanges(diff);
  if (!changed) {
    return { map: current, diff: { ...diff, toRevision: current.revision } };
  }
  const next: LiveLiteratureMap = {
    ...current,
    revision: current.revision + 1,
    updatedAt: timestamp,
    nodes,
    edges,
  };
  return { map: next, diff: { ...diff, toRevision: next.revision } };
}

export function setLiteratureMapNodeState(
  current: LiveLiteratureMap,
  paperId: string,
  input: { status?: LiteratureMapNodeStatus; position?: Omit<LiteratureMapPosition, "pinned"> & { pinned?: boolean } },
  options: { now?: Date } = {},
): LiveLiteratureMap {
  validateLiveMap(current);
  const identityIndex = buildIdentityIndex(current.nodes);
  const canonicalId = resolveRecordId(paperId, identityIndex);
  if (!canonicalId) throw new Error(`Unknown literature map paper: ${paperId}`);
  const timestamp = (options.now ?? new Date()).toISOString();
  let changed = false;
  const nodes = current.nodes.map((node) => {
    if (node.id !== canonicalId) return cloneNode(node);
    const status = input.status ?? node.status;
    const position = input.position
      ? {
          x: finiteCoordinate(input.position.x, "x"),
          y: finiteCoordinate(input.position.y, "y"),
          pinned: input.position.pinned ?? true,
        }
      : { ...node.position };
    if (status === node.status && sameJson(position, node.position)) return cloneNode(node);
    changed = true;
    return { ...cloneNode(node), status, position, updatedAt: timestamp };
  });
  return changed
    ? { ...current, revision: current.revision + 1, updatedAt: timestamp, nodes, edges: current.edges.map(cloneEdge) }
    : current;
}

export function freezeLiteratureMap(
  current: LiveLiteratureMap,
  input: { snapshotId: string; now?: Date },
): Readonly<FrozenLiteratureMapSnapshot> {
  validateLiveMap(current);
  const snapshot: FrozenLiteratureMapSnapshot = {
    schemaVersion: 1,
    kind: "snapshot",
    snapshotId: requireStableId(input.snapshotId, "snapshot ID"),
    sourceMapId: current.mapId,
    sourceRevision: current.revision,
    frozenAt: (input.now ?? new Date()).toISOString(),
    nodes: current.nodes.map(cloneNode),
    edges: current.edges.map(cloneEdge),
  };
  return deepFreeze(snapshot);
}

function applyNodeTombstones(
  nodes: LiteratureMapNode[],
  recordIds: string[],
  tombstone: boolean,
  timestamp: string,
  identityIndex: Map<string, string>,
  diff: MutableDiff,
): void {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const recordId of uniqueStrings(recordIds)) {
    const canonicalId = resolveRecordId(recordId, identityIndex);
    const node = canonicalId ? nodeById.get(canonicalId) : undefined;
    if (!node || node.tombstone === tombstone) continue;
    node.tombstone = tombstone;
    node.updatedAt = timestamp;
    (tombstone ? diff.nodes.tombstoned : diff.nodes.restored).push(node.id);
  }
}

function synchronizeEndpointTombstones(
  edges: LiteratureMapEdge[],
  nodeById: Map<string, LiteratureMapNode>,
  timestamp: string,
  diff: MutableDiff,
): void {
  for (const edge of edges) {
    const shouldTombstone = Boolean(nodeById.get(edge.source)?.tombstone || nodeById.get(edge.target)?.tombstone);
    if (edge.tombstone === shouldTombstone) continue;
    edge.tombstone = shouldTombstone;
    edge.updatedAt = timestamp;
    (shouldTombstone ? diff.edges.tombstoned : diff.edges.restored).push(edge.id);
  }
}

function resolvePaperId(paper: ResearchPaper, index: Map<string, string>): string | undefined {
  for (const token of paperIdentityTokens(paper)) {
    const match = index.get(token);
    if (match) return match;
  }
  return undefined;
}

function resolveRecordId(recordId: string, index: Map<string, string>): string | undefined {
  const raw = cleanString(recordId);
  if (!raw) return undefined;
  const normalized = raw.toLocaleLowerCase("en-US");
  const doi = normalizeDoi(raw);
  const arxiv = normalizeArxiv(raw);
  const directMatch = index.get(`record:${normalized}`)
    ?? (doi ? index.get(`doi:${doi}`) : undefined)
    ?? (arxiv ? index.get(`arxiv:${arxiv}`) : undefined);
  if (directMatch) return directMatch;

  // These values are not self-describing like DOI and arXiv identifiers. Use
  // them only when they identify one node unambiguously.
  const matches = new Set<string>();
  for (const namespace of ["openalex", "openreview", "pmid", "pmcid", "zotero"]) {
    const match = index.get(`${namespace}:${normalized}`);
    if (match) matches.add(match);
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

function buildIdentityIndex(nodes: LiteratureMapNode[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of nodes) indexNodeIdentity(node, index);
  return index;
}

function indexNodeIdentity(node: LiteratureMapNode, index: Map<string, string>): void {
  for (const token of paperIdentityTokens(node.paper, node.aliases)) {
    if (!index.has(token)) index.set(token, node.id);
  }
}

function paperIdentityTokens(paper: ResearchPaper, aliases: string[] = []): string[] {
  const tokens: string[] = [];
  for (const record of [paper.id, ...aliases]) pushToken(tokens, "record", record);
  pushToken(tokens, "openalex", paper.identity.openAlexId);
  pushToken(tokens, "doi", normalizeDoi(paper.identity.doi ?? paper.doi));
  pushToken(tokens, "arxiv", normalizeArxiv(paper.identity.arxiv ?? paper.identity.other?.arxiv));
  pushToken(tokens, "openreview", paper.identity.openReview);
  pushToken(tokens, "pmid", paper.identity.pmid);
  pushToken(tokens, "pmcid", paper.identity.pmcid);
  pushToken(tokens, "zotero", paper.identity.zoteroKey);
  for (const [key, value] of Object.entries(paper.identity.other ?? {})) {
    if (key.toLocaleLowerCase("en-US") === "arxiv") continue;
    pushToken(tokens, `other:${key.toLocaleLowerCase("en-US")}`, value);
  }
  return uniqueStrings(tokens);
}

function pushToken(target: string[], namespace: string, value: unknown): void {
  const normalized = cleanString(value)?.toLocaleLowerCase("en-US");
  if (normalized) target.push(`${namespace}:${normalized}`);
}

function mergePaper(existing: ResearchPaper, incoming: ResearchPaper, canonicalId: string): ResearchPaper {
  const identity = mergeIdentity(existing.identity, incoming.identity, existing.doi, incoming.doi);
  const venueEvidence = mergeVenueEvidence(existing.venueEvidence, incoming.venueEvidence);
  return {
    ...existing,
    id: canonicalId,
    identity,
    title: richerString(existing.title, incoming.title) ?? existing.title,
    authors: incoming.authors.length > existing.authors.length ? [...incoming.authors] : [...existing.authors],
    ...(existing.year !== undefined || incoming.year !== undefined ? { year: incoming.year ?? existing.year } : {}),
    ...(existing.publicationDate || incoming.publicationDate
      ? { publicationDate: incoming.publicationDate ?? existing.publicationDate }
      : {}),
    ...(existing.updatedAt || incoming.updatedAt ? { updatedAt: laterDate(existing.updatedAt, incoming.updatedAt) } : {}),
    ...(existing.type || incoming.type ? { type: incoming.type ?? existing.type } : {}),
    ...(existing.venue || incoming.venue ? { venue: incoming.venue ?? existing.venue } : {}),
    ...(venueEvidence ? { venueEvidence } : {}),
    ...(identity.doi ? { doi: identity.doi } : {}),
    ...(existing.url || incoming.url ? { url: incoming.url ?? existing.url } : {}),
    citedByCount: Math.max(existing.citedByCount, incoming.citedByCount),
    ...(existing.isOpenAccess !== undefined || incoming.isOpenAccess !== undefined
      ? { isOpenAccess: incoming.isOpenAccess ?? existing.isOpenAccess }
      : {}),
    ...(existing.abstract || incoming.abstract
      ? { abstract: richerString(existing.abstract, incoming.abstract) }
      : {}),
    topics: mergeTopics(existing.topics, incoming.topics),
    referencedWorkIds: uniqueStrings([...existing.referencedWorkIds, ...incoming.referencedWorkIds]),
    sourceId: existing.sourceId,
    sourceIds: uniqueStrings([...existing.sourceIds, ...incoming.sourceIds]),
    provenance: mergeProvenance(existing.provenance, incoming.provenance),
  };
}

function mergeIdentity(
  existing: PaperIdentity,
  incoming: PaperIdentity,
  existingDoi?: string,
  incomingDoi?: string,
): PaperIdentity {
  const doi = normalizeDoi(existing.doi ?? existingDoi) ?? normalizeDoi(incoming.doi ?? incomingDoi);
  const arxiv = normalizeArxiv(existing.arxiv ?? existing.other?.arxiv)
    ?? normalizeArxiv(incoming.arxiv ?? incoming.other?.arxiv);
  const other = { ...(incoming.other ?? {}), ...(existing.other ?? {}) };
  delete other.arxiv;
  return {
    ...incoming,
    ...existing,
    ...(doi ? { doi } : {}),
    ...(arxiv ? { arxiv } : {}),
    ...(Math.max(existing.arxivVersion ?? 0, incoming.arxivVersion ?? 0) > 0
      ? { arxivVersion: Math.max(existing.arxivVersion ?? 0, incoming.arxivVersion ?? 0) }
      : {}),
    ...(Object.keys(other).length > 0 ? { other } : {}),
  };
}

function mergeTopics(existing: ResearchTopic[], incoming: ResearchTopic[]): ResearchTopic[] {
  const topics = new Map<string, ResearchTopic>();
  for (const topic of [...existing, ...incoming]) {
    const key = topic.id || topic.name.toLocaleLowerCase("en-US");
    const previous = topics.get(key);
    topics.set(key, previous && (previous.score ?? -1) >= (topic.score ?? -1) ? previous : { ...topic });
  }
  return [...topics.values()];
}

function mergeVenueEvidence(
  existing: ResearchVenueEvidence[] | undefined,
  incoming: ResearchVenueEvidence[] | undefined,
): ResearchVenueEvidence[] | undefined {
  const entries = new Map<string, ResearchVenueEvidence>();
  for (const item of [...(existing ?? []), ...(incoming ?? [])]) {
    const key = [
      item.sourceId,
      item.evidence,
      item.venue,
      item.year ?? "",
      item.track ?? "",
      item.status,
      item.officialVenueId ?? "",
    ].join("\u0000");
    if (!entries.has(key)) entries.set(key, { ...item });
  }
  const merged = [...entries.values()];
  return merged.length > 0 ? merged : undefined;
}

function mergeProvenance(
  existing: ResearchPaperProvenance[],
  incoming: ResearchPaperProvenance[],
): ResearchPaperProvenance[] {
  const entries = new Map<string, ResearchPaperProvenance>();
  for (const item of [...existing, ...incoming]) {
    const key = [item.sourceId, item.sourceRecordId ?? "", item.queryVariantId ?? "", item.rank].join("\u0000");
    if (!entries.has(key)) entries.set(key, { ...item });
  }
  return [...entries.values()];
}

function normalizeEdge(edge: ResearchRelationEdge, source: string, target: string): ResearchRelationEdge {
  const undirected = edge.type === "shared_topic" && source.localeCompare(target) > 0;
  const normalizedSource = undirected ? target : source;
  const normalizedTarget = undirected ? source : target;
  return {
    ...edge,
    id: `${edge.type}:${normalizedSource}:${normalizedTarget}`,
    source: normalizedSource,
    target: normalizedTarget,
    weight: Number.isFinite(edge.weight) ? Math.max(0, edge.weight) : 0,
    evidence: edge.evidence ? uniqueStrings(edge.evidence) : undefined,
  };
}

function mergeEdge(existing: LiteratureMapEdge, incoming: ResearchRelationEdge): ResearchRelationEdge {
  const evidence = uniqueStrings([...(existing.evidence ?? []), ...(incoming.evidence ?? [])]);
  return {
    id: existing.id,
    source: incoming.source,
    target: incoming.target,
    type: incoming.type,
    weight: Math.max(existing.weight, incoming.weight),
    inferred: existing.inferred && incoming.inferred,
    ...(evidence.length > 0 ? { evidence } : {}),
  };
}

function edgeIdentity(edge: Pick<ResearchRelationEdge, "source" | "target" | "type">): string {
  return `${edge.type}\u0000${edge.source}\u0000${edge.target}`;
}

function positionForNewNode(
  id: string,
  existing: LiteratureMapNode[],
  incomingEdges: ResearchRelationEdge[],
  identityIndex: Map<string, string>,
): LiteratureMapPosition {
  const neighborPositions: LiteratureMapPosition[] = [];
  for (const edge of incomingEdges) {
    const other = edge.source === id ? edge.target : edge.target === id ? edge.source : undefined;
    if (!other) continue;
    const canonical = resolveRecordId(other, identityIndex);
    const node = canonical ? existing.find((entry) => entry.id === canonical) : undefined;
    if (node && !node.tombstone) neighborPositions.push(node.position);
  }
  const angle = stableAngle(id);
  if (neighborPositions.length > 0) {
    const center = neighborPositions.reduce((sum, position) => ({
      x: sum.x + position.x,
      y: sum.y + position.y,
    }), { x: 0, y: 0 });
    const radius = 72 + (stableHash(id) % 37);
    return {
      x: center.x / neighborPositions.length + Math.cos(angle) * radius,
      y: center.y / neighborPositions.length + Math.sin(angle) * radius,
      pinned: false,
    };
  }
  const index = existing.length;
  const radius = index === 0 ? 0 : 96 + Math.sqrt(index) * 54;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, pinned: false };
}

function stableAngle(value: string): number {
  return (stableHash(value) % 3600) / 3600 * Math.PI * 2;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function uniqueNodeId(candidate: string, nodes: Map<string, LiteratureMapNode>): string {
  const base = requireStableId(candidate, "paper ID");
  if (!nodes.has(base)) return base;
  let suffix = 2;
  while (nodes.has(`${base}#${suffix}`)) suffix += 1;
  return `${base}#${suffix}`;
}

function mutableDiff(revision: number): MutableDiff {
  return {
    fromRevision: revision,
    toRevision: revision,
    nodes: { added: [], updated: [], tombstoned: [], restored: [] },
    edges: { added: [], updated: [], tombstoned: [], restored: [] },
    aliasesAdded: [],
    warnings: [],
  };
}

type MutableDiff = LiteratureMapDiff;

function normalizeDiff(diff: MutableDiff): void {
  for (const values of [
    diff.nodes.added,
    diff.nodes.updated,
    diff.nodes.tombstoned,
    diff.nodes.restored,
    diff.edges.added,
    diff.edges.updated,
    diff.edges.tombstoned,
    diff.edges.restored,
    diff.warnings,
  ]) {
    const unique = uniqueStrings(values);
    values.splice(0, values.length, ...unique);
  }
  const seenAliases = new Set<string>();
  diff.aliasesAdded = diff.aliasesAdded.filter((entry) => {
    const key = `${entry.alias}\u0000${entry.canonicalId}`;
    if (seenAliases.has(key)) return false;
    seenAliases.add(key);
    return true;
  });
}

function hasChanges(diff: LiteratureMapDiff): boolean {
  return diff.nodes.added.length > 0
    || diff.nodes.updated.length > 0
    || diff.nodes.tombstoned.length > 0
    || diff.nodes.restored.length > 0
    || diff.edges.added.length > 0
    || diff.edges.updated.length > 0
    || diff.edges.tombstoned.length > 0
    || diff.edges.restored.length > 0
    || diff.aliasesAdded.length > 0;
}

function validateLiveMap(map: LiveLiteratureMap): void {
  if (map.kind !== "live" || map.schemaVersion !== 1 || !cleanString(map.mapId)) {
    throw new Error("Invalid live literature map.");
  }
  if (!Number.isSafeInteger(map.revision) || map.revision < 0) {
    throw new Error("Literature map revision must be a non-negative integer.");
  }
}

function finiteCoordinate(value: number, axis: string): number {
  if (!Number.isFinite(value)) throw new Error(`Literature map ${axis} coordinate must be finite.`);
  return value;
}

function requireStableId(value: unknown, label: string): string {
  const id = cleanString(value);
  if (!id || id.length > 4_096) throw new Error(`A valid ${label} is required.`);
  return id;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function richerString(left: string | undefined, right: string | undefined): string | undefined {
  const a = cleanString(left);
  const b = cleanString(right);
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

function laterDate(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return right > left ? right : left;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = cleanString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function uniqueOrigins(values: LiteratureMapOrigin[]): LiteratureMapOrigin[] {
  return [...new Set(values)];
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stripEdgeTimes(edge: LiteratureMapEdge): Omit<LiteratureMapEdge, "firstSeenAt" | "updatedAt"> {
  const { firstSeenAt: _firstSeenAt, updatedAt: _updatedAt, ...rest } = edge;
  return rest;
}

function clonePaper(paper: ResearchPaper): ResearchPaper {
  return {
    ...paper,
    identity: { ...paper.identity, other: paper.identity.other ? { ...paper.identity.other } : undefined },
    authors: [...paper.authors],
    topics: paper.topics.map((topic) => ({ ...topic })),
    referencedWorkIds: [...paper.referencedWorkIds],
    sourceIds: [...paper.sourceIds],
    provenance: paper.provenance.map((entry) => ({ ...entry })),
    ...(paper.venueEvidence ? { venueEvidence: paper.venueEvidence.map((entry) => ({ ...entry })) } : {}),
  };
}

function cloneNode(node: LiteratureMapNode): LiteratureMapNode {
  return {
    ...node,
    paper: clonePaper(node.paper),
    aliases: [...node.aliases],
    position: { ...node.position },
    origins: [...node.origins],
  };
}

function cloneEdge(edge: LiteratureMapEdge): LiteratureMapEdge {
  return { ...edge, evidence: edge.evidence ? [...edge.evidence] : undefined };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
