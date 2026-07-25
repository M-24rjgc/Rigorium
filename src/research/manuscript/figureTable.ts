import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createResearchArtifact,
  type ResearchArtifactParent,
  type ResearchArtifactProducer,
  type ResearchArtifactSource,
} from "../artifacts/index.js";
import type {
  FigureTableArtifact,
  FigureTableFileRef,
  FigureTableItem,
  FigureTableItemInput,
} from "./types.js";
import {
  MANUSCRIPT_LIMITS,
  hashBytes,
  hashText,
  requireCitationKey,
  requireHash,
  requireIdentifier,
  requireLatex,
  requireSafeRelativePath,
  requireText,
  resolveWithin,
  uniqueSorted,
} from "./validation.js";

export type FigureTableFileVerification = Readonly<{
  status: "verified" | "failed";
  files: readonly Readonly<{
    path: string;
    expectedHash: string;
    actualHash?: string;
    status: "verified" | "missing" | "hash_mismatch" | "unsafe";
  }>[];
}>;

export function createFigureTableArtifact(input: {
  items: readonly FigureTableItemInput[];
  producer: ResearchArtifactProducer;
  artifactId?: string;
  now?: Date;
}): FigureTableArtifact {
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > MANUSCRIPT_LIMITS.maxFigureTableItems) {
    throw new TypeError(`FigureTableArtifact needs between 1 and ${MANUSCRIPT_LIMITS.maxFigureTableItems} items.`);
  }
  const items = input.items.map(normalizeItem);
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.itemId)) throw new TypeError(`Figure/table item ${item.itemId} is duplicated.`);
    ids.add(item.itemId);
  }
  const parentByKey = new Map<string, ResearchArtifactParent>();
  for (const item of items) {
    for (const ref of item.captionEvidenceRefs) {
      parentByKey.set(`supports:${ref.artifactId}@${ref.revision}`, { relation: "supports", artifact: ref });
    }
  }
  const sources: ResearchArtifactSource[] = [];
  for (const item of items) {
    for (const data of item.data) sources.push(fileSource("figure-table-data", data));
    if (item.script.status === "available") sources.push(fileSource("figure-table-script", item.script.file));
    sources.push(fileSource("figure-table-output", item.output));
    sources.push({ sourceId: "figure-table-caption", recordId: item.itemId, contentHash: item.captionContentHash });
  }
  return createResearchArtifact({
    kind: "figure_table",
    payload: Object.freeze({ schemaVersion: 1 as const, kind: "figure_table" as const, items: Object.freeze(items) }),
    producer: input.producer,
    parents: [...parentByKey.values()],
    sources,
    ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

export async function verifyFigureTableArtifactFiles(input: {
  projectRoot: string;
  artifact: FigureTableArtifact;
  maxFileBytes?: number;
}): Promise<FigureTableFileVerification> {
  const maxFileBytes = input.maxFileBytes ?? 512 * 1024 * 1024;
  const files = input.artifact.payload.items.flatMap((item) => [
    ...item.data,
    ...(item.script.status === "available" ? [item.script.file] : []),
    item.output,
  ]);
  const unique = new Map(files.map((file) => [file.path, file]));
  const results: Array<FigureTableFileVerification["files"][number]> = [];
  for (const file of [...unique.values()].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    const absolute = resolveWithin(input.projectRoot, resolve(input.projectRoot, file.path), `figure/table file ${file.path}`);
    try {
      const stats = await lstat(absolute);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxFileBytes) {
        results.push(Object.freeze({ path: file.path, expectedHash: file.contentHash, status: "unsafe" as const }));
        continue;
      }
      const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      await handle.close();
      const actualHash = hashBytes(await readFile(absolute));
      results.push(Object.freeze({
        path: file.path,
        expectedHash: file.contentHash,
        actualHash,
        status: actualHash === file.contentHash ? "verified" as const : "hash_mismatch" as const,
      }));
    } catch (error) {
      const status = isNodeError(error, "ENOENT") ? "missing" as const : "unsafe" as const;
      results.push(Object.freeze({ path: file.path, expectedHash: file.contentHash, status }));
    }
  }
  return Object.freeze({
    status: results.every((file) => file.status === "verified") ? "verified" : "failed",
    files: Object.freeze(results),
  });
}

function normalizeItem(input: FigureTableItemInput): FigureTableItem {
  if (!input || typeof input !== "object") throw new TypeError("Figure/table items must be objects.");
  if (input.kind !== "figure" && input.kind !== "table") throw new TypeError("Figure/table item kind is invalid.");
  if (!Array.isArray(input.data) || input.data.length === 0) throw new TypeError("Figure/table items need at least one data file.");
  const data = input.data.map((file, index) => normalizeFile(file, `data[${index}]`));
  const output = normalizeFile(input.output, "output");
  const script = input.script.status === "available"
    ? Object.freeze({
        status: "available" as const,
        file: normalizeFile(input.script.file, "script.file"),
        command: Object.freeze(input.script.command.map((part, index) => requireText(part, `script.command[${index}]`, 4_096))),
      })
    : Object.freeze({
        status: "not_applicable" as const,
        reason: requireText(input.script.reason, "script.reason", 2_000),
      });
  if (script.status === "available" && script.command.length === 0) throw new TypeError("Figure/table script command must not be empty.");
  const captionLatex = requireLatex(input.captionLatex, "captionLatex");
  return Object.freeze({
    itemId: requireIdentifier(input.itemId, "figure/table itemId"),
    kind: input.kind,
    label: requireIdentifier(input.label, "figure/table label"),
    data: Object.freeze(data),
    script,
    output,
    captionLatex,
    captionContentHash: hashText(captionLatex),
    captionEvidenceRefs: Object.freeze(input.captionEvidenceRefs.map((ref) => Object.freeze({ ...ref }))),
    citationKeys: Object.freeze(uniqueSorted(input.citationKeys.map((key) => requireCitationKey(key)))),
    reuseStatus: script.status === "available" ? "recomputable" : "output_only",
  });
}

function normalizeFile(file: FigureTableFileRef, label: string): FigureTableFileRef {
  if (!file || typeof file !== "object") throw new TypeError(`${label} must be a file reference.`);
  return Object.freeze({
    path: requireSafeRelativePath(file.path, `${label}.path`),
    contentHash: requireHash(file.contentHash, `${label}.contentHash`),
    mediaType: requireText(file.mediaType, `${label}.mediaType`, 256),
  });
}

function fileSource(sourceId: string, file: FigureTableFileRef): ResearchArtifactSource {
  return { sourceId, locator: file.path, contentHash: file.contentHash };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

