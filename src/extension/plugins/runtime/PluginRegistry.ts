import type { RigoriumLoadedPlugin } from "../protocol/plugin.js";

export class PluginRegistry {
  private readonly plugins = new Map<string, RigoriumLoadedPlugin>();

  replaceAll(plugins: RigoriumLoadedPlugin[]): void {
    this.plugins.clear();
    for (const plugin of plugins) {
      this.plugins.set(`${plugin.name}@${plugin.source}`, plugin);
    }
  }

  list(): RigoriumLoadedPlugin[] {
    return [...this.plugins.values()];
  }
}
