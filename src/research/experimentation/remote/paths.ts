import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import type {
  PreparedRemoteStageFile,
  RemoteStageFileInput,
} from "./contracts.js";

export const MAX_REMOTE_STAGE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_REMOTE_STAGE_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_REMOTE_STAGE_FILES = 128;

export async function prepareRemoteStageFiles(input: {
  projectRoot: string;
  workdir: string;
  files: readonly RemoteStageFileInput[];
}): Promise<readonly PreparedRemoteStageFile[]> {
  if (!Array.isArray(input.files) || input.files.length > MAX_REMOTE_STAGE_FILES) {
    throw new TypeError(`stageFiles must contain at most ${MAX_REMOTE_STAGE_FILES} files.`);
  }
  const projectRoot = resolve(input.projectRoot);
  const projectReal = await realpath(projectRoot);
  if (relative(projectRoot, projectReal) !== "") {
    throw new TypeError("projectRoot must not resolve through a symbolic link or junction.");
  }
  const workdir = normalizeRemoteAbsolutePath(input.workdir, "workdir");
  const seenRemote = new Set<string>();
  const prepared: PreparedRemoteStageFile[] = [];
  let totalBytes = 0;

  for (const [index, file] of input.files.entries()) {
    if (!file || typeof file.localPath !== "string") throw new TypeError(`stageFiles[${index}].localPath is required.`);
    const localPath = isAbsolute(file.localPath) ? resolve(file.localPath) : resolve(projectRoot, file.localPath);
    assertLocalPathWithin(projectRoot, localPath, `stageFiles[${index}].localPath`);
    await assertNoLocalSymlink(projectRoot, localPath, `stageFiles[${index}].localPath`);
    const stats = await lstat(localPath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new TypeError(`stageFiles[${index}].localPath must be a regular file.`);
    if (stats.size > MAX_REMOTE_STAGE_FILE_BYTES) {
      throw new TypeError(`stageFiles[${index}] exceeds ${MAX_REMOTE_STAGE_FILE_BYTES} bytes.`);
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_REMOTE_STAGE_TOTAL_BYTES) throw new TypeError("Staged files exceed the total byte limit.");
    const localReal = await realpath(localPath);
    assertLocalPathWithin(projectReal, localReal, `stageFiles[${index}].localPath`);
    const remoteRelativePath = normalizeRemoteRelativePath(file.remoteRelativePath, `stageFiles[${index}].remoteRelativePath`);
    const remotePath = resolveRemoteChild(workdir, remoteRelativePath, `stageFiles[${index}].remoteRelativePath`);
    if (seenRemote.has(remotePath)) throw new TypeError(`Remote stage path is duplicated: ${remoteRelativePath}.`);
    seenRemote.add(remotePath);
    const content = await readFile(localPath);
    if (content.byteLength !== stats.size) throw new TypeError(`stageFiles[${index}] changed while it was being read.`);
    prepared.push(Object.freeze({
      localRelativePath: normalizeLocalRelativePath(relative(projectRoot, localPath)),
      remoteRelativePath,
      remotePath,
      bytes: content.byteLength,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
    }));
  }
  return Object.freeze(prepared.sort((left, right) => left.remotePath.localeCompare(right.remotePath, "en")));
}

export function normalizeRemoteAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\\") || value.includes("\u0000")) {
    throw new TypeError(`${label} must be an absolute POSIX path.`);
  }
  if (!value.startsWith("/") || value.length > 4_096) throw new TypeError(`${label} must be an absolute POSIX path.`);
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === "/") throw new TypeError(`${label} must be a normalized non-root POSIX path.`);
  for (const segment of normalized.split("/").slice(1)) {
    if (!safeRemotePathSegment(segment)) throw new TypeError(`${label} contains an unsafe path segment.`);
  }
  return normalized;
}

export function normalizeRemoteRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\\") || value.includes("\u0000")) {
    throw new TypeError(`${label} must be a relative POSIX path.`);
  }
  if (value.startsWith("/") || value.length > 4_096) throw new TypeError(`${label} must be a relative POSIX path.`);
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new TypeError(`${label} must stay below its remote root.`);
  }
  for (const segment of normalized.split("/")) {
    if (!safeRemotePathSegment(segment)) throw new TypeError(`${label} contains an unsafe path segment.`);
  }
  return normalized;
}

export function assertRemotePathWithin(rootValue: string, candidateValue: string, label: string): void {
  const root = normalizeRemoteAbsolutePath(rootValue, `${label} root`);
  const candidate = normalizeRemoteAbsolutePath(candidateValue, label);
  const rel = posix.relative(root, candidate);
  if (!rel || rel.startsWith("../") || rel === ".." || posix.isAbsolute(rel)) {
    if (candidate !== root) throw new TypeError(`${label} must stay below ${root}.`);
    return;
  }
}

export function resolveRemoteChild(rootValue: string, relativeValue: string, label: string): string {
  const root = normalizeRemoteAbsolutePath(rootValue, `${label} root`);
  const child = normalizeRemoteRelativePath(relativeValue, label);
  const candidate = posix.resolve(root, child);
  const rel = posix.relative(root, candidate);
  if (!rel || rel.startsWith("../") || rel === ".." || posix.isAbsolute(rel)) {
    throw new TypeError(`${label} must resolve below ${root}.`);
  }
  return candidate;
}

export function remoteJobKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertLocalPathWithin(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    if (candidate !== root) throw new TypeError(`${label} must stay inside the Project.`);
    return;
  }
}

async function assertNoLocalSymlink(root: string, candidate: string, label: string): Promise<void> {
  const rel = relative(root, candidate);
  assertLocalPathWithin(root, candidate, label);
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) throw new TypeError(`${label} must not traverse a symbolic link or junction.`);
  }
}

function normalizeLocalRelativePath(value: string): string {
  return value.split(sep).join("/");
}

function safeRemotePathSegment(value: string): boolean {
  return value.length > 0 && value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}
