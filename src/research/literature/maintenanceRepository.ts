import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { getProjectLiteratureMapPaths } from "./mapRepository.js";

export const LITERATURE_MAINTENANCE_AUDIT_SCHEMA_VERSION = 1 as const;
export const MAX_LITERATURE_MAINTENANCE_AUDITS = 200;
const MAX_AUDIT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_AUDIT_STRING_LENGTH = 16 * 1024;

export type LiteratureMaintenanceAuditRecord = Readonly<{
  schemaVersion: 1;
  kind: "literature_map_maintenance_audit";
  maintenanceId: string;
  trigger: string;
  intent?: string;
  startedAt: string;
  completedAt: string;
  cancelled: boolean;
  sourceAudits: readonly Record<string, unknown>[];
  candidateReview: Record<string, unknown>;
  map?: {
    mapId: string;
    fromRevision: number;
    toRevision: number;
    persisted: boolean;
  };
  errors: readonly string[];
}>;

export type LiteratureMaintenanceAuditDocument = Readonly<{
  schemaVersion: 1;
  kind: "literature_map_maintenance_audit_log";
  audits: readonly LiteratureMaintenanceAuditRecord[];
}>;

export function getProjectLiteratureMaintenanceAuditPath(input: { projectRoot: string }): string {
  const paths = getProjectLiteratureMapPaths({ projectRoot: input.projectRoot });
  const auditPath = join(paths.researchDir, "maintenance-audit.json");
  assertWithinProject(paths.projectRoot, auditPath);
  return auditPath;
}

export async function loadProjectLiteratureMaintenanceAudits(input: {
  projectRoot: string;
  limit?: number;
}): Promise<LiteratureMaintenanceAuditRecord[]> {
  const path = getProjectLiteratureMaintenanceAuditPath(input);
  const stat = await lstatIfExists(path);
  if (!stat) return [];
  if (!stat.isFile()) throw new Error("Literature maintenance audit path is not a regular file.");
  if (stat.size > MAX_AUDIT_FILE_BYTES) throw new Error("Literature maintenance audit file exceeds its size limit.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Literature maintenance audit is not valid JSON: ${detail}`);
  }
  const document = validateAuditDocument(parsed);
  const limit = normalizeLimit(input.limit);
  return document.audits.slice(Math.max(0, document.audits.length - limit)).map((audit) => ({ ...audit }));
}

export async function appendProjectLiteratureMaintenanceAudit(input: {
  projectRoot: string;
  audit: LiteratureMaintenanceAuditRecord;
  maxAudits?: number;
}): Promise<{ path: string; persisted: boolean; audits: LiteratureMaintenanceAuditRecord[] }> {
  const path = getProjectLiteratureMaintenanceAuditPath(input);
  const existing = await loadProjectLiteratureMaintenanceAudits({ projectRoot: input.projectRoot, limit: MAX_LITERATURE_MAINTENANCE_AUDITS });
  const maxAudits = normalizeMaxAudits(input.maxAudits);
  const audits = [...existing, normalizeAuditRecord(input.audit)].slice(-maxAudits);
  const document: LiteratureMaintenanceAuditDocument = {
    schemaVersion: LITERATURE_MAINTENANCE_AUDIT_SCHEMA_VERSION,
    kind: "literature_map_maintenance_audit_log",
    audits,
  };
  const serialized = JSON.stringify(document, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_AUDIT_FILE_BYTES) {
    throw new Error("Literature maintenance audit would exceed its size limit.");
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await unlinkIfExists(temporaryPath);
  }
  return { path, persisted: true, audits };
}

function validateAuditDocument(value: unknown): LiteratureMaintenanceAuditDocument {
  if (!isRecord(value)
    || value.schemaVersion !== LITERATURE_MAINTENANCE_AUDIT_SCHEMA_VERSION
    || value.kind !== "literature_map_maintenance_audit_log"
    || !Array.isArray(value.audits)) {
    throw new Error("Unsupported literature maintenance audit schema.");
  }
  if (value.audits.length > MAX_LITERATURE_MAINTENANCE_AUDITS) {
    throw new Error("Literature maintenance audit contains too many entries.");
  }
  const audits = value.audits.map((entry) => normalizeAuditRecord(entry));
  return {
    schemaVersion: LITERATURE_MAINTENANCE_AUDIT_SCHEMA_VERSION,
    kind: "literature_map_maintenance_audit_log",
    audits,
  };
}

function normalizeAuditRecord(value: unknown): LiteratureMaintenanceAuditRecord {
  if (!isRecord(value)) throw new Error("A literature maintenance audit entry must be an object.");
  const maintenanceId = requireText(value.maintenanceId, "maintenanceId");
  const trigger = requireText(value.trigger, "trigger");
  const startedAt = requireTimestamp(value.startedAt, "startedAt");
  const completedAt = requireTimestamp(value.completedAt, "completedAt");
  if (typeof value.cancelled !== "boolean") throw new Error("cancelled must be a boolean.");
  if (!Array.isArray(value.sourceAudits) || !Array.isArray(value.errors) || !isRecord(value.candidateReview)) {
    throw new Error("Maintenance audit sourceAudits, candidateReview, and errors are required.");
  }
  const sourceAudits = value.sourceAudits.map((entry) => {
    if (!isRecord(entry)) throw new Error("Maintenance source audit entries must be objects.");
    return entry;
  });
  const errors = value.errors.map((entry) => requireText(entry, "errors[]"));
  let map: LiteratureMaintenanceAuditRecord["map"];
  if (value.map !== undefined) {
    if (!isRecord(value.map)
      || typeof value.map.mapId !== "string"
      || !Number.isSafeInteger(value.map.fromRevision)
      || !Number.isSafeInteger(value.map.toRevision)
      || typeof value.map.persisted !== "boolean") {
      throw new Error("Maintenance audit map summary is invalid.");
    }
    map = {
      mapId: requireText(value.map.mapId, "map.mapId"),
      fromRevision: value.map.fromRevision,
      toRevision: value.map.toRevision,
      persisted: value.map.persisted,
    };
  }
  return {
    schemaVersion: LITERATURE_MAINTENANCE_AUDIT_SCHEMA_VERSION,
    kind: "literature_map_maintenance_audit",
    maintenanceId,
    trigger,
    ...(value.intent === undefined ? {} : { intent: requireText(value.intent, "intent") }),
    startedAt,
    completedAt,
    cancelled: value.cancelled,
    sourceAudits,
    candidateReview: value.candidateReview,
    ...(map ? { map } : {}),
    errors,
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return MAX_LITERATURE_MAINTENANCE_AUDITS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LITERATURE_MAINTENANCE_AUDITS) {
    throw new Error(`limit must be between 1 and ${MAX_LITERATURE_MAINTENANCE_AUDITS}.`);
  }
  return value;
}

function normalizeMaxAudits(value: number | undefined): number {
  return normalizeLimit(value);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\u0000") || value.length > MAX_AUDIT_STRING_LENGTH) {
    throw new Error(`${label} must be non-empty text within its size limit.`);
  }
  return value.trim();
}

function requireTimestamp(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO-compatible timestamp.`);
  return text;
}

function assertWithinProject(projectRoot: string, candidate: string): void {
  const root = resolve(projectRoot);
  const target = resolve(candidate);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(`..${sep}`) || rel === "") {
    throw new Error("Literature maintenance audit path must remain inside the project root.");
  }
}

async function lstatIfExists(path: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
