import { randomUUID } from "node:crypto";
import type {
  ZoteroCloudBatchWriteFailure,
  ZoteroCloudBatchWriteSuccess,
  ZoteroCloudDeleted,
  ZoteroCloudExecuteWritePlanInput,
  ZoteroCloudLibrary,
  ZoteroCloudProvider,
  ZoteroCloudSettings,
  ZoteroCloudStatus,
  ZoteroCloudStatusKind,
  ZoteroCloudSyncResult,
  ZoteroCloudTagOperation,
  ZoteroCloudTransport,
  ZoteroCloudTransportRequest,
  ZoteroCloudTransportResponse,
  ZoteroCloudVersions,
  ZoteroCloudWriteConflict,
  ZoteroCloudWriteIntent,
  ZoteroCloudWritePlan,
  ZoteroCloudWriteResult,
} from "../types.js";

const API_VERSION = "3";
const DEFAULT_PLAN_TTL_MS = 5 * 60_000;
const MAX_NOTE_HTML_CHARS = 500_000;
const MAX_TAGS_PER_CHANGE = 100;
const MAX_TAG_CHARS = 256;

type ResolvedCloudContext = {
  library: ZoteroCloudLibrary;
  libraryVersion: number;
  writable: boolean;
  status: ZoteroCloudStatus;
};

type CloudItem = {
  key: string;
  version: number;
  itemType: string;
  tags: string[];
  noteHtml: string;
};

type CachedPlan = {
  plan: ZoteroCloudWritePlan;
  expiresAt: number;
};

type BatchOutcome = {
  successful: ZoteroCloudBatchWriteSuccess[];
  unchanged: ZoteroCloudBatchWriteSuccess[];
  failed: ZoteroCloudBatchWriteFailure[];
};

export type CreateZoteroCloudProviderOptions = {
  /**
   * This is an authenticated boundary owned by the caller. It receives no
   * absolute URLs and is the only place that may attach a Zotero API key.
   */
  transport: ZoteroCloudTransport;
  config?: ZoteroCloudSettings;
  now?: () => Date;
  planTtlMs?: number;
  createPlanId?: () => string;
};

export class ZoteroCloudProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoteroCloudProviderError";
  }
}

/**
 * A small domain-only adapter for Zotero's Web API v3.
 *
 * It deliberately knows nothing about credentials, Electron, or HTTP clients.
 * An outer secure process injects an authenticated transport and the provider
 * only sends relative Zotero API paths through that boundary.
 */
export function createZoteroCloudProvider(
  options: CreateZoteroCloudProviderOptions,
): ZoteroCloudProvider {
  const transport = options.transport;
  const config = normalizeConfig(options.config);
  const now = options.now ?? (() => new Date());
  const createPlanId = options.createPlanId ?? randomUUID;
  const planTtlMs = normalizePlanTtl(options.planTtlMs);
  const plans = new Map<string, CachedPlan>();

  const request = async (input: ZoteroCloudTransportRequest): Promise<ZoteroCloudTransportResponse> => {
    assertRelativePath(input.path);
    try {
      const response = await transport.request(input);
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        throw new ZoteroCloudProviderError("Zotero cloud transport returned an invalid HTTP status.");
      }
      return response;
    } catch (error) {
      if (error instanceof ZoteroCloudProviderError) throw error;
      // Transport errors can include implementation-specific request headers.
      // Never surface them, because the transport owns credentials.
      throw new ZoteroCloudProviderError("Unable to contact the Zotero Web API.");
    }
  };

  const getStatus = async (): Promise<ZoteroCloudStatus> => {
    const checkedAt = now().toISOString();
    if (!config.enabled || (config.libraryType === "group" && !config.libraryId)) {
      return unconfiguredStatus(checkedAt);
    }

    let keyResponse: ZoteroCloudTransportResponse;
    try {
      keyResponse = await request({
        path: "/keys/current",
        method: "GET",
        headers: baseHeaders(),
      });
    } catch {
      return statusForTransportFailure(checkedAt);
    }
    if (!isSuccessful(keyResponse.status)) {
      return statusForHttpFailure(keyResponse, checkedAt);
    }

    const account = asRecord(keyResponse.body);
    const userId = positiveId(account?.userID);
    const library = resolveLibrary(config, userId);
    if (!library) {
      return errorStatus(checkedAt, "Zotero Web API did not provide a usable library identity.");
    }
    const permissions = libraryPermissions(account?.access, library);
    if (!permissions.readable) {
      return errorStatus(checkedAt, "The configured Zotero library is not readable by this credential.", library);
    }

    let versionResponse: ZoteroCloudTransportResponse;
    try {
      versionResponse = await request({
        path: `${library.path}/items?format=versions&limit=1`,
        method: "GET",
        headers: baseHeaders(),
      });
    } catch {
      return statusForTransportFailure(checkedAt, library);
    }
    if (!isSuccessful(versionResponse.status)) {
      return statusForHttpFailure(versionResponse, checkedAt, library);
    }
    const libraryVersion = responseLibraryVersion(versionResponse);
    if (libraryVersion === undefined) {
      return errorStatus(checkedAt, "Zotero Web API did not provide a library version.", library);
    }
    return statusFromResolvedContext({
      library,
      libraryVersion,
      writable: permissions.writable,
      checkedAt,
      response: versionResponse,
    });
  };

  const resolveReadyContext = async (allowReadOnly: boolean): Promise<ResolvedCloudContext> => {
    const status = await getStatus();
    if (!status.library || status.libraryVersion === undefined) {
      throw new ZoteroCloudProviderError(status.error ?? "Zotero cloud is not configured or available.");
    }
    if (!allowReadOnly && !status.writable) {
      throw new ZoteroCloudProviderError("The configured Zotero library is read-only.");
    }
    return {
      library: status.library,
      libraryVersion: status.libraryVersion,
      writable: status.writable,
      status,
    };
  };

  const createWritePlan = async (intent: ZoteroCloudWriteIntent): Promise<ZoteroCloudWritePlan> => {
    const context = await resolveReadyContext(false);
    const preparedAt = now().toISOString();
    const planId = requirePlanId(createPlanId());
    let plan: ZoteroCloudWritePlan;

    if (intent.kind === "tags") {
      const itemKey = requireItemKey(intent.itemKey);
      const requestedTags = normalizeTags(intent.tags);
      const item = await readItem(context.library, itemKey);
      const afterTags = applyTagOperation(item.tags, requestedTags, intent.operation);
      plan = {
        planId,
        preparedAt,
        library: context.library,
        libraryVersion: context.libraryVersion,
        requiresConfirmation: true,
        kind: "tags",
        itemKey,
        itemVersion: item.version,
        operation: intent.operation,
        requestedTags,
        beforeTags: item.tags,
        afterTags,
      };
    } else if (intent.operation === "create") {
      const parentItemKey = requireItemKey(intent.parentItemKey);
      const parentItem = await readItem(context.library, parentItemKey);
      plan = {
        planId,
        preparedAt,
        library: context.library,
        libraryVersion: context.libraryVersion,
        requiresConfirmation: true,
        kind: "note",
        operation: "create",
        parentItemKey,
        parentItemVersion: parentItem.version,
        html: requireNoteHtml(intent.html),
      };
    } else {
      const noteKey = requireItemKey(intent.noteKey);
      const note = await readItem(context.library, noteKey);
      if (note.itemType !== "note") {
        throw new ZoteroCloudProviderError("The requested Zotero item is not a note.");
      }
      if (intent.operation === "update") {
        plan = {
          planId,
          preparedAt,
          library: context.library,
          libraryVersion: context.libraryVersion,
          requiresConfirmation: true,
          kind: "note",
          operation: "update",
          noteKey,
          noteVersion: note.version,
          beforeHtml: note.noteHtml,
          html: requireNoteHtml(intent.html),
        };
      } else {
        plan = {
          planId,
          preparedAt,
          library: context.library,
          libraryVersion: context.libraryVersion,
          requiresConfirmation: true,
          kind: "note",
          operation: "delete",
          noteKey,
          noteVersion: note.version,
          beforeHtml: note.noteHtml,
        };
      }
    }

    plans.set(plan.planId, {
      // The cache is authoritative, so callers cannot alter a reviewed plan
      // between preview and confirmation.
      plan: clonePlan(plan),
      expiresAt: now().getTime() + planTtlMs,
    });
    return clonePlan(plan);
  };

  const executeWritePlan = async (input: ZoteroCloudExecuteWritePlanInput): Promise<ZoteroCloudWriteResult> => {
    const requestedPlan = input.plan;
    if (!input.confirmed) return confirmationRequired(requestedPlan.planId);

    const cached = plans.get(requestedPlan.planId);
    if (!cached || cached.expiresAt <= now().getTime()) {
      plans.delete(requestedPlan.planId);
      return failedResult(requestedPlan.planId, "error", "This Zotero write plan has expired or is unknown.");
    }
    // Plans are one-shot. If a request outcome is uncertain, the caller must
    // explicitly preview again instead of replaying an old mutation.
    plans.delete(requestedPlan.planId);
    const plan = cached.plan;

    if (plan.kind === "tags") return executeTags(plan);
    if (plan.operation === "create") return executeCreateNote(plan);
    if (plan.operation === "update") return executeUpdateNote(plan);
    return executeDeleteNote(plan);
  };

  const executeTags = async (plan: Extract<ZoteroCloudWritePlan, { kind: "tags" }>): Promise<ZoteroCloudWriteResult> => {
    const response = await writeRequest(
      `${plan.library.path}/items/${encodeURIComponent(plan.itemKey)}`,
      "PATCH",
      {
        "If-Unmodified-Since-Version": String(plan.itemVersion),
        "Content-Type": "application/json",
      },
      { tags: plan.afterTags.map((tag) => ({ tag })) },
    );
    if (response === undefined) return failedResult(plan.planId, "error", "Unable to contact the Zotero Web API.");
    if (response.status !== 412) return resultFromWriteResponse(plan, response, 0, plan.itemKey);

    return retryTagPlanOnce(plan);
  };

  const retryTagPlanOnce = async (
    plan: Extract<ZoteroCloudWritePlan, { kind: "tags" }>,
  ): Promise<ZoteroCloudWriteResult> => {
    let latest: CloudItem;
    try {
      latest = await readItem(plan.library, plan.itemKey);
    } catch {
      return conflictResult(plan.planId, tagConflict(plan, undefined, "unsafe_rebase"), 0);
    }

    if (plan.operation === "replace" && !sameTagSet(plan.beforeTags, latest.tags)) {
      return conflictResult(plan.planId, tagConflict(plan, latest, "unsafe_rebase"), 0);
    }
    const rebasedTags = applyTagOperation(latest.tags, plan.requestedTags, plan.operation);
    const retry = await writeRequest(
      `${plan.library.path}/items/${encodeURIComponent(plan.itemKey)}`,
      "PATCH",
      {
        "If-Unmodified-Since-Version": String(latest.version),
        "Content-Type": "application/json",
      },
      { tags: rebasedTags.map((tag) => ({ tag })) },
    );
    if (retry === undefined) return failedResult(plan.planId, "error", "Unable to contact the Zotero Web API.", 1);
    if (retry.status === 412) {
      return conflictResult(plan.planId, tagConflict(plan, latest, "retry_exhausted"), 1);
    }
    return resultFromWriteResponse(plan, retry, 1, plan.itemKey);
  };

  const executeCreateNote = async (
    plan: Extract<ZoteroCloudWritePlan, { kind: "note"; operation: "create" }>,
  ): Promise<ZoteroCloudWriteResult> => {
    const response = await writeRequest(
      `${plan.library.path}/items`,
      "POST",
      {
        "If-Unmodified-Since-Version": String(plan.libraryVersion),
        "Content-Type": "application/json",
      },
      [{ itemType: "note", parentItem: plan.parentItemKey, note: plan.html }],
    );
    if (response === undefined) return failedResult(plan.planId, "error", "Unable to contact the Zotero Web API.");
    if (response.status === 412) {
      return conflictResult(plan.planId, {
        kind: "note",
        operation: "create",
        reason: "library_changed",
      }, 0, response);
    }
    return resultFromWriteResponse(plan, response, 0);
  };

  const executeUpdateNote = async (
    plan: Extract<ZoteroCloudWritePlan, { kind: "note"; operation: "update" }>,
  ): Promise<ZoteroCloudWriteResult> => {
    const response = await writeRequest(
      `${plan.library.path}/items/${encodeURIComponent(plan.noteKey)}`,
      "PATCH",
      {
        "If-Unmodified-Since-Version": String(plan.noteVersion),
        "Content-Type": "application/json",
      },
      { note: plan.html },
    );
    if (response === undefined) return failedResult(plan.planId, "error", "Unable to contact the Zotero Web API.");
    if (response.status !== 412) return resultFromWriteResponse(plan, response, 0, plan.noteKey);
    return noteConflictResult(plan, response);
  };

  const executeDeleteNote = async (
    plan: Extract<ZoteroCloudWritePlan, { kind: "note"; operation: "delete" }>,
  ): Promise<ZoteroCloudWriteResult> => {
    const response = await writeRequest(
      `${plan.library.path}/items/${encodeURIComponent(plan.noteKey)}`,
      "DELETE",
      { "If-Unmodified-Since-Version": String(plan.noteVersion) },
    );
    if (response === undefined) return failedResult(plan.planId, "error", "Unable to contact the Zotero Web API.");
    if (response.status !== 412) return resultFromWriteResponse(plan, response, 0, plan.noteKey);
    return noteConflictResult(plan, response);
  };

  const noteConflictResult = async (
    plan: Extract<ZoteroCloudWritePlan, { kind: "note"; operation: "update" }>
      | Extract<ZoteroCloudWritePlan, { kind: "note"; operation: "delete" }>,
    response: ZoteroCloudTransportResponse,
  ): Promise<ZoteroCloudWriteResult> => {
    let currentVersion: number | undefined;
    let remoteHtml: string | undefined;
    try {
      const current = await readItem(plan.library, plan.noteKey);
      currentVersion = current.version;
      remoteHtml = current.noteHtml;
    } catch {
      // The original operation still remains a deliberate conflict. A failed
      // refresh must not turn it into an overwrite or an implicit retry.
    }
    const conflict: ZoteroCloudWriteConflict = {
      kind: "note",
      operation: plan.operation,
      noteKey: plan.noteKey,
      originalVersion: plan.noteVersion,
      ...(currentVersion !== undefined ? { currentVersion } : {}),
      baseHtml: plan.beforeHtml,
      ...(plan.operation === "update" ? { localHtml: plan.html } : {}),
      ...(remoteHtml !== undefined ? { remoteHtml } : {}),
      reason: "remote_changed",
    };
    return conflictResult(plan.planId, conflict, 0, response);
  };

  const writeRequest = async (
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<ZoteroCloudTransportResponse | undefined> => {
    try {
      return await request({ path, method, headers: { ...baseHeaders(), ...headers }, ...(body !== undefined ? { body } : {}) });
    } catch {
      return undefined;
    }
  };

  const readItem = async (library: ZoteroCloudLibrary, itemKey: string): Promise<CloudItem> => {
    let response: ZoteroCloudTransportResponse;
    try {
      response = await request({
        path: `${library.path}/items/${encodeURIComponent(itemKey)}`,
        method: "GET",
        headers: baseHeaders(),
      });
    } catch {
      throw new ZoteroCloudProviderError("Unable to read the requested Zotero item.");
    }
    if (!isSuccessful(response.status)) {
      throw new ZoteroCloudProviderError(httpMessage(response.status));
    }
    const item = parseCloudItem(response.body);
    if (!item) throw new ZoteroCloudProviderError("Zotero Web API returned an invalid item record.");
    return item;
  };

  return {
    getStatus,
    async probeIncrementalSync(input = {}): Promise<ZoteroCloudSyncResult> {
      const checkedAt = now().toISOString();
      const sinceVersion = input.sinceVersion;
      if (sinceVersion !== undefined && (!Number.isSafeInteger(sinceVersion) || sinceVersion < 0)) {
        throw new ZoteroCloudProviderError("Zotero sync version must be a non-negative integer.");
      }
      const context = await resolveReadyContext(true).catch(() => undefined);
      if (!context) {
        const provider = await getStatus();
        return unavailableSync(provider, checkedAt, sinceVersion);
      }

      const querySuffix = sinceVersion === undefined ? "" : `&since=${sinceVersion}`;
      const headers = {
        ...baseHeaders(),
        ...(sinceVersion === undefined ? {} : { "If-Modified-Since-Version": String(sinceVersion) }),
      };
      let responses: ZoteroCloudTransportResponse[];
      try {
        responses = await Promise.all([
          request({
            path: `${context.library.path}/items?format=versions${querySuffix}`,
            method: "GET",
            headers,
          }),
          request({
            path: `${context.library.path}/collections?format=versions${querySuffix}`,
            method: "GET",
            headers,
          }),
          request({
            path: `${context.library.path}/deleted${sinceVersion === undefined ? "" : `?since=${sinceVersion}`}`,
            method: "GET",
            headers,
          }),
        ]);
      } catch {
        return unavailableSync(statusForTransportFailure(checkedAt, context.library), checkedAt, sinceVersion);
      }

      const failure = responses.find((response) => !isSuccessful(response.status) && response.status !== 304);
      if (failure) {
        return unavailableSync(statusForHttpFailure(failure, checkedAt, context.library), checkedAt, sinceVersion);
      }
      const [itemsResponse, collectionsResponse, deletedResponse] = responses;
      const itemVersions = itemsResponse?.status === 304 ? {} : parseVersions(itemsResponse?.body);
      const collectionVersions = collectionsResponse?.status === 304 ? {} : parseVersions(collectionsResponse?.body);
      const deleted = deletedResponse?.status === 304 ? emptyDeleted() : parseDeleted(deletedResponse?.body);
      const libraryVersion = maxDefined(
        ...responses.map(responseLibraryVersion),
        context.libraryVersion,
      );
      const retryAfter = maxDefined(...responses.map(retryAfterSeconds));
      const backoff = maxDefined(...responses.map(backoffSeconds));
      const unchanged = sinceVersion !== undefined
        && Object.keys(itemVersions).length === 0
        && Object.keys(collectionVersions).length === 0
        && deleted.items.length === 0
        && deleted.collections.length === 0
        && deleted.searches.length === 0;
      return {
        status: unchanged ? "unchanged" : "updated",
        checkedAt,
        provider: context.status,
        ...(sinceVersion !== undefined ? { sinceVersion } : {}),
        ...(libraryVersion !== undefined ? { libraryVersion } : {}),
        itemVersions,
        collectionVersions,
        deleted,
        ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
        ...(backoff !== undefined ? { backoffSeconds: backoff } : {}),
      };
    },
    createWritePlan,
    executeWritePlan,
  };
}

function normalizeConfig(value: ZoteroCloudSettings | undefined): ZoteroCloudSettings {
  const enabled = value?.enabled === true;
  const libraryType = value?.libraryType === "group" ? "group" : "user";
  const suppliedLibraryId = value?.libraryId;
  const libraryId = positiveId(suppliedLibraryId) ?? null;
  if (suppliedLibraryId !== null && suppliedLibraryId !== undefined && !libraryId) {
    throw new ZoteroCloudProviderError("Zotero cloud library ID must be a positive integer.");
  }
  if (enabled && libraryType === "group" && !libraryId) {
    throw new ZoteroCloudProviderError("A Zotero cloud group library requires a library ID.");
  }
  return { enabled, libraryType, libraryId };
}

function normalizePlanTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PLAN_TTL_MS;
  if (!Number.isFinite(value) || value < 0) {
    throw new ZoteroCloudProviderError("Zotero write plan TTL must be a non-negative number.");
  }
  return Math.floor(value);
}

function baseHeaders(): Record<string, string> {
  return { Accept: "application/json", "Zotero-API-Version": API_VERSION };
}

function assertRelativePath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new ZoteroCloudProviderError("Zotero cloud transport paths must be relative API paths.");
  }
}

function resolveLibrary(config: ZoteroCloudSettings, userId: string | undefined): ZoteroCloudLibrary | undefined {
  if (config.libraryType === "group") {
    if (!config.libraryId) return undefined;
    return { type: "group", id: config.libraryId, path: `/groups/${config.libraryId}` };
  }
  if (!userId) return undefined;
  return { type: "user", id: userId, path: `/users/${userId}` };
}

function libraryPermissions(accessValue: unknown, library: ZoteroCloudLibrary): { readable: boolean; writable: boolean } {
  const access = asRecord(accessValue);
  const root = library.type === "user"
    ? asRecord(access?.user)
    : groupAccess(asRecord(access?.groups), library.id);
  if (!root) return { readable: false, writable: false };
  if (root.library !== true) return { readable: false, writable: false };
  return { readable: true, writable: root.write === true };
}

function groupAccess(groups: Record<string, unknown> | undefined, libraryId: string): Record<string, unknown> | undefined {
  if (!groups) return undefined;
  return asRecord(groups[libraryId]) ?? asRecord(groups.all);
}

function statusFromResolvedContext(input: {
  library: ZoteroCloudLibrary;
  libraryVersion: number;
  writable: boolean;
  checkedAt: string;
  response: ZoteroCloudTransportResponse;
}): ZoteroCloudStatus {
  const retryAfter = retryAfterSeconds(input.response);
  const backoff = backoffSeconds(input.response);
  return {
    provider: "zotero-cloud",
    status: input.writable ? "ready" : "read_only",
    configured: true,
    available: true,
    writable: input.writable,
    checkedAt: input.checkedAt,
    library: input.library,
    libraryVersion: input.libraryVersion,
    ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
    ...(backoff !== undefined ? { backoffSeconds: backoff } : {}),
  };
}

function unconfiguredStatus(checkedAt: string): ZoteroCloudStatus {
  return {
    provider: "zotero-cloud",
    status: "unconfigured",
    configured: false,
    available: false,
    writable: false,
    checkedAt,
  };
}

function statusForTransportFailure(checkedAt: string, library?: ZoteroCloudLibrary): ZoteroCloudStatus {
  return {
    provider: "zotero-cloud",
    status: "offline",
    configured: true,
    available: false,
    writable: false,
    checkedAt,
    ...(library ? { library } : {}),
    error: "Unable to contact the Zotero Web API.",
  };
}

function statusForHttpFailure(
  response: ZoteroCloudTransportResponse,
  checkedAt: string,
  library?: ZoteroCloudLibrary,
): ZoteroCloudStatus {
  const status = response.status === 429 ? "rate_limited" : "error";
  return {
    provider: "zotero-cloud",
    status,
    configured: true,
    available: false,
    writable: false,
    checkedAt,
    ...(library ? { library } : {}),
    ...(retryAfterSeconds(response) !== undefined ? { retryAfterSeconds: retryAfterSeconds(response) } : {}),
    ...(backoffSeconds(response) !== undefined ? { backoffSeconds: backoffSeconds(response) } : {}),
    error: httpMessage(response.status),
  };
}

function errorStatus(checkedAt: string, error: string, library?: ZoteroCloudLibrary): ZoteroCloudStatus {
  return {
    provider: "zotero-cloud",
    status: "error",
    configured: true,
    available: false,
    writable: false,
    checkedAt,
    ...(library ? { library } : {}),
    error,
  };
}

function responseLibraryVersion(response: ZoteroCloudTransportResponse | undefined): number | undefined {
  if (!response) return undefined;
  const headerVersion = headerNumber(response.headers, "Last-Modified-Version");
  if (headerVersion !== undefined) return headerVersion;
  const versions = parseVersions(response.body);
  return maxDefined(...Object.values(versions));
}

function parseVersions(value: unknown): ZoteroCloudVersions {
  const raw = asRecord(value);
  if (!raw) return {};
  const versions: ZoteroCloudVersions = {};
  for (const [key, version] of Object.entries(raw)) {
    const parsed = nonNegativeVersion(version);
    if (parsed !== undefined && key.trim()) versions[key] = parsed;
  }
  return versions;
}

function emptyDeleted(): ZoteroCloudDeleted {
  return { items: [], collections: [], searches: [] };
}

function parseDeleted(value: unknown): ZoteroCloudDeleted {
  const raw = asRecord(value);
  return {
    items: stringArray(raw?.items),
    collections: stringArray(raw?.collections),
    searches: stringArray(raw?.searches),
  };
}

function unavailableSync(
  provider: ZoteroCloudStatus,
  checkedAt: string,
  sinceVersion: number | undefined,
): ZoteroCloudSyncResult {
  return {
    status: "unavailable",
    checkedAt,
    provider,
    ...(sinceVersion !== undefined ? { sinceVersion } : {}),
    itemVersions: {},
    collectionVersions: {},
    deleted: emptyDeleted(),
    ...(provider.retryAfterSeconds !== undefined ? { retryAfterSeconds: provider.retryAfterSeconds } : {}),
    ...(provider.backoffSeconds !== undefined ? { backoffSeconds: provider.backoffSeconds } : {}),
  };
}

function parseCloudItem(value: unknown): CloudItem | undefined {
  const raw = Array.isArray(value) ? asRecord(value[0]) : asRecord(value);
  if (!raw) return undefined;
  const data = asRecord(raw.data) ?? raw;
  const key = requireItemKeyOrUndefined(data.key ?? raw.key);
  const version = nonNegativeVersion(raw.version ?? data.version);
  const itemType = stringValue(data.itemType) ?? "item";
  if (!key || version === undefined) return undefined;
  return {
    key,
    version,
    itemType,
    tags: normalizeIncomingTags(data.tags),
    noteHtml: typeof data.note === "string" ? data.note : "",
  };
}

function applyTagOperation(existing: string[], requested: string[], operation: ZoteroCloudTagOperation): string[] {
  if (operation === "replace") return uniqueTags(requested);
  if (operation === "add") return uniqueTags([...existing, ...requested]);
  const remove = new Set(requested.map(tagIdentity));
  return uniqueTags(existing).filter((tag) => !remove.has(tagIdentity(tag)));
}

function sameTagSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left.map(tagIdentity));
  const rightSet = new Set(right.map(tagIdentity));
  return leftSet.size === rightSet.size && [...leftSet].every((tag) => rightSet.has(tag));
}

function tagConflict(
  plan: Extract<ZoteroCloudWritePlan, { kind: "tags" }>,
  latest: CloudItem | undefined,
  reason: "unsafe_rebase" | "retry_exhausted",
): ZoteroCloudWriteConflict {
  return {
    kind: "tags",
    itemKey: plan.itemKey,
    originalVersion: plan.itemVersion,
    ...(latest ? { currentVersion: latest.version } : {}),
    baseTags: plan.beforeTags,
    localTags: plan.afterTags,
    remoteTags: latest?.tags ?? [],
    reason,
  };
}

function normalizeTags(value: string[]): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS_PER_CHANGE) {
    throw new ZoteroCloudProviderError(`Zotero tag changes accept at most ${MAX_TAGS_PER_CHANGE} tags.`);
  }
  return uniqueTags(value.map((tag) => {
    if (typeof tag !== "string") throw new ZoteroCloudProviderError("Zotero tags must be text.");
    const normalized = tag.trim().normalize("NFC");
    if (!normalized || normalized.length > MAX_TAG_CHARS) {
      throw new ZoteroCloudProviderError(`Zotero tags must contain 1-${MAX_TAG_CHARS} characters.`);
    }
    return normalized;
  }));
}

function normalizeIncomingTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags = value
    .map((tag) => typeof tag === "string" ? tag : asRecord(tag)?.tag)
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim().normalize("NFC"))
    .filter(Boolean)
    .slice(0, MAX_TAGS_PER_CHANGE * 10);
  return uniqueTags(tags);
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tag of tags) {
    const key = tagIdentity(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(tag);
  }
  return unique;
}

function tagIdentity(tag: string): string {
  return tag.normalize("NFC").toLocaleLowerCase("en-US");
}

function requireItemKey(value: unknown): string {
  const key = requireItemKeyOrUndefined(value);
  if (!key) throw new ZoteroCloudProviderError("Zotero item keys must contain only letters and numbers.");
  return key;
}

function requireItemKeyOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9]{1,32}$/u.test(value.trim())
    ? value.trim().toUpperCase()
    : undefined;
}

function requirePlanId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new ZoteroCloudProviderError("Zotero write plans require a valid identifier.");
  }
  return value.trim();
}

function requireNoteHtml(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_NOTE_HTML_CHARS) {
    throw new ZoteroCloudProviderError(`Zotero note HTML must contain at most ${MAX_NOTE_HTML_CHARS} characters.`);
  }
  return value;
}

function clonePlan<T extends ZoteroCloudWritePlan>(plan: T): T {
  return JSON.parse(JSON.stringify(plan)) as T;
}

function resultFromWriteResponse(
  plan: ZoteroCloudWritePlan,
  response: ZoteroCloudTransportResponse,
  retryCount: 0 | 1,
  fallbackKey?: string,
): ZoteroCloudWriteResult {
  if (isSuccessful(response.status)) {
    const outcome = parseBatchOutcome(response.body, fallbackKey);
    const hasSuccess = outcome.successful.length > 0 || outcome.unchanged.length > 0;
    const hasFailure = outcome.failed.length > 0;
    return {
      planId: plan.planId,
      status: hasFailure && hasSuccess ? "partial" : hasFailure ? "error" : "succeeded",
      executed: true,
      ...(responseLibraryVersion(response) !== undefined ? { libraryVersion: responseLibraryVersion(response) } : {}),
      successful: outcome.successful,
      unchanged: outcome.unchanged,
      failed: outcome.failed,
      retryCount,
      ...(retryAfterSeconds(response) !== undefined ? { retryAfterSeconds: retryAfterSeconds(response) } : {}),
      ...(backoffSeconds(response) !== undefined ? { backoffSeconds: backoffSeconds(response) } : {}),
    };
  }
  if (response.status === 412) {
    return failedResult(plan.planId, "conflict", "Zotero rejected the write because the remote item changed.", retryCount, response);
  }
  return failedResult(plan.planId, writeStatus(response.status), httpMessage(response.status), retryCount, response);
}

function parseBatchOutcome(value: unknown, fallbackKey?: string): BatchOutcome {
  const raw = asRecord(value);
  const successful = parseBatchEntries(raw?.successful ?? raw?.success, fallbackKey);
  const unchanged = parseBatchEntries(raw?.unchanged, fallbackKey);
  const failed = parseFailures(raw?.failed);
  if (successful.length === 0 && unchanged.length === 0 && failed.length === 0) {
    return { successful: [{ index: 0, ...(fallbackKey ? { key: fallbackKey } : {}) }], unchanged: [], failed: [] };
  }
  return { successful, unchanged, failed };
}

function parseBatchEntries(value: unknown, fallbackKey?: string): ZoteroCloudBatchWriteSuccess[] {
  const raw = asRecord(value);
  if (!raw) return [];
  return Object.entries(raw).flatMap(([index, entry]) => {
    const parsedIndex = Number(index);
    if (!Number.isSafeInteger(parsedIndex) || parsedIndex < 0) return [];
    const record = asRecord(entry);
    const key = requireItemKeyOrUndefined(record?.key ?? entry) ?? fallbackKey;
    const version = nonNegativeVersion(record?.version);
    return [{ index: parsedIndex, ...(key ? { key } : {}), ...(version !== undefined ? { version } : {}) }];
  });
}

function parseFailures(value: unknown): ZoteroCloudBatchWriteFailure[] {
  const raw = asRecord(value);
  if (!raw) return [];
  return Object.entries(raw).flatMap(([index, entry]) => {
    const parsedIndex = Number(index);
    if (!Number.isSafeInteger(parsedIndex) || parsedIndex < 0) return [];
    const record = asRecord(entry);
    return [{
      index: parsedIndex,
      ...(typeof record?.code === "number" ? { code: record.code } : {}),
      ...(requireItemKeyOrUndefined(record?.key) ? { key: requireItemKeyOrUndefined(record?.key) } : {}),
      message: safeMessage(record?.message ?? entry),
    }];
  });
}

function confirmationRequired(planId: string): ZoteroCloudWriteResult {
  return {
    planId,
    status: "confirmation_required",
    executed: false,
    successful: [],
    unchanged: [],
    failed: [],
    retryCount: 0,
  };
}

function conflictResult(
  planId: string,
  conflict: ZoteroCloudWriteConflict,
  retryCount: 0 | 1,
  response?: ZoteroCloudTransportResponse,
): ZoteroCloudWriteResult {
  return {
    planId,
    status: "conflict",
    executed: true,
    ...(responseLibraryVersion(response) !== undefined ? { libraryVersion: responseLibraryVersion(response!) } : {}),
    successful: [],
    unchanged: [],
    failed: [],
    retryCount,
    conflict,
    ...(response && retryAfterSeconds(response) !== undefined ? { retryAfterSeconds: retryAfterSeconds(response) } : {}),
    ...(response && backoffSeconds(response) !== undefined ? { backoffSeconds: backoffSeconds(response) } : {}),
  };
}

function failedResult(
  planId: string,
  status: Exclude<ZoteroCloudWriteResult["status"], "confirmation_required" | "succeeded" | "partial">,
  error: string,
  retryCount: 0 | 1 = 0,
  response?: ZoteroCloudTransportResponse,
): ZoteroCloudWriteResult {
  return {
    planId,
    status,
    executed: status !== "error" || Boolean(response),
    ...(response && responseLibraryVersion(response) !== undefined ? { libraryVersion: responseLibraryVersion(response) } : {}),
    successful: [],
    unchanged: [],
    failed: [],
    retryCount,
    error: safeMessage(error),
    ...(response && retryAfterSeconds(response) !== undefined ? { retryAfterSeconds: retryAfterSeconds(response) } : {}),
    ...(response && backoffSeconds(response) !== undefined ? { backoffSeconds: backoffSeconds(response) } : {}),
  };
}

function writeStatus(status: number): Exclude<ZoteroCloudWriteResult["status"], "confirmation_required" | "succeeded" | "partial"> {
  switch (status) {
    case 403: return "forbidden";
    case 404: return "not_found";
    case 409: return "locked";
    case 412: return "conflict";
    case 428: return "precondition_required";
    case 429: return "rate_limited";
    default: return "error";
  }
}

function isSuccessful(status: number): boolean {
  return status >= 200 && status < 300;
}

function httpMessage(status: number): string {
  switch (status) {
    case 403: return "Zotero rejected this credential or library permission.";
    case 404: return "The requested Zotero resource no longer exists.";
    case 409: return "Zotero has temporarily locked this library.";
    case 412: return "The Zotero resource changed after this plan was prepared.";
    case 428: return "Zotero requires a version precondition for this write.";
    case 429: return "Zotero is rate limiting requests.";
    default: return `Zotero Web API returned HTTP ${status}.`;
  }
}

function headerNumber(headers: ZoteroCloudTransportResponse["headers"], name: string): number | undefined {
  const value = headerValue(headers, name);
  return value ? nonNegativeVersion(value) : undefined;
}

function headerValue(headers: ZoteroCloudTransportResponse["headers"], name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | undefined>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? record[key] : undefined;
}

function retryAfterSeconds(response: ZoteroCloudTransportResponse | undefined): number | undefined {
  return response ? headerNumber(response.headers, "Retry-After") : undefined;
}

function backoffSeconds(response: ZoteroCloudTransportResponse | undefined): number | undefined {
  return response ? headerNumber(response.headers, "Backoff") : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[1-9]\d*$/u.test(normalized) ? normalized : undefined;
}

function nonNegativeVersion(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.max(...defined) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeMessage(value: unknown): string {
  const text = typeof value === "string" ? value : "Zotero Web API rejected the requested operation.";
  return text
    .replace(/(zotero-api-key\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .slice(0, 400);
}
