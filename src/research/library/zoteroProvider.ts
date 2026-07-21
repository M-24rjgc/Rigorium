import { randomUUID } from "node:crypto";
import type {
  LibraryImportResult,
  LibraryProvider,
  LibraryProviderStatus,
  ResearchPaper,
  ZoteroCollectionsResult,
  ZoteroCollectionTarget,
  ZoteroItemsResult,
  ZoteroLibraryItem,
  ZoteroListItemsInput,
  ZoteroPaperMatch,
  ZoteroPaperMatchReason,
} from "../types.js";

const LOCAL_API_ROOT = "/api/users/0";
const COLLECTION_PAGE_SIZE = 100;
const MAX_COLLECTIONS = 1_000;
const MAX_ITEM_LIMIT = 100;
const MAX_MATCH_PAPERS = 50;
const MATCH_CONCURRENCY = 4;
const CONNECTOR_HEADERS = { "X-Zotero-Connector-API-Version": "3" } as const;

export type CreateZoteroLibraryProviderOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
};

export function createZoteroLibraryProvider(
  options: CreateZoteroLibraryProviderOptions = {},
): LibraryProvider {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? "http://127.0.0.1:23119");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const now = options.now ?? (() => new Date());

  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };

  const requestLocalApi = async (path: string): Promise<LocalApiResponse> => {
    const response = await request(path, {
      headers: {
        Accept: "application/json",
        "Zotero-API-Version": "3",
      },
    });
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new ZoteroHttpError(
        `Zotero Local API returned HTTP ${response.status}: ${responseText(body)}`,
        response.status,
      );
    }
    return { body, total: totalResults(response) };
  };

  const getSelectedCollection = async (): Promise<ZoteroCollectionTarget | undefined> => {
    const response = await request("/connector/getSelectedCollection", {
      method: "POST",
      headers: { ...CONNECTOR_HEADERS, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) return undefined;
    return normalizeCollectionTarget(await readResponseBody(response));
  };

  return {
    id: "zotero",
    async getStatus(): Promise<LibraryProviderStatus> {
      const checkedAt = now().toISOString();
      let apiReady = false;
      let connectorReady = false;
      let selectedCollection: ZoteroCollectionTarget | undefined;
      const errors: string[] = [];

      const [apiProbe, connectorProbe] = await Promise.allSettled([
        request("/api/", { headers: { "Zotero-API-Version": "3" } }),
        request("/connector/ping", { headers: CONNECTOR_HEADERS }),
      ]);
      if (apiProbe.status === "fulfilled") {
        apiReady = apiProbe.value.ok;
        if (!apiReady) errors.push(`Local API returned HTTP ${apiProbe.value.status}.`);
      } else {
        errors.push(`Local API unavailable: ${errorMessage(apiProbe.reason)}`);
      }
      if (connectorProbe.status === "fulfilled") {
        connectorReady = connectorProbe.value.ok;
        if (!connectorReady) errors.push(`Connector returned HTTP ${connectorProbe.value.status}.`);
      } else {
        errors.push(`Connector unavailable: ${errorMessage(connectorProbe.reason)}`);
      }

      if (connectorReady) {
        try {
          selectedCollection = await getSelectedCollection();
        } catch (error) {
          errors.push(`Selected collection unavailable: ${errorMessage(error)}`);
        }
      }

      return {
        provider: "zotero",
        available: apiReady || connectorReady,
        apiReady,
        connectorReady,
        checkedAt,
        ...(selectedCollection ? { selectedCollection } : {}),
        ...(errors.length > 0 ? { error: errors.join(" ") } : {}),
      };
    },
    getSelectedCollection,
    async listCollections(): Promise<ZoteroCollectionsResult> {
      const collections: ZoteroCollectionTarget[] = [];
      let reportedTotal: number | undefined;
      let start = 0;
      let truncated = false;

      while (collections.length < MAX_COLLECTIONS) {
        const limit = Math.min(COLLECTION_PAGE_SIZE, MAX_COLLECTIONS - collections.length);
        const query = new URLSearchParams({
          format: "json",
          limit: String(limit),
          start: String(start),
        });
        const page = await requestLocalApi(`${LOCAL_API_ROOT}/collections?${query.toString()}`);
        const rawCollections = arrayResponse(page.body);
        if (page.total !== undefined) reportedTotal = page.total;

        const normalized = rawCollections
          .map(normalizeCollectionTarget)
          .filter((collection): collection is ZoteroCollectionTarget => collection !== undefined);
        collections.push(...normalized);

        if (rawCollections.length < limit) break;
        start += rawCollections.length;
        if (reportedTotal !== undefined && start >= reportedTotal) break;
      }

      if (collections.length >= MAX_COLLECTIONS && (reportedTotal === undefined || reportedTotal > collections.length)) {
        truncated = true;
      }
      return {
        collections,
        total: reportedTotal ?? collections.length,
        truncated,
      };
    },
    async listItems(input: ZoteroListItemsInput = {}): Promise<ZoteroItemsResult> {
      const collectionKey = normalizeCollectionKey(input.collectionKey);
      const queryText = normalizedQuery(input.query);
      const limit = normalizedLimit(input.limit);
      const query = new URLSearchParams({ format: "json", limit: String(limit) });
      if (queryText) {
        query.set("q", queryText);
        query.set("qmode", "titleCreatorYear");
      }
      const path = collectionKey
        ? `${LOCAL_API_ROOT}/collections/${encodeURIComponent(collectionKey)}/items/top?${query.toString()}`
        : `${LOCAL_API_ROOT}/items/top?${query.toString()}`;
      const page = await requestLocalApi(path);
      const rawItems = arrayResponse(page.body);
      const items = rawItems
        .map(normalizeZoteroItem)
        .filter((item): item is ZoteroLibraryItem => item !== undefined);
      return {
        ...(collectionKey ? { collection: { key: collectionKey, name: collectionKey } } : {}),
        items,
        total: page.total ?? items.length,
        truncated: page.total !== undefined ? page.total > rawItems.length : rawItems.length >= limit,
        ...(queryText ? { query: queryText } : {}),
      };
    },
    async matchPapers(input): Promise<ZoteroPaperMatch[]> {
      const papers = Array.isArray(input.papers) ? input.papers.slice(0, MAX_MATCH_PAPERS) : [];
      const collectionKey = normalizeCollectionKey(input.collectionKey);
      return mapWithConcurrency(papers, MATCH_CONCURRENCY, async (paper) => {
        const candidates = await findPaperCandidates(paper, requestLocalApi);
        const matches = candidates
          .map((item) => ({ item, reasons: matchReasons(paper, item) }))
          .filter((candidate) => candidate.reasons.length > 0)
          .sort((left, right) => scoreMatch(right.reasons) - scoreMatch(left.reasons));
        const best = matches[0];
        if (!best) {
          return {
            paperId: paper.id,
            matched: false,
            confidence: "none",
            reasons: [],
            ...(collectionKey ? { inCollection: false } : {}),
          };
        }
        const heuristic = best.reasons.every((reason) => reason === "title");
        return {
          paperId: paper.id,
          matched: true,
          confidence: heuristic ? "heuristic" : "exact",
          reasons: best.reasons,
          item: best.item,
          ...(collectionKey ? { inCollection: best.item.collectionKeys.includes(collectionKey) } : {}),
        };
      });
    },
    async importPapers(input): Promise<LibraryImportResult> {
      if (input.confirmed !== true) {
        throw new Error("Zotero import requires explicit confirmation.");
      }
      if (!Array.isArray(input.papers) || input.papers.length === 0) {
        throw new Error("Select at least one paper to import into Zotero.");
      }
      if (input.papers.length > 50) {
        throw new Error("A single Zotero import is limited to 50 papers.");
      }

      const selectedCollection = await getSelectedCollection().catch(() => undefined);
      const session = `rigorium-${randomUUID()}`;
      const bibtex = papersToBibtex(input.papers);
      const response = await request(`/connector/import?session=${encodeURIComponent(session)}`, {
        method: "POST",
        headers: { ...CONNECTOR_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
        body: bibtex,
      });
      const responseBody = await readResponseBody(response);
      if (!response.ok) {
        throw new Error(`Zotero import failed (HTTP ${response.status}): ${responseText(responseBody)}`);
      }
      return {
        provider: "zotero",
        importedCount: input.papers.length,
        session,
        ...(selectedCollection ? { selectedCollection } : {}),
        response: responseBody,
      };
    },
  };
}

export function papersToBibtex(papers: ResearchPaper[]): string {
  const usedKeys = new Set<string>();
  return papers.map((paper, index) => {
    const key = uniqueCitationKey(paper, index, usedKeys);
    const fields: string[] = [
      `  title = {${escapeBibtex(paper.title)}}`,
    ];
    if (paper.authors.length > 0) fields.push(`  author = {${paper.authors.map(escapeBibtex).join(" and ")}}`);
    if (paper.year) fields.push(`  year = {${paper.year}}`);
    if (paper.venue) fields.push(`  journal = {${escapeBibtex(paper.venue)}}`);
    if (paper.doi) fields.push(`  doi = {${escapeBibtex(paper.doi)}}`);
    if (paper.url) fields.push(`  url = {${escapeBibtex(paper.url)}}`);
    return `@article{${key},\n${fields.join(",\n")}\n}`;
  }).join("\n\n");
}

function uniqueCitationKey(paper: ResearchPaper, index: number, used: Set<string>): string {
  const author = paper.authors[0]?.split(/\s+/u).at(-1) ?? "paper";
  const firstTitleWord = paper.title.match(/[\p{L}\p{N}]+/u)?.[0] ?? "research";
  const base = `${author}${paper.year ?? "nd"}${firstTitleWord}`
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/gu, "")
    .slice(0, 60) || `paper${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function escapeBibtex(value: string): string {
  return value.replace(/[{}]/gu, "").replace(/\s+/gu, " ").trim();
}

function normalizeCollectionTarget(value: unknown): ZoteroCollectionTarget | undefined {
  if (!isRecord(value)) return undefined;
  const collection = isRecord(value.collection)
    ? value.collection
    : isRecord(value.data)
      ? value.data
      : value;
  const key = stringValue(collection.key) ?? stringValue(value.key);
  const id = stringValue(collection.id) ?? stringValue(value.id);
  const name = stringValue(collection.name)
    ?? stringValue(value.collectionName)
    ?? stringValue(value.libraryName)
    ?? key;
  if (!name) return undefined;
  const library = isRecord(value.library) ? value.library : isRecord(collection.library) ? collection.library : {};
  const meta = isRecord(value.meta) ? value.meta : isRecord(collection.meta) ? collection.meta : {};
  const libraryId = libraryIdValue(value.libraryID)
    ?? libraryIdValue(collection.libraryID)
    ?? libraryIdValue(library.id);
  const libraryName = stringValue(value.libraryName)
    ?? stringValue(collection.libraryName)
    ?? stringValue(library.name);
  const parentKey = stringValue(collection.parentCollection) ?? stringValue(value.parentCollection);
  const itemCount = countValue(collection.numItems) ?? countValue(value.numItems) ?? countValue(meta.numItems);
  return {
    name,
    ...(id ? { id } : {}),
    ...(key ? { key } : {}),
    ...(libraryId !== undefined ? { libraryId } : {}),
    ...(libraryName ? { libraryName } : {}),
    ...(typeof value.editable === "boolean" ? { editable: value.editable } : {}),
    ...(parentKey ? { parentKey } : {}),
    ...(itemCount !== undefined ? { itemCount } : {}),
  };
}

type LocalApiResponse = {
  body: unknown;
  total?: number;
};

type LocalApiRequester = (path: string) => Promise<LocalApiResponse>;

class ZoteroHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ZoteroHttpError";
  }
}

function normalizeZoteroItem(value: unknown): ZoteroLibraryItem | undefined {
  if (!isRecord(value)) return undefined;
  const data = isRecord(value.data) ? value.data : value;
  const key = stringValue(data.key) ?? stringValue(value.key);
  if (!key) return undefined;
  const itemType = stringValue(data.itemType) ?? "item";
  if (["attachment", "note", "annotation"].includes(itemType)) return undefined;

  const title = stringValue(data.title) ?? "";
  const date = stringValue(data.date);
  const doi = firstDefined(
    normalizeDoi(data.DOI),
    normalizeDoi(data.doi),
    normalizeDoi(data.url),
    normalizeDoi(data.extra),
  );
  const arxiv = firstDefined(
    normalizeArxiv(data.arXiv),
    normalizeArxiv(data.arxiv),
    normalizeArxiv(data.archiveID),
    normalizeArxiv(data.archiveLocation),
    normalizeArxiv(data.extra),
    normalizeArxiv(data.url),
  );
  const pmid = firstDefined(
    normalizePmid(data.PMID),
    normalizePmid(data.pmid),
    normalizePmid(data.extra),
    normalizePmid(data.url),
  );
  const identity = {
    zoteroKey: key,
    ...(doi ? { doi } : {}),
    ...(arxiv ? { arxiv } : {}),
    ...(pmid ? { pmid } : {}),
  };
  const creators = Array.isArray(data.creators)
    ? data.creators.map(creatorDisplayName).filter((creator): creator is string => creator !== undefined)
    : [];
  const tags = Array.isArray(data.tags)
    ? data.tags.map(tagName).filter((tag): tag is string => tag !== undefined)
    : [];
  const collectionKeys = Array.isArray(data.collections)
    ? data.collections.map(normalizeCollectionKey).filter((collection): collection is string => collection !== undefined)
    : [];

  return {
    key,
    itemType,
    title,
    creators,
    ...(date ? { date } : {}),
    ...(yearFromDate(date) ? { year: yearFromDate(date) } : {}),
    ...(doi ? { doi } : {}),
    ...(arxiv ? { arxiv } : {}),
    ...(pmid ? { pmid } : {}),
    ...(stringValue(data.url) ? { url: stringValue(data.url) } : {}),
    tags,
    collectionKeys,
    identity,
  };
}

async function findPaperCandidates(
  paper: ResearchPaper,
  requestLocalApi: LocalApiRequester,
): Promise<ZoteroLibraryItem[]> {
  const identity = normalizedPaperIdentity(paper);
  if (identity.zoteroKey) {
    try {
      const result = await requestLocalApi(
        `${LOCAL_API_ROOT}/items/${encodeURIComponent(identity.zoteroKey)}?format=json`,
      );
      return uniqueItems(itemResponse(result.body));
    } catch (error) {
      if (error instanceof ZoteroHttpError && error.status === 404) {
        // A stale Zotero key should not prevent DOI/arXiv/PMID fallback matching.
      } else {
        throw error;
      }
    }
  }

  const searchTerms = [identity.doi, identity.arxiv, identity.pmid]
    .filter((value): value is string => value !== undefined);
  const candidates: ZoteroLibraryItem[] = [];
  for (const term of new Set(searchTerms)) {
    candidates.push(...await searchItems(term, "everything", requestLocalApi));
  }

  const hasExactMatch = candidates.some((candidate) => matchReasons(paper, candidate).some((reason) => reason !== "title"));
  if (!hasExactMatch && paper.title.trim()) {
    candidates.push(...await searchItems(paper.title, "titleCreatorYear", requestLocalApi));
  }
  return uniqueItems(candidates);
}

async function searchItems(
  queryText: string,
  mode: "everything" | "titleCreatorYear",
  requestLocalApi: LocalApiRequester,
): Promise<ZoteroLibraryItem[]> {
  const query = new URLSearchParams({
    format: "json",
    limit: "12",
    q: queryText,
    qmode: mode,
  });
  const result = await requestLocalApi(`${LOCAL_API_ROOT}/items?${query.toString()}`);
  return itemResponse(result.body);
}

function itemResponse(value: unknown): ZoteroLibraryItem[] {
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : isRecord(value)
        ? [value]
        : [];
  return values
    .map(normalizeZoteroItem)
    .filter((item): item is ZoteroLibraryItem => item !== undefined);
}

function arrayResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.items)) return value.items;
  return [];
}

function uniqueItems(items: ZoteroLibraryItem[]): ZoteroLibraryItem[] {
  const unique = new Map<string, ZoteroLibraryItem>();
  for (const item of items) unique.set(item.key.toUpperCase(), item);
  return [...unique.values()];
}

function normalizedPaperIdentity(paper: ResearchPaper): {
  zoteroKey?: string;
  doi?: string;
  arxiv?: string;
  pmid?: string;
} {
  return {
    ...(normalizeZoteroKey(paper.identity.zoteroKey) ? { zoteroKey: normalizeZoteroKey(paper.identity.zoteroKey) } : {}),
    ...(firstDefined(normalizeDoi(paper.identity.doi), normalizeDoi(paper.doi), normalizeDoi(paper.url))
      ? { doi: firstDefined(normalizeDoi(paper.identity.doi), normalizeDoi(paper.doi), normalizeDoi(paper.url)) }
      : {}),
    ...(firstDefined(normalizeArxiv(paper.identity.arxiv), normalizeArxiv(paper.url))
      ? { arxiv: firstDefined(normalizeArxiv(paper.identity.arxiv), normalizeArxiv(paper.url)) }
      : {}),
    ...(firstDefined(normalizePmid(paper.identity.pmid), normalizePmid(paper.url))
      ? { pmid: firstDefined(normalizePmid(paper.identity.pmid), normalizePmid(paper.url)) }
      : {}),
  };
}

function matchReasons(paper: ResearchPaper, item: ZoteroLibraryItem): ZoteroPaperMatchReason[] {
  const source = normalizedPaperIdentity(paper);
  const reasons: ZoteroPaperMatchReason[] = [];
  if (source.zoteroKey && source.zoteroKey === normalizeZoteroKey(item.key)) reasons.push("zotero_key");
  if (source.doi && source.doi === normalizeDoi(item.doi)) reasons.push("doi");
  if (source.arxiv && source.arxiv === normalizeArxiv(item.arxiv)) reasons.push("arxiv");
  if (source.pmid && source.pmid === normalizePmid(item.pmid)) reasons.push("pmid");
  if (reasons.length > 0) return reasons;

  const sourceTitle = normalizedTitle(paper.title);
  const itemTitle = normalizedTitle(item.title);
  const compatibleYear = paper.year === undefined || item.year === undefined || paper.year === item.year;
  const identifiersConflict = Boolean(
    (source.doi && item.doi && source.doi !== normalizeDoi(item.doi))
    || (source.arxiv && item.arxiv && source.arxiv !== normalizeArxiv(item.arxiv))
    || (source.pmid && item.pmid && source.pmid !== normalizePmid(item.pmid)),
  );
  if (!identifiersConflict && sourceTitle.length >= 12 && sourceTitle === itemTitle && compatibleYear) {
    return ["title"];
  }
  return [];
}

function scoreMatch(reasons: ZoteroPaperMatchReason[]): number {
  return reasons.reduce((score, reason) => score + ({
    zotero_key: 100,
    doi: 90,
    arxiv: 80,
    pmid: 70,
    title: 10,
  } as const)[reason], 0);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function normalizedQuery(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
}

function normalizedLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_ITEM_LIMIT, Math.max(1, Math.round(value)))
    : 50;
}

function normalizeCollectionKey(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const key = value.trim();
  if (!/^[A-Za-z0-9]{1,32}$/u.test(key)) {
    throw new Error("Zotero collection keys must contain only letters and numbers.");
  }
  return key;
}

function normalizeZoteroKey(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9]{1,32}$/u.test(value.trim())
    ? value.trim().toUpperCase()
    : undefined;
}

function normalizeDoi(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const doi = raw
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
    .replace(/^doi:\s*/iu, "")
    .replace(/[\s.,;]+$/u, "")
    .toLowerCase();
  return /^10\.\d{4,9}\/.+$/u.test(doi) ? doi : undefined;
}

function normalizeArxiv(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const direct = raw.match(/^(?:arxiv:\s*)?([a-z-]+(?:\.[a-z-]+)?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?$/iu);
  const embedded = raw.match(/(?:arxiv(?:\.org\/(?:abs|pdf)\/|:\s*|\s+))([a-z-]+(?:\.[a-z-]+)?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/iu);
  return (direct?.[1] ?? embedded?.[1])?.toLowerCase();
}

function normalizePmid(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const direct = raw.match(/^\d{4,10}$/u)?.[0];
  const embedded = raw.match(/(?:pmid\s*:\s*|pubmed\.ncbi\.nlm\.nih\.gov\/)(\d{4,10})/iu)?.[1];
  return direct ?? embedded;
}

function normalizedTitle(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

function creatorDisplayName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const literal = stringValue(value.name);
  if (literal) return literal;
  return [stringValue(value.firstName), stringValue(value.lastName)].filter(Boolean).join(" ") || undefined;
}

function tagName(value: unknown): string | undefined {
  return typeof value === "string" ? stringValue(value) : isRecord(value) ? stringValue(value.tag) : undefined;
}

function yearFromDate(value: string | undefined): number | undefined {
  const year = value?.match(/\b(18|19|20|21)\d{2}\b/u)?.[0];
  return year ? Number(year) : undefined;
}

function totalResults(response: Response): number | undefined {
  const value = response.headers.get("Total-Results");
  if (!value) return undefined;
  const total = Number(value);
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

function libraryIdValue(value: unknown): string | number | undefined {
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

function countValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Zotero provider only connects to a local loopback HTTP endpoint.");
  }
  return parsed.toString().replace(/\/$/u, "");
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function responseText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 400) : JSON.stringify(value).slice(0, 400);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
