import { toResearchArtifactRef } from "../artifacts/index.js";
import type { EvidencePackArtifact, EvidencePackEntry } from "../literature/evidencePack.js";
import type { LiteratureMapEdge, LiteratureMapNode } from "../literature/mapMaintenance.js";
import type {
  CitationSetArtifact,
  LiteratureMapForManuscript,
  RelatedWorkEvidenceRef,
  RelatedWorkMapGroup,
  RelatedWorkPlan,
} from "./types.js";
import { requireIdentifier, requireText, uniqueSorted } from "./validation.js";

export function deriveRelatedWorkMapGroups(map: LiteratureMapForManuscript): RelatedWorkMapGroup[] {
  const nodes = activeNodes(map.nodes);
  const activeIds = new Set(nodes.map((node) => node.id));
  const edges = activeEdges(map.edges, activeIds);
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  const unseen = new Set(nodes.map((node) => node.id));
  const groups: RelatedWorkMapGroup[] = [];
  while (unseen.size > 0) {
    const seed = [...unseen].sort((left, right) => left.localeCompare(right, "en"))[0]!;
    const queue = [seed];
    const paperIds: string[] = [];
    unseen.delete(seed);
    while (queue.length > 0) {
      const current = queue.shift()!;
      paperIds.push(current);
      for (const neighbor of [...(adjacency.get(current) ?? [])].sort((left, right) => left.localeCompare(right, "en"))) {
        if (!unseen.delete(neighbor)) continue;
        queue.push(neighbor);
      }
    }
    paperIds.sort((left, right) => left.localeCompare(right, "en"));
    const relationTypes = uniqueSorted(edges
      .filter((edge) => paperIds.includes(edge.source) && paperIds.includes(edge.target))
      .map((edge) => edge.type));
    const index = groups.length + 1;
    groups.push(Object.freeze({
      groupId: `map-group-${String(index).padStart(3, "0")}`,
      label: `Literature map group ${index}`,
      paperIds: Object.freeze(paperIds),
      comparisonAxes: Object.freeze(relationTypes),
    }));
  }
  return groups;
}

export function organizeRelatedWork(input: {
  map: LiteratureMapForManuscript;
  citationSet: CitationSetArtifact;
  evidencePacks: readonly EvidencePackArtifact[];
  groups?: readonly RelatedWorkMapGroup[];
}): RelatedWorkPlan {
  const mapIdentity = input.map.kind === "live"
    ? { id: input.map.mapId, revision: input.map.revision }
    : { id: input.map.sourceMapId, revision: input.map.sourceRevision };
  const nodes = activeNodes(input.map.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const groups = (input.groups ?? deriveRelatedWorkMapGroups(input.map)).map((group) => normalizeGroup(group, nodeIds));
  const groupIds = new Set<string>();
  for (const group of groups) {
    if (groupIds.has(group.groupId)) throw new TypeError(`Related-work group ${group.groupId} is duplicated.`);
    groupIds.add(group.groupId);
  }

  const citationByPaperId = new Map(input.citationSet.payload.entries
    .filter((entry) => entry.paperId !== undefined)
    .map((entry) => [entry.paperId!, entry.citationKey]));
  const evidenceByPaperId = indexEvidence(input.evidencePacks);
  const assigned = new Set(groups.flatMap((group) => [...group.paperIds]));
  const uncited = new Set<string>();
  const plans = groups.map((group) => {
    const citationKeys = uniqueSorted(group.paperIds.flatMap((paperId) => {
      const key = citationByPaperId.get(paperId);
      if (!key) {
        uncited.add(paperId);
        return [];
      }
      return [key];
    }));
    const evidence = group.paperIds.flatMap((paperId) => evidenceByPaperId.get(paperId) ?? []);
    const evidencedIds = new Set(evidence.map((entry) => entry.paperId));
    const citedPaperCount = group.paperIds.filter((paperId) => citationByPaperId.has(paperId)).length;
    const coverageStatus = citedPaperCount === group.paperIds.length && evidencedIds.size === group.paperIds.length
      ? "complete"
      : citedPaperCount === 0 || evidencedIds.size === 0
        ? "unsupported"
        : "partial";
    return Object.freeze({
      groupId: group.groupId,
      label: group.label,
      paperIds: Object.freeze([...group.paperIds]),
      citationKeys: Object.freeze(citationKeys),
      evidence: Object.freeze(evidence),
      comparisonAxes: Object.freeze([...(group.comparisonAxes ?? [])]),
      coverage: Object.freeze({
        mappedPaperCount: group.paperIds.length,
        citedPaperCount,
        evidencedPaperCount: evidencedIds.size,
        status: coverageStatus,
      }),
    });
  });

  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "related_work_plan" as const,
    sourceMapId: requireIdentifier(mapIdentity.id, "sourceMapId"),
    sourceMapRevision: mapIdentity.revision,
    groups: Object.freeze(plans),
    ungroupedPaperIds: Object.freeze(nodes.map((node) => node.id).filter((id) => !assigned.has(id)).sort()),
    uncitedPaperIds: Object.freeze([...uncited].sort((left, right) => left.localeCompare(right, "en"))),
    evidencePackRefs: Object.freeze(input.evidencePacks.map(toResearchArtifactRef)),
  });
}

function normalizeGroup(group: RelatedWorkMapGroup, nodeIds: Set<string>): RelatedWorkMapGroup {
  if (!group || typeof group !== "object" || !Array.isArray(group.paperIds) || group.paperIds.length === 0) {
    throw new TypeError("Related-work map groups need at least one paper.");
  }
  const paperIds = uniqueSorted(group.paperIds.map((paperId) => requireIdentifier(paperId, "group paperId")));
  const missing = paperIds.find((paperId) => !nodeIds.has(paperId));
  if (missing) throw new TypeError(`Related-work group references paper ${missing}, which is not active in the map.`);
  return Object.freeze({
    groupId: requireIdentifier(group.groupId, "groupId"),
    label: requireText(group.label, "group label", 512),
    paperIds: Object.freeze(paperIds),
    comparisonAxes: Object.freeze(uniqueSorted((group.comparisonAxes ?? []).map((axis) => requireText(axis, "comparison axis", 512)))),
  });
}

function indexEvidence(packs: readonly EvidencePackArtifact[]): Map<string, RelatedWorkEvidenceRef[]> {
  const result = new Map<string, RelatedWorkEvidenceRef[]>();
  for (const pack of packs) {
    const ref = toResearchArtifactRef(pack);
    for (const entry of pack.payload.entries) {
      const evidence = Object.freeze({
        evidencePack: ref,
        entryId: entry.id,
        paperId: entry.paperId,
        locatorLabel: locatorLabel(entry),
      });
      result.set(entry.paperId, [...(result.get(entry.paperId) ?? []), evidence]);
    }
  }
  for (const entries of result.values()) entries.sort((left, right) => left.entryId.localeCompare(right.entryId, "en"));
  return result;
}

function locatorLabel(entry: EvidencePackEntry): string {
  const parts = [
    entry.locator.section ? `section ${entry.locator.section}` : undefined,
    entry.locator.page === undefined ? undefined : `page ${entry.locator.page}`,
    entry.locator.paragraph === undefined ? undefined : `paragraph ${entry.locator.paragraph}`,
    entry.locator.characterStart === undefined ? undefined : `character ${entry.locator.characterStart}`,
  ].filter((value): value is string => value !== undefined);
  return parts.join(", ") || `${entry.locator.sourceId}:${entry.locator.recordId ?? entry.paperId}`;
}

function activeNodes(nodes: readonly LiteratureMapNode[]): LiteratureMapNode[] {
  return nodes
    .filter((node) => !node.tombstone && node.status !== "excluded" && node.status !== "irrelevant")
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function activeEdges(edges: readonly LiteratureMapEdge[], nodeIds: Set<string>): LiteratureMapEdge[] {
  return edges.filter((edge) => !edge.tombstone && nodeIds.has(edge.source) && nodeIds.has(edge.target));
}

