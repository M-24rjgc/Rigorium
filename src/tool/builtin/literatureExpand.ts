import { randomUUID } from "node:crypto";
import type { PermissionResult } from "../../permission/index.js";
import { normalizeDoi } from "../../research/identity.js";
import {
  expandOpenAlexCitations,
  normalizeOpenAlexWorkId,
  OpenAlexSeedResolutionError,
} from "../../research/literature/openAlexExpansion.js";
import { readResearchSettings } from "../../research/settings.js";
import type {
  LiteratureExpansionArtifact,
  LiteratureExpansionDirection,
  LiteratureExpansionSeed,
} from "../../research/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolDefinition, PilotDeckToolExecutionOutput } from "../protocol/types.js";

export type LiteratureExpandInput = {
  seed: LiteratureExpansionSeed;
  directions?: LiteratureExpansionDirection[];
  limitPerDirection?: number;
};

export type CreateLiteratureExpandToolOptions = {
  /** OpenAlex works endpoint override, primarily for controlled tests. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_DIRECTIONS: LiteratureExpansionDirection[] = ["references", "citations"];
const OPENALEX_OR_FILTER_MAX = 100;

/**
 * Expands a selected paper's real OpenAlex citation neighborhood. The agent
 * invokes this from a natural-language request or an existing research node;
 * users never need a slash command and the tool never mutates Zotero.
 */
export function createLiteratureExpandTool(
  options: CreateLiteratureExpandToolOptions = {},
): PilotDeckToolDefinition<LiteratureExpandInput, LiteratureExpansionArtifact> {
  return {
    name: "literature_expand",
    title: "Expand Literature Citations",
    description: `Expand a selected academic paper through real references and citing papers, then produce a structured research artifact for Rigorium's research panel.

Use this when the user asks to follow references, inspect who cites a paper, broaden an existing literature node, or continue a research thread from a paper already in the current artifact. Pass the selected paper's OpenAlex ID or DOI from that artifact. The user does not need to type a slash command. This is metadata-only and never writes to Zotero.`,
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["seed"],
      additionalProperties: false,
      properties: {
        seed: {
          type: "object",
          additionalProperties: false,
          description: "A selected paper. openAlexId or doi is required; display fields are only used for verification.",
          properties: {
            openAlexId: { type: "string" },
            doi: { type: "string" },
            title: { type: "string" },
            year: { type: "number" },
            authors: { type: "array", items: { type: "string" }, maxItems: 50 },
          },
        },
        directions: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: { type: "string", enum: ["references", "citations"] },
          description: "Defaults to both directions. Citation edges always point from a citing work to a cited work.",
        },
        limitPerDirection: {
          type: "number",
          description: "Maximum papers retained for each direction; bounded by Research Settings and OpenAlex's OR-filter limit.",
        },
      },
    },
    maxResultBytes: 500_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "ask",
      reason: {
        type: "tool",
        toolName: "literature_expand",
        message: "Citation expansion requires network access.",
      },
      request: {
        toolCallId: "",
        toolName: "literature_expand",
        inputSummary: "academic citation expansion",
        reason: {
          type: "tool",
          toolName: "literature_expand",
          message: "Citation expansion requires network access.",
        },
        options: [
          { id: "allow_once", label: "Allow expansion" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    execute: async (input, context) => {
      const seed = normalizeSeed(input.seed);
      const directions = normalizeDirections(input.directions);
      const settingsSnapshot = await readResearchSettings({
        pilotHome: context.env?.PILOT_HOME,
        projectRoot: context.cwd,
      });
      const settings = settingsSnapshot.effective;
      if (!settings.literature.enabled) {
        throw new PilotDeckToolRuntimeError(
          "setup_required",
          "Academic literature search is disabled in Research Settings.",
        );
      }
      if (!settings.privacy.allowRemoteMetadataSearch) {
        throw new PilotDeckToolRuntimeError(
          "permission_denied",
          "Remote metadata search is disabled by Research Settings privacy controls.",
        );
      }
      if (!settings.literature.sources.openalex.enabled) {
        throw new PilotDeckToolRuntimeError(
          "setup_required",
          "OpenAlex citation expansion is disabled in Research Settings.",
        );
      }

      const configuredLimit = finiteInteger(input.limitPerDirection) ?? settings.literature.search.defaultLimit;
      const limitPerDirection = Math.max(
        1,
        Math.min(settings.literature.budget.maxResultsPerSearch, OPENALEX_OR_FILTER_MAX, configuredLimit),
      );
      let expansion;
      try {
        expansion = await expandOpenAlexCitations({
          seed,
          directions,
          limitPerDirection,
          signal: context.abortSignal,
          now: context.now,
        }, {
          endpoint: options.endpoint,
          fetchImpl: options.fetchImpl,
          timeoutMs: settings.literature.budget.requestTimeoutMs,
          mailto: settings.literature.sources.openalex.mailto,
        });
      } catch (error) {
        if (error instanceof OpenAlexSeedResolutionError) {
          throw new PilotDeckToolRuntimeError("tool_execution_failed", error.message, {
            ...(error.queryUrl ? { queryUrl: error.queryUrl } : {}),
          });
        }
        throw error;
      }

      const succeeded = expansion.directions.some((direction) => direction.status === "ok" || direction.status === "partial");
      const coverageStatus = !succeeded
        ? "failed"
        : expansion.directions.every((direction) => direction.status === "ok")
          ? "complete"
          : "partial";
      const warnings = uniqueStrings([
        ...(expansion.source.warnings ?? []),
        ...expansion.directions.flatMap((direction) => direction.warnings ?? []),
        ...expansion.directions
          .filter((direction) => direction.status === "error" || direction.status === "unavailable")
          .map((direction) => `${direction.direction}: ${direction.error ?? "OpenAlex did not return usable data."}`),
      ]);
      const artifact: LiteratureExpansionArtifact = {
        schemaVersion: 1,
        kind: "literature_expansion",
        artifactId: `literature-expansion-${randomUUID()}`,
        createdAt: (context.now?.() ?? new Date()).toISOString(),
        intent: { text: `Citation expansion for ${expansion.seed.title}` },
        plan: {
          seed,
          directions,
          limitPerDirection,
          sourceIds: ["openalex"],
        },
        seedPaperId: expansion.seed.id,
        papers: expansion.papers,
        edges: expansion.edges,
        sources: [expansion.source],
        directions: expansion.directions,
        coverage: {
          status: coverageStatus,
          resultCount: expansion.papers.length,
          warnings,
          requestedSourceIds: ["openalex"],
          successfulSourceIds: succeeded ? ["openalex"] : [],
          failedSourceIds: succeeded ? [] : ["openalex"],
        },
        presentation: { autoOpen: settings.literature.map.autoOpen },
      };
      return formatToolOutput(artifact);
    },
  };
}

function normalizeSeed(value: LiteratureExpansionSeed | undefined): LiteratureExpansionSeed {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", "literature_expand requires a seed object.");
  }
  const openAlexId = normalizeOpenAlexWorkId(value.openAlexId);
  const doi = normalizeDoi(value.doi);
  if (value.openAlexId !== undefined && !openAlexId) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "seed.openAlexId must be an OpenAlex W identifier or canonical OpenAlex work URL.",
    );
  }
  if (value.doi !== undefined && !doi) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "seed.doi must be a valid DOI.",
    );
  }
  if (!openAlexId && !doi) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "literature_expand requires seed.openAlexId or seed.doi as a valid strong identifier.",
    );
  }
  return {
    ...(openAlexId ? { openAlexId } : {}),
    ...(doi ? { doi } : {}),
    ...(stringValue(value.title) ? { title: stringValue(value.title) } : {}),
    ...(finiteInteger(value.year) !== undefined ? { year: finiteInteger(value.year) } : {}),
    ...(Array.isArray(value.authors)
      ? { authors: value.authors.map(stringValue).filter((author): author is string => Boolean(author)).slice(0, 50) }
      : {}),
  };
}

function normalizeDirections(value: LiteratureExpansionDirection[] | undefined): LiteratureExpansionDirection[] {
  const candidate = value ?? DEFAULT_DIRECTIONS;
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", "literature_expand requires at least one citation direction.");
  }
  const directions = [...new Set(candidate)];
  if (directions.some((direction) => direction !== "references" && direction !== "citations")) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", "directions must contain only references and citations.");
  }
  return directions;
}

function formatToolOutput(artifact: LiteratureExpansionArtifact): PilotDeckToolExecutionOutput<LiteratureExpansionArtifact> {
  const lines = [
    `Citation expansion: ${artifact.papers.find((paper) => paper.id === artifact.seedPaperId)?.title ?? artifact.seedPaperId}`,
    `Results: ${artifact.papers.length} papers, ${artifact.edges.length} real citation relationships`,
    ...artifact.directions.map((direction) => {
      const total = direction.totalMatches !== undefined ? ` of ${direction.totalMatches}` : "";
      const suffix = direction.truncated ? ", truncated" : "";
      return `- ${direction.direction}: ${direction.status}; ${direction.resultCount}${total} papers${suffix}`;
    }),
  ];
  if (artifact.coverage.warnings.length > 0) {
    lines.push(`Coverage warning: ${artifact.coverage.warnings.join(" ")}`);
  }
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "json", value: artifact },
    ],
    data: artifact,
    metadata: {
      provider: "openalex",
      resultCount: artifact.papers.length,
      relationshipCount: artifact.edges.length,
      coverageStatus: artifact.coverage.status,
    },
  };
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 4_096) : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
