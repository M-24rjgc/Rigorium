import type { RigoriumMarketplaceReference } from "./manifest.js";

export type RigoriumPluginMarketplaceStatus = "resolved" | "deferred";

export type RigoriumMarketplaceResolution = {
  status: RigoriumPluginMarketplaceStatus;
  reference: RigoriumMarketplaceReference;
  reason?: string;
};

export function resolveMarketplaceReference(reference: RigoriumMarketplaceReference): RigoriumMarketplaceResolution {
  if (reference.source === "git" || reference.source === "zip" || reference.source === "mcpb") {
    return {
      status: "deferred",
      reference,
      reason: `${reference.source} installation is not implemented in the local runtime.`,
    };
  }
  return { status: "resolved", reference };
}
