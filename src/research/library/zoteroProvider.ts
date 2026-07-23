import { randomUUID } from "node:crypto";
import { normalizeArxiv, normalizeDoi } from "../identity.js";
import type {
  LibraryImportResult,
  LibraryProvider,
  LibraryProviderStatus,
  ResearchPaper,
  ZoteroAttachment,
  ZoteroAttachmentFile,
  ZoteroAttachmentFullText,
  ZoteroCitationStyle,
  ZoteroCollectionsResult,
  ZoteroCollectionTarget,
  ZoteroChild,
  ZoteroItemDetail,
  ZoteroItemExport,
  ZoteroItemExportFormat,
  ZoteroItemsResult,
  ZoteroLibraryItem,
  ZoteroListItemsInput,
  ZoteroListTagsInput,
  ZoteroNote,
  ZoteroPaperMatch,
  ZoteroPaperMatchReason,
  ZoteroTagsResult,
} from "../types.js";

const LOCAL_API_ROOT = "/api/users/0";
const COLLECTION_PAGE_SIZE = 100;
const MAX_COLLECTIONS = 1_000;
const MAX_ITEM_LIMIT = 100;
const MAX_MATCH_PAPERS = 50;
const MATCH_CONCURRENCY = 4;
const MAX_ATTACHMENT_FULL_TEXT_CHARS = 1_000_000;
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

  const requestLocalApi = async (
    path: string,
    options: { accept?: string } = {},
  ): Promise<LocalApiResponse> => {
    const response = await request(path, {
      headers: {
        Accept: options.accept ?? "application/json",
        "Zotero-API-Version": "3",
      },
    });
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new ZoteroLocalApiError(
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
        writeMode: connectorReady ? "connector_import" : "read_only",
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
      const start = normalizedStart(input.start);
      const query = new URLSearchParams({
        format: "json",
        limit: String(limit),
        start: String(start),
      });
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
      const nextStart = hasNextPage(page.total, start, rawItems.length, limit)
        ? start + rawItems.length
        : undefined;
      return {
        ...(collectionKey ? { collection: { key: collectionKey, name: collectionKey } } : {}),
        items,
        total: page.total ?? items.length,
        start,
        ...(nextStart !== undefined ? { nextStart } : {}),
        truncated: nextStart !== undefined,
        ...(queryText ? { query: queryText } : {}),
      };
    },
    async listTags(input: ZoteroListTagsInput = {}): Promise<ZoteroTagsResult> {
      const collectionKey = normalizeCollectionKey(input.collectionKey);
      const queryText = normalizedQuery(input.query);
      const limit = normalizedLimit(input.limit);
      const start = normalizedStart(input.start);
      const query = new URLSearchParams({
        format: "json",
        limit: String(limit),
        start: String(start),
      });
      if (queryText) query.set("q", queryText);
      const path = collectionKey
        ? `${LOCAL_API_ROOT}/collections/${encodeURIComponent(collectionKey)}/items/top/tags?${query.toString()}`
        : `${LOCAL_API_ROOT}/items/top/tags?${query.toString()}`;
      const page = await requestLocalApi(path);
      const rawTags = arrayResponse(page.body);
      const tags = uniqueTagNames(rawTags.map(normalizeTagName));
      const nextStart = hasNextPage(page.total, start, rawTags.length, limit)
        ? start + rawTags.length
        : undefined;
      return {
        tags,
        total: page.total ?? tags.length,
        start,
        ...(nextStart !== undefined ? { nextStart } : {}),
        truncated: nextStart !== undefined,
        ...(queryText ? { query: queryText } : {}),
      };
    },
    async getItemDetails(itemKey: string): Promise<ZoteroItemDetail> {
      const key = requireZoteroItemKey(itemKey);
      const itemResult = await requestLocalApi(`${LOCAL_API_ROOT}/items/${encodeURIComponent(key)}?format=json`);
      const rawItem = singleResponse(itemResult.body);
      const item = rawItem ? normalizeZoteroItem(rawItem) : undefined;
      if (!item) {
        throw new ZoteroInputError("The requested Zotero item is not a bibliographic library item.");
      }

      const childrenResult = await requestLocalApi(
        `${LOCAL_API_ROOT}/items/${encodeURIComponent(key)}/children?format=json`,
      );
      const rawChildren = arrayResponse(childrenResult.body);
      const children = rawChildren
        .map(normalizeZoteroChild)
        .filter((child): child is ZoteroChild => child !== undefined);
      const attachments = rawChildren
        .map(normalizeZoteroAttachment)
        .filter((attachment): attachment is ZoteroAttachment => attachment !== undefined);
      const notes = rawChildren
        .map(normalizeZoteroNote)
        .filter((note): note is ZoteroNote => note !== undefined);

      return {
        item,
        tags: item.tags,
        data: sanitizeZoteroData(itemData(rawItem)),
        children,
        attachments,
        notes,
      };
    },
    async getAttachmentFullText(attachmentKey: string): Promise<ZoteroAttachmentFullText> {
      const key = requireZoteroItemKey(attachmentKey);
      const attachmentResult = await requestLocalApi(`${LOCAL_API_ROOT}/items/${encodeURIComponent(key)}?format=json`);
      const rawAttachment = singleResponse(attachmentResult.body);
      const attachment = rawAttachment ? normalizeZoteroAttachment(rawAttachment) : undefined;
      if (!attachment) {
        throw new ZoteroInputError("Full text can only be requested for a Zotero attachment.");
      }

      // This is deliberately a separate method and route from item details.
      // The Local API's file URL endpoint is never used here.
      const fullTextResult = await requestLocalApi(
        `${LOCAL_API_ROOT}/items/${encodeURIComponent(key)}/fulltext`,
      );
      return normalizeAttachmentFullText(key, fullTextResult.body);
    },
    async getAttachmentFile(attachmentKey: string): Promise<ZoteroAttachmentFile> {
      const key = requireZoteroItemKey(attachmentKey);
      const attachmentResult = await requestLocalApi(`${LOCAL_API_ROOT}/items/${encodeURIComponent(key)}?format=json`);
      const rawAttachment = singleResponse(attachmentResult.body);
      const attachment = rawAttachment ? normalizeZoteroAttachment(rawAttachment) : undefined;
      if (!attachment) {
        throw new ZoteroInputError("A local file can only be opened for a Zotero attachment.");
      }

      const fileResult = await requestLocalApi(
        `${LOCAL_API_ROOT}/items/${encodeURIComponent(key)}/file/view/url`,
        { accept: "text/plain, */*;q=0.8" },
      );
      return normalizeAttachmentFile(key, fileResult.body);
    },
    async exportItem(input): Promise<ZoteroItemExport> {
      const itemKey = requireZoteroItemKey(input.itemKey);
      const format = requireExportFormat(input.format);
      const style = requireCitationStyle(input.style);
      const officialFormat = format === "csl-json" ? "csljson" : format;
      const exportQuery = new URLSearchParams({
        itemKey,
        format: officialFormat,
        limit: "1",
      });
      const renderedQuery = new URLSearchParams({
        itemKey,
        format: "json",
        include: "data,citation,bib",
        style,
        limit: "1",
      });
      const [exportResult, renderedResult] = await Promise.all([
        requestLocalApi(
          `${LOCAL_API_ROOT}/items?${exportQuery.toString()}`,
          { accept: format === "bibtex" ? "text/plain, */*;q=0.8" : "application/json" },
        ),
        requestLocalApi(`${LOCAL_API_ROOT}/items?${renderedQuery.toString()}`),
      ]);
      const rendered = singleResponse(renderedResult.body);
      const citation = formattedOutput(rendered, "citation");
      const bibliography = formattedOutput(rendered, "bibliography");

      return {
        itemKey,
        format,
        style,
        content: format === "bibtex"
          ? exportText(exportResult.body)
          : exportCslJsonText(exportResult.body),
        ...(citation ? { citation } : {}),
        ...(bibliography ? { bibliography } : {}),
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

export class ZoteroLocalApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ZoteroLocalApiError";
  }
}

export class ZoteroInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoteroInputError";
  }
}

function singleResponse(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return value.find(isRecord);
  if (isRecord(value) && Array.isArray(value.items)) return value.items.find(isRecord);
  return isRecord(value) ? value : undefined;
}

function itemData(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return isRecord(value.data) ? value.data : value;
}

function normalizeZoteroChild(value: unknown): ZoteroChild | undefined {
  if (!isRecord(value)) return undefined;
  const data = itemData(value);
  const key = normalizeZoteroKey(data.key) ?? normalizeZoteroKey(value.key);
  if (!key) return undefined;
  const itemType = stringValue(data.itemType) ?? "item";
  const note = stringValue(data.note);
  const annotationText = stringValue(data.annotationText);
  const title = safeDisplayString(data.title)
    ?? safeDisplayString(data.filename)
    ?? notePreview(note)
    ?? annotationText
    ?? itemType;
  const parentItem = normalizeZoteroKey(data.parentItem);
  return {
    key,
    itemType,
    title,
    ...(parentItem ? { parentItem } : {}),
  };
}

function normalizeZoteroAttachment(value: unknown): ZoteroAttachment | undefined {
  const child = normalizeZoteroChild(value);
  if (!child || child.itemType !== "attachment") return undefined;
  const data = itemData(value);
  const contentType = stringValue(data.contentType);
  const linkMode = stringValue(data.linkMode);
  const filename = safeDisplayString(data.filename);
  const dateModified = stringValue(data.dateModified);
  return {
    ...child,
    itemType: "attachment",
    ...(contentType ? { contentType } : {}),
    ...(linkMode ? { linkMode } : {}),
    ...(filename ? { filename } : {}),
    ...(dateModified ? { dateModified } : {}),
  };
}

function normalizeZoteroNote(value: unknown): ZoteroNote | undefined {
  const child = normalizeZoteroChild(value);
  if (!child || child.itemType !== "note") return undefined;
  const html = stringValue(itemData(value).note) ?? "";
  return {
    ...child,
    itemType: "note",
    html,
    text: htmlToText(html),
  };
}

function normalizeAttachmentFullText(attachmentKey: string, value: unknown): ZoteroAttachmentFullText {
  const data = isRecord(value) ? value : {};
  const sourceContent = typeof data.content === "string"
    ? data.content
    : typeof value === "string"
      ? value
      : "";
  const truncated = sourceContent.length > MAX_ATTACHMENT_FULL_TEXT_CHARS;
  const content = truncated ? sourceContent.slice(0, MAX_ATTACHMENT_FULL_TEXT_CHARS) : sourceContent;
  const indexedPages = countValue(data.indexedPages);
  const totalPages = countValue(data.totalPages);
  const indexedChars = countValue(data.indexedChars);
  const version = countValue(data.version);
  return {
    attachmentKey,
    content,
    truncated,
    ...(indexedPages !== undefined ? { indexedPages } : {}),
    ...(totalPages !== undefined ? { totalPages } : {}),
    ...(indexedChars !== undefined ? { indexedChars } : {}),
    totalChars: sourceContent.length,
    ...(version !== undefined ? { version } : {}),
  };
}

function normalizeAttachmentFile(attachmentKey: string, value: unknown): ZoteroAttachmentFile {
  const rawUrl = stringValue(value)
    ?? (isRecord(value) ? stringValue(value.url) ?? stringValue(value.fileUrl) : undefined);
  if (!rawUrl || rawUrl.length > 16_384) {
    throw new ZoteroInputError("Zotero did not return a usable local attachment file URL.");
  }
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "file:"
      || (host && host !== "localhost")
      || parsed.pathname.startsWith("//")
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.search
      || parsed.hash
    ) {
      throw new Error("unsafe file URL");
    }
    return { attachmentKey, fileUrl: parsed.href };
  } catch {
    throw new ZoteroInputError("Zotero did not return a safe local attachment file URL.");
  }
}

function sanitizeZoteroData(value: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isLocalPathField(key)) continue;
    const sanitized = sanitizeZoteroValue(raw);
    if (sanitized !== undefined) safe[key] = sanitized;
  }
  return safe;
}

function sanitizeZoteroValue(value: unknown): unknown {
  if (typeof value === "string") return isLocalFileReference(value) ? undefined : value;
  if (Array.isArray(value)) {
    return value
      .map(sanitizeZoteroValue)
      .filter((entry): entry is Exclude<typeof entry, undefined> => entry !== undefined);
  }
  if (isRecord(value)) return sanitizeZoteroData(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  return undefined;
}

function isLocalPathField(value: string): boolean {
  return ["path", "filepath", "localpath", "fileurl", "file", "view", "fileview", "fileviewurl"]
    .includes(value.replace(/[^A-Za-z]/gu, "").toLowerCase());
}

function isLocalFileReference(value: string): boolean {
  const trimmed = value.trim();
  if (/^file:/iu.test(trimmed)
    || /^[A-Za-z]:[\\/]/u.test(trimmed)
    || /^\\\\[^\\]/u.test(trimmed)) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname.toLowerCase())
      && /\/(?:file|view)(?:\/|$)/iu.test(parsed.pathname);
  } catch {
    return false;
  }
}

function safeDisplayString(value: unknown): string | undefined {
  const text = stringValue(value);
  return text && !isLocalFileReference(text) ? text : undefined;
}

function notePreview(value: string | undefined): string | undefined {
  const text = value ? htmlToText(value) : "";
  return text ? text.slice(0, 160) : undefined;
}

function htmlToText(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(/<\/p\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function requireZoteroItemKey(value: unknown): string {
  const key = normalizeZoteroKey(value);
  if (!key) throw new ZoteroInputError("Zotero item keys must contain only letters and numbers.");
  return key;
}

function requireExportFormat(value: unknown): ZoteroItemExportFormat {
  if (value === "bibtex" || value === "csl-json") return value;
  throw new ZoteroInputError("format must be \"bibtex\" or \"csl-json\".");
}

function requireCitationStyle(value: unknown): ZoteroCitationStyle {
  if (value === "apa" || value === "chicago-author-date" || value === "ieee" || value === "mla") {
    return value;
  }
  throw new ZoteroInputError("Unsupported Zotero citation style.");
}

function exportText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function exportCslJsonText(value: unknown): string {
  if (Array.isArray(value) || isRecord(value)) return JSON.stringify(value, null, 2);
  throw new ZoteroLocalApiError("Zotero Local API returned invalid CSL-JSON export data.", 502);
}

function formattedOutput(
  value: Record<string, unknown> | undefined,
  kind: "citation" | "bibliography",
): string | undefined {
  if (!value) return undefined;
  const keys = kind === "citation" ? ["citation"] : ["bibliography", "bib"];
  const records = [value, isRecord(value.meta) ? value.meta : undefined, isRecord(value.data) ? value.data : undefined]
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  for (const record of records) {
    for (const key of keys) {
      const formatted = stringValue(record[key]);
      if (formatted) return formatted;
    }
  }
  return undefined;
}

function normalizeZoteroItem(value: unknown): ZoteroLibraryItem | undefined {
  if (!isRecord(value)) return undefined;
  const data = isRecord(value.data) ? value.data : value;
  const key = stringValue(data.key) ?? stringValue(value.key);
  if (!key) return undefined;
  const itemType = stringValue(data.itemType) ?? "item";
  if (["attachment", "note", "annotation"].includes(itemType)) return undefined;

  const title = safeDisplayString(data.title) ?? "";
  const date = stringValue(data.date);
  const url = safeDisplayString(data.url);
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
    ...(url ? { url } : {}),
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
      if (error instanceof ZoteroLocalApiError && error.status === 404) {
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
  const legacyArxiv = Object.entries(paper.identity.other ?? {})
    .find(([key]) => key.toLowerCase() === "arxiv")?.[1];
  return {
    ...(normalizeZoteroKey(paper.identity.zoteroKey) ? { zoteroKey: normalizeZoteroKey(paper.identity.zoteroKey) } : {}),
    ...(firstDefined(normalizeDoi(paper.identity.doi), normalizeDoi(paper.doi), normalizeDoi(paper.url))
      ? { doi: firstDefined(normalizeDoi(paper.identity.doi), normalizeDoi(paper.doi), normalizeDoi(paper.url)) }
      : {}),
    ...(firstDefined(normalizeArxiv(paper.identity.arxiv), normalizeArxiv(legacyArxiv), normalizeArxiv(paper.url))
      ? { arxiv: firstDefined(normalizeArxiv(paper.identity.arxiv), normalizeArxiv(legacyArxiv), normalizeArxiv(paper.url)) }
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

function normalizedStart(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ZoteroInputError("Zotero item pagination start must be a non-negative integer.");
  }
  return value;
}

function hasNextPage(
  total: number | undefined,
  start: number,
  returned: number,
  limit: number,
): boolean {
  if (returned === 0) return false;
  return total !== undefined ? start + returned < total : returned >= limit;
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

function normalizeTagName(value: unknown): string | undefined {
  if (isRecord(value) && isRecord(value.data)) return tagName(value.data);
  return tagName(value);
}

function uniqueTagNames(values: Array<string | undefined>): string[] {
  const tags = new Map<string, string>();
  for (const value of values) {
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    if (!tags.has(key)) tags.set(key, value);
  }
  return [...tags.values()].sort((left, right) => left.localeCompare(right));
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
