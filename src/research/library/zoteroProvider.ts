import { randomUUID } from "node:crypto";
import type {
  LibraryImportResult,
  LibraryProvider,
  LibraryProviderStatus,
  ResearchPaper,
  ZoteroCollectionTarget,
} from "../types.js";

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

  const getSelectedCollection = async (): Promise<ZoteroCollectionTarget | undefined> => {
    const response = await request("/connector/getSelectedCollection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

      try {
        const response = await request("/api/");
        apiReady = response.ok;
        if (!response.ok) errors.push(`Local API returned HTTP ${response.status}.`);
      } catch (error) {
        errors.push(`Local API unavailable: ${errorMessage(error)}`);
      }

      try {
        const response = await request("/connector/ping");
        connectorReady = response.ok;
        if (!response.ok) errors.push(`Connector returned HTTP ${response.status}.`);
      } catch (error) {
        errors.push(`Connector unavailable: ${errorMessage(error)}`);
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
        headers: { "Content-Type": "text/plain; charset=utf-8" },
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
  const collection = isRecord(value.collection) ? value.collection : value;
  const name = stringValue(collection.name)
    ?? stringValue(value.collectionName)
    ?? stringValue(value.libraryName)
    ?? "My Library";
  return {
    name,
    ...(stringValue(collection.id) ? { id: stringValue(collection.id) } : {}),
    ...(stringValue(collection.key) ? { key: stringValue(collection.key) } : {}),
    ...(typeof value.libraryID === "number" || typeof value.libraryID === "string"
      ? { libraryId: value.libraryID }
      : {}),
    ...(stringValue(value.libraryName) ? { libraryName: stringValue(value.libraryName) } : {}),
    ...(typeof value.editable === "boolean" ? { editable: value.editable } : {}),
  };
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
