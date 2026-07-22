import { networkFetch } from "../../network/fetch.js";
import { normalizeArxivIdentifier, normalizeDoi } from "../identity.js";
import type {
  LiteratureSearchResult,
  LiteratureSource,
  ResearchPaper,
  ResearchPaperProvenance,
  ResearchRelationEdge,
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
const OPENALEX_FIELDS = [
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
          retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 4_000 },
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => response.statusText);
          return failedResult(retrievedAt, url, `OpenAlex API error (${response.status}): ${truncate(detail, 400)}`);
        }

        const raw = await response.json() as OpenAlexResponse;
        const papers = Array.isArray(raw.results)
          ? raw.results.flatMap((work, index) => {
              const paper = normalizeOpenAlexWork(work, {
                rank: index + 1,
                retrievedAt,
                queryUrl: url.toString(),
              });
              return paper ? [paper] : [];
            })
          : [];
        const edges = buildRelationshipEdges(papers, options.includeTopicEdges !== false);
        const source: ResearchSourceStatus = {
          id: "openalex",
          name: "OpenAlex",
          status: "ok",
          retrievedAt,
          queryUrl: url.toString(),
          resultCount: papers.length,
          totalMatches: finiteNumber(raw.meta?.count),
          coverage: "Ranked OpenAlex metadata results for the submitted query and filters.",
        };
        return { papers, edges, source };
      } catch (error) {
        return failedResult(
          retrievedAt,
          url,
          `OpenAlex request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

function buildOpenAlexUrl(endpoint: string, plan: SearchPlan, mailto?: string): URL {
  const url = new URL(endpoint);
  url.searchParams.set("search", plan.query);
  url.searchParams.set("per-page", String(plan.limit));
  url.searchParams.set("select", OPENALEX_FIELDS);
  if (mailto?.trim()) url.searchParams.set("mailto", mailto.trim());

  const filters: string[] = [];
  if (plan.fromYear) filters.push(`from_publication_date:${plan.fromYear}-01-01`);
  if (plan.toYear) filters.push(`to_publication_date:${plan.toYear}-12-31`);
  if (filters.length > 0) url.searchParams.set("filter", filters.join(","));
  if (plan.sort === "cited_by_count") url.searchParams.set("sort", "cited_by_count:desc");
  if (plan.sort === "publication_date") url.searchParams.set("sort", "publication_date:desc");
  return url;
}

function normalizeOpenAlexWork(
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
    citedByCount: finiteNumber(work.cited_by_count) ?? 0,
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

function failedResult(retrievedAt: string, url: URL, error: string): LiteratureSearchResult {
  return {
    papers: [],
    edges: [],
    source: {
      id: "openalex",
      name: "OpenAlex",
      status: "error",
      retrievedAt,
      queryUrl: url.toString(),
      resultCount: 0,
      coverage: "OpenAlex did not return usable results for this request.",
      error,
    },
  };
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

type OpenAlexWork = Record<string, unknown> & {
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
  referenced_works?: unknown;
  ids?: unknown;
  abstract_inverted_index?: unknown;
};
