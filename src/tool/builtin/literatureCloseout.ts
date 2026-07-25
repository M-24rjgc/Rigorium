import { stat } from "node:fs/promises";
import type { PermissionResult } from "../../permission/index.js";
import {
  createPreprintCandidateMonitorSource,
  createZoteroCandidateMonitorSource,
  syncProjectLiteratureCandidateMonitor,
  type LiteratureCandidateMonitorSource,
} from "../../research/literature/candidateMonitor.js";
import { createArxivSource } from "../../research/literature/arxivSource.js";
import { createCrossrefSource } from "../../research/literature/crossrefSource.js";
import {
  buildEvidencePack,
  captureZoteroAttachmentEvidence,
  createEvidencePackArtifact,
  type EvidenceLocator,
  type EvidencePackArtifact,
  type EvidencePackEntryInput,
} from "../../research/literature/evidencePack.js";
import {
  createCandidatePortfolioArtifact,
  rescanCandidateDirections,
  type CandidatePortfolioArtifact,
  type NoveltyRescanCandidate,
  type NoveltyRescanSource,
} from "../../research/literature/noveltyRescan.js";
import { createOpenAlexSource } from "../../research/literature/openAlexSource.js";
import { createZoteroLibraryProvider } from "../../research/library/zoteroProvider.js";
import { readResearchSettings } from "../../research/settings.js";
import type { ResearchSettings } from "../../research/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolValidationIssue, PilotDeckToolValidationResult } from "../protocol/schema.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";
import {
  createLiteratureSearchTool,
  type CreateLiteratureSearchToolOptions,
} from "./literatureSearch.js";

const TOOL_NAME = "literature_closeout";
const MAX_TOOL_EVIDENCE_ENTRIES = 64;
const MAX_TOOL_EVIDENCE_CHARS = 500_000;
const NOVELTY_SOURCE_IDS = ["openalex", "crossref", "arxiv"] as const;
const MONITOR_SOURCE_IDS = ["zotero", "arxiv"] as const;

type NoveltySourceId = typeof NOVELTY_SOURCE_IDS[number];
type MonitorSourceId = typeof MONITOR_SOURCE_IDS[number];
type ZoteroEvidenceLocator = Omit<EvidenceLocator, "sourceId" | "recordId">;
type MonitorResult = Awaited<ReturnType<typeof syncProjectLiteratureCandidateMonitor>>;

export type LiteratureCloseoutEvidenceInput = Readonly<{
  action: "evidence_pack";
  artifactId?: string;
  entries?: readonly EvidencePackEntryInput[];
  zoteroAttachment?: Readonly<{
    attachmentKey: string;
    paperId: string;
    entryId: string;
    locator: ZoteroEvidenceLocator;
    quote?: string;
    note?: string;
  }>;
}>;

export type LiteratureCloseoutNoveltyInput = Readonly<{
  action: "novelty_rescan";
  artifactId?: string;
  candidates: readonly NoveltyRescanCandidate[];
  noveltySourceIds?: readonly NoveltySourceId[];
  limitPerSource?: number;
}>;

export type LiteratureCloseoutMonitorInput = Readonly<{
  action: "candidate_monitor_poll";
  query?: string;
  monitorSourceIds?: readonly MonitorSourceId[];
  monitorLimit?: number;
  fromYear?: number;
  toYear?: number;
  zoteroCollectionKey?: string;
}>;

export type LiteratureCloseoutInput =
  | LiteratureCloseoutEvidenceInput
  | LiteratureCloseoutNoveltyInput
  | LiteratureCloseoutMonitorInput;

type CloseoutSafety = Readonly<{
  candidateOnly: boolean;
  zoteroWritePerformed: false;
  literatureMapWritePerformed: false;
  formalPromotionPerformed: false;
}>;

export type LiteratureCloseoutResult =
  | Readonly<{
      schemaVersion: 1;
      kind: "literature_closeout_result";
      action: "evidence_pack";
      artifact: EvidencePackArtifact;
      safety: CloseoutSafety;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "literature_closeout_result";
      action: "novelty_rescan";
      artifact: CandidatePortfolioArtifact;
      safety: CloseoutSafety;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "literature_closeout_result";
      action: "candidate_monitor_poll";
      monitor: MonitorResult;
      safety: CloseoutSafety;
    }>;

export type CreateLiteratureCloseoutToolOptions = Readonly<{
  search?: CreateLiteratureSearchToolOptions;
  zoteroFetchImpl?: typeof fetch;
  zoteroTimeoutMs?: number;
  maxResultBytes?: number;
}>;

/**
 * Exposes the final literature primitives without promoting candidates or
 * writing to Zotero/the reviewed literature map.
 */
export function createLiteratureCloseoutTool(
  options: CreateLiteratureCloseoutToolOptions = {},
): PilotDeckToolDefinition<LiteratureCloseoutInput, LiteratureCloseoutResult> {
  const searchTool = createLiteratureSearchTool(options.search);
  return {
    name: TOOL_NAME,
    title: "Close Out Literature Evidence and Candidates",
    description: `Create traceable evidence packs, rescan research-direction candidates across official metadata sources, or poll the project-local candidate monitor.

Use action=evidence_pack only with an exact source snapshot and a page, paragraph, section, or character locator; a Zotero attachment may be read through the existing Local API provider. Use action=novelty_rescan to collect auditable similarity and value signals across OpenAlex, Crossref, and arXiv. Use action=candidate_monitor_poll to compare Zotero/arXiv candidates with the previous project-local ledger. This tool never writes to Zotero, never writes or promotes into the reviewed literature map, and never claims novelty when source coverage is unavailable.`,
    kind: "custom",
    inputSchema: inputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 1_500_000,
    isReadOnly: (input) => input?.action !== "candidate_monitor_poll",
    isConcurrencySafe: (input) => input?.action !== "candidate_monitor_poll",
    isDestructive: () => false,
    isOpenWorld: (input) => input?.action === "novelty_rescan"
      || (input?.action === "candidate_monitor_poll"
        && (input.monitorSourceIds === undefined || input.monitorSourceIds.includes("arxiv"))),
    validateInput: async (input): Promise<PilotDeckToolValidationResult> => validateInput(input),
    checkPermissions: async (input, context): Promise<PermissionResult> => {
      let normalized: LiteratureCloseoutInput;
      try {
        normalized = normalizeInput(input);
      } catch {
        return { type: "passthrough" };
      }
      if (normalized.action === "novelty_rescan") {
        return searchTool.checkPermissions?.({ query: normalized.candidates[0]!.query ?? normalized.candidates[0]!.summary }, context)
          ?? { type: "passthrough" };
      }
      if (normalized.action === "candidate_monitor_poll" && normalized.monitorSourceIds?.includes("arxiv")) {
        return searchTool.checkPermissions?.({ query: normalized.query ?? "candidate monitor" }, context)
          ?? { type: "passthrough" };
      }
      return { type: "passthrough" };
    },
    execute: async (rawInput, context) => {
      let input: LiteratureCloseoutInput;
      try {
        input = normalizeInput(rawInput);
      } catch (error) {
        throw invalidInput(error);
      }

      if (input.action === "evidence_pack") {
        return executeEvidencePack(input, context, options);
      }
      if (input.action === "novelty_rescan") {
        return executeNoveltyRescan(input, context, options);
      }
      return executeCandidateMonitor(input, context, options);
    },
  };
}

async function executeEvidencePack(
  input: LiteratureCloseoutEvidenceInput,
  context: PilotDeckToolRuntimeContext,
  options: CreateLiteratureCloseoutToolOptions,
): Promise<PilotDeckToolExecutionOutput<LiteratureCloseoutResult>> {
  const now = context.now?.() ?? new Date();
  let artifact: EvidencePackArtifact;
  if (input.entries) {
    try {
      artifact = createEvidencePackArtifact({
        entries: input.entries,
        producer: { kind: "tool", toolName: TOOL_NAME },
        ...(input.artifactId ? { artifactId: input.artifactId } : {}),
        now,
      });
    } catch (error) {
      throw invalidInput(error);
    }
  } else {
    const attachment = input.zoteroAttachment!;
    const settings = (await readSettings(context)).effective;
    if (!settings.zotero.enabled) {
      throw new PilotDeckToolRuntimeError("setup_required", "Zotero is disabled in Research Settings.");
    }
    const provider = createZoteroLibraryProvider({
      baseUrl: settings.zotero.baseUrl,
      fetchImpl: options.zoteroFetchImpl,
      timeoutMs: positiveInteger(options.zoteroTimeoutMs),
      now: context.now,
    });
    try {
      artifact = await captureZoteroAttachmentEvidence({
        provider,
        attachmentKey: attachment.attachmentKey,
        paperId: attachment.paperId,
        entryId: attachment.entryId,
        locator: attachment.locator,
        ...(attachment.quote ? { quote: attachment.quote } : {}),
        ...(attachment.note ? { note: attachment.note } : {}),
        producer: { kind: "tool", toolName: TOOL_NAME },
        ...(input.artifactId ? { artifactId: input.artifactId } : {}),
        now,
      });
    } catch (error) {
      throw new PilotDeckToolRuntimeError(
        "tool_execution_failed",
        `Zotero evidence capture failed: ${errorMessage(error)}`,
      );
    }
  }

  return formatOutput({
    schemaVersion: 1,
    kind: "literature_closeout_result",
    action: "evidence_pack",
    artifact,
    safety: safety(false),
  });
}

async function executeNoveltyRescan(
  input: LiteratureCloseoutNoveltyInput,
  context: PilotDeckToolRuntimeContext,
  options: CreateLiteratureCloseoutToolOptions,
): Promise<PilotDeckToolExecutionOutput<LiteratureCloseoutResult>> {
  const settings = (await readSettings(context)).effective;
  if (!settings.literature.enabled) {
    throw new PilotDeckToolRuntimeError("setup_required", "Academic literature search is disabled in Research Settings.");
  }
  if (!settings.privacy.allowRemoteMetadataSearch) {
    throw new PilotDeckToolRuntimeError("permission_denied", "Remote metadata search is disabled by Research Settings privacy controls.");
  }
  const requestedLimit = input.limitPerSource ?? settings.literature.search.defaultLimit;
  const limitPerSource = Math.min(requestedLimit, settings.literature.budget.maxResultsPerSearch);
  const sources = noveltySources(input.noveltySourceIds!, settings, options);
  let rescan;
  try {
    rescan = await rescanCandidateDirections({
      candidates: input.candidates,
      sources,
      limitPerSource,
      ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      now: context.now,
    });
  } catch (error) {
    throw invalidInput(error);
  }
  const artifact = createCandidatePortfolioArtifact({
    rescan,
    producer: { kind: "tool", toolName: TOOL_NAME },
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    now: context.now?.() ?? new Date(),
  });
  return formatOutput({
    schemaVersion: 1,
    kind: "literature_closeout_result",
    action: "novelty_rescan",
    artifact,
    safety: safety(true),
  });
}

async function executeCandidateMonitor(
  input: LiteratureCloseoutMonitorInput,
  context: PilotDeckToolRuntimeContext,
  options: CreateLiteratureCloseoutToolOptions,
): Promise<PilotDeckToolExecutionOutput<LiteratureCloseoutResult>> {
  await requireProjectDirectory(context.cwd);
  const settings = (await readSettings(context)).effective;
  if (!settings.literature.enabled) {
    throw new PilotDeckToolRuntimeError("setup_required", "Academic literature monitoring is disabled in Research Settings.");
  }
  const sources = monitorSources(input, settings, context, options);
  let monitor: MonitorResult;
  try {
    monitor = await syncProjectLiteratureCandidateMonitor({
      projectRoot: context.cwd,
      sources,
      ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      now: context.now,
    });
  } catch (error) {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `Candidate monitor poll failed: ${errorMessage(error)}`,
    );
  }
  return formatOutput({
    schemaVersion: 1,
    kind: "literature_closeout_result",
    action: "candidate_monitor_poll",
    monitor,
    safety: safety(true),
  });
}

function noveltySources(
  sourceIds: readonly NoveltySourceId[],
  settings: ResearchSettings,
  options: CreateLiteratureCloseoutToolOptions,
): NoveltyRescanSource[] {
  const search = options.search ?? {};
  const timeoutMs = settings.literature.budget.requestTimeoutMs;
  return sourceIds.map((sourceId) => {
    if (sourceId === "openalex") {
      return settings.literature.sources.openalex.enabled
        ? createOpenAlexSource({
            endpoint: search.endpoint,
            fetchImpl: search.fetchImpl,
            timeoutMs,
            mailto: settings.literature.sources.openalex.mailto,
            includeTopicEdges: false,
          })
        : disabledNoveltySource("openalex", "OpenAlex");
    }
    if (sourceId === "crossref") {
      return settings.literature.sources.crossref.enabled
        ? createCrossrefSource({
            endpoint: search.crossrefEndpoint,
            fetchImpl: search.crossrefFetchImpl ?? search.fetchImpl,
            timeoutMs,
            mailto: settings.literature.sources.crossref.mailto,
          })
        : disabledNoveltySource("crossref", "Crossref");
    }
    return settings.literature.sources.arxiv.enabled
      ? createArxivSource({
          endpoint: search.arxivEndpoint,
          fetchImpl: search.arxivFetchImpl ?? search.fetchImpl,
          timeoutMs,
          ...(search.arxivMinimumIntervalMs === undefined ? {} : { minimumIntervalMs: search.arxivMinimumIntervalMs }),
        })
      : disabledNoveltySource("arxiv", "arXiv");
  });
}

function monitorSources(
  input: LiteratureCloseoutMonitorInput,
  settings: ResearchSettings,
  context: PilotDeckToolRuntimeContext,
  options: CreateLiteratureCloseoutToolOptions,
): LiteratureCandidateMonitorSource[] {
  const search = options.search ?? {};
  return input.monitorSourceIds!.map((sourceId) => {
    if (sourceId === "zotero") {
      if (!settings.zotero.enabled) return disabledMonitorSource("zotero", "Zotero", "Zotero is disabled in Research Settings.", context);
      const provider = createZoteroLibraryProvider({
        baseUrl: settings.zotero.baseUrl,
        fetchImpl: options.zoteroFetchImpl,
        timeoutMs: positiveInteger(options.zoteroTimeoutMs),
        now: context.now,
      });
      return createZoteroCandidateMonitorSource({
        provider,
        collectionKey: input.zoteroCollectionKey ?? settings.zotero.collectionKey ?? undefined,
        maxItems: input.monitorLimit,
        now: context.now,
      });
    }
    if (!settings.privacy.allowRemoteMetadataSearch) {
      return disabledMonitorSource("arxiv", "arXiv", "Remote metadata search is disabled by Research Settings privacy controls.", context);
    }
    if (!settings.literature.sources.arxiv.enabled) {
      return disabledMonitorSource("arxiv", "arXiv", "arXiv is disabled in Research Settings.", context);
    }
    const source = createArxivSource({
      endpoint: search.arxivEndpoint,
      fetchImpl: search.arxivFetchImpl ?? search.fetchImpl,
      timeoutMs: settings.literature.budget.requestTimeoutMs,
      ...(search.arxivMinimumIntervalMs === undefined ? {} : { minimumIntervalMs: search.arxivMinimumIntervalMs }),
    });
    return createPreprintCandidateMonitorSource({
      source,
      query: input.query!,
      limit: input.monitorLimit,
      ...(input.fromYear === undefined ? {} : { fromYear: input.fromYear }),
      ...(input.toYear === undefined ? {} : { toYear: input.toYear }),
      now: context.now,
    });
  });
}

function disabledNoveltySource(id: string, name: string): NoveltyRescanSource {
  return {
    id,
    name,
    search: async (_plan, context = {}) => ({
      papers: [],
      edges: [],
      source: {
        id,
        name,
        status: "disabled",
        retrievedAt: (context.now?.() ?? new Date()).toISOString(),
        resultCount: 0,
        coverage: `${name} is disabled in Research Settings.`,
      },
    }),
  };
}

function disabledMonitorSource(
  id: string,
  name: string,
  reason: string,
  context: PilotDeckToolRuntimeContext,
): LiteratureCandidateMonitorSource {
  return {
    id,
    name,
    poll: async ({ now }) => ({
      papers: [],
      source: {
        id,
        name,
        status: "disabled",
        retrievedAt: (now ?? context.now ?? (() => new Date()))().toISOString(),
        coverage: reason,
      },
    }),
  };
}

function normalizeInput(value: unknown): LiteratureCloseoutInput {
  if (!isRecord(value)) throw new TypeError("input must be an object.");
  const action = value.action;
  if (action === "evidence_pack") return normalizeEvidenceInput(value);
  if (action === "novelty_rescan") return normalizeNoveltyInput(value);
  if (action === "candidate_monitor_poll") return normalizeMonitorInput(value);
  throw new TypeError("action must be evidence_pack, novelty_rescan, or candidate_monitor_poll.");
}

function normalizeEvidenceInput(value: Record<string, unknown>): LiteratureCloseoutEvidenceInput {
  assertAllowedKeys(value, ["action", "artifactId", "entries", "zoteroAttachment"]);
  const artifactId = optionalArtifactId(value.artifactId);
  const hasEntries = value.entries !== undefined;
  const hasAttachment = value.zoteroAttachment !== undefined;
  if (hasEntries === hasAttachment) throw new TypeError("evidence_pack requires exactly one of entries or zoteroAttachment.");
  if (hasEntries) {
    if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > MAX_TOOL_EVIDENCE_ENTRIES) {
      throw new TypeError(`entries must contain between 1 and ${MAX_TOOL_EVIDENCE_ENTRIES} evidence records.`);
    }
    let totalChars = 0;
    for (const [index, entry] of value.entries.entries()) {
      if (!isRecord(entry)) throw new TypeError(`entries[${index}] must be an object.`);
      assertAllowedKeys(entry, ["id", "paperId", "locator", "snapshot", "quote", "note"], `entries[${index}]`);
      if (!isRecord(entry.locator)) throw new TypeError(`entries[${index}].locator must be an object.`);
      assertAllowedKeys(entry.locator, ["sourceId", "recordId", "url", "page", "paragraph", "section", "characterStart", "characterEnd"], `entries[${index}].locator`);
      if (!isRecord(entry.snapshot)) throw new TypeError(`entries[${index}].snapshot must be an object.`);
      assertAllowedKeys(entry.snapshot, ["content", "contentHash", "capturedAt", "mediaType", "truncated", "indexedPages", "totalPages"], `entries[${index}].snapshot`);
      if (typeof entry.snapshot.content === "string") totalChars += entry.snapshot.content.length;
    }
    if (totalChars > MAX_TOOL_EVIDENCE_CHARS) {
      throw new TypeError(`evidence snapshot content exceeds ${MAX_TOOL_EVIDENCE_CHARS} characters.`);
    }
    const entries = value.entries as unknown as readonly EvidencePackEntryInput[];
    buildEvidencePack({ entries, now: new Date(0) });
    return { action: "evidence_pack", entries, ...(artifactId ? { artifactId } : {}) };
  }
  const zoteroAttachment = normalizeZoteroAttachment(value.zoteroAttachment);
  return { action: "evidence_pack", zoteroAttachment, ...(artifactId ? { artifactId } : {}) };
}

function normalizeZoteroAttachment(value: unknown): NonNullable<LiteratureCloseoutEvidenceInput["zoteroAttachment"]> {
  if (!isRecord(value)) throw new TypeError("zoteroAttachment must be an object.");
  assertAllowedKeys(value, ["attachmentKey", "paperId", "entryId", "locator", "quote", "note"], "zoteroAttachment");
  if (!isRecord(value.locator)) throw new TypeError("zoteroAttachment.locator must be an object.");
  assertAllowedKeys(value.locator, ["url", "page", "paragraph", "section", "characterStart", "characterEnd"], "zoteroAttachment.locator");
  const locator = normalizeZoteroLocator(value.locator);
  return {
    attachmentKey: requiredText(value.attachmentKey, "zoteroAttachment.attachmentKey", 256),
    paperId: requiredText(value.paperId, "zoteroAttachment.paperId", 256),
    entryId: requiredText(value.entryId, "zoteroAttachment.entryId", 256),
    locator,
    ...(value.quote === undefined ? {} : { quote: requiredText(value.quote, "zoteroAttachment.quote", 16_000) }),
    ...(value.note === undefined ? {} : { note: requiredText(value.note, "zoteroAttachment.note", 4_000) }),
  };
}

function normalizeZoteroLocator(value: Record<string, unknown>): ZoteroEvidenceLocator {
  const page = optionalInteger(value.page, "zoteroAttachment.locator.page", 1);
  const paragraph = optionalInteger(value.paragraph, "zoteroAttachment.locator.paragraph", 1);
  const characterStart = optionalInteger(value.characterStart, "zoteroAttachment.locator.characterStart", 0);
  const characterEnd = optionalInteger(value.characterEnd, "zoteroAttachment.locator.characterEnd", 0);
  const section = value.section === undefined ? undefined : requiredText(value.section, "zoteroAttachment.locator.section", 512);
  const url = value.url === undefined ? undefined : requiredText(value.url, "zoteroAttachment.locator.url", 4_096);
  if (page === undefined && paragraph === undefined && section === undefined && characterStart === undefined) {
    throw new TypeError("zoteroAttachment.locator requires page, paragraph, section, or characterStart.");
  }
  if (characterStart !== undefined && characterEnd !== undefined && characterEnd < characterStart) {
    throw new TypeError("zoteroAttachment.locator.characterEnd cannot precede characterStart.");
  }
  return {
    ...(url === undefined ? {} : { url }),
    ...(page === undefined ? {} : { page }),
    ...(paragraph === undefined ? {} : { paragraph }),
    ...(section === undefined ? {} : { section }),
    ...(characterStart === undefined ? {} : { characterStart }),
    ...(characterEnd === undefined ? {} : { characterEnd }),
  };
}

function normalizeNoveltyInput(value: Record<string, unknown>): LiteratureCloseoutNoveltyInput {
  assertAllowedKeys(value, ["action", "artifactId", "candidates", "noveltySourceIds", "limitPerSource"]);
  if (!Array.isArray(value.candidates) || value.candidates.length === 0 || value.candidates.length > 24) {
    throw new TypeError("candidates must contain between 1 and 24 records.");
  }
  const ids = new Set<string>();
  const candidates = value.candidates.map((candidate, index): NoveltyRescanCandidate => {
    if (!isRecord(candidate)) throw new TypeError(`candidates[${index}] must be an object.`);
    assertAllowedKeys(candidate, ["id", "summary", "titleSeed", "query"], `candidates[${index}]`);
    const id = requiredText(candidate.id, `candidates[${index}].id`, 256);
    if (ids.has(id)) throw new TypeError(`Candidate ${id} is duplicated.`);
    ids.add(id);
    return {
      id,
      summary: requiredText(candidate.summary, `candidates[${index}].summary`, 1_000),
      ...(candidate.titleSeed === undefined ? {} : { titleSeed: requiredText(candidate.titleSeed, `candidates[${index}].titleSeed`, 1_000) }),
      ...(candidate.query === undefined ? {} : { query: requiredText(candidate.query, `candidates[${index}].query`, 1_000) }),
    };
  });
  const noveltySourceIds = normalizeEnumArray(value.noveltySourceIds, NOVELTY_SOURCE_IDS, "noveltySourceIds");
  const limitPerSource = optionalInteger(value.limitPerSource, "limitPerSource", 1, 50);
  const artifactId = optionalArtifactId(value.artifactId);
  return {
    action: "novelty_rescan",
    candidates,
    noveltySourceIds: noveltySourceIds ?? [...NOVELTY_SOURCE_IDS],
    ...(limitPerSource === undefined ? {} : { limitPerSource }),
    ...(artifactId ? { artifactId } : {}),
  };
}

function normalizeMonitorInput(value: Record<string, unknown>): LiteratureCloseoutMonitorInput {
  assertAllowedKeys(value, ["action", "query", "monitorSourceIds", "monitorLimit", "fromYear", "toYear", "zoteroCollectionKey"]);
  const monitorSourceIds = normalizeEnumArray(value.monitorSourceIds, MONITOR_SOURCE_IDS, "monitorSourceIds") ?? [...MONITOR_SOURCE_IDS];
  const query = value.query === undefined ? undefined : requiredText(value.query, "query", 1_000);
  if (monitorSourceIds.includes("arxiv") && !query) throw new TypeError("query is required when monitorSourceIds includes arxiv.");
  const monitorLimit = optionalInteger(value.monitorLimit, "monitorLimit", 1, 100) ?? 25;
  const fromYear = optionalYear(value.fromYear, "fromYear");
  const toYear = optionalYear(value.toYear, "toYear");
  if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) throw new TypeError("fromYear cannot be after toYear.");
  const zoteroCollectionKey = value.zoteroCollectionKey === undefined
    ? undefined
    : requiredText(value.zoteroCollectionKey, "zoteroCollectionKey", 32);
  return {
    action: "candidate_monitor_poll",
    monitorSourceIds,
    monitorLimit,
    ...(query ? { query } : {}),
    ...(fromYear === undefined ? {} : { fromYear }),
    ...(toYear === undefined ? {} : { toYear }),
    ...(zoteroCollectionKey === undefined ? {} : { zoteroCollectionKey }),
  };
}

function validateInput(input: unknown): PilotDeckToolValidationResult {
  try {
    return { ok: true, input: normalizeInput(input) };
  } catch (error) {
    const issue: PilotDeckToolValidationIssue = {
      path: "$",
      code: "invalid_schema",
      message: errorMessage(error),
    };
    return { ok: false, issues: [issue] };
  }
}

function inputSchema() {
  const locatorProperties = {
    url: { type: "string", maxLength: 4_096 },
    page: { type: "integer", minimum: 1 },
    paragraph: { type: "integer", minimum: 1 },
    section: { type: "string", maxLength: 512 },
    characterStart: { type: "integer", minimum: 0 },
    characterEnd: { type: "integer", minimum: 0 },
  };
  return {
    type: "object" as const,
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["evidence_pack", "novelty_rescan", "candidate_monitor_poll"] },
      artifactId: { type: "string", maxLength: 256 },
      entries: {
        type: "array",
        minItems: 1,
        maxItems: MAX_TOOL_EVIDENCE_ENTRIES,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "paperId", "locator", "snapshot"],
          properties: {
            id: { type: "string", maxLength: 256 },
            paperId: { type: "string", maxLength: 256 },
            locator: {
              type: "object",
              additionalProperties: false,
              required: ["sourceId"],
              properties: {
                sourceId: { type: "string", maxLength: 256 },
                recordId: { type: "string", maxLength: 256 },
                ...locatorProperties,
              },
            },
            snapshot: {
              type: "object",
              additionalProperties: false,
              required: ["content"],
              properties: {
                content: { type: "string", maxLength: MAX_TOOL_EVIDENCE_CHARS },
                contentHash: { type: "string", maxLength: 128 },
                capturedAt: { type: "string", maxLength: 128 },
                mediaType: { type: "string", maxLength: 128 },
                truncated: { type: "boolean" },
                indexedPages: { type: "integer", minimum: 0 },
                totalPages: { type: "integer", minimum: 0 },
              },
            },
            quote: { type: "string", maxLength: 16_000 },
            note: { type: "string", maxLength: 4_000 },
          },
        },
      },
      zoteroAttachment: {
        type: "object",
        additionalProperties: false,
        required: ["attachmentKey", "paperId", "entryId", "locator"],
        properties: {
          attachmentKey: { type: "string", maxLength: 256 },
          paperId: { type: "string", maxLength: 256 },
          entryId: { type: "string", maxLength: 256 },
          locator: { type: "object", additionalProperties: false, properties: locatorProperties },
          quote: { type: "string", maxLength: 16_000 },
          note: { type: "string", maxLength: 4_000 },
        },
      },
      candidates: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "summary"],
          properties: {
            id: { type: "string", maxLength: 256 },
            summary: { type: "string", maxLength: 1_000 },
            titleSeed: { type: "string", maxLength: 1_000 },
            query: { type: "string", maxLength: 1_000 },
          },
        },
      },
      noveltySourceIds: {
        type: "array",
        minItems: 1,
        maxItems: NOVELTY_SOURCE_IDS.length,
        uniqueItems: true,
        items: { type: "string", enum: [...NOVELTY_SOURCE_IDS] },
      },
      limitPerSource: { type: "integer", minimum: 1, maximum: 50 },
      query: { type: "string", maxLength: 1_000 },
      monitorSourceIds: {
        type: "array",
        minItems: 1,
        maxItems: MONITOR_SOURCE_IDS.length,
        uniqueItems: true,
        items: { type: "string", enum: [...MONITOR_SOURCE_IDS] },
      },
      monitorLimit: { type: "integer", minimum: 1, maximum: 100 },
      fromYear: { type: "integer", minimum: 1800 },
      toYear: { type: "integer", minimum: 1800 },
      zoteroCollectionKey: { type: "string", maxLength: 32 },
    },
  };
}

function formatOutput(result: LiteratureCloseoutResult): PilotDeckToolExecutionOutput<LiteratureCloseoutResult> {
  const lines = [
    `Literature closeout: ${result.action}`,
    "Zotero write: no",
    "Reviewed literature-map write: no",
    "Formal candidate promotion: no",
  ];
  const metadata: Record<string, unknown> = {
    action: result.action,
    candidateOnly: result.safety.candidateOnly,
    zoteroWritePerformed: false,
    literatureMapWritePerformed: false,
  };
  if (result.action === "evidence_pack") {
    lines.push(`Evidence entries: ${result.artifact.payload.entries.length}`, `Artifact: ${result.artifact.artifactId}`);
    metadata.artifactId = result.artifact.artifactId;
    metadata.entryCount = result.artifact.payload.entries.length;
  } else if (result.action === "novelty_rescan") {
    lines.push(
      `Candidates rescanned: ${result.artifact.payload.rescan.candidates.length}`,
      `Coverage: ${result.artifact.payload.rescan.coverage.status}`,
      `Artifact: ${result.artifact.artifactId}`,
    );
    metadata.artifactId = result.artifact.artifactId;
    metadata.candidateCount = result.artifact.payload.rescan.candidates.length;
    metadata.coverageStatus = result.artifact.payload.rescan.coverage.status;
  } else {
    lines.push(
      `New candidates: ${result.monitor.newCandidates.length}`,
      `Updated candidates: ${result.monitor.updatedCandidates.length}`,
      `Candidate ledger persisted: ${result.monitor.persisted ? "yes" : "no"}`,
      `Candidate ledger: ${result.monitor.path}`,
    );
    metadata.newCandidateCount = result.monitor.newCandidates.length;
    metadata.updatedCandidateCount = result.monitor.updatedCandidates.length;
    metadata.persisted = result.monitor.persisted;
    metadata.path = result.monitor.path;
  }
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "json", value: result },
    ],
    data: result,
    metadata,
  };
}

function safety(candidateOnly: boolean): CloseoutSafety {
  return {
    candidateOnly,
    zoteroWritePerformed: false,
    literatureMapWritePerformed: false,
    formalPromotionPerformed: false,
  };
}

async function readSettings(context: PilotDeckToolRuntimeContext) {
  return readResearchSettings({
    pilotHome: context.env?.PILOT_HOME,
    projectRoot: context.cwd,
  });
}

async function requireProjectDirectory(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new PilotDeckToolRuntimeError("path_not_allowed", "Candidate monitoring requires an existing current Project directory.");
  }
}

function normalizeEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length) {
    throw new TypeError(`${label} must contain between 1 and ${allowed.length} values.`);
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== "string" || !allowed.includes(entry as T)) throw new TypeError(`${label} contains an unsupported value.`);
    return entry as T;
  });
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${label} must not contain duplicates.`);
  return normalized;
}

function optionalArtifactId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const artifactId = requiredText(value, "artifactId", 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(artifactId)) throw new TypeError("artifactId must be a safe identifier.");
  return artifactId;
}

function optionalYear(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return optionalInteger(value, label, 1800, new Date().getUTCFullYear() + 2);
}

function optionalInteger(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function positiveInteger(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) {
    throw new TypeError(`${label} must be trimmed non-empty text no longer than ${maximum} characters.`);
  }
  return value;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label = "input"): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new TypeError(`${label}.${unknown} is not supported for this action.`);
}

function invalidInput(error: unknown): PilotDeckToolRuntimeError {
  return error instanceof PilotDeckToolRuntimeError
    ? error
    : new PilotDeckToolRuntimeError("invalid_tool_input", errorMessage(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
