import { randomUUID } from "node:crypto";
import type { PermissionResult } from "../../permission/index.js";
import { mergeLiteratureSearchResults } from "../../research/literature/candidatePool.js";
import { createArxivSource, normalizeArxivClassifications } from "../../research/literature/arxivSource.js";
import { createCrossrefSource } from "../../research/literature/crossrefSource.js";
import { createOpenAlexSource } from "../../research/literature/openAlexSource.js";
import { readResearchSettings } from "../../research/settings.js";
import type {
  LiteratureSearchResult,
  LiteratureSource,
  LiteratureSearchArtifact,
  SearchClassification,
  SearchPlan,
  SearchQueryVariant,
  SearchQueryVariantCategory,
} from "../../research/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";

export type LiteratureSearchInput = {
  query: string;
  /** Agent-selected alternative terminology for the same natural-language goal. */
  queryVariants?: Array<{
    query: string;
    /** The tool reserves primary for the main query. */
    category?: Exclude<SearchQueryVariantCategory, "primary">;
    rationale?: string;
  }>;
  limit?: number;
  fromYear?: number;
  toYear?: number;
  sort?: "relevance" | "cited_by_count" | "publication_date";
  classifications?: SearchClassification[];
};

export type CreateLiteratureSearchToolOptions = {
  /** OpenAlex endpoint override, primarily for controlled tests. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /** Crossref endpoint override, primarily for controlled tests. */
  crossrefEndpoint?: string;
  crossrefFetchImpl?: typeof fetch;
  /** arXiv endpoint override, primarily for controlled tests. */
  arxivEndpoint?: string;
  arxivFetchImpl?: typeof fetch;
  /** Test-only shorter arXiv gate interval. Production retains 3 seconds. */
  arxivMinimumIntervalMs?: number;
};

export function createLiteratureSearchTool(
  options: CreateLiteratureSearchToolOptions = {},
): PilotDeckToolDefinition<LiteratureSearchInput, LiteratureSearchArtifact> {
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
        queryVariants: {
          type: "array",
          maxItems: 3,
          description: "Optional alternative query formulations selected by the agent when a synonym, abbreviation, historical term, or adjacent field materially improves recall. The user does not need to provide these as commands.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: {
              query: { type: "string" },
              category: {
                type: "string",
                enum: ["synonym", "abbreviation", "historical_term", "adjacent_field"],
                description: "Optional reason category. The primary query is assigned primary automatically.",
              },
              rationale: { type: "string" },
            },
          },
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
        classifications: {
          type: "array",
          maxItems: 8,
          description: "Optional structured arXiv subject-class constraints selected from the research goal.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["scheme", "include"],
            properties: {
              scheme: { type: "string", enum: ["arxiv"] },
              include: {
                type: "array",
                minItems: 1,
                maxItems: 32,
                items: {
                  type: "string",
                  pattern: "^[a-z][a-z-]*(?:\\.[A-Za-z0-9-]+)?$",
                },
              },
            },
          },
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

      const maxLimit = settings.literature.budget.maxResultsPerSearch;
      const requestedLimit = finiteInteger(input.limit) ?? settings.literature.search.defaultLimit;
      const limit = Math.max(1, Math.min(maxLimit, requestedLimit));
      const fromYear = boundedSearchYear(input.fromYear, settings.literature.search.fromYear);
      const toYear = boundedSearchYear(input.toYear, settings.literature.search.toYear);
      if (fromYear && toYear && fromYear > toYear) {
        throw new PilotDeckToolRuntimeError("invalid_tool_input", "fromYear cannot be after toYear.");
      }
      let classifications: string[];
      try {
        classifications = normalizeArxivClassifications(input.classifications);
      } catch (error) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          "Invalid arXiv classifications: " + (error instanceof Error ? error.message : String(error)),
        );
      }
      const queryVariants = buildSearchQueryVariants(query, input.queryVariants, limit);

      const sources: LiteratureSource[] = [];
      let disabledArxivResult: LiteratureSearchResult | undefined;
      if (settings.literature.sources.openalex.enabled) {
        sources.push(createOpenAlexSource({
          endpoint: options.endpoint,
          fetchImpl: options.fetchImpl,
          timeoutMs: settings.literature.budget.requestTimeoutMs,
          mailto: settings.literature.sources.openalex.mailto,
          includeTopicEdges: settings.literature.map.showTopicEdges,
        }));
      }
      if (settings.literature.sources.arxiv.enabled) {
        sources.push(createArxivSource({
          endpoint: options.arxivEndpoint,
          fetchImpl: options.arxivFetchImpl ?? options.fetchImpl,
          timeoutMs: settings.literature.budget.requestTimeoutMs,
          ...(options.arxivMinimumIntervalMs !== undefined ? { minimumIntervalMs: options.arxivMinimumIntervalMs } : {}),
        }));
      } else if (classifications.length > 0) {
        const retrievedAt = (context.now?.() ?? new Date()).toISOString();
        disabledArxivResult = {
          papers: [],
          edges: [],
          source: {
            id: "arxiv",
            name: "arXiv",
            status: "disabled",
            retrievedAt,
            resultCount: 0,
            coverage: "arXiv classification constraints were not searched because arXiv is disabled in Research Settings.",
            warnings: ["arXiv classification constraints were not applied because arXiv is disabled."],
          },
        };
      }
      if (settings.literature.sources.crossref.enabled) {
        sources.push(createCrossrefSource({
          endpoint: options.crossrefEndpoint,
          fetchImpl: options.crossrefFetchImpl ?? options.fetchImpl,
          timeoutMs: settings.literature.budget.requestTimeoutMs,
          mailto: settings.literature.sources.crossref.mailto,
        }));
      }
      if (sources.length === 0) {
        throw new PilotDeckToolRuntimeError(
          "setup_required",
          "No academic metadata source is enabled in Research Settings.",
        );
      }

      const plan: SearchPlan = {
        query,
        limit,
        ...(fromYear ? { fromYear } : {}),
        ...(toYear ? { toYear } : {}),
        sort: input.sort ?? settings.literature.search.sort,
        ...(classifications.length > 0 ? {
          classifications: [{ scheme: "arxiv" as const, include: classifications }],
        } : {}),
        sourceIds: [
          ...(settings.literature.sources.openalex.enabled ? ["openalex"] : []),
          ...(settings.literature.sources.arxiv.enabled || disabledArxivResult ? ["arxiv"] : []),
          ...(settings.literature.sources.crossref.enabled ? ["crossref"] : []),
        ],
        queryVariants,
      };
      // Sources are independent metadata requests. A failed source resolves to
      // a structured result, so every query-source attempt preserves successful
      // siblings and remains auditable after candidates are merged.
      const results = (await Promise.all(queryVariants.map(async (variant) => {
        const variantPlan: SearchPlan = {
          ...plan,
          query: variant.query,
          limit: variant.requestLimit,
        };
        const variantResults = await Promise.all(sources.map((source) => source.search(variantPlan, {
          signal: context.abortSignal,
          now: context.now,
        })));
        return variantResults.map((result) => annotateQueryVariant(result, variant.id));
      }))).flat();
      if (disabledArxivResult) {
        results.push(...queryVariants.map((variant) => annotateQueryVariant(disabledArxivResult, variant.id)));
      }
      const pool = mergeLiteratureSearchResults({
        requestedSourceIds: plan.sourceIds,
        results,
        limit,
        sourcePriority: ["openalex", "arxiv", "crossref"],
      });
      const artifact: LiteratureSearchArtifact = {
        schemaVersion: 1,
        kind: "literature_search",
        artifactId: `literature-${randomUUID()}`,
        createdAt: (context.now?.() ?? new Date()).toISOString(),
        intent: { text: query },
        plan,
        papers: pool.papers,
        edges: pool.edges,
        sources: pool.sources,
        queryAudit: results.map((result) => result.source),
        coverage: pool.coverage,
        presentation: {
          autoOpen: settings.literature.map.autoOpen,
        },
      };
      return formatToolOutput(artifact);
    },
  };
}

function formatToolOutput(artifact: LiteratureSearchArtifact): PilotDeckToolExecutionOutput<LiteratureSearchArtifact> {
  const sourceSummary = artifact.sources.map((source) => `${source.name} (${source.status})`).join(", ");
  const lines = [
    `Academic literature search: ${artifact.plan.query}`,
    ...(artifact.plan.queryVariants && artifact.plan.queryVariants.length > 1
      ? [`Query variants: ${artifact.plan.queryVariants.length}`]
      : []),
    `Sources: ${sourceSummary || "unknown"}`,
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
      provider: artifact.plan.sourceIds.length === 1 ? artifact.plan.sourceIds[0] : "multi-source",
      resultCount: artifact.papers.length,
      relationshipCount: artifact.edges.length,
      coverageStatus: artifact.coverage.status,
    },
  };
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function buildSearchQueryVariants(
  primaryQuery: string,
  alternatives: LiteratureSearchInput["queryVariants"],
  totalLimit: number,
): SearchQueryVariant[] {
  if (alternatives !== undefined && !Array.isArray(alternatives)) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", "queryVariants must be an array when provided.");
  }
  if ((alternatives?.length ?? 0) > 3) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", "literature_search accepts at most three alternative query variants.");
  }

  const candidates: Array<{
    query: string;
    category?: SearchQueryVariantCategory;
    rationale?: string;
  }> = [{ query: primaryQuery, category: "primary" }];
  const fingerprints = new Set([queryFingerprint(primaryQuery)]);
  for (const alternative of alternatives ?? []) {
    if (!isRecord(alternative) || typeof alternative.query !== "string") {
      throw new PilotDeckToolRuntimeError("invalid_tool_input", "Each query variant requires a non-empty query string.");
    }
    const query = alternative.query.trim();
    if (!query) {
      throw new PilotDeckToolRuntimeError("invalid_tool_input", "Each query variant requires a non-empty query string.");
    }
    let category: Exclude<SearchQueryVariantCategory, "primary"> | undefined;
    if (alternative.category !== undefined) {
      const rawCategory: unknown = alternative.category;
      if (!isSearchQueryVariantCategory(rawCategory) || rawCategory === "primary") {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          "A query variant category must be synonym, abbreviation, historical_term, or adjacent_field.",
        );
      }
      category = rawCategory;
    }

    if (alternative.rationale !== undefined && typeof alternative.rationale !== "string") {
      throw new PilotDeckToolRuntimeError("invalid_tool_input", "A query variant rationale must be text when provided.");
    }
    const rationale = alternative.rationale?.trim();
    const fingerprint = queryFingerprint(query);
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    candidates.push({
      query,
      ...(category ? { category } : {}),
      ...(rationale ? { rationale } : {}),
    });
  }

  // Every executed formulation needs at least one result slot. When the user
  // requests fewer total results than formulations, keep the primary query
  // and only the earliest alternatives that fit inside that total budget.
  const executableCandidates = candidates.slice(0, Math.max(1, totalLimit));
  const requestLimits = allocateVariantLimits(totalLimit, executableCandidates.length);
  return executableCandidates.map((candidate, index) => ({
    id: index === 0 ? "primary" : `alternative-${index}`,
    query: candidate.query,
    requestLimit: requestLimits[index] ?? 1,
    ...(candidate.category ? { category: candidate.category } : {}),
    ...(candidate.rationale ? { rationale: candidate.rationale } : {}),
  }));
}

function isSearchQueryVariantCategory(value: unknown): value is SearchQueryVariantCategory {
  return value === "primary"
    || value === "synonym"
    || value === "abbreviation"
    || value === "historical_term"
    || value === "adjacent_field";
}

function allocateVariantLimits(totalLimit: number, count: number): number[] {
  const base = Math.floor(totalLimit / count);
  const remainder = totalLimit % count;
  return Array.from({ length: count }, (_, index) => Math.max(1, base + (index < remainder ? 1 : 0)));
}

function annotateQueryVariant(result: LiteratureSearchResult, queryVariantId: string): LiteratureSearchResult {
  return {
    ...result,
    source: { ...result.source, queryVariantId },
    papers: result.papers.map((paper) => ({
      ...paper,
      provenance: paper.provenance.map((provenance) => ({ ...provenance, queryVariantId })),
    })),
  };
}

function queryFingerprint(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedSearchYear(value: unknown, fallback: number | null): number | undefined {
  const year = finiteInteger(value);
  if (year === undefined) return fallback ?? undefined;
  const currentMax = new Date().getUTCFullYear() + 2;
  return Math.min(currentMax, Math.max(1800, year));
}
