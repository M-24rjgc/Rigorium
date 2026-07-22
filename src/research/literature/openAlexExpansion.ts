import { networkFetch } from "../../network/fetch.js";
import { normalizeDoi } from "../identity.js";
import type {
  LiteratureExpansionDirection,
  LiteratureExpansionDirectionResult,
  LiteratureExpansionSeed,
  ResearchPaper,
  ResearchRelationEdge,
  ResearchSourceStatus,
} from "../types.js";
import {
  normalizeOpenAlexWork,
  OPENALEX_WORK_FIELDS,
  type OpenAlexWork,
} from "./openAlexSource.js";

export type OpenAlexCitationExpansionOptions = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  mailto?: string;
};

export type OpenAlexCitationExpansionInput = {
  seed: LiteratureExpansionSeed;
  directions: LiteratureExpansionDirection[];
  limitPerDirection: number;
  signal?: AbortSignal;
  now?: () => Date;
};

export type OpenAlexCitationExpansion = {
  seed: ResearchPaper;
  papers: ResearchPaper[];
  edges: ResearchRelationEdge[];
  directions: LiteratureExpansionDirectionResult[];
  source: ResearchSourceStatus;
  seedWarnings: string[];
};

const DEFAULT_ENDPOINT = "https://api.openalex.org/works";
const DEFAULT_TIMEOUT_MS = 20_000;
const OPENALEX_OR_FILTER_MAX = 100;
const OPENALEX_TRANSIENT_RETRY_STATUSES = [408, 409, 425, 500, 502, 503, 504] as const;

/**
 * Resolves one strong OpenAlex/DOI seed, then grows only real citation edges.
 * This is intentionally a small adapter extension rather than a graph service:
 * callers own artifact construction and retain all direction-level coverage.
 */
export async function expandOpenAlexCitations(
  input: OpenAlexCitationExpansionInput,
  options: OpenAlexCitationExpansionOptions = {},
): Promise<OpenAlexCitationExpansion> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retrievedAt = (input.now?.() ?? new Date()).toISOString();
  const seedRequest = buildSeedRequest(endpoint, input.seed, options.mailto);
  const seedResponse = await requestJson<OpenAlexWork>(seedRequest.url, {
    fetchImpl: options.fetchImpl,
    timeoutMs,
    signal: input.signal,
  });

  if (!seedResponse.ok) {
    throw new OpenAlexSeedResolutionError(seedResponse.error, seedRequest.url.toString());
  }

  const seedPayload = seedResponse.value as unknown;
  if (!isRecord(seedPayload)) {
    throw new OpenAlexSeedResolutionError("OpenAlex returned a malformed seed response.", seedRequest.url.toString());
  }
  const seedWork = seedPayload as OpenAlexWork;
  const seed = normalizeOpenAlexWork(seedWork, {
    rank: 1,
    retrievedAt,
    queryUrl: seedRequest.url.toString(),
  });
  if (!seed) {
    throw new OpenAlexSeedResolutionError("OpenAlex returned a seed record without a stable work ID and title.", seedRequest.url.toString());
  }
  assertCanonicalOpenAlexSeed(seed, seedRequest.url.toString());
  assertSeedIdentityMatches(input.seed, seed, seedRequest.url.toString());
  const seedWarnings = verifySeedPresentation(input.seed, seed);
  const referenceIds = extractReferenceIds(seedWork);
  const effectiveLimit = Math.max(1, Math.min(OPENALEX_OR_FILTER_MAX, Math.floor(input.limitPerDirection)));

  const directionResults = await Promise.all(input.directions.map((direction) => direction === "references"
    ? expandReferences({
        endpoint,
        seed,
        referenceIds,
        limit: effectiveLimit,
        retrievedAt,
        signal: input.signal,
        options,
      })
    : expandCitations({
        endpoint,
        seed,
        limit: effectiveLimit,
        retrievedAt,
        signal: input.signal,
        options,
      })));

  const directions = directionResults.map((result) => result.direction);
  const papers = uniquePapers([seed, ...directionResults.flatMap((result) => result.papers)]);
  const edges = uniqueEdges(directionResults.flatMap((result) => result.edges));
  const successfulDirections = directions.filter((result) => result.status === "ok" || result.status === "partial");
  const warnings = uniqueStrings([
    ...seedWarnings,
    ...directions.flatMap((result) => result.warnings ?? []),
    ...directions.filter((result) => result.status === "error" || result.status === "unavailable")
      .map((result) => `${capitalize(result.direction)}: ${result.error ?? "OpenAlex did not return usable data."}`),
  ]);

  const source: ResearchSourceStatus = {
    id: "openalex",
    name: "OpenAlex",
    status: successfulDirections.length > 0 ? "ok" : "error",
    retrievedAt,
    queryUrl: seedRequest.url.toString(),
    resultCount: papers.length,
    coverage: successfulDirections.length > 0
      ? "OpenAlex citation expansion from a verified seed; inspect each requested direction for truncation and coverage."
      : "OpenAlex could resolve the seed but did not return a usable requested citation direction.",
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(successfulDirections.length > 0 ? {} : {
      error: directions.map((result) => result.error).filter((value): value is string => Boolean(value)).join(" ") || undefined,
    }),
  };

  return { seed, papers, edges, directions, source, seedWarnings };
}

export class OpenAlexSeedResolutionError extends Error {
  readonly name = "OpenAlexSeedResolutionError";

  constructor(message: string, readonly queryUrl: string) {
    super(message);
  }
}

/** Accept OpenAlex's canonical URL or compact W identifier, never an arbitrary URL. */
export function normalizeOpenAlexWorkId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(?:https?:\/\/openalex\.org\/)?(W\d+)\/?$/iu.exec(value.trim());
  return match ? `https://openalex.org/${match[1].toUpperCase()}` : undefined;
}

type DirectionExpansion = {
  direction: LiteratureExpansionDirectionResult;
  papers: ResearchPaper[];
  edges: ResearchRelationEdge[];
};

async function expandReferences(input: {
  endpoint: string;
  seed: ResearchPaper;
  referenceIds: string[];
  limit: number;
  retrievedAt: string;
  signal?: AbortSignal;
  options: OpenAlexCitationExpansionOptions;
}): Promise<DirectionExpansion> {
  const requestedCount = input.referenceIds.length;
  if (requestedCount === 0) {
    return {
      direction: {
        direction: "references",
        status: "ok",
        resultCount: 0,
        requestedCount: 0,
        resolvedCount: 0,
        truncated: false,
      },
      papers: [],
      edges: [],
    };
  }

  const attemptIds = input.referenceIds.slice(0, Math.min(input.limit, OPENALEX_OR_FILTER_MAX));
  const url = buildListUrl(input.endpoint, {
    filter: `openalex_id:${attemptIds.map(openAlexWorkKey).join("|")}`,
    limit: attemptIds.length,
    mailto: input.options.mailto,
  });
  const response = await requestJson<OpenAlexListResponse>(url, {
    fetchImpl: input.options.fetchImpl,
    timeoutMs: input.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: input.signal,
  });
  if (!response.ok) {
    return failedDirection("references", url, requestedCount, response.error);
  }
  const payload = response.value as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return failedDirection("references", url, requestedCount, "OpenAlex returned a malformed references response.");
  }

  const byId = new Map<string, ResearchPaper>();
  const results = payload.results as OpenAlexWork[];
  const responseOverflow = results.length > input.limit;
  const boundedResults = results.slice(0, input.limit);
  for (let index = 0; index < results.length; index += 1) {
    if (index >= boundedResults.length) break;
    const work = boundedResults[index] as unknown;
    if (!isRecord(work)) continue;
    const paper = normalizeOpenAlexWork(work as OpenAlexWork, {
      rank: index + 1,
      retrievedAt: input.retrievedAt,
      queryUrl: url.toString(),
    });
    if (paper) byId.set(paper.id, paper);
  }
  const papers = attemptIds.map((id) => byId.get(id)).filter((paper): paper is ResearchPaper => Boolean(paper));
  const unresolved = attemptIds.filter((id) => !byId.has(id));
  const truncated = requestedCount > attemptIds.length || responseOverflow;
  const warnings = [
    ...(truncated
      ? [`OpenAlex reported ${requestedCount} reference IDs; only the first ${attemptIds.length} were expanded by the configured per-direction limit (maximum ${OPENALEX_OR_FILTER_MAX} identifiers per OR filter).`]
      : []),
    ...(unresolved.length > 0
      ? [`OpenAlex could not hydrate ${unresolved.length} of ${attemptIds.length} requested reference IDs.`]
      : []),
    ...(responseOverflow
      ? [`OpenAlex returned ${results.length} reference records for a page of ${input.limit}; only the first ${input.limit} were retained.`]
      : []),
  ];
  const partial = truncated || unresolved.length > 0;
  return {
    direction: {
      direction: "references",
      status: partial ? "partial" : "ok",
      resultCount: papers.length,
      requestedCount,
      resolvedCount: papers.length,
      truncated,
      queryUrl: url.toString(),
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    papers,
    edges: papers.map((paper) => citationEdge(input.seed.id, paper.id)),
  };
}

async function expandCitations(input: {
  endpoint: string;
  seed: ResearchPaper;
  limit: number;
  retrievedAt: string;
  signal?: AbortSignal;
  options: OpenAlexCitationExpansionOptions;
}): Promise<DirectionExpansion> {
  const url = buildListUrl(input.endpoint, {
    filter: `cites:${openAlexWorkKey(input.seed.id)}`,
    limit: input.limit,
    sort: "cited_by_count:desc",
    mailto: input.options.mailto,
  });
  const response = await requestJson<OpenAlexListResponse>(url, {
    fetchImpl: input.options.fetchImpl,
    timeoutMs: input.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: input.signal,
  });
  if (!response.ok) return failedDirection("citations", url, undefined, response.error);
  const payload = response.value as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return failedDirection("citations", url, undefined, "OpenAlex returned a malformed citations response.");
  }

  const results = payload.results as OpenAlexWork[];
  const responseOverflow = results.length > input.limit;
  const boundedResults = results.slice(0, input.limit);
  let rejectedWorks = 0;
  const papers = boundedResults.flatMap((work, index) => {
    if (!isRecord(work)) {
      rejectedWorks += 1;
      return [];
    }
    const paper = normalizeOpenAlexWork(work as OpenAlexWork, {
      rank: index + 1,
      retrievedAt: input.retrievedAt,
      queryUrl: url.toString(),
    });
    const canonicalId = normalizeOpenAlexWorkId(paper?.id);
    const canonicalIdentityId = normalizeOpenAlexWorkId(paper?.identity.openAlexId);
    const citesSeed = paper?.referencedWorkIds.some((id) => normalizeOpenAlexWorkId(id) === input.seed.id) ?? false;
    if (
      !paper
      || paper.id === input.seed.id
      || canonicalId !== paper.id
      || canonicalIdentityId !== canonicalId
      || !citesSeed
    ) {
      rejectedWorks += 1;
      return [];
    }
    return [paper];
  });
  const rawMetaCount = isRecord(payload.meta) ? payload.meta.count : undefined;
  const totalMatches = nonNegativeInteger(rawMetaCount);
  const invalidMetaCount = rawMetaCount !== undefined && totalMatches === undefined;
  const countUnderflow = totalMatches !== undefined && totalMatches < boundedResults.length;
  const pageFilled = results.length >= input.limit;
  const truncated = totalMatches !== undefined
    ? totalMatches > boundedResults.length || responseOverflow
    : pageFilled;
  const warnings = totalMatches !== undefined
    ? (truncated
      ? [`OpenAlex reports ${totalMatches} citing works; this expansion retains the first ${papers.length} ranked works.`]
      : [])
    : [invalidMetaCount
      ? "OpenAlex provided an invalid meta.count; citation coverage is partial."
      : pageFilled
        ? `OpenAlex did not provide meta.count; the first ${papers.length} citing works may be incomplete.`
        : "OpenAlex did not provide meta.count; citation coverage is based on a short response."];
  if (responseOverflow) {
    warnings.push(`OpenAlex returned ${results.length} citing records for a page of ${input.limit}; only the first ${input.limit} were retained.`);
  }
  if (countUnderflow) {
    warnings.push(`OpenAlex reported meta.count=${totalMatches} but returned ${boundedResults.length} citing records; citation coverage is partial.`);
  }
  if (rejectedWorks > 0) {
    warnings.push(`OpenAlex returned ${rejectedWorks} citing records without a canonical identity or explicit reference to the seed; they were excluded from real citation edges.`);
  }
  const partial = truncated || totalMatches === undefined || countUnderflow || rejectedWorks > 0;
  return {
    direction: {
      direction: "citations",
      status: partial ? "partial" : "ok",
      resultCount: papers.length,
      ...(totalMatches !== undefined ? { totalMatches } : {}),
      truncated,
      queryUrl: url.toString(),
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    papers,
    edges: papers.map((paper) => citationEdge(paper.id, input.seed.id)),
  };
}

function failedDirection(
  direction: LiteratureExpansionDirection,
  url: URL,
  requestedCount: number | undefined,
  error: string,
): DirectionExpansion {
  return {
    direction: {
      direction,
      status: "error",
      resultCount: 0,
      ...(requestedCount !== undefined ? { requestedCount, resolvedCount: 0 } : {}),
      truncated: false,
      queryUrl: url.toString(),
      error,
    },
    papers: [],
    edges: [],
  };
}

function buildSeedRequest(endpoint: string, seed: LiteratureExpansionSeed, mailto?: string): { url: URL; openAlexId?: string; doi?: string } {
  const openAlexId = normalizeOpenAlexWorkId(seed.openAlexId);
  const doi = normalizeDoi(seed.doi);
  if (!openAlexId && !doi) {
    throw new OpenAlexSeedResolutionError("literature_expand requires a valid OpenAlex work ID or DOI seed.", "");
  }
  const identifier = openAlexId ?? `https://doi.org/${doi}`;
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/${encodeURIComponent(identifier)}`;
  url.search = "";
  url.searchParams.set("select", OPENALEX_WORK_FIELDS);
  addMailto(url, mailto);
  return { url, ...(openAlexId ? { openAlexId } : {}), ...(doi ? { doi } : {}) };
}

function buildListUrl(endpoint: string, input: { filter: string; limit: number; sort?: string; mailto?: string }): URL {
  const url = new URL(endpoint);
  url.searchParams.set("filter", input.filter);
  url.searchParams.set("per-page", String(Math.max(1, Math.min(OPENALEX_OR_FILTER_MAX, input.limit))));
  url.searchParams.set("select", OPENALEX_WORK_FIELDS);
  if (input.sort) url.searchParams.set("sort", input.sort);
  addMailto(url, input.mailto);
  return url;
}

function addMailto(url: URL, mailto: string | undefined): void {
  if (mailto?.trim()) url.searchParams.set("mailto", mailto.trim());
}

async function requestJson<T>(
  url: URL,
  options: { fetchImpl?: typeof fetch; timeoutMs: number; signal?: AbortSignal },
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const response = await networkFetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Rigorium/0.1 (local research workspace)",
      },
      signal: options.signal,
    }, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      // A 429 carries provider quota state. Do not let the shared retry helper
      // cap a long Retry-After value and issue an early follow-up request.
      retry: {
        maxRetries: 2,
        baseDelayMs: 500,
        maxDelayMs: 4_000,
        retryStatuses: OPENALEX_TRANSIENT_RETRY_STATUSES,
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      return { ok: false, error: `OpenAlex API error (${response.status}): ${truncate(detail, 400)}` };
    }
    try {
      return { ok: true, value: await response.json() as T };
    } catch (error) {
      return { ok: false, error: `OpenAlex returned invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  } catch (error) {
    return { ok: false, error: `OpenAlex request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function assertCanonicalOpenAlexSeed(paper: ResearchPaper, queryUrl: string): void {
  const canonicalPaperId = normalizeOpenAlexWorkId(paper.id);
  const canonicalIdentityId = normalizeOpenAlexWorkId(paper.identity.openAlexId);
  if (
    !canonicalPaperId
    || !canonicalIdentityId
    || canonicalPaperId !== canonicalIdentityId
    || paper.id !== canonicalPaperId
    || paper.identity.openAlexId !== canonicalIdentityId
  ) {
    throw new OpenAlexSeedResolutionError(
      "OpenAlex returned a seed record without a canonical OpenAlex W identifier.",
      queryUrl,
    );
  }
}

function assertSeedIdentityMatches(seed: LiteratureExpansionSeed, paper: ResearchPaper, queryUrl: string): void {
  const expectedOpenAlexId = normalizeOpenAlexWorkId(seed.openAlexId);
  const expectedDoi = normalizeDoi(seed.doi);
  if (expectedOpenAlexId && expectedOpenAlexId !== paper.id) {
    throw new OpenAlexSeedResolutionError("The supplied OpenAlex work ID did not resolve to that work record.", queryUrl);
  }
  const actualDoi = normalizeDoi(paper.identity.doi ?? paper.doi);
  if (expectedDoi && actualDoi !== expectedDoi) {
    throw new OpenAlexSeedResolutionError("The supplied DOI conflicts with the resolved OpenAlex work record.", queryUrl);
  }
}

function verifySeedPresentation(seed: LiteratureExpansionSeed, paper: ResearchPaper): string[] {
  const warnings: string[] = [];
  if (seed.title && normalizedText(seed.title) !== normalizedText(paper.title)) {
    warnings.push("The supplied seed title differs from OpenAlex; the strong identifier was used as the authority.");
  }
  if (Number.isFinite(seed.year) && seed.year !== paper.year) {
    warnings.push("The supplied seed year differs from OpenAlex; the strong identifier was used as the authority.");
  }
  if (Array.isArray(seed.authors) && seed.authors.length > 0) {
    const normalizedAuthors = new Set(paper.authors.map(normalizedText));
    if (seed.authors.every((author) => !normalizedAuthors.has(normalizedText(author)))) {
      warnings.push("The supplied seed authors differ from OpenAlex; the strong identifier was used as the authority.");
    }
  }
  return warnings;
}

function extractReferenceIds(work: OpenAlexWork): string[] {
  if (!Array.isArray(work.referenced_works)) return [];
  return uniqueStrings(work.referenced_works.map(normalizeOpenAlexWorkId).filter((id): id is string => Boolean(id)));
}

function openAlexWorkKey(value: string): string {
  const normalized = normalizeOpenAlexWorkId(value);
  if (!normalized) {
    throw new OpenAlexSeedResolutionError("Citation expansion requires a canonical OpenAlex W identifier.", "");
  }
  return normalized.slice("https://openalex.org/".length);
}

function citationEdge(source: string, target: string): ResearchRelationEdge {
  return {
    id: `citation:${source}:${target}`,
    source,
    target,
    type: "citation",
    weight: 1,
    inferred: false,
  };
}

function uniquePapers(papers: ResearchPaper[]): ResearchPaper[] {
  const byId = new Map<string, ResearchPaper>();
  for (const paper of papers) if (!byId.has(paper.id)) byId.set(paper.id, paper);
  return [...byId.values()];
}

function uniqueEdges(edges: ResearchRelationEdge[]): ResearchRelationEdge[] {
  const byId = new Map<string, ResearchRelationEdge>();
  for (const edge of edges) if (edge.source !== edge.target && !byId.has(edge.id)) byId.set(edge.id, edge);
  return [...byId.values()];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

type OpenAlexListResponse = {
  meta?: { count?: unknown };
  results?: OpenAlexWork[];
};
