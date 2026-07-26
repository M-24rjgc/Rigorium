import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import {
  RESEARCH_ARTIFACT_KINDS,
  appendProjectResearchArtifacts,
  createResearchArtifact,
  loadProjectResearchArtifactRepository,
  toResearchArtifactRef,
  type ResearchArtifactEnvelope,
  type ResearchArtifactRef,
} from "../../../src/research/artifacts/index.js";
import {
  completeResearchIdea,
  discoverResearchIdeas,
} from "../../../src/research/design/workflow.js";
import {
  createResearchDirectorDecision,
  createResearchDirectorPlan,
  assertNoFixedStageFields,
} from "../../../src/research/director/index.js";
import {
  createExperimentAnalysisReport,
} from "../../../src/research/experimentation/analysis/index.js";
import {
  confirmExecutionJob,
  issueExecutionGrant,
  loadExperimentManifest,
  recordObservedBaseline,
  recordReportedBaseline,
  saveExperimentSpec,
  submitLocalExperimentRun,
  type BaselineObservation,
  type MetricObservation,
  type RunAttempt,
} from "../../../src/research/experimentation/index.js";
import { createEvidencePackArtifact } from "../../../src/research/literature/evidencePack.js";
import {
  createImplementationSnapshotArtifact,
  createMethodSpecArtifact,
  runVerificationCheck,
} from "../../../src/research/method/index.js";
import {
  createCitationSet,
  createManuscriptVersion,
  renderManuscript,
  verifyFigureTableArtifactFiles,
  type ManuscriptCommandRunner,
} from "../../../src/research/manuscript/index.js";
import {
  createRevisionDecision,
  createReviewRound,
} from "../../../src/research/review/index.js";
import { researchDesignInput } from "../design/fixtures.js";
import { methodSpecInput } from "../method/fixtures.js";
import {
  artifactStatus,
  cleanLaneReports,
  createE2eTemporaryRoot,
  latestArtifactRevisions,
  removeValidatedE2eTemporaryRoot,
  sha256Text,
  timelineDate,
} from "./fixtures.js";

const temporaryRoots = new Set<string>();

after(async () => {
  for (const root of [...temporaryRoots].reverse()) await removeValidatedE2eTemporaryRoot(root);
});

test("research E2E chain starts from a broad direction", async () => {
  await runResearchChain("discover");
});

test("research E2E chain starts from a user supplied idea", async () => {
  await runResearchChain("complete");
});

async function runResearchChain(entry: "discover" | "complete"): Promise<void> {
  const projectRoot = await temporaryRoot(`${entry}-project`);
  const verificationWorkspace = await temporaryRoot(`${entry}-verification`);
  let minute = entry === "discover" ? 0 : 600;
  const nextNow = () => timelineDate(minute++);

  const evidence = createEvidencePackArtifact({
    artifactId: `${entry}-evidence`,
    entries: [
      {
        id: "evidence-prior",
        paperId: "prior-work",
        locator: { sourceId: "openalex", recordId: "W1", page: 1 },
        snapshot: { content: "Existing methods use a static aggregation mechanism." },
      },
      {
        id: "evidence-gap",
        paperId: "gap-work",
        locator: { sourceId: "paperqa", recordId: "paper-2", page: 4 },
        snapshot: { content: "Current evaluation omits distribution-shift calibration." },
      },
    ],
    producer: { kind: "import", id: "e2e-fixture" },
    now: nextNow(),
  });

  const designInput = researchDesignInput(entry);
  const designRequest = {
    portfolio: {
      idea: designInput.idea,
      candidates: designInput.candidates,
      constraints: designInput.constraints,
      evidenceRequest: designInput.evidenceRequest,
      citations: designInput.citations,
      parents: [{ relation: "uses" as const, artifact: toResearchArtifactRef(evidence) }],
      artifactId: `${entry}-portfolio`,
    },
    challenge: {
      independentCriticisms: designInput.independentCriticisms,
      similarWorkRescans: designInput.similarWorkRescans,
      evidenceRescans: designInput.evidenceRescans,
    },
    comparison: {
      objectives: designInput.objectives,
      assessments: designInput.assessments,
    },
    decision: {
      ...designInput.decision,
      eliminations: designInput.eliminations,
    },
    brief: designInput.brief,
    // Design artifacts retain the evidence parent and carry its immutable
    // envelope so the complete design closure remains independently verifiable.
    sourceArtifacts: [evidence],
    now: nextNow(),
  };
  const design = entry === "discover"
    ? discoverResearchIdeas(designRequest)
    : completeResearchIdea(designRequest);
  assert.equal(design.entry, entry);
  assert.equal(design.researchBrief.payload.status, "ready");

  const methodSpec = createMethodSpecArtifact({
    brief: design.researchBrief,
    spec: {
      ...methodSpecInput(),
      artifactId: `${entry}-method-spec`,
      now: nextNow(),
    },
  });

  await writeTextFile(verificationWorkspace, "src/model.js", "process.stdout.write('model-ok\\n');\n");
  await writeTextFile(verificationWorkspace, "tests/model.test.js", "process.stdout.write('test-ok\\n');\n");
  await writeTextFile(verificationWorkspace, "config/e2e.json", "{\"fixture\":true}\n");
  const verificationRecords = [];
  for (const [index, check] of methodSpec.payload.verificationChecks.entries()) {
    verificationRecords.push(await runVerificationCheck({
      projectRoot,
      workspaceRoot: verificationWorkspace,
      check,
      recordId: `${entry}-verification-${index + 1}`,
      now: nextNow(),
    }));
  }
  assert.equal(verificationRecords.every((record) => record.status === "passed"), true);

  const implementationSnapshot = await createImplementationSnapshotArtifact({
    methodSpec,
    routeId: "route-node",
    implementationRoot: verificationWorkspace,
    configFiles: ["config/e2e.json"],
    verificationRecords,
    observedConclusions: [{
      id: `${entry}-observed-conclusion`,
      expectedConclusionId: "expected-calibration",
      statement: "All declared isolated verification checks passed.",
      outcome: "supported",
      verificationRecordIds: verificationRecords.map((record) => record.id),
    }],
    artifactId: `${entry}-implementation-snapshot`,
    now: nextNow(),
  });

  const experimentId = `${entry}-experiment`;
  const sourceArtifacts = [evidence, ...design.artifacts, methodSpec, implementationSnapshot];
  const experimentSpec = await saveExperimentSpec({
    projectRoot,
    spec: {
      experimentId,
      title: `${entry} calibrated aggregation evaluation`,
      description: "Deterministic local E2E experiment.",
      expectedMetrics: ["accuracy"],
      parents: [{ relation: "uses", artifact: toResearchArtifactRef(implementationSnapshot) }],
      sourceArtifacts,
      localWorker: {
        kind: "mock",
        result: {
          metrics: [{ name: "accuracy", value: entry === "discover" ? 0.93 : 0.92, direction: "maximize", split: "held-out" }],
          artifacts: [{
            path: "results/metrics.json",
            content: JSON.stringify({ accuracy: entry === "discover" ? 0.93 : 0.92 }),
            role: "output",
            mediaType: "application/json",
          }],
        },
      },
    },
    now: nextNow(),
  });
  assert.equal(experimentSpec.value.parents.some((parent) => parent.artifact.artifactId === implementationSnapshot.artifactId), true);
  assert.equal(experimentSpec.manifest.artifactEnvelopes.some((artifact) => artifact.artifactId === implementationSnapshot.artifactId), true);

  const grant = await issueExecutionGrant({
    projectRoot,
    grant: {
      grantId: `${entry}-grant`,
      experimentId,
      mode: "confirm_each",
      reason: "Execute the two deterministic E2E local runs.",
      budget: { maxAttempts: 2 },
    },
    now: nextNow(),
  });
  const completedRuns = [];
  for (const [index, jobId] of [`${entry}-job-one`, `${entry}-job-two`].entries()) {
    await confirmExecutionJob({
      projectRoot,
      grantId: grant.value.payload.grantId,
      jobId,
      now: nextNow(),
    });
    completedRuns.push((await submitLocalExperimentRun({
      projectRoot,
      experimentId,
      grantId: grant.value.payload.grantId,
      jobId,
      run: {
        routeId: "route-node",
        parameters: { seed: index + 1 },
        slices: { distribution: "held-out" },
      },
      now: nextNow(),
    })).value);
  }
  assert.equal(completedRuns.every((run) => run.payload.status === "succeeded"), true);

  const firstRun = completedRuns[0]!;
  const firstMetricId = firstRun.payload.metricObservationIds[0]!;
  await recordReportedBaseline({
    projectRoot,
    baseline: {
      baselineId: `${entry}-reported-baseline`,
      experimentId,
      metricName: "accuracy",
      reportedValue: 0.89,
      split: "held-out",
      direction: "maximize",
      citation: { text: "Prior work, Table 1", url: "https://example.invalid/prior-work" },
    },
    now: nextNow(),
  });
  await recordObservedBaseline({
    projectRoot,
    baseline: {
      baselineId: `${entry}-observed-baseline`,
      experimentId,
      runAttemptId: firstRun.payload.attemptId,
      metricObservationId: firstMetricId,
    },
    now: nextNow(),
  });

  const manifest = await loadExperimentManifest({ projectRoot });
  assert.ok(manifest);
  const latestRuns = latestArtifactRevisions(manifest.runAttempts);
  assert.equal(latestRuns.length, 2);
  assert.equal(latestRuns.every((run) => run.payload.status === "succeeded"), true);
  assertObservedBaselinesResolve(manifest.baselineObservations, latestRuns, manifest.metricObservations);

  const analysisFiles = await createAnalysisFiles(projectRoot, entry, completedRuns);
  const analysis = createExperimentAnalysisReport({
    runAttempts: manifest.runAttempts,
    metricObservations: manifest.metricObservations,
    baselineObservations: manifest.baselineObservations,
    objectives: [{ experimentId, metricName: "accuracy", direction: "maximize", split: "held-out" }],
    ablationFactors: [{ name: "seed", controlValue: 1 }],
    robustnessDimensions: [{ name: "distribution" }],
    budget: { maxAttempts: 2, maxWallTimeMs: 2_000, maxCostUsd: 1 },
    figureTable: {
      artifactId: `${entry}-analysis-figure-table`,
      items: [{
        itemId: `${entry}-accuracy-table`,
        kind: "table",
        label: `tab:${entry}-accuracy`,
        data: [analysisFiles.data],
        script: {
          status: "available",
          file: analysisFiles.script,
          command: [process.execPath, analysisFiles.script.path],
        },
        output: analysisFiles.output,
        captionLatex: "Held-out accuracy from deterministic local runs.",
        captionEvidenceRefs: [toResearchArtifactRef(evidence)],
        citationKeys: ["prior2025"],
      }],
    },
    analysisId: `${entry}-analysis`,
    producer: { kind: "tool", id: "e2e-analysis", toolName: "experiment_analysis" },
    now: nextNow(),
  });
  const figureTable = analysis.figureTableArtifact;
  assert.ok(figureTable);
  assert.equal(figureTable.parents.filter((parent) => parent.artifact.kind === "run_attempt").length, latestRuns.length);
  const figureVerification = await verifyFigureTableArtifactFiles({ projectRoot, artifact: figureTable });
  assert.equal(figureVerification.status, "verified");

  const reportedComparison = analysis.baselineComparisons.find((comparison) => comparison.baselineRef.artifactId === `${entry}-reported-baseline`);
  const observedComparison = analysis.baselineComparisons.find((comparison) => comparison.baselineRef.artifactId === `${entry}-observed-baseline`);
  assert.equal(reportedComparison?.provenance, "reported_not_rerun");
  assert.equal(observedComparison?.provenance, "observed_run");

  const citationSet = createCitationSet({
    artifactId: `${entry}-citations`,
    bibtexEntries: [{
      citationKey: "prior2025",
      entryType: "article",
      paperId: "prior-work",
      fields: {
        title: "Static Aggregation Under Shift",
        author: "Example Author",
        year: "2025",
      },
    }],
    producer: { kind: "import", id: "e2e-fixture" },
    now: nextNow(),
  });
  const manuscript = createManuscriptVersion({
    artifactId: `${entry}-manuscript`,
    title: `${entry} adaptive aggregation manuscript`,
    latex: `\\documentclass{article}
\\begin{document}
Adaptive aggregation is evaluated against prior work \\citep{prior2025}.
\\label{pilotdeck-main-matter-end}
\\bibliographystyle{plain}
\\bibliography{references}
\\end{document}`,
    target: { venue: "generic", mode: "internal_draft" },
    sections: [
      {
        sectionId: "introduction",
        kind: "introduction",
        title: "Introduction",
        requestedOutput: "preserve",
        minimumMaturity: "citation_only",
        statements: [{
          statementId: "prior-work",
          kind: "context",
          maturity: "evidence_snapshot",
          citationKeys: ["prior2025"],
          evidenceRefs: [toResearchArtifactRef(evidence)],
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
          statementId: "local-results",
          kind: "result",
          maturity: "observed_result",
          citationKeys: [],
          evidenceRefs: [toResearchArtifactRef(evidence)],
          figureTableRefs: [toResearchArtifactRef(figureTable)],
          textOrigin: "user",
        }],
      },
    ],
    revisionNote: "Deterministic end-to-end research-chain fixture.",
    producer: { kind: "agent", id: "e2e-writer" },
    citationSet,
    figureTables: [figureTable],
    evidencePacks: [evidence],
    now: nextNow(),
  });
  const renderRun = await renderManuscript({
    projectRoot,
    manuscript,
    citationSet,
    figureTables: [figureTable],
    engine: "pdflatex",
    producer: { kind: "tool", id: "e2e-render", toolName: "manuscript_latex" },
    artifactId: `${entry}-render`,
    now: nextNow(),
  }, {
    runner: syntheticRenderRunner,
    engineProbes: [{ name: "pdflatex", status: "available", executable: "pdflatex", version: "synthetic" }],
  });
  assert.equal(renderRun.payload.compileStatus, "succeeded");
  assert.equal(renderRun.payload.exportBoundary.performed, false);

  const review = createReviewRound({
    manuscript,
    renderRun,
    citationSet,
    figureTableArtifacts: [figureTable],
    runAttempts: latestRuns,
    laneReports: cleanLaneReports(),
    artifactId: `${entry}-review-round`,
    now: nextNow(),
  });
  assert.equal(review.reviewRound.payload.status, "pass");
  assert.equal(review.findings.length, 0);
  assert.equal(review.reviewRound.payload.laneSummaries.length, 7);

  const unrelated = createResearchArtifact({
    kind: "method_spec",
    artifactId: `${entry}-unrelated-method-spec`,
    payload: { branch: "unrelated" },
    producer: { kind: "user" },
    now: nextNow(),
  });
  const experimentArtifacts = uniqueArtifactEnvelopes([
    ...manifest.specs,
    ...manifest.executionGrants,
    ...manifest.runAttempts,
    ...manifest.metricObservations,
    ...manifest.baselineObservations,
    ...manifest.artifactEnvelopes,
  ]);
  const materializedArtifacts = uniqueArtifactEnvelopes([
    evidence,
    ...design.artifacts,
    methodSpec,
    implementationSnapshot,
    ...experimentArtifacts,
    citationSet,
    figureTable,
    manuscript,
    renderRun,
    ...review.findings,
    review.reviewRound,
    unrelated,
  ]);
  const revisionDecision = createRevisionDecision({
    reviewRound: review.reviewRound,
    findings: review.findings,
    resolutions: [],
    artifacts: materializedArtifacts,
    artifactId: `${entry}-revision-decision`,
    now: nextNow(),
  });
  assert.equal(revisionDecision.decision.payload.status, "no_revision");

  const initialAppend = await appendProjectResearchArtifacts({
    projectRoot,
    artifacts: revisionDecision.artifacts,
    now: nextNow(),
  });
  assert.equal(initialAppend.persisted, true);
  const persisted = await loadProjectResearchArtifactRepository({ projectRoot });
  assert.ok(persisted);
  assert.equal(artifactStatus(persisted.artifacts, toResearchArtifactRef(unrelated)), "active");

  const revisedEvidence = createEvidencePackArtifact({
    artifactId: evidence.artifactId,
    revision: 2,
    parents: [{ relation: "supersedes", artifact: toResearchArtifactRef(evidence) }],
    entries: [
      {
        id: "evidence-prior",
        paperId: "prior-work",
        locator: { sourceId: "openalex", recordId: "W1", page: 1 },
        snapshot: { content: "Revised evidence withdraws the static aggregation conclusion." },
      },
      {
        id: "evidence-gap",
        paperId: "gap-work",
        locator: { sourceId: "paperqa", recordId: "paper-2", page: 4 },
        snapshot: { content: "Current evaluation omits distribution-shift calibration." },
      },
    ],
    producer: { kind: "import", id: "e2e-fixture" },
    now: nextNow(),
  });
  const invalidated = await appendProjectResearchArtifacts({
    projectRoot,
    artifacts: [revisedEvidence],
    now: nextNow(),
  });
  const staleIds = new Set(invalidated.staleRefs.map((ref) => ref.artifactId));
  for (const artifact of [
    design.portfolio,
    design.researchBrief,
    methodSpec,
    implementationSnapshot,
    experimentSpec.value,
    manuscript,
    renderRun,
    review.reviewRound,
    revisionDecision.decision,
  ]) {
    assert.equal(staleIds.has(artifact.artifactId), true, `${artifact.artifactId} should become stale after the evidence revision.`);
    assert.equal(artifactStatus(invalidated.snapshot.artifacts, toResearchArtifactRef(artifact)), "stale");
  }
  assert.equal(artifactStatus(invalidated.snapshot.artifacts, toResearchArtifactRef(unrelated)), "active");

  const directorPlan = createResearchDirectorPlan({
    goal: {
      objective: "Repair every stale result after evidence changes.",
      successCriteria: ["Every active conclusion is derived from current evidence."],
    },
    artifacts: invalidated.snapshot.artifacts,
    capabilities: [{
      capabilityId: "repair-artifacts",
      toolName: "e2e_repair",
      operation: "recompute",
      available: true,
      concurrencySafe: true,
      accepts: [],
      produces: RESEARCH_ARTIFACT_KINDS,
      estimatedCostUnits: 1,
      estimatedDurationMs: 1,
    }],
    budget: { limitUnits: 1_000, spentUnits: 0 },
    permissions: { defaultAccess: "allow" },
    now: nextNow(),
  });
  assert.equal(directorPlan.mode, "repair");
  assert.doesNotThrow(() => assertNoFixedStageFields(directorPlan));
  const directorAction = directorPlan.actions.find((action) => action.blockedBoundaryIds.length === 0);
  assert.ok(directorAction);
  const directorDecision = createResearchDirectorDecision({
    plan: directorPlan,
    receipts: [{
      receiptId: `${entry}-director-receipt`,
      planId: directorPlan.planId,
      actionId: directorAction.actionId,
      capabilityId: directorAction.capabilityId,
      status: "succeeded",
      outcome: "artifact_revision_required",
      outputArtifactRefs: [],
      costUnits: 0,
      durationMs: 0,
      completedAt: nextNow().toISOString(),
    }],
    now: nextNow(),
  });
  assert.equal(directorDecision.decision, "revise");
  assert.doesNotThrow(() => assertNoFixedStageFields(directorDecision));
}

const syntheticRenderRunner: ManuscriptCommandRunner = async (request) => {
  if (!request.cwd) throw new Error("Synthetic manuscript runner requires a working directory.");
  const buildDirectory = join(request.cwd, "build");
  await mkdir(buildDirectory, { recursive: true });
  await writeFile(join(buildDirectory, "main.pdf"), "%PDF-1.4\n% deterministic E2E render\n", "utf8");
  await writeFile(join(buildDirectory, "main.log"), "Synthetic compiler log.\n", "utf8");
  return { exitCode: 0, stdout: "synthetic compiler output", stderr: "", timedOut: false };
};

async function createAnalysisFiles(
  projectRoot: string,
  entry: "discover" | "complete",
  runs: readonly { payload: { attemptId: string; metricObservationIds: readonly string[] } }[],
) {
  const dataContent = ["attempt_id,metric_observation_id", ...runs.map((run) => `${run.payload.attemptId},${run.payload.metricObservationIds[0]}`)].join("\n").concat("\n");
  const scriptContent = "process.stdout.write('rendered e2e analysis\\n');\n";
  const outputContent = "Deterministic analysis table output.\n";
  const data = { path: `analysis/${entry}-metrics.csv`, contentHash: sha256Text(dataContent), mediaType: "text/csv" };
  const script = { path: `analysis/${entry}-render.js`, contentHash: sha256Text(scriptContent), mediaType: "text/javascript" };
  const output = { path: `analysis/${entry}-results.txt`, contentHash: sha256Text(outputContent), mediaType: "text/plain" };
  await writeTextFile(projectRoot, data.path, dataContent);
  await writeTextFile(projectRoot, script.path, scriptContent);
  await writeTextFile(projectRoot, output.path, outputContent);
  return { data, script, output };
}

function assertObservedBaselinesResolve(
  baselines: readonly BaselineObservation[],
  runs: readonly RunAttempt[],
  metrics: readonly MetricObservation[],
): void {
  for (const baseline of baselines) {
    if (baseline.payload.provenance.kind !== "observed") continue;
    const provenance = baseline.payload.provenance;
    const run = runs.find((candidate) => candidate.payload.attemptId === provenance.runAttemptId);
    const metric = metrics.find((candidate) => candidate.artifactId === provenance.metricObservationId);
    assert.equal(run?.payload.status, "succeeded");
    assert.equal(run?.payload.metricObservationIds.includes(provenance.metricObservationId), true);
    assert.equal(metric?.payload.runAttemptId, provenance.runAttemptId);
    assert.equal(metric?.payload.value, baseline.payload.value);
  }
}

function uniqueArtifactEnvelopes(artifacts: readonly ResearchArtifactEnvelope[]): ResearchArtifactEnvelope[] {
  const unique = new Map<string, ResearchArtifactEnvelope>();
  for (const artifact of artifacts) {
    const key = `${artifact.artifactId}@${artifact.revision}`;
    const previous = unique.get(key);
    if (previous && (previous.kind !== artifact.kind || previous.contentHash !== artifact.contentHash)) {
      throw new Error(`Conflicting E2E artifact envelopes for ${key}.`);
    }
    if (!previous) unique.set(key, artifact);
  }
  return [...unique.values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId, "en")
    || left.revision - right.revision);
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await createE2eTemporaryRoot(label);
  temporaryRoots.add(root);
  return root;
}

async function writeTextFile(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
