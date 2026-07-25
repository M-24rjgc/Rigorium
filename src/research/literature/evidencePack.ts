import { createHash, randomUUID } from "node:crypto";
import {
  createResearchArtifact,
  hashResearchArtifactContent,
  type ResearchArtifactEnvelope,
  type ResearchArtifactProducer,
} from "../artifacts/index.js";
import type { LibraryProvider } from "../types.js";

/** A bounded locator that can be rendered without reopening the source. */
export type EvidenceLocator = Readonly<{
  sourceId: string;
  recordId?: string;
  url?: string;
  page?: number;
  paragraph?: number;
  section?: string;
  characterStart?: number;
  characterEnd?: number;
}>;

export type EvidenceSnapshot = Readonly<{
  content: string;
  contentHash?: string;
  capturedAt?: string;
  mediaType?: string;
  truncated?: boolean;
  indexedPages?: number;
  totalPages?: number;
}>;

export type EvidencePackEntryInput = Readonly<{
  id: string;
  paperId: string;
  locator: EvidenceLocator;
  snapshot: EvidenceSnapshot;
  quote?: string;
  note?: string;
}>;

export type EvidencePackEntry = Readonly<{
  id: string;
  paperId: string;
  locator: EvidenceLocator;
  snapshot: Readonly<{
    content: string;
    contentHash: string;
    capturedAt: string;
    mediaType?: string;
    truncated?: boolean;
    indexedPages?: number;
    totalPages?: number;
  }>;
  quote?: string;
  note?: string;
}>;

export type EvidencePackPayload = Readonly<{
  schemaVersion: 1;
  kind: "evidence_pack";
  entries: readonly EvidencePackEntry[];
  paperIds: readonly string[];
  sourceIds: readonly string[];
}>;

export type EvidencePackArtifact = ResearchArtifactEnvelope<"evidence_pack", EvidencePackPayload>;

export const EVIDENCE_PACK_LIMITS = {
  maxEntries: 256,
  maxContentLength: 2_000_000,
  maxQuoteLength: 16_000,
  maxNoteLength: 4_000,
  maxIdentifierLength: 256,
  maxSectionLength: 512,
  maxUrlLength: 4_096,
} as const;

/** SHA-256 of the exact UTF-8 snapshot content, with an explicit algorithm prefix. */
export function hashEvidenceSnapshot(content: string): string {
  if (typeof content !== "string") throw new TypeError("Evidence snapshot content must be text.");
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/** Validate that a supplied hash still describes the exact source snapshot. */
export function verifyEvidenceSnapshot(snapshot: Pick<EvidenceSnapshot, "content" | "contentHash">): boolean {
  return snapshot.contentHash === undefined || snapshot.contentHash === hashEvidenceSnapshot(snapshot.content);
}

/**
 * Normalize page/paragraph evidence and materialize its immutable snapshot hash.
 * The function is side-effect free; callers decide where the artifact is stored.
 */
export function buildEvidencePack(input: {
  entries: readonly EvidencePackEntryInput[];
  now?: Date;
}): EvidencePackPayload {
  if (!input || !Array.isArray(input.entries)) throw new TypeError("Evidence pack entries must be an array.");
  if (input.entries.length > EVIDENCE_PACK_LIMITS.maxEntries) {
    throw new TypeError(`Evidence pack entries exceed ${EVIDENCE_PACK_LIMITS.maxEntries}.`);
  }
  const capturedAt = (input.now ?? new Date()).toISOString();
  const ids = new Set<string>();
  const entries = input.entries.map((entry, index) => normalizeEntry(entry, index, capturedAt, ids));
  return Object.freeze({
    schemaVersion: 1,
    kind: "evidence_pack" as const,
    entries: Object.freeze(entries),
    paperIds: Object.freeze(uniqueSorted(entries.map((entry) => entry.paperId))),
    sourceIds: Object.freeze(uniqueSorted(entries.map((entry) => entry.locator.sourceId))),
  });
}

/** Create a graph-compatible `evidence_pack` envelope with source hashes attached. */
export function createEvidencePackArtifact(input: {
  entries: readonly EvidencePackEntryInput[];
  producer: ResearchArtifactProducer;
  artifactId?: string;
  revision?: number;
  parents?: Parameters<typeof createResearchArtifact>[0]["parents"];
  now?: Date;
}): EvidencePackArtifact {
  const payload = buildEvidencePack(input);
  return createResearchArtifact({
    kind: "evidence_pack",
    payload,
    producer: input.producer,
    ...(input.artifactId === undefined ? { artifactId: `evidence-pack-${randomUUID()}` } : { artifactId: input.artifactId }),
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    ...(input.parents === undefined ? {} : { parents: input.parents }),
    sources: payload.entries.map((entry) => ({
      sourceId: entry.locator.sourceId,
      ...(entry.locator.recordId === undefined ? {} : { recordId: entry.locator.recordId }),
      ...(entry.locator.url === undefined ? {} : { locator: entry.locator.url }),
      retrievedAt: entry.snapshot.capturedAt,
      contentHash: entry.snapshot.contentHash,
    })),
    now: input.now,
  }) as EvidencePackArtifact;
}

/**
 * Capture indexed attachment text through the existing official Zotero Local
 * API provider. Location remains caller-supplied because Zotero full-text
 * responses do not manufacture PDF paragraph coordinates.
 */
export async function captureZoteroAttachmentEvidence(input: {
  provider: Pick<LibraryProvider, "getAttachmentFullText">;
  attachmentKey: string;
  paperId: string;
  entryId: string;
  locator: Omit<EvidenceLocator, "sourceId" | "recordId">;
  quote?: string;
  note?: string;
  producer: ResearchArtifactProducer;
  artifactId?: string;
  revision?: number;
  now?: Date;
}): Promise<EvidencePackArtifact> {
  const attachmentKey = identifier(input.attachmentKey, "attachmentKey");
  const fullText = await input.provider.getAttachmentFullText(attachmentKey);
  return createEvidencePackArtifact({
    entries: [{
      id: input.entryId,
      paperId: input.paperId,
      locator: {
        ...input.locator,
        sourceId: "zotero",
        recordId: attachmentKey,
      },
      snapshot: {
        content: fullText.content,
        capturedAt: (input.now ?? new Date()).toISOString(),
        mediaType: "text/plain",
        truncated: fullText.truncated,
        ...(fullText.indexedPages === undefined ? {} : { indexedPages: fullText.indexedPages }),
        ...(fullText.totalPages === undefined ? {} : { totalPages: fullText.totalPages }),
      },
      ...(input.quote === undefined ? {} : { quote: input.quote }),
      ...(input.note === undefined ? {} : { note: input.note }),
    }],
    producer: input.producer,
    ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    now: input.now,
  });
}

/** Detect accidental mutation or stale hashes before an evidence pack is used. */
export function validateEvidencePack(payload: EvidencePackPayload): void {
  const rebuilt = buildEvidencePack({
    entries: payload.entries.map((entry) => ({
      id: entry.id,
      paperId: entry.paperId,
      locator: entry.locator,
      snapshot: entry.snapshot,
      ...(entry.quote === undefined ? {} : { quote: entry.quote }),
      ...(entry.note === undefined ? {} : { note: entry.note }),
    })),
    now: new Date(payload.entries[0]?.snapshot.capturedAt ?? 0),
  });
  if (hashResearchArtifactContent(rebuilt) !== hashResearchArtifactContent(payload)) {
    throw new TypeError("Evidence pack contains invalid, stale, or non-deterministic entries.");
  }
}

function normalizeEntry(
  value: EvidencePackEntryInput,
  index: number,
  capturedAt: string,
  ids: Set<string>,
): EvidencePackEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`entries[${index}] must be an object.`);
  }
  const id = identifier(value.id, `entries[${index}].id`);
  if (ids.has(id)) throw new TypeError(`Evidence entry ${id} is duplicated.`);
  ids.add(id);
  const paperId = identifier(value.paperId, `entries[${index}].paperId`);
  const locator = normalizeLocator(value.locator, `entries[${index}].locator`);
  const snapshot = value.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError(`entries[${index}].snapshot must be an object.`);
  }
  const content = boundedText(snapshot.content, `entries[${index}].snapshot.content`, EVIDENCE_PACK_LIMITS.maxContentLength);
  const contentHash = hashEvidenceSnapshot(content);
  if (snapshot.contentHash !== undefined && snapshot.contentHash !== contentHash) {
    throw new TypeError(`entries[${index}].snapshot.contentHash does not match its content.`);
  }
  const snapshotTime = snapshot.capturedAt === undefined
    ? capturedAt
    : isoTimestamp(snapshot.capturedAt, `entries[${index}].snapshot.capturedAt`);
  const mediaType = snapshot.mediaType === undefined
    ? undefined
    : boundedText(snapshot.mediaType, `entries[${index}].snapshot.mediaType`, 128);
  const truncated = snapshot.truncated;
  if (truncated !== undefined && typeof truncated !== "boolean") {
    throw new TypeError(`entries[${index}].snapshot.truncated must be a boolean.`);
  }
  const indexedPages = nonNegativeIntegerOrUndefined(snapshot.indexedPages, `entries[${index}].snapshot.indexedPages`);
  const totalPages = nonNegativeIntegerOrUndefined(snapshot.totalPages, `entries[${index}].snapshot.totalPages`);
  const quote = value.quote === undefined ? undefined : boundedText(value.quote, `entries[${index}].quote`, EVIDENCE_PACK_LIMITS.maxQuoteLength);
  if (quote !== undefined && !content.includes(quote)) {
    throw new TypeError(`entries[${index}].quote must occur in the captured snapshot.`);
  }
  const note = value.note === undefined ? undefined : boundedText(value.note, `entries[${index}].note`, EVIDENCE_PACK_LIMITS.maxNoteLength);
  return {
    id,
    paperId,
    locator,
    snapshot: {
      content,
      contentHash,
      capturedAt: snapshotTime,
      ...(mediaType === undefined ? {} : { mediaType }),
      ...(truncated === undefined ? {} : { truncated }),
      ...(indexedPages === undefined ? {} : { indexedPages }),
      ...(totalPages === undefined ? {} : { totalPages }),
    },
    ...(quote === undefined ? {} : { quote }),
    ...(note === undefined ? {} : { note }),
  };
}

function normalizeLocator(value: EvidenceLocator, label: string): EvidenceLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const sourceId = identifier(value.sourceId, `${label}.sourceId`);
  const recordId = value.recordId === undefined ? undefined : identifier(value.recordId, `${label}.recordId`);
  const url = value.url === undefined ? undefined : boundedText(value.url, `${label}.url`, EVIDENCE_PACK_LIMITS.maxUrlLength);
  const page = positiveIntegerOrUndefined(value.page, `${label}.page`);
  const paragraph = positiveIntegerOrUndefined(value.paragraph, `${label}.paragraph`);
  const section = value.section === undefined ? undefined : boundedText(value.section, `${label}.section`, EVIDENCE_PACK_LIMITS.maxSectionLength);
  const characterStart = nonNegativeIntegerOrUndefined(value.characterStart, `${label}.characterStart`);
  const characterEnd = nonNegativeIntegerOrUndefined(value.characterEnd, `${label}.characterEnd`);
  if (characterStart !== undefined && characterEnd !== undefined && characterEnd < characterStart) {
    throw new TypeError(`${label}.characterEnd must be greater than or equal to characterStart.`);
  }
  if (page === undefined && paragraph === undefined && section === undefined && characterStart === undefined) {
    throw new TypeError(`${label} must include a page, paragraph, section, or characterStart locator.`);
  }
  return {
    sourceId,
    ...(recordId === undefined ? {} : { recordId }),
    ...(url === undefined ? {} : { url }),
    ...(page === undefined ? {} : { page }),
    ...(paragraph === undefined ? {} : { paragraph }),
    ...(section === undefined ? {} : { section }),
    ...(characterStart === undefined ? {} : { characterStart }),
    ...(characterEnd === undefined ? {} : { characterEnd }),
  };
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > EVIDENCE_PACK_LIMITS.maxIdentifierLength || value.includes("\u0000")) {
    throw new TypeError(`${label} must be a trimmed non-empty identifier.`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) {
    throw new TypeError(`${label} must be bounded printable text.`);
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const text = boundedText(value, label, 128);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${label} must be an ISO timestamp.`);
  return text;
}

function positiveIntegerOrUndefined(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${label} must be a positive integer.`);
  return value as number;
}

function nonNegativeIntegerOrUndefined(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return value as number;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}
