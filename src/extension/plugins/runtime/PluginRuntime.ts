import { resolvePluginDirectories } from "../discovery/PluginDirectoryResolver.js";
import { discoverPluginPaths, discoverSkillPaths } from "../discovery/discoverLocalPlugins.js";
import { loadPluginFromPath, loadSkillFromPath } from "../loading/PluginLoader.js";
import { loadPluginHooks } from "../loading/PluginHookLoader.js";
import { readFileSync } from "node:fs";
import type { LoadedPluginCommand } from "../loading/PluginCommandLoader.js";
import { CapabilityRegistry } from "../../capabilities/CapabilityRegistry.js";
import type { RigoriumCapability } from "../../capabilities/index.js";
import type { RigoriumLoadedPlugin } from "../protocol/plugin.js";
import { PluginRegistry } from "./PluginRegistry.js";
import { truncateMcpInstructionString } from "./truncateMcpString.js";
import type { RigoriumHooksSettings } from "../../hooks/protocol/settings.js";
import type { RigoriumCustomRouter } from "../../../router/customRouter/customRouter.js";

/**
 * Static MCP server contribution shape callers can rely on. Manifests load
 * `mcpServers` as `Record<string, unknown>` to stay forward-compatible, so
 * this type is *advisory* — the runtime only reads `instructions` and falls
 * back gracefully when missing.
 */
export type RigoriumMcpServerStaticSpec = {
  instructions?: string;
  [key: string]: unknown;
};

/**
 * Aggregated B3 instruction entry (always non-empty `instructions`). Exposed
 * as a stricter alias of {@link PluginMcpInstruction} so callers that only
 * care about *populated* entries keep a non-optional `instructions` field.
 */
export type RigoriumMcpInstructionEntry = {
  serverName: string;
  instructions: string;
};

export type PluginRuntimeOptions = {
  projectRoot: string;
  rigoriumHome: string;
  /** Read-only skills shipped with the active Rigorium build. */
  builtinSkillsRoot?: string;
  builtinPlugins?: RigoriumLoadedPlugin[];
  builtinPluginsEnabled?: Record<string, boolean>;
  /**
   * Path to the shared plugin enable config (`~/.rigorium/plugins.json`).
   * The UI toggle writes here; the gateway reads it so a plugin disabled in
   * the UI contributes nothing to the agent (skills/hooks/capabilities/MCP).
   * Missing file → all plugins enabled.
   */
  pluginEnableConfigPath?: string;
};

export type PluginRefreshResult = {
  previous: RigoriumLoadedPlugin[];
  next: RigoriumLoadedPlugin[];
  added: RigoriumLoadedPlugin[];
  removed: RigoriumLoadedPlugin[];
};

export type PluginCommandContribution = {
  name: string;
  description?: string;
  argumentHint?: string;
  namespace?: string;
};

export type PluginSkillContribution = {
  name: string;
  description?: string;
  /** Absolute path to the resolved SKILL.md. */
  path: string;
  namespace?: string;
};

export type PluginMcpInstruction = {
  serverName: string;
  instructions?: string;
};

export type PluginContributionSnapshot = {
  plugins: RigoriumLoadedPlugin[];
  commands: PluginCommandContribution[];
  skills: PluginSkillContribution[];
  outputStyles: LoadedPluginCommand[];
  hooks: RigoriumHooksSettings;
  mcpServers: Record<string, unknown>;
  lspServers: Record<string, unknown>;
  mcpInstructions: PluginMcpInstruction[];
  /** Machine-checkable capability contracts declared by loaded plugins. */
  capabilities: RigoriumCapability[];
};

export class PluginRuntime {
  private readonly registry = new PluginRegistry();
  /** Capability contracts of the currently loaded plugins. */
  private readonly capabilityRegistry = new CapabilityRegistry();

  constructor(private readonly options: PluginRuntimeOptions) {}

  snapshot(): RigoriumLoadedPlugin[] {
    return this.registry.list();
  }

  /** Capability registry of the currently loaded plugins (live). */
  capabilities(): CapabilityRegistry {
    return this.capabilityRegistry;
  }

  mcpServers(): Record<string, unknown> {
    return Object.assign({}, ...this.registry.list().map((plugin) => plugin.mcpServers ?? {})) as Record<string, unknown>;
  }

  /**
   * Read-only static instructions aggregator (deferred-feature §5.3 / B3).
   * - Iterates `mcpServers` from every loaded plugin.
   * - Filters entries with a non-empty `instructions: string` field.
   * - Truncates each entry to {@link truncateMcpInstructionString} (2048 chars).
   * - Returns a stable list sorted by `serverName` (avoids prompt-cache thrash).
   *
   * Once C1 (real MCP runtime) lands, the runtime can layer dynamic
   * instructions on top via the same `getAllMcpInstructions` aggregator
   * surface used by `PluginRuntimeExtensionResolver`.
   */
  getAllMcpInstructions(): RigoriumMcpInstructionEntry[] {
    const entries: RigoriumMcpInstructionEntry[] = [];
    const seen = new Set<string>();
    for (const plugin of this.registry.list()) {
      const servers = plugin.mcpServers;
      if (!servers || typeof servers !== "object") continue;
      for (const [serverName, raw] of Object.entries(servers)) {
        if (seen.has(serverName)) continue;
        if (!raw || typeof raw !== "object") continue;
        const candidate = (raw as RigoriumMcpServerStaticSpec).instructions;
        if (typeof candidate !== "string") continue;
        const trimmed = candidate.trim();
        if (trimmed.length === 0) continue;
        seen.add(serverName);
        entries.push({
          serverName,
          instructions: truncateMcpInstructionString(trimmed),
        });
      }
    }
    entries.sort((a, b) => a.serverName.localeCompare(b.serverName));
    return entries;
  }

  lspServers(): Record<string, unknown> {
    return Object.assign({}, ...this.registry.list().map((plugin) => plugin.lspServers ?? {})) as Record<string, unknown>;
  }

  snapshotContributions(): PluginContributionSnapshot {
    const plugins = this.registry.list();
    return {
      plugins,
      commands: plugins.flatMap((plugin) => (plugin.commands ?? []).map((command) => toCommandContribution(plugin, command))),
      skills: collectSkillContributions(plugins),
      outputStyles: plugins.flatMap((plugin) => plugin.outputStyles ?? []),
      hooks: loadPluginHooks(plugins),
      mcpServers: this.mcpServers(),
      lspServers: this.lspServers(),
      mcpInstructions: this.getAllMcpInstructions(),
      capabilities: this.capabilityRegistry.list(),
    };
  }

  getAllCommands(): PluginCommandContribution[] {
    return this.snapshotContributions().commands;
  }

  getAllSkills(): PluginSkillContribution[] {
    return this.snapshotContributions().skills;
  }

  lookupRouter(extensionId: string): RigoriumCustomRouter | undefined {
    for (const plugin of this.registry.list()) {
      for (const contribution of plugin.routerContributions ?? []) {
        if (contribution.id !== extensionId) {
          continue;
        }
        return contribution.createCustomRouter();
      }
    }
    return undefined;
  }

  async loadSkillPrompt(extensionId: string): Promise<string | undefined> {
    const plugins = sortByResolutionPriority(this.registry.list());

    for (const plugin of plugins) {
      const prompt = plugin.promptContributions?.find((contribution) => contribution.name === extensionId);
      if (prompt) {
        return prompt.content;
      }
    }

    for (const plugin of plugins) {
      const skill = plugin.skills?.find((entry) => entry.name === extensionId);
      if (skill) {
        return skill.content;
      }
    }

    // Resolve namespaced plugin skills by their short name only after exact
    // standalone names have had a chance to resolve.
    for (const plugin of plugins) {
      const skill = plugin.skills?.find((entry) => entry.name.endsWith(`:${extensionId}`));
      if (skill) {
        return skill.content;
      }
    }

    for (const plugin of plugins) {
      const command = plugin.commands?.find((entry) => entry.name === extensionId || entry.name.endsWith(`:${extensionId}`));
      if (command) {
        return command.content;
      }
    }
    return undefined;
  }

  async refresh(): Promise<RigoriumLoadedPlugin[]> {
    return (await this.refreshWithReport()).next;
  }

  async refreshWithReport(): Promise<PluginRefreshResult> {
    const previous = this.registry.list();
    const paths = resolvePluginDirectories({
      projectRoot: this.options.projectRoot,
      rigoriumHome: this.options.rigoriumHome,
    });
    const [discovered, discoveredSkills] = await Promise.all([
      discoverPluginPaths([
        { path: paths.globalPluginsDir, source: "global" },
        { path: paths.projectPluginsDir, source: "project" },
      ]),
      discoverSkillPaths([
        ...(this.options.builtinSkillsRoot
          ? [{ path: this.options.builtinSkillsRoot, source: "builtin" as const }]
          : []),
        { path: paths.globalSkillsDir, source: "global" },
        { path: paths.projectSkillsDir, source: "project" },
      ]),
    ]);
    const [loaded, loadedSkills] = await Promise.all([
      Promise.all(
        discovered.map((plugin) => loadPluginFromPath(plugin.path, plugin.source).catch(() => undefined)),
      ),
      Promise.all(
        discoveredSkills.map((s) => loadSkillFromPath(s.path, s.source).catch(() => undefined)),
      ),
    ]);
    const plugins = [
      ...enabledBuiltinPlugins(this.options.builtinPlugins ?? [], this.options.builtinPluginsEnabled ?? {}),
      ...loaded.filter(isLoadedPlugin),
      ...loadedSkills.filter(isLoadedPlugin),
    ];
    // Apply the UI-side enable toggle: a plugin disabled in `plugins.json`
    // (UI plugin manager) must not contribute skills/hooks/capabilities/MCP
    // to the agent runtime either. Builtins keep their own enable map.
    const enabledByConfig = readPluginEnableConfig(this.options.pluginEnableConfigPath);
    const gated = plugins.filter(
      (plugin) =>
        plugin.source === "builtin" ||
        enabledByConfig[plugin.name] !== false,
    );
    this.registry.replaceAll(gated);
    // Rebuild the capability registry from the freshly loaded plugins so the
    // director/router/UI always see the capabilities of the *current* set.
    this.capabilityRegistry.replaceAll(
      gated.flatMap((plugin) => plugin.capabilities ?? []),
    );
    return {
      previous,
      next: gated,
      added: gated.filter((plugin) => !hasPlugin(previous, plugin)),
      removed: previous.filter((plugin) => !hasPlugin(gated, plugin)),
    };
  }
}

/**
 * Read the shared plugin enable map (`~/.rigorium/plugins.json`, written by
 * the UI plugin manager). Missing/unreadable → everything enabled.
 *
 * Tolerates both shapes the UI has written over time:
 * - flat:   `{ "plugin-a": false }`
 * - nested: `{ "plugin-a": { enabled: false } }`
 * (`ui/server/routes/plugins.js` writes the nested shape; older builds wrote
 * the flat one.) A plugin is disabled iff its entry is `false` or an object
 * with `enabled === false` — anything else (including a missing entry) keeps
 * it enabled.
 */
function readPluginEnableConfig(path: string | undefined): Record<string, unknown> {
  if (!path) {
    return {};
  }
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
  const normalized: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (entry === false) {
      normalized[name] = false;
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const enabled = (entry as { enabled?: unknown }).enabled;
      normalized[name] = enabled === false ? false : true;
    } else {
      normalized[name] = entry;
    }
  }
  return normalized;
}

function isLoadedPlugin(value: RigoriumLoadedPlugin | undefined): value is RigoriumLoadedPlugin {
  return value !== undefined;
}

function enabledBuiltinPlugins(
  plugins: RigoriumLoadedPlugin[],
  enabled: Record<string, boolean>,
): RigoriumLoadedPlugin[] {
  return plugins.filter((plugin) => plugin.source !== "builtin" || enabled[plugin.name] !== false);
}

function hasPlugin(plugins: RigoriumLoadedPlugin[], plugin: RigoriumLoadedPlugin): boolean {
  return plugins.some((candidate) => candidate.name === plugin.name && candidate.source === plugin.source);
}

function toCommandContribution(
  plugin: RigoriumLoadedPlugin,
  command: LoadedPluginCommand,
): PluginCommandContribution {
  return {
    name: command.name,
    description: typeof command.frontmatter.description === "string" ? command.frontmatter.description : undefined,
    argumentHint:
      typeof command.frontmatter["argument-hint"] === "string"
        ? command.frontmatter["argument-hint"]
        : undefined,
    namespace: plugin.name,
  };
}

function toSkillContribution(
  plugin: RigoriumLoadedPlugin,
  skill: LoadedPluginCommand,
): PluginSkillContribution {
  return {
    name: skill.name,
    description: typeof skill.frontmatter.description === "string" ? skill.frontmatter.description : undefined,
    path: skill.path,
    namespace: plugin.name,
  };
}

function sourcePriority(source: RigoriumLoadedPlugin["source"]): number {
  switch (source) {
    case "project":
      return 2;
    case "global":
      return 1;
    case "builtin":
    default:
      return 0;
  }
}

function sortByResolutionPriority(plugins: RigoriumLoadedPlugin[]): RigoriumLoadedPlugin[] {
  return [...plugins].sort((a, b) => sourcePriority(b.source) - sourcePriority(a.source));
}

function collectSkillContributions(plugins: RigoriumLoadedPlugin[]): PluginSkillContribution[] {
  const selected = new Map<string, { contribution: PluginSkillContribution; priority: number }>();
  for (const plugin of plugins) {
    const priority = sourcePriority(plugin.source);
    for (const skill of plugin.skills ?? []) {
      const contribution = toSkillContribution(plugin, skill);
      const existing = selected.get(contribution.name);
      if (!existing || priority >= existing.priority) {
        selected.set(contribution.name, { contribution, priority });
      }
    }
  }
  return [...selected.values()].map((entry) => entry.contribution);
}
