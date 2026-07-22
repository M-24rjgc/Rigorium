import { networkFetch } from "../../network/fetch.js";
import { normalizeDoi } from "../identity.js";
import type {
  LiteratureSearchResult,
  LiteratureSource,
  ResearchPaper,
  ResearchPaperProvenance,
  ResearchSourceStatus,
  SearchPlan,
} from "../types.js";

export type CreateCrossrefSourceOptions = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Upper bound for the JSON metadata response body, before parsing. */
  maxResponseBytes?: number;
  /** Optional address sent as Crossref's documented `mailto` query parameter. */
  mailto?: string;
};

const DEFAULT_ENDPOINT = "https://api.crossref.org/works";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const CROSSREF_FIELDS = [
  "DOI",
  "title",
  "author",
  "published",
  "published-print",
  "published-online",
  "container-title",
  "URL",
  "type",
  "is-referenced-by-count",
].join(",");

/** Shared by every Crossref adapter in this Node/Electron process. */
const crossrefEndpointGates = new Map<string, CrossrefEndpointGate>();

/**
 * Crossref is intentionally a metadata and DOI-identity supplement. It has no
 * dependency on copied upstream code and does not retrieve full abstracts,
 * rights metadata, or reference lists in this increment. OpenAlex remains the
 * relationship source.
 */
export function createCrossrefSource(options: CreateCrossrefSourceOptions = {}): LiteratureSource {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positiveInteger(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = positiveInteger(options.maxResponseBytes) ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    id: "crossref",
    name: "Crossref",
    async search(plan, context = {}) {
      let retrievedAt = (context.now?.() ?? new Date()).toISOString();
      const url = buildCrossrefUrl(endpoint, plan, options.mailto);

      try {
        const permit = await crossrefGateFor(url).acquire(context.signal);
        retrievedAt = (context.now?.() ?? new Date()).toISOString();
        let responseHeaders: Headers | undefined;
        try {
          const requestStartedAt = Date.now();
          const response = await networkFetch(url.toString(), {
            method: "GET",
            headers: {
              Accept: "application/json",
              "User-Agent": crossrefUserAgent(options.mailto),
            },
            signal: context.signal,
          }, {
            timeoutMs,
            signal: context.signal,
            fetchImpl,
            // HTTP provider responses must reach the endpoint gate unchanged:
            // its Retry-After/Backoff headers are provider-specific and must
            // never be shortened by generic retry caps. Transport failures
            // retain the existing bounded retry behavior.
            retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 4_000, retryStatuses: [] },
          });
          responseHeaders = response.headers;
          const body = await readCrossrefResponseBody(response, {
            signal: context.signal,
            timeoutMs: remainingTimeoutMs(requestStartedAt, timeoutMs),
            maxBytes: maxResponseBytes,
          });

          if (!response.ok) {
            const detail = body || response.statusText;
            return failedResult(retrievedAt, url, `Crossref API error (${response.status}): ${truncate(detail, 400)}`);
          }

          const raw = JSON.parse(body) as CrossrefResponse;
          const message = isRecord(raw.message) ? raw.message : undefined;
          if (!message || !Array.isArray(message.items)) {
            return failedResult(retrievedAt, url, "Crossref response did not contain a message.items array.");
          }

          const papers = message.items.flatMap((work, index) => {
            const paper = normalizeCrossrefWork(work, {
              rank: index + 1,
              retrievedAt,
              queryUrl: url.toString(),
            });
            return paper ? [paper] : [];
          });
          const source: ResearchSourceStatus = {
            id: "crossref",
            name: "Crossref",
            status: "ok",
            retrievedAt,
            queryUrl: url.toString(),
            resultCount: papers.length,
            totalMatches: finiteNumber(message["total-results"]),
            coverage: "Ranked Crossref DOI metadata results for the submitted query and filters. This source contributes bibliographic metadata and DOI identity; OpenAlex remains the relationship source.",
          };
          return { papers, edges: [], source };
        } finally {
          // Release only after the final response body has been read. This
          // keeps actual endpoint requests serialized, while retaining the
          // existing networkFetch retry behavior inside the same permit.
          permit.release(responseHeaders);
        }
      } catch (error) {
        return failedResult(
          retrievedAt,
          url,
          `Crossref request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

function crossrefGateFor(url: URL): CrossrefEndpointGate {
  const key = crossrefEndpointKey(url);
  let gate = crossrefEndpointGates.get(key);
  if (!gate) {
    gate = new CrossrefEndpointGate();
    crossrefEndpointGates.set(key, gate);
  }
  return gate;
}

/** @internal Test-only observability for provider rate-header behavior. */
export function inspectCrossrefEndpointGateForTests(endpoint: string): {
  nextAllowedAt: number;
  minimumIntervalMs: number;
} | undefined {
  return crossrefEndpointGates.get(crossrefEndpointKey(new URL(endpoint)))?.snapshot();
}

function crossrefEndpointKey(url: URL): string {
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`;
}

type CrossrefPermit = {
  release(headers?: Headers): void;
};

/**
 * A small FIFO endpoint gate. It intentionally lives at module scope so two
 * tool instances cannot accidentally exceed a provider-wide process budget.
 */
class CrossrefEndpointGate {
  private tail: Promise<void> = Promise.resolve();
  private nextAllowedAt = 0;
  private minimumIntervalMs = 0;

  async acquire(signal?: AbortSignal): Promise<CrossrefPermit> {
    const previous = this.tail;
    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    // This must remain chained to `previous` even if this caller aborts while
    // queued. Otherwise a later caller could overtake an in-flight request.
    this.tail = previous.then(() => completion, () => completion);

    try {
      await waitForGate(previous, signal);
      await waitUntil(this.nextAllowedAt, signal);
    } catch (error) {
      resolveCompletion?.();
      throw error;
    }

    const startedAt = Date.now();
    let released = false;
    return {
      release: (headers) => {
        if (released) return;
        released = true;
        this.observeResponse(startedAt, headers);
        resolveCompletion?.();
      },
    };
  }

  private observeResponse(startedAt: number, headers?: Headers): void {
    const headerInterval = headers ? minimumIntervalFromHeaders(headers) : undefined;
    if (headerInterval !== undefined) this.minimumIntervalMs = headerInterval;

    this.nextAllowedAt = Math.max(this.nextAllowedAt, startedAt + this.minimumIntervalMs);
    const backoff = headers ? backoffFromHeaders(headers, Date.now()) : undefined;
    if (backoff !== undefined) this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + backoff);
  }

  snapshot(): { nextAllowedAt: number; minimumIntervalMs: number } {
    return { nextAllowedAt: this.nextAllowedAt, minimumIntervalMs: this.minimumIntervalMs };
  }
}

function minimumIntervalFromHeaders(headers: Headers): number | undefined {
  const limit = positiveNumber(headers.get("x-rate-limit-limit"));
  const interval = durationMilliseconds(headers.get("x-rate-limit-interval"));
  if (limit === undefined || interval === undefined) return undefined;
  return Math.ceil(interval / limit);
}

function backoffFromHeaders(headers: Headers, now: number): number | undefined {
  const values = [
    retryAfterMilliseconds(headers.get("retry-after"), now),
    durationMilliseconds(headers.get("backoff")),
    durationMilliseconds(headers.get("x-rate-limit-backoff")),
  ].filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : undefined;
}

/** Accept `1s`, `250ms`, `2m`, and numeric seconds without hard-coded limits. */
function durationMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)?\s*$/iu.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const unit = match[2]?.toLowerCase() ?? "s";
  const multiplier = unit === "ms" || unit.startsWith("millisecond")
    ? 1
    : unit === "m" || unit.startsWith("minute")
      ? 60_000
      : unit === "h" || unit.startsWith("hour")
        ? 3_600_000
        : 1_000;
  return Math.ceil(amount * multiplier);
}

function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
  const duration = durationMilliseconds(value);
  if (duration !== undefined) return duration;
  if (!value) return undefined;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function positiveNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function remainingTimeoutMs(startedAt: number, timeoutMs: number): number {
  return Math.max(0, timeoutMs - (Date.now() - startedAt));
}

type ReadCrossrefResponseBodyOptions = {
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
};

/**
 * Response headers may arrive before a slow or malicious body. Do not let that
 * body bypass the request budget or keep the endpoint gate occupied forever.
 */
async function readCrossrefResponseBody(
  response: Response,
  options: ReadCrossrefResponseBodyOptions,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  let failure: Error | undefined;
  let rejectInterrupted: ((reason?: unknown) => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupted = reject;
  });
  const cancel = (reason: Error) => {
    if (failure) return;
    failure = reason;
    // Cancellation is deliberately detached: a non-cooperative stream must
    // not turn a timeout or user abort into a permanently stuck search.
    void reader.cancel(reason).catch(() => undefined);
    rejectInterrupted?.(reason);
  };

  if (options.timeoutMs <= 0) {
    cancel(bodyTimeoutError(0));
  }
  const timer = options.timeoutMs > 0
    ? setTimeout(() => cancel(bodyTimeoutError(options.timeoutMs)), options.timeoutMs)
    : undefined;
  const onAbort = () => cancel(bodyAbortError(options.signal?.reason));
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let complete = false;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), interrupted]);
      if (failure) throw failure;
      if (next.done) {
        complete = true;
        break;
      }
      const value = next.value;
      bytes += value.byteLength;
      if (bytes > options.maxBytes) {
        const error = bodySizeError(options.maxBytes);
        cancel(error);
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
    return `${text}${decoder.decode()}`;
  } catch (error) {
    if (!failure && error instanceof Error) cancel(error);
    throw failure ?? error;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (!complete && !failure) {
      void reader.cancel().catch(() => undefined);
    }
  }
}

function bodyTimeoutError(timeoutMs: number): Error {
  return new Error(`Crossref response body timed out after ${timeoutMs}ms.`);
}

function bodyAbortError(reason: unknown): Error {
  const detail = reason instanceof Error && reason.message ? `: ${reason.message}` : "";
  const error = new Error(`Crossref response body read was aborted${detail}`);
  error.name = "AbortError";
  return error;
}

function bodySizeError(maxBytes: number): Error {
  return new Error(`Crossref response body exceeded the ${maxBytes}-byte limit.`);
}

function waitForGate(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(gateAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(gateAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function waitUntil(deadline: number, signal?: AbortSignal): Promise<void> {
  const delay = deadline - Date.now();
  if (delay <= 0) return Promise.resolve();
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delay));
  if (signal.aborted) return Promise.reject(gateAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(gateAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function gateAbortError(): Error {
  const error = new Error("Crossref request was aborted while waiting for the endpoint rate gate.");
  error.name = "AbortError";
  return error;
}

function crossrefUserAgent(mailto?: string): string {
  const contact = mailto?.trim();
  // Do not put arbitrary settings text into an HTTP header. The query parameter
  // is still sent separately; this merely makes a valid configured contact
  // visible in the documented polite-pool User-Agent form.
  if (contact && /^[^\s()]{3,200}$/u.test(contact) && /^[\x20-\x7e]+$/u.test(contact)) {
    return `Rigorium/0.1 (mailto:${contact})`;
  }
  return "Rigorium/0.1 (local research workspace)";
}

function buildCrossrefUrl(endpoint: string, plan: SearchPlan, mailto?: string): URL {
  const url = new URL(endpoint);
  url.searchParams.set("query.bibliographic", plan.query);
  url.searchParams.set("rows", String(plan.limit));
  url.searchParams.set("select", CROSSREF_FIELDS);
  if (mailto?.trim()) url.searchParams.set("mailto", mailto.trim());

  const filters: string[] = [];
  if (plan.fromYear) filters.push(`from-pub-date:${plan.fromYear}-01-01`);
  if (plan.toYear) filters.push(`until-pub-date:${plan.toYear}-12-31`);
  if (filters.length > 0) url.searchParams.set("filter", filters.join(","));

  if (plan.sort === "cited_by_count") {
    url.searchParams.set("sort", "is-referenced-by-count");
    url.searchParams.set("order", "desc");
  } else if (plan.sort === "publication_date") {
    url.searchParams.set("sort", "published");
    url.searchParams.set("order", "desc");
  } else {
    url.searchParams.set("sort", "score");
    url.searchParams.set("order", "desc");
  }
  return url;
}

function normalizeCrossrefWork(
  work: CrossrefWork,
  provenance: Omit<ResearchPaperProvenance, "sourceId" | "sourceRecordId">,
): ResearchPaper | null {
  const doi = normalizeDoi(work.DOI);
  const title = firstString(work.title);
  if (!doi || !title) return null;

  const publication = publicationDate(work);
  const id = `https://doi.org/${doi}`;

  return {
    id,
    identity: { doi },
    title,
    authors: normalizeAuthors(work.author),
    ...(publication.year ? { year: publication.year } : {}),
    ...(publication.date ? { publicationDate: publication.date } : {}),
    ...(stringValue(work.type) ? { type: stringValue(work.type) } : {}),
    ...(firstString(work["container-title"]) ? { venue: firstString(work["container-title"]) } : {}),
    doi,
    url: safeHttpUrl(work.URL) ?? id,
    citedByCount: finiteNumber(work["is-referenced-by-count"]) ?? 0,
    topics: [],
    referencedWorkIds: [],
    sourceId: "crossref",
    sourceIds: ["crossref"],
    provenance: [{
      sourceId: "crossref",
      sourceRecordId: doi,
      ...provenance,
    }],
  };
}

function publicationDate(work: CrossrefWork): { year?: number; date?: string } {
  for (const key of ["published-print", "published-online", "published"] as const) {
    const value = work[key];
    if (!isRecord(value) || !Array.isArray(value["date-parts"])) continue;
    const first = value["date-parts"][0];
    if (!Array.isArray(first)) continue;
    const year = finiteNumber(first[0]);
    if (!year || year < 1000 || year > 9999) continue;
    const month = finiteNumber(first[1]);
    const day = finiteNumber(first[2]);
    const parts = [String(year)];
    if (month && month >= 1 && month <= 12) {
      parts.push(String(month).padStart(2, "0"));
      if (day && day >= 1 && day <= 31) parts.push(String(day).padStart(2, "0"));
    }
    return { year, date: parts.join("-") };
  }
  return {};
}

function normalizeAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const literalName = stringValue(entry.name);
    const name = literalName ?? [stringValue(entry.given), stringValue(entry.family)].filter(Boolean).join(" ");
    return name ? [name] : [];
  });
}


function failedResult(retrievedAt: string, url: URL, error: string): LiteratureSearchResult {
  return {
    papers: [],
    edges: [],
    source: {
      id: "crossref",
      name: "Crossref",
      status: "error",
      retrievedAt,
      queryUrl: url.toString(),
      resultCount: 0,
      coverage: "Crossref did not return usable results for this request.",
      error,
    },
  };
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  return Array.isArray(value) ? value.map(stringValue).find((entry): entry is string => Boolean(entry)) : undefined;
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

type CrossrefResponse = {
  message?: unknown;
};

type CrossrefWork = Record<string, unknown> & {
  DOI?: unknown;
  title?: unknown;
  author?: unknown;
  published?: unknown;
  "published-print"?: unknown;
  "published-online"?: unknown;
  "container-title"?: unknown;
  URL?: unknown;
  type?: unknown;
  "is-referenced-by-count"?: unknown;
};
