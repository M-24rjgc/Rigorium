import { homedir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { findCanonicalProjectRoot } from "../session/worktree/findCanonicalProjectRoot.js";

export type RigoriumPathEnv = Record<string, string | undefined>;

export const DEFAULT_RIGORIUM_HOME = "~/.rigorium";
export const RIGORIUM_CONFIG_FILE_NAME = "rigorium.yaml";
export const RIGORIUM_PROJECT_DIR_NAME = ".rigorium";

export type RigoriumExtensionPaths = {
  globalPluginsDir: string;
  globalSkillsDir: string;
  projectPluginsDir: string;
  projectSkillsDir: string;
};

export function resolveRigoriumHome(env: RigoriumPathEnv = process.env): string {
  return normalizeHomePath(env.RIGORIUM_HOME ?? DEFAULT_RIGORIUM_HOME);
}

export function getRigoriumConfigFilePath(rigoriumHome: string): string {
  return resolve(rigoriumHome, RIGORIUM_CONFIG_FILE_NAME);
}

export function getRigoriumProjectConfigFilePath(projectRoot: string): string {
  return resolve(projectRoot, RIGORIUM_PROJECT_DIR_NAME, RIGORIUM_CONFIG_FILE_NAME);
}

export function getRigoriumMemoryRootDir(rigoriumHome: string): string {
  return resolve(rigoriumHome, "memory");
}

export function getRigoriumProjectChatDir(projectRoot: string, rigoriumHome: string): string {
  const projectId = resolveProjectStorageId(projectRoot, rigoriumHome);
  return resolve(rigoriumHome, "projects", projectId, "chats");
}

/**
 * Async variant that first resolves a worktree cwd to its canonical
 * main-repository root (so all worktrees share the same project ID).
 * Use this for all new code. The sync `getRigoriumProjectChatDir` keeps
 * the legacy behaviour for callers that cannot await.
 */
export async function getRigoriumProjectChatDirAsync(
  projectRoot: string,
  rigoriumHome: string,
): Promise<string> {
  const canonical = await findCanonicalProjectRoot(projectRoot);
  const projectId = resolveProjectStorageId(canonical, rigoriumHome);
  return resolve(rigoriumHome, "projects", projectId, "chats");
}

export function getRigoriumExtensionPaths(projectRoot: string, rigoriumHome: string): RigoriumExtensionPaths {
  return {
    globalPluginsDir: resolve(rigoriumHome, "plugins"),
    globalSkillsDir: resolve(rigoriumHome, "skills"),
    projectPluginsDir: resolve(projectRoot, RIGORIUM_PROJECT_DIR_NAME, "plugins"),
    projectSkillsDir: resolve(projectRoot, RIGORIUM_PROJECT_DIR_NAME, "skills"),
  };
}

export function createProjectId(projectRoot: string): string {
  const normalizedRoot = resolve(projectRoot);
  return createLegacyProjectId(normalizedRoot);
}

export function createCollisionResistantProjectId(projectRoot: string): string {
  const normalizedRoot = resolve(projectRoot);
  const legacyId = createLegacyProjectId(normalizedRoot);
  const digest = createHash("sha1").update(normalizedRoot).digest("hex").slice(0, 10);
  return `${legacyId}--${digest}`;
}

/**
 * Resolve the on-disk project directory name for a workspace.
 *
 * `.cwd` markers are authoritative because the legacy project ID is lossy:
 * distinct paths (especially paths containing non-ASCII segments) can encode
 * to the same slug. When no valid marker exists, retain the legacy ID for
 * backwards compatibility with unregistered projects.
 */
export function resolveProjectStorageId(projectRoot: string, rigoriumHome: string): string {
  return findStoredProjectId(projectRoot, rigoriumHome) ?? createProjectId(projectRoot);
}

/**
 * Async variant: resolves canonical (worktree-aware) root before hashing.
 * Two worktrees of the same repo produce the same project ID.
 */
export async function createProjectIdAsync(projectRoot: string): Promise<string> {
  const canonical = await findCanonicalProjectRoot(projectRoot);
  return createProjectId(canonical);
}

function normalizeHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return resolve(path);
}

function createLegacyProjectId(projectRoot: string): string {
  // Normalize to forward slashes so the same physical path produces the same
  // project ID on Windows (\) and Unix (/). Also strip a Windows drive-letter
  // prefix (e.g. "C:") so "C:\Users\foo" slugifies identically to "/Users/foo".
  const normalized = projectRoot.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  return normalized.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function findStoredProjectId(projectRoot: string, rigoriumHome: string): string | null {
  const projectsDir = resolve(rigoriumHome, "projects");
  if (!existsSync(projectsDir)) {
    return null;
  }
  const target = normalizeProjectPathForMarkerComparison(projectRoot);
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const markerPath = resolve(projectsDir, entry.name, ".cwd");
      let marker: string;
      try {
        marker = readFileSync(markerPath, "utf8").trim();
      } catch {
        continue;
      }
      if (!marker || normalizeProjectPathForMarkerComparison(marker) !== target) {
        continue;
      }
      try {
        if (statSync(marker).isDirectory()) {
          return entry.name;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeProjectPathForMarkerComparison(projectRoot: string): string {
  const resolved = resolve(projectRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
