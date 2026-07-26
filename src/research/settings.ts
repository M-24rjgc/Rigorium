import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ResearchSettings, ResearchSettingsSnapshot, ResearchSettingsScope } from "./types.js";

export const DEFAULT_RESEARCH_SETTINGS: ResearchSettings = {
  schemaVersion: 1,
  literature: {
    enabled: true,
    sources: {
      openalex: {
        enabled: true,
        mailto: "",
      },
      arxiv: {
        enabled: true,
      },
      crossref: {
        enabled: true,
        mailto: "",
      },
      openreview: {
        // This source stays dormant unless the agent provides an explicit
        // official OpenReview venue ID in a venue set.
        enabled: true,
      },
    },
    search: {
      defaultLimit: 12,
      fromYear: null,
      toYear: null,
      sort: "relevance",
    },
    budget: {
      maxResultsPerSearch: 25,
      requestTimeoutMs: 20_000,
    },
    map: {
      autoOpen: true,
      autoUpdate: true,
      showTopicEdges: true,
    },
  },
  zotero: {
    enabled: true,
    baseUrl: "http://127.0.0.1:23119",
    useSelectedCollection: true,
    collectionKey: null,
    collectionName: null,
    cloud: {
      enabled: false,
      libraryType: "user",
      libraryId: null,
    },
  },
  citation: {
    style: "apa",
    includeDoi: true,
  },
  privacy: {
    allowRemoteMetadataSearch: true,
    allowRemoteFullText: false,
  },
};

type ReadResearchSettingsInput = {
  rigoriumHome?: string;
  projectRoot?: string;
};

type WriteResearchSettingsInput = ReadResearchSettingsInput & {
  scope: ResearchSettingsScope;
  settings: unknown;
  projectOverrideEnabled?: boolean;
};

export function getResearchSettingsPaths(input: ReadResearchSettingsInput = {}) {
  const rigoriumHome = resolve(input.rigoriumHome?.trim() || process.env.RIGORIUM_HOME || join(homedir(), ".rigorium"));
  const globalPath = join(rigoriumHome, "research", "settings.json");
  const projectPath = input.projectRoot?.trim()
    ? join(resolve(input.projectRoot), ".rigorium", "research", "settings.json")
    : undefined;
  return { globalPath, projectPath };
}

export async function readResearchSettings(
  input: ReadResearchSettingsInput = {},
): Promise<ResearchSettingsSnapshot> {
  const paths = getResearchSettingsPaths(input);
  const globalRaw = await readJsonFile(paths.globalPath);
  const global = normalizeResearchSettings(globalRaw, DEFAULT_RESEARCH_SETTINGS);

  let projectOverride: ResearchSettingsSnapshot["projectOverride"] = null;
  let effective = global;
  if (paths.projectPath) {
    const raw = await readJsonFile(paths.projectPath);
    if (isRecord(raw)) {
      const enabled = raw.enabled !== false;
      const settings = normalizeResearchSettings(raw.settings, global);
      projectOverride = {
        enabled,
        path: paths.projectPath,
        settings,
      };
      if (enabled) effective = settings;
    }
  }

  return {
    global,
    projectOverride,
    effective,
    paths: {
      global: paths.globalPath,
      ...(paths.projectPath ? { project: paths.projectPath } : {}),
    },
  };
}

export async function writeResearchSettings(input: WriteResearchSettingsInput): Promise<ResearchSettingsSnapshot> {
  const paths = getResearchSettingsPaths(input);
  if (input.scope === "project" && !paths.projectPath) {
    throw new Error("Project-scoped research settings require a project root.");
  }

  if (input.scope === "global") {
    const settings = normalizeResearchSettings(input.settings, DEFAULT_RESEARCH_SETTINGS);
    validateResearchSettings(settings);
    await writeJsonFile(paths.globalPath, settings);
  } else {
    const current = await readResearchSettings(input);
    const settings = normalizeResearchSettings(input.settings, current.global);
    validateResearchSettings(settings);
    await writeJsonFile(paths.projectPath!, {
      schemaVersion: 1,
      enabled: input.projectOverrideEnabled !== false,
      settings,
    });
  }

  return readResearchSettings(input);
}

export function normalizeResearchSettings(value: unknown, base: ResearchSettings): ResearchSettings {
  const root = isRecord(value) ? value : {};
  const literature = isRecord(root.literature) ? root.literature : {};
  const sources = isRecord(literature.sources) ? literature.sources : {};
  const openalex = isRecord(sources.openalex) ? sources.openalex : {};
  const arxiv = isRecord(sources.arxiv) ? sources.arxiv : {};
  const crossref = isRecord(sources.crossref) ? sources.crossref : {};
  const openreview = isRecord(sources.openreview) ? sources.openreview : {};
  const search = isRecord(literature.search) ? literature.search : {};
  const budget = isRecord(literature.budget) ? literature.budget : {};
  const map = isRecord(literature.map) ? literature.map : {};
  const zotero = isRecord(root.zotero) ? root.zotero : {};
  const cloud = isRecord(zotero.cloud) ? zotero.cloud : {};
  const citation = isRecord(root.citation) ? root.citation : {};
  const privacy = isRecord(root.privacy) ? root.privacy : {};

  return {
    schemaVersion: 1,
    literature: {
      enabled: booleanValue(literature.enabled, base.literature.enabled),
      sources: {
        openalex: {
          enabled: booleanValue(openalex.enabled, base.literature.sources.openalex.enabled),
          mailto: stringValue(openalex.mailto, base.literature.sources.openalex.mailto, 200),
        },
        arxiv: {
          enabled: booleanValue(arxiv.enabled, base.literature.sources.arxiv.enabled),
        },
        crossref: {
          enabled: booleanValue(crossref.enabled, base.literature.sources.crossref.enabled),
          mailto: stringValue(crossref.mailto, base.literature.sources.crossref.mailto, 200),
        },
        openreview: {
          enabled: booleanValue(openreview.enabled, base.literature.sources.openreview?.enabled ?? true),
        },
      },
      search: {
        defaultLimit: integerValue(search.defaultLimit, base.literature.search.defaultLimit, 1, 100),
        fromYear: nullableYear(search.fromYear, base.literature.search.fromYear),
        toYear: nullableYear(search.toYear, base.literature.search.toYear),
        sort: enumValue(
          search.sort,
          ["relevance", "cited_by_count", "publication_date"] as const,
          base.literature.search.sort,
        ),
      },
      budget: {
        maxResultsPerSearch: integerValue(
          budget.maxResultsPerSearch,
          base.literature.budget.maxResultsPerSearch,
          1,
          100,
        ),
        requestTimeoutMs: integerValue(
          budget.requestTimeoutMs,
          base.literature.budget.requestTimeoutMs,
          2_000,
          120_000,
        ),
      },
      map: {
        autoOpen: booleanValue(map.autoOpen, base.literature.map.autoOpen),
        autoUpdate: booleanValue(map.autoUpdate, base.literature.map.autoUpdate),
        showTopicEdges: booleanValue(map.showTopicEdges, base.literature.map.showTopicEdges),
      },
    },
    zotero: {
      enabled: booleanValue(zotero.enabled, base.zotero.enabled),
      baseUrl: loopbackBaseUrl(zotero.baseUrl, base.zotero.baseUrl),
      useSelectedCollection: booleanValue(zotero.useSelectedCollection, base.zotero.useSelectedCollection),
      collectionKey: zoteroCollectionKey(zotero.collectionKey, base.zotero.collectionKey),
      collectionName: zoteroCollectionName(
        zotero.collectionName,
        zoteroCollectionKey(zotero.collectionKey, base.zotero.collectionKey),
        base.zotero,
      ),
      cloud: {
        enabled: booleanValue(cloud.enabled, base.zotero.cloud.enabled),
        libraryType: enumValue(
          cloud.libraryType,
          ["user", "group"] as const,
          base.zotero.cloud.libraryType,
        ),
        libraryId: zoteroCloudLibraryId(cloud.libraryId, base.zotero.cloud.libraryId),
      },
    },
    citation: {
      style: enumValue(
        citation.style,
        ["apa", "chicago-author-date", "ieee", "mla"] as const,
        base.citation.style,
      ),
      includeDoi: booleanValue(citation.includeDoi, base.citation.includeDoi),
    },
    privacy: {
      allowRemoteMetadataSearch: booleanValue(
        privacy.allowRemoteMetadataSearch,
        base.privacy.allowRemoteMetadataSearch,
      ),
      allowRemoteFullText: booleanValue(privacy.allowRemoteFullText, base.privacy.allowRemoteFullText),
    },
  };
}

export function validateResearchSettings(settings: ResearchSettings): void {
  const { fromYear, toYear } = settings.literature.search;
  if (fromYear !== null && toYear !== null && fromYear > toYear) {
    throw new Error("Research search start year cannot be after the end year.");
  }
  if (settings.literature.search.defaultLimit > settings.literature.budget.maxResultsPerSearch) {
    throw new Error("Default result count cannot exceed the per-search budget.");
  }
  const cloud = settings.zotero.cloud;
  if (cloud.libraryId !== null && !isPositiveLibraryId(cloud.libraryId)) {
    throw new Error("Zotero cloud library ID must be a positive integer.");
  }
  if (cloud.enabled && cloud.libraryType === "group" && cloud.libraryId === null) {
    throw new Error("A Zotero cloud group library requires a library ID.");
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/u, "")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : fallback;
}

function zoteroCollectionKey(value: unknown, fallback: string | null): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return fallback;
  const key = value.trim();
  return /^[A-Za-z0-9]{1,32}$/u.test(key) ? key : fallback;
}

function zoteroCollectionName(
  value: unknown,
  collectionKey: string | null,
  base: ResearchSettings["zotero"],
): string | null {
  if (!collectionKey) return null;
  if (value === null || value === "") return null;
  if (typeof value === "string") return value.trim().slice(0, 500) || null;
  return collectionKey === base.collectionKey ? base.collectionName : null;
}

function zoteroCloudLibraryId(value: unknown, fallback: string | null): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return fallback;
  const libraryId = value.trim();
  if (!isPositiveLibraryId(libraryId)) {
    throw new Error("Zotero cloud library ID must be a positive integer.");
  }
  return libraryId;
}

function isPositiveLibraryId(value: string): boolean {
  return /^[1-9]\d*$/u.test(value);
}

function integerValue(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function nullableYear(value: unknown, fallback: number | null): number | null {
  if (value === null || value === "") return null;
  const currentMax = new Date().getUTCFullYear() + 2;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(currentMax, Math.max(1800, Math.round(value)))
    : fallback;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function loopbackBaseUrl(value: unknown, fallback: string): string {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Zotero base URL must be a valid URL.");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Zotero base URL must use HTTP on the local loopback interface.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Zotero base URL must not contain credentials.");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
