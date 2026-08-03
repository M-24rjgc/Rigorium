import type { InputModality } from "../../model/index.js";
import type { CapabilityDeclaration, RigoriumCapability } from "./types.js";

const MODALITY_VALUES: readonly string[] = ["text", "image", "pdf", "audio"];

function isModality(value: unknown): value is InputModality {
  return typeof value === "string" && (MODALITY_VALUES as readonly string[]).includes(value);
}

function normalizeModalityRequirements(value: unknown): readonly InputModality[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const modalities = value.filter(isModality);
  return modalities.length > 0 ? modalities : undefined;
}

function normalizeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return strings.length > 0 ? strings : undefined;
}

/**
 * Promote a single manifest declaration (legacy string or contract object)
 * into a capability contract. Invalid fields are dropped silently rather than
 * failing the whole plugin load — capability declarations are advisory at this
 * layer; the registry validation pass reports dangling dependencies.
 */
export function parseCapabilityDeclaration(
  raw: CapabilityDeclaration,
  pluginName: string,
): RigoriumCapability | undefined {
  if (typeof raw === "string") {
    const id = raw.trim();
    if (id.length === 0) {
      return undefined;
    }
    return { id, plugin: pluginName };
  }
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (id.length === 0) {
    return undefined;
  }
  return {
    id,
    name: typeof record.name === "string" ? record.name : undefined,
    description: typeof record.description === "string" ? record.description : undefined,
    accepts: normalizeStringArray(record.accepts),
    produces: normalizeStringArray(record.produces),
    dependsOnCapabilityIds: normalizeStringArray(record.dependsOnCapabilityIds),
    modalityRequirements: normalizeModalityRequirements(record.modalityRequirements),
    concurrencySafe: typeof record.concurrencySafe === "boolean" ? record.concurrencySafe : undefined,
    estimatedCostUnits:
      typeof record.estimatedCostUnits === "number" && Number.isFinite(record.estimatedCostUnits)
        ? record.estimatedCostUnits
        : undefined,
    estimatedDurationMs:
      typeof record.estimatedDurationMs === "number" && Number.isFinite(record.estimatedDurationMs)
        ? record.estimatedDurationMs
        : undefined,
    requiresUserConfirmation:
      typeof record.requiresUserConfirmation === "boolean" ? record.requiresUserConfirmation : undefined,
    plugin: pluginName,
  };
}

/**
 * Parse the `settings.capabilities` value of a plugin manifest into contracts.
 * Accepts:
 *   - an array of strings ("legacy" declarations),
 *   - an array of contract objects,
 *   - a mix of both.
 * Returns an empty array for anything else (missing / malformed settings).
 */
export function parsePluginCapabilities(
  rawSettings: unknown,
  pluginName: string,
): RigoriumCapability[] {
  const settings = rawSettings as Record<string, unknown> | undefined;
  if (!settings || typeof settings !== "object") {
    return [];
  }
  const declared = settings.capabilities;
  if (!Array.isArray(declared)) {
    return [];
  }
  const capabilities: RigoriumCapability[] = [];
  const seen = new Set<string>();
  for (const entry of declared) {
    if (typeof entry === "string" || (typeof entry === "object" && entry !== null)) {
      const capability = parseCapabilityDeclaration(entry as CapabilityDeclaration, pluginName);
      if (capability && !seen.has(capability.id)) {
        seen.add(capability.id);
        capabilities.push(capability);
      }
    }
  }
  return capabilities;
}
