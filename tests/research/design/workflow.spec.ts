import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDirectionCompatibility,
  createResearchDesignPackage,
  reviseResearchBriefArtifact,
  validateComparisonAgainstPortfolio,
  validateResearchDesignArtifact,
} from "../../../src/research/design/index.js";
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
    validateComparisonAgainstPortfolio({ portfolio: result.portfolio, decision: result.decisionRecord });
  }
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
