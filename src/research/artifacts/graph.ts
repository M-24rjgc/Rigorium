import {
  researchArtifactKey,
  type ResearchArtifactEnvelope,
  type ResearchArtifactInvalidation,
  type ResearchArtifactRef,
} from "./types.js";

export type ResearchArtifactGraph = Readonly<{
  artifacts: ReadonlyMap<string, ResearchArtifactEnvelope>;
  /** All parent relations, including immutable revision lineage. */
  children: ReadonlyMap<string, readonly string[]>;
  /** Only causal dependency relations; revision lineage never invalidates a replacement. */
  invalidationChildren: ReadonlyMap<string, readonly string[]>;
  roots: readonly string[];
  missingParents: readonly ResearchArtifactRef[];
}>;

export function buildResearchArtifactGraph(
  artifacts: readonly ResearchArtifactEnvelope[],
): ResearchArtifactGraph {
  const byKey = new Map<string, ResearchArtifactEnvelope>();
  const children = new Map<string, string[]>();
  const invalidationChildren = new Map<string, string[]>();
  const missingParents = new Map<string, ResearchArtifactRef>();

  for (const artifact of artifacts) {
    const key = researchArtifactKey(artifact);
    if (byKey.has(key)) throw new TypeError(`Research artifact ${key} is duplicated.`);
    byKey.set(key, artifact);
    children.set(key, []);
    invalidationChildren.set(key, []);
  }

  for (const artifact of artifacts) {
    const childKey = researchArtifactKey(artifact);
    for (const parent of artifact.parents) {
      const parentKey = researchArtifactKey(parent.artifact);
      const target = byKey.get(parentKey);
      if (!target) {
        missingParents.set(parentKey, parent.artifact);
        continue;
      }
      if (target.kind !== parent.artifact.kind || target.contentHash !== parent.artifact.contentHash) {
        throw new TypeError(`Research artifact parent ${parentKey} does not match its referenced kind or content hash.`);
      }
      children.get(parentKey)?.push(childKey);
      if (parent.relation !== "supersedes") invalidationChildren.get(parentKey)?.push(childKey);
    }
  }

  for (const entries of children.values()) entries.sort(compareText);
  for (const entries of invalidationChildren.values()) entries.sort(compareText);
  assertAcyclic(byKey, children);
  const roots = [...byKey.keys()]
    .filter((key) => (byKey.get(key)?.parents.length ?? 0) === 0)
    .sort(compareText);

  return Object.freeze({
    artifacts: byKey,
    children,
    invalidationChildren,
    roots,
    missingParents: [...missingParents.values()].sort(compareRefs),
  });
}

export function invalidateResearchArtifactDescendants(input: {
  artifacts: readonly ResearchArtifactEnvelope[];
  roots: readonly ResearchArtifactRef[];
  reason: ResearchArtifactInvalidation["reason"];
  now?: Date;
}): ResearchArtifactEnvelope[] {
  const graph = buildResearchArtifactGraph(input.artifacts);
  const changedKeys = new Set(input.roots.map(researchArtifactKey));
  const queue = [...changedKeys];
  const staleKeys = new Set<string>();

  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index];
    if (!key) continue;
    for (const childKey of graph.invalidationChildren.get(key) ?? []) {
      if (changedKeys.has(childKey) || staleKeys.has(childKey)) continue;
      staleKeys.add(childKey);
      queue.push(childKey);
    }
  }

  if (staleKeys.size === 0) return [...input.artifacts];
  const invalidatedAt = (input.now ?? new Date()).toISOString();
  const roots = input.roots.map((root) => Object.freeze({ ...root }));
  return input.artifacts.map((artifact) => {
    if (!staleKeys.has(researchArtifactKey(artifact)) || artifact.status !== "active") return artifact;
    return Object.freeze({
      ...artifact,
      status: "stale" as const,
      updatedAt: invalidatedAt,
      invalidation: Object.freeze({ invalidatedAt, reason: input.reason, roots }),
    });
  });
}

export function latestResearchArtifactRevisions(
  artifacts: readonly ResearchArtifactEnvelope[],
): ResearchArtifactEnvelope[] {
  const latest = new Map<string, ResearchArtifactEnvelope>();
  for (const artifact of artifacts) {
    const existing = latest.get(artifact.artifactId);
    if (!existing || artifact.revision > existing.revision) latest.set(artifact.artifactId, artifact);
  }
  return [...latest.values()].sort((left, right) => compareText(left.artifactId, right.artifactId));
}

function assertAcyclic(
  artifacts: ReadonlyMap<string, ResearchArtifactEnvelope>,
  children: ReadonlyMap<string, readonly string[]>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (key: string): void => {
    if (visiting.has(key)) throw new TypeError(`Research artifact graph contains a cycle at ${key}.`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const childKey of children.get(key) ?? []) visit(childKey);
    visiting.delete(key);
    visited.add(key);
  };

  for (const key of [...artifacts.keys()].sort(compareText)) visit(key);
}

function compareRefs(left: ResearchArtifactRef, right: ResearchArtifactRef): number {
  return compareText(researchArtifactKey(left), researchArtifactKey(right));
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}
