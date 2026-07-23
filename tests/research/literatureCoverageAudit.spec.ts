import assert from "node:assert/strict";
import test from "node:test";
import { buildLiteratureSearchCoverageAudit } from "../../src/research/literature/coverageAudit.js";
import type { ResearchSourceStatus, SearchPlan } from "../../src/research/types.js";

const retrievedAt = "2026-07-23T00:00:00.000Z";

function source(input: {
  id: string;
  queryVariantId: string;
  status?: ResearchSourceStatus["status"];
  partial?: boolean;
  resultCount?: number;
  warning?: string;
  error?: string;
}): ResearchSourceStatus {
  const status = input.status ?? "ok";
  return {
    id: input.id,
    name: input.id === "openalex" ? "OpenAlex" : input.id === "crossref" ? "Crossref" : "OpenReview",
    queryVariantId: input.queryVariantId,
    status,
    ...(input.partial ? { partial: true } : {}),
    retrievedAt,
    resultCount: input.resultCount ?? (status === "ok" ? 1 : 0),
    coverage: `${input.id} coverage`,
    ...(input.warning ? { warnings: [input.warning] } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

const plan: SearchPlan = {
  query: "research agents",
  limit: 4,
  sort: "relevance",
  sourceIds: ["openalex", "crossref", "openreview"],
  queryVariants: [
    { id: "primary", query: "research agents", requestLimit: 2, category: "primary" },
    { id: "alternative-1", query: "agentic systems", requestLimit: 2, category: "adjacent_field" },
  ],
};

test("coverage audit makes source-by-query completion explicit without marking primary-only sources missing", () => {
  const audit = buildLiteratureSearchCoverageAudit({
    plan,
    queryAudit: [
      source({ id: "openalex", queryVariantId: "primary", resultCount: 3 }),
      source({ id: "openalex", queryVariantId: "alternative-1", status: "error", error: "alternate unavailable" }),
      source({ id: "crossref", queryVariantId: "primary", partial: true, resultCount: 2, warning: "results truncated" }),
      source({ id: "crossref", queryVariantId: "alternative-1", resultCount: 1 }),
      source({ id: "openreview", queryVariantId: "primary", resultCount: 1 }),
    ],
    sourceScopes: [{ sourceId: "openreview", scope: "primary_query_only" }],
  });

  assert.equal(audit.status, "partial");
  assert.deepEqual(audit.queryVariants.map((item) => ({
    id: item.queryVariantId,
    expected: item.expectedSourceIds,
    successful: item.successfulSourceIds,
    partial: item.partialSourceIds,
    failed: item.failedSourceIds,
    missing: item.missingSourceIds,
    status: item.status,
  })), [
    {
      id: "primary",
      expected: ["openalex", "crossref", "openreview"],
      successful: ["openalex", "crossref", "openreview"],
      partial: ["crossref"],
      failed: [],
      missing: [],
      status: "partial",
    },
    {
      id: "alternative-1",
      expected: ["openalex", "crossref"],
      successful: ["crossref"],
      partial: [],
      failed: ["openalex"],
      missing: [],
      status: "partial",
    },
  ]);
  const openReview = audit.sources.find((item) => item.sourceId === "openreview");
  assert.deepEqual(openReview, {
    sourceId: "openreview",
    sourceName: "OpenReview",
    scope: "primary_query_only",
    expectedQueryVariantIds: ["primary"],
    attemptedQueryVariantIds: ["primary"],
    successfulQueryVariantIds: ["primary"],
    partialQueryVariantIds: [],
    failedQueryVariantIds: [],
    missingQueryVariantIds: [],
    resultCount: 1,
    status: "complete",
  });
  assert.match(audit.warnings.join(" "), /OpenAlex \(alternative-1\): alternate unavailable/);
  assert.match(audit.warnings.join(" "), /Crossref \(primary\): results truncated/);
});

test("coverage audit reports a declared source that returned no query status", () => {
  const audit = buildLiteratureSearchCoverageAudit({
    plan: {
      ...plan,
      sourceIds: ["openalex", "crossref"],
      queryVariants: [plan.queryVariants?.[0] as NonNullable<SearchPlan["queryVariants"]>[number]],
    },
    queryAudit: [source({ id: "openalex", queryVariantId: "primary" })],
  });

  assert.equal(audit.status, "partial");
  assert.deepEqual(audit.queryVariants[0]?.missingSourceIds, ["crossref"]);
  assert.deepEqual(audit.sources.find((item) => item.sourceId === "crossref")?.missingQueryVariantIds, ["primary"]);
  assert.match(audit.warnings.join(" "), /crossref \(primary\): source did not return an audit status/);
});
