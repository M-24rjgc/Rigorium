import {
  appendProjectResearchArtifacts,
  getLatestProjectResearchArtifact,
  getProjectResearchArtifact,
  getProjectResearchArtifactHistory,
  invalidateProjectResearchArtifactDescendants,
  listLatestProjectResearchArtifacts,
  loadProjectResearchArtifactRepository,
  ResearchArtifactRepositoryError,
  type ProjectResearchArtifactSnapshot,
} from "../../research/artifacts/repository.js";
import {
  canonicalJson,
  createResearchArtifact,
  RESEARCH_ARTIFACT_KINDS,
  type ResearchArtifactEnvelope,
  type ResearchArtifactInvalidation,
  type ResearchArtifactKind,
  type ResearchArtifactParent,
  type ResearchArtifactProducer,
  type ResearchArtifactRef,
  type ResearchArtifactSource,
  type ResearchArtifactStatus,
} from "../../research/artifacts/types.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";

export const RESEARCH_ARTIFACT_OPERATIONS = [
  "append_batch",
  "get",
  "latest",
  "history",
  "list",
  "invalidate_descendants",
] as const;

const RESEARCH_ARTIFACT_STATUSES = ["active", "stale", "superseded", "rejected", "archived"] as const;
const INVALIDATION_REASONS = ["upstream_changed", "evidence_withdrawn", "run_failed", "review_finding", "manual"] as const;

export type ResearchArtifactOperation = typeof RESEARCH_ARTIFACT_OPERATIONS[number];

export type ResearchArtifactsToolInput =
  | Readonly<{
    operation: "append_batch";
    artifacts: readonly ResearchArtifactEnvelope[];
    expectedRepositoryRevision?: number;
  }>
  | Readonly<{
    operation: "get";
    artifactId: string;
    revision: number;
  }>
  | Readonly<{
    operation: "latest" | "history";
    artifactId: string;
  }>
  | Readonly<{
    operation: "list";
    kind?: ResearchArtifactKind;
    status?: ResearchArtifactStatus;
  }>
  | Readonly<{
    operation: "invalidate_descendants";
    roots: readonly ResearchArtifactRef[];
    reason: ResearchArtifactInvalidation["reason"];
    expectedRepositoryRevision?: number;
  }>;

export type ResearchArtifactRepositorySummary = Readonly<{
  path: string;
  repositoryId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  artifactCount: number;
  latestArtifactCount: number;
}>;

export type ResearchArtifactsToolOutput = Readonly<{
  operation: ResearchArtifactOperation;
  projectRoot: string;
  repository: ResearchArtifactRepositorySummary | null;
  artifact?: ResearchArtifactEnvelope;
  artifacts?: readonly ResearchArtifactEnvelope[];
  appendedRefs?: readonly ResearchArtifactRef[];
  idempotentRefs?: readonly ResearchArtifactRef[];
  supersededRefs?: readonly ResearchArtifactRef[];
  roots?: readonly ResearchArtifactRef[];
  staleRefs?: readonly ResearchArtifactRef[];
  persisted?: boolean;
}>;

export type CreateResearchArtifactsToolOptions = Readonly<{
  maxResultBytes?: number;
}>;

/**
 * Project-local persistence for immutable research artifact envelopes. The
 * repository itself owns locking, integrity checks, and append-only status
 * history; this tool only fixes its root to the active runtime Project.
 */
export function createResearchArtifactsTool(
  options: CreateResearchArtifactsToolOptions = {},
): RigoriumToolDefinition<ResearchArtifactsToolInput, ResearchArtifactsToolOutput> {
  return {
    name: "research_artifacts",
    title: "Persist and Query Research Artifacts",
    description: `Persist immutable research artifact envelopes to the current Project, retrieve a specific or latest revision, inspect revision history and latest artifacts, or append descendant invalidation events.

The Project root is always the tool runtime cwd and cannot be supplied by the caller. append_batch and invalidate_descendants are Project-local append-only repository updates, not network, export, shell, or destructive actions. They preserve the repository's 64 MiB bound, immutable-envelope hashes, revision checks, project isolation, and lock handling. get, latest, history, and list are read-only.`,
    kind: "custom",
    inputSchema: researchArtifactsInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 4_000_000,
    isReadOnly: (input) => isReadOperation(input.operation),
    isConcurrencySafe: (input) => isReadOperation(input.operation),
    isDestructive: () => false,
    requiresUserInteraction: () => false,
    isOpenWorld: () => false,
    validateInput: async (input) => validateInput(input),
    execute: async (input, context) => {
      try {
        return formatOutput(await executeOperation(normalizeInput(input), context));
      } catch (error) {
        throw mapResearchArtifactError(error);
      }
    },
  };
}

async function executeOperation(
  input: ResearchArtifactsToolInput,
  context: RigoriumToolRuntimeContext,
): Promise<ResearchArtifactsToolOutput> {
  const projectRoot = context.cwd;
  const now = context.now?.();

  switch (input.operation) {
    case "append_batch": {
      const result = await appendProjectResearchArtifacts({
        projectRoot,
        artifacts: input.artifacts,
        ...(input.expectedRepositoryRevision === undefined
          ? {}
          : { expectedRepositoryRevision: input.expectedRepositoryRevision }),
        ...(now === undefined ? {} : { now }),
      });
      return Object.freeze({
        operation: input.operation,
        projectRoot,
        repository: summarizeSnapshot(result.snapshot),
        appendedRefs: result.appendedRefs,
        idempotentRefs: result.idempotentRefs,
        supersededRefs: result.supersededRefs,
        staleRefs: result.staleRefs,
        persisted: result.persisted,
      });
    }
    case "get": {
      const artifact = await getProjectResearchArtifact({
        projectRoot,
        artifactId: input.artifactId,
        revision: input.revision,
      });
      return Object.freeze({
        operation: input.operation,
        projectRoot,
        repository: await currentRepositorySummary(projectRoot),
        ...(artifact === undefined ? {} : { artifact }),
      });
    }
    case "latest": {
      const artifact = await getLatestProjectResearchArtifact({ projectRoot, artifactId: input.artifactId });
      return Object.freeze({
        operation: input.operation,
        projectRoot,
        repository: await currentRepositorySummary(projectRoot),
        ...(artifact === undefined ? {} : { artifact }),
      });
    }
    case "history": {
      const artifacts = await getProjectResearchArtifactHistory({ projectRoot, artifactId: input.artifactId });
      return Object.freeze({
        operation: input.operation,
        projectRoot,
        repository: await currentRepositorySummary(projectRoot),
        artifacts,
      });
    }
    case "list": {
      const artifacts = await listLatestProjectResearchArtifacts({
        projectRoot,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.status === undefined ? {} : { status: input.status }),
      });
      return Object.freeze({
        operation: input.operation,
        projectRoot,
        repository: await currentRepositorySummary(projectRoot),
        artifacts,
      });
    }
    case "invalidate_descendants": {
      const result = await invalidateProjectResearchArtifactDescendants({
        projectRoot,
        roots: input.roots,
        reason: input.reason,
        ...(input.expectedRepositoryRevision === undefined
          ? {}
          : { expectedRepositoryRevision: input.expectedRepositoryRevision }),
        ...(now === undefined ? {} : { now }),
      });
      return Object.freeze({
        operation: input.operation,
        projectRoot,
        repository: summarizeSnapshot(result.snapshot),
        roots: result.roots,
        staleRefs: result.staleRefs,
        persisted: result.persisted,
      });
    }
  }
}

async function currentRepositorySummary(projectRoot: string): Promise<ResearchArtifactRepositorySummary | null> {
  return summarizeSnapshot(await loadProjectResearchArtifactRepository({ projectRoot }));
}

function summarizeSnapshot(
  snapshot: ProjectResearchArtifactSnapshot | undefined,
): ResearchArtifactRepositorySummary | null {
  if (snapshot === undefined) return null;
  return Object.freeze({
    path: snapshot.path,
    repositoryId: snapshot.repositoryId,
    revision: snapshot.revision,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    contentHash: snapshot.contentHash,
    artifactCount: snapshot.artifacts.length,
    latestArtifactCount: new Set(snapshot.artifacts.map((artifact) => artifact.artifactId)).size,
  });
}

function validateInput(input: unknown): RigoriumToolValidationResult {
  try {
    normalizeInput(input);
    return { ok: true, input };
  } catch (error) {
    const issue: RigoriumToolValidationIssue = {
      path: "$",
      code: "invalid_schema",
      message: messageOf(error),
    };
    return { ok: false, issues: [issue] };
  }
}

function normalizeInput(value: unknown): ResearchArtifactsToolInput {
  if (!isRecord(value)) throw new TypeError("research_artifacts input must be an object.");
  const allowedKeys = [
    "operation",
    "artifacts",
    "expectedRepositoryRevision",
    "artifactId",
    "revision",
    "kind",
    "status",
    "roots",
    "reason",
  ];
  assertAllowedKeys(value, allowedKeys, "research_artifacts");
  if (!(RESEARCH_ARTIFACT_OPERATIONS as readonly string[]).includes(String(value.operation))) {
    throw new TypeError(`operation must be one of: ${RESEARCH_ARTIFACT_OPERATIONS.join(", ")}.`);
  }

  switch (value.operation as ResearchArtifactOperation) {
    case "append_batch": {
      assertAllowedKeys(value, ["operation", "artifacts", "expectedRepositoryRevision"], "operation=append_batch");
      if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
        throw new TypeError("operation=append_batch requires a non-empty artifacts array.");
      }
      const artifacts = value.artifacts.map((artifact, index) => normalizeArtifactEnvelope(artifact, `artifacts[${index}]`));
      const expectedRepositoryRevision = optionalRepositoryRevision(value.expectedRepositoryRevision);
      return expectedRepositoryRevision === undefined
        ? Object.freeze({ operation: "append_batch" as const, artifacts: Object.freeze(artifacts) })
        : Object.freeze({ operation: "append_batch" as const, artifacts: Object.freeze(artifacts), expectedRepositoryRevision });
    }
    case "get": {
      assertAllowedKeys(value, ["operation", "artifactId", "revision"], "operation=get");
      return Object.freeze({
        operation: "get" as const,
        artifactId: requireIdentifier(value.artifactId, "artifactId"),
        revision: requirePositiveInteger(value.revision, "revision"),
      });
    }
    case "latest":
    case "history": {
      assertAllowedKeys(value, ["operation", "artifactId"], `operation=${value.operation}`);
      return Object.freeze({
        operation: value.operation as "latest" | "history",
        artifactId: requireIdentifier(value.artifactId, "artifactId"),
      });
    }
    case "list": {
      assertAllowedKeys(value, ["operation", "kind", "status"], "operation=list");
      const kind = value.kind === undefined ? undefined : requireArtifactKind(value.kind, "kind");
      const status = value.status === undefined ? undefined : requireArtifactStatus(value.status, "status");
      return Object.freeze({
        operation: "list" as const,
        ...(kind === undefined ? {} : { kind }),
        ...(status === undefined ? {} : { status }),
      });
    }
    case "invalidate_descendants": {
      assertAllowedKeys(value, ["operation", "roots", "reason", "expectedRepositoryRevision"], "operation=invalidate_descendants");
      if (!Array.isArray(value.roots) || value.roots.length === 0) {
        throw new TypeError("operation=invalidate_descendants requires a non-empty roots array.");
      }
      const roots = value.roots.map((root, index) => normalizeArtifactRef(root, `roots[${index}]`));
      const reason = requireInvalidationReason(value.reason, "reason");
      const expectedRepositoryRevision = optionalRepositoryRevision(value.expectedRepositoryRevision);
      return expectedRepositoryRevision === undefined
        ? Object.freeze({ operation: "invalidate_descendants" as const, roots: Object.freeze(roots), reason })
        : Object.freeze({
            operation: "invalidate_descendants" as const,
            roots: Object.freeze(roots),
            reason,
            expectedRepositoryRevision,
          });
    }
  }
}

function normalizeArtifactEnvelope(value: unknown, label: string): ResearchArtifactEnvelope {
  if (!isRecord(value)) throw new TypeError(`${label} must be an artifact envelope object.`);
  const requiredKeys = [
    "schemaVersion",
    "artifactId",
    "revision",
    "kind",
    "status",
    "createdAt",
    "updatedAt",
    "contentHash",
    "producer",
    "parents",
    "sources",
    "payload",
  ];
  assertRequiredKeys(value, requiredKeys, label);
  assertAllowedKeys(value, [...requiredKeys, "invalidation"], label);
  if (value.schemaVersion !== 1) throw new TypeError(`${label}.schemaVersion must be 1.`);
  const artifactId = requireIdentifier(value.artifactId, `${label}.artifactId`);
  const revision = requirePositiveInteger(value.revision, `${label}.revision`);
  const kind = requireArtifactKind(value.kind, `${label}.kind`);
  const status = requireArtifactStatus(value.status, `${label}.status`);
  const createdAt = requireIsoDate(value.createdAt, `${label}.createdAt`);
  const updatedAt = requireIsoDate(value.updatedAt, `${label}.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new TypeError(`${label}.updatedAt must not precede createdAt.`);
  }
  if (!isRecord(value.producer)) throw new TypeError(`${label}.producer must be an object.`);
  if (!Array.isArray(value.parents) || !Array.isArray(value.sources)) {
    throw new TypeError(`${label}.parents and ${label}.sources must be arrays.`);
  }
  const contentHash = requireHash(value.contentHash, `${label}.contentHash`);
  const envelope = value as unknown as ResearchArtifactEnvelope;
  const payload = cloneCanonicalJson(envelope.payload, `${label}.payload`);
  const rebuilt = createResearchArtifact({
    kind,
    artifactId,
    revision,
    status,
    producer: envelope.producer as ResearchArtifactProducer,
    parents: envelope.parents as ResearchArtifactParent[],
    sources: envelope.sources as ResearchArtifactSource[],
    payload,
    now: new Date(createdAt),
  });
  if (rebuilt.contentHash !== contentHash) {
    throw new TypeError(`${label}.contentHash does not match its canonical immutable content.`);
  }
  const invalidation = value.invalidation === undefined
    ? undefined
    : normalizeInvalidation(value.invalidation, status, createdAt, updatedAt, `${label}.invalidation`);
  const normalized = Object.freeze({
    ...rebuilt,
    createdAt,
    updatedAt,
    contentHash,
    payload,
    ...(invalidation === undefined ? {} : { invalidation }),
  }) as ResearchArtifactEnvelope;
  if (canonicalJson(value) !== canonicalJson(normalized)) {
    throw new TypeError(`${label} contains unknown or non-canonical fields.`);
  }
  return normalized;
}

function normalizeInvalidation(
  value: unknown,
  status: ResearchArtifactStatus,
  createdAt: string,
  updatedAt: string,
  label: string,
): ResearchArtifactInvalidation {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  assertRequiredKeys(value, ["invalidatedAt", "reason", "roots"], label);
  assertAllowedKeys(value, ["invalidatedAt", "reason", "roots"], label);
  if (status !== "stale") throw new TypeError(`${label} is allowed only for a stale artifact.`);
  const invalidatedAt = requireIsoDate(value.invalidatedAt, `${label}.invalidatedAt`);
  if (Date.parse(invalidatedAt) < Date.parse(createdAt) || Date.parse(invalidatedAt) > Date.parse(updatedAt)) {
    throw new TypeError(`${label}.invalidatedAt must fall between createdAt and updatedAt.`);
  }
  const reason = requireInvalidationReason(value.reason, `${label}.reason`);
  if (!Array.isArray(value.roots) || value.roots.length === 0) {
    throw new TypeError(`${label}.roots must be a non-empty array.`);
  }
  const roots = uniqueArtifactRefs(value.roots.map((root, index) => normalizeArtifactRef(root, `${label}.roots[${index}]`)));
  return Object.freeze({ invalidatedAt, reason, roots });
}

function normalizeArtifactRef(value: unknown, label: string): ResearchArtifactRef {
  if (!isRecord(value)) throw new TypeError(`${label} must be an artifact reference object.`);
  assertRequiredKeys(value, ["artifactId", "revision", "kind", "contentHash"], label);
  assertAllowedKeys(value, ["artifactId", "revision", "kind", "contentHash"], label);
  return Object.freeze({
    artifactId: requireIdentifier(value.artifactId, `${label}.artifactId`),
    revision: requirePositiveInteger(value.revision, `${label}.revision`),
    kind: requireArtifactKind(value.kind, `${label}.kind`),
    contentHash: requireHash(value.contentHash, `${label}.contentHash`),
  });
}

function researchArtifactsInputSchema() {
  return {
    type: "object" as const,
    additionalProperties: false,
    required: ["operation"],
    properties: {
      operation: { type: "string", enum: [...RESEARCH_ARTIFACT_OPERATIONS] },
      artifacts: { type: "array", minItems: 1, items: { type: "object" } },
      expectedRepositoryRevision: { type: "integer", minimum: 0 },
      artifactId: { type: "string" },
      revision: { type: "integer", minimum: 1 },
      kind: { type: "string", enum: [...RESEARCH_ARTIFACT_KINDS] },
      status: { type: "string", enum: [...RESEARCH_ARTIFACT_STATUSES] },
      roots: { type: "array", minItems: 1, items: { type: "object" } },
      reason: { type: "string", enum: [...INVALIDATION_REASONS] },
    },
  };
}

function formatOutput(data: ResearchArtifactsToolOutput): RigoriumToolExecutionOutput<ResearchArtifactsToolOutput> {
  const lines = [
    `Research artifact operation: ${data.operation}`,
    `Project: ${data.projectRoot}`,
    `Repository revision: ${data.repository?.revision ?? "none"}`,
    `Artifacts: ${data.repository?.artifactCount ?? 0}`,
    ...(data.artifact === undefined ? [] : [`Artifact: ${data.artifact.kind} ${data.artifact.artifactId}@${data.artifact.revision}`]),
    ...(data.artifacts === undefined ? [] : [`Returned artifacts: ${data.artifacts.length}`]),
    ...(data.appendedRefs === undefined ? [] : [`Appended: ${data.appendedRefs.length}`]),
    ...(data.idempotentRefs === undefined ? [] : [`Idempotent: ${data.idempotentRefs.length}`]),
    ...(data.staleRefs === undefined ? [] : [`Stale descendants: ${data.staleRefs.length}`]),
    ...(data.persisted === undefined ? [] : [`Persisted: ${data.persisted}`]),
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }, { type: "json", value: data }],
    data,
    metadata: {
      operation: data.operation,
      projectRoot: data.projectRoot,
      repositoryRevision: data.repository?.revision,
      artifactCount: data.repository?.artifactCount ?? 0,
      returnedArtifactCount: data.artifacts?.length,
      artifactId: data.artifact?.artifactId,
      artifactRevision: data.artifact?.revision,
      appendedCount: data.appendedRefs?.length,
      idempotentCount: data.idempotentRefs?.length,
      staleCount: data.staleRefs?.length,
      persisted: data.persisted,
      projectLocalAppendOnly: data.operation === "append_batch" || data.operation === "invalidate_descendants",
    },
  };
}

function mapResearchArtifactError(error: unknown): RigoriumToolRuntimeError {
  if (error instanceof RigoriumToolRuntimeError) return error;
  if (error instanceof ResearchArtifactRepositoryError) {
    const details = { diagnostic: error.diagnostic };
    if (error.code === "path_violation") return new RigoriumToolRuntimeError("path_not_allowed", error.message, details);
    if (error.code === "revision_conflict" || error.code === "repository_busy") {
      return new RigoriumToolRuntimeError("file_conflict", error.message, details);
    }
    if (["invalid_input", "invalid_project_root", "invalid_schema", "integrity_mismatch", "artifact_conflict", "missing_parent"].includes(error.code)) {
      return new RigoriumToolRuntimeError("invalid_tool_input", error.message, details);
    }
    return new RigoriumToolRuntimeError("tool_execution_failed", error.message, details);
  }
  if (error instanceof TypeError) return new RigoriumToolRuntimeError("invalid_tool_input", error.message);
  return new RigoriumToolRuntimeError("tool_execution_failed", `Research artifact operation failed: ${messageOf(error)}`);
}

function isReadOperation(operation: ResearchArtifactOperation): boolean {
  return operation === "get" || operation === "latest" || operation === "history" || operation === "list";
}

function assertAllowedKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} does not accept ${key}; project storage is fixed to the current cwd.`);
    }
  }
}

function assertRequiredKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (!(key in value)) throw new TypeError(`${label}.${key} is required.`);
  }
}

function optionalRepositoryRevision(value: unknown): number | undefined {
  return value === undefined ? undefined : requireRepositoryRevision(value, "expectedRepositoryRevision");
}

function requireRepositoryRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${label} must be a positive integer.`);
  return value as number;
}

function requireArtifactKind(value: unknown, label: string): ResearchArtifactKind {
  if (typeof value !== "string" || !(RESEARCH_ARTIFACT_KINDS as readonly string[]).includes(value)) {
    throw new TypeError(`${label} must be a supported research artifact kind.`);
  }
  return value as ResearchArtifactKind;
}

function requireArtifactStatus(value: unknown, label: string): ResearchArtifactStatus {
  if (typeof value !== "string" || !(RESEARCH_ARTIFACT_STATUSES as readonly string[]).includes(value)) {
    throw new TypeError(`${label} must be a supported research artifact status.`);
  }
  return value as ResearchArtifactStatus;
}

function requireInvalidationReason(value: unknown, label: string): ResearchArtifactInvalidation["reason"] {
  if (typeof value !== "string" || !(INVALIDATION_REASONS as readonly string[]).includes(value)) {
    throw new TypeError(`${label} must be a supported invalidation reason.`);
  }
  return value as ResearchArtifactInvalidation["reason"];
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new TypeError(`${label} must be a safe identifier no longer than 256 characters.`);
  }
  return value;
}

function requireIsoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError(`${label} must be an ISO date.`);
  return new Date(Date.parse(value)).toISOString();
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 content hash.`);
  }
  return value;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneCanonicalJson(value: unknown, label: string): unknown {
  try {
    return JSON.parse(canonicalJson(value)) as unknown;
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON: ${messageOf(error)}`);
  }
}

function uniqueArtifactRefs(refs: readonly ResearchArtifactRef[]): ResearchArtifactRef[] {
  const byKey = new Map<string, ResearchArtifactRef>();
  for (const ref of refs) byKey.set(artifactRefKey(ref), ref);
  return [...byKey.values()].sort((left, right) => artifactRefKey(left).localeCompare(artifactRefKey(right), "en"));
}

function artifactRefKey(ref: ResearchArtifactRef): string {
  return `${ref.kind}:${ref.artifactId}@${ref.revision}:${ref.contentHash}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
