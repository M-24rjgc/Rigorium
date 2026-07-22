import { parseXml, XmlElement } from "@rgrove/parse-xml";
import { networkFetch } from "../../network/fetch.js";
import { normalizeArxivIdentifier, normalizeDoi } from "../identity.js";
import type {
  LiteratureSearchResult,
  LiteratureSource,
  ResearchPaper,
  ResearchPaperProvenance,
  ResearchSourceApplied,
  ResearchSourceStatus,
  ResearchTopic,
  SearchPlan,
} from "../types.js";

export type CreateArxivSourceOptions = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Upper bound for the Atom response before any XML parser is invoked. */
  maxResponseBytes?: number;
  /** Defensive cap for the parsed XML tree depth. */
  maxXmlDepth?: number;
  /** Defensive cap for Atom entry records in one response. */
  maxEntries?: number;
  /**
   * Test-only override. Production callers use the documented 3-second
   * minimum between arXiv request starts.
   */
  minimumIntervalMs?: number;
};

const DEFAULT_ENDPOINT = "https://export.arxiv.org/api/query";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_MAX_XML_DEPTH = 32;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MINIMUM_INTERVAL_MS = 3_000;
const MAX_QUERY_LENGTH = 500;
const MAX_ABSTRACT_LENGTH = 4_000;
const MAX_AUTHORS = 100;

const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";
const ARXIV_NAMESPACE = "http://arxiv.org/schemas/atom";
const OPENSEARCH_NAMESPACE = "http://a9.com/-/spec/opensearch/1.1/";
const CATEGORY_TOKEN_PATTERN = /^[a-z][a-z-]*(?:\.[A-Za-z0-9-]+)?$/u;

/**
 * Official arXiv subject classes. An allow-list prevents category values from
 * becoming untrusted API query grammar while preserving all current primary
 * and cross-list classes that the desktop app supports.
 */
const ARXIV_CATEGORY_IDS = [
  "astro-ph.CO", "astro-ph.EP", "astro-ph.GA", "astro-ph.HE", "astro-ph.IM", "astro-ph.SR",
  "cond-mat.dis-nn", "cond-mat.mes-hall", "cond-mat.mtrl-sci", "cond-mat.other",
  "cond-mat.quant-gas", "cond-mat.soft", "cond-mat.stat-mech", "cond-mat.str-el", "cond-mat.supr-con",
  "cs.AI", "cs.AR", "cs.CC", "cs.CE", "cs.CG", "cs.CL", "cs.CR", "cs.CV", "cs.CY",
  "cs.DB", "cs.DC", "cs.DL", "cs.DM", "cs.DS", "cs.ET", "cs.FL", "cs.GL", "cs.GR",
  "cs.GT", "cs.HC", "cs.IR", "cs.IT", "cs.LG", "cs.LO", "cs.MA", "cs.MM", "cs.MS",
  "cs.NA", "cs.NE", "cs.NI", "cs.OH", "cs.OS", "cs.PF", "cs.PL", "cs.RO", "cs.SC",
  "cs.SD", "cs.SE", "cs.SI", "cs.SY",
  "econ.EM", "econ.GN", "econ.TH",
  "eess.AS", "eess.IV", "eess.SP",
  "gr-qc", "hep-ex", "hep-lat", "hep-ph", "hep-th",
  "math.AC", "math.AG", "math.AP", "math.AT", "math.CA", "math.CO", "math.CT", "math.CV",
  "math.DG", "math.DS", "math.FA", "math.GM", "math.GN", "math.GR", "math.GT", "math.HO",
  "math.IT", "math.KT", "math.LO", "math.MG", "math.MP", "math.NA", "math.NT", "math.OA",
  "math.OC", "math.PR", "math.QA", "math.RA", "math.RT", "math.SG", "math.SP", "math.ST",
  "nlin.AO", "nlin.CD", "nlin.CG", "nlin.PS", "nlin.SI",
  "nucl-ex", "nucl-th",
  "physics.acc-ph", "physics.ao-ph", "physics.app-ph", "physics.atm-clus", "physics.atom-ph",
  "physics.bio-ph", "physics.chem-ph", "physics.class-ph", "physics.comp-ph", "physics.data-an",
  "physics.ed-ph", "physics.flu-dyn", "physics.gen-ph", "physics.geo-ph", "physics.hist-ph",
  "physics.ins-det", "physics.med-ph", "physics.optics", "physics.org-ph", "physics.plasm-ph",
  "physics.pop-ph", "physics.soc-ph", "physics.space-ph",
  "q-bio.BM", "q-bio.CB", "q-bio.GN", "q-bio.MN", "q-bio.NC", "q-bio.OT", "q-bio.PE",
  "q-bio.QM", "q-bio.SC", "q-bio.TO",
  "q-fin.CP", "q-fin.EC", "q-fin.GN", "q-fin.MF", "q-fin.PM", "q-fin.PR", "q-fin.RM",
  "q-fin.ST", "q-fin.TR",
  "quant-ph",
  "stat.AP", "stat.CO", "stat.ME", "stat.ML", "stat.OT", "stat.TH",
] as const;

const arxivCategoriesByLowerCase = new Map(
  ARXIV_CATEGORY_IDS.map((category) => [category.toLowerCase(), category]),
);

/** Shared by adapters targeting the same arXiv endpoint in this process. */
const arxivRequestGates = new Map<string, ArxivRequestGate>();

export function createArxivSource(options: CreateArxivSourceOptions = {}): LiteratureSource {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positiveInteger(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = positiveInteger(options.maxResponseBytes) ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxXmlDepth = positiveInteger(options.maxXmlDepth) ?? DEFAULT_MAX_XML_DEPTH;
  const maxEntries = positiveInteger(options.maxEntries) ?? DEFAULT_MAX_ENTRIES;
  const minimumIntervalMs = effectiveArxivMinimumInterval(endpoint, options.minimumIntervalMs);

  return {
    id: "arxiv",
    name: "arXiv",
    async search(plan, context = {}) {
      let retrievedAt = (context.now?.() ?? new Date()).toISOString();
      let url: URL;
      let normalizedClassifications: string[];
      try {
        normalizedClassifications = normalizeArxivClassifications(plan.classifications);
        url = buildArxivUrl(endpoint, plan, normalizedClassifications);
      } catch (error) {
        return failedResult(
          retrievedAt,
          undefined,
          "arXiv request could not be prepared: " + errorMessage(error),
        );
      }

      try {
        const permit = arxivRequestGateFor(url, minimumIntervalMs).acquire(context.signal);
        const acquired = await permit;
        retrievedAt = (context.now?.() ?? new Date()).toISOString();
        try {
          const requestStartedAt = Date.now();
          const response = await requestArxivResponse(url, {
            fetchImpl,
            timeoutMs,
            signal: context.signal,
          });
          const body = await readArxivResponseBody(response, {
            signal: context.signal,
            timeoutMs: remainingTimeoutMs(requestStartedAt, timeoutMs),
            maxBytes: maxResponseBytes,
          });
          if (!response.ok) {
            return failedResult(
              retrievedAt,
              url,
              "arXiv API error (" + response.status + "): " + truncate(body || response.statusText, 400),
            );
          }

          const feed = parseArxivFeed(body, {
            maxDepth: maxXmlDepth,
            maxEntries: Math.min(maxEntries, Math.max(1, plan.limit)),
          });
          if (feed.kind === "error") {
            return failedResult(retrievedAt, url, "arXiv error feed: " + feed.message);
          }

          const papers: ResearchPaper[] = [];
          let skippedEntries = 0;
          for (let index = 0; index < feed.entries.length; index += 1) {
            const paper = normalizeArxivEntry(feed.entries[index]!, {
              rank: index + 1,
              retrievedAt,
              queryUrl: url.toString(),
            });
            if (paper) papers.push(paper);
            else skippedEntries += 1;
          }

          const warnings: string[] = [];
          if (plan.sort === "cited_by_count") {
            warnings.push("arXiv does not expose cited-by counts; requested ranking was downgraded to relevance.");
          }
          if (plan.sort === "publication_date") {
            warnings.push("arXiv does not expose publication dates separate from preprint submission; requested ranking uses submittedDate.");
          }
          if (skippedEntries > 0) {
            warnings.push(String(skippedEntries) + " malformed or incomplete arXiv entry records were ignored.");
          }
          if (feed.totalMatches !== undefined && feed.totalMatches > 0 && feed.entries.length === 0) {
            warnings.push("arXiv reported matching records but returned an empty Atom page.");
          }

          const applied = appliedArxivPlan(plan, normalizedClassifications);
          const source: ResearchSourceStatus = {
            id: "arxiv",
            name: "arXiv",
            status: "ok",
            retrievedAt,
            queryUrl: url.toString(),
            resultCount: papers.length,
            ...(feed.totalMatches !== undefined ? { totalMatches: feed.totalMatches } : {}),
            coverage: "Ranked arXiv preprint metadata for the submitted query. arXiv contributes identifiers, abstracts, categories, and submission history, but no citation edges.",
            ...(warnings.length > 0 ? { warnings } : {}),
            applied,
          };
          return { papers, edges: [], source };
        } catch (error) {
          if (error instanceof ArxivCancellationUnconfirmedError) acquired.poison();
          throw error;
        } finally {
          acquired.release();
        }
      } catch (error) {
        return failedResult(retrievedAt, url, "arXiv request failed: " + errorMessage(error));
      }
    },
  };
}

/**
 * Strictly validate provider-specific category filters before they enter the
 * arXiv query language. The return value uses official canonical casing.
 */
export function normalizeArxivClassifications(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("arXiv classifications must be an array.");
  }
  if (value.length > 8) {
    throw new Error("At most eight arXiv classification groups may be supplied.");
  }

  const categories: string[] = [];
  for (const classification of value) {
    if (!isRecord(classification) || classification.scheme !== "arxiv") {
      throw new Error("Only arXiv classification filters are supported.");
    }
    if (!Array.isArray(classification.include) || classification.include.length === 0 || classification.include.length > 32) {
      throw new Error("Each arXiv classification filter requires one to 32 category tokens.");
    }
    for (const token of classification.include) {
      if (typeof token !== "string") {
        throw new Error("arXiv category tokens must be strings.");
      }
      const canonical = normalizeArxivCategoryToken(token);
      if (!categories.includes(canonical)) categories.push(canonical);
    }
  }
  return categories;
}

export function normalizeArxivCategoryToken(value: string): string {
  const token = value.trim();
  if (!CATEGORY_TOKEN_PATTERN.test(token)) {
    throw new Error("Invalid arXiv category token: " + truncate(token, 80));
  }
  const canonical = arxivCategoriesByLowerCase.get(token.toLowerCase());
  if (!canonical) {
    throw new Error("Unsupported arXiv category token: " + truncate(token, 80));
  }
  return canonical;
}

function buildArxivUrl(endpoint: string, plan: SearchPlan, classifications: string[]): URL {
  const url = new URL(endpoint);
  const clauses = ["all:" + quoteArxivQuery(plan.query)];
  if (plan.fromYear || plan.toYear) {
    const from = plan.fromYear ? String(plan.fromYear) + "01010000" : "*";
    const to = plan.toYear ? String(plan.toYear) + "12312359" : "*";
    clauses.push("submittedDate:[" + from + " TO " + to + "]");
  }
  if (classifications.length > 0) {
    clauses.push("(" + classifications.map((category) => "cat:" + category).join(" OR ") + ")");
  }
  const sort = arxivSort(plan.sort);
  url.searchParams.set("search_query", clauses.join(" AND "));
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(plan.limit));
  url.searchParams.set("sortBy", sort.sortBy);
  url.searchParams.set("sortOrder", "descending");
  return url;
}

function quoteArxivQuery(value: string): string {
  const query = value
    .replace(/["\\]/gu, " ")
    .trim()
    .replace(/\s+/gu, " ")
    .slice(0, MAX_QUERY_LENGTH);
  if (!query) throw new Error("arXiv search requires a non-empty query.");
  return "\"" + query + "\"";
}

function arxivSort(sort: SearchPlan["sort"]): { sortBy: "relevance" | "submittedDate"; applied: string } {
  if (sort === "publication_date") {
    return { sortBy: "submittedDate", applied: "submittedDate:descending" };
  }
  return { sortBy: "relevance", applied: "relevance:descending" };
}

function appliedArxivPlan(plan: SearchPlan, classifications: string[]): ResearchSourceApplied {
  const sort = arxivSort(plan.sort);
  return {
    sort: sort.applied,
    ...(plan.fromYear || plan.toYear ? { dateField: "submitted" as const } : {}),
    ...(classifications.length > 0 ? { classifications } : {}),
  };
}

function arxivRequestGateFor(endpoint: URL, minimumIntervalMs: number): ArxivRequestGate {
  const key = arxivEndpointGateKey(endpoint);
  let gate = arxivRequestGates.get(key);
  if (!gate) {
    gate = new ArxivRequestGate(minimumIntervalMs);
    arxivRequestGates.set(key, gate);
  } else {
    gate.tightenMinimumInterval(minimumIntervalMs);
  }
  return gate;
}

/** @internal Test-only observability for the provider-wide request gate. */
export function inspectArxivRequestGateForTests(
  endpoint = DEFAULT_ENDPOINT,
  _minimumIntervalMs?: number,
): {
  nextRequestStartAt: number;
  minimumIntervalMs: number;
  poisoned: boolean;
} | undefined {
  return arxivRequestGates.get(arxivEndpointGateKey(new URL(endpoint)))?.snapshot();
}

function arxivEndpointGateKey(endpoint: URL): string {
  return endpoint.protocol + "//" + endpoint.host.toLowerCase() + endpoint.pathname;
}

function effectiveArxivMinimumInterval(endpoint: string, configuredMinimumIntervalMs: unknown): number {
  const requested = positiveInteger(configuredMinimumIntervalMs) ?? DEFAULT_MINIMUM_INTERVAL_MS;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return requested;
  }
  return isOfficialArxivApiEndpoint(parsed)
    ? Math.max(DEFAULT_MINIMUM_INTERVAL_MS, requested)
    : requested;
}

function isOfficialArxivApiEndpoint(endpoint: URL): boolean {
  const host = endpoint.hostname.toLowerCase();
  return ["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(host)
    && /^\/api\/query\/?$/u.test(endpoint.pathname);
}

type ArxivRequestPermit = {
  release(): void;
  /**
   * A cancellation failure leaves the previous HTTP stream's lifecycle
   * unknown. This deliberately blocks the endpoint queue forever rather than
   * risking a second concurrent arXiv connection.
   */
  poison(): void;
};

/**
 * A process-wide FIFO gate. The permit is deliberately held through response
 * consumption, so only one arXiv connection is active at a time. The next
 * request cannot start until both the preceding permit releases and the
 * documented minimum request-start interval has elapsed.
 */
class ArxivRequestGate {
  private tail: Promise<void> = Promise.resolve();
  private nextRequestStartAt = 0;
  private lastRequestStartedAt = 0;
  private poisoned = false;

  constructor(private minimumIntervalMs: number) {}

  tightenMinimumInterval(minimumIntervalMs: number): void {
    if (minimumIntervalMs <= this.minimumIntervalMs) return;
    this.minimumIntervalMs = minimumIntervalMs;
    this.nextRequestStartAt = Math.max(
      this.nextRequestStartAt,
      this.lastRequestStartedAt + this.minimumIntervalMs,
    );
  }

  async acquire(signal?: AbortSignal): Promise<ArxivRequestPermit> {
    const previous = this.tail;
    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.tail = previous.then(() => completion, () => completion);

    try {
      await waitForGate(previous, signal);
      await waitUntil(this.nextRequestStartAt, signal);
    } catch (error) {
      resolveCompletion?.();
      throw error;
    }

    const startedAt = Date.now();
    this.lastRequestStartedAt = startedAt;
    this.nextRequestStartAt = Math.max(this.nextRequestStartAt, startedAt + this.minimumIntervalMs);
    let released = false;
    return {
      release: () => {
        if (released || this.poisoned) return;
        released = true;
        resolveCompletion?.();
      },
      poison: () => {
        this.poisoned = true;
      },
    };
  }

  snapshot(): { nextRequestStartAt: number; minimumIntervalMs: number; poisoned: boolean } {
    return {
      nextRequestStartAt: this.nextRequestStartAt,
      minimumIntervalMs: this.minimumIntervalMs,
      poisoned: this.poisoned,
    };
  }
}

type RequestArxivResponseOptions = {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  signal?: AbortSignal;
};

/**
 * Keep the permit until networkFetch itself settles. Its timeout and parent
 * abort support abort the underlying transport, but a non-cooperative custom
 * fetch may still never settle; in that case the provider gate deliberately
 * remains held instead of allowing a second connection to overlap it.
 */
async function requestArxivResponse(url: URL, options: RequestArxivResponseOptions): Promise<Response> {
  return networkFetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/atom+xml, application/xml;q=0.9",
      "User-Agent": "Rigorium/0.1 (local research workspace)",
    },
    signal: options.signal,
  }, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    retry: { maxRetries: 0, retryStatuses: [] },
  });
}

type ReadArxivResponseBodyOptions = {
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
};

async function readArxivResponseBody(response: Response, options: ReadArxivResponseBodyOptions): Promise<string> {
  const contentLength = positiveInteger(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > options.maxBytes) {
    const error = bodySizeError(options.maxBytes);
    await cancelArxivResponseBody(response.body, error);
    throw error;
  }
  const reader = response.body?.getReader();
  if (!reader) return "";

  let failure: Error | undefined;
  let rejectInterrupted: ((reason?: unknown) => void) | undefined;
  let cancellation: Promise<void> | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupted = reject;
  });
  const beginCancellation = (reason: Error): void => {
    if (failure) return;
    failure = reason;
    cancellation = Promise.resolve()
      .then(() => reader.cancel(reason))
      .then(
        () => {
          rejectInterrupted?.(failure!);
        },
        (error: unknown) => {
          failure = cancellationUnconfirmedError("reader", error);
          rejectInterrupted?.(failure);
        },
      );
  };

  if (options.timeoutMs <= 0) {
    beginCancellation(bodyTimeoutError(0));
  }
  const timer = options.timeoutMs > 0
    ? setTimeout(() => {
      beginCancellation(bodyTimeoutError(options.timeoutMs));
    }, options.timeoutMs)
    : undefined;
  const onAbort = () => {
    beginCancellation(bodyAbortError(options.signal?.reason));
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const next = await Promise.race([reader.read(), interrupted]);
      if (failure) throw failure;
      if (next.done) {
        break;
      }
      const value = next.value;
      bytes += value.byteLength;
      if (bytes > options.maxBytes) {
        const error = bodySizeError(options.maxBytes);
        beginCancellation(error);
        await cancellation;
        throw failure ?? error;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (!failure) beginCancellation(normalized);
    else await cancellation;
    throw failure ?? normalized;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function cancelArxivResponseBody(body: ReadableStream<Uint8Array> | null, reason: Error): Promise<void> {
  if (!body) return;
  try {
    await body.cancel(reason);
  } catch (error) {
    throw cancellationUnconfirmedError("response body", error);
  }
}

class ArxivCancellationUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArxivCancellationUnconfirmedError";
  }
}

function cancellationUnconfirmedError(target: "reader" | "response body", error: unknown): ArxivCancellationUnconfirmedError {
  const detail = errorMessage(error);
  return new ArxivCancellationUnconfirmedError(
    "arXiv " + target + " cancellation could not be confirmed; this endpoint has been blocked to avoid overlapping requests"
      + (detail ? ": " + truncate(detail, 300) : ""),
  );
}

type ParsedArxivFeed =
  | { kind: "ok"; entries: XmlElement[]; totalMatches?: number }
  | { kind: "error"; message: string };

function parseArxivFeed(
  xml: string,
  options: { maxDepth: number; maxEntries: number },
): ParsedArxivFeed {
  preflightArxivXml(xml, options);
  const document = parseXml(xml);
  const root = document.root;
  if (!root || root.name !== "feed") {
    throw new Error("arXiv XML response did not contain an Atom feed root.");
  }
  validateFeedNamespaces(root);
  assertXmlDepth(root, options.maxDepth);

  const entries = childElements(root).filter((element) => element.name === "entry");
  if (entries.length > options.maxEntries) {
    throw new Error("arXiv XML response exceeded the " + options.maxEntries + "-entry limit.");
  }

  const errorElement = childElements(root).find((element) => element.name === "error");
  if (errorElement) {
    return {
      kind: "error",
      message: truncate(normalizeText(errorElement.text) ?? "unknown arXiv feed error", 600),
    };
  }
  const errorEntry = entries.length === 1 && isExplicitArxivErrorEntry(entries[0]!) ? entries[0]! : undefined;
  if (errorEntry) {
    return {
      kind: "error",
      message: truncate(
        directChildText(errorEntry, "summary") ?? directChildText(errorEntry, "title") ?? "unknown arXiv feed error",
        600,
      ),
    };
  }

  const totalText = directChildText(root, "opensearch:totalResults");
  if (totalText !== undefined && !/^\d+$/u.test(totalText)) {
    throw new Error("arXiv XML response contained an invalid opensearch:totalResults value.");
  }
  const totalMatches = totalText === undefined ? undefined : safeNonNegativeInteger(totalText);
  return {
    kind: "ok",
    entries,
    ...(totalMatches !== undefined ? { totalMatches } : {}),
  };
}

function isExplicitArxivErrorEntry(entry: XmlElement): boolean {
  const title = directChildText(entry, "title")?.toLocaleLowerCase("en-US");
  if (title !== "error" && title !== "错误") return false;
  const locators = [
    directChildText(entry, "id"),
    ...childElements(entry)
      .filter((element) => element.name === "link")
      .map((element) => element.attributes.href),
  ];
  return locators.some((locator) => isOfficialArxivErrorLocator(locator));
}

function isOfficialArxivErrorLocator(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host !== "arxiv.org" && host !== "export.arxiv.org") return false;
    return /^\/api\/errors(?:\/|$)/u.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Bound the hostile XML surface before building a document tree. This scanner
 * only counts tags; parseXml remains responsible for XML conformance. It skips
 * comments, CDATA, processing instructions, and quoted attributes so a string
 * that merely looks like markup cannot inflate the structural limits.
 */
function preflightArxivXml(xml: string, options: { maxDepth: number; maxEntries: number }): void {
  let index = 0;
  let depth = 0;
  let entries = 0;
  while (index < xml.length) {
    const start = xml.indexOf("<", index);
    if (start < 0) return;

    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      if (end < 0) return;
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const end = xml.indexOf("]]>", start + 9);
      if (end < 0) return;
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      if (end < 0) return;
      index = end + 2;
      continue;
    }
    if (startsXmlDeclaration(xml, start, "<!DOCTYPE") || startsXmlDeclaration(xml, start, "<!ENTITY")) {
      throw new Error("arXiv XML response contains a forbidden DOCTYPE or ENTITY declaration.");
    }

    const end = findXmlTagEnd(xml, start + 1);
    if (end < 0) return;
    if (xml.startsWith("</", start)) {
      depth = Math.max(0, depth - 1);
      index = end + 1;
      continue;
    }
    if (xml.startsWith("<!", start)) {
      index = end + 1;
      continue;
    }

    const name = xmlTagName(xml, start + 1, end);
    if (name === "entry") {
      entries += 1;
      if (entries > options.maxEntries) {
        throw new Error("arXiv XML response exceeded the " + options.maxEntries + "-entry limit before parsing.");
      }
    }
    if (!xmlTagIsSelfClosing(xml, start, end)) {
      depth += 1;
      if (depth > options.maxDepth) {
        throw new Error("arXiv XML response exceeded the " + options.maxDepth + "-level XML depth limit before parsing.");
      }
    }
    index = end + 1;
  }
}

function startsXmlDeclaration(xml: string, start: number, declaration: string): boolean {
  if (xml.slice(start, start + declaration.length).toUpperCase() !== declaration) return false;
  const next = xml[start + declaration.length];
  return next === undefined || /[\s[>]/u.test(next);
}

function findXmlTagEnd(xml: string, start: number): number {
  let quote: "\"" | "'" | undefined;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return -1;
}

function xmlTagName(xml: string, start: number, end: number): string {
  let index = start;
  while (index < end && /\s/u.test(xml[index]!)) index += 1;
  const nameStart = index;
  while (index < end && /[A-Za-z0-9:_.-]/u.test(xml[index]!)) index += 1;
  return xml.slice(nameStart, index);
}

function xmlTagIsSelfClosing(xml: string, start: number, end: number): boolean {
  let index = end - 1;
  while (index > start && /\s/u.test(xml[index]!)) index -= 1;
  return xml[index] === "/";
}

function validateFeedNamespaces(root: XmlElement): void {
  if (root.attributes.xmlns !== ATOM_NAMESPACE) {
    throw new Error("arXiv XML response did not declare the expected Atom namespace.");
  }
  if (root.attributes["xmlns:arxiv"] !== ARXIV_NAMESPACE) {
    throw new Error("arXiv XML response did not declare the expected arXiv namespace.");
  }
  if (root.attributes["xmlns:opensearch"] !== OPENSEARCH_NAMESPACE) {
    throw new Error("arXiv XML response did not declare the expected OpenSearch namespace.");
  }
}

function assertXmlDepth(root: XmlElement, maxDepth: number): void {
  const stack: Array<{ element: XmlElement; depth: number }> = [{ element: root, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > maxDepth) {
      throw new Error("arXiv XML response exceeded the " + maxDepth + "-level XML depth limit.");
    }
    for (const child of childElements(current.element)) {
      stack.push({ element: child, depth: current.depth + 1 });
    }
  }
}

function normalizeArxivEntry(
  entry: XmlElement,
  provenance: Omit<ResearchPaperProvenance, "sourceId" | "sourceRecordId">,
): ResearchPaper | null {
  const rawId = directChildText(entry, "id");
  const arxiv = normalizeArxivIdentifier(rawId);
  const title = normalizeText(directChildText(entry, "title"));
  if (!rawId || !arxiv || !title) return null;

  const published = normalizeAtomTimestamp(directChildText(entry, "published"));
  const updated = normalizeAtomTimestamp(directChildText(entry, "updated"));
  const categories = entryCategories(entry);
  const journalReference = normalizeText(directChildText(entry, "arxiv:journal_ref"));
  const doi = normalizeDoi(directChildText(entry, "arxiv:doi"));
  const canonicalUrl = "https://arxiv.org/abs/" + arxiv.id;
  const sourceRecordId = originalArxivRecordId(rawId, arxiv.id, arxiv.version);

  return {
    id: canonicalUrl,
    identity: {
      arxiv: arxiv.id,
      ...(arxiv.version !== undefined ? { arxivVersion: arxiv.version } : {}),
      ...(doi ? { doi } : {}),
    },
    title: truncate(title, 1_000),
    authors: entryAuthors(entry),
    ...(published ? { publicationDate: published } : {}),
    ...(published ? { year: Number(published.slice(0, 4)) } : {}),
    ...(updated ? { updatedAt: updated } : {}),
    type: "preprint",
    ...(journalReference ? { venue: truncate(journalReference, 500) } : {}),
    ...(doi ? { doi } : {}),
    url: canonicalUrl,
    citedByCount: 0,
    isOpenAccess: true,
    ...(normalizeText(directChildText(entry, "summary")) ? {
      abstract: truncate(normalizeText(directChildText(entry, "summary"))!, MAX_ABSTRACT_LENGTH),
    } : {}),
    topics: categories,
    referencedWorkIds: [],
    sourceId: "arxiv",
    sourceIds: ["arxiv"],
    provenance: [{
      sourceId: "arxiv",
      sourceRecordId,
      ...provenance,
    }],
  };
}

function entryAuthors(entry: XmlElement): string[] {
  const authors: string[] = [];
  for (const author of childElements(entry).filter((element) => element.name === "author")) {
    const name = normalizeText(directChildText(author, "name"));
    if (name && !authors.includes(name)) authors.push(name);
    if (authors.length >= MAX_AUTHORS) break;
  }
  return authors;
}

function entryCategories(entry: XmlElement): ResearchTopic[] {
  const primary = childElements(entry)
    .find((element) => element.name === "arxiv:primary_category")
    ?.attributes.term;
  const normalizedPrimary = primary ? canonicalProviderCategory(primary) : undefined;
  const categories = childElements(entry)
    .filter((element) => element.name === "category")
    .map((element) => element.attributes.term)
    .filter((term): term is string => typeof term === "string")
    .map(canonicalProviderCategory)
    .filter((term): term is string => Boolean(term));
  const ordered = [
    ...(normalizedPrimary ? [normalizedPrimary] : []),
    ...categories.filter((category) => category !== normalizedPrimary),
  ];
  return ordered.map((category, index) => ({
    id: "arxiv:" + category,
    name: category,
    score: index === 0 && normalizedPrimary ? 1 : 0.7,
  }));
}

function canonicalProviderCategory(value: string): string | undefined {
  const token = value.trim();
  if (!CATEGORY_TOKEN_PATTERN.test(token)) return undefined;
  return arxivCategoriesByLowerCase.get(token.toLowerCase());
}

function originalArxivRecordId(rawId: string, canonicalId: string, version?: number): string {
  const match = /\/(?:abs|pdf)\/([^?#\s]+?)(?:\.pdf)?$/iu.exec(rawId.trim());
  const record = match?.[1]?.toLowerCase();
  if (record) return record;
  return canonicalId + (version !== undefined ? "v" + version : "");
}

function normalizeAtomTimestamp(value: string | undefined): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return undefined;
  const date = new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  const year = date.getUTCFullYear();
  return year >= 1000 && year <= 9999 ? date.toISOString() : undefined;
}

function childElements(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => child instanceof XmlElement);
}

function directChildText(element: XmlElement, name: string): string | undefined {
  const child = childElements(element).find((candidate) => candidate.name === name);
  return child ? normalizeText(child.text) : undefined;
}

function normalizeText(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/gu, " ").trim();
  return text || undefined;
}

function failedResult(retrievedAt: string, url: URL | undefined, error: string): LiteratureSearchResult {
  return {
    papers: [],
    edges: [],
    source: {
      id: "arxiv",
      name: "arXiv",
      status: "error",
      retrievedAt,
      ...(url ? { queryUrl: url.toString() } : {}),
      resultCount: 0,
      coverage: "arXiv did not return usable results for this request.",
      error,
    },
  };
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function safeNonNegativeInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function remainingTimeoutMs(startedAt: number, timeoutMs: number): number {
  return Math.max(0, timeoutMs - (Date.now() - startedAt));
}

function bodyTimeoutError(timeoutMs: number): Error {
  return new Error("arXiv response body timed out after " + timeoutMs + "ms.");
}

function bodySizeError(maxBytes: number): Error {
  return new Error("arXiv response body exceeded the " + maxBytes + "-byte limit.");
}

function bodyAbortError(reason: unknown): Error {
  const detail = reason instanceof Error && reason.message ? ": " + reason.message : "";
  const error = new Error("arXiv response body read was aborted" + detail);
  error.name = "AbortError";
  return error;
}

function requestAbortError(reason: unknown): Error {
  const detail = reason instanceof Error && reason.message ? ": " + reason.message : "";
  const error = new Error("arXiv request was aborted" + detail);
  error.name = "AbortError";
  return error;
}

function waitForGate(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(requestAbortError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(requestAbortError(signal.reason));
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
  if (signal.aborted) return Promise.reject(requestAbortError(signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(requestAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength - 1) + "…" : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
