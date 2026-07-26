import type { RigoriumExtensionPaths } from "../../../rigorium/paths.js";
import { getRigoriumExtensionPaths } from "../../../rigorium/paths.js";

export type PluginDirectoryResolverInput = {
  projectRoot: string;
  rigoriumHome: string;
};

export function resolvePluginDirectories(input: PluginDirectoryResolverInput): RigoriumExtensionPaths {
  return getRigoriumExtensionPaths(input.projectRoot, input.rigoriumHome);
}
