import { randomUUID } from "node:crypto";
import type { PermissionResult } from "../../permission/index.js";
import { mergeLiteratureSearchResults } from "../../research/literature/candidatePool.js";
import { createArxivSource, normalizeArxivClassifications } from "../../research/literature/arxivSource.js";
import { createCrossrefSource } from "../../research/literature/crossrefSource.js";
import { createOpenAlexSource } from "../../research/literature/openAlexSource.js";
import { createOpenReviewSource } from "../../research/literature/openReviewSource.js";
import {
  buildLiteratureSearchCoverageAudit,
  type LiteratureSearchCoverageSourceScope,
} from "../../research/literature/coverageAudit.js";
import { buildLiteratureTerminology, sanitizeRetrievalUrl } from "../../research/literature/terminology.js";
import { readResearchSettings } from "../../research/settings.js";
import type {
  LiteratureSearchResult,
  LiteratureSource,
  LiteratureSearchArtifact,
  LiteratureTerminologySourceRecord,
  LiteratureTerminologyTaxonomyLevelRecord,
  ResearchPaper,
  SearchVenueConstraint,
  SearchVenueSet,
  SearchVenueStatus,
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
  /**
   * Agent-selected conference constraints derived from the user's natural
   * language request. This is structured tool input, not a user slash command.
   */
  venueSet?: {
    id: string;
    name: string;
    venues: Array<{
      id: string;
      name: string;
      aliases?: string[];
      year?: number;
      track?: string;
      status?: SearchVenueStatus;
      accepted?: boolean;
      /** Explicit official OpenReview `content.venueid`, never inferred. */
      openReviewVenueId?: string;
    }>;
  };
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
  /** Official OpenReview endpoint override, primarily for controlled tests. */
  openReviewEndpoint?: string;
  openReviewFetchImpl?: typeof fetch;
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
        venueSet: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "venues"],
          description: "Optional named conference venue set selected from the user's request. Use an explicit OpenReview venue ID only when the official decision status is known; never infer acceptance from arXiv or generic metadata.",
          properties: {
            id: { type: "string", maxLength: 128 },
            name: { type: "string", maxLength: 200 },
            venues: {
              type: "array",
              minItems: 1,
              maxItems: 12,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "name"],
                properties: {
                  id: { type: "string", maxLength: 128 },
                  name: { type: "string", maxLength: 200 },
                  aliases: { type: "array", maxItems: 8, items: { type: "string", maxLength: 200 } },
                  year: { type: "number" },
                  track: { type: "string", maxLength: 200 },
                  status: { type: "string", enum: ["accepted", "submission"] },
                  accepted: { type: "boolean", description: "Legacy boolean form of status; true maps to accepted and false maps to submission." },
                  openReviewVenueId: { type: "string", maxLength: 512 },
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
      let venueSet: SearchVenueSet | undefined;
      try {
        venueSet = normalizeVenueSet(input.venueSet);
      } catch (error) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          "Invalid venue set: " + (error instanceof Error ? error.message : String(error)),
        );
      }
      const queryVariants = buildSearchQueryVariants(query, input.queryVariants, limit);

      const sources: LiteratureSource[] = [];
      let disabledArxivResult: LiteratureSearchResult | undefined;
      let disabledOpenReviewResult: LiteratureSearchResult | undefined;
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
      const venueStatusRequested = venueSet?.venues.some((venue) => venue.status !== undefined) ?? false;
      const officialOpenReviewVenueRequested = venueSet?.venues.some((venue) => Boolean(venue.openReviewVenueId)) ?? false;
      if (officialOpenReviewVenueRequested && settings.literature.sources.openreview?.enabled !== false) {
        sources.push(createOpenReviewSource({
          endpoint: options.openReviewEndpoint,
          fetchImpl: options.openReviewFetchImpl ?? options.fetchImpl,
          timeoutMs: settings.literature.budget.requestTimeoutMs,
        }));
      } else if (venueStatusRequested || officialOpenReviewVenueRequested) {
        const retrievedAt = (context.now?.() ?? new Date()).toISOString();
        const reason = officialOpenReviewVenueRequested
          ? "OpenReview is disabled in Research Settings, so official venue status was not retrieved."
          : "No explicit official OpenReview venue ID was supplied, so requested venue status remains unverified.";
        disabledOpenReviewResult = {
          papers: [],
          edges: [],
          source: {
            id: "openreview",
            name: "OpenReview",
            status: "disabled",
            retrievedAt,
            resultCount: 0,
            coverage: reason,
            warnings: [reason],
            ...(venueSet ? {
              applied: {
                venueSet: {
                  id: venueSet.id,
                  name: venueSet.name,
                  constraintIds: venueSet.venues.map((venue) => venue.id),
                  requestedStatuses: requestedVenueStatuses(venueSet),
                  enforcement: "official" as const,
                },
              },
            } : {}),
          },
        };
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
        ...(venueSet ? { venueSet } : {}),
        sourceIds: [
          ...(settings.literature.sources.openalex.enabled ? ["openalex"] : []),
          ...(settings.literature.sources.arxiv.enabled || disabledArxivResult ? ["arxiv"] : []),
          ...(settings.literature.sources.crossref.enabled ? ["crossref"] : []),
          ...(officialOpenReviewVenueRequested || disabledOpenReviewResult ? ["openreview"] : []),
        ],
        queryVariants,
      };
      // Generic metadata sources are independent for each terminology variant.
      // OpenReview venue IDs do not change with terminology, so execute those
      // official requests once for the primary formulation rather than
      // multiplying calls against the venue API.
      const variantSources = sources.filter((source) => source.id !== "openreview");
      const officialVenueSources = sources.filter((source) => source.id === "openreview");
      const results = (await Promise.all(queryVariants.map(async (variant) => {
        const variantPlan: SearchPlan = {
          ...plan,
          query: variant.query,
          limit: variant.requestLimit,
        };
        const variantResults = await Promise.all(variantSources.map((source) => source.search(variantPlan, {
          signal: context.abortSignal,
          now: context.now,
        })));
        return variantResults.map((result) => annotateQueryVariant(
          applyVenueMetadataFilter(sanitizeSearchResultUrls(result), venueSet),
          variant.id,
        ));
      }))).flat();
      if (officialVenueSources.length > 0) {
        const officialResults = await Promise.all(officialVenueSources.map((source) => source.search(plan, {
          signal: context.abortSignal,
          now: context.now,
        })));
        results.push(...officialResults.map((result) => annotateQueryVariant(
          sanitizeSearchResultUrls(result),
          "primary",
        )));
      }
      if (disabledArxivResult) {
        results.push(...queryVariants.map((variant) =>
          annotateQueryVariant(sanitizeSearchResultUrls(disabledArxivResult), variant.id),
        ));
      }
      if (disabledOpenReviewResult) {
        // OpenReview venue evidence is requested only for the primary query;
        // do not manufacture alternate-query audit rows when the source is disabled.
        results.push(annotateQueryVariant(sanitizeSearchResultUrls(disabledOpenReviewResult), "primary"));
      }
      const pool = mergeLiteratureSearchResults({
        requestedSourceIds: plan.sourceIds,
        results,
        limit,
        sourcePriority: ["openreview", "openalex", "arxiv", "crossref"],
      });
      const terminology = buildLiteratureTerminology(pool.terminologyObservations);
      const queryAudit = results.map((result) => result.source);
      const coverageAudit = buildLiteratureSearchCoverageAudit({
        plan,
        queryAudit,
        sourceScopes: sourceCoverageScopes(variantSources, officialVenueSources, disabledArxivResult, disabledOpenReviewResult),
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
        queryAudit,
        coverageAudit,
        ...(terminology ? { terminology } : {}),
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
  const variantCoverage = artifact.coverageAudit?.queryVariants ?? [];
  const lines = [
    `Academic literature search: ${artifact.plan.query}`,
    ...(artifact.plan.queryVariants && artifact.plan.queryVariants.length > 1
      ? [`Query variants: ${artifact.plan.queryVariants.length}`]
      : []),
    ...(variantCoverage.length > 1
      ? [`Variant coverage: ${variantCoverage.map((item) => `${item.queryVariantId} (${item.status})`).join(", ")}`]
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

function sourceCoverageScopes(
  variantSources: LiteratureSource[],
  officialVenueSources: LiteratureSource[],
  disabledArxivResult: LiteratureSearchResult | undefined,
  disabledOpenReviewResult: LiteratureSearchResult | undefined,
): LiteratureSearchCoverageSourceScope[] {
  return [
    ...variantSources.map((source) => ({ sourceId: source.id, scope: "per_query_variant" as const })),
    ...officialVenueSources.map((source) => ({ sourceId: source.id, scope: "primary_query_only" as const })),
    ...(disabledArxivResult ? [{ sourceId: disabledArxivResult.source.id, scope: "per_query_variant" as const }] : []),
    ...(disabledOpenReviewResult ? [{ sourceId: disabledOpenReviewResult.source.id, scope: "primary_query_only" as const }] : []),
  ];
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

export function buildSearchQueryVariants(
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
    ...(result.terminologyObservations ? {
      terminologyObservations: result.terminologyObservations.map((observation) => ({
        ...observation,
        queryVariantId,
      })),
    } : {}),
  };
}

/** Ensure only sanitized URLs are retained in the persisted artifact path. */
function sanitizeSearchResultUrls(result: LiteratureSearchResult): LiteratureSearchResult {
  const { queryUrl: _sourceQueryUrl, ...sourceWithoutQueryUrl } = result.source;
  const sourceQueryUrl = sanitizeRetrievalUrl(result.source.queryUrl);
  return {
    ...result,
    source: {
      ...sourceWithoutQueryUrl,
      ...(sourceQueryUrl ? { queryUrl: sourceQueryUrl } : {}),
    },
    papers: result.papers.map((paper) => ({
      ...paper,
      provenance: paper.provenance.map((provenance) => {
        const { queryUrl: _provenanceQueryUrl, ...provenanceWithoutQueryUrl } = provenance;
        const queryUrl = sanitizeRetrievalUrl(provenance.queryUrl);
        return {
          ...provenanceWithoutQueryUrl,
          ...(queryUrl ? { queryUrl } : {}),
        };
      }),
    })),
    ...(result.terminologyObservations ? {
      terminologyObservations: result.terminologyObservations.flatMap((observation) => {
        const retrievalUrl = sanitizeRetrievalUrl(observation.retrievalUrl);
        if (!retrievalUrl) return [];
        return [{
          ...observation,
          retrievalUrl,
          ...(observation.primaryTopic ? {
            primaryTopic: sanitizeTerminologySourceRecord(observation.primaryTopic),
          } : {}),
          keywords: observation.keywords.map(sanitizeTerminologySourceRecord),
          topics: observation.topics.map(sanitizeTerminologySourceRecord),
        }];
      }),
    } : {}),
  };
}

function sanitizeTerminologySourceRecord(record: LiteratureTerminologySourceRecord): LiteratureTerminologySourceRecord {
  const { providerUrl: _providerUrl, subfield, field, ...rest } = record;
  const providerUrl = sanitizeRetrievalUrl(record.providerUrl);
  return {
    ...rest,
    ...(providerUrl ? { providerUrl } : {}),
    ...(subfield ? { subfield: sanitizeTaxonomyLevelRecord(subfield) } : {}),
    ...(field ? { field: sanitizeTaxonomyLevelRecord(field) } : {}),
  };
}

function sanitizeTaxonomyLevelRecord(
  record: LiteratureTerminologyTaxonomyLevelRecord,
): LiteratureTerminologyTaxonomyLevelRecord {
  const { providerUrl: _providerUrl, ...rest } = record;
  const providerUrl = sanitizeRetrievalUrl(record.providerUrl);
  return { ...rest, ...(providerUrl ? { providerUrl } : {}) };
}

export function normalizeVenueSet(value: LiteratureSearchInput["venueSet"]): SearchVenueSet | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("venueSet must be an object.");
  const id = venueSetId(value.id, "venueSet.id");
  const name = boundedText(value.name, "venueSet.name", 200);
  if (!Array.isArray(value.venues) || value.venues.length === 0 || value.venues.length > 12) {
    throw new Error("venueSet.venues must contain between 1 and 12 venues.");
  }

  const seenIds = new Set<string>();
  const venues = value.venues.map((rawVenue, index): SearchVenueConstraint => {
    if (!isRecord(rawVenue)) throw new Error(`venueSet.venues[${index}] must be an object.`);
    const venueId = venueSetId(rawVenue.id, `venueSet.venues[${index}].id`);
    if (seenIds.has(venueId)) throw new Error(`venueSet contains duplicate venue id '${venueId}'.`);
    seenIds.add(venueId);
    const venueName = boundedText(rawVenue.name, `venueSet.venues[${index}].name`, 200);
    const aliases = normalizeVenueAliases(rawVenue.aliases, index, venueName);
    const year = normalizeVenueYear(rawVenue.year, index);
    const track = optionalBoundedText(rawVenue.track, `venueSet.venues[${index}].track`, 200);
    const status = normalizeVenueStatus(rawVenue.status, rawVenue.accepted, index);
    const openReviewVenueId = normalizeOpenReviewVenueId(rawVenue.openReviewVenueId, index);
    return {
      id: venueId,
      name: venueName,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(year !== undefined ? { year } : {}),
      ...(track ? { track } : {}),
      ...(status ? { status } : {}),
      ...(openReviewVenueId ? { openReviewVenueId } : {}),
    };
  });
  return { id, name, venues };
}

function venueSetId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.trim())) {
    throw new Error(`${label} must use 1-128 letters, numbers, dots, underscores, or hyphens.`);
  }
  return value.trim().toLowerCase();
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty text.`);
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters.`);
  return normalized;
}

function optionalBoundedText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedText(value, label, maximum);
}

function normalizeVenueAliases(value: unknown, index: number, venueName: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error(`venueSet.venues[${index}].aliases must contain at most 8 strings.`);
  }
  const aliases = value.map((alias, aliasIndex) => boundedText(
    alias,
    `venueSet.venues[${index}].aliases[${aliasIndex}]`,
    200,
  ));
  const seen = new Set<string>([venueFingerprint(venueName)]);
  return aliases.filter((alias) => {
    const fingerprint = venueFingerprint(alias);
    if (!fingerprint || seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

function normalizeVenueYear(value: unknown, index: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const currentMax = new Date().getUTCFullYear() + 2;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1800 || value > currentMax) {
    throw new Error(`venueSet.venues[${index}].year must be an integer between 1800 and ${currentMax}.`);
  }
  return value;
}

function normalizeVenueStatus(value: unknown, accepted: unknown, index: number): SearchVenueStatus | undefined {
  if (value !== undefined && value !== "accepted" && value !== "submission") {
    throw new Error(`venueSet.venues[${index}].status must be accepted or submission.`);
  }
  if (accepted !== undefined && typeof accepted !== "boolean") {
    throw new Error(`venueSet.venues[${index}].accepted must be a boolean when provided.`);
  }
  const legacy = typeof accepted === "boolean" ? (accepted ? "accepted" : "submission") : undefined;
  if (value !== undefined && legacy !== undefined && value !== legacy) {
    throw new Error(`venueSet.venues[${index}] has conflicting status and accepted fields.`);
  }
  return value ?? legacy;
}

function normalizeOpenReviewVenueId(value: unknown, index: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const venueId = boundedText(value, `venueSet.venues[${index}].openReviewVenueId`, 512);
  if (!/^[A-Za-z0-9._/() -]+$/u.test(venueId)) {
    throw new Error(`venueSet.venues[${index}].openReviewVenueId contains unsupported characters.`);
  }
  return venueId;
}

function requestedVenueStatuses(venueSet: SearchVenueSet): SearchVenueStatus[] {
  return [...new Set(venueSet.venues.flatMap((venue) => venue.status ? [venue.status] : []))];
}

/**
 * Generic sources expose venue strings and publication years, not programme
 * decisions. Filter those records conservatively and mark their decision state
 * unknown; only OpenReview's explicit official venue ID can carry an official
 * accepted/submission status.
 */
function applyVenueMetadataFilter(
  result: LiteratureSearchResult,
  venueSet: SearchVenueSet | undefined,
): LiteratureSearchResult {
  if (!venueSet || result.source.id === "openreview" || result.source.status !== "ok") return result;
  const originalCount = result.papers.length;
  const matches = result.papers.flatMap((paper) => {
    const constraint = venueSet.venues.find((candidate) => matchesVenueMetadata(paper, candidate));
    if (!constraint || !paper.venue) return [];
    return [{
      ...paper,
      venueEvidence: mergeVenueEvidence([
        ...(paper.venueEvidence ?? []),
        {
          sourceId: result.source.id,
          evidence: "metadata" as const,
          venue: paper.venue,
          ...(paper.year !== undefined ? { year: paper.year } : {}),
          ...(constraint.track ? { track: constraint.track } : {}),
          status: "unknown" as const,
        },
      ]),
    }];
  });
  const requestedStatuses = requestedVenueStatuses(venueSet);
  const warnings = [
    ...(result.source.warnings ?? []),
    ...(requestedStatuses.length > 0
      ? ["Conference decision status is metadata-unverified for this source; it was not inferred from bibliographic or arXiv records."]
      : []),
  ];
  return {
    ...result,
    papers: matches,
    source: {
      ...result.source,
      ...(result.source.partial || requestedStatuses.length > 0 ? { partial: true } : {}),
      resultCount: matches.length,
      coverage: `Venue metadata filter retained ${matches.length}/${originalCount} ${result.source.name} records for '${venueSet.name}'. ${result.source.coverage}`,
      ...(warnings.length > 0 ? { warnings } : {}),
      applied: {
        ...result.source.applied,
        venueSet: {
          id: venueSet.id,
          name: venueSet.name,
          constraintIds: venueSet.venues.map((venue) => venue.id),
          ...(requestedStatuses.length > 0 ? { requestedStatuses } : {}),
          enforcement: "metadata",
        },
      },
    },
  };
}

function matchesVenueMetadata(paper: ResearchPaper, constraint: SearchVenueConstraint): boolean {
  if (!paper.venue) return false;
  if (constraint.year !== undefined && paper.year !== constraint.year) return false;
  const venue = venueFingerprint(paper.venue);
  const names = [constraint.name, ...(constraint.aliases ?? [])].map(venueFingerprint).filter(Boolean);
  if (!names.some((name) => venue === name || (name.length >= 4 && venue.includes(name)))) return false;
  if (!constraint.track) return true;
  const track = venueFingerprint(constraint.track);
  return track.length >= 3 && venue.includes(track);
}

function venueFingerprint(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function mergeVenueEvidence<T extends NonNullable<ResearchPaper["venueEvidence"]>[number]>(evidence: T[]): T[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = [
      item.sourceId,
      item.evidence,
      item.venue,
      item.year ?? "",
      item.track ?? "",
      item.status,
      item.officialVenueId ?? "",
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
