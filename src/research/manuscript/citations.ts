import {
  canonicalJson,
  createResearchArtifact,
  type ResearchArtifactSource,
} from "../artifacts/index.js";
import type { ZoteroLibraryItem } from "../types.js";
import type {
  BibtexEntryData,
  CitationRecord,
  CitationSetArtifact,
  CitationSetDiagnostic,
  CreateCitationSetInput,
  ZoteroCitationData,
} from "./types.js";
import {
  MANUSCRIPT_LIMITS,
  hashText,
  requireCitationKey,
  requireHash,
  requireIdentifier,
  requireText,
} from "./validation.js";

const BIBTEX_ENTRY_TYPE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const BIBTEX_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export function createCitationSet(input: CreateCitationSetInput): CitationSetArtifact {
  const zoteroItems = input.zoteroItems ?? [];
  const bibtexEntries = input.bibtexEntries ?? [];
  if (zoteroItems.length + bibtexEntries.length === 0) {
    throw new TypeError("CitationSet requires at least one Zotero or BibTeX entry.");
  }
  if (zoteroItems.length + bibtexEntries.length > MANUSCRIPT_LIMITS.maxCitations) {
    throw new TypeError(`CitationSet cannot exceed ${MANUSCRIPT_LIMITS.maxCitations} entries.`);
  }

  const usedKeys = new Set<string>();
  const diagnostics: CitationSetDiagnostic[] = [];
  const records: CitationRecord[] = [];

  for (const entry of bibtexEntries) {
    records.push(fromBibtexEntry(entry, usedKeys));
  }
  for (const citation of zoteroItems) {
    records.push(fromZoteroItem(citation, usedKeys, diagnostics));
  }

  records.sort((left, right) => left.citationKey.localeCompare(right.citationKey, "en"));
  diagnostics.sort((left, right) => {
    const byKey = left.citationKey.localeCompare(right.citationKey, "en");
    return byKey || left.code.localeCompare(right.code, "en");
  });
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "citation_set" as const,
    entries: Object.freeze(records),
    citationKeys: Object.freeze(records.map((entry) => entry.citationKey)),
    bibtex: `${records.map((entry) => entry.bibtex).join("\n\n")}\n`,
    diagnostics: Object.freeze(diagnostics),
  });
  const sources: ResearchArtifactSource[] = records.map((record) => ({
    sourceId: record.source.kind,
    recordId: record.source.recordId,
    contentHash: record.source.contentHash,
  }));

  return createResearchArtifact({
    kind: "citation_set",
    payload,
    producer: input.producer,
    sources,
    ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

export function renderBibtexEntry(entry: Pick<CitationRecord, "citationKey" | "entryType" | "fields">): string {
  const citationKey = requireCitationKey(entry.citationKey);
  const entryType = requireEntryType(entry.entryType);
  const fields = normalizeFields(entry.fields);
  const lines = Object.entries(fields).map(([key, value]) => `  ${key} = {${escapeBibtexText(value)}}`);
  return `@${entryType}{${citationKey},\n${lines.join(",\n")}\n}`;
}

function fromBibtexEntry(entry: BibtexEntryData, usedKeys: Set<string>): CitationRecord {
  if (!entry || typeof entry !== "object") throw new TypeError("BibTeX entries must be objects.");
  const citationKey = reserveExplicitKey(entry.citationKey, usedKeys);
  const entryType = requireEntryType(entry.entryType);
  const fields = normalizeFields(entry.fields);
  const title = requireText(fields.title ?? "", `BibTeX ${citationKey} title`, 8_000);
  const authors = splitAuthors(fields.author);
  const bibtex = renderBibtexEntry({ citationKey, entryType, fields });
  const recordId = entry.sourceRecordId === undefined
    ? citationKey
    : requireText(entry.sourceRecordId, `BibTeX ${citationKey} sourceRecordId`, 1_000);
  return Object.freeze({
    citationKey,
    entryType,
    title,
    authors: Object.freeze(authors),
    fields: Object.freeze(fields),
    bibtex,
    source: Object.freeze({ kind: "bibtex" as const, recordId, contentHash: hashText(bibtex) }),
    ...(entry.paperId === undefined ? {} : { paperId: requireIdentifier(entry.paperId, `BibTeX ${citationKey} paperId`) }),
  });
}

function fromZoteroItem(
  citation: ZoteroCitationData,
  usedKeys: Set<string>,
  diagnostics: CitationSetDiagnostic[],
): CitationRecord {
  if (!citation || typeof citation !== "object") throw new TypeError("Zotero citation entries must be objects.");
  const item = normalizeZoteroItem(citation.item);
  let citationKey: string;
  if (citation.citationKey !== undefined) {
    citationKey = reserveExplicitKey(citation.citationKey, usedKeys);
  } else {
    const base = generatedCitationKey(item);
    citationKey = reserveGeneratedKey(base, usedKeys);
    diagnostics.push(Object.freeze({
      code: "generated_key" as const,
      citationKey,
      message: `Generated a deterministic citation key for Zotero item ${item.key}.`,
    }));
    if (citationKey !== base) {
      diagnostics.push(Object.freeze({
        code: "key_collision_resolved" as const,
        citationKey,
        message: `Resolved generated citation-key collision for Zotero item ${item.key}.`,
      }));
    }
  }
  if (item.creators.length === 0) diagnostics.push(missingDiagnostic("missing_author", citationKey, "The source has no author metadata."));
  if (item.year === undefined) diagnostics.push(missingDiagnostic("missing_year", citationKey, "The source has no normalized publication year."));

  const entryType = zoteroEntryType(item.itemType);
  const fields = normalizeFields({
    title: item.title,
    ...(item.creators.length === 0 ? {} : { author: item.creators.join(" and ") }),
    ...(item.year === undefined ? {} : { year: String(item.year) }),
    ...(item.doi === undefined ? {} : { doi: normalizeDoi(item.doi) }),
    ...(item.url === undefined ? {} : { url: item.url }),
    ...(item.arxiv === undefined ? {} : { eprint: item.arxiv, archiveprefix: "arXiv" }),
  });
  const bibtex = renderBibtexEntry({ citationKey, entryType, fields });
  const sourceHash = citation.sourceContentHash === undefined
    ? hashText(canonicalJson(item))
    : requireHash(citation.sourceContentHash, `Zotero ${item.key} sourceContentHash`);
  return Object.freeze({
    citationKey,
    entryType,
    title: item.title,
    authors: Object.freeze([...item.creators]),
    fields: Object.freeze(fields),
    bibtex,
    source: Object.freeze({ kind: "zotero" as const, recordId: item.key, contentHash: sourceHash }),
    ...(citation.paperId === undefined ? {} : { paperId: requireIdentifier(citation.paperId, `Zotero ${item.key} paperId`) }),
  });
}

function normalizeZoteroItem(item: ZoteroLibraryItem): ZoteroLibraryItem {
  if (!item || typeof item !== "object") throw new TypeError("Zotero item must be an object.");
  const key = requireIdentifier(item.key, "Zotero item key");
  const title = requireText(item.title, `Zotero ${key} title`, 8_000);
  const itemType = requireText(item.itemType, `Zotero ${key} itemType`, 128);
  const creators = (item.creators ?? []).map((creator, index) => requireText(creator, `Zotero ${key} creators[${index}]`, 1_000));
  return {
    ...item,
    key,
    title,
    itemType,
    creators,
    tags: [...(item.tags ?? [])],
    collectionKeys: [...(item.collectionKeys ?? [])],
    identity: { ...(item.identity ?? {}) },
  };
}

function normalizeFields(value: Readonly<Record<string, string>>): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("BibTeX fields must be an object.");
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const key = rawKey.toLowerCase();
    if (!BIBTEX_FIELD_NAME.test(key)) throw new TypeError(`Unsupported BibTeX field name: ${rawKey}.`);
    normalized[key] = requireText(rawValue, `BibTeX field ${key}`, 64_000);
  }
  if (Object.keys(normalized).length === 0) throw new TypeError("BibTeX entry must contain fields.");
  return normalized;
}

function requireEntryType(value: string): string {
  const normalized = requireText(value, "BibTeX entryType", 64).toLowerCase();
  if (!BIBTEX_ENTRY_TYPE.test(normalized)) throw new TypeError("BibTeX entryType is invalid.");
  return normalized;
}

function reserveExplicitKey(value: string, usedKeys: Set<string>): string {
  const key = requireCitationKey(value);
  if (usedKeys.has(key)) throw new TypeError(`Citation key ${key} is duplicated.`);
  usedKeys.add(key);
  return key;
}

function reserveGeneratedKey(base: string, usedKeys: Set<string>): string {
  if (!usedKeys.has(base)) {
    usedKeys.add(base);
    return base;
  }
  for (let index = 0; index < 26 * 26; index += 1) {
    const suffix = index < 26
      ? String.fromCharCode(97 + index)
      : `${String.fromCharCode(97 + Math.floor(index / 26) - 1)}${String.fromCharCode(97 + (index % 26))}`;
    const candidate = `${base}${suffix}`;
    if (!usedKeys.has(candidate)) {
      usedKeys.add(candidate);
      return candidate;
    }
  }
  throw new TypeError(`Too many citation-key collisions for ${base}.`);
}

function generatedCitationKey(item: ZoteroLibraryItem): string {
  const author = item.creators[0] ? slug(lastName(item.creators[0])) : "anon";
  const year = item.year === undefined ? "nd" : String(item.year);
  const titleToken = item.title.split(/\s+/u).map(slug).find((token) => token.length >= 3) ?? "work";
  return requireCitationKey(`${author || "anon"}${year}${titleToken || "work"}`);
}

function lastName(value: string): string {
  const comma = value.split(",", 1)[0]?.trim();
  if (value.includes(",") && comma) return comma;
  return value.trim().split(/\s+/u).at(-1) ?? value;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9]+/gu, "").toLowerCase();
}

function splitAuthors(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(/\s+and\s+/iu).map((author) => author.trim()).filter(Boolean);
}

function escapeBibtexText(value: string): string {
  return value
    .replace(/\\/gu, "\\textbackslash{}")
    .replace(/([%&#_$])/gu, "\\$1")
    .replace(/\{/gu, "\\{")
    .replace(/\}/gu, "\\}")
    .replace(/\r?\n/gu, " ");
}

function zoteroEntryType(itemType: string): string {
  const normalized = itemType.toLowerCase();
  if (normalized.includes("booksection") || normalized.includes("book section")) return "incollection";
  if (normalized.includes("conference")) return "inproceedings";
  if (normalized.includes("book")) return "book";
  if (normalized.includes("thesis")) return "phdthesis";
  if (normalized.includes("report")) return "techreport";
  if (normalized.includes("web")) return "misc";
  return "article";
}

function normalizeDoi(value: string): string {
  return value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "").toLowerCase();
}

function missingDiagnostic(
  code: "missing_author" | "missing_year",
  citationKey: string,
  message: string,
): CitationSetDiagnostic {
  return Object.freeze({ code, citationKey, message });
}

