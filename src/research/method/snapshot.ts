import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createResearchArtifact,
  toResearchArtifactRef,
  type ResearchArtifactParent,
  type ResearchArtifactProducer,
} from "../artifacts/index.js";
import type {
  ExpectedConclusion,
  ImplementationRoute,
  ImplementationSnapshotArtifact,
  ImplementationSnapshotFile,
  ImplementationSnapshotPayload,
  MethodSpecArtifact,
  ObservedConclusion,
  SnapshotFileInput,
  VerificationCheckSpec,
  VerificationRecord,
} from "./contracts.js";

export async function createImplementationSnapshotArtifact(input: {
  methodSpec: MethodSpecArtifact;
  routeId: string;
  implementationRoot: string;
  configFiles?: readonly string[];
  verificationRecords?: readonly VerificationRecord[];
  observedConclusions?: readonly ObservedConclusion[];
  producer?: ResearchArtifactProducer;
  parents?: readonly ResearchArtifactParent[];
  artifactId?: string;
  revision?: number;
  now?: Date;
}): Promise<ImplementationSnapshotArtifact> {
  const methodSpec = assertMethodSpec(input.methodSpec);
  const routeId = identifier(input.routeId, "routeId");
  const route = methodSpec.payload.implementationRoutes.find((candidate) => candidate.id === routeId);
  if (!route) throw new TypeError(`MethodSpec has no implementation route ${routeId}.`);
  const root = await inspectRoot(input.implementationRoot);
  const requestedFiles = snapshotFiles(route, input.configFiles ?? []);
  const files = Object.freeze(await Promise.all(requestedFiles.map((file) => captureFile(root, file))));
  const records = normalizeVerificationRecords(
    input.verificationRecords ?? [],
    route,
    methodSpec.payload.verificationChecks,
  );
  const expectedConclusions = Object.freeze([...methodSpec.payload.expectedConclusions]);
  const observedConclusions = normalizeObservedConclusions(
    input.observedConclusions ?? [],
    expectedConclusions,
    records,
  );
  const capturedAt = isoDate(input.now ?? new Date(), "now");
  const payload: ImplementationSnapshotPayload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "implementation_snapshot" as const,
    methodSpecRef: toResearchArtifactRef(methodSpec),
    routeId,
    capturedAt,
    capturePolicy: Object.freeze({
      readOnly: true as const,
      autoCommit: false as const,
      dirtyUserWorktree: "preserved" as const,
    }),
    files,
    sourceHash: aggregateHash(files.filter((file) => file.role === "source" || file.role === "config")),
    testHash: aggregateHash(files.filter((file) => file.role === "test")),
    verificationRecords: records,
    expectedConclusions,
    observedConclusions,
  });
  return createResearchArtifact({
    kind: "implementation_snapshot",
    artifactId: input.artifactId ?? `implementation-snapshot-${randomUUID()}`,
    revision: input.revision,
    payload,
    producer: input.producer ?? { kind: "tool", toolName: "research_method_snapshot" },
    parents: [
      { relation: "derived_from", artifact: toResearchArtifactRef(methodSpec) },
      ...(input.parents ?? []),
    ],
    sources: methodSpec.sources,
    now: input.now,
  }) as ImplementationSnapshotArtifact;
}

function assertMethodSpec(value: MethodSpecArtifact): MethodSpecArtifact {
  if (!value || value.kind !== "method_spec" || value.payload?.kind !== "method_spec"
    || value.payload.status !== "executable") {
    throw new TypeError("An executable MethodSpec artifact is required.");
  }
  if (value.status !== "active") throw new TypeError("Implementation snapshots require an active MethodSpec.");
  return value;
}

function snapshotFiles(route: ImplementationRoute, configFiles: readonly string[]): SnapshotFileInput[] {
  if (!Array.isArray(configFiles)) throw new TypeError("configFiles must be an array.");
  const files: SnapshotFileInput[] = [
    ...route.sourceFiles.map((path) => ({ path, role: "source" as const })),
    ...route.testFiles.map((path) => ({ path, role: "test" as const })),
    ...configFiles.map((path) => ({ path: safeRelativePath(path, "configFiles"), role: "config" as const })),
  ];
  const seen = new Set<string>();
  for (const file of files) {
    const path = safeRelativePath(file.path, `${file.role} file`);
    const key = process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
    if (seen.has(key)) throw new TypeError(`Snapshot file ${path} is listed more than once.`);
    seen.add(key);
  }
  return files
    .map((file) => Object.freeze({ path: safeRelativePath(file.path, `${file.role} file`), role: file.role }))
    .sort(compareFileInput);
}

async function inspectRoot(value: string): Promise<string> {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\u0000")) {
    throw new TypeError("implementationRoot must be a non-empty path.");
  }
  const root = resolve(value);
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TypeError("implementationRoot must be a real directory.");
  }
  return realpath(root);
}

async function captureFile(root: string, input: SnapshotFileInput): Promise<ImplementationSnapshotFile> {
  const path = safeRelativePath(input.path, `${input.role} file`);
  const parts = path.split("/");
  let candidate = root;
  for (let index = 0; index < parts.length; index += 1) {
    candidate = join(candidate, parts[index]!);
    let stats;
    try {
      stats = await lstat(candidate);
    } catch (error) {
      throw new TypeError(`Snapshot file ${path} cannot be inspected: ${messageOf(error)}.`);
    }
    if (stats.isSymbolicLink()) throw new TypeError(`Snapshot file ${path} traverses a symbolic link.`);
    if (index < parts.length - 1 && !stats.isDirectory()) {
      throw new TypeError(`Snapshot path component ${parts[index]} in ${path} is not a directory.`);
    }
    if (index === parts.length - 1 && !stats.isFile()) {
      throw new TypeError(`Snapshot file ${path} must be a regular file.`);
    }
  }
  const realCandidate = await realpath(candidate);
  if (!containsPath(root, realCandidate)) throw new TypeError(`Snapshot file ${path} escapes the implementation root.`);
  const content = await readFile(realCandidate);
  return Object.freeze({
    path,
    role: input.role,
    sha256: sha256(content),
    bytes: content.length,
  });
}

function normalizeVerificationRecords(
  values: readonly VerificationRecord[],
  route: ImplementationRoute,
  checks: readonly VerificationCheckSpec[],
): readonly VerificationRecord[] {
  if (!Array.isArray(values)) throw new TypeError("verificationRecords must be an array.");
  const allowedChecks = new Set(route.verificationCheckIds);
  const checksById = new Map(checks.map((check) => [check.id, check]));
  const ids = new Set<string>();
  return Object.freeze(values.map((value, index) => {
    if (!value || typeof value !== "object") throw new TypeError(`verificationRecords[${index}] must be an object.`);
    const id = identifier(value.id, `verificationRecords[${index}].id`);
    if (ids.has(id)) throw new TypeError(`Verification record ${id} is duplicated.`);
    ids.add(id);
    const checkId = identifier(value.checkId, `verificationRecords[${index}].checkId`);
    const check = checksById.get(checkId);
    if (!allowedChecks.has(checkId) || !check) {
      throw new TypeError(`Verification record ${id} does not belong to route ${route.id}.`);
    }
    if (value.kind !== check.kind || value.workspaceMode !== "isolated") {
      throw new TypeError(`Verification record ${id} does not match its isolated check contract.`);
    }
    if (!["passed", "failed", "timeout", "cancelled"].includes(value.status)) {
      throw new TypeError(`Verification record ${id} has an invalid status.`);
    }
    if (!Array.isArray(value.command) || value.command.length === 0
      || value.command.some((part: string) => typeof part !== "string" || part.includes("\u0000"))) {
      throw new TypeError(`Verification record ${id} has an invalid command.`);
    }
    if (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) {
      throw new TypeError(`Verification record ${id} has an invalid exit code.`);
    }
    hash(value.stdoutHash, `Verification record ${id} stdoutHash`);
    hash(value.stderrHash, `Verification record ${id} stderrHash`);
    nonNegativeInteger(value.stdoutBytes, `Verification record ${id} stdoutBytes`);
    nonNegativeInteger(value.stderrBytes, `Verification record ${id} stderrBytes`);
    nonNegativeInteger(value.durationMs, `Verification record ${id} durationMs`);
    isoText(value.executedAt, `Verification record ${id} executedAt`);
    if (!Array.isArray(value.numericalResults)) {
      throw new TypeError(`Verification record ${id} numericalResults must be an array.`);
    }
    return Object.freeze({
      ...value,
      command: Object.freeze([...value.command]),
      numericalResults: Object.freeze([...value.numericalResults]),
    });
  }));
}

function normalizeObservedConclusions(
  values: readonly ObservedConclusion[],
  expectedConclusions: readonly ExpectedConclusion[],
  records: readonly VerificationRecord[],
): readonly ObservedConclusion[] {
  if (!Array.isArray(values)) throw new TypeError("observedConclusions must be an array.");
  const expectedById = new Map(expectedConclusions.map((conclusion) => [conclusion.id, conclusion]));
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const ids = new Set<string>();
  return Object.freeze(values.map((value, index) => {
    if (!value || typeof value !== "object") throw new TypeError(`observedConclusions[${index}] must be an object.`);
    const id = identifier(value.id, `observedConclusions[${index}].id`);
    if (ids.has(id)) throw new TypeError(`Observed conclusion ${id} is duplicated.`);
    ids.add(id);
    const expectedConclusion = value.expectedConclusionId === undefined
      ? undefined
      : expectedById.get(identifier(value.expectedConclusionId, `observedConclusions[${index}].expectedConclusionId`));
    if (value.expectedConclusionId !== undefined && !expectedConclusion) {
      throw new TypeError(`Observed conclusion ${id} references an unknown expected conclusion.`);
    }
    if (typeof value.statement !== "string" || !value.statement.trim() || value.statement !== value.statement.trim()
      || value.statement.length > 8_000 || value.statement.includes("\u0000")) {
      throw new TypeError(`Observed conclusion ${id} requires a bounded statement.`);
    }
    if (!["supported", "contradicted", "inconclusive"].includes(value.outcome)) {
      throw new TypeError(`Observed conclusion ${id} has an invalid outcome.`);
    }
    if (!Array.isArray(value.verificationRecordIds) || value.verificationRecordIds.length === 0) {
      throw new TypeError(`Observed conclusion ${id} must cite actual verification records.`);
    }
    const verificationRecordIds = value.verificationRecordIds.map((recordId: string) => {
      const normalized = identifier(recordId, `Observed conclusion ${id} verification record`);
      if (!recordsById.has(normalized)) {
        throw new TypeError(`Observed conclusion ${id} references unknown verification record ${normalized}.`);
      }
      return normalized;
    });
    if (new Set(verificationRecordIds).size !== verificationRecordIds.length) {
      throw new TypeError(`Observed conclusion ${id} repeats a verification record.`);
    }
    if (value.outcome === "supported" && expectedConclusion) {
      const citedRecords: VerificationRecord[] = verificationRecordIds.map((recordId: string) => recordsById.get(recordId)!);
      const passedChecks = new Set(citedRecords
        .filter((record: VerificationRecord) => record.status === "passed")
        .map((record: VerificationRecord) => record.checkId));
      for (const requiredCheckId of expectedConclusion.requiredVerificationIds) {
        if (!passedChecks.has(requiredCheckId)) {
          throw new TypeError(`Observed conclusion ${id} cannot claim support without passed check ${requiredCheckId}.`);
        }
      }
    }
    return Object.freeze({
      id,
      ...(expectedConclusion === undefined ? {} : { expectedConclusionId: expectedConclusion.id }),
      statement: value.statement,
      outcome: value.outcome,
      verificationRecordIds: Object.freeze(verificationRecordIds),
    });
  }));
}

function aggregateHash(files: readonly ImplementationSnapshotFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort(compareSnapshotFile)) {
    hash.update(JSON.stringify([file.role, file.path, file.sha256, file.bytes]), "utf8");
    hash.update("\n", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\u0000")) {
    throw new TypeError(`${label} must be a non-empty relative path.`);
  }
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)
    || parts.some((part) => part === "" || part === "." || part === ".." || part.includes(":"))) {
    throw new TypeError(`${label} must be a safe relative path.`);
  }
  return normalized;
}

function containsPath(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function compareFileInput(left: SnapshotFileInput, right: SnapshotFileInput): number {
  return left.role.localeCompare(right.role, "en") || left.path.localeCompare(right.path, "en");
}

function compareSnapshotFile(left: ImplementationSnapshotFile, right: ImplementationSnapshotFile): number {
  return left.role.localeCompare(right.role, "en") || left.path.localeCompare(right.path, "en");
}

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 hash.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return value as number;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new TypeError(`${label} must be a safe identifier.`);
  }
  return value;
}

function isoDate(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`${label} must be a valid date.`);
  return value.toISOString();
}

function isoText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp.`);
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
