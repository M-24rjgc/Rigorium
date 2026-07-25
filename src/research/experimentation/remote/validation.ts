import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import {
  canonicalJson,
  hashResearchArtifactContent,
} from "../../artifacts/index.js";
import type {
  RemoteConnectionRecord,
  RemoteConnectionSpec,
  RemoteExperimentSubmission,
  RemoteJobRecord,
  SlurmResourceSpec,
} from "./contracts.js";
import {
  assertRemotePathWithin,
  normalizeRemoteAbsolutePath,
} from "./paths.js";
import { normalizeSlurmResources } from "./slurm.js";

export function normalizeRemoteConnection(
  input: RemoteConnectionSpec,
  now = new Date(),
): RemoteConnectionRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("connection must be an object.");
  const connectionId = identifier(input.connectionId, "connectionId");
  const host = remoteHost(input.host);
  const port = boundedInteger(input.port ?? 22, "port", 1, 65_535);
  const username = input.username === undefined ? undefined : remoteUsername(input.username);
  const sshExecutable = localExecutable(input.sshExecutable ?? "ssh", "sshExecutable");
  const identityFile = input.identityFile === undefined ? undefined : absoluteLocalPath(input.identityFile, "identityFile");
  const knownHostsFile = absoluteLocalPath(input.knownHostsFile, "knownHostsFile");
  const agentCommand = normalizeAgentCommand(input.agentCommand);
  const workspaceRoot = normalizeRemoteAbsolutePath(input.workspaceRoot, "workspaceRoot");
  const stateRoot = normalizeRemoteAbsolutePath(input.stateRoot, "stateRoot");
  if (workspaceRoot === stateRoot || workspaceRoot.startsWith(`${stateRoot}/`) || stateRoot.startsWith(`${workspaceRoot}/`)) {
    throw new TypeError("workspaceRoot and stateRoot must be separate remote trees.");
  }
  const connectTimeoutMs = boundedInteger(input.connectTimeoutMs ?? 15_000, "connectTimeoutMs", 1_000, 300_000);
  const requestTimeoutMs = boundedInteger(input.requestTimeoutMs ?? 120_000, "requestTimeoutMs", 1_000, 86_400_000);
  const timestamp = isoDate(now, "now");
  return Object.freeze({
    connectionId,
    host,
    port,
    ...(username === undefined ? {} : { username }),
    sshExecutable,
    ...(identityFile === undefined ? {} : { identityFile }),
    knownHostsFile,
    agentCommand: Object.freeze(agentCommand),
    workspaceRoot,
    stateRoot,
    connectTimeoutMs,
    requestTimeoutMs,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function normalizeRemoteSubmission(input: RemoteExperimentSubmission): Readonly<{
  connectionId: string;
  backend: "ssh" | "slurm";
  experimentId: string;
  grantId: string;
  jobId: string;
  automaticGrantConfirmed: boolean;
  workdir: string;
  argv: readonly string[];
  slurm?: SlurmResourceSpec;
}> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("submission must be an object.");
  if (input.backend !== "ssh" && input.backend !== "slurm") throw new TypeError("backend must be ssh or slurm.");
  const workdir = normalizeRemoteAbsolutePath(input.workdir, "workdir");
  const argv = normalizeArgv(input.argv);
  const slurm = input.backend === "slurm" ? normalizeSlurmResources(input.slurm) : undefined;
  if (input.backend === "ssh" && input.slurm !== undefined) throw new TypeError("slurm resources require backend=slurm.");
  return Object.freeze({
    connectionId: identifier(input.connectionId, "connectionId"),
    backend: input.backend,
    experimentId: identifier(input.experimentId, "experimentId"),
    grantId: identifier(input.grantId, "grantId"),
    jobId: identifier(input.jobId, "jobId"),
    automaticGrantConfirmed: input.automaticGrantConfirmed === true,
    workdir,
    argv: Object.freeze(argv),
    ...(slurm === undefined ? {} : { slurm }),
  });
}

export function assertSubmissionWithinConnection(
  connection: RemoteConnectionRecord,
  workdir: string,
): void {
  assertRemotePathWithin(connection.workspaceRoot, workdir, "workdir");
  if (workdir === connection.workspaceRoot) throw new TypeError("workdir must be below workspaceRoot, not the root itself.");
}

export function remoteSubmissionHash(input: {
  connectionId: string;
  backend: "ssh" | "slurm";
  experimentId: string;
  grantId: string;
  jobId: string;
  workdir: string;
  argv: readonly string[];
  slurm?: SlurmResourceSpec;
  stagedFiles: readonly Readonly<{ remoteRelativePath: string; remotePath: string; bytes: number; sha256: string }>[];
}): string {
  return hashResearchArtifactContent({
    connectionId: input.connectionId,
    backend: input.backend,
    experimentId: input.experimentId,
    grantId: input.grantId,
    jobId: input.jobId,
    workdir: input.workdir,
    argv: input.argv,
    ...(input.slurm === undefined ? {} : { slurm: input.slurm }),
    stagedFiles: [...input.stagedFiles]
      .map((file) => ({
        remoteRelativePath: file.remoteRelativePath,
        remotePath: file.remotePath,
        bytes: file.bytes,
        sha256: file.sha256,
      }))
      .sort((left, right) => left.remotePath.localeCompare(right.remotePath, "en")),
  });
}

export function sameConnectionTerms(left: RemoteConnectionRecord, right: RemoteConnectionRecord): boolean {
  return canonicalJson(connectionTerms(left)) === canonicalJson(connectionTerms(right));
}

export function assertRemoteJobIdentity(previous: RemoteJobRecord, next: RemoteJobRecord): void {
  for (const key of ["jobId", "attemptId", "experimentId", "grantId", "grantMode", "connectionId", "backend", "requestHash", "workdir"] as const) {
    if (previous[key] !== next[key]) throw new TypeError(`Remote job identity field ${key} is immutable.`);
  }
  if (canonicalJson(previous.argv) !== canonicalJson(next.argv) || canonicalJson(previous.slurm ?? {}) !== canonicalJson(next.slurm ?? {})) {
    throw new TypeError("Remote job execution terms are immutable.");
  }
  if (previous.backendJobId && next.backendJobId !== previous.backendJobId) throw new TypeError("backendJobId is immutable once observed.");
  if (previous.schedulerJobId && next.schedulerJobId !== previous.schedulerJobId) throw new TypeError("schedulerJobId is immutable once observed.");
}

export function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new TypeError(`${label} must be a safe identifier.`);
  }
  return value;
}

export function isoDate(value: unknown, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new TypeError(`${label} must be a valid date.`);
  return value.toISOString();
}

export function normalizeArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4_096) throw new TypeError("argv must contain an executable and bounded arguments.");
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 65_536 || entry.includes("\u0000")
      || /[\u0001-\u0008\u000B\u000C\u000E-\u001F]/u.test(entry)) {
      throw new TypeError(`argv[${index}] must be bounded text without control characters.`);
    }
    return entry;
  });
}

export function normalizeAgentCommand(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new TypeError("agentCommand must contain a fixed executable and arguments.");
  const normalized = value.map((entry, index) => {
    if (typeof entry !== "string" || !entry || entry.length > 1_024 || !/^[A-Za-z0-9_./:=+-]+$/u.test(entry)) {
      throw new TypeError(`agentCommand[${index}] contains unsafe shell characters.`);
    }
    return entry;
  });
  if (!normalized[0]!.startsWith("/")) throw new TypeError("agentCommand executable must be an absolute POSIX path.");
  return normalized;
}

function connectionTerms(value: RemoteConnectionRecord) {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...terms } = value;
  return terms;
}

function remoteHost(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 253 || value.includes("@") || value.startsWith("-")) {
    throw new TypeError("host must be a DNS name or IP address without user information.");
  }
  if (isIP(value) !== 0) return value;
  if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/u.test(value)) {
    throw new TypeError("host must be a valid DNS name or IP address.");
  }
  return value;
}

function remoteUsername(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9._-]{0,63}$/u.test(value)) throw new TypeError("username is invalid.");
  return value;
}

function localExecutable(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\u0000") || value.length > 4_096) {
    throw new TypeError(`${label} must be a local executable name or absolute path.`);
  }
  if (isAbsolute(value)) return value;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) throw new TypeError(`${label} command name is invalid.`);
  return value;
}

function absoluteLocalPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\u0000") || value.length > 8_192) {
    throw new TypeError(`${label} must be an absolute local path.`);
  }
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}
