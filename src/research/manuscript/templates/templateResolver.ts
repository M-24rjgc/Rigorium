import type { VenueDefinition, VenueTemplateSource } from "./venueRegistry.js";

/**
 * Year-resolution for venue template sources.
 *
 * Template availability lags the conference calendar: when the user targets
 * ICLR 2027 but the official template is not out yet, the honest answer is
 * "use the closest verified prior year and adjust the year token". This
 * resolver makes that decision *explicit and auditable* (the agent still
 * chooses whether to accept the fallback — nothing is automatic).
 */

export type ResolvedTemplateSource = Readonly<{
  source: VenueTemplateSource;
  /** The year this source is authoritative for (undefined = evergreen). */
  sourceYear?: number;
  /** True when the requested year had no source and a prior year was used. */
  yearAdjusted: boolean;
  /** Requested year minus the source year (0 = exact match). */
  yearGap: number;
  /** Short human-readable rationale. */
  rationale: string;
}>;

export type TemplateResolution = Readonly<{
  venue: VenueDefinition;
  requestedYear?: number;
  /** Exact-match sources first, then prior-year fallbacks, newest first. */
  candidates: readonly ResolvedTemplateSource[];
  /** True when no source matches the requested year (fallback needed). */
  fallbackRequired: boolean;
}>;

/**
 * Resolve template sources for a venue and requested year.
 *
 * Strategy (open by design — it only ranks, the agent decides):
 * 1. exact-year sources first;
 * 2. then evergreen sources (no year — journal styles, shared ACL files);
 * 3. then prior years, newest first (gap ≤ 3), each marked `yearAdjusted`.
 */
export function resolveTemplateSources(
  venue: VenueDefinition,
  requestedYear?: number,
): TemplateResolution {
  const exact: ResolvedTemplateSource[] = [];
  const evergreen: ResolvedTemplateSource[] = [];
  const prior: ResolvedTemplateSource[] = [];

  for (const source of venue.sources) {
    if (source.year === undefined) {
      evergreen.push(
        Object.freeze<ResolvedTemplateSource>({
          source,
          yearAdjusted: false,
          yearGap: 0,
          rationale: "Evergreen template source (no specific year).",
        }),
      );
      continue;
    }
    if (requestedYear !== undefined && source.year === requestedYear) {
      exact.push(
        Object.freeze<ResolvedTemplateSource>({
          source,
          sourceYear: source.year,
          yearAdjusted: false,
          yearGap: 0,
          rationale: `Exact match for ${requestedYear}.`,
        }),
      );
      continue;
    }
    if (requestedYear === undefined || source.year < requestedYear) {
      const gap = requestedYear === undefined ? 0 : requestedYear - source.year;
      if (gap <= 3) {
        prior.push(
          Object.freeze<ResolvedTemplateSource>({
            source,
            sourceYear: source.year,
            yearAdjusted: requestedYear !== undefined,
            yearGap: gap,
            rationale:
              requestedYear === undefined
                ? `Prior-year source (${source.year}).`
                : `Requested ${requestedYear} has no official template yet; closest prior verified source is ${source.year} (gap ${gap}). Adjust the year token after downloading.`,
          }),
        );
      }
    }
  }

  prior.sort((left, right) => (right.sourceYear ?? 0) - (left.sourceYear ?? 0));
  const fallbackRequired = requestedYear !== undefined && exact.length === 0;
  return Object.freeze({
    venue,
    requestedYear,
    candidates: Object.freeze([...exact, ...evergreen, ...prior]),
    fallbackRequired,
  });
}

/** Shortest rationale for the top candidate (for tool output). */
export function topCandidate(resolution: TemplateResolution): ResolvedTemplateSource | undefined {
  return resolution.candidates[0];
}
