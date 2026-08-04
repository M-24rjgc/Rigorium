import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaimGraph } from "../../src/research/claims/ClaimGraph.js";
import {
  EVIDENCE_STRENGTH_WEIGHTS,
  aggregateContributions,
  computeBelief,
  strengthFromArtifactKind,
} from "../../src/research/claims/beliefPropagation.js";
import type { Claim, EvidenceContribution } from "../../src/research/claims/types.js";

function makeClaim(claimId: string, statement: string): Claim {
  return Object.freeze({
    claimId,
    statement,
    createdAt: "2026-08-03T00:00:00.000Z",
  });
}

function contribution(
  sourceArtifactId: string,
  sourceKind: string,
  relation: "supports" | "challenges",
  strength: EvidenceContribution["strength"],
): EvidenceContribution {
  return Object.freeze({
    sourceArtifactId,
    sourceKind,
    relation,
    strength,
    sourceRevision: 1,
    observedAt: "2026-08-03T00:00:00.000Z",
  });
}

// ---------------------------------------------------------------------------
// beliefPropagation
// ---------------------------------------------------------------------------

test("computeBelief: fresh claim starts at maximal ignorance", () => {
  const belief = computeBelief(makeClaim("c1", "X improves Y"), []);
  assert.equal(belief.confidence, 0.5);
  assert.equal(belief.uncertainty, 1);
  assert.equal(belief.status, "active");
  assert.equal(belief.evidenceCount, 0);
});

test("computeBelief: replicated support raises confidence and lowers uncertainty", () => {
  const belief = computeBelief(
    makeClaim("c1", "X improves Y"),
    [contribution("run-1", "run_attempt", "supports", "replicated_result")],
  );
  assert.ok(belief.confidence > 0.5, `confidence=${belief.confidence}`);
  assert.ok(belief.uncertainty < 1);
  assert.equal(belief.status, "active");
  assert.equal(belief.supportsWeight, EVIDENCE_STRENGTH_WEIGHTS.replicated_result);
});

test("computeBelief: strong challenges flip status to challenged", () => {
  const belief = computeBelief(
    makeClaim("c1", "X improves Y"),
    [
      contribution("r1", "run_attempt", "challenges", "replicated_result"),
      contribution("pack-1", "evidence_pack", "challenges", "citation"),
    ],
  );
  assert.equal(belief.status, "challenged");
  assert.ok(belief.confidence <= 0.5);
  assert.equal(
    belief.challengesWeight,
    EVIDENCE_STRENGTH_WEIGHTS.replicated_result + EVIDENCE_STRENGTH_WEIGHTS.citation,
  );
});

test("computeBelief: overwhelming challenges falsify a weak claim", () => {
  const belief = computeBelief(
    makeClaim("c1", "X improves Y"),
    [
      contribution("r1", "run_attempt", "challenges", "replicated_result"),
      contribution("r2", "run_attempt", "challenges", "replicated_result"),
      contribution("r3", "finding", "challenges", "review_consensus"),
    ],
  );
  assert.equal(belief.status, "falsified");
  assert.ok(belief.confidence < 0.25);
});

test("aggregateContributions: harvests supports/challenges edges pointing at claims", () => {
  const artifacts = [
    {
      artifactId: "run-1",
      revision: 1,
      kind: "run_attempt",
      parents: [{ relation: "supports", artifact: { artifactId: "c1", kind: "claim" } }],
    },
    {
      artifactId: "finding-1",
      revision: 1,
      kind: "finding",
      parents: [{ relation: "challenges", artifact: { artifactId: "c1", kind: "claim" } }],
    },
    {
      artifactId: "unrelated",
      revision: 1,
      kind: "evidence_pack",
      parents: [{ relation: "derived_from", artifact: { artifactId: "brief-1", kind: "research_brief" } }],
    },
  ];
  const contributions = aggregateContributions(artifacts, new Set(["c1"]), "2026-08-03T00:00:00.000Z");
  const c1 = contributions.get("c1");
  assert.equal(c1?.length, 2);
  assert.deepEqual(
    c1?.map((c) => c.relation).sort(),
    ["challenges", "supports"],
  );
  assert.equal(c1?.[0]?.strength, "observed_result");
  assert.equal(c1?.[1]?.strength, "review_consensus");
  assert.equal(contributions.has("unrelated"), false);
});

test("strengthFromArtifactKind maps artifact kinds to epistemic strengths", () => {
  assert.equal(strengthFromArtifactKind("run_attempt"), "observed_result");
  assert.equal(strengthFromArtifactKind("baseline_observation"), "baseline_observation");
  assert.equal(strengthFromArtifactKind("finding"), "review_consensus");
  assert.equal(strengthFromArtifactKind("evidence_pack"), "citation");
});

// ---------------------------------------------------------------------------
// ClaimGraph
// ---------------------------------------------------------------------------

function createTempProject(): string {
  return mkdtempSync(join(tmpdir(), "rigorium-claims-"));
}

test("ClaimGraph: upsert, persist, reload round-trip", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({
      claimId: "c1",
      statement: "Method A beats baseline B on C",
      falsificationCondition: "A does not outperform B on C at p<0.05",
    });
    await graph.upsertClaim({
      claimId: "c2",
      statement: "C matters for A",
      parentClaimIds: ["c1"],
    });

    // Reload from disk — must see both claims.
    const reloaded = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    const claims = await reloaded.listClaims();
    assert.equal(claims.length, 2);
    assert.equal(claims[0]!.claimId, "c1");
    assert.equal(claims[1]!.parentClaimIds?.[0], "c1");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ClaimGraph: recomputeBeliefs harvests evidence from artifact DAG", async () => {
  const projectRoot = createTempProject();
  try {
    const artifacts = [
      {
        artifactId: "run-1",
        revision: 1,
        kind: "run_attempt",
        parents: [{ relation: "supports", artifact: { artifactId: "c1", kind: "claim" } }],
      },
      {
        artifactId: "finding-1",
        revision: 1,
        kind: "finding",
        parents: [{ relation: "challenges", artifact: { artifactId: "c1", kind: "claim" } }],
      },
    ];
    const graph = new ClaimGraph({
      projectRoot,
      loadArtifacts: async () => artifacts,
    });
    await graph.upsertClaim({ claimId: "c1", statement: "X beats Y" });

    const snapshot = await graph.recomputeBeliefs();
    assert.equal(snapshot.beliefs.length, 1);
    const belief = snapshot.beliefs[0]!;
    assert.equal(belief.evidenceCount, 2);
    assert.equal(belief.status, "active"); // 0.25 support vs 0.3 challenge → below thresholds
    assert.ok(belief.confidence < 0.5);
    assert.equal(graph.contributionsFor("c1").length, 2);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ClaimGraph: supersedeClaim cascades to descendants", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({ claimId: "c1", statement: "root claim" });
    await graph.upsertClaim({ claimId: "c2", statement: "derived", parentClaimIds: ["c1"] });
    await graph.upsertClaim({ claimId: "c3", statement: "leaf", parentClaimIds: ["c2"] });
    await graph.upsertClaim({ claimId: "other", statement: "independent" });
    // The superseding claim must exist: the revision trail would otherwise
    // dangle at a nonexistent target.
    await graph.upsertClaim({ claimId: "c1-v2", statement: "replacement root" });

    const affected = await graph.supersedeClaim({ claimId: "c1", supersededByClaimId: "c1-v2" });
    assert.deepEqual(affected.sort(), ["c1", "c2", "c3"]);

    const snapshot = await graph.recomputeBeliefs();
    const statuses = new Map(snapshot.beliefs.map((b) => [b.claimId, b.status]));
    assert.equal(statuses.get("c1"), "superseded");
    assert.equal(statuses.get("c2"), "superseded");
    assert.equal(statuses.get("c3"), "superseded");
    assert.equal(statuses.get("other"), "active");
    assert.equal(statuses.get("c1-v2"), "active");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ClaimGraph: supersedeClaim rejects an unknown superseding claim", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({ claimId: "c1", statement: "root claim" });
    await assert.rejects(
      graph.supersedeClaim({ claimId: "c1", supersededByClaimId: "does-not-exist" }),
      /unknown claim "does-not-exist"/,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ClaimGraph: structurally-malformed file refuses overwrite (never wiped)", async () => {
  const projectRoot = createTempProject();
  try {
    // File exists and parses, but the shape is wrong: { claims: "x" }.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const claimsDir = join(projectRoot, ".rigorium", "research", "claims");
    mkdirSync(claimsDir, { recursive: true });
    writeFileSync(join(claimsDir, "claims.json"), JSON.stringify({ schemaVersion: 1, claims: "x" }), "utf8");

    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    assert.equal((await graph.listClaims()).length, 0, "malformed shape reads as empty");
    await assert.rejects(graph.upsertClaim({ claimId: "c1", statement: "must not persist" }), /refusing to overwrite/i);

    // The original file is untouched.
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(join(claimsDir, "claims.json"), "utf8");
    assert.match(raw, /"claims"\s*:\s*"x"/, "original malformed file must remain on disk");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ClaimGraph: mostUncertainClaims ranks active claims by uncertainty", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({ claimId: "c-uncertain", statement: "no evidence yet" });
    await graph.upsertClaim({ claimId: "c-cited", statement: "has one citation" });
    const artifacts = [
      {
        artifactId: "pack-1",
        revision: 1,
        kind: "evidence_pack",
        parents: [{ relation: "supports", artifact: { artifactId: "c-cited", kind: "claim" } }],
      },
    ];
    const withEvidence = new ClaimGraph({ projectRoot, loadArtifacts: async () => artifacts });
    const ranked = await withEvidence.mostUncertainClaims(5);
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0]!.claimId, "c-uncertain", "no-evidence claim ranks first");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ClaimGraph: supersedeClaim rejects a self-referential successor", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({ claimId: "c1", statement: "root claim" });
    await assert.rejects(
      graph.supersedeClaim({ claimId: "c1", supersededByClaimId: "c1" }),
      /with itself/,
    );
    // The claim must remain active — a self-supersede must not pin it.
    const snapshot = await graph.recomputeBeliefs();
    assert.equal(snapshot.beliefs.find((b) => b.claimId === "c1")?.status, "active");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ClaimGraph: supersedeClaim rejects a second supersede (chain must not fork)", async () => {
  const projectRoot = createTempProject();
  try {
    const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
    await graph.upsertClaim({ claimId: "c1", statement: "root claim" });
    await graph.upsertClaim({ claimId: "c1-v2", statement: "replacement" });
    await graph.upsertClaim({ claimId: "c1-v3", statement: "another replacement" });

    await graph.supersedeClaim({ claimId: "c1", supersededByClaimId: "c1-v2" });
    await assert.rejects(
      graph.supersedeClaim({ claimId: "c1", supersededByClaimId: "c1-v3" }),
      /already superseded by "c1-v2"/,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
