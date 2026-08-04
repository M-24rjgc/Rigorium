import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaimGraph } from "../../src/research/claims/ClaimGraph.js";
import { createClaimMonitorTool, deriveQuery } from "../../src/tool/builtin/claimMonitor.js";
import type { ClaimMonitorToolResult } from "../../src/tool/builtin/claimMonitor.js";
import type { ResearchArtifactRef } from "../../src/research/artifacts/types.js";

function createTempProject(): string {
  return mkdtempSync(join(tmpdir(), "rigorium-monitor-"));
}

test("deriveQuery: strips stop words and keeps content keywords", () => {
  const query = deriveQuery("Attention-based transformers improve relation extraction on biomedical corpora", "c1");
  assert.match(query, /attention/i);
  assert.match(query, /transformers/i);
  assert.ok(!/improve/i.test(query), "stop word 'improve' must be dropped");
  assert.ok(query.length > 10);
});

test("deriveQuery: degenerate statements fall back to the claim id", () => {
  assert.equal(deriveQuery("the and for", "c-42"), "c-42");
});

test("claim_monitor: active claims get queries; falsified claims are excluded", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({ claimId: "c-live", statement: "Graph neural networks improve molecular property prediction" });
    await graph.upsertClaim({ claimId: "c-dead", statement: "An old claim that was challenged" });

    // Falsify c-dead with strong challenges.
    const challenges = [
      { artifactId: "f1", revision: 1, kind: "finding", status: "active", parents: [{ relation: "challenges", artifact: { artifactId: "c-dead", kind: "claim" } }] },
      { artifactId: "f2", revision: 1, kind: "finding", status: "active", parents: [{ relation: "challenges", artifact: { artifactId: "c-dead", kind: "claim" } }] },
      { artifactId: "f3", revision: 1, kind: "finding", status: "active", parents: [{ relation: "challenges", artifact: { artifactId: "c-dead", kind: "claim" } }] },
      { artifactId: "f4", revision: 1, kind: "finding", status: "active", parents: [{ relation: "challenges", artifact: { artifactId: "c-dead", kind: "claim" } }] },
    ];
    const tool = createClaimMonitorTool({ loadArtifacts: async () => challenges });
    const result = (await tool.execute(
      { action: "check" },
      { cwd: projectRoot, sessionId: "s", turnId: "t", abortSignal: undefined, now: () => new Date() } as never,
    )) as unknown as { data: ClaimMonitorToolResult };
    const data = result.data as Extract<ClaimMonitorToolResult, { action: "check" }>;
    assert.equal(data.totalClaims, 2);
    assert.equal(data.monitored.length, 1, "only the active claim is monitored");
    assert.equal(data.monitored[0]!.claimId, "c-live");
    assert.match(data.monitored[0]!.query, /neural/i);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("claim_monitor: default loader sees on-disk evidence (not evidence-blind)", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({ claimId: "c-evidence", statement: "A claim with real evidence" });

    // Land a challenging finding in the artifact repository (production path).
    const { createResearchArtifact } = await import("../../src/research/artifacts/types.js");
    const { appendProjectResearchArtifacts } = await import("../../src/research/artifacts/repository.js");
    // The artifact DAG references claims as parent nodes (kind "claim" is a
    // valid ref target even though the claim itself lives in the claim graph).
    const claimRef: ResearchArtifactRef = {
      artifactId: "c-evidence",
      revision: 1,
      kind: "claim",
      contentHash: `sha256:${"a".repeat(64)}`,
    };
    const finding = createResearchArtifact({
      kind: "finding",
      payload: { finding: "contradicts" },
      producer: { kind: "tool", toolName: "research_review" },
      parents: [{ relation: "challenges", artifact: claimRef }],
    });
    await appendProjectResearchArtifacts({ projectRoot, artifacts: [finding] });

    // No loadArtifacts override — the tool's real default loader runs.
    const tool = createClaimMonitorTool();
    const result = (await tool.execute(
      { action: "check" },
      { cwd: projectRoot, sessionId: "s", turnId: "t", abortSignal: undefined, now: () => new Date() } as never,
    )) as unknown as { data: ClaimMonitorToolResult };
    const data = result.data as Extract<ClaimMonitorToolResult, { action: "check" }>;
    const monitored = data.monitored.find((claim) => claim.claimId === "c-evidence");
    assert.ok(monitored, "claim with on-disk evidence must be monitored");
    assert.equal(monitored!.evidenceCount, 1, "parents must survive the default loader");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("claim_monitor: limit caps the monitored list", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    for (let i = 0; i < 5; i += 1) {
      await graph.upsertClaim({ claimId: `c-${i}`, statement: `Hypothesis number ${i} about representation learning` });
    }
    const tool = createClaimMonitorTool();
    const result = (await tool.execute(
      { action: "check", limit: 2 },
      { cwd: projectRoot, sessionId: "s", turnId: "t", abortSignal: undefined, now: () => new Date() } as never,
    )) as unknown as { data: ClaimMonitorToolResult };
    const data = result.data as Extract<ClaimMonitorToolResult, { action: "check" }>;
    assert.equal(data.monitored.length, 2);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("claim_monitor: claim_create registers a claim in the production write path", async () => {
  const projectRoot = createTempProject();
  try {
    const tool = createClaimMonitorTool();
    const result = (await tool.execute(
      { action: "claim_create", claimId: "c-new", statement: "A freshly registered research question", falsificationCondition: "The null result holds" },
      { cwd: projectRoot, sessionId: "s", turnId: "t", abortSignal: undefined, now: () => new Date() } as never,
    )) as unknown as { data: Extract<ClaimMonitorToolResult, { action: "claim_create" }> };

    assert.equal(result.data.action, "claim_create");
    assert.equal(result.data.claim.claimId, "c-new");
    assert.equal(result.data.claim.falsificationCondition, "The null result holds");

    // A fresh graph instance must see the registered claim on disk.
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    const claims = await graph.listClaims();
    assert.equal(claims.some((claim) => claim.claimId === "c-new"), true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("claim_monitor: claim_supersede ends the claim and its descendants", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({ claimId: "c-root", statement: "Root claim about retrieval" });
    await graph.upsertClaim({ claimId: "c-child", statement: "Derived claim", parentClaimIds: ["c-root"] });
    await graph.upsertClaim({ claimId: "c-replacement", statement: "The revised hypothesis" });

    const tool = createClaimMonitorTool();
    const result = (await tool.execute(
      { action: "claim_supersede", claimId: "c-root", supersededByClaimId: "c-replacement", reason: "Evidence contradicted the root" },
      { cwd: projectRoot, sessionId: "s", turnId: "t", abortSignal: undefined, now: () => new Date() } as never,
    )) as unknown as { data: Extract<ClaimMonitorToolResult, { action: "claim_supersede" }> };

    assert.equal(result.data.action, "claim_supersede");
    assert.deepEqual([...result.data.affected].sort(), ["c-child", "c-root"]);
    assert.equal(result.data.supersededByClaimId, "c-replacement");

    // A fresh graph instance (the tool writes through its own instance) —
    // reading the persisted state proves the write, not an in-memory cache.
    const reloaded = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    const snapshot = await reloaded.recomputeBeliefs();
    const statuses = new Map(snapshot.beliefs.map((b) => [b.claimId, b.status]));
    assert.equal(statuses.get("c-root"), "superseded");
    assert.equal(statuses.get("c-child"), "superseded");
    assert.equal(statuses.get("c-replacement"), "active");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("claim_monitor: claim_supersede rejects self-supersession with a tool error", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({ claimId: "c-x", statement: "A claim" });
    const tool = createClaimMonitorTool();
    await assert.rejects(
      tool.execute(
        { action: "claim_supersede", claimId: "c-x", supersededByClaimId: "c-x" },
        { cwd: projectRoot, sessionId: "s", turnId: "t", abortSignal: undefined, now: () => new Date() } as never,
      ),
      /with itself/,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
