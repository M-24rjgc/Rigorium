import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RigoriumPluginSourceKind } from "../protocol/plugin.js";

export type DiscoveredPluginPath = {
  path: string;
  source: RigoriumPluginSourceKind;
};

export async function discoverPluginPaths(
  directories: Array<{ path: string; source: RigoriumPluginSourceKind }>,
): Promise<DiscoveredPluginPath[]> {
  const discovered: DiscoveredPluginPath[] = [];
  for (const directory of directories) {
    let entries: string[];
    try {
      entries = await readdir(directory.path);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const pluginPath = join(directory.path, entry);
      try {
        if ((await stat(pluginPath)).isDirectory()) {
          discovered.push({ path: pluginPath, source: directory.source });
        }
      } catch {
        continue;
      }
    }
  }
  return discovered;
}

/**
 * Discovers standalone skill directories (containing SKILL.md without a
 * plugin manifest). Mirrors the legacy standalone skill directory convention.
 * Directories that carry `plugin.json`/`manifest.json` are skipped — they are
 * full plugins and must not double-load as standalone skills.
 */
export async function discoverSkillPaths(
  directories: Array<{ path: string; source: RigoriumPluginSourceKind }>,
): Promise<DiscoveredPluginPath[]> {
  const discovered: DiscoveredPluginPath[] = [];
  for (const directory of directories) {
    let entries: string[];
    try {
      entries = await readdir(directory.path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillDir = join(directory.path, entry);
      try {
        if (!(await stat(skillDir)).isDirectory()) continue;
        const files = await readdir(skillDir);
        if (files.some((f) => /^skill\.md$/i.test(f))) {
          if (files.some((f) => f === "plugin.json" || f === "manifest.json")) {
            continue;
          }
          discovered.push({ path: skillDir, source: directory.source });
        }
      } catch {
        continue;
      }
    }
  }
  return discovered;
}
