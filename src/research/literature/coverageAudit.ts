import type {
  LiteratureSearchCoverageAudit,
  LiteratureSearchQueryVariantCoverage,
  LiteratureSearchSourceCoverage,
  LiteratureSearchSourceExecutionScope,
  ResearchCoverage,
  ResearchSourceStatus,
  SearchPlan,
  SearchQueryVariant,
} from "../types.js";

export type LiteratureSearchCoverageSourceScope = {
  sourceId: string;
  scope: LiteratureSearchSourceExecutionScope;
};

export type BuildLiteratureSearchCoverageAuditInput = {
  plan: SearchPlan;
  queryAudit: ResearchSourceStatus[];
  /**
   * Sources default to one request per executed query formulation. Callers
   * declare exceptions, such as a venue-only source that runs once for the
   * primary formulation, instead of treating those omitted cells as failures.
   */
  sourceScopes?: LiteratureSearchCoverageSourceScope[];
};

type CoverageCellState = "complete" | "partial" | "failed" | "missing";

type CoverageCell = {
  state: CoverageCellState;
  resultCount: number;
  sourceName: string;
};

/**
 * Build a read-only coverage matrix from the normalized provider attempts
 * already retained by `literature_search`. This does not issue extra requests
 * or infer query terms. OpenAlex, Crossref, and arXiv expose one submitted
 * query per request, while OpenReview venue retrieval is intentionally scoped
 * to the primary formulation; see their official API references:
 * https://developers.openalex.org/api-reference/works/list-works
 * https://www.crossref.org/documentation/retrieve-metadata/rest-api/
 * https://info.arxiv.org/help/api/user-manual.html
 * https://docs.openreview.net/getting-started/using-the-api
 */
export function buildLiteratureSearchCoverageAudit(
  input: BuildLiteratureSearchCoverageAuditInput,
): LiteratureSearchCoverageAudit {
  const variants = queryVariantsForPlan(input.plan);
  const sourceIds = uniqueInOrder(
    input.plan.sourceIds.length > 0
      ? input.plan.sourceIds
      : input.queryAudit.map((attempt) => attempt.id),
  );
  const primaryVariant = variants.find((variant) => variant.id === "primary") ?? variants[0];
  const scopeBySourceId = new Map(
    (input.sourceScopes ?? []).map((item) => [item.sourceId, item.scope]),
  );
  const cells = buildCoverageCells(input.queryAudit, primaryVariant?.id ?? "primary");
  const expectedVariantsBySource = new Map<string, string[]>();

  for (const sourceId of sourceIds) {
    const scope = scopeBySourceId.get(sourceId) ?? "per_query_variant";
    expectedVariantsBySource.set(sourceId, scope === "primary_query_only"
      ? (primaryVariant ? [primaryVariant.id] : [])
      : variants.map((variant) => variant.id));
  }

  const sourceCoverage = sourceIds.map((sourceId) => buildSourceCoverage(
    sourceId,
    scopeBySourceId.get(sourceId) ?? "per_query_variant",
    expectedVariantsBySource.get(sourceId) ?? [],
    cells,
  ));
  const queryCoverage = variants.map((variant) => buildQueryCoverage(
    variant,
    sourceIds.filter((sourceId) => (expectedVariantsBySource.get(sourceId) ?? []).includes(variant.id)),
    cells,
  ));

  return {
    status: statusFor(
      sourceCoverage.reduce((sum, item) => sum + item.successfulQueryVariantIds.length, 0),
      sourceCoverage.reduce((sum, item) => sum + item.partialQueryVariantIds.length, 0),
      sourceCoverage.reduce((sum, item) => sum + item.failedQueryVariantIds.length, 0),
      sourceCoverage.reduce((sum, item) => sum + item.missingQueryVariantIds.length, 0),
    ),
    queryVariants: queryCoverage,
    sources: sourceCoverage,
    warnings: auditWarnings(input.queryAudit, sourceIds, variants, expectedVariantsBySource),
  };
}

function queryVariantsForPlan(plan: SearchPlan): SearchQueryVariant[] {
  if (plan.queryVariants && plan.queryVariants.length > 0) return plan.queryVariants;
  return [{ id: "primary", query: plan.query, requestLimit: plan.limit, category: "primary" }];
}

function buildCoverageCells(
  queryAudit: ResearchSourceStatus[],
  primaryVariantId: string,
): Map<string, CoverageCell> {
  const attemptsByCell = new Map<string, ResearchSourceStatus[]>();
  for (const attempt of queryAudit) {
    const key = coverageCellKey(attempt.id, attempt.queryVariantId ?? primaryVariantId);
    const attempts = attemptsByCell.get(key);
    if (attempts) attempts.push(attempt);
    else attemptsByCell.set(key, [attempt]);
  }

  return new Map([...attemptsByCell.entries()].map(([key, attempts]) => [key, coverageCellFor(attempts)]));
}

function coverageCellFor(attempts: ResearchSourceStatus[]): CoverageCell {
  const usable = attempts.filter((attempt) => attempt.status === "ok");
  const resultCount = attempts.reduce((sum, attempt) => sum + Math.max(0, attempt.resultCount), 0);
  const sourceName = attempts[0]?.name ?? "unknown";
  if (usable.length === 0) return { state: "failed", resultCount, sourceName };
  if (usable.some((attempt) => attempt.partial) || attempts.some((attempt) => attempt.status !== "ok")) {
    return { state: "partial", resultCount, sourceName };
  }
  return { state: "complete", resultCount, sourceName };
}

function buildSourceCoverage(
  sourceId: string,
  scope: LiteratureSearchSourceExecutionScope,
  expectedQueryVariantIds: string[],
  cells: Map<string, CoverageCell>,
): LiteratureSearchSourceCoverage {
  const rows = expectedQueryVariantIds.map((queryVariantId) => ({
    queryVariantId,
    cell: cells.get(coverageCellKey(sourceId, queryVariantId)),
  }));
  const successfulQueryVariantIds = rows
    .filter((row) => row.cell?.state === "complete" || row.cell?.state === "partial")
    .map((row) => row.queryVariantId);
  const partialQueryVariantIds = rows.filter((row) => row.cell?.state === "partial").map((row) => row.queryVariantId);
  const failedQueryVariantIds = rows.filter((row) => row.cell?.state === "failed").map((row) => row.queryVariantId);
  const missingQueryVariantIds = rows.filter((row) => !row.cell).map((row) => row.queryVariantId);
  const sourceName = rows.find((row) => row.cell)?.cell?.sourceName ?? sourceId;

  return {
    sourceId,
    sourceName,
    scope,
    expectedQueryVariantIds,
    attemptedQueryVariantIds: rows.filter((row) => row.cell).map((row) => row.queryVariantId),
    successfulQueryVariantIds,
    partialQueryVariantIds,
    failedQueryVariantIds,
    missingQueryVariantIds,
    resultCount: rows.reduce((sum, row) => sum + (row.cell?.resultCount ?? 0), 0),
    status: statusFor(successfulQueryVariantIds.length, partialQueryVariantIds.length, failedQueryVariantIds.length, missingQueryVariantIds.length),
  };
}

function buildQueryCoverage(
  variant: SearchQueryVariant,
  expectedSourceIds: string[],
  cells: Map<string, CoverageCell>,
): LiteratureSearchQueryVariantCoverage {
  const rows = expectedSourceIds.map((sourceId) => ({
    sourceId,
    cell: cells.get(coverageCellKey(sourceId, variant.id)),
  }));
  const successfulSourceIds = rows
    .filter((row) => row.cell?.state === "complete" || row.cell?.state === "partial")
    .map((row) => row.sourceId);
  const partialSourceIds = rows.filter((row) => row.cell?.state === "partial").map((row) => row.sourceId);
  const failedSourceIds = rows.filter((row) => row.cell?.state === "failed").map((row) => row.sourceId);
  const missingSourceIds = rows.filter((row) => !row.cell).map((row) => row.sourceId);

  return {
    queryVariantId: variant.id,
    query: variant.query,
    ...(variant.category ? { category: variant.category } : {}),
    expectedSourceIds,
    attemptedSourceIds: rows.filter((row) => row.cell).map((row) => row.sourceId),
    successfulSourceIds,
    partialSourceIds,
    failedSourceIds,
    missingSourceIds,
    resultCount: rows.reduce((sum, row) => sum + (row.cell?.resultCount ?? 0), 0),
    status: statusFor(successfulSourceIds.length, partialSourceIds.length, failedSourceIds.length, missingSourceIds.length),
  };
}

function statusFor(
  successfulCount: number,
  partialCount: number,
  failedCount: number,
  missingCount: number,
): ResearchCoverage["status"] {
  if (successfulCount === 0) return "failed";
  return partialCount > 0 || failedCount > 0 || missingCount > 0 ? "partial" : "complete";
}

function auditWarnings(
  queryAudit: ResearchSourceStatus[],
  sourceIds: string[],
  variants: SearchQueryVariant[],
  expectedVariantsBySource: Map<string, string[]>,
): string[] {
  const sourceSet = new Set(sourceIds);
  const variantSet = new Set(variants.map((variant) => variant.id));
  const warnings: string[] = [];
  for (const attempt of queryAudit) {
    const queryVariantId = attempt.queryVariantId ?? "primary";
    const label = `${attempt.name} (${queryVariantId})`;
    if (!sourceSet.has(attempt.id)) warnings.push(`${label}: source was not declared in the search plan.`);
    if (!variantSet.has(queryVariantId)) warnings.push(`${label}: query variant was not declared in the search plan.`);
    if (!(expectedVariantsBySource.get(attempt.id) ?? []).includes(queryVariantId)) {
      warnings.push(`${label}: attempt was outside the declared source scope.`);
    }
    for (const warning of attempt.warnings ?? []) warnings.push(`${label}: ${warning}`);
    if (attempt.status !== "ok") warnings.push(`${label}: ${attempt.error ?? attempt.coverage}`);
  }
  for (const sourceId of sourceIds) {
    for (const queryVariantId of expectedVariantsBySource.get(sourceId) ?? []) {
      const found = queryAudit.some((attempt) => attempt.id === sourceId && (attempt.queryVariantId ?? "primary") === queryVariantId);
      if (!found) warnings.push(`${sourceId} (${queryVariantId}): source did not return an audit status.`);
    }
  }
  return uniqueInOrder(warnings).sort(compareText);
}

function coverageCellKey(sourceId: string, queryVariantId: string): string {
  return `${sourceId}\u0000${queryVariantId}`;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
