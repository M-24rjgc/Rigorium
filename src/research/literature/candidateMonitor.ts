import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  LibraryProvider,
  LiteratureSearchResult,
  LiteratureSource,
  ResearchPaper,
  SearchPlan,
} from "../types.js";
import { getProjectLiteratureMapPaths } from "./mapRepository.js";
import { zoteroItemToResearchPaper } from "./maintenance.js";
import { mergeLiteratureSearchResults } from "./candidatePool.js";

export const LITERATURE_CANDIDATE_MONITOR_SCHEMA_VERSION = 1 as const;
export const MAX_LITERATURE_CANDIDATE_MONITOR_RECORDS = 2_000;
const MAX_MONITOR_FILE_BYTES = 8 * 1024 * 1024;

export type CandidateMonitorSourceResult = Readonly<{
  papers: ResearchPaper[];
  source: Readonly<{
    id: string;
    name: string;
    status: "ok" | "error" | "disabled";
    retrievedAt: string;
    coverage: string;
    queryUrl?: string;
    error?: string;
  }>;
}>;

export type LiteratureCandidateMonitorSource = Readonly<{
  id: string;
  name: string;
  poll(input: { signal?: AbortSignal; now: () => Date }): Promise<CandidateMonitorSourceResult>;
}>;

export type LiteratureCandidateMonitorRecord = Readonly<{
  key: string;
  paper: ResearchPaper;
  firstSeenAt: string;
  lastSeenAt: string;
  sourceIds: string[];
  snapshotHash: string;
}>;

export type LiteratureCandidateMonitorState = Readonly<{
  schemaVersion: 1;
  kind: "literature_candidate_monitor";
  revision: number;
  updatedAt: string;
  records: readonly LiteratureCandidateMonitorRecord[];
}>;

export type LiteratureCandidateMonitorSourceAudit = Readonly<{
  sourceId: string;
  sourceName: string;
  status: "ok" | "error" | "disabled";
  retrievedAt: string;
  candidateCount: number;
  coverage: string;
  queryUrl?: string;
  error?: string;
}>;

export type LiteratureCandidateMonitorResult = Readonly<{
  schemaVersion: 1;
  kind: "literature_candidate_monitor_result";
  checkedAt: string;
  candidateOnly: true;
  state: LiteratureCandidateMonitorState;
  newCandidates: readonly ResearchPaper[];
  updatedCandidates: readonly ResearchPaper[];
  candidates: readonly ResearchPaper[];
  sources: readonly LiteratureCandidateMonitorSourceAudit[];
  changed: boolean;
}>;

export type LiteratureCandidateMonitorPaths = Readonly<{
  statePath: string;
}>;

/** Create a read-only Zotero top-level item monitor using the official provider. */
export function createZoteroCandidateMonitorSource(input: {
  provider: LibraryProvider;
  collectionKey?: string;
  maxItems?: number;
  pageSize?: number;
  now?: () => Date;
}): LiteratureCandidateMonitorSource {
  const maxItems = boundedInteger(input.maxItems ?? 500, 1, 2_000, "maxItems");
  const pageSize = boundedInteger(input.pageSize ?? 100, 1, 100, "pageSize");
  const defaultNow = input.now ?? (() => new Date());
  return {
    id: "zotero",
    name: "Zotero",
    poll: async ({ now = defaultNow }) => {
      const papers: ResearchPaper[] = [];
      let start = 0;
      let nextStart: number | undefined = 0;
      try {
        while (papers.length < maxItems && nextStart !== undefined) {
          const page = await input.provider.listItems({
            ...(input.collectionKey ? { collectionKey: input.collectionKey } : {}),
            limit: Math.min(pageSize, maxItems - papers.length),
            start,
          });
          const retrievedAt = now().toISOString();
          papers.push(...page.items.map((item) => zoteroItemToResearchPaper(item, retrievedAt)));
          nextStart = page.nextStart;
          if (page.items.length === 0) break;
          start = page.nextStart ?? start + page.items.length;
        }
        const truncated = papers.length >= maxItems;
        return {
          papers,
          source: {
            id: "zotero",
            name: "Zotero",
            status: "ok" as const,
            retrievedAt: now().toISOString(),
            coverage: `Read ${papers.length} Zotero top-level items${truncated ? ` (capped at ${maxItems}).` : "."}`,
          },
        };
      } catch (error) {
        return {
          papers: [],
          source: {
            id: "zotero",
            name: "Zotero",
            status: "error" as const,
            retrievedAt: now().toISOString(),
            coverage: "Zotero monitor could not read the official Local API.",
            error: errorMessage(error),
          },
        };
      }
    },
  };
}

/** Create a read-only preprint monitor backed by an existing academic source adapter. */
export function createPreprintCandidateMonitorSource(input: {
  source: LiteratureSource;
  query: string;
  limit?: number;
  fromYear?: number;
  toYear?: number;
  now?: () => Date;
}): LiteratureCandidateMonitorSource {
  const query = boundedText(input.query, "query", 1_000);
  const limit = boundedInteger(input.limit ?? 25, 1, 100, "limit");
  const defaultNow = input.now ?? (() => new Date());
  return {
    id: input.source.id,
    name: input.source.name,
    poll: async ({ signal, now = defaultNow }) => {
      const plan: SearchPlan = {
        query,
        mode: "broad",
        limit,
        sort: "publication_date",
        sourceIds: [input.source.id],
        ...(input.fromYear === undefined ? {} : { fromYear: input.fromYear }),
        ...(input.toYear === undefined ? {} : { toYear: input.toYear }),
      };
      try {
        const result = await input.source.search(plan, { signal, now });
        return {
          papers: result.papers,
          source: {
            id: result.source.id,
            name: result.source.name,
            status: result.source.status,
            retrievedAt: result.source.retrievedAt,
            coverage: result.source.coverage,
            ...(result.source.queryUrl ? { queryUrl: result.source.queryUrl } : {}),
            ...(result.source.error ? { error: result.source.error } : {}),
          },
        };
      } catch (error) {
        return {
          papers: [],
          source: {
            id: input.source.id,
            name: input.source.name,
            status: "error" as const,
            retrievedAt: now().toISOString(),
            coverage: `${input.source.name} preprint monitor failed.`,
            error: errorMessage(error),
          },
        };
      }
    },
  };
}

export function emptyLiteratureCandidateMonitorState(now = new Date()): LiteratureCandidateMonitorState {
  return { schemaVersion: 1, kind: "literature_candidate_monitor", revision: 0, updatedAt: now.toISOString(), records: [] };
}

/**
 * Poll Zotero/preprint sources and update only the monitor's candidate ledger.
 * This function never calls a map repository or any Zotero write method.
 */
export async function pollLiteratureCandidateMonitor(input: {
  sources: readonly LiteratureCandidateMonitorSource[];
  state?: LiteratureCandidateMonitorState;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<LiteratureCandidateMonitorResult> {
  const sources = normalizeSources(input.sources);
  const now = input.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const previous = validateMonitorState(input.state ?? emptyLiteratureCandidateMonitorState(now()));
  const results: CandidateMonitorSourceResult[] = [];
  const audits: LiteratureCandidateMonitorSourceAudit[] = [];
  for (const source of sources) {
    if (input.signal?.aborted) break;
    try {
      const result = await source.poll({ ...(input.signal ? { signal: input.signal } : {}), now });
      results.push(result);
      audits.push({
        sourceId: result.source.id,
        sourceName: result.source.name,
        status: result.source.status,
        retrievedAt: result.source.retrievedAt,
        candidateCount: result.papers.length,
        coverage: result.source.coverage,
        ...(result.source.queryUrl ? { queryUrl: result.source.queryUrl } : {}),
        ...(result.source.error ? { error: result.source.error } : {}),
      });
    } catch (error) {
      audits.push({
        sourceId: source.id,
        sourceName: source.name,
        status: "error",
        retrievedAt: checkedAt,
        candidateCount: 0,
        coverage: "Candidate monitor source failed before returning records.",
        error: errorMessage(error),
      });
    }
  }
  const merged = mergeLiteratureSearchResults({
    requestedSourceIds: sources.map((source) => source.id),
    results: results.map(toSearchResult),
    limit: MAX_LITERATURE_CANDIDATE_MONITOR_RECORDS,
  });
  const previousByKey = new Map(previous.records.map((record) => [record.key, record]));
  const nextRecords = new Map(previousByKey);
  const newCandidates: ResearchPaper[] = [];
  const updatedCandidates: ResearchPaper[] = [];
  for (const paper of merged.papers) {
    const key = paperKey(paper);
    const snapshotHash = paperHash(paper);
    const existing = previousByKey.get(key);
    const sourceIds = uniqueSorted([...(existing?.sourceIds ?? []), ...paper.sourceIds, paper.sourceId]);
    if (!existing) {
      nextRecords.set(key, { key, paper, firstSeenAt: checkedAt, lastSeenAt: checkedAt, sourceIds, snapshotHash });
      newCandidates.push(paper);
      continue;
    }
    const changed = existing.snapshotHash !== snapshotHash || !sameStringArray(existing.sourceIds, sourceIds);
    if (changed) updatedCandidates.push(paper);
    nextRecords.set(key, {
      key,
      paper: changed ? paper : existing.paper,
      firstSeenAt: existing.firstSeenAt,
      lastSeenAt: checkedAt,
      sourceIds,
      snapshotHash: changed ? snapshotHash : existing.snapshotHash,
    });
  }
  const changed = newCandidates.length > 0 || updatedCandidates.length > 0;
  const records = [...nextRecords.values()].sort((left, right) => left.key.localeCompare(right.key, "en")).slice(-MAX_LITERATURE_CANDIDATE_MONITOR_RECORDS);
  const state: LiteratureCandidateMonitorState = changed
    ? {
        schemaVersion: 1,
        kind: "literature_candidate_monitor",
        revision: previous.revision + 1,
        updatedAt: checkedAt,
        records,
      }
    : previous;
  return {
    schemaVersion: 1,
    kind: "literature_candidate_monitor_result",
    checkedAt,
    candidateOnly: true,
    state,
    newCandidates: newCandidates.sort(comparePaper),
    updatedCandidates: updatedCandidates.sort(comparePaper),
    candidates: records.map((record) => record.paper),
    sources: audits.sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en")),
    changed,
  };
}

export function getProjectLiteratureCandidateMonitorPaths(input: { projectRoot: string }): LiteratureCandidateMonitorPaths {
  const paths = getProjectLiteratureMapPaths({ projectRoot: input.projectRoot });
  return { statePath: join(paths.researchDir, "candidate-monitor.json") };
}

export async function loadProjectLiteratureCandidateMonitorState(input: {
  projectRoot: string;
}): Promise<LiteratureCandidateMonitorState | undefined> {
  const { statePath } = getProjectLiteratureCandidateMonitorPaths(input);
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_MONITOR_FILE_BYTES) throw new Error("Candidate monitor state exceeds its size limit.");
  try {
    return validateMonitorState(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Candidate monitor state is invalid: ${errorMessage(error)}`);
  }
}

/** Persist monitor cursors/candidates atomically; this is not a formal map or library write. */
export async function persistProjectLiteratureCandidateMonitorState(input: {
  projectRoot: string;
  state: LiteratureCandidateMonitorState;
}): Promise<LiteratureCandidateMonitorPaths> {
  const paths = getProjectLiteratureCandidateMonitorPaths(input);
  const state = validateMonitorState(input.state);
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_MONITOR_FILE_BYTES) throw new Error("Candidate monitor state exceeds its size limit.");
  await mkdir(dirname(paths.statePath), { recursive: true });
  const temporary = `${paths.statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFileSafe(temporary, serialized);
    await rename(temporary, paths.statePath);
  } finally {
    await unlinkIfExists(temporary);
  }
  return paths;
}

export async function syncProjectLiteratureCandidateMonitor(input: {
  projectRoot: string;
  sources: readonly LiteratureCandidateMonitorSource[];
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<LiteratureCandidateMonitorResult & { persisted: boolean; path: string }> {
  const previous = await loadProjectLiteratureCandidateMonitorState({ projectRoot: input.projectRoot });
  const result = await pollLiteratureCandidateMonitor({ ...input, ...(previous ? { state: previous } : {}) });
  if (result.changed) {
    const paths = await persistProjectLiteratureCandidateMonitorState({ projectRoot: input.projectRoot, state: result.state });
    return { ...result, persisted: true, path: paths.statePath };
  }
  return { ...result, persisted: false, path: getProjectLiteratureCandidateMonitorPaths({ projectRoot: input.projectRoot }).statePath };
}

function toSearchResult(result: CandidateMonitorSourceResult): LiteratureSearchResult {
  return { papers: result.papers, edges: [], source: { ...result.source, resultCount: result.papers.length } };
}

function validateMonitorState(value: unknown): LiteratureCandidateMonitorState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Monitor state must be an object.");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "literature_candidate_monitor" || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0 || typeof record.updatedAt !== "string" || !Array.isArray(record.records)) {
    throw new TypeError("Unsupported literature candidate monitor state schema.");
  }
  if (record.records.length > MAX_LITERATURE_CANDIDATE_MONITOR_RECORDS) throw new TypeError("Monitor state contains too many records.");
  const records = record.records.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`records[${index}] must be an object.`);
    const candidate = entry as Record<string, unknown>;
    const key = boundedText(candidate.key, `records[${index}].key`, 4_096);
    const paper = candidate.paper as ResearchPaper;
    if (!paper || typeof paper !== "object" || typeof paper.id !== "string") throw new TypeError(`records[${index}].paper is invalid.`);
    const firstSeenAt = isoTimestamp(candidate.firstSeenAt, `records[${index}].firstSeenAt`);
    const lastSeenAt = isoTimestamp(candidate.lastSeenAt, `records[${index}].lastSeenAt`);
    const sourceIds = stringArray(candidate.sourceIds, `records[${index}].sourceIds`);
    const snapshotHash = boundedText(candidate.snapshotHash, `records[${index}].snapshotHash`, 128);
    if (snapshotHash !== paperHash(paper)) throw new TypeError(`records[${index}].snapshotHash does not match paper.`);
    return { key, paper, firstSeenAt, lastSeenAt, sourceIds, snapshotHash };
  });
  return { schemaVersion: 1, kind: "literature_candidate_monitor", revision: record.revision as number, updatedAt: isoTimestamp(record.updatedAt, "updatedAt"), records };
}

function normalizeSources(value: readonly LiteratureCandidateMonitorSource[]): LiteratureCandidateMonitorSource[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) throw new TypeError("Monitor sources must contain between 1 and 8 entries.");
  const seen = new Set<string>();
  return value.map((source, index) => {
    if (!source || typeof source !== "object" || typeof source.poll !== "function") throw new TypeError(`sources[${index}] must declare poll.`);
    const id = boundedText(source.id, `sources[${index}].id`, 256);
    if (seen.has(id)) throw new TypeError(`Monitor source ${id} is duplicated.`);
    seen.add(id);
    return source;
  });
}

function paperKey(paper: ResearchPaper): string {
  const identity = paper.identity;
  const strong = [identity.doi ?? paper.doi, identity.arxiv, identity.openAlexId, identity.openReview, identity.pmid, identity.pmcid, identity.zoteroKey]
    .find((value) => typeof value === "string" && value.trim());
  if (strong) return `id:${strong.toLocaleLowerCase("en-US")}`;
  const author = paper.authors[0]?.toLocaleLowerCase("en-US") ?? "";
  const title = paper.title.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return `title:${title}|${paper.year ?? ""}|${author}`;
}

function paperHash(paper: ResearchPaper): string {
  const stablePaper = {
    ...paper,
    authors: [...paper.authors],
    topics: [...paper.topics].sort((left, right) => left.id.localeCompare(right.id, "en")),
    referencedWorkIds: uniqueSorted(paper.referencedWorkIds),
    sourceIds: uniqueSorted(paper.sourceIds),
    provenance: paper.provenance
      .map(({ retrievedAt: _retrievedAt, queryUrl: _queryUrl, ...entry }) => entry)
      .sort((left, right) => [left.sourceId, left.sourceRecordId ?? "", left.queryVariantId ?? "", left.rank].join("\u0000")
        .localeCompare([right.sourceId, right.sourceRecordId ?? "", right.queryVariantId ?? "", right.rank].join("\u0000"), "en")),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(stablePaper), "utf8").digest("hex")}`;
}

function comparePaper(left: ResearchPaper, right: ResearchPaper): number {
  return left.id.localeCompare(right.id, "en");
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) throw new TypeError(`${label} must be a string array.`);
  return uniqueSorted(value);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} must be between ${minimum} and ${maximum}.`);
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) throw new TypeError(`${label} must be bounded printable text.`);
  return value.trim();
}

function isoTimestamp(value: unknown, label: string): string {
  const text = boundedText(value, label, 128);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${label} must be an ISO timestamp.`);
  return text;
}

async function writeFileSafe(path: string, content: string): Promise<void> {
  const { open } = await import("node:fs/promises");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
