import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResearchArtifactGraph,
  toResearchArtifactRef,
} from "../../../src/research/artifacts/index.js";
import {
  buildDirectionCompatibility,
  createResearchDesignPackage,
  reviseResearchBriefArtifact,
  validateComparisonAgainstPortfolio,
  validateResearchDesignArtifact,
  type ResearchDesignPackageInput,
} from "../../../src/research/design/index.js";
import { createEvidencePackArtifact } from "../../../src/research/literature/evidencePack.js";
import { researchDesignInput } from "./fixtures.js";

test("both natural-language entries produce a complete artifact-linked design package", () => {
  for (const entry of ["discover", "complete"] as const) {
    const input = researchDesignInput(entry);
    const result = createResearchDesignPackage({
      portfolio: {
        entry: input.entry,
        idea: input.idea,
        candidates: input.candidates,
        constraints: input.constraints,
        evidenceRequest: input.evidenceRequest,
        citations: input.citations,
      },
      challenge: {
        independentCriticisms: input.independentCriticisms,
        similarWorkRescans: input.similarWorkRescans,
        evidenceRescans: input.evidenceRescans,
      },
      comparison: { objectives: input.objectives, assessments: input.assessments },
      decision: { ...input.decision, eliminations: input.eliminations },
      brief: input.brief,
      now: new Date("2026-07-25T00:00:00.000Z"),
    });

    assert.equal(result.entry, entry);
    assert.deepEqual(result.comparison.rankedCandidateIds, ["adaptive-gate", "robust-objective"]);
    assert.deepEqual(result.comparison.paretoFrontierCandidateIds, ["adaptive-gate"]);
    assert.equal(result.decisionRecord.payload.choice, "adaptive-gate");
    assert.equal(result.researchBrief.payload.status, "ready");
    assert.equal(result.researchBrief.payload.title.status, "provisional");
    assert.equal(result.artifacts.every((artifact) => validateResearchDesignArtifact(artifact).ok), true);
    assert.deepEqual(result.sourceArtifacts, []);
    validateComparisonAgainstPortfolio({ portfolio: result.portfolio, decision: result.decisionRecord });
  }
});

test("complete external EvidencePack closures support CandidatePortfolio and ResearchBrief parents", () => {
  const { root, evidence } = externalEvidenceClosure();
  const request = designPackageInput();
  const externalParent = { relation: "uses" as const, artifact: toResearchArtifactRef(evidence) };
  const result = createResearchDesignPackage({
    ...request,
    portfolio: { ...request.portfolio, parents: [externalParent] },
    brief: { ...(request.brief ?? {}), parents: [externalParent] },
    sourceArtifacts: [root, evidence],
  });

  const graph = buildResearchArtifactGraph(result.artifacts);
  assert.equal(graph.missingParents.length, 0);
  assert.equal(result.artifacts.length, 6);
  assert.equal(result.sourceArtifacts.length, 2);
  assert.equal(result.portfolio.parents.some((parent) => parent.artifact.contentHash === evidence.contentHash), true);
  assert.equal(result.researchBrief.parents.some((parent) => parent.artifact.contentHash === evidence.contentHash), true);

  const normalizedEvidence = result.sourceArtifacts.find((artifact) => artifact.artifactId === evidence.artifactId)!;
  const sourceContent = evidence.payload.entries[0]!.snapshot.content;
  const mutableSnapshot = evidence.payload.entries[0]!.snapshot as { content: string };
  mutableSnapshot.content = "Mutated after the package was materialized.";
  assert.equal((normalizedEvidence.payload as typeof evidence.payload).entries[0]!.snapshot.content, sourceContent);
  assert.equal(Object.isFrozen(normalizedEvidence), true);
  assert.equal(Object.isFrozen(normalizedEvidence.payload), true);
  assert.equal(Object.isFrozen((normalizedEvidence.payload as typeof evidence.payload).entries[0]!.snapshot), true);
});

test("external source closures reject missing, tampered, conflicting, and unreferenced envelopes", () => {
  const { root, evidence } = externalEvidenceClosure();
  const request = designPackageInput();
  const externalParent = { relation: "uses" as const, artifact: toResearchArtifactRef(evidence) };
  const createWithSources = (sourceArtifacts: readonly unknown[]) => createResearchDesignPackage({
    ...request,
    portfolio: { ...request.portfolio, parents: [externalParent] },
    sourceArtifacts: sourceArtifacts as ResearchDesignPackageInput["sourceArtifacts"],
  });

  assert.throws(
    () => createWithSources([evidence]),
    /complete, valid Artifact DAG closure/iu,
  );
  assert.throws(
    () => createWithSources([root, { ...evidence, contentHash: `sha256:${"0".repeat(64)}` }]),
    /contentHash does not match/iu,
  );

  const conflicting = createEvidencePackArtifact({
    artifactId: evidence.artifactId,
    entries: [evidenceEntry("conflicting-evidence", "Different immutable evidence content.")],
    producer: { kind: "import", id: "design-test" },
    parents: [{ relation: "derived_from", artifact: toResearchArtifactRef(root) }],
    now: new Date("2026-07-25T00:02:00.000Z"),
  });
  assert.throws(
    () => createWithSources([root, evidence, conflicting]),
    /conflicting envelopes/iu,
  );

  const unrelated = createEvidencePackArtifact({
    artifactId: "design-unrelated-evidence",
    entries: [evidenceEntry("unrelated-evidence", "Unrelated evidence branch.")],
    producer: { kind: "import", id: "design-test" },
    now: new Date("2026-07-25T00:03:00.000Z"),
  });
  assert.throws(
    () => createWithSources([root, evidence, unrelated]),
    /is not an ancestor/iu,
  );
});

test("mechanism variants cannot masquerade as divergent candidates", () => {
  const input = researchDesignInput();
  const duplicate = {
    ...input.candidates[1]!,
    mechanism: {
      ...input.candidates[1]!.mechanism,
      signature: input.candidates[0]!.mechanism.signature,
    },
  };
  assert.throws(() => createResearchDesignPackage({
    portfolio: {
      entry: input.entry,
      idea: input.idea,
      candidates: [input.candidates[0]!, duplicate],
      citations: input.citations,
      evidenceRequest: input.evidenceRequest,
    },
    challenge: {
      independentCriticisms: input.independentCriticisms,
      similarWorkRescans: input.similarWorkRescans,
      evidenceRescans: input.evidenceRescans,
    },
    comparison: { objectives: input.objectives, assessments: input.assessments },
    decision: { ...input.decision, eliminations: input.eliminations },
  }), /mechanically distinct/iu);
});

test("open contradictions block an unconfirmed selection", () => {
  const input = researchDesignInput();
  assert.throws(() => createResearchDesignPackage({
    portfolio: {
      entry: input.entry,
      idea: input.idea,
      candidates: input.candidates,
      citations: input.citations,
      evidenceRequest: input.evidenceRequest,
    },
    challenge: {
      independentCriticisms: input.independentCriticisms,
      similarWorkRescans: input.similarWorkRescans,
      evidenceRescans: input.evidenceRescans,
      contradictions: [{
        id: "open-contradiction",
        candidateId: "adaptive-gate",
        claim: "The gate improves calibration.",
        counterClaim: "The effect disappears under parameter matching.",
        evidenceIds: ["evidence-gap"],
        status: "open",
      }],
    },
    comparison: { objectives: input.objectives, assessments: input.assessments },
    decision: { ...input.decision, eliminations: input.eliminations },
  }), /explicit user confirmation/iu);
});

test("ResearchBrief revisions preserve identity and require explicit final-title confirmation", () => {
  const input = researchDesignInput();
  const result = createResearchDesignPackage({
    portfolio: { entry: input.entry, idea: input.idea, candidates: input.candidates, citations: input.citations, evidenceRequest: input.evidenceRequest },
    challenge: { independentCriticisms: input.independentCriticisms, similarWorkRescans: input.similarWorkRescans, evidenceRescans: input.evidenceRescans },
    comparison: { objectives: input.objectives, assessments: input.assessments },
    decision: { ...input.decision, eliminations: input.eliminations },
    brief: input.brief,
    now: new Date("2026-07-25T00:00:00.000Z"),
  });
  assert.throws(() => reviseResearchBriefArtifact({
    previous: result.researchBrief,
    portfolio: result.portfolio,
    title: { text: "Final Research Title", status: "confirmed" },
  }), /explicitConfirmation/iu);

  const revised = reviseResearchBriefArtifact({
    previous: result.researchBrief,
    portfolio: result.portfolio,
    challengeReport: result.challengeReport,
    decisionRecord: result.decisionRecord,
    title: {
      text: "Final Research Title",
      status: "confirmed",
      explicitConfirmation: true,
      confirmedBy: "user",
      confirmedAt: "2026-07-25T01:00:00.000Z",
    },
    now: new Date("2026-07-25T01:00:00.000Z"),
  });
  assert.equal(revised.artifactId, result.researchBrief.artifactId);
  assert.equal(revised.revision, 2);
  assert.equal(revised.payload.title.status, "confirmed");
  assert.equal(revised.parents.some((parent) => parent.relation === "supersedes"), true);
});

test("legacy direction lifecycle remains a display-only dynamic compatibility view", () => {
  const compatibility = buildDirectionCompatibility({ sourceArtifactIds: ["legacy-seed-1"] });
  assert.equal(compatibility.agentLoopControl, "none");
  assert.equal("nextStageId" in compatibility, false);
  assert.equal(compatibility.dynamicChecks.evidence, "needs_evidence");
});

function designPackageInput(): ResearchDesignPackageInput {
  const input = researchDesignInput();
  return {
    portfolio: {
      entry: input.entry,
      idea: input.idea,
      candidates: input.candidates,
      constraints: input.constraints,
      evidenceRequest: input.evidenceRequest,
      citations: input.citations,
    },
    challenge: {
      independentCriticisms: input.independentCriticisms,
      similarWorkRescans: input.similarWorkRescans,
      evidenceRescans: input.evidenceRescans,
    },
    comparison: { objectives: input.objectives, assessments: input.assessments },
    decision: { ...input.decision, eliminations: input.eliminations },
    brief: input.brief,
    now: new Date("2026-07-25T00:10:00.000Z"),
  };
}

function externalEvidenceClosure() {
  const root = createEvidencePackArtifact({
    artifactId: "design-evidence-root",
    entries: [evidenceEntry("root-evidence", "Evidence root snapshot.")],
    producer: { kind: "import", id: "design-test" },
    now: new Date("2026-07-25T00:00:00.000Z"),
  });
  const evidence = createEvidencePackArtifact({
    artifactId: "design-evidence",
    entries: [evidenceEntry("external-evidence", "Evidence child snapshot.")],
    producer: { kind: "import", id: "design-test" },
    parents: [{ relation: "derived_from", artifact: toResearchArtifactRef(root) }],
    now: new Date("2026-07-25T00:01:00.000Z"),
  });
  return { root, evidence };
}

function evidenceEntry(id: string, content: string) {
  return {
    id,
    paperId: `${id}-paper`,
    locator: { sourceId: "synthetic", recordId: id, page: 1 },
    snapshot: { content },
  };
}
