import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ClaimGraph } from "../../../src/research/claims/ClaimGraph.js";
import {
  buildResearchAuditReport,
  renderResearchAuditMarkdown,
  verifyResearchAudit,
} from "../../../src/research/audit/replay.js";

function createTempProject(): string {
  return mkdtempSync(join(tmpdir(), "rigorium-audit-"));
}

const AUDIT_BASE = Date.now() - 60_000;
const T0 = new Date(AUDIT_BASE).toISOString();
const T1 = new Date(AUDIT_BASE + 1_000).toISOString();
const T2 = new Date(AUDIT_BASE + 2_000).toISOString();

function nowAt(iso: string): () => Date {
  return () => new Date(iso);
}

async function seedClaim(projectRoot: string, claimId: string, statement: string): Promise<void> {
  const graph = new ClaimGraph({ projectRoot, loadArtifacts: async () => [] });
  await graph.upsertClaim({ claimId, statement });
}

async function appendArtifacts(projectRoot: string, entries: Array<{
  kind: "manuscript_version" | "finding" | "run_attempt";
  artifactId: string;
  timestamp: string;
  payload: Record<string, unknown>;
  parents?: Array<{ relation: string; artifact: { artifactId: string; kind: string; revision: number } }>;
}>): Promise<void> {
  const { createResearchArtifact, toResearchArtifactRef } = await import("../../../src/research/artifacts/index.js");
  const { appendProjectResearchArtifacts } = await import("../../../src/research/artifacts/repository.js");
  // Build final envelopes in entry order (entries are topologically sorted),
  // resolving parent refs against already-final envelopes so kind and
  // contentHash match what the repository stores.
  const final = new Map<string, ReturnType<typeof createResearchArtifact>>();
  for (const entry of entries) {
    const envelope = createResearchArtifact({
      kind: entry.kind,
      artifactId: entry.artifactId,
      producer: { kind: "agent" },
      now: nowAt(entry.timestamp)(),
      payload: entry.payload,
      parents: entry.parents?.map((parent) => ({
        relation: parent.relation as "derived_from" | "uses" | "supports" | "challenges" | "supersedes",
        artifact: toResearchArtifactRef(final.get(parent.artifact.artifactId)!),
      })),
    });
    final.set(entry.artifactId, envelope);
  }
  await appendProjectResearchArtifacts({ projectRoot, artifacts: [...final.values()] });
}

function writePlanHistory(projectRoot: string, records: Array<Record<string, unknown>>): void {
  const dir = join(projectRoot, ".rigorium", "research", "claims");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "planHistory.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

test("audit: empty project yields a clean-but-early report", async () => {
  const projectRoot = createTempProject();
  try {
    const report = await buildResearchAuditReport({ projectRoot, now: nowAt(T2) });
    assert.equal(report.claims.length, 0);
    assert.equal(report.plans.length, 0);
    assert.equal(report.artifacts.length, 0);
    assert.equal(report.openFindings.length, 0);
    assert.equal(report.runs, undefined);
    assert.ok(report.issues.some((issue) => issue.code === "no_claims"));
    assert.equal(verifyResearchAudit(report), true, "no claims is a warning, not fatal");
    const md = renderResearchAuditMarkdown(report);
    assert.match(md, /# Research Audit Report/);
    assert.match(md, /No planning rounds recorded yet/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("audit: replays claims, decision trail, artifacts and closure ledger", async () => {
  const projectRoot = createTempProject();
  try {
    await seedClaim(projectRoot, "c1", "Hypothesis A improves B");
    writePlanHistory(projectRoot, [
      { computedAt: T0, shouldStop: false, topScore: 0.42, actionCount: 2, actionTypes: ["run_experiment", "literature_search"] },
      { computedAt: T1, shouldStop: true, stopReason: "uncertainty saturated", topScore: 0.001, actionCount: 0, actionTypes: [] },
    ]);
    await appendArtifacts(projectRoot, [
      {
        kind: "manuscript_version",
        artifactId: "m1",
        timestamp: T0,
        payload: {
          kind: "manuscript_version", title: "T", target: { venue: "generic", mode: "internal_draft" },
          sections: [], citationSet: null, figureTables: [], evidencePacks: [], latex: "", revisionNote: "",
          complianceChecks: [], renderRef: null,
        },
      },
      {
        kind: "finding",
        artifactId: "review-f-1",
        timestamp: T1,
        payload: {
          kind: "finding", reviewRoundId: "r1", findingId: "f-1", dedupeKey: "d1", source: "reviewer",
          lanes: ["method"], reviewerIds: ["rv1"], assessment: "concern", category: "method",
          severity: "blocker", confidence: "high", summary: "Missing baseline comparison", rationale: "r",
          location: { sectionId: "method", anchorText: "baseline" },
          actions: [{ kind: "add_evidence", instruction: "Add baseline.", targetArtifactRefs: [] }],
          evidenceRefs: [], runRefs: [], affectedArtifactRefs: [], mergedFromFindingIds: [],
        },
        parents: [{ relation: "derived_from", artifact: { artifactId: "m1", kind: "manuscript_version", revision: 1 } }],
      },
      {
        kind: "run_attempt",
        artifactId: "run-1",
        timestamp: T2,
        payload: {
          kind: "run_attempt", attemptId: "run-1", experimentId: "e1", specRevision: 1, specDigest: "d",
          adapterId: "local", jobId: "j1", status: "succeeded", grantMode: "granted",
          preparedAt: T2, artifactIds: [], metricObservationIds: [],
          runFacts: { gitCommit: "abc123", envFingerprint: "fp1" },
        },
        parents: [
          { relation: "derived_from", artifact: { artifactId: "m1", kind: "manuscript_version", revision: 1 } },
          { relation: "uses", artifact: { artifactId: "review-f-1", kind: "finding", revision: 1 } },
        ],
      },
    ]);

    const report = await buildResearchAuditReport({ projectRoot, now: nowAt(T2) });
    assert.equal(report.claims.length, 1);
    assert.equal(report.claims[0]!.claimId, "c1");
    assert.equal(report.plans.length, 2);
    assert.ok(report.plans[1]!.shouldStop);
    assert.equal(report.artifacts.length, 3);
    assert.equal(report.artifactKindCounts["run_attempt"], 1);
    assert.deepEqual(report.runs, {
      totalRuns: 1,
      failedRuns: 0,
      failureRate: 0,
      withReproMetadata: 1,
      missingReproMetadata: 0,
    });
    // The run references the finding → closure ledger empty.
    assert.equal(report.openFindings.length, 0);
    assert.ok(!report.issues.some((issue) => issue.code === "open_finding"));
    assert.ok(!report.issues.some((issue) => issue.code === "never_stopped"));
    assert.equal(verifyResearchAudit(report), true);

    const md = renderResearchAuditMarkdown(report);
    assert.match(md, /## Claims \(belief state\)/);
    assert.match(md, /## Orchestration decision trail/);
    assert.match(md, /## Run reproducibility/);
    assert.match(md, /With gitCommit\+envFingerprint: 1\/1/);
    assert.match(md, /All blocker\/major findings are referenced by later work/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("audit: unreferenced blocker surfaces as open finding + run repro gap", async () => {
  const projectRoot = createTempProject();
  try {
    await seedClaim(projectRoot, "c1", "Hypothesis A improves B");
    await appendArtifacts(projectRoot, [
      {
        kind: "manuscript_version",
        artifactId: "m1",
        timestamp: T0,
        payload: {
          kind: "manuscript_version", title: "T", target: { venue: "generic", mode: "internal_draft" },
          sections: [], citationSet: null, figureTables: [], evidencePacks: [], latex: "", revisionNote: "",
          complianceChecks: [], renderRef: null,
        },
      },
      {
        kind: "finding",
        artifactId: "review-f-2",
        timestamp: T1,
        payload: {
          kind: "finding", reviewRoundId: "r1", findingId: "f-2", dedupeKey: "d2", source: "reviewer",
          lanes: ["evidence"], reviewerIds: ["rv2"], assessment: "concern", category: "evidence",
          severity: "major", confidence: "high", summary: "Missing supporting run", rationale: "r",
          location: { sectionId: "results", anchorText: "run" },
          actions: [{ kind: "rerun_experiment", instruction: "Run it.", targetArtifactRefs: [] }],
          evidenceRefs: [], runRefs: [], affectedArtifactRefs: [], mergedFromFindingIds: [],
        },
        parents: [{ relation: "derived_from", artifact: { artifactId: "m1", kind: "manuscript_version", revision: 1 } }],
      },
      {
        kind: "run_attempt",
        artifactId: "run-1",
        timestamp: T2,
        payload: {
          kind: "run_attempt", attemptId: "run-1", experimentId: "e1", specRevision: 1, specDigest: "d",
          adapterId: "local", jobId: "j1", status: "succeeded", grantMode: "granted",
          preparedAt: T2, artifactIds: [], metricObservationIds: [],
        },
      },
    ]);

    const report = await buildResearchAuditReport({ projectRoot, now: nowAt(T2) });
    assert.equal(report.openFindings.length, 1);
    assert.equal(report.openFindings[0]!.findingId, "review-f-2");
    assert.ok(report.issues.some((issue) => issue.code === "open_finding"));
    assert.deepEqual(report.runs?.missingReproMetadata, 1);
    assert.ok(report.issues.some((issue) => issue.code === "run_reproducibility_gap"));
    assert.equal(verifyResearchAudit(report), true, "warnings do not fail verification");

    const md = renderResearchAuditMarkdown(report);
    assert.match(md, /\*\*\[major\]\*\* `review-f-2`/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("audit: corrupt decision trail is a fatal integrity issue", async () => {
  const projectRoot = createTempProject();
  try {
    await seedClaim(projectRoot, "c1", "Hypothesis A improves B");
    writePlanHistory(projectRoot, [
      { computedAt: T0, shouldStop: false, topScore: 0.42, actionCount: 2, actionTypes: ["run_experiment"] },
    ]);
    const dir = join(projectRoot, ".rigorium", "research", "claims");
    writeFileSync(join(dir, "planHistory.jsonl"), "{not-json}\n", "utf8");

    const report = await buildResearchAuditReport({ projectRoot, now: nowAt(T2) });
    assert.ok(report.issues.some((issue) => issue.code === "plan_history_corrupt" && issue.severity === "fatal"));
    assert.equal(verifyResearchAudit(report), false, "a corrupt decision trail must fail verification");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
