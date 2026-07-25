import {
  createResearchArtifact,
  LITERATURE_NOVELTY_RESCAN_ARTIFACT_KIND,
  type ResearchArtifactEnvelope,
  type ResearchArtifactParent,
  type ResearchArtifactProducer,
} from "../artifacts/index.js";
import type {
  LiteratureSearchResult,
  LiteratureSource,
  ResearchPaper,
  ResearchSourceStatus,
  SearchPlan,
} from "../types.js";
import { mergeLiteratureSearchResults } from "./candidatePool.js";

export const NOVELTY_RESCAN_LIMITS = {
  maxCandidates: 24,
  maxSources: 8,
  maxResultsPerSource: 50,
  maxQueryLength: 1_000,
  maxMatchesPerCandidate: 100,
} as const;

export type NoveltyRescanCandidate = Readonly<{
  id: string;
  summary: string;
  titleSeed?: string;
  /** Optional explicit query; otherwise summary and title seed are combined. */
  query?: string;
}>;

export type NoveltyRescanSource = Pick<LiteratureSource, "id" | "name" | "search">;

export type NoveltyRescanMatch = Readonly<{
  paperId: string;
  title: string;
  sourceIds: string[];
  relevance: number;
  citedByCount: number;
  year?: number;
  isOpenAccess?: boolean;
}>;

export type NoveltyRescanAssessment = Readonly<{
  candidateId: string;
  query: string;
  novelty: Readonly<{
    status: "gap_signal" | "crowded" | "not_established" | "insufficient_coverage";
    score: number;
    strongMatchCount: number;
    evidencePaperIds: string[];
  }>;
  value: Readonly<{
    status: "promising_signal" | "mixed_signal" | "weak_signal" | "insufficient_coverage";
    score: number;
    signals: Readonly<{
      relevance: number;
      crossSourceAgreement: number;
      citation: number;
      recency: number;
      openAccess: number;
    }>;
  }>;
  matches: readonly NoveltyRescanMatch[];
  sourceIds: string[];
  warnings: string[];
}>;

export type NoveltyRescanSourceAudit = Readonly<{
  id: string;
  name: string;
  status: "ok" | "error" | "disabled";
  resultCount: number;
  retrievedAt: string;
  queryCount: number;
  queryUrls: string[];
  error?: string;
}>;

export type NoveltyRescanResult = Readonly<{
  schemaVersion: 1;
  kind: "candidate_novelty_value_rescan";
  createdAt: string;
  candidates: readonly NoveltyRescanAssessment[];
  sources: readonly NoveltyRescanSourceAudit[];
  coverage: Readonly<{
    status: "complete" | "partial" | "failed";
    requestedSourceIds: string[];
    successfulSourceIds: string[];
    failedSourceIds: string[];
    warnings: string[];
  }>;
}>;

export type LiteratureNoveltyRescanPayload = Readonly<{
  schemaVersion: 1;
  kind: typeof LITERATURE_NOVELTY_RESCAN_ARTIFACT_KIND;
  rescan: NoveltyRescanResult;
}>;

export type LiteratureNoveltyRescanArtifact = ResearchArtifactEnvelope<
  typeof LITERATURE_NOVELTY_RESCAN_ARTIFACT_KIND,
  LiteratureNoveltyRescanPayload
>;

/**
 * Run a bounded, read-only novelty/value rescan for each candidate across all
 * configured providers. Every provider query and match remains traceable.
 */
export async function rescanCandidateDirections(input: {
  candidates: readonly NoveltyRescanCandidate[];
  sources: readonly NoveltyRescanSource[];
  limitPerSource?: number;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<NoveltyRescanResult> {
  const candidates = normalizeCandidates(input.candidates);
  const sources = normalizeSources(input.sources);
  const limit = boundedInteger(input.limitPerSource ?? 12, 1, NOVELTY_RESCAN_LIMITS.maxResultsPerSource, "limitPerSource");
  const now = input.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const allAudits = new Map<string, MutableSourceAudit>();
  const assessments: NoveltyRescanAssessment[] = [];
  const warnings: string[] = [];

  for (const candidate of candidates) {
    const query = candidate.query ?? [candidate.titleSeed, candidate.summary].filter(Boolean).join(" ").trim();
    const results: LiteratureSearchResult[] = [];
    for (const source of sources) {
      const audit = allAudits.get(source.id) ?? {
        id: source.id,
        name: source.name,
        status: "ok" as const,
        resultCount: 0,
        retrievedAt: createdAt,
        queryCount: 0,
        queryUrls: [],
      };
      audit.queryCount += 1;
      try {
        const result = await source.search(buildRescanPlan(query, source.id, limit), {
          ...(input.signal ? { signal: input.signal } : {}),
          now,
        });
        results.push(result);
        audit.resultCount += result.papers.length;
        audit.retrievedAt = result.source.retrievedAt;
        if (result.source.queryUrl) audit.queryUrls.push(result.source.queryUrl);
        if (result.source.status !== "ok") {
          audit.status = result.source.status;
          if (result.source.error) audit.error = result.source.error;
        }
      } catch (error) {
        audit.status = "error";
        audit.error = errorMessage(error);
        warnings.push(`${source.id}: ${audit.error}`);
        results.push(failedSearchResult(source, query, audit.error, now));
      }
      allAudits.set(source.id, audit);
      if (input.signal?.aborted) break;
    }
    const merged = mergeLiteratureSearchResults({
      requestedSourceIds: sources.map((source) => source.id),
      results,
      limit: Math.min(NOVELTY_RESCAN_LIMITS.maxMatchesPerCandidate, limit * Math.max(1, sources.length)),
      sourcePriority: sources.map((source) => source.id),
    });
    const candidateResult = assessCandidate(candidate, query, merged.papers, merged.sources, now().getUTCFullYear());
    assessments.push(candidateResult);
    warnings.push(...merged.coverage.warnings.map((warning) => `${candidate.id}: ${warning}`));
    if (input.signal?.aborted) break;
  }

  const sourcesAudit = [...allAudits.values()]
    .map((audit) => ({ ...audit, queryUrls: uniqueSorted(audit.queryUrls) }));
  const successfulSourceIds = sourcesAudit.filter((source) => source.status === "ok" && source.queryCount > 0).map((source) => source.id);
  const failedSourceIds = sourcesAudit.filter((source) => source.status !== "ok").map((source) => source.id);
  const status: NoveltyRescanResult["coverage"]["status"] = successfulSourceIds.length === 0
    ? "failed"
    : failedSourceIds.length > 0 || input.signal?.aborted
      ? "partial"
      : "complete";
  return Object.freeze({
    schemaVersion: 1,
    kind: "candidate_novelty_value_rescan" as const,
    createdAt,
    candidates: Object.freeze(assessments.sort((left, right) => left.candidateId.localeCompare(right.candidateId, "en"))),
    sources: Object.freeze(sourcesAudit),
    coverage: Object.freeze({
      status,
      requestedSourceIds: sources.map((source) => source.id),
      successfulSourceIds,
      failedSourceIds,
      warnings: uniqueSorted(warnings),
    }),
  });
}

/** Wrap a rescan in its own versioned literature artifact envelope. */
export function createLiteratureNoveltyRescanArtifact(input: {
  rescan: NoveltyRescanResult;
  producer: ResearchArtifactProducer;
  parents?: readonly ResearchArtifactParent[];
  artifactId?: string;
  revision?: number;
  now?: Date;
}): LiteratureNoveltyRescanArtifact {
  return createResearchArtifact({
    kind: LITERATURE_NOVELTY_RESCAN_ARTIFACT_KIND,
    payload: {
      schemaVersion: 1,
      kind: LITERATURE_NOVELTY_RESCAN_ARTIFACT_KIND,
      rescan: input.rescan,
    },
    producer: input.producer,
    ...(input.parents === undefined ? {} : { parents: input.parents }),
    ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    sources: input.rescan.sources.map((source) => ({
      sourceId: source.id,
      retrievedAt: source.retrievedAt,
      ...(source.queryUrls[0] ? { locator: source.queryUrls[0] } : {}),
    })),
    now: input.now,
  }) as LiteratureNoveltyRescanArtifact;
}

function assessCandidate(
  candidate: NoveltyRescanCandidate,
  query: string,
  papers: readonly ResearchPaper[],
  sources: readonly ResearchSourceStatus[],
  currentYear: number,
): NoveltyRescanAssessment {
  const queryTokens = tokens(query);
  const matches = papers
    .map((paper) => {
      const relevance = lexicalRelevance(queryTokens, paper);
      const sourceIds = uniqueSorted(paper.sourceIds.length > 0 ? paper.sourceIds : [paper.sourceId]);
      return {
        paperId: paper.id,
        title: paper.title,
        sourceIds,
        relevance,
        citedByCount: paper.citedByCount,
        ...(paper.year === undefined ? {} : { year: paper.year }),
        ...(paper.isOpenAccess === undefined ? {} : { isOpenAccess: paper.isOpenAccess }),
      } satisfies NoveltyRescanMatch;
    })
    .sort((left, right) => right.relevance - left.relevance || right.citedByCount - left.citedByCount || left.paperId.localeCompare(right.paperId, "en"))
    .slice(0, NOVELTY_RESCAN_LIMITS.maxMatchesPerCandidate);
  const strongMatches = matches.filter((match) => match.relevance >= 0.45);
  const successfulCount = sources.filter((source) => source.status === "ok").length;
  const requestedCount = sources.length;
  const coverageIncomplete = requestedCount === 0 || successfulCount < requestedCount;
  const noveltyStatus: NoveltyRescanAssessment["novelty"]["status"] = coverageIncomplete && successfulCount === 0
    ? "insufficient_coverage"
    : strongMatches.length >= 3
      ? "crowded"
      : strongMatches.length > 0
        ? "not_established"
        : "gap_signal";
  const relevance = average(matches.slice(0, 5).map((match) => match.relevance));
  const crossSourceAgreement = matches.length === 0 || requestedCount === 0
    ? 0
    : Math.min(1, Math.max(...matches.map((match) => match.sourceIds.length), 0) / requestedCount);
  const citation = percentileSignal(matches.map((match) => match.citedByCount), 100);
  const recency = average(matches.slice(0, 5).map((match) => match.year === undefined ? 0.4 : Math.max(0, 1 - Math.max(0, currentYear - match.year) / 15)));
  const openAccess = matches.length === 0 ? 0 : matches.filter((match) => match.isOpenAccess === true).length / matches.length;
  const valueScore = roundScore(0.45 * relevance + 0.2 * crossSourceAgreement + 0.15 * citation + 0.1 * recency + 0.1 * openAccess);
  const valueStatus: NoveltyRescanAssessment["value"]["status"] = coverageIncomplete && successfulCount === 0
    ? "insufficient_coverage"
    : valueScore >= 0.65
      ? "promising_signal"
      : valueScore >= 0.35
        ? "mixed_signal"
        : "weak_signal";
  return {
    candidateId: candidate.id,
    query,
    novelty: {
      status: noveltyStatus,
      score: roundScore(strongMatches.length === 0 ? 1 : Math.max(0, 1 - strongMatches.length / 5)),
      strongMatchCount: strongMatches.length,
      evidencePaperIds: strongMatches.map((match) => match.paperId),
    },
    value: {
      status: valueStatus,
      score: valueScore,
      signals: {
        relevance: roundScore(relevance),
        crossSourceAgreement: roundScore(crossSourceAgreement),
        citation: roundScore(citation),
        recency: roundScore(recency),
        openAccess: roundScore(openAccess),
      },
    },
    matches,
    sourceIds: uniqueSorted(matches.flatMap((match) => match.sourceIds)),
    warnings: coverageIncomplete
      ? [`${requestedCount - successfulCount} configured source(s) did not return usable coverage.`]
      : [],
  };
}

function buildRescanPlan(query: string, sourceId: string, limit: number): SearchPlan {
  const normalized = query.trim().slice(0, NOVELTY_RESCAN_LIMITS.maxQueryLength);
  return {
    query: normalized,
    mode: "broad",
    limit,
    sort: "relevance",
    sourceIds: [sourceId],
    queryVariants: [{ id: "primary", query: normalized, requestLimit: limit, category: "primary", provenance: { kind: "agent_selected" } }],
  };
}

function normalizeCandidates(value: readonly NoveltyRescanCandidate[]): NoveltyRescanCandidate[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > NOVELTY_RESCAN_LIMITS.maxCandidates) {
    throw new TypeError(`candidates must contain between 1 and ${NOVELTY_RESCAN_LIMITS.maxCandidates} entries.`);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError(`candidates[${index}] must be an object.`);
    const id = identifier(candidate.id, `candidates[${index}].id`);
    if (seen.has(id)) throw new TypeError(`Candidate ${id} is duplicated.`);
    seen.add(id);
    const summary = boundedText(candidate.summary, `candidates[${index}].summary`, NOVELTY_RESCAN_LIMITS.maxQueryLength);
    const titleSeed = candidate.titleSeed === undefined ? undefined : boundedText(candidate.titleSeed, `candidates[${index}].titleSeed`, NOVELTY_RESCAN_LIMITS.maxQueryLength);
    const query = candidate.query === undefined ? undefined : boundedText(candidate.query, `candidates[${index}].query`, NOVELTY_RESCAN_LIMITS.maxQueryLength);
    return { id, summary, ...(titleSeed === undefined ? {} : { titleSeed }), ...(query === undefined ? {} : { query }) };
  });
}

function normalizeSources(value: readonly NoveltyRescanSource[]): NoveltyRescanSource[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > NOVELTY_RESCAN_LIMITS.maxSources) {
    throw new TypeError(`sources must contain between 1 and ${NOVELTY_RESCAN_LIMITS.maxSources} entries.`);
  }
  const seen = new Set<string>();
  return value.map((source, index) => {
    if (!source || typeof source !== "object" || typeof source.search !== "function") throw new TypeError(`sources[${index}] must declare search.`);
    const id = identifier(source.id, `sources[${index}].id`);
    if (seen.has(id)) throw new TypeError(`Source ${id} is duplicated.`);
    seen.add(id);
    return { id, name: boundedText(source.name, `sources[${index}].name`, 256), search: source.search };
  });
}

function failedSearchResult(source: NoveltyRescanSource, query: string, error: string, now: () => Date): LiteratureSearchResult {
  const retrievedAt = now().toISOString();
  return {
    papers: [],
    edges: [],
    source: {
      id: source.id,
      name: source.name,
      status: "error",
      retrievedAt,
      resultCount: 0,
      coverage: `Novelty rescan query failed for ${source.name}.`,
      error: error.slice(0, 1_000),
      queryUrl: `rescan:${source.id}:${encodeURIComponent(query)}`,
    },
  };
}

function lexicalRelevance(queryTokens: ReadonlySet<string>, paper: ResearchPaper): number {
  if (queryTokens.size === 0) return 0;
  const paperTokens = tokens([paper.title, paper.abstract ?? "", ...paper.topics.map((topic) => topic.name)].join(" "));
  const overlap = [...queryTokens].filter((token) => paperTokens.has(token)).length;
  return overlap / queryTokens.size;
}

function tokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3));
}

function percentileSignal(values: readonly number[], scale: number): number {
  if (values.length === 0) return 0;
  return Math.min(1, Math.log1p(Math.max(...values, 0)) / Math.log1p(scale));
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000) / 1_000;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} must be between ${minimum} and ${maximum}.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256 || value.includes("\u0000")) throw new TypeError(`${label} must be a trimmed identifier.`);
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) throw new TypeError(`${label} must be bounded printable text.`);
  return value.trim();
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type MutableSourceAudit = {
  id: string;
  name: string;
  status: "ok" | "error" | "disabled";
  resultCount: number;
  retrievedAt: string;
  queryCount: number;
  queryUrls: string[];
  error?: string;
};
