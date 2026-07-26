import type {
  RigoriumToolAvailability,
  RigoriumToolAvailabilityContext,
  RigoriumToolDefinition,
} from "../protocol/types.js";
import { ToolRegistry } from "./ToolRegistry.js";

export type RigoriumUnavailableToolDiagnostic = {
  toolName: string;
  code: Exclude<RigoriumToolAvailability, { ok: true }>["code"];
  reason: string;
};

export type FilterAvailableToolsResult = {
  registry: ToolRegistry;
  unavailable: RigoriumUnavailableToolDiagnostic[];
};

export async function filterAvailableTools(
  registry: ToolRegistry,
  context: RigoriumToolAvailabilityContext,
): Promise<FilterAvailableToolsResult> {
  const filtered = new ToolRegistry();
  const unavailable: RigoriumUnavailableToolDiagnostic[] = [];
  const checkCache = new Map<
    NonNullable<RigoriumToolDefinition["checkAvailability"]>,
    Promise<RigoriumToolAvailability>
  >();

  for (const tool of registry.list()) {
    const availability = await resolveToolAvailability(tool, context, checkCache);
    if (availability.ok) {
      filtered.register(tool);
      continue;
    }

    unavailable.push({
      toolName: tool.name,
      code: availability.code,
      reason: availability.reason,
    });
  }

  return { registry: filtered, unavailable };
}

async function resolveToolAvailability(
  tool: RigoriumToolDefinition,
  context: RigoriumToolAvailabilityContext,
  cache: Map<NonNullable<RigoriumToolDefinition["checkAvailability"]>, Promise<RigoriumToolAvailability>>,
): Promise<RigoriumToolAvailability> {
  const check = tool.checkAvailability;
  if (!check) {
    return { ok: true };
  }

  let promise = cache.get(check);
  if (!promise) {
    promise = Promise.resolve()
      .then(() => check(context))
      .catch((error): RigoriumToolAvailability => ({
        ok: false,
        code: "failed_check",
        reason: error instanceof Error ? error.message : String(error),
      }));
    cache.set(check, promise);
  }

  return promise;
}
