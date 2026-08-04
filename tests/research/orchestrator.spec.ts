import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ResearchOrchestrator } from "../../src/research/director/ResearchOrchestrator.js";
import { ClaimGraph } from "../../src/research/claims/ClaimGraph.js";

function createTempProject(): string {
  return mkdtempSync(join(tmpdir(), "rigorium-orchestrator-"));
}

const NO_ARTIFACTS = async () => [];

test("ResearchOrchestrator: empty project yields a stop plan with guidance", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = new ResearchOrchestrator({ projectRoot, loadArtifacts: NO_ARTIFACTS });
    const plan = await orchestrator.planNextActions();
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.shouldStop, true);
    assert.match(plan.summaryMarkdown, /No claims yet/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ResearchOrchestrator: seeded claims produce ranked actions and a summary file", async () => {
  const projectRoot = createTempProject();
  try {
    // Seed two claims: one uncertain (action-worthy), one settled.
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: NO_ARTIFACTS });
    await graph.upsertClaim({ claimId: "c-uncertain", statement: "Hypothesis A improves B" });
    await graph.upsertClaim({ claimId: "c-settled", statement: "Established result" });
    const artifacts = [
      {
        artifactId: "run-1",
        revision: 1,
        kind: "run_attempt",
        status: "active",
        parents: [{ relation: "supports", artifact: { artifactId: "c-settled", kind: "claim" } }],
      },
      {
        artifactId: "run-2",
        revision: 1,
        kind: "run_attempt",
        status: "active",
        parents: [{ relation: "supports", artifact: { artifactId: "c-settled", kind: "claim" } }],
      },
    ];

    const orchestrator = new ResearchOrchestrator({ projectRoot, loadArtifacts: async () => artifacts });
    const plan = await orchestrator.planNextActions();
    assert.equal(plan.shouldStop, false);
    assert.ok(plan.actions.length >= 1);
    assert.equal(plan.actions[0]!.claimId, "c-uncertain", "uncertain claim must rank first");
    assert.ok(plan.beliefs.length === 2);
    // Evidence reduces the settled claim's uncertainty below the bare claim.
    const settled = plan.beliefs.find((belief) => belief.claimId === "c-settled")!;
    const uncertain = plan.beliefs.find((belief) => belief.claimId === "c-uncertain")!;
    assert.ok(settled.uncertainty < uncertain.uncertainty, `settled=${settled.uncertainty} uncertain=${uncertain.uncertainty}`);
    assert.ok(settled.confidence > uncertain.confidence, `settled=${settled.confidence} uncertain=${uncertain.confidence}`);
    assert.match(plan.summaryMarkdown, /c-uncertain/);

    const summaryPath = await orchestrator.writeSummary(plan.summaryMarkdown);
    assert.match(readFileSync(summaryPath, "utf8"), /Recommended actions/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ResearchOrchestrator: backtracking is reported when a claim gets falsified", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: NO_ARTIFACTS });
    await graph.upsertClaim({ claimId: "c1", statement: "A beats B" });

    const challengingArtifacts = [
      {
        artifactId: "finding-1",
        revision: 1,
        kind: "finding",
        status: "active",
        parents: [{ relation: "challenges", artifact: { artifactId: "c1", kind: "claim" } }],
      },
      {
        artifactId: "finding-2",
        revision: 1,
        kind: "finding",
        status: "active",
        parents: [{ relation: "challenges", artifact: { artifactId: "c1", kind: "claim" } }],
      },
      {
        artifactId: "finding-3",
        revision: 1,
        kind: "finding",
        status: "active",
        parents: [{ relation: "challenges", artifact: { artifactId: "c1", kind: "claim" } }],
      },
      {
        artifactId: "finding-4",
        revision: 1,
        kind: "finding",
        status: "active",
        parents: [{ relation: "challenges", artifact: { artifactId: "c1", kind: "claim" } }],
      },
    ];

    // Round 1: no evidence — active. Same instance across rounds (the
    // production pattern): previousBeliefs carries over inside the instance.
    let evidence: unknown[] = [];
    const orchestrator = new ResearchOrchestrator({
      projectRoot,
      loadArtifacts: async () => evidence as never[],
    });
    const first = await orchestrator.planNextActions();
    assert.equal(first.backtracking, false);

    // Round 2: challenge evidence lands → claim falsified → backtracking.
    evidence = challengingArtifacts;
    const secondPlan = await orchestrator.planNextActions();
    const c1 = secondPlan.beliefs.find((belief) => belief.claimId === "c1")!;
    assert.equal(c1.status, "falsified", "four review findings (weight 1.2) must falsify the claim");
    assert.equal(secondPlan.backtracking, true, "previous round had no evidence");
    assert.ok(secondPlan.revisions.length >= 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ResearchOrchestrator: venue context reports style-profile readiness", async () => {
  const projectRoot = createTempProject();
  try {
    const { StyleProfileStore } = await import("../../src/research/manuscript/style/StyleProfileStore.js");
    const store = new StyleProfileStore({ projectRoot });
    await store.save({
      venue: "iclr",
      computedAt: "2026-08-03T00:00:00.000Z",
      learnedFrom: ["p1"],
      storyArc: [],
      sentenceTemplates: [],
      paragraphPatterns: [],
      figureConventions: [],
      writingVoice: "Direct.",
    });
    const orchestrator = new ResearchOrchestrator({ projectRoot, loadArtifacts: NO_ARTIFACTS });
    const plan = await orchestrator.planNextActions();
    assert.equal(plan.venue?.id, "iclr");
    assert.equal(plan.venue?.styleProfileReady, true);
    assert.match(plan.summaryMarkdown, /style profile ready/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("orchestrator: blocker/major findings without later referencing artifacts surface as open", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({ claimId: "c1", statement: "A claim needing review" });

    // Create a review round with a blocker finding (production artifact path).
    const { createResearchArtifact, toResearchArtifactRef } = await import("../../src/research/artifacts/index.js");
    const { appendProjectResearchArtifacts } = await import("../../src/research/artifacts/repository.js");
    const manuscript = createResearchArtifact({
      kind: "manuscript_version",
      artifactId: "m1",
      producer: { kind: "user" },
      payload: { schemaVersion: 1, kind: "manuscript_version", title: "T", target: { venue: "generic", mode: "internal_draft" }, sections: [], citationSet: null, figureTables: [], evidencePacks: [], latex: "", revisionNote: "", complianceChecks: [], renderRef: null },
      now: new Date(Date.now() - 60_000),
    });
    const finding = createResearchArtifact({
      kind: "finding",
      artifactId: "review-f-1",
      producer: { kind: "agent" },
      payload: {
        schemaVersion: 1, kind: "finding", reviewRoundId: "r1", findingId: "f-1", dedupeKey: "d1",
        source: "reviewer", lanes: ["method"], reviewerIds: ["rv1"], assessment: "concern",
        category: "method", severity: "blocker", confidence: "high",
        summary: "The method section lacks a baseline comparison",
        rationale: "A baseline is required for a fair comparison.",
        location: { sectionId: "method", anchorText: "baseline" },
        actions: [{ kind: "add_evidence", instruction: "Add a baseline run.", targetArtifactRefs: [] }],
        evidenceRefs: [], runRefs: [], affectedArtifactRefs: [], mergedFromFindingIds: [],
      },
      parents: [{ relation: "derived_from", artifact: toResearchArtifactRef(manuscript) }],
      now: new Date(Date.now() - 50_000),
    });
    await appendProjectResearchArtifacts({ projectRoot, artifacts: [manuscript, finding] });

    const orchestrator = new ResearchOrchestrator({ projectRoot });
    const plan = await orchestrator.planNextActions();

    assert.ok(plan.openFindings, "an unreferenced blocker must be listed as open");
    assert.equal(plan.openFindings!.length, 1);
    assert.equal(plan.openFindings![0]!.findingId, "review-f-1");
    assert.equal(plan.openFindings![0]!.severity, "blocker");
    assert.match(plan.summaryMarkdown, /Open review findings/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("orchestrator: findings referenced by later artifacts are closed", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({ claimId: "c1", statement: "A claim needing review" });

    const { createResearchArtifact, toResearchArtifactRef } = await import("../../src/research/artifacts/index.js");
    const { appendProjectResearchArtifacts } = await import("../../src/research/artifacts/repository.js");
    const manuscript = createResearchArtifact({
      kind: "manuscript_version",
      artifactId: "m1",
      producer: { kind: "user" },
      payload: { schemaVersion: 1, kind: "manuscript_version", title: "T", target: { venue: "generic", mode: "internal_draft" }, sections: [], citationSet: null, figureTables: [], evidencePacks: [], latex: "", revisionNote: "", complianceChecks: [], renderRef: null },
      now: new Date(Date.now() - 60_000),
    });
    const finding = createResearchArtifact({
      kind: "finding",
      artifactId: "review-f-2",
      producer: { kind: "agent" },
      payload: {
        schemaVersion: 1, kind: "finding", reviewRoundId: "r1", findingId: "f-2", dedupeKey: "d2",
        source: "reviewer", lanes: ["evidence"], reviewerIds: ["rv2"], assessment: "concern",
        category: "evidence", severity: "major", confidence: "high",
        summary: "Missing supporting run",
        rationale: "The claim needs a supporting run.",
        location: { sectionId: "results", anchorText: "run" },
        actions: [{ kind: "rerun_experiment", instruction: "Run the experiment.", targetArtifactRefs: [] }],
        evidenceRefs: [], runRefs: [], affectedArtifactRefs: [], mergedFromFindingIds: [],
      },
      parents: [{ relation: "derived_from", artifact: toResearchArtifactRef(manuscript) }],
      now: new Date(Date.now() - 50_000),
    });
    // A later run_attempt artifact REFERENCES the finding — closure.
    const run = createResearchArtifact({
      kind: "run_attempt",
      artifactId: "run-1",
      producer: { kind: "agent" },
      payload: {
        schemaVersion: 1, kind: "run_attempt", attemptId: "run-1", experimentId: "e1",
        specRevision: 1, specDigest: "d", adapterId: "local", jobId: "j1", status: "succeeded",
        grantMode: "granted", preparedAt: "2026-08-05T00:00:00.000Z", artifactIds: [], metricObservationIds: [],
      },
      parents: [
        { relation: "derived_from", artifact: toResearchArtifactRef(manuscript) },
        { relation: "uses", artifact: toResearchArtifactRef(finding) },
      ],
      now: new Date(Date.now() - 40_000),
    });
    await appendProjectResearchArtifacts({ projectRoot, artifacts: [manuscript, finding, run] });

    const orchestrator = new ResearchOrchestrator({ projectRoot });
    const plan = await orchestrator.planNextActions();

    assert.equal(plan.openFindings, undefined, "a referenced finding is closed");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
