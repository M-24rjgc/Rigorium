import path from "node:path";

/**
 * Convert a path that came from the local filesystem into the stable form
 * carried by model-facing protocol values and persisted references.
 */
export function toProtocolPath(fileSystemPath: string): string {
  return fileSystemPath.replaceAll("\\", "/");
}

/**
 * Convert a protocol path back to the current host's native representation
 * before passing it to filesystem APIs.
 */
export function toNativeFileSystemPath(protocolPath: string): string {
  return path.normalize(
    protocolPath.replaceAll("/", path.sep).replaceAll("\\", path.sep),
  );
}
