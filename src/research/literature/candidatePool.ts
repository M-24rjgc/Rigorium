import {
  normalizeArxiv,
  normalizeArxivIdentifier,
  normalizeArxivVersion,
  normalizeDoi,
} from "../identity.js";
import type {
  LiteratureSearchResult,
  PaperIdentity,
  ResearchPaper,
  ResearchPaperProvenance,
  ResearchRelationEdge,
  ResearchSourceStatus,
} from "../types.js";

const RRF_K = 60;

export type LiteratureCandidatePoolInput = {
  requestedSourceIds: string[];
  results: LiteratureSearchResult[];
  limit: number;
  /** Lower positions win ties after reciprocal-rank fusion. */
  sourcePriority?: string[];
};

export type LiteratureCandidatePool = {
  papers: ResearchPaper[];
  edges: ResearchRelationEdge[];
  sources: ResearchSourceStatus[];
  coverage: {
    status: "complete" | "partial" | "failed";
    resultCount: number;
    warnings: string[];
    requestedSourceIds: string[];
    successfulSourceIds: string[];
    failedSourceIds: string[];
  };
};

type CandidateEntry = {
  paper: ResearchPaper;
  source: ResearchSourceStatus;
  stableOrder: number;
  provenance: ResearchPaperProvenance[];
  strongIdentifiers: Set<string>;
};

type CandidateGroup = {
  entries: CandidateEntry[];
  strongIdentifiers: Set<string>;
  stableOrder: number;
};

type MergedCandidate = {
  paper: ResearchPaper;
  entries: CandidateEntry[];
  rrfScore: number;
  sourcePriority: number;
  bestRank: number;
  stableOrder: number;
};

/**
 * Merge successful source results into one deterministic candidate pool.
 *
 * Strong identifiers always take precedence. The deliberately strict weak
 * matcher is used only when one side has no strong identifier, and requires
 * an exact normalized title, the same year, and the same first author.
 */
export function mergeLiteratureSearchResults(input: LiteratureCandidatePoolInput): LiteratureCandidatePool {
  const requestedSourceIds = uniqueStrings(input.requestedSourceIds);
  const sourcePriority = buildSourcePriority(input.sourcePriority ?? requestedSourceIds);
  const sourceById = new Map(input.results.map((result) => [result.source.id, result.source]));
  const sources = requestedSourceIds.map((id) => sourceById.get(id)).filter((source): source is ResearchSourceStatus => Boolean(source));
  const missingSourceIds = requestedSourceIds.filter((id) => !sourceById.has(id));
  const successfulSourceIds = requestedSourceIds.filter((id) => sourceById.get(id)?.status === "ok");
  const failedSourceIds = requestedSourceIds.filter((id) => sourceById.get(id)?.status !== "ok");
  for (const id of missingSourceIds) {
    failedSourceIds.push(id);
  }

  const warnings = sources.flatMap((source) => [
    ...(source.warnings ?? []).map((warning) => `${source.name}: ${warning}`),
    ...(source.status === "ok" ? [] : [`${source.name}: ${source.error ?? source.coverage}`]),
  ]);
  for (const id of missingSourceIds) {
    warnings.push(`${id}: source did not return a status.`);
  }

  const groups: CandidateGroup[] = [];
  let stableOrder = 0;
  for (const result of input.results) {
    if (result.source.status !== "ok") continue;
    for (let index = 0; index < result.papers.length; index += 1) {
      const paper = result.papers[index];
      const entry: CandidateEntry = {
        paper,
        source: result.source,
        stableOrder: stableOrder++,
        provenance: normalizeProvenance(paper, result.source, index + 1),
        strongIdentifiers: strongIdentifiers(paper),
      };
      addEntry(groups, entry);
    }
  }

  const merged = groups.map((group) => mergeCandidateGroup(group, sourcePriority));
  merged.sort((left, right) => compareMergedCandidates(left, right));
  const selected = merged.slice(0, Math.max(0, input.limit));
  const papers = selected.map((candidate) => candidate.paper);
  const edges = mergeEdges(input.results, selected);
  const coverageStatus = successfulSourceIds.length === 0
    ? "failed"
    : failedSourceIds.length > 0
      ? "partial"
      : "complete";

  return {
    papers,
    edges,
    sources,
    coverage: {
      status: coverageStatus,
      resultCount: papers.length,
      warnings,
      requestedSourceIds,
      successfulSourceIds,
      failedSourceIds: uniqueStrings(failedSourceIds),
    },
  };
}

function addEntry(groups: CandidateGroup[], entry: CandidateEntry): void {
  const strongMatches = groups.filter((group) => sharesIdentifier(entry.strongIdentifiers, group.strongIdentifiers));
  if (strongMatches.length > 0) {
    const target = strongMatches[0];
    target.entries.push(entry);
    addIdentifiers(target.strongIdentifiers, entry.strongIdentifiers);
    for (const duplicate of strongMatches.slice(1)) {
      target.entries.push(...duplicate.entries);
      addIdentifiers(target.strongIdentifiers, duplicate.strongIdentifiers);
      const index = groups.indexOf(duplicate);
      if (index >= 0) groups.splice(index, 1);
    }
    return;
  }

  // Do not use a weak match to bridge two groups. Exact identifiers are the
  // only safe way to merge an already-distinct pair of identifier clusters.
  const weakMatch = groups.find((group) => cautiouslyMatchesWeakly(entry, group));
  if (weakMatch) {
    weakMatch.entries.push(entry);
    addIdentifiers(weakMatch.strongIdentifiers, entry.strongIdentifiers);
    return;
  }

  groups.push({
    entries: [entry],
    strongIdentifiers: new Set(entry.strongIdentifiers),
    stableOrder: entry.stableOrder,
  });
}

function cautiouslyMatchesWeakly(entry: CandidateEntry, group: CandidateGroup): boolean {
  // If both sides have strong identifiers and none matched above, they are
  // conflicting records, even when titles happen to agree.
  if (entry.strongIdentifiers.size > 0 && group.strongIdentifiers.size > 0) return false;
  return group.entries.some((other) => {
    const leftTitle = normalizedTitle(entry.paper.title);
    const rightTitle = normalizedTitle(other.paper.title);
    if (!leftTitle || leftTitle !== rightTitle || leftTitle.length < 24) return false;
    if (entry.paper.year === undefined || other.paper.year === undefined || entry.paper.year !== other.paper.year) {
      return false;
    }
    const leftAuthor = normalizedAuthor(entry.paper.authors[0]);
    const rightAuthor = normalizedAuthor(other.paper.authors[0]);
    return Boolean(leftAuthor && rightAuthor && leftAuthor === rightAuthor);
  });
}

function mergeCandidateGroup(group: CandidateGroup, sourcePriority: Map<string, number>): MergedCandidate {
  const ordered = [...group.entries].sort((left, right) => compareEntries(left, right, sourcePriority));
  const primary = ordered.find((entry) => entry.paper.sourceId === "openalex") ?? ordered[0];
  const provenance = uniqueProvenance(ordered.flatMap((entry) => entry.provenance), sourcePriority);
  const sourceIds = orderedSourceIds(ordered, provenance, sourcePriority);
  const identities = mergeIdentities(ordered.map((entry) => entry.paper.identity));
  const doi = normalizeDoi(identities.doi ?? primary.paper.doi ?? firstDefined(ordered, (entry) => entry.paper.doi));
  if (doi) identities.doi = doi;

  const abstracts = ordered.map((entry) => entry.paper.abstract).filter((value): value is string => Boolean(value));
  const candidatesBySource = new Map<string, ResearchPaperProvenance>();
  for (const item of provenance) {
    const previous = candidatesBySource.get(item.sourceId);
    if (!previous || item.rank < previous.rank) candidatesBySource.set(item.sourceId, item);
  }
  const rrfScore = [...candidatesBySource.values()].reduce((score, item) => score + 1 / (RRF_K + item.rank), 0);
  const sourcePriorityValue = sourceIds.reduce((best, id) => Math.min(best, priorityOf(id, sourcePriority)), Number.MAX_SAFE_INTEGER);
  const bestRank = provenance.reduce((best, item) => Math.min(best, item.rank), Number.MAX_SAFE_INTEGER);

  const paper: ResearchPaper = {
    id: primary.paper.id,
    identity: identities,
    title: primary.paper.title,
    authors: longestArray(ordered.map((entry) => entry.paper.authors), primary.paper.authors),
    ...(firstDefined(ordered, (entry) => entry.paper.year) !== undefined
      ? { year: firstDefined(ordered, (entry) => entry.paper.year) }
      : {}),
    ...(firstDefined(ordered, (entry) => entry.paper.publicationDate)
      ? { publicationDate: firstDefined(ordered, (entry) => entry.paper.publicationDate) }
      : {}),
    ...(firstDefined(ordered, (entry) => entry.paper.updatedAt)
      ? { updatedAt: firstDefined(ordered, (entry) => entry.paper.updatedAt) }
      : {}),
    ...(firstDefined(ordered, (entry) => entry.paper.type) ? { type: firstDefined(ordered, (entry) => entry.paper.type) } : {}),
    ...(firstDefined(ordered, (entry) => entry.paper.venue) ? { venue: firstDefined(ordered, (entry) => entry.paper.venue) } : {}),
    ...(doi ? { doi } : {}),
    ...(firstDefined(ordered, (entry) => entry.paper.url) ? { url: firstDefined(ordered, (entry) => entry.paper.url) } : {}),
    citedByCount: Math.max(...ordered.map((entry) => entry.paper.citedByCount), 0),
    ...mergedOpenAccess(ordered.map((entry) => entry.paper.isOpenAccess)),
    ...(longestString(abstracts) ? { abstract: longestString(abstracts) } : {}),
    topics: mergeTopics(ordered.map((entry) => entry.paper.topics)),
    referencedWorkIds: uniqueStrings(ordered.flatMap((entry) => entry.paper.referencedWorkIds)),
    sourceId: primary.paper.sourceId,
    sourceIds,
    provenance,
  };

  return {
    paper,
    entries: ordered,
    rrfScore,
    sourcePriority: sourcePriorityValue,
    bestRank,
    stableOrder: group.stableOrder,
  };
}

function mergeEdges(results: LiteratureSearchResult[], selected: MergedCandidate[]): ResearchRelationEdge[] {
  const visibleIds = new Set(selected.map((candidate) => candidate.paper.id));
  const mappedIds = new Map<string, string>();
  for (const candidate of selected) {
    for (const entry of candidate.entries) mappedIds.set(entry.paper.id, candidate.paper.id);
  }

  const deduplicated = new Map<string, ResearchRelationEdge>();
  for (const result of results) {
    if (result.source.status !== "ok") continue;
    for (const edge of result.edges) {
      const source = mappedIds.get(edge.source);
      const target = mappedIds.get(edge.target);
      if (!source || !target || source === target || !visibleIds.has(source) || !visibleIds.has(target)) continue;
      const unchanged = source === edge.source && target === edge.target;
      const normalized: ResearchRelationEdge = unchanged
        ? edge
        : { ...edge, id: `${edge.type}:${source}:${target}`, source, target };
      const key = `${normalized.type}\u0000${normalized.source}\u0000${normalized.target}`;
      const previous = deduplicated.get(key);
      deduplicated.set(key, chooseEdge(previous, normalized));
    }
  }
  return [...deduplicated.values()].sort((left, right) => compareText(left.id, right.id));
}

function chooseEdge(previous: ResearchRelationEdge | undefined, candidate: ResearchRelationEdge): ResearchRelationEdge {
  if (!previous) return candidate;
  if (previous.inferred !== candidate.inferred) return previous.inferred ? candidate : previous;
  if (candidate.weight > previous.weight) return candidate;
  const evidence = uniqueStrings([...(previous.evidence ?? []), ...(candidate.evidence ?? [])]);
  return evidence.length === (previous.evidence?.length ?? 0) ? previous : { ...previous, evidence };
}

function normalizeProvenance(
  paper: ResearchPaper,
  source: ResearchSourceStatus,
  fallbackRank: number,
): ResearchPaperProvenance[] {
  const supplied = paper.provenance.filter((item) => item.sourceId === source.id && Number.isFinite(item.rank) && item.rank > 0);
  if (supplied.length > 0) return supplied;
  return [{
    sourceId: source.id,
    sourceRecordId: paper.id,
    rank: fallbackRank,
    retrievedAt: source.retrievedAt,
    ...(source.queryUrl ? { queryUrl: source.queryUrl } : {}),
  }];
}

function uniqueProvenance(items: ResearchPaperProvenance[], sourcePriority: Map<string, number>): ResearchPaperProvenance[] {
  const byRecord = new Map<string, ResearchPaperProvenance>();
  for (const item of items) {
    const normalized: ResearchPaperProvenance = {
      sourceId: item.sourceId,
      ...(item.sourceRecordId ? { sourceRecordId: item.sourceRecordId } : {}),
      rank: Math.max(1, Math.round(item.rank)),
      retrievedAt: item.retrievedAt,
      ...(item.queryUrl ? { queryUrl: item.queryUrl } : {}),
    };
    const key = `${normalized.sourceId}\u0000${normalized.sourceRecordId ?? ""}`;
    const previous = byRecord.get(key);
    if (!previous || normalized.rank < previous.rank) byRecord.set(key, normalized);
  }
  return [...byRecord.values()].sort((left, right) => {
    const priority = priorityOf(left.sourceId, sourcePriority) - priorityOf(right.sourceId, sourcePriority);
    if (priority !== 0) return priority;
    if (left.rank !== right.rank) return left.rank - right.rank;
    return compareText(left.sourceRecordId ?? "", right.sourceRecordId ?? "");
  });
}

function orderedSourceIds(
  entries: CandidateEntry[],
  provenance: ResearchPaperProvenance[],
  sourcePriority: Map<string, number>,
): string[] {
  return uniqueStrings([
    ...entries.flatMap((entry) => [entry.paper.sourceId, ...entry.paper.sourceIds]),
    ...provenance.map((item) => item.sourceId),
  ]).sort((left, right) => {
    const priority = priorityOf(left, sourcePriority) - priorityOf(right, sourcePriority);
    return priority !== 0 ? priority : compareText(left, right);
  });
}

function mergeIdentities(identities: PaperIdentity[]): PaperIdentity {
  const merged: PaperIdentity = {};
  const other: Record<string, string> = {};
  for (const identity of identities) {
    if (!merged.openAlexId && identity.openAlexId) merged.openAlexId = identity.openAlexId;
    if (!merged.doi && identity.doi) merged.doi = normalizeDoi(identity.doi) ?? identity.doi;
    const directArxiv = normalizeArxivIdentifier(identity.arxiv);
    const legacyArxiv = legacyArxivIdentifier(identity.other);
    const arxiv = directArxiv ?? legacyArxiv;
    if (!merged.arxiv && arxiv) merged.arxiv = arxiv.id;
    if (arxiv && arxiv.id === merged.arxiv) {
      const arxivVersion = Math.max(
        normalizeArxivVersion(identity.arxivVersion) ?? 0,
        directArxiv?.version ?? 0,
        legacyArxiv?.version ?? 0,
      );
      if (arxivVersion > 0 && (merged.arxivVersion === undefined || arxivVersion > merged.arxivVersion)) {
        merged.arxivVersion = arxivVersion;
      }
    }
    if (!merged.openReview && identity.openReview) merged.openReview = identity.openReview;
    if (!merged.pmid && identity.pmid) merged.pmid = identity.pmid;
    if (!merged.pmcid && identity.pmcid) merged.pmcid = identity.pmcid;
    if (!merged.zoteroKey && identity.zoteroKey) merged.zoteroKey = identity.zoteroKey;
    for (const [key, value] of Object.entries(identity.other ?? {})) {
      if (key.toLowerCase() === "arxiv") continue;
      if (!(key in other)) other[key] = value;
    }
  }
  if (Object.keys(other).length > 0) merged.other = other;
  return merged;
}

function mergeTopics(topicLists: ResearchPaper["topics"][]): ResearchPaper["topics"] {
  const topics = new Map<string, ResearchPaper["topics"][number]>();
  for (const topic of topicLists.flat()) {
    const previous = topics.get(topic.id);
    if (!previous || (topic.score ?? 0) > (previous.score ?? 0)) topics.set(topic.id, topic);
  }
  return [...topics.values()].sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || compareText(left.id, right.id));
}

function mergedOpenAccess(values: Array<boolean | undefined>): Pick<ResearchPaper, "isOpenAccess"> | Record<string, never> {
  if (values.some((value) => value === true)) return { isOpenAccess: true };
  if (values.some((value) => value === false)) return { isOpenAccess: false };
  return {};
}

function strongIdentifiers(paper: ResearchPaper): Set<string> {
  const identity = paper.identity;
  const arxiv = normalizeArxiv(identity.arxiv) ?? legacyArxivIdentifier(identity.other)?.id;
  const identifiers = [
    normalizeDoi(identity.doi ?? paper.doi) ? `doi:${normalizeDoi(identity.doi ?? paper.doi)}` : undefined,
    arxiv ? `arxiv:${arxiv}` : undefined,
    normalizedValue(identity.openReview) ? `openreview:${normalizedValue(identity.openReview)}` : undefined,
    normalizedValue(identity.pmid) ? `pmid:${normalizedValue(identity.pmid)}` : undefined,
    normalizedValue(identity.pmcid) ? `pmcid:${normalizedValue(identity.pmcid)}` : undefined,
    normalizedValue(identity.openAlexId) ? `openalex:${normalizedValue(identity.openAlexId)}` : undefined,
    normalizedValue(identity.zoteroKey) ? `zotero:${normalizedValue(identity.zoteroKey)}` : undefined,
    ...Object.entries(identity.other ?? {}).flatMap(([key, value]) => {
      const normalizedKey = normalizedValue(key);
      const normalized = normalizedValue(value);
      if (normalizedKey === "arxiv") return [];
      return normalizedKey && normalized ? [`other:${normalizedKey}:${normalized}`] : [];
    }),
  ];
  return new Set(identifiers.filter((value): value is string => Boolean(value)));
}

function normalizedValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function legacyArxivIdentifier(other: Record<string, string> | undefined) {
  if (!other) return undefined;
  for (const [key, value] of Object.entries(other)) {
    if (key.toLowerCase() === "arxiv") return normalizeArxivIdentifier(value);
  }
  return undefined;
}

function normalizedTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function normalizedAuthor(value: string | undefined): string | undefined {
  return value ? normalizedTitle(value) : undefined;
}

function sharesIdentifier(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function addIdentifiers(target: Set<string>, values: Set<string>): void {
  for (const value of values) target.add(value);
}

function compareMergedCandidates(left: MergedCandidate, right: MergedCandidate): number {
  if (right.rrfScore !== left.rrfScore) return right.rrfScore - left.rrfScore;
  if (left.sourcePriority !== right.sourcePriority) return left.sourcePriority - right.sourcePriority;
  if (left.bestRank !== right.bestRank) return left.bestRank - right.bestRank;
  if (right.paper.citedByCount !== left.paper.citedByCount) return right.paper.citedByCount - left.paper.citedByCount;
  const title = compareText(left.paper.title, right.paper.title);
  return title !== 0 ? title : compareText(left.paper.id, right.paper.id);
}

function compareEntries(left: CandidateEntry, right: CandidateEntry, sourcePriority: Map<string, number>): number {
  const leftRank = earliestRank(left.provenance);
  const rightRank = earliestRank(right.provenance);
  const priority = priorityOf(left.paper.sourceId, sourcePriority) - priorityOf(right.paper.sourceId, sourcePriority);
  if (priority !== 0) return priority;
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.stableOrder !== right.stableOrder) return left.stableOrder - right.stableOrder;
  return compareText(left.paper.id, right.paper.id);
}

function earliestRank(provenance: ResearchPaperProvenance[]): number {
  return provenance.reduce((best, item) => Math.min(best, item.rank), Number.MAX_SAFE_INTEGER);
}

function buildSourcePriority(sourceIds: string[]): Map<string, number> {
  const priorities = new Map<string, number>();
  for (const id of sourceIds) {
    if (!priorities.has(id)) priorities.set(id, priorities.size);
  }
  return priorities;
}

function priorityOf(sourceId: string, priorities: Map<string, number>): number {
  return priorities.get(sourceId) ?? Number.MAX_SAFE_INTEGER - 1;
}

function firstDefined<T>(entries: CandidateEntry[], pick: (entry: CandidateEntry) => T | undefined): T | undefined {
  for (const entry of entries) {
    const value = pick(entry);
    if (value !== undefined) return value;
  }
  return undefined;
}

function longestArray(values: string[][], fallback: string[]): string[] {
  return values.reduce((best, value) => value.length > best.length ? value : best, fallback);
}

function longestString(values: string[]): string | undefined {
  return values.reduce<string | undefined>((best, value) => !best || value.length > best.length ? value : best, undefined);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
