import { networkFetch } from "../../network/fetch.js";
import { normalizeDoi } from "../identity.js";
import { sanitizeRetrievalUrl } from "./terminology.js";
import type {
  LiteratureSearchResult,
  LiteratureSource,
  ResearchPaper,
  ResearchPaperProvenance,
  ResearchSourceStatus,
  SearchPlan,
  SearchVenueConstraint,
} from "../types.js";

export type CreateOpenReviewSourceOptions = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_ENDPOINT = "https://api2.openreview.net/notes";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_VENUE_CONSTRAINTS = 12;
const OPENREVIEW_TRANSIENT_RETRY_STATUSES = [408, 409, 425, 429, 500, 502, 503, 504] as const;

type VenueAttempt = {
  constraint: SearchVenueConstraint;
  url: URL;
  papers: ResearchPaper[];
  totalMatches?: number;
  error?: string;
};

/**
 * Reads papers from explicit OpenReview venue IDs. This adapter is deliberately
 * opt-in: it only runs when the agent supplied a venue constraint tied to an
 * official OpenReview venue identifier, and it never guesses accepted status
 * from title or generic venue metadata.
 */
export function createOpenReviewSource(
  options: CreateOpenReviewSourceOptions = {},
): LiteratureSource {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positiveInteger(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;

  return {
    id: "openreview",
    name: "OpenReview",
    async search(plan, context = {}) {
      const retrievedAt = (context.now?.() ?? new Date()).toISOString();
      const venueSet = plan.venueSet;
      const constraints = officialVenueConstraints(plan);
      if (!venueSet || constraints.length === 0) {
        return {
          papers: [],
          edges: [],
          source: {
            id: "openreview",
            name: "OpenReview",
            status: "disabled",
            retrievedAt,
            resultCount: 0,
            coverage: "No official OpenReview venue identifier was included in this search plan.",
          },
        };
      }

      const perVenueLimit = Math.max(1, Math.min(plan.limit, Math.ceil(plan.limit / constraints.length)));
      const attempts = await Promise.all(constraints.map(async (constraint): Promise<VenueAttempt> => {
        const url = buildOpenReviewUrl(endpoint, constraint, perVenueLimit);
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
            retry: {
              maxRetries: 2,
              baseDelayMs: 500,
              maxDelayMs: 4_000,
              retryStatuses: OPENREVIEW_TRANSIENT_RETRY_STATUSES,
            },
          });
          if (!response.ok) {
            const body = await response.text().catch(() => response.statusText);
            return {
              constraint,
              url,
              papers: [],
              error: `OpenReview API error (${response.status}): ${truncate(body || response.statusText, 400)}`,
            } satisfies VenueAttempt;
          }

          const payload = await response.json() as unknown;
          const raw = isRecord(payload) ? payload : {};
          const notes = Array.isArray(raw.notes) ? raw.notes : [];
          const queryUrl = sanitizeRetrievalUrl(url.toString());
          const papers = notes.flatMap((note, index) => {
            const paper = normalizeOpenReviewNote(note, {
              constraint,
              rank: index + 1,
              retrievedAt,
              ...(queryUrl ? { queryUrl } : {}),
            });
            return paper ? [paper] : [];
          });
          return {
            constraint,
            url,
            papers,
            ...(nonNegativeFiniteNumber(raw.count) !== undefined
              ? { totalMatches: nonNegativeFiniteNumber(raw.count) }
              : {}),
          } satisfies VenueAttempt;
        } catch (error) {
          return {
            constraint,
            url,
            papers: [],
            error: `OpenReview request failed: ${error instanceof Error ? error.message : String(error)}`,
          } satisfies VenueAttempt;
        }
      }));

      const successful = attempts.filter((attempt) => !attempt.error);
      if (successful.length === 0) {
        const first = attempts[0];
        return failedResult(
          retrievedAt,
          first?.url ?? new URL(endpoint),
          attempts.map((attempt) => `${attempt.constraint.name}: ${attempt.error ?? "no result"}`).join(" "),
        );
      }

      const failures = attempts.filter((attempt) => attempt.error);
      const ranked = rankOpenReviewPapers(
        successful.flatMap((attempt) => attempt.papers),
        plan.query,
      ).slice(0, plan.limit);
      const papers = ranked.map((paper, index) => ({
        ...paper,
        provenance: paper.provenance.map((provenance) => ({ ...provenance, rank: index + 1 })),
      }));
      const totalMatches = attempts.every((attempt) => attempt.totalMatches !== undefined)
        ? attempts.reduce((total, attempt) => total + (attempt.totalMatches ?? 0), 0)
        : undefined;
      const warnings = failures.map((attempt) => `${attempt.constraint.name}: ${attempt.error}`);
      const oneQueryUrl = attempts.length === 1
        ? sanitizeRetrievalUrl(attempts[0]?.url.toString())
        : undefined;
      const source: ResearchSourceStatus = {
        id: "openreview",
        name: "OpenReview",
        status: "ok",
        ...(failures.length > 0 ? { partial: true } : {}),
        retrievedAt,
        ...(oneQueryUrl ? { queryUrl: oneQueryUrl } : {}),
        resultCount: papers.length,
        ...(totalMatches !== undefined ? { totalMatches } : {}),
        coverage: failures.length > 0
          ? `Official OpenReview venue metadata returned for ${successful.length}/${attempts.length} venue constraints.`
          : `Official OpenReview venue metadata returned for ${attempts.length} venue constraints.`,
        ...(warnings.length > 0 ? { warnings } : {}),
        applied: {
          venueSet: {
            id: venueSet.id,
            name: venueSet.name,
            constraintIds: constraints.map((constraint) => constraint.id),
            ...(requestedStatuses(venueSet).length > 0 ? { requestedStatuses: requestedStatuses(venueSet) } : {}),
            enforcement: "official",
          },
        },
      };
      return { papers, edges: [], source };
    },
  };
}

export function buildOpenReviewUrl(
  endpoint: string,
  constraint: Pick<SearchVenueConstraint, "openReviewVenueId">,
  limit: number,
): URL {
  const venueId = constraint.openReviewVenueId?.trim();
  if (!venueId) throw new Error("OpenReview venue identifier is required.");
  const url = new URL(endpoint);
  url.searchParams.set("content.venueid", venueId);
  url.searchParams.set("limit", String(Math.max(1, Math.floor(limit))));
  return url;
}

export function normalizeOpenReviewNote(
  value: unknown,
  context: {
    constraint: SearchVenueConstraint;
    rank: number;
    retrievedAt: string;
    queryUrl?: string;
  },
): ResearchPaper | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id) ?? stringValue(value.forum);
  const content = isRecord(value.content) ? value.content : {};
  const title = contentString(content.title);
  if (!id || !title) return undefined;

  const doi = normalizeDoi(contentString(content.doi));
  const venue = contentString(content.venue) ?? context.constraint.name;
  const year = context.constraint.year ?? yearFromOpenReviewNote(value);
  const status = requestedVenueStatus(context.constraint);
  const officialVenueId = context.constraint.openReviewVenueId?.trim();
  const other: Record<string, string> = {
    openreviewVenueId: officialVenueId ?? "",
    ...(context.constraint.track ? { openreviewTrack: context.constraint.track } : {}),
    ...(status ? { openreviewStatus: status } : {}),
    ...(status === "accepted" ? { openreviewAccepted: "true" } : {}),
  };
  if (!other.openreviewVenueId) delete other.openreviewVenueId;

  const provenance: ResearchPaperProvenance = {
    sourceId: "openreview",
    sourceRecordId: id,
    rank: context.rank,
    retrievedAt: context.retrievedAt,
    ...(context.queryUrl ? { queryUrl: context.queryUrl } : {}),
  };
  return {
    id: `https://openreview.net/forum?id=${encodeURIComponent(id)}`,
    identity: {
      openReview: id,
      ...(doi ? { doi } : {}),
      ...(Object.keys(other).length > 0 ? { other } : {}),
    },
    title,
    authors: contentStrings(content.authors),
    ...(year !== undefined ? { year } : {}),
    ...(doi ? { doi } : {}),
    venue,
    ...(officialVenueId ? {
      venueEvidence: [{
        sourceId: "openreview",
        evidence: "official" as const,
        venue,
        ...(year !== undefined ? { year } : {}),
        ...(context.constraint.track ? { track: context.constraint.track } : {}),
        status: status ?? "unknown",
        officialVenueId,
      }],
    } : {}),
    type: "conference-paper",
    url: `https://openreview.net/forum?id=${encodeURIComponent(id)}`,
    citedByCount: 0,
    ...(contentString(content.abstract) ? { abstract: truncate(contentString(content.abstract)!, 1_200) } : {}),
    topics: [],
    referencedWorkIds: [],
    sourceId: "openreview",
    sourceIds: ["openreview"],
    provenance: [provenance],
  };
}

function officialVenueConstraints(plan: SearchPlan): SearchVenueConstraint[] {
  const seen = new Set<string>();
  const constraints: SearchVenueConstraint[] = [];
  for (const constraint of plan.venueSet?.venues ?? []) {
    const venueId = constraint.openReviewVenueId?.trim();
    if (!venueId || seen.has(venueId.toLowerCase())) continue;
    seen.add(venueId.toLowerCase());
    constraints.push(constraint);
    if (constraints.length >= MAX_VENUE_CONSTRAINTS) break;
  }
  return constraints;
}

function requestedVenueStatus(constraint: SearchVenueConstraint): "accepted" | "submission" | undefined {
  if (constraint.status === "accepted" || constraint.status === "submission") return constraint.status;
  if (constraint.accepted === true) return "accepted";
  if (constraint.accepted === false) return "submission";
  return undefined;
}

function requestedStatuses(venueSet: NonNullable<SearchPlan["venueSet"]>): Array<"accepted" | "submission"> {
  return [...new Set(venueSet.venues.flatMap((constraint) => {
    const status = requestedVenueStatus(constraint);
    return status ? [status] : [];
  }))];
}

function rankOpenReviewPapers(papers: ResearchPaper[], query: string): ResearchPaper[] {
  const queryTerms = query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...papers].sort((left, right) => {
    const scoreDifference = queryScore(right, queryTerms) - queryScore(left, queryTerms);
    if (scoreDifference !== 0) return scoreDifference;
    const yearDifference = (right.year ?? 0) - (left.year ?? 0);
    if (yearDifference !== 0) return yearDifference;
    return left.title.localeCompare(right.title);
  });
}

function queryScore(paper: ResearchPaper, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = `${paper.title}\n${paper.abstract ?? ""}`.toLocaleLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function failedResult(retrievedAt: string, url: URL, error: string): LiteratureSearchResult {
  const queryUrl = sanitizeRetrievalUrl(url.toString());
  return {
    papers: [],
    edges: [],
    source: {
      id: "openreview",
      name: "OpenReview",
      status: "error",
      retrievedAt,
      ...(queryUrl ? { queryUrl } : {}),
      resultCount: 0,
      coverage: "OpenReview official venue metadata could not be retrieved.",
      error: truncate(error, 800),
    },
  };
}

function contentString(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  if (isRecord(value)) return contentString(value.value ?? value.values);
  if (Array.isArray(value)) return value.map(contentString).find((item): item is string => Boolean(item));
  return undefined;
}

function contentStrings(value: unknown): string[] {
  const raw = isRecord(value) ? value.value ?? value.values : value;
  if (typeof raw === "string") return raw.split(/\s*,\s*/u).map(stringValue).filter((item): item is string => Boolean(item));
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (isRecord(entry)) return [entry.name, entry.value].filter((item): item is string => typeof item === "string");
    return [];
  }).map(stringValue).filter((item): item is string => Boolean(item)))];
}

function yearFromOpenReviewNote(note: Record<string, unknown>): number | undefined {
  for (const key of ["pdate", "tcdate", "cdate", "mdate"] as const) {
    const value = finiteNumber(note[key]);
    if (value === undefined) continue;
    const milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
    const year = new Date(milliseconds).getUTCFullYear();
    if (year >= 1800 && year <= new Date().getUTCFullYear() + 2) return year;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 8_192) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}...`;
}
