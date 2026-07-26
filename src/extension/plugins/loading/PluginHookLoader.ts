import type { RigoriumHooksSettings } from "../../hooks/protocol/settings.js";
import type { RigoriumLoadedPlugin } from "../protocol/plugin.js";

export function loadPluginHooks(plugins: RigoriumLoadedPlugin[]): RigoriumHooksSettings {
  const settings: RigoriumHooksSettings = {};
  for (const plugin of plugins) {
    for (const [event, matchers] of Object.entries(plugin.hooksConfig ?? {}) as Array<
      [keyof RigoriumHooksSettings, NonNullable<RigoriumHooksSettings[keyof RigoriumHooksSettings]>]
    >) {
      settings[event] = [
        ...(settings[event] ?? []),
        ...matchers.map((matcher) => ({
          ...matcher,
          pluginName: plugin.name,
          pluginId: `${plugin.name}@${plugin.source}`,
          pluginRoot: plugin.path,
        })),
      ];
    }
  }
  return settings;
}
