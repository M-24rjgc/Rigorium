import { randomUUID } from "node:crypto";
import type { PermissionResult } from "../../permission/index.js";
import { createOpenAlexSource } from "../../research/literature/openAlexSource.js";
import { readResearchSettings } from "../../research/settings.js";
import type { ResearchArtifact, SearchPlan } from "../../research/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";

export type LiteratureSearchInput = {
  query: string;
  limit?: number;
  fromYear?: number;
  toYear?: number;
  sort?: "relevance" | "cited_by_count" | "publication_date";
};

export type CreateLiteratureSearchToolOptions = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
};

export function createLiteratureSearchTool(
  options: CreateLiteratureSearchToolOptions = {},
): PilotDeckToolDefinition<LiteratureSearchInput, ResearchArtifact> {
  return {
    name: "literature_search",
    title: "Search Academic Literature",
    description: `Search real academic literature and produce a structured research artifact for Rigorium's research panel.

Use this tool when the user asks for papers, prior work, related work, a literature review, research directions, novelty checking, seminal work, recent academic work, or evidence for a research question. Translate the user's natural-language goal into a focused query and optional year range. Do not ask the user to type a slash command.

The result includes normalized paper identities, source provenance, real citation links among returned papers, and clearly marked inferred shared-topic links. This tool only searches metadata; it does not modify Zotero. Formal Zotero writes require a separate explicit user action in the research panel.`,
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Focused academic literature query derived from the user's natural-language research goal.",
        },
        limit: {
          type: "number",
          description: "Number of ranked papers to retrieve. Uses Research Settings when omitted.",
        },
        fromYear: {
          type: "number",
          description: "Optional inclusive publication start year.",
        },
        toYear: {
          type: "number",
          description: "Optional inclusive publication end year.",
        },
        sort: {
          type: "string",
          enum: ["relevance", "cited_by_count", "publication_date"],
          description: "Ranking strategy. Defaults to the project or global Research Settings value.",
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
        toolName: "literature_search",
        message: "Academic literature search requires network access.",
      },
      request: {
        toolCallId: "",
        toolName: "literature_search",
        inputSummary: "academic literature search",
        reason: {
          type: "tool",
          toolName: "literature_search",
          message: "Academic literature search requires network access.",
        },
        options: [
          { id: "allow_once", label: "Allow search" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    execute: async (input, context) => {
      const query = input.query?.trim();
      if (!query) {
        throw new PilotDeckToolRuntimeError("invalid_tool_input", "literature_search requires a non-empty query.");
      }

      const settingsSnapshot = await readResearchSettings({
        pilotHome: context.env?.PILOT_HOME,
        projectRoot: context.cwd,
      });
      const settings = settingsSnapshot.effective;
      if (!settings.literature.enabled || !settings.literature.sources.openalex.enabled) {
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

      const maxLimit = settings.literature.budget.maxResultsPerSearch;
      const requestedLimit = finiteInteger(input.limit) ?? settings.literature.search.defaultLimit;
      const limit = Math.max(1, Math.min(maxLimit, requestedLimit));
      const fromYear = finiteInteger(input.fromYear) ?? settings.literature.search.fromYear ?? undefined;
      const toYear = finiteInteger(input.toYear) ?? settings.literature.search.toYear ?? undefined;
      if (fromYear && toYear && fromYear > toYear) {
        throw new PilotDeckToolRuntimeError("invalid_tool_input", "fromYear cannot be after toYear.");
      }

      const plan: SearchPlan = {
        query,
        limit,
        ...(fromYear ? { fromYear } : {}),
        ...(toYear ? { toYear } : {}),
        sort: input.sort ?? settings.literature.search.sort,
        sourceIds: ["openalex"],
      };
      const source = createOpenAlexSource({
        endpoint: options.endpoint,
        fetchImpl: options.fetchImpl,
        timeoutMs: settings.literature.budget.requestTimeoutMs,
        mailto: settings.literature.sources.openalex.mailto,
        includeTopicEdges: settings.literature.map.showTopicEdges,
      });
      const result = await source.search(plan, { signal: context.abortSignal, now: context.now });
      const warnings = result.source.status === "error" && result.source.error
        ? [result.source.error]
        : [];
      const artifact: ResearchArtifact = {
        schemaVersion: 1,
        kind: "literature_search",
        artifactId: `literature-${randomUUID()}`,
        createdAt: (context.now?.() ?? new Date()).toISOString(),
        intent: { text: query },
        plan,
        papers: result.papers,
        edges: result.edges,
        sources: [result.source],
        coverage: {
          status: result.source.status === "error" ? "failed" : "complete",
          resultCount: result.papers.length,
          warnings,
        },
        presentation: {
          autoOpen: settings.literature.map.autoOpen,
        },
      };
      return formatToolOutput(artifact);
    },
  };
}

function formatToolOutput(artifact: ResearchArtifact): PilotDeckToolExecutionOutput<ResearchArtifact> {
  const source = artifact.sources[0];
  const lines = [
    `Academic literature search: ${artifact.plan.query}`,
    `Source: ${source?.name ?? "unknown"} (${source?.status ?? "unknown"})`,
    `Results: ${artifact.papers.length}`,
    `Relationships: ${artifact.edges.length}`,
  ];
  if (artifact.coverage.warnings.length > 0) {
    lines.push(`Coverage warning: ${artifact.coverage.warnings.join(" ")}`);
  }
  if (artifact.papers.length > 0) {
    lines.push("", "Top papers:");
    for (const paper of artifact.papers.slice(0, 10)) {
      lines.push(`- ${paper.title}${paper.year ? ` (${paper.year})` : ""} — ${paper.url ?? paper.id}`);
    }
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
