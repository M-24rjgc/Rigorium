import assert from "node:assert/strict";
import test from "node:test";
import {
  createResearchArtifact,
  toResearchArtifactRef,
} from "../../../src/research/artifacts/index.js";
import { runDeterministicReviewPreflight } from "../../../src/research/review/preflight.js";
import {
  REVIEW_NOW,
  createSyntheticReviewArtifacts,
} from "./fixtures.js";

test("review preflight consumes manuscript-module artifacts and passes a complete synthetic package", () => {
  const fixture = createSyntheticReviewArtifacts();
  const result = runDeterministicReviewPreflight({
    manuscript: fixture.manuscript,
    renderRun: fixture.render,
    citationSet: fixture.citations,
    figureTableArtifacts: [fixture.figure],
    runAttempts: [fixture.run],
  });

  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.checks.map((check) => check.id), [
    "compile_render",
    "citation_completeness",
    "page_limit",
    "anonymity",
    "figure_table_provenance",
  ]);
  assert.equal(result.checks.every((check) => check.status === "passed"), true);
});

test("review preflight accepts multiple succeeded structured figure/table provenance parents", () => {
  const fixture = createSyntheticReviewArtifacts({ additionalSucceededProvenanceRuns: 1 });
  const result = runDeterministicReviewPreflight({
    manuscript: fixture.manuscript,
    renderRun: fixture.render,
    citationSet: fixture.citations,
    figureTableArtifacts: [fixture.figure],
    runAttempts: fixture.runs,
  });

  assert.equal(result.findings.length, 0);
  assert.equal(fixture.figure.parents.filter((parent) => parent.relation === "uses"
    && parent.artifact.kind === "run_attempt").length, 2);
});

test("review preflight reports a structured FigureTable without a run provenance parent", () => {
  const fixture = createSyntheticReviewArtifacts({ includeRunProvenance: false });
  const result = runDeterministicReviewPreflight({
    manuscript: fixture.manuscript,
    renderRun: fixture.render,
    citationSet: fixture.citations,
    figureTableArtifacts: [fixture.figure],
    runAttempts: [fixture.run],
  });
  const finding = result.findings.find((candidate) => candidate.category === "figure_provenance");

  assert.ok(finding);
  assert.match(finding.rationale, /no run_attempt provenance parent/iu);
  assert.deepEqual(finding.runRefs, []);
});

test("review preflight reports a failed structured FigureTable provenance run", () => {
  const fixture = createSyntheticReviewArtifacts({ runStatus: "failed" });
  const result = runDeterministicReviewPreflight({
    manuscript: fixture.manuscript,
    renderRun: fixture.render,
    citationSet: fixture.citations,
    figureTableArtifacts: [fixture.figure],
    runAttempts: [fixture.run],
  });
  const finding = result.findings.find((candidate) => candidate.category === "figure_provenance");

  assert.ok(finding);
  assert.match(finding.rationale, /has status failed/iu);
  assert.deepEqual(finding.runRefs, [toResearchArtifactRef(fixture.run)]);
});

test("review preflight reports a structured FigureTable run hash mismatch", () => {
  const fixture = createSyntheticReviewArtifacts();
  const mismatchedRun = createResearchArtifact({
    kind: "run_attempt",
    artifactId: fixture.run.artifactId,
    revision: fixture.run.revision,
    payload: {
      ...fixture.run.payload,
      jobId: "review-job-hash-mismatch",
    },
    producer: fixture.run.producer,
    now: REVIEW_NOW,
  });
  const result = runDeterministicReviewPreflight({
    manuscript: fixture.manuscript,
    renderRun: fixture.render,
    citationSet: fixture.citations,
    figureTableArtifacts: [fixture.figure],
    runAttempts: [mismatchedRun],
  });
  const finding = result.findings.find((candidate) => candidate.category === "figure_provenance");

  assert.ok(finding);
  assert.match(finding.rationale, /does not exactly match its supplied run artifact/iu);
  assert.equal(finding.runRefs.some((ref) => ref.contentHash === toResearchArtifactRef(fixture.run).contentHash), true);
  assert.equal(finding.runRefs.some((ref) => ref.contentHash === toResearchArtifactRef(mismatchedRun).contentHash), true);
});

test("review preflight reports compile, citation, page, anonymity, and provenance failures with anchors", () => {
  const fixture = createSyntheticReviewArtifacts({
    targetMode: "anonymous_submission",
    maxMainPages: 2,
    mainMatterPage: 6,
    compileStatus: "failed",
    includePdf: false,
    anonymityStatus: "fail",
    bindCitationEvidence: false,
  });
  const result = runDeterministicReviewPreflight({
    manuscript: fixture.manuscript,
    renderRun: fixture.render,
    citationSet: fixture.citations,
    figureTableArtifacts: [fixture.figure],
    runAttempts: [],
  });
  const categories = new Set(result.findings.map((finding) => finding.category));

  assert.equal(categories.has("compile"), true);
  assert.equal(categories.has("citation"), true);
  assert.equal(categories.has("page_limit"), true);
  assert.equal(categories.has("anonymity"), true);
  assert.equal(categories.has("figure_provenance"), true);
  assert.equal(result.checks.every((check) => check.status === "failed"), true);
  assert.equal(result.findings.every((finding) => finding.location.sectionId.length > 0
    && finding.location.anchorText.length > 0), true);
});

test("review preflight rejects a CitationSet that is not the manuscript's pinned artifact", () => {
  const fixture = createSyntheticReviewArtifacts();
  const other = createSyntheticReviewArtifacts();
  const mismatched = Object.freeze({ ...other.citations, artifactId: "other-citations" });
  assert.throws(() => runDeterministicReviewPreflight({
    manuscript: fixture.manuscript,
    renderRun: fixture.render,
    citationSet: mismatched,
    figureTableArtifacts: [fixture.figure],
    runAttempts: [fixture.run],
  }), /does not match the manuscript citationSetRef/iu);
});
