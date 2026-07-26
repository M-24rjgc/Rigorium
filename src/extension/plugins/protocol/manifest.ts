import type { RigoriumHooksSettings } from "../../hooks/protocol/settings.js";

export type RigoriumPluginManifest = {
  name: string;
  version?: string;
  description?: string;
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
