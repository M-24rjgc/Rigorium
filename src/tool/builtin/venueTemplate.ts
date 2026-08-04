import { VenueTemplateRegistry } from "../../research/manuscript/templates/VenueTemplateRegistry.js";
import type { VenueDefinition, VenueTemplateSource } from "../../research/manuscript/templates/index.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult, RigoriumToolInputSchema } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";

/**
 * venue_template — the open venue/template query surface for the agent.
 *
 * The agent — not a pipeline — decides which venue to target and which
 * template source to trust. This tool answers the queries that decision
 * needs: what venues exist (built-in + project custom), which template
 * sources resolve for a venue+year (with explicit year-fallback rationale),
 * and how to persist a verified pin back into the project registry.
 */

export type VenueTemplateToolInput =
  | Readonly<{ action: "list"; filter?: string }>
  | Readonly<{ action: "resolve"; venue: string; year?: number }>
  | Readonly<{
      action: "pin";
      venue: string;
      year: number;
      source: Omit<VenueTemplateSource, "verified">;
    }>;

export type VenueTemplateToolResult =
  | Readonly<{ action: "list"; venues: readonly VenueSummary[] }>
  | Readonly<{ action: "resolve"; resolution: import("../../research/manuscript/templates/index.js").TemplateResolution }>
  | Readonly<{ action: "pin"; pinned: VenueTemplateSource; venue: string; year: number }>;

export type VenueSummary = Readonly<{
  id: string;
  kind: VenueDefinition["kind"];
  displayName: string;
  publisher?: string;
  verifiedSources: number;
  unverifiedSources: number;
  availableYears: readonly (number | undefined)[];
  defaultPageLimit?: number;
  anonymousSubmission?: boolean;
}>;

export type CreateVenueTemplateToolOptions = Readonly<{
  maxResultBytes?: number;
  /** Injectable registry factory (tests). */
  registryFactory?: (projectRoot: string) => VenueTemplateRegistry;
}>;

export function createVenueTemplateTool(
  options: CreateVenueTemplateToolOptions = {},
): RigoriumToolDefinition<VenueTemplateToolInput, VenueTemplateToolResult> {
  return {
    name: "venue_template",
    title: "Query and Pin Venue Templates",
    description: `List the built-in publication venues (conferences and journals), resolve which template sources exist for a venue and year (with explicit year-fallback rationale), or pin a verified template source back into the project venue registry.

Use action=list to see available venues (ICLR, ICML, NeurIPS, ACL, EMNLP, NAACL, CVPR, ICCV, AAAI, COLM, JMLR, TMLR, TPAMI, IEEE Transactions, Neural Computation, Nature Machine Intelligence, Science Advances, PNAS, plus any project-custom venues). Use action=resolve with the target venue and year to get candidate template sources ranked by recency, including prior-year fallbacks marked yearAdjusted=true. Use action=pin only after you have downloaded a template and verified its integrity (content hash, required files) — this records the pin in the project registry so later rendering uses the verified source. The choice of venue, year, and source is yours; this tool never forces a template.`,
    kind: "custom",
    inputSchema: venueTemplateInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 2_000_000,
    isReadOnly: (input) => input.action !== "pin",
    isConcurrencySafe: () => true,
    isOpenWorld: () => false,
    validateInput: async (input) => validateInput(input),
    execute: async (input, context) => {
      try {
        return formatOutput(await executeAction(input, context, options));
      } catch (error) {
        throw new RigoriumToolRuntimeError("invalid_tool_input", `Invalid venue template action: ${messageOf(error)}`);
      }
    },
  };
}

async function executeAction(
  input: VenueTemplateToolInput,
  context: RigoriumToolRuntimeContext,
  options: CreateVenueTemplateToolOptions,
): Promise<VenueTemplateToolResult> {
  requireActionInput(input);
  const projectRoot = context.cwd;
  const registry = options.registryFactory
    ? options.registryFactory(projectRoot)
    : new VenueTemplateRegistry({ projectRoot });

  if (input.action === "list") {
    const venues = await registry.listVenues();
    const filter = input.filter?.trim().toLowerCase();
    const summaries = venues
      .filter((venue) => !filter || venue.id.includes(filter) || venue.displayName.toLowerCase().includes(filter))
      .map(toSummary);
    return Object.freeze({ action: "list", venues: Object.freeze(summaries) });
  }

  if (input.action === "resolve") {
    const resolution = await registry.resolve(input.venue, input.year);
    if (!resolution) {
      throw new RigoriumToolRuntimeError(
        "invalid_tool_input",
        `Unknown venue "${input.venue}". Use action=list to see available venues, or register it in the project venues registry.`,
      );
    }
    return Object.freeze({ action: "resolve", resolution });
  }

  // action === "pin"
  const venue = await registry.getVenue(input.venue);
  if (!venue) {
    throw new RigoriumToolRuntimeError(
      "invalid_tool_input",
      `Unknown venue "${input.venue}". Cannot pin a template to an unregistered venue.`,
    );
  }
  const pinned: VenueTemplateSource = Object.freeze({
    ...input.source,
    year: input.year,
    verified: true,
  });
  // pinSource runs the read-merge-write under a module-level lock with a
  // fresh disk read inside, so concurrent pins merge instead of silently
  // dropping each other.
  await registry.pinSource({ venueId: input.venue, source: pinned });
  return Object.freeze({ action: "pin", pinned, venue: input.venue, year: input.year });
}

function toSummary(venue: VenueDefinition): VenueSummary {
  const verifiedSources = venue.sources.filter((source) => source.verified).length;
  return Object.freeze({
    id: venue.id,
    kind: venue.kind,
    displayName: venue.displayName,
    publisher: venue.publisher,
    verifiedSources,
    unverifiedSources: venue.sources.length - verifiedSources,
    availableYears: Object.freeze(
      [...new Set(venue.sources.map((source) => source.year))].sort((a, b) => (b ?? 0) - (a ?? 0)),
    ),
    defaultPageLimit: venue.defaultPageLimit,
    anonymousSubmission: venue.anonymousSubmission,
  });
}

function requireActionInput(input: unknown): asserts input is VenueTemplateToolInput {
  if (!input || typeof input !== "object" || typeof (input as { action?: unknown }).action !== "string") {
    throw new RigoriumToolRuntimeError("invalid_tool_input", "venue_template requires an action: list, resolve, or pin.");
  }
}

async function validateInput(input: VenueTemplateToolInput): Promise<RigoriumToolValidationResult> {
  try {
    requireActionInput(input);
    if (input.action === "list" && input.filter !== undefined && typeof input.filter !== "string") {
      return { ok: false, issues: [issue("filter must be a string when provided")] };
    }
    if (input.action === "resolve") {
      if (typeof input.venue !== "string" || input.venue.trim() === "") {
        return { ok: false, issues: [issue("resolve requires a non-empty venue id")] };
      }
      if (input.year !== undefined && (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100)) {
        return { ok: false, issues: [issue("year must be an integer between 2000 and 2100")] };
      }
    }
    if (input.action === "pin") {
      if (typeof input.venue !== "string" || input.venue.trim() === "") {
        return { ok: false, issues: [issue("pin requires a non-empty venue id")] };
      }
      if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) {
        return { ok: false, issues: [issue("pin requires an integer year between 2000 and 2100")] };
      }
      if (!input.source || typeof input.source.officialPageUrl !== "string") {
        return { ok: false, issues: [issue("pin requires a source with officialPageUrl")] };
      }
    }
    return { ok: true, input };
  } catch {
    return { ok: false, issues: [issue("invalid venue_template input")] };
  }
}

function issue(message: string): RigoriumToolValidationIssue {
  return { path: "", code: "invalid_type", message };
}

function venueTemplateInputSchema(): RigoriumToolInputSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["list", "resolve", "pin"] },
      filter: { type: "string" },
      venue: { type: "string" },
      year: { type: "integer", minimum: 2000, maximum: 2100 },
      source: {
        type: "object",
        properties: {
          officialPageUrl: { type: "string" },
          archiveUrl: { type: "string" },
          repositoryUrl: { type: "string" },
          commit: { type: "string" },
          archiveSha256: { type: "string" },
          archiveBytes: { type: "integer" },
          requiredFiles: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
        },
      },
    },
  };
}

function formatOutput(result: VenueTemplateToolResult): RigoriumToolExecutionOutput<VenueTemplateToolResult> {
  return { content: [{ type: "text", text: renderSummary(result) }], data: result };
}

function renderSummary(result: VenueTemplateToolResult): string {
  if (result.action === "list") {
    const lines = result.venues.map((venue) => {
      const years = venue.availableYears.map((year) => (year === undefined ? "evergreen" : String(year))).join(",") || "none";
      return `${venue.id} [${venue.kind}] ${venue.displayName} — sources: ${venue.verifiedSources} verified / ${venue.unverifiedSources} unverified — years: ${years}${venue.defaultPageLimit ? ` — page limit ${venue.defaultPageLimit}` : ""}${venue.anonymousSubmission ? " — anonymous" : ""}`;
    });
    return lines.length > 0
      ? `Available venues (${result.venues.length}):\n${lines.join("\n")}`
      : "No venues match the filter.";
  }
  if (result.action === "resolve") {
    const resolution = result.resolution;
    const lines = resolution.candidates.map((candidate, index) => {
      const verified = candidate.source.verified ? "VERIFIED" : "unverified";
      const adjusted = candidate.yearAdjusted ? " [year-adjusted]" : "";
      return `${index + 1}. ${resolution.venue.id} ${candidate.sourceYear ?? "evergreen"} (${verified}${adjusted}) ${candidate.rationale} ${candidate.source.archiveUrl ?? candidate.source.officialPageUrl}`;
    });
    return [
      `Venue: ${resolution.venue.id} (${resolution.venue.displayName})`,
      `Requested year: ${resolution.requestedYear ?? "unspecified"}`,
      `Fallback required: ${resolution.fallbackRequired}`,
      lines.length > 0 ? lines.join("\n") : "No template sources found for this venue/year.",
    ].join("\n");
  }
  return `Pinned verified template for ${result.venue} ${result.year}: ${result.pinned.archiveUrl ?? result.pinned.officialPageUrl}`;
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
