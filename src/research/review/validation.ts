import {
  RESEARCH_ARTIFACT_KINDS,
  type ResearchArtifactKind,
  type ResearchArtifactRef,
} from "../artifacts/index.js";
import type {
  ManuscriptLocation,
  ReviewTarget,
  ReviewableManuscriptArtifact,
} from "./contracts.js";

const ARTIFACT_KINDS = new Set<string>(RESEARCH_ARTIFACT_KINDS);

export function assertReviewableManuscript(value: ReviewableManuscriptArtifact): ReviewableManuscriptArtifact {
  if (!value || value.kind !== "manuscript_version" || value.status !== "active"
    || value.payload?.kind !== "manuscript_version" || value.payload.schemaVersion !== 1) {
    throw new TypeError("Review requires an active manuscript_version artifact.");
  }
  text(value.payload.title, "manuscript title", 2_000);
  if (value.payload.source?.format !== "latex" || value.payload.source.mainFile !== "main.tex"
    || value.payload.source.singleSourceOfTruth !== true) {
    throw new TypeError("Review requires the manuscript module's canonical LaTeX source contract.");
  }
  text(value.payload.source.content, "manuscript LaTeX source", 4_000_000, true);
  if (!value.payload.source.content.trim()) throw new TypeError("manuscript LaTeX source must not be empty.");
  sha256(value.payload.source.contentHash, "manuscript source contentHash");
  normalizeTarget(value.payload.target);
  if (!Array.isArray(value.payload.sections) || value.payload.sections.length === 0) {
    throw new TypeError("manuscript sections must not be empty.");
  }
  const sectionIds = new Set<string>();
  for (const [index, section] of value.payload.sections.entries()) {
    const id = identifier(section.sectionId, `manuscript sections[${index}].sectionId`);
    if (sectionIds.has(id)) throw new TypeError(`Manuscript section ${id} is duplicated.`);
    sectionIds.add(id);
    text(section.title, `manuscript sections[${index}].title`, 2_000);
    if (!Array.isArray(section.statements)) throw new TypeError(`Manuscript section ${id} statements must be an array.`);
    const statementIds = new Set<string>();
    for (const [statementIndex, statement] of section.statements.entries()) {
      const statementId = identifier(statement.statementId, `manuscript sections[${index}].statements[${statementIndex}].statementId`);
      if (statementIds.has(statementId)) throw new TypeError(`Manuscript statement ${statementId} is duplicated in section ${id}.`);
      statementIds.add(statementId);
      if (!Array.isArray(statement.citationKeys) || !Array.isArray(statement.evidenceRefs)
        || !Array.isArray(statement.figureTableRefs)) {
        throw new TypeError(`Manuscript statement ${statementId} references must be arrays.`);
      }
      statement.citationKeys.forEach((key: string, keyIndex: number) => {
        citationKey(key, `statement ${statementId} citationKeys[${keyIndex}]`);
      });
      uniqueRefs(statement.evidenceRefs, `statement ${statementId} evidenceRefs`);
      uniqueRefs(statement.figureTableRefs, `statement ${statementId} figureTableRefs`);
    }
  }
  if (!Array.isArray(value.payload.figureTableRefs)) throw new TypeError("manuscript figureTableRefs must be an array.");
  uniqueRefs(value.payload.figureTableRefs, "manuscript figureTableRefs");
  if (value.payload.citationSetRef !== undefined) normalizeRef(value.payload.citationSetRef, "manuscript citationSetRef");
  return value;
}

export function normalizeTarget(value: ReviewTarget): ReviewTarget {
  if (!value || typeof value !== "object") throw new TypeError("review target must be an object.");
  if (!["iclr", "generic"].includes(value.venue)) throw new TypeError("review target venue is invalid.");
  if (!["anonymous_submission", "camera_ready", "internal_draft"].includes(value.mode)) {
    throw new TypeError("review target mode is invalid.");
  }
  const conferenceYear = value.conferenceYear === undefined
    ? undefined
    : positiveInteger(value.conferenceYear, "review target conferenceYear");
  if (conferenceYear !== undefined && (conferenceYear < 1900 || conferenceYear > 9999)) {
    throw new TypeError("review target conferenceYear is outside the supported range.");
  }
  if (value.venue === "iclr" && conferenceYear === undefined) {
    throw new TypeError("ICLR review targets require a conferenceYear.");
  }
  const maxMainPages = value.maxMainPages === undefined
    ? undefined
    : positiveInteger(value.maxMainPages, "review target maxMainPages");
  return Object.freeze({
    venue: value.venue,
    ...(conferenceYear === undefined ? {} : { conferenceYear }),
    mode: value.mode,
    ...(maxMainPages === undefined ? {} : { maxMainPages }),
  });
}

export function normalizeLocation(value: ManuscriptLocation, label = "location"): ManuscriptLocation {
  if (!value || typeof value !== "object") throw new TypeError(`${label} must be an object.`);
  const lineStart = value.lineStart === undefined ? undefined : positiveInteger(value.lineStart, `${label}.lineStart`);
  const lineEnd = value.lineEnd === undefined ? undefined : positiveInteger(value.lineEnd, `${label}.lineEnd`);
  if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
    throw new TypeError(`${label}.lineEnd must not precede lineStart.`);
  }
  return Object.freeze({
    sectionId: identifier(value.sectionId, `${label}.sectionId`),
    ...(value.statementId === undefined ? {} : { statementId: identifier(value.statementId, `${label}.statementId`) }),
    ...(value.paragraphId === undefined ? {} : { paragraphId: identifier(value.paragraphId, `${label}.paragraphId`) }),
    ...(value.page === undefined ? {} : { page: positiveInteger(value.page, `${label}.page`) }),
    ...(lineStart === undefined ? {} : { lineStart }),
    ...(lineEnd === undefined ? {} : { lineEnd }),
    anchorText: text(value.anchorText, `${label}.anchorText`, 1_000),
  });
}

export function locationKey(value: ManuscriptLocation): string {
  const location = normalizeLocation(value);
  return [
    location.sectionId,
    location.statementId ?? "",
    location.paragraphId ?? "",
    String(location.page ?? ""),
    String(location.lineStart ?? ""),
    String(location.lineEnd ?? ""),
    normalizeWords(location.anchorText),
  ].join("|");
}

export function normalizeRef(value: ResearchArtifactRef, label = "artifactRef"): ResearchArtifactRef {
  if (!value || typeof value !== "object") throw new TypeError(`${label} must be an artifact reference.`);
  const kind = String(value.kind);
  if (!ARTIFACT_KINDS.has(kind)) throw new TypeError(`${label}.kind is invalid.`);
  return Object.freeze({
    artifactId: identifier(value.artifactId, `${label}.artifactId`),
    revision: positiveInteger(value.revision, `${label}.revision`),
    kind: kind as ResearchArtifactKind,
    contentHash: sha256(value.contentHash, `${label}.contentHash`),
  });
}

export function uniqueRefs(values: readonly ResearchArtifactRef[], label: string): ResearchArtifactRef[] {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array.`);
  const refs = values.map((value, index) => normalizeRef(value, `${label}[${index}]`));
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = fullRefKey(ref);
    if (seen.has(key)) throw new TypeError(`${label} contains duplicate reference ${key}.`);
    seen.add(key);
  }
  return refs;
}

export function mergeRefs(groups: readonly (readonly ResearchArtifactRef[])[]): ResearchArtifactRef[] {
  const byKey = new Map<string, ResearchArtifactRef>();
  for (const group of groups) {
    for (const ref of group) {
      const normalized = normalizeRef(ref);
      byKey.set(fullRefKey(normalized), normalized);
    }
  }
  return [...byKey.values()].sort(compareRefs);
}

export function sameRef(left: ResearchArtifactRef, right: ResearchArtifactRef): boolean {
  return fullRefKey(left) === fullRefKey(right);
}

export function fullRefKey(ref: ResearchArtifactRef): string {
  return `${ref.kind}:${ref.artifactId}@${ref.revision}:${ref.contentHash}`;
}

export function compareRefs(left: ResearchArtifactRef, right: ResearchArtifactRef): number {
  return fullRefKey(left).localeCompare(fullRefKey(right), "en");
}

export function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new TypeError(`${label} must be a safe identifier.`);
  }
  return value;
}

export function citationKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u.test(value)) {
    throw new TypeError(`${label} must be a safe citation key.`);
  }
  return value;
}

export function text(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\u0000")
    || (!allowEmpty && (!value.trim() || value !== value.trim()))) {
    throw new TypeError(`${label} must be bounded${allowEmpty ? "" : " non-empty"} text.`);
  }
  return value;
}

export function textList(values: readonly string[], label: string, maximum: number, allowEmpty = false): string[] {
  if (!Array.isArray(values) || values.length > maximum) throw new TypeError(`${label} must be a bounded array.`);
  return values.map((value, index) => text(value, `${label}[${index}]`, 8_000, allowEmpty));
}

export function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 hash.`);
  }
  return value;
}

export function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value as number;
}

export function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return value as number;
}

export function strictBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
  return value;
}

export function isoDate(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`${label} must be a valid date.`);
  return value.toISOString();
}

export function normalizeWords(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}
