import { createHash } from "node:crypto";
import { toResearchArtifactRef, type ResearchArtifactRef } from "../artifacts/index.js";
import {
  containsActiveLatexCommand,
  extractLatexCitationKeys,
  stripLatexComments,
} from "../manuscript/index.js";
import type {
  ExperimentFigureTableArtifact,
  FindingActionKind,
  ManuscriptLocation,
  ReviewFigureTableArtifact,
  ReviewFindingDraft,
  ReviewPreflightCheck,
  ReviewPreflightCheckId,
  ReviewPreflightInput,
  ReviewerLane,
} from "./contracts.js";
import {
  assertReviewableManuscript,
  citationKey,
  fullRefKey,
  identifier,
  mergeRefs,
  normalizeLocation,
  sameRef,
  sha256,
  text,
} from "./validation.js";

export type PreflightFindingDraft = ReviewFindingDraft & Readonly<{ source: "preflight" }>;

export type ReviewPreflightResult = Readonly<{
  checks: readonly ReviewPreflightCheck[];
  findings: readonly PreflightFindingDraft[];
}>;

export function runDeterministicReviewPreflight(input: ReviewPreflightInput): ReviewPreflightResult {
  const manuscript = assertReviewableManuscript(input.manuscript);
  const manuscriptRef = toResearchArtifactRef(manuscript);
  const findings: PreflightFindingDraft[] = [];
  const checks: ReviewPreflightCheck[] = [];

  const compileFindings = checkCompileRender(input, manuscriptRef);
  findings.push(...compileFindings);
  checks.push(check("compile_render", compileFindings, compileFindings.length === 0
    ? "A successful render with an output hash is linked to this manuscript."
    : "The manuscript does not have a complete successful render record."));

  const citationFindings = checkCitations(input, manuscriptRef);
  findings.push(...citationFindings);
  checks.push(check("citation_completeness", citationFindings, citationFindings.length === 0
    ? "Every in-text citation resolves to an evidence-linked citation entry."
    : "One or more in-text citations are unresolved or lack evidence links."));

  const pageFindings = checkPageLimit(input, manuscriptRef);
  findings.push(...pageFindings);
  checks.push(check("page_limit", pageFindings, pageFindings.length === 0
    ? input.manuscript.payload.target.maxMainPages === undefined
      ? "The manuscript target does not declare a main-matter page limit."
      : "The rendered page count is within the declared target limit."
    : "The rendered page count is unavailable or exceeds the declared target limit."));

  const anonymityFindings = checkAnonymity(input, manuscriptRef);
  findings.push(...anonymityFindings);
  checks.push(check("anonymity", anonymityFindings, anonymityFindings.length === 0
    ? "The manuscript and render satisfy the declared anonymity policy."
    : "The submission exposes identity state that conflicts with the declared target policy."));

  const provenanceFindings = checkFigureTableProvenance(input, manuscriptRef);
  findings.push(...provenanceFindings);
  checks.push(check("figure_table_provenance", provenanceFindings, provenanceFindings.length === 0
    ? "Every manuscript figure and table resolves to matching file and run provenance."
    : "One or more manuscript figures or tables lack matching file or run provenance."));

  return Object.freeze({
    checks: Object.freeze(checks),
    findings: Object.freeze(findings.sort((left, right) => left.id.localeCompare(right.id, "en"))),
  });
}

function checkCompileRender(input: ReviewPreflightInput, manuscriptRef: ResearchArtifactRef): PreflightFindingDraft[] {
  const location = documentLocation(input, "Rendered manuscript");
  if (!input.renderRun) {
    return [preflightFinding({
      checkId: "compile_render",
      entity: "missing",
      lane: "target_fit",
      category: "compile",
      severity: "blocker",
      summary: "No render run is attached to the manuscript.",
      rationale: "Compile and render status must be known before substantive review can rely on pagination or visible output.",
      location,
      actionKind: "repair_render",
      action: "Produce a successful render run and attach its output hash.",
      affectedArtifactRefs: [manuscriptRef],
    })];
  }
  assertRenderRun(input, manuscriptRef);
  const renderRef = toResearchArtifactRef(input.renderRun);
  const findings: PreflightFindingDraft[] = [];
  if (input.renderRun.payload.compileStatus !== "succeeded") {
    findings.push(preflightFinding({
      checkId: "compile_render",
      entity: "status",
      lane: "target_fit",
      category: "compile",
      severity: "blocker",
      summary: `Render status is ${input.renderRun.payload.compileStatus}.`,
      rationale: input.renderRun.payload.diagnostics.map((diagnostic) => diagnostic.message).join(" ")
        || "The manuscript has no successful compiled output.",
      location,
      actionKind: "repair_render",
      action: "Resolve the compile errors and produce a successful render record.",
      affectedArtifactRefs: [manuscriptRef, renderRef],
    }));
  } else {
    const pdf = input.renderRun.payload.outputs.find((output) => output.kind === "pdf");
    if (!pdf) {
      findings.push(preflightFinding({
        checkId: "compile_render",
        entity: "pdf-output",
        lane: "target_fit",
        category: "render",
        severity: "major",
        summary: "The successful render has no recorded PDF output.",
        rationale: "Review output must be pinned to the exact rendered manuscript rather than an unversioned file.",
        location,
        actionKind: "repair_render",
        action: "Record the rendered PDF output hash and regenerate the render artifact.",
        affectedArtifactRefs: [manuscriptRef, renderRef],
      }));
    } else {
      sha256(pdf.contentHash, "renderRun PDF contentHash");
      if (!Number.isSafeInteger(pdf.bytes) || pdf.bytes <= 0) {
        findings.push(preflightFinding({
          checkId: "compile_render",
          entity: "pdf-bytes",
          lane: "target_fit",
          category: "render",
          severity: "major",
          summary: "The rendered PDF has no positive byte count.",
          rationale: "A zero-length or unmeasured output cannot be treated as a reviewable render.",
          location,
          actionKind: "repair_render",
          action: "Regenerate the PDF and record its positive byte count.",
          affectedArtifactRefs: [manuscriptRef, renderRef],
        }));
      }
    }
  }
  return findings;
}

function checkCitations(input: ReviewPreflightInput, manuscriptRef: ResearchArtifactRef): PreflightFindingDraft[] {
  const cited = extractLatexCitationKeys(input.manuscript.payload.source.content);
  if (input.citationSet) assertCitationSet(input);
  if (cited.length === 0) return [];
  const entries = new Set((input.citationSet?.payload.citationKeys ?? [])
    .map((key, index) => citationKey(key, `citationSet.citationKeys[${index}]`)));
  const citationSetRef = input.citationSet ? toResearchArtifactRef(input.citationSet) : undefined;
  const findings: PreflightFindingDraft[] = [];
  for (const key of cited) {
    const bindings = input.manuscript.payload.sections.flatMap((section) => section.statements
      .filter((statement) => statement.citationKeys.includes(key))
      .map((statement) => ({ section, statement })));
    const evidenceRefs = mergeRefs(bindings.map(({ statement }) => statement.evidenceRefs));
    const problems: string[] = [];
    if (!input.citationSet) problems.push("no CitationSet is attached");
    else if (!entries.has(key)) problems.push("the CitationSet does not contain the key");
    if (evidenceRefs.length === 0) problems.push("no section statement binds the citation to evidence");
    if (problems.length === 0) continue;
    const first = bindings[0];
    const location = first
      ? statementLocation(first.section.sectionId, first.statement.statementId, key)
      : documentLocation(input, key);
    findings.push(preflightFinding({
      checkId: "citation_completeness",
      entity: key,
      lane: "evidence",
      category: "citation",
      severity: "major",
      summary: `Citation ${key} is unresolved or lacks an evidence binding.`,
      rationale: problems.join("; "),
      location,
      actionKind: "correct_citation",
      action: `Resolve citation ${key} and attach its evidence reference.`,
      evidenceRefs,
      affectedArtifactRefs: mergeRefs([[manuscriptRef], citationSetRef ? [citationSetRef] : []]),
    }));
  }
  return findings;
}

function checkPageLimit(input: ReviewPreflightInput, manuscriptRef: ResearchArtifactRef): PreflightFindingDraft[] {
  const pageLimit = input.manuscript.payload.target.maxMainPages;
  if (pageLimit === undefined) return [];
  const location = documentLocation(input, "Target page limit");
  const renderRef = input.renderRun ? toResearchArtifactRef(input.renderRun) : undefined;
  const affected = mergeRefs([[manuscriptRef], renderRef ? [renderRef] : []]);
  const mainMatterPage = input.renderRun?.payload.mainMatterPage;
  const pageCount = input.renderRun?.payload.pageCount;
  const observedPages = mainMatterPage ?? pageCount;
  if (!Number.isSafeInteger(observedPages) || (observedPages as number) <= 0) {
    return [preflightFinding({
      checkId: "page_limit",
      entity: "unknown",
      lane: "target_fit",
      category: "page_limit",
      severity: "major",
      summary: "Rendered page count is unavailable.",
      rationale: `Target ${input.manuscript.payload.target.venue} declares a ${pageLimit}-page main-matter limit.`,
      location,
      actionKind: "repair_render",
      action: "Record a valid rendered page count before target-fit review.",
      affectedArtifactRefs: affected,
    })];
  }
  if ((observedPages as number) <= pageLimit) return [];
  return [preflightFinding({
    checkId: "page_limit",
    entity: "exceeded",
    lane: "target_fit",
    category: "page_limit",
    severity: "major",
    summary: `Rendered manuscript records ${observedPages} pages for a ${pageLimit}-page target.`,
    rationale: mainMatterPage === undefined
      ? "The main-matter marker is unavailable and total PDF length exceeds the declared limit, so compliance is not demonstrated."
      : "The resolved main-matter boundary exceeds the declared target limit.",
    location,
    actionKind: "revise_manuscript",
    action: "Reduce the main manuscript to the declared page limit or explicitly change the target contract.",
    affectedArtifactRefs: affected,
  })];
}

function checkAnonymity(input: ReviewPreflightInput, manuscriptRef: ResearchArtifactRef): PreflightFindingDraft[] {
  if (input.manuscript.payload.target.mode !== "anonymous_submission") return [];
  const violations: string[] = [];
  const renderCheck = input.renderRun?.payload.checks.find((check) => check.name === "anonymity");
  if (renderCheck && (renderCheck.status === "fail" || renderCheck.status === "warning")) {
    violations.push(...renderCheck.messages);
  }
  const source = stripLatexComments(input.manuscript.payload.source.content);
  if (containsActiveLatexCommand(source, "iclrfinalcopy")) violations.push("Active \\iclrfinalcopy exposes the camera-ready author block.");
  if (/\\pdfinfo\s*\{[^}]*(?:Author|Creator)\s*=/iu.test(source)) violations.push("PDF metadata may contain author or creator identity.");
  if (/\\section\*?\s*\{\s*Acknowledg/iu.test(source)) violations.push("Acknowledgements are present in anonymous source.");
  if (violations.length === 0) return [];
  const renderRef = input.renderRun ? toResearchArtifactRef(input.renderRun) : undefined;
  return [preflightFinding({
    checkId: "anonymity",
    entity: "identity-exposed",
    lane: "target_fit",
    category: "anonymity",
    severity: renderCheck?.status === "warning" ? "major" : "blocker",
    summary: "Submission anonymity requirements are not satisfied.",
    rationale: [...new Set(violations)].join("; "),
    location: documentLocation(input, input.manuscript.payload.title),
    actionKind: "revise_manuscript",
    action: "Remove identifying metadata and regenerate an anonymous review render.",
    affectedArtifactRefs: mergeRefs([[manuscriptRef], renderRef ? [renderRef] : []]),
  })];
}

function checkFigureTableProvenance(
  input: ReviewPreflightInput,
  manuscriptRef: ResearchArtifactRef,
): PreflightFindingDraft[] {
  const artifacts = new Map<string, NonNullable<ReviewPreflightInput["figureTableArtifacts"]>[number]>();
  for (const artifact of input.figureTableArtifacts ?? []) {
    if (!artifact || artifact.kind !== "figure_table" || artifact.status !== "active") {
      throw new TypeError("figureTableArtifacts must contain active figure_table envelopes.");
    }
    const key = fullRefKey(toResearchArtifactRef(artifact));
    if (artifacts.has(key)) throw new TypeError(`Figure/table artifact ${key} is duplicated.`);
    artifacts.set(key, artifact);
  }
  const runs: NonNullable<ReviewPreflightInput["runAttempts"]>[number][] = [];
  const runRefs = new Set<string>();
  for (const run of input.runAttempts ?? []) {
    if (!run || run.kind !== "run_attempt" || run.status !== "active") {
      throw new TypeError("runAttempts must contain active run_attempt envelopes.");
    }
    const refKey = fullRefKey(toResearchArtifactRef(run));
    if (runRefs.has(refKey)) throw new TypeError(`Run artifact ${refKey} is duplicated.`);
    runRefs.add(refKey);
    identifier(run.payload.attemptId, "run attemptId");
    if (!Array.isArray(run.payload.artifactIds)) throw new TypeError("run attempt artifactIds must be an array.");
    run.payload.artifactIds.forEach((artifactId, index) => {
      identifier(artifactId, `run attempt artifactIds[${index}]`);
    });
    runs.push(run);
  }
  const findings: PreflightFindingDraft[] = [];
  for (const declaredRef of input.manuscript.payload.figureTableRefs) {
    const problems: string[] = [];
    const artifact = artifacts.get(fullRefKey(declaredRef));
    let role: "figure" | "table" = "figure";
    let producingRuns = artifact
      ? runs.filter((candidate) => candidate.payload.status === "succeeded"
        && candidate.payload.artifactIds.includes(artifact.artifactId))
      : [];
    let run = producingRuns.length === 1 ? producingRuns[0] : undefined;
    if (!artifact) problems.push("the referenced figure_table artifact or envelope hash is unavailable");
    if (artifact) {
      if (isExperimentFigureTable(artifact)) {
        identifier(artifact.payload.experimentId, `figure_table ${artifact.artifactId} experimentId`);
        identifier(artifact.payload.runAttemptId, `figure_table ${artifact.artifactId} runAttemptId`);
        if (artifact.payload.role !== "figure" && artifact.payload.role !== "table") {
          throw new TypeError(`figure_table ${artifact.artifactId} has an invalid role.`);
        }
        role = artifact.payload.role;
        sha256(artifact.payload.sha256, `figure_table ${artifact.artifactId} sha256`);
        if (!Number.isSafeInteger(artifact.payload.bytes) || artifact.payload.bytes <= 0) {
          problems.push("the produced file has no positive byte count");
        }
        producingRuns = runs.filter((candidate) => candidate.payload.attemptId === artifact.payload.runAttemptId
          && candidate.payload.status === "succeeded"
          && candidate.payload.artifactIds.includes(artifact.artifactId));
        run = producingRuns.length === 1 ? producingRuns[0] : undefined;
        if (producingRuns.length === 0) problems.push("no succeeded producing run matches runAttemptId and artifactIds");
        if (producingRuns.length > 1) problems.push("multiple succeeded runs claim the same produced artifact");
      } else {
        if (artifact.payload.kind !== "figure_table" || artifact.payload.schemaVersion !== 1
          || !Array.isArray(artifact.payload.items) || artifact.payload.items.length === 0) {
          problems.push("the structured figure_table has no items");
        } else {
          role = artifact.payload.items.every((item) => item.kind === "table") ? "table" : "figure";
          for (const item of artifact.payload.items) {
            sha256(item.output.contentHash, `figure_table ${artifact.artifactId} item ${item.itemId} output hash`);
            for (const file of item.data) {
              sha256(file.contentHash, `figure_table ${artifact.artifactId} item ${item.itemId} data hash`);
            }
            if (item.script.status === "available") {
              sha256(item.script.file.contentHash, `figure_table ${artifact.artifactId} item ${item.itemId} script hash`);
            }
          }
        }
        if (producingRuns.length === 0) problems.push("no succeeded producing run lists the structured figure_table artifact");
        if (producingRuns.length > 1) problems.push("multiple succeeded runs claim the same structured figure_table artifact");
      }
    }
    if (problems.length === 0) continue;
    const runRef = run ? toResearchArtifactRef(run) : undefined;
    const binding = findFigureTableBinding(input, declaredRef);
    findings.push(preflightFinding({
      checkId: "figure_table_provenance",
      entity: declaredRef.artifactId,
      lane: "evidence",
      category: role === "figure" ? "figure_provenance" : "table_provenance",
      severity: "major",
      summary: `${role === "figure" ? "Figure" : "Table"} artifact ${declaredRef.artifactId} lacks complete provenance.`,
      rationale: problems.join("; "),
      location: binding ?? documentLocation(input, declaredRef.artifactId),
      actionKind: "fix_provenance",
      action: `Link ${declaredRef.artifactId} to recorded file hashes and one succeeded producing run.`,
      evidenceRefs: artifact ? [toResearchArtifactRef(artifact)] : [],
      runRefs: runRef ? [runRef] : [],
      affectedArtifactRefs: mergeRefs([
        [manuscriptRef],
        [declaredRef],
        runRef ? [runRef] : [],
      ]),
    }));
  }
  return findings;
}

function assertRenderRun(input: ReviewPreflightInput, manuscriptRef: ResearchArtifactRef): void {
  const render = input.renderRun!;
  if (render.kind !== "render_run" || render.status !== "active"
    || render.payload?.kind !== "render_run" || render.payload.schemaVersion !== 1) {
    throw new TypeError("renderRun must be a render_run artifact with the review render contract.");
  }
  if (!sameRef(render.payload.manuscriptRef, manuscriptRef)) throw new TypeError("renderRun references a different manuscript.");
  if (!Array.isArray(render.payload.diagnostics) || !Array.isArray(render.payload.outputs)
    || !Array.isArray(render.payload.checks)) {
    throw new TypeError("renderRun diagnostics, outputs, and checks must be arrays.");
  }
}

function assertCitationSet(input: ReviewPreflightInput): void {
  const citationSet = input.citationSet!;
  if (citationSet.kind !== "citation_set" || citationSet.status !== "active" || citationSet.payload?.kind !== "citation_set"
    || citationSet.payload.schemaVersion !== 1) {
    throw new TypeError("citationSet must be a citation_set artifact with the review citation contract.");
  }
  const declared = input.manuscript.payload.citationSetRef;
  if (!declared || !sameRef(toResearchArtifactRef(citationSet), declared)) {
    throw new TypeError("citationSet does not match the manuscript citationSetRef.");
  }
  if (!Array.isArray(citationSet.payload.entries) || !Array.isArray(citationSet.payload.citationKeys)) {
    throw new TypeError("citationSet entries and citationKeys must be arrays.");
  }
}

function preflightFinding(input: {
  checkId: ReviewPreflightCheckId;
  entity: string;
  lane: ReviewerLane;
  category: PreflightFindingDraft["category"];
  severity: PreflightFindingDraft["severity"];
  summary: string;
  rationale: string;
  location: ManuscriptLocation;
  actionKind: FindingActionKind;
  action: string;
  evidenceRefs?: readonly ResearchArtifactRef[];
  runRefs?: readonly ResearchArtifactRef[];
  affectedArtifactRefs: readonly ResearchArtifactRef[];
}): PreflightFindingDraft {
  const location = normalizeLocation(input.location);
  const entity = identifier(safeEntity(input.entity), "preflight finding entity");
  const digest = createHash("sha256")
    .update(`${input.checkId}\n${entity}\n${location.sectionId}\n${location.anchorText}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  const affectedArtifactRefs = mergeRefs([input.affectedArtifactRefs]);
  return Object.freeze({
    id: `preflight-${input.checkId}-${digest}`,
    dedupeKey: `preflight:${input.checkId}:${entity}`,
    source: "preflight" as const,
    lane: input.lane,
    reviewerId: "deterministic-preflight",
    assessment: "concern" as const,
    category: input.category,
    severity: input.severity,
    confidence: "high" as const,
    summary: text(input.summary, "preflight finding summary", 4_000),
    rationale: text(input.rationale, "preflight finding rationale", 8_000),
    location,
    actions: Object.freeze([Object.freeze({
      kind: input.actionKind,
      instruction: text(input.action, "preflight finding action", 8_000),
      targetArtifactRefs: Object.freeze(affectedArtifactRefs),
    })]),
    evidenceRefs: Object.freeze(mergeRefs([input.evidenceRefs ?? []])),
    runRefs: Object.freeze(mergeRefs([input.runRefs ?? []])),
    affectedArtifactRefs: Object.freeze(affectedArtifactRefs),
  });
}

function check(id: ReviewPreflightCheckId, findings: readonly PreflightFindingDraft[], detail: string): ReviewPreflightCheck {
  return Object.freeze({
    id,
    status: findings.length === 0 ? "passed" as const : "failed" as const,
    detail,
    findingIds: Object.freeze(findings.map((finding) => finding.id).sort((left, right) => left.localeCompare(right, "en"))),
  });
}

function documentLocation(input: ReviewPreflightInput, anchorText: string): ManuscriptLocation {
  const section = input.manuscript.payload.sections[0]!;
  return Object.freeze({ sectionId: section.sectionId, page: 1, anchorText });
}

function statementLocation(sectionId: string, statementId: string, anchorText: string): ManuscriptLocation {
  return Object.freeze({ sectionId, statementId, anchorText });
}

function findFigureTableBinding(
  input: ReviewPreflightInput,
  ref: ResearchArtifactRef,
): ManuscriptLocation | undefined {
  for (const section of input.manuscript.payload.sections) {
    for (const statement of section.statements) {
      if (statement.figureTableRefs.some((candidate) => sameRef(candidate, ref))) {
        return statementLocation(section.sectionId, statement.statementId, ref.artifactId);
      }
    }
  }
  return undefined;
}

function isExperimentFigureTable(
  artifact: ReviewFigureTableArtifact,
): artifact is ExperimentFigureTableArtifact {
  return "runAttemptId" in artifact.payload;
}

function safeEntity(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._:-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized.slice(0, 200) || "document";
}
