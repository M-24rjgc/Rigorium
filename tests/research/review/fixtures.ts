import {
  createResearchArtifact,
  toResearchArtifactRef,
  type ResearchArtifactRef,
} from "../../../src/research/artifacts/index.js";
import type { RunAttemptPayload } from "../../../src/research/experimentation/index.js";
import { createEvidencePackArtifact } from "../../../src/research/literature/evidencePack.js";
import {
  createCitationSet,
  createFigureTableArtifact,
  createManuscriptVersion,
  type ManuscriptComplianceCheck,
  type RenderRunPayload,
} from "../../../src/research/manuscript/index.js";
import {
  REVIEWER_LANES,
  type ReviewAssessment,
  type ReviewFindingDraft,
  type ReviewerLane,
  type ReviewerLaneReport,
} from "../../../src/research/review/contracts.js";

export const REVIEW_NOW = new Date("2026-07-25T08:00:00.000Z");

export function syntheticHash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

export function createSyntheticReviewArtifacts(options: Readonly<{
  targetMode?: "anonymous_submission" | "camera_ready" | "internal_draft";
  maxMainPages?: number;
  mainMatterPage?: number;
  compileStatus?: "succeeded" | "failed" | "engine_unavailable";
  includePdf?: boolean;
  anonymityStatus?: "pass" | "warning" | "fail";
  bindCitationEvidence?: boolean;
  includeRunProvenance?: boolean;
  additionalSucceededProvenanceRuns?: number;
  runStatus?: "succeeded" | "failed";
}> = {}) {
  const evidence = createEvidencePackArtifact({
    artifactId: "review-evidence",
    entries: [{
      id: "review-evidence-entry",
      paperId: "synthetic-paper",
      locator: { sourceId: "synthetic", recordId: "review-source", page: 1, paragraph: 1 },
      snapshot: { content: "Synthetic review evidence fixture." },
    }],
    producer: { kind: "import" },
    now: REVIEW_NOW,
  });
  const citations = createCitationSet({
    artifactId: "review-citations",
    bibtexEntries: [{
      citationKey: "synthetic2026",
      entryType: "article",
      paperId: "synthetic-paper",
      fields: { title: "Synthetic review source", author: "Synthetic Author", year: "2026" },
    }],
    producer: { kind: "import" },
    now: REVIEW_NOW,
  });
  const runStatus = options.runStatus ?? "succeeded";
  const runPayload: RunAttemptPayload = {
    attemptId: "review-run",
    experimentId: "review-experiment",
    specRevision: 1,
    specDigest: syntheticHash("d"),
    adapterId: "local",
    jobId: "review-job",
    status: runStatus,
    grantMode: "confirm_each",
    preparedAt: REVIEW_NOW.toISOString(),
    startedAt: REVIEW_NOW.toISOString(),
    finishedAt: REVIEW_NOW.toISOString(),
    artifactIds: [],
    metricObservationIds: [],
  };
  const run = createResearchArtifact({
    kind: "run_attempt",
    artifactId: "review-run",
    payload: runPayload,
    producer: { kind: "tool", toolName: "synthetic_fixture" },
    now: REVIEW_NOW,
  });
  const additionalRuns = Array.from({ length: options.additionalSucceededProvenanceRuns ?? 0 }, (_, index) => {
    const attemptId = `review-run-provenance-${index + 1}`;
    const payload: RunAttemptPayload = {
      ...runPayload,
      attemptId,
      jobId: `review-job-provenance-${index + 1}`,
      status: "succeeded",
      artifactIds: [],
      metricObservationIds: [],
    };
    return createResearchArtifact({
      kind: "run_attempt",
      artifactId: attemptId,
      payload,
      producer: { kind: "tool", toolName: "synthetic_fixture" },
      now: REVIEW_NOW,
    });
  });
  const figure = createFigureTableArtifact({
    artifactId: "review-figure",
    items: [{
      itemId: "synthetic-figure",
      kind: "figure",
      label: "fig:synthetic",
      data: [{ path: "data/synthetic.csv", contentHash: syntheticHash("a"), mediaType: "text/csv" }],
      script: {
        status: "available",
        file: { path: "scripts/synthetic.ts", contentHash: syntheticHash("b"), mediaType: "text/typescript" },
        command: ["node", "scripts/synthetic.ts"],
      },
      output: { path: "figures/synthetic.png", contentHash: syntheticHash("c"), mediaType: "image/png" },
      captionLatex: "Synthetic fixture figure.",
      captionEvidenceRefs: [toResearchArtifactRef(evidence)],
      citationKeys: ["synthetic2026"],
    }],
    provenanceRefs: options.includeRunProvenance === false
      ? []
      : [toResearchArtifactRef(run), ...additionalRuns.map(toResearchArtifactRef)],
    producer: { kind: "tool", toolName: "synthetic_fixture" },
    now: REVIEW_NOW,
  });
  const evidenceRefs = options.bindCitationEvidence === false ? [] : [toResearchArtifactRef(evidence)];
  const manuscript = createManuscriptVersion({
    artifactId: "review-manuscript",
    title: "Synthetic Review Manuscript",
    latex: `\\documentclass{article}
\\begin{document}
Synthetic claim \\citep{synthetic2026}.
\\label{pilotdeck-main-matter-end}
\\bibliographystyle{plain}
\\bibliography{references}
\\end{document}`,
    target: {
      venue: "generic",
      mode: options.targetMode ?? "internal_draft",
      maxMainPages: options.maxMainPages ?? 4,
    },
    sections: [
      {
        sectionId: "introduction",
        kind: "introduction",
        title: "Introduction",
        requestedOutput: "preserve",
        minimumMaturity: "citation_only",
        statements: [{
          statementId: "claim-citation",
          kind: "context",
          maturity: evidenceRefs.length > 0 ? "evidence_snapshot" : "citation_only",
          citationKeys: ["synthetic2026"],
          evidenceRefs,
          figureTableRefs: [],
          textOrigin: "user",
        }],
      },
      {
        sectionId: "results",
        kind: "results",
        title: "Results",
        requestedOutput: "preserve",
        minimumMaturity: "observed_result",
        statements: [{
          statementId: "result-figure",
          kind: "result",
          maturity: "observed_result",
          citationKeys: [],
          evidenceRefs,
          figureTableRefs: [toResearchArtifactRef(figure)],
          textOrigin: "user",
        }],
      },
    ],
    revisionNote: "Synthetic review fixture.",
    producer: { kind: "user" },
    citationSet: citations,
    figureTables: [figure],
    evidencePacks: options.bindCitationEvidence === false ? [] : [evidence],
    now: REVIEW_NOW,
  });
  const compileStatus = options.compileStatus ?? "succeeded";
  const checks: ManuscriptComplianceCheck[] = [
    check("compile", compileStatus === "succeeded" ? "pass" : "fail"),
    check("anonymity", options.anonymityStatus ?? "pass"),
    check("page_limit", (options.mainMatterPage ?? 3) <= (options.maxMainPages ?? 4) ? "pass" : "fail"),
    check("citations", "pass"),
    check("appendix", "not_checked"),
    check("template", "not_checked"),
  ];
  const renderPayload: RenderRunPayload = {
    schemaVersion: 1,
    kind: "render_run",
    manuscriptRef: toResearchArtifactRef(manuscript),
    engine: { name: "pdflatex", status: "available", executable: "pdflatex", version: "synthetic" },
    command: ["pdflatex", "main.tex"],
    exitCode: compileStatus === "succeeded" ? 0 : 1,
    timedOut: false,
    compileStatus,
    workingDirectory: "synthetic-review-workspace",
    diagnostics: compileStatus === "succeeded" ? [] : [{ severity: "error", code: "synthetic", message: "Synthetic compile failure." }],
    checks,
    pageCount: options.mainMatterPage ?? 3,
    mainMatterPage: options.mainMatterPage ?? 3,
    outputs: options.includePdf === false ? [] : [{
      kind: "pdf",
      path: "synthetic-review-workspace/main.pdf",
      contentHash: syntheticHash("e"),
      bytes: 1024,
      exported: false,
    }],
    exportBoundary: { requested: false, confirmed: false, performed: false },
  };
  const render = createResearchArtifact({
    kind: "render_run",
    artifactId: "review-render",
    payload: renderPayload,
    producer: { kind: "tool", toolName: "synthetic_fixture" },
    parents: [
      { relation: "uses", artifact: toResearchArtifactRef(manuscript) },
      { relation: "uses", artifact: toResearchArtifactRef(citations) },
      { relation: "uses", artifact: toResearchArtifactRef(figure) },
    ],
    now: REVIEW_NOW,
  });
  return { evidence, citations, figure, run, runs: Object.freeze([run, ...additionalRuns]), manuscript, render };
}

export function createLaneReports(
  manuscriptRef: ResearchArtifactRef,
  drafts: Partial<Record<ReviewerLane, readonly ReviewFindingDraft[]>> = {},
): ReviewerLaneReport[] {
  return REVIEWER_LANES.map((lane, index) => Object.freeze({
    lane,
    reviewerId: `reviewer-${index + 1}-${lane}`,
    independent: true as const,
    findings: Object.freeze([...(drafts[lane] ?? [])]),
  }));
}

export function createFindingDraft(input: {
  id: string;
  lane: ReviewerLane;
  reviewerId: string;
  manuscriptRef: ResearchArtifactRef;
  assessment?: ReviewAssessment;
  dedupeKey?: string;
  summary?: string;
  severity?: ReviewFindingDraft["severity"];
  category?: ReviewFindingDraft["category"];
}): ReviewFindingDraft {
  const assessment = input.assessment ?? "concern";
  return Object.freeze({
    id: input.id,
    dedupeKey: input.dedupeKey ?? "synthetic:result-claim",
    lane: input.lane,
    reviewerId: input.reviewerId,
    assessment,
    category: input.category ?? input.lane,
    severity: input.severity ?? "major",
    confidence: "high" as const,
    summary: input.summary ?? "The synthetic result needs revision.",
    rationale: assessment === "concern"
      ? "The anchored synthetic statement lacks a required justification."
      : "The anchored synthetic statement is supported by the supplied artifact.",
    location: { sectionId: "results", statementId: "result-figure", anchorText: "Synthetic result" },
    actions: [{
      kind: assessment === "concern" ? "revise_manuscript" as const : "no_change" as const,
      instruction: assessment === "concern" ? "Revise the anchored result statement." : "Keep the supported statement.",
      targetArtifactRefs: [input.manuscriptRef],
    }],
    evidenceRefs: [],
    runRefs: [],
    affectedArtifactRefs: [input.manuscriptRef],
  });
}

function check(
  name: ManuscriptComplianceCheck["name"],
  status: ManuscriptComplianceCheck["status"],
): ManuscriptComplianceCheck {
  return Object.freeze({
    name,
    status,
    messages: status === "fail" || status === "warning" ? Object.freeze([`Synthetic ${name} ${status}.`]) : Object.freeze([]),
  });
}
