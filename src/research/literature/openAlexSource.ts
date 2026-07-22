import { networkFetch } from "../../network/fetch.js";
import { normalizeArxivIdentifier, normalizeDoi } from "../identity.js";
import { sanitizeRetrievalUrl } from "./terminology.js";
import type {
  LiteratureSearchResult,
  LiteratureSource,
  LiteratureTerminologySourceObservation,
  LiteratureTerminologySourceRecord,
  ResearchPaper,
  ResearchPaperProvenance,
  ResearchRelationEdge,
  ResearchSourceRateLimit,
  ResearchSourceStatus,
  ResearchTopic,
  SearchPlan,
} from "../types.js";

export type CreateOpenAlexSourceOptions = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  mailto?: string;
  includeTopicEdges?: boolean;
};

const DEFAULT_ENDPOINT = "https://api.openalex.org/works";
const DEFAULT_TIMEOUT_MS = 20_000;
const OPENALEX_TRANSIENT_RETRY_STATUSES = [408, 409, 425, 500, 502, 503, 504] as const;
/** Citation-expansion projection. Keep this stable and payload-minimal. */
export const OPENALEX_WORK_FIELDS = [
  "id",
  "doi",
  "title",
  "display_name",
  "publication_year",
  "publication_date",
  "type",
  "cited_by_count",
  "authorships",
  "primary_location",
  "open_access",
  "topics",
  "referenced_works",
  "ids",
  "abstract_inverted_index",
].join(",");
/** Search-only projection with terminology metadata unavailable to expansion. */
export const OPENALEX_SEARCH_FIELDS = [
  OPENALEX_WORK_FIELDS,
  "keywords",
  "primary_topic",
  "is_paratext",
].join(",");

export function createOpenAlexSource(options: CreateOpenAlexSourceOptions = {}): LiteratureSource {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: "openalex",
    name: "OpenAlex",
    async search(plan, context = {}) {
      const retrievedAt = (context.now?.() ?? new Date()).toISOString();
      const url = buildOpenAlexUrl(endpoint, plan, options.mailto);
      const persistedQueryUrl = sanitizeRetrievalUrl(url.toString());
      let responseRateLimit: ResearchSourceRateLimit | undefined;

      try {
        const response = await networkFetch(url.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": "Rigorium/0.1 (local research workspace)",
          },
          signal: context.signal,
        }, {
          timeoutMs,
          signal: context.signal,
          fetchImpl,
          // 429 carries quota state. Never let a bounded generic retry issue
          // an early follow-up request before the provider permits it.
          retry: {
            maxRetries: 2,
            baseDelayMs: 500,
            maxDelayMs: 4_000,
            retryStatuses: OPENALEX_TRANSIENT_RETRY_STATUSES,
          },
        });
        responseRateLimit = openAlexRateLimit(response.headers);

        if (!response.ok) {
          const detail = await response.text().catch(() => response.statusText);
          return failedResult(
            retrievedAt,
            url,
            `OpenAlex API error (${response.status}): ${truncate(detail, 400)}`,
            responseRateLimit,
          );
        }

        const parsed = await response.json() as unknown;
        const raw = isRecord(parsed) ? parsed : {};
        const works = Array.isArray(raw.results) ? raw.results : [];
        const papers: ResearchPaper[] = [];
        const terminologyObservations: LiteratureTerminologySourceObservation[] = [];
        for (let index = 0; index < works.length; index += 1) {
          const work = works[index];
          if (!isRecord(work)) continue;
          const paper = normalizeOpenAlexWork(work as OpenAlexWork, {
            rank: index + 1,
            retrievedAt,
            ...(persistedQueryUrl ? { queryUrl: persistedQueryUrl } : {}),
          });
          if (!paper) continue;
          papers.push(paper);
          const observation = observeOpenAlexTerminology(work as OpenAlexWork, {
            sourcePaperId: paper.id,
            retrievedAt,
            retrievalUrl: persistedQueryUrl,
          });
          if (observation) terminologyObservations.push(observation);
        }
        const edges = buildRelationshipEdges(papers, options.includeTopicEdges !== false);
        const source: ResearchSourceStatus = {
          id: "openalex",
          name: "OpenAlex",
          status: "ok",
          retrievedAt,
          ...(persistedQueryUrl ? { queryUrl: persistedQueryUrl } : {}),
          resultCount: papers.length,
          totalMatches: nonNegativeFiniteNumber(isRecord(raw.meta) ? raw.meta.count : undefined),
          coverage: openAlexCoverage("Ranked OpenAlex metadata results for the submitted query and filters.", responseRateLimit),
          ...(responseRateLimit ? { rateLimit: responseRateLimit } : {}),
        };
        return {
          papers,
          edges,
          source,
          ...(terminologyObservations.length > 0 ? { terminologyObservations } : {}),
        };
      } catch (error) {
        return failedResult(
          retrievedAt,
          url,
          `OpenAlex request failed: ${error instanceof Error ? error.message : String(error)}`,
          responseRateLimit,
        );
      }
    },
  };
}

function buildOpenAlexUrl(endpoint: string, plan: SearchPlan, mailto?: string): URL {
  const url = new URL(endpoint);
  url.searchParams.set("search", plan.query);
  url.searchParams.set("per-page", String(plan.limit));
  url.searchParams.set("select", OPENALEX_SEARCH_FIELDS);
  if (mailto?.trim()) url.searchParams.set("mailto", mailto.trim());

  const filters: string[] = [];
  if (plan.fromYear) filters.push(`from_publication_date:${plan.fromYear}-01-01`);
  if (plan.toYear) filters.push(`to_publication_date:${plan.toYear}-12-31`);
  if (filters.length > 0) url.searchParams.set("filter", filters.join(","));
  if (plan.sort === "cited_by_count") url.searchParams.set("sort", "cited_by_count:desc");
  if (plan.sort === "publication_date") url.searchParams.set("sort", "publication_date:desc");
  return url;
}

export function normalizeOpenAlexWork(
  work: OpenAlexWork,
  provenance: Omit<ResearchPaperProvenance, "sourceId" | "sourceRecordId">,
): ResearchPaper | null {
  const id = stringValue(work.id);
  const title = stringValue(work.display_name) ?? stringValue(work.title);
  if (!id || !title) return null;

  const ids = isRecord(work.ids) ? work.ids : {};
  const doiUrl = stringValue(work.doi) ?? stringValue(ids.doi);
  const doi = normalizeDoi(doiUrl);
  const arxiv = normalizeArxivIdentifier(ids.arxiv);
  const paperUrl = safeHttpUrl(doiUrl)
    ?? safeHttpUrl(isRecord(work.primary_location) ? work.primary_location.landing_page_url : undefined)
    ?? safeHttpUrl(id);
  const authors = Array.isArray(work.authorships)
    ? work.authorships
        .map((authorship) => isRecord(authorship) && isRecord(authorship.author)
          ? stringValue(authorship.author.display_name)
          : undefined)
        .filter((name): name is string => Boolean(name))
    : [];
  const primaryLocation = isRecord(work.primary_location) ? work.primary_location : {};
  const source = isRecord(primaryLocation.source) ? primaryLocation.source : {};
  const openAccess = isRecord(work.open_access) ? work.open_access : {};
  const topics = normalizeTopics(work.topics);
  const referencedWorkIds = Array.isArray(work.referenced_works)
    ? work.referenced_works.filter((value): value is string => typeof value === "string").slice(0, 500)
    : [];

  const other: Record<string, string> = {};
  for (const [key, value] of Object.entries(ids)) {
    if (["openalex", "doi", "arxiv", "pmid", "pmcid"].includes(key)) continue;
    if (typeof value === "string") other[key] = value;
  }

  return {
    id,
    identity: {
      openAlexId: id,
      ...(doi ? { doi } : {}),
      ...(arxiv ? {
        arxiv: arxiv.id,
        ...(arxiv.version !== undefined ? { arxivVersion: arxiv.version } : {}),
      } : {}),
      ...(normalizeExternalId(ids.pmid, "pmid") ? { pmid: normalizeExternalId(ids.pmid, "pmid") } : {}),
      ...(normalizeExternalId(ids.pmcid, "pmcid") ? { pmcid: normalizeExternalId(ids.pmcid, "pmcid") } : {}),
      ...(Object.keys(other).length > 0 ? { other } : {}),
    },
    title,
    authors,
    ...(finiteNumber(work.publication_year) ? { year: finiteNumber(work.publication_year) } : {}),
    ...(stringValue(work.publication_date) ? { publicationDate: stringValue(work.publication_date) } : {}),
    ...(stringValue(work.type) ? { type: stringValue(work.type) } : {}),
    ...(stringValue(source.display_name) ? { venue: stringValue(source.display_name) } : {}),
    ...(doi ? { doi } : {}),
    ...(paperUrl ? { url: paperUrl } : {}),
    citedByCount: nonNegativeFiniteNumber(work.cited_by_count) ?? 0,
    ...(typeof openAccess.is_oa === "boolean" ? { isOpenAccess: openAccess.is_oa } : {}),
    ...(reconstructAbstract(work.abstract_inverted_index) ? { abstract: reconstructAbstract(work.abstract_inverted_index) } : {}),
    topics,
    referencedWorkIds,
    sourceId: "openalex",
    sourceIds: ["openalex"],
    provenance: [{
      sourceId: "openalex",
      sourceRecordId: id,
      ...provenance,
    }],
  };
}

/**
 * Capture only provider-native terminology fields from an unmerged OpenAlex
 * work response. The candidate pool later maps `sourcePaperId` to a visible
 * final paper, which prevents rejected source results from contributing terms.
 */
export function observeOpenAlexTerminology(
  work: OpenAlexWork,
  context: {
    sourcePaperId: string;
    retrievedAt: string;
    retrievalUrl?: string;
  },
): LiteratureTerminologySourceObservation | undefined {
  if (work.is_paratext === true) return undefined;
  const sourcePaperId = stringValue(context.sourcePaperId);
  const retrievalUrl = sanitizeRetrievalUrl(context.retrievalUrl);
  if (!sourcePaperId || !retrievalUrl) return undefined;
  const primaryTopic = normalizeTerminologyRecord(work.primary_topic);
  const keywords = normalizeTerminologyRecords(work.keywords);
  const topics = normalizeTerminologyRecords(work.topics);
  return {
    providerId: "openalex",
    sourcePaperId,
    retrievalUrl,
    retrievedAt: context.retrievedAt,
    isParatext: false,
    keywords: keywords.records,
    topics: topics.records,
    fieldCounts: {
      keywords: keywords.fieldCounts,
      topics: topics.fieldCounts,
    },
    ...(primaryTopic ? { primaryTopic } : {}),
  };
}

function normalizeTerminologyRecords(value: unknown): {
  records: LiteratureTerminologySourceRecord[];
  fieldCounts: { sourceRecordCount: number; invalidRecordCount: number };
} {
  const entries = Array.isArray(value) ? value : [];
  const records: LiteratureTerminologySourceRecord[] = [];
  let invalidRecordCount = 0;
  for (const entry of entries) {
    const record = normalizeTerminologyRecord(entry);
    if (record) records.push(record);
    else invalidRecordCount += 1;
  }
  return {
    records,
    fieldCounts: { sourceRecordCount: entries.length, invalidRecordCount },
  };
}

function normalizeTerminologyRecord(value: unknown): LiteratureTerminologySourceRecord | undefined {
  if (!isRecord(value)) return undefined;
  const providerRecordId = stringValue(value.id);
  const text = stringValue(value.display_name) ?? stringValue(value.name);
  if (!providerRecordId || !text) return undefined;
  const score = normalizedTerminologyScore(value.score);
  if (score === undefined) return undefined;
  const providerUrl = sanitizeRetrievalUrl(
    safeHttpUrl(value.url) ?? safeHttpUrl(value.id),
  );
  if (!providerUrl) return undefined;
  const subfield = normalizeTaxonomyLevelRecord(value.subfield);
  const field = normalizeTaxonomyLevelRecord(value.field);
  return {
    providerRecordId,
    text,
    providerUrl,
    score,
    ...(subfield ? { subfield } : {}),
    ...(field ? { field } : {}),
  };
}

function normalizeTaxonomyLevelRecord(value: unknown): {
  providerRecordId: string;
  text: string;
  providerUrl?: string;
} | undefined {
  if (!isRecord(value)) return undefined;
  const providerRecordId = stringValue(value.id);
  const text = stringValue(value.display_name) ?? stringValue(value.name);
  if (!providerRecordId || !text) return undefined;
  const providerUrl = sanitizeRetrievalUrl(
    safeHttpUrl(value.url) ?? safeHttpUrl(value.id),
  );
  if (!providerUrl) return undefined;
  return {
    providerRecordId,
    text,
    providerUrl,
  };
}

function normalizedTerminologyScore(value: unknown): number | undefined {
  const score = finiteNumber(value);
  return score !== undefined && score >= 0 && score <= 1 ? score : undefined;
}

function buildRelationshipEdges(papers: ResearchPaper[], includeTopicEdges: boolean): ResearchRelationEdge[] {
  const paperIds = new Set(papers.map((paper) => paper.id));
  const edges: ResearchRelationEdge[] = [];
  const connectedPairs = new Set<string>();

  for (const paper of papers) {
    for (const referencedId of paper.referencedWorkIds) {
      if (!paperIds.has(referencedId) || referencedId === paper.id) continue;
      const pair = unorderedPair(paper.id, referencedId);
      connectedPairs.add(pair);
      edges.push({
        id: `citation:${paper.id}:${referencedId}`,
        source: paper.id,
        target: referencedId,
        type: "citation",
        weight: 1,
        inferred: false,
      });
    }
  }

  if (!includeTopicEdges) return edges;

  const candidates: ResearchRelationEdge[] = [];
  for (let left = 0; left < papers.length; left += 1) {
    for (let right = left + 1; right < papers.length; right += 1) {
      const a = papers[left];
      const b = papers[right];
      const pair = unorderedPair(a.id, b.id);
      if (connectedPairs.has(pair)) continue;
      const shared = sharedTopics(a.topics, b.topics);
      if (shared.length === 0) continue;
      candidates.push({
        id: `topic:${a.id}:${b.id}`,
        source: a.id,
        target: b.id,
        type: "shared_topic",
        weight: shared.reduce((sum, topic) => sum + (topic.score ?? 0.5), 0),
        inferred: true,
        evidence: shared.slice(0, 3).map((topic) => topic.name),
      });
    }
  }

  candidates.sort((a, b) => b.weight - a.weight);
  const topicDegree = new Map<string, number>();
  for (const edge of candidates) {
    if ((topicDegree.get(edge.source) ?? 0) >= 2 || (topicDegree.get(edge.target) ?? 0) >= 2) continue;
    edges.push(edge);
    topicDegree.set(edge.source, (topicDegree.get(edge.source) ?? 0) + 1);
    topicDegree.set(edge.target, (topicDegree.get(edge.target) ?? 0) + 1);
    if (edges.length >= papers.length * 3) break;
  }
  return edges;
}

function normalizeTopics(value: unknown): ResearchTopic[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = stringValue(entry.id);
    const name = stringValue(entry.display_name);
    if (!id || !name) return [];
    return [{ id, name, ...(finiteNumber(entry.score) ? { score: finiteNumber(entry.score) } : {}) }];
  });
}

function sharedTopics(left: ResearchTopic[], right: ResearchTopic[]): ResearchTopic[] {
  const rightIds = new Set(right.map((topic) => topic.id));
  return left.filter((topic) => rightIds.has(topic.id));
}

function reconstructAbstract(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const words: Array<{ position: number; word: string }> = [];
  for (const [word, positions] of Object.entries(value)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (typeof position === "number" && Number.isFinite(position)) words.push({ position, word });
    }
  }
  if (words.length === 0) return undefined;
  const abstract = words.sort((a, b) => a.position - b.position).map((entry) => entry.word).join(" ");
  return truncate(abstract, 1_200);
}

function failedResult(
  retrievedAt: string,
  url: URL,
  error: string,
  rateLimit?: ResearchSourceRateLimit,
): LiteratureSearchResult {
  const queryUrl = sanitizeRetrievalUrl(url.toString());
  return {
    papers: [],
    edges: [],
    source: {
      id: "openalex",
      name: "OpenAlex",
      status: "error",
      retrievedAt,
      ...(queryUrl ? { queryUrl } : {}),
      resultCount: 0,
      coverage: openAlexCoverage("OpenAlex did not return usable results for this request.", rateLimit),
      ...(rateLimit ? { rateLimit } : {}),
      error,
    },
  };
}

function openAlexRateLimit(headers: Headers): ResearchSourceRateLimit | undefined {
  const limit = nonNegativeHeaderNumber(headers, "x-ratelimit-limit");
  const remaining = nonNegativeHeaderNumber(headers, "x-ratelimit-remaining");
  const resetSeconds = nonNegativeHeaderNumber(headers, "x-ratelimit-reset");
  const retryAfter = retryAfterSeconds(headers.get("retry-after"));
  const costUsd = nonNegativeHeaderNumber(headers, "x-ratelimit-cost-usd");
  const remainingUsd = nonNegativeHeaderNumber(headers, "x-ratelimit-remaining-usd");
  const rateLimit: ResearchSourceRateLimit = {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(resetSeconds !== undefined ? { resetSeconds } : {}),
    ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(remainingUsd !== undefined ? { remainingUsd } : {}),
  };
  return Object.keys(rateLimit).length > 0 ? rateLimit : undefined;
}

function nonNegativeHeaderNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (!raw?.trim()) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const numeric = Number(value.trim());
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000));
}

function openAlexCoverage(base: string, rateLimit: ResearchSourceRateLimit | undefined): string {
  if (!rateLimit) return base;
  const details = [
    rateLimit.limit !== undefined ? `limit ${rateLimit.limit}` : undefined,
    rateLimit.remaining !== undefined ? `remaining ${rateLimit.remaining}` : undefined,
    rateLimit.resetSeconds !== undefined ? `reset in ${rateLimit.resetSeconds}s` : undefined,
    rateLimit.retryAfterSeconds !== undefined ? `retry after ${rateLimit.retryAfterSeconds}s` : undefined,
    rateLimit.costUsd !== undefined ? `cost USD ${rateLimit.costUsd}` : undefined,
    rateLimit.remainingUsd !== undefined ? `remaining USD ${rateLimit.remainingUsd}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return details.length > 0 ? `${base} OpenAlex rate limit: ${details.join(", ")}.` : base;
}

function safeHttpUrl(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeExternalId(value: unknown, prefix: string): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  const marker = `${prefix}:`;
  const index = text.toLowerCase().lastIndexOf(marker);
  return index >= 0 ? text.slice(index + marker.length) : text;
}

function unorderedPair(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

type OpenAlexResponse = {
  meta?: { count?: unknown };
  results?: OpenAlexWork[];
};

export type OpenAlexWork = Record<string, unknown> & {
  id?: unknown;
  doi?: unknown;
  title?: unknown;
  display_name?: unknown;
  publication_year?: unknown;
  publication_date?: unknown;
  type?: unknown;
  cited_by_count?: unknown;
  authorships?: unknown;
  primary_location?: unknown;
  open_access?: unknown;
  topics?: unknown;
  keywords?: unknown;
  primary_topic?: unknown;
  is_paratext?: unknown;
  referenced_works?: unknown;
  ids?: unknown;
  abstract_inverted_index?: unknown;
};
