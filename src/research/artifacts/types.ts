import { createHash, randomUUID } from "node:crypto";

export const RESEARCH_ARTIFACT_SCHEMA_VERSION = 1 as const;

/** Stable envelope kind for versioned literature novelty/value rescan results. */
export const LITERATURE_NOVELTY_RESCAN_ARTIFACT_KIND = "literature_novelty_rescan" as const;

export const RESEARCH_ARTIFACT_KINDS = [
  "evidence_pack",
  "candidate_portfolio",
  LITERATURE_NOVELTY_RESCAN_ARTIFACT_KIND,
  "challenge_report",
  "decision_record",
  "research_brief",
  "method_spec",
  "implementation_snapshot",
  "experiment_spec",
  "execution_grant",
  "run_attempt",
  "baseline_observation",
  "metric_observation",
  "figure_table",
  "citation_set",
  "manuscript_version",
  "render_run",
  "review_round",
  "finding",
  "revision_decision",
] as const;

export type ResearchArtifactKind = typeof RESEARCH_ARTIFACT_KINDS[number];
export type ResearchArtifactStatus = "active" | "stale" | "superseded" | "rejected" | "archived";
export type ResearchArtifactRelation = "derived_from" | "uses" | "supports" | "challenges" | "supersedes";

export type ResearchArtifactRef = Readonly<{
  artifactId: string;
  revision: number;
  kind: ResearchArtifactKind;
  contentHash: string;
}>;

export type ResearchArtifactParent = Readonly<{
  relation: ResearchArtifactRelation;
  artifact: ResearchArtifactRef;
}>;

export type ResearchArtifactProducer = Readonly<{
  kind: "user" | "agent" | "tool" | "import";
  id?: string;
  toolName?: string;
}>;

export type ResearchArtifactSource = Readonly<{
  sourceId: string;
  recordId?: string;
  locator?: string;
  retrievedAt?: string;
  contentHash?: string;
}>;

export type ResearchArtifactInvalidation = Readonly<{
  invalidatedAt: string;
  reason: "upstream_changed" | "evidence_withdrawn" | "run_failed" | "review_finding" | "manual";
  roots: ResearchArtifactRef[];
}>;

export type ResearchArtifactEnvelope<
  TKind extends ResearchArtifactKind = ResearchArtifactKind,
  TPayload = unknown,
> = Readonly<{
  schemaVersion: 1;
  artifactId: string;
  revision: number;
  kind: TKind;
  status: ResearchArtifactStatus;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  producer: ResearchArtifactProducer;
  parents: ResearchArtifactParent[];
  sources: ResearchArtifactSource[];
  invalidation?: ResearchArtifactInvalidation;
  payload: TPayload;
}>;

export type CreateResearchArtifactInput<
  TKind extends ResearchArtifactKind,
  TPayload,
> = Readonly<{
  kind: TKind;
  payload: TPayload;
  producer: ResearchArtifactProducer;
  parents?: readonly ResearchArtifactParent[];
  sources?: readonly ResearchArtifactSource[];
  artifactId?: string;
  revision?: number;
  status?: ResearchArtifactStatus;
  now?: Date;
}>;

export function createResearchArtifact<
  TKind extends ResearchArtifactKind,
  TPayload,
>(input: CreateResearchArtifactInput<TKind, TPayload>): ResearchArtifactEnvelope<TKind, TPayload> {
  const artifactId = requireIdentifier(input.artifactId ?? `${input.kind}-${randomUUID()}`, "artifactId");
  const revision = requirePositiveInteger(input.revision ?? 1, "revision");
  const now = (input.now ?? new Date()).toISOString();
  const parents = normalizeParents(input.parents ?? []);
  const sources = normalizeSources(input.sources ?? []);
  const status = input.status ?? "active";
  assertArtifactStatus(status);
  const producer = normalizeProducer(input.producer);
  const contentHash = hashResearchArtifactContent({
    artifactId,
    revision,
    kind: input.kind,
    parents,
    sources,
    payload: input.payload,
  });

  return Object.freeze({
    schemaVersion: RESEARCH_ARTIFACT_SCHEMA_VERSION,
    artifactId,
    revision,
    kind: input.kind,
    status,
    createdAt: now,
    updatedAt: now,
    contentHash,
    producer,
    parents,
    sources,
    payload: input.payload,
  });
}

export function toResearchArtifactRef(artifact: ResearchArtifactEnvelope): ResearchArtifactRef {
  return Object.freeze({
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    kind: artifact.kind,
    contentHash: artifact.contentHash,
  });
}

export function researchArtifactKey(value: Pick<ResearchArtifactRef, "artifactId" | "revision">): string {
  return `${value.artifactId}@${value.revision}`;
}

export function hashResearchArtifactContent(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set<object>());
}

function serializeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Research artifact content cannot contain non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    assertNoCycle(value, ancestors);
    const next = new Set(ancestors).add(value);
    return `[${value.map((entry) => serializeCanonical(entry, next)).join(",")}]`;
  }
  if (isRecord(value)) {
    assertNoCycle(value, ancestors);
    const next = new Set(ancestors).add(value);
    const entries = Object.keys(value)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => {
        const entry = value[key];
        if (entry === undefined) throw new TypeError("Research artifact content cannot contain undefined values.");
        return `${JSON.stringify(key)}:${serializeCanonical(entry, next)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Research artifact content cannot contain ${typeof value} values.`);
}

function normalizeParents(value: readonly ResearchArtifactParent[]): ResearchArtifactParent[] {
  const seen = new Set<string>();
  return value.map((parent) => {
    if (!parent || typeof parent !== "object") throw new TypeError("Artifact parents must be objects.");
    assertRelation(parent.relation);
    const artifact = normalizeRef(parent.artifact);
    const identity = `${parent.relation}:${researchArtifactKey(artifact)}`;
    if (seen.has(identity)) throw new TypeError(`Artifact parent ${identity} is duplicated.`);
    seen.add(identity);
    return Object.freeze({ relation: parent.relation, artifact });
  });
}

function normalizeSources(value: readonly ResearchArtifactSource[]): ResearchArtifactSource[] {
  return value.map((source) => {
    if (!source || typeof source !== "object") throw new TypeError("Artifact sources must be objects.");
    return Object.freeze({
      sourceId: requireIdentifier(source.sourceId, "source.sourceId"),
      ...(source.recordId === undefined ? {} : { recordId: requireText(source.recordId, "source.recordId") }),
      ...(source.locator === undefined ? {} : { locator: requireText(source.locator, "source.locator") }),
      ...(source.retrievedAt === undefined ? {} : { retrievedAt: requireIsoDate(source.retrievedAt, "source.retrievedAt") }),
      ...(source.contentHash === undefined ? {} : { contentHash: requireHash(source.contentHash, "source.contentHash") }),
    });
  });
}

function normalizeProducer(value: ResearchArtifactProducer): ResearchArtifactProducer {
  if (!value || typeof value !== "object" || !["user", "agent", "tool", "import"].includes(value.kind)) {
    throw new TypeError("Artifact producer kind is invalid.");
  }
  return Object.freeze({
    kind: value.kind,
    ...(value.id === undefined ? {} : { id: requireText(value.id, "producer.id") }),
    ...(value.toolName === undefined ? {} : { toolName: requireText(value.toolName, "producer.toolName") }),
  });
}

function normalizeRef(value: ResearchArtifactRef): ResearchArtifactRef {
  if (!value || typeof value !== "object") throw new TypeError("Artifact reference must be an object.");
  assertArtifactKind(value.kind);
  return Object.freeze({
    artifactId: requireIdentifier(value.artifactId, "artifact reference ID"),
    revision: requirePositiveInteger(value.revision, "artifact reference revision"),
    kind: value.kind,
    contentHash: requireHash(value.contentHash, "artifact reference contentHash"),
  });
}

function assertArtifactKind(value: string): asserts value is ResearchArtifactKind {
  if (!(RESEARCH_ARTIFACT_KINDS as readonly string[]).includes(value)) {
    throw new TypeError(`Unsupported research artifact kind: ${value}.`);
  }
}

function assertArtifactStatus(value: string): asserts value is ResearchArtifactStatus {
  if (!["active", "stale", "superseded", "rejected", "archived"].includes(value)) {
    throw new TypeError(`Unsupported research artifact status: ${value}.`);
  }
}

function assertRelation(value: string): asserts value is ResearchArtifactRelation {
  if (!["derived_from", "uses", "supports", "challenges", "supersedes"].includes(value)) {
    throw new TypeError(`Unsupported research artifact relation: ${value}.`);
  }
}

function requireIdentifier(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (normalized.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized)) {
    throw new TypeError(`${label} must be a safe identifier no longer than 256 characters.`);
  }
  return normalized;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\u0000") || value.length > 16_000) {
    throw new TypeError(`${label} must be non-empty trimmed text.`);
  }
  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function requireIsoDate(value: string, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError(`${label} must be an ISO date.`);
  return value;
}

function requireHash(value: string, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 content hash.`);
  }
  return value;
}

function assertNoCycle(value: object, ancestors: Set<object>): void {
  if (ancestors.has(value)) throw new TypeError("Research artifact content cannot contain cyclic values.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
