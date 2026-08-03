import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { parsePluginCapabilities } from "../../capabilities/parseCapabilities.js";
import { parseHooksConfig } from "../../hooks/config/parseHooksConfig.js";
import type { RigoriumLoadedPlugin } from "../protocol/plugin.js";
import type { RigoriumPluginManifest } from "../protocol/manifest.js";
import { parsePluginManifest } from "../config/parsePluginManifest.js";
import {
  getPluginCommandName,
  isSkillFile,
  parseMarkdownFrontmatter,
  type LoadedPluginCommand,
} from "../loading/PluginCommandLoader.js";

const __filename = fileURLToPath(import.meta.url);
const BUILTIN_DIR = resolve(__filename, "..");

let _cache: RigoriumLoadedPlugin[] | undefined;

export function loadBuiltinPlugins(): RigoriumLoadedPlugin[] {
  if (_cache) return _cache;
  _cache = loadBuiltinPluginsFromDirectory(BUILTIN_DIR);
  return _cache;
}

export function loadBuiltinPluginsFromDirectory(builtinDir: string): RigoriumLoadedPlugin[] {
  const plugins: RigoriumLoadedPlugin[] = [];
  try {
    for (const name of readdirSync(builtinDir).sort((left, right) => left.localeCompare(right, "en"))) {
      const pluginPath = resolve(builtinDir, name);
      if (!statSync(pluginPath).isDirectory()) continue;
      const manifestPath = resolve(pluginPath, "plugin.json");
      try {
        statSync(manifestPath);
      } catch {
        continue;
      }
      const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
      const manifest = parsePluginManifest(raw);
      plugins.push({
        name: manifest.name,
        path: pluginPath,
        source: "builtin",
        manifest,
        hooksConfig:
          manifest.hooks && typeof manifest.hooks === "object"
            ? parseHooksConfig(manifest.hooks).settings
            : undefined,
        commands: loadConfiguredMarkdownSync(pluginPath, manifest, manifest.commands, "commands"),
        skills: loadConfiguredMarkdownSync(pluginPath, manifest, manifest.skills, "skills"),
        outputStyles: loadConfiguredMarkdownSync(pluginPath, manifest, manifest.outputStyles, "output-styles"),
        mcpServers: manifest.mcpServers,
        lspServers: manifest.lspServers,
        capabilities: parsePluginCapabilities(manifest.settings, manifest.name),
      });
    }
  } catch { /* builtin dir scan failed — fine, no builtins */ }
  return plugins;
}

function loadConfiguredMarkdownSync(
  pluginPath: string,
  manifest: RigoriumPluginManifest,
  configured: string | string[] | undefined,
  fallbackDir: "commands" | "skills" | "output-styles",
): LoadedPluginCommand[] {
  const directories = configured === undefined ? [fallbackDir] : Array.isArray(configured) ? configured : [configured];
  return directories.flatMap((directory) => {
    const baseDir = resolve(pluginPath, directory);
    return collectMarkdownFilesSync(baseDir).map((filePath) => {
      const parsed = parseMarkdownFrontmatter(readFileSync(filePath, "utf8"));
      return {
        name: getPluginCommandName(manifest.name, filePath, baseDir),
        path: filePath,
        content: parsed.content,
        frontmatter: parsed.frontmatter,
        isSkill: isSkillFile(filePath),
      };
    });
  });
}

function collectMarkdownFilesSync(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"));
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = resolve(directory, entry);
    let entryStat;
    try {
      entryStat = statSync(fullPath);
    } catch {
      continue;
    }
    if (entryStat.isDirectory()) {
      files.push(...collectMarkdownFilesSync(fullPath));
    } else if (/\.md$/iu.test(basename(fullPath))) {
      files.push(fullPath);
    }
  }
  return files;
}
