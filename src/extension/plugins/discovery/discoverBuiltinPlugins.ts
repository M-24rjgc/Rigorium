import type { RigoriumLoadedPlugin } from "../protocol/plugin.js";

export function discoverBuiltinPlugins(plugins: RigoriumLoadedPlugin[] = []): RigoriumLoadedPlugin[] {
  return plugins.filter((plugin) => plugin.source === "builtin");
}
