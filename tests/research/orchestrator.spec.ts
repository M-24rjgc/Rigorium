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
