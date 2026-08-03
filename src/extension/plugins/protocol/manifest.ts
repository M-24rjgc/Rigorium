import type { RigoriumHooksSettings } from "../../hooks/protocol/settings.js";

/**
 * Unified plugin manifest (v2).
 *
 * One manifest shape serves both plugin surfaces:
 * - the gateway ("TS") side consumes `skills` / `hooks` / `commands` /
 *   `outputStyles` / `mcpServers` / `settings.capabilities`, and
 * - the Web UI side consumes `displayName` / `entry` / `server` / `slot` /
 *   `permissions` to mount a tab and proxy RPC to a plugin subprocess.
 *
 * A plugin may be either or both; fields are optional in every direction.
 * Discovery reads `plugin.json` first, falling back to the legacy
 * `manifest.json` name, so previously-installed UI plugins keep working.
 */
export type RigoriumPluginManifest = {
  name: string;
  version?: string;
  description?: string;
  /** UI display name (falls back to `name` in the UI surface). */
  displayName?: string;
  author?: string;
  /** UI icon key (e.g. a lucide icon name). */
  icon?: string;
  /** UI plugin type: "react" | "module". */
  type?: string;
  /** UI slot the plugin mounts into (currently "tab"). */
  slot?: string;
  /**
   * Relative path (no "..", not absolute) to the browser entry module that
   * exports `mount(container, api)` / `unmount(container)`.
   */
  entry?: string;
  /** Relative path to the plugin server entry run as a subprocess. */
  server?: string;
  /** String permission keys the UI plugin may request. */
  permissions?: string[];
  commands?: string | string[];
  agents?: string | string[];
  skills?: string | string[];
  hooks?: string | RigoriumHooksSettings;
  mcpServers?: Record<string, unknown>;
  lspServers?: Record<string, unknown>;
  outputStyles?: string | string[];
  marketplace?: RigoriumMarketplaceReference;
  mcpb?: string;
  settings?: Record<string, unknown>;
};

export type RigoriumMarketplaceReference = {
  name: string;
  plugin: string;
  version?: string;
  source?: "marketplace" | "git" | "zip" | "mcpb";
  url?: string;
};
