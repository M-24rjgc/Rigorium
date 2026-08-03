import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaimGraph } from "../../src/research/claims/ClaimGraph.js";
import { ResearchOrchestrator } from "../../src/research/director/ResearchOrchestrator.js";
import { createResearchPlanTool } from "../../src/tool/builtin/researchPlan.js";
import type { ResearchPlanToolResult } from "../../src/tool/builtin/researchPlan.js";

function createTempProject(): string {
  return mkdtempSync(join(tmpdir(), "rigorium-plan-"));
}

function toolContext(projectRoot: string) {
  return { cwd: projectRoot, sessionId: "s", turnId: "t", abortSignal: undefined, now: () => new Date() } as never;
}

test("research_plan: seed claims yield a literature-first EIG plan", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({
      claimId: "c-thesis",
      statement: "Belief-driven orchestration outperforms fixed pipelines for research agents",
      falsificationCondition: "A pipeline baseline matches or beats it",
    });
    await graph.upsertClaim({ claimId: "c-eig", statement: "EIG per cost selects better actions", parentClaimIds: ["c-thesis"] });

    const tool = createResearchPlanTool();
    const result = (await tool.execute(
      { action: "plan" },
      toolContext(projectRoot),
    )) as unknown as { data: ResearchPlanToolResult };

    assert.equal(result.data.action, "plan");
    assert.equal(result.data.beliefCount, 2);
    assert.equal(result.data.shouldStop, false);
    assert.ok(result.data.actions.length > 0);
    // At seed state (no evidence), literature search dominates on gain/cost.
    assert.equal(result.data.actions[0]!.type, "literature_search");
    assert.equal(result.data.actions[0]!.claimId, "c-thesis");
    assert.equal(result.data.backtracking, false);
    assert.ok(result.data.summaryMarkdown.includes("Belief state"));
    assert.ok(result.data.summaryMarkdown.includes("literature_search"));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("research_plan: persisted evidence changes the plan (belief loop)", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({ claimId: "c-1", statement: "Evidence aware routing cuts latency" });

    // Evidence on disk: two supports (observed) — belief confidence rises,
    // uncertainty falls; the maturity discount reduces EIG per action but the
    // plan must still be computable and consistent with the new beliefs.
    const evidence = [
      { artifactId: "a1", revision: 1, kind: "run_attempt", status: "active", parents: [{ relation: "supports", artifact: { artifactId: "c-1", kind: "claim" } }], updatedAt: "2026-08-01T00:00:00.000Z" },
      { artifactId: "a2", revision: 1, kind: "run_attempt", status: "active", parents: [{ relation: "supports", artifact: { artifactId: "c-1", kind: "claim" } }], updatedAt: "2026-08-01T00:00:00.000Z" },
    ];
    const tool = createResearchPlanTool({
      orchestratorFactory: (root) =>
        new ResearchOrchestrator({ projectRoot: root, loadArtifacts: async () => evidence }),
    });
    const result = (await tool.execute(
      { action: "plan" },
      toolContext(projectRoot),
    )) as unknown as { data: ResearchPlanToolResult };
    // One claim-targeted action (per-claim dedup) — principle_revision may
    // also appear as an aggregate candidate, so assert on the claim action.
    const claimActions = result.data.actions.filter((action) => action.claimId === "c-1");
    assert.equal(claimActions.length, 1);
    assert.equal(claimActions[0]!.type, "literature_search");
    // Two observed supports → weight 0.5 → confidence 0.5+0.5·(0.5/1.5) = 0.67.
    assert.ok(result.data.summaryMarkdown.includes("confidence 0.67"));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("research_plan: persistSummary writes the summary into project state", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({ claimId: "c-1", statement: "A claim worth planning against" });

    const tool = createResearchPlanTool();
    const result = (await tool.execute(
      { action: "plan", persistSummary: true },
      toolContext(projectRoot),
    )) as unknown as { data: ResearchPlanToolResult };
    assert.ok(result.data.summaryPath);
    const summaryPath = result.data.summaryPath!;
    assert.ok(existsSync(summaryPath), "summary must be written to disk");
    const content = readFileSync(summaryPath, "utf8");
    assert.ok(content.includes("# Research Orchestration Summary"));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("research_plan: registered by default in the builtin registry", async () => {
  const { createBuiltinRegistry } = await import("../../src/tool/registry/createBuiltinRegistry.js");
  const registry = createBuiltinRegistry();
  const tool = registry.get("research_plan");
  assert.ok(tool, "research_plan must be registered by default");
  assert.equal(tool.name, "research_plan");
});
