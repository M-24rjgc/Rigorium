import type {
  ResearchDesignToolInput,
} from "../../../src/tool/builtin/researchDesign.js";

export function researchDesignInput(entry: "discover" | "complete" = "discover"): ResearchDesignToolInput {
  const citations = [
    {
      id: "evidence-prior",
      sourceId: "openalex",
      recordId: "W1",
      locator: "https://openalex.org/W1",
      claim: "Existing methods use a static aggregation mechanism.",
      role: "prior_art" as const,
      strength: "direct" as const,
    },
    {
      id: "evidence-gap",
      sourceId: "paperqa",
      recordId: "paper-2",
      locator: "paper-2.pdf#page=4",
      claim: "Current evaluation omits distribution-shift calibration.",
      role: "gap" as const,
      strength: "direct" as const,
    },
  ];
  return {
    entry,
    idea: {
      id: "idea-main",
      statement: "Improve robust aggregation under distribution shift.",
      question: "Which mechanism improves calibration without excessive compute?",
      source: entry === "complete" ? "user" : "conversation",
    },
    citations,
    evidenceRequest: {
      id: "evidence-request-main",
      purpose: "gap",
      queries: ["robust aggregation distribution shift calibration"],
      requestedClaims: ["mechanism overlap", "calibration baselines"],
      sourceIds: ["openalex", "paperqa"],
      maxEntries: 8,
      status: "partial",
    },
    constraints: [
      { id: "compute-budget", kind: "compute", statement: "One GPU-day maximum.", status: "satisfied", required: true, evidenceIds: [] },
      { id: "ethics-review", kind: "ethics", statement: "No sensitive personal data.", status: "satisfied", required: true, evidenceIds: [] },
    ],
    candidates: [
      candidate({
        id: "adaptive-gate",
        mechanismId: "mechanism-gate",
        family: "adaptive-gating",
        differentiator: "Learns a sample-conditioned gate instead of changing the objective.",
        distinctFrom: ["robust-objective"],
        innovationKind: "algorithm",
        evidenceIds: ["evidence-prior", "evidence-gap"],
      }),
      candidate({
        id: "robust-objective",
        mechanismId: "mechanism-objective",
        family: "distributionally-robust-objective",
        differentiator: "Changes the training objective while leaving aggregation static.",
        distinctFrom: ["adaptive-gate"],
        innovationKind: "theory",
        evidenceIds: ["evidence-prior", "evidence-gap"],
      }),
    ],
    independentCriticisms: [
      {
        id: "criticism-confounding",
        candidateId: "adaptive-gate",
        reviewerId: "critic-agent",
        category: "evaluation",
        severity: "medium",
        status: "resolved",
        statement: "The gain may come from parameter count rather than gating.",
        resolution: "Add a parameter-matched baseline and an ablation.",
        evidenceIds: ["evidence-gap"],
      },
    ],
    similarWorkRescans: [
      {
        id: "similarity-rescan",
        candidateId: "adaptive-gate",
        query: "sample conditioned robust aggregation gate",
        comparedWork: "Prior static aggregation method",
        mechanismComparison: "The prior method has no sample-conditioned gate.",
        outcome: "distinct",
        evidenceIds: ["evidence-prior"],
      },
    ],
    evidenceRescans: [
      {
        id: "evidence-rescan",
        candidateId: "adaptive-gate",
        query: "distribution shift calibration evaluation",
        sourceIds: ["openalex", "paperqa"],
        claimChecked: "Calibration is omitted by the closest evaluation.",
        outcome: "supports",
        evidenceIds: ["evidence-gap"],
      },
    ],
    objectives: [
      { id: "novelty", label: "Mechanism novelty", weight: 2, direction: "maximize", description: "Evidence-backed mechanism difference." },
      { id: "compute", label: "Compute cost", weight: 1, direction: "minimize", description: "Estimated GPU hours." },
      { id: "falsifiability", label: "Falsifiability", weight: 1, direction: "maximize", description: "Strength of observable disconfirmation." },
    ],
    assessments: [
      score("adaptive-gate", "novelty", 8, ["evidence-prior"]),
      score("adaptive-gate", "compute", 12, []),
      score("adaptive-gate", "falsifiability", 9, ["evidence-gap"]),
      score("robust-objective", "novelty", 7, ["evidence-prior"]),
      score("robust-objective", "compute", 18, []),
      score("robust-objective", "falsifiability", 7, ["evidence-gap"]),
    ],
    eliminations: [
      {
        id: "retain-gate",
        candidateId: "adaptive-gate",
        outcome: "retained",
        reasonCodes: [],
        rationale: "Best weighted score and on the Pareto frontier.",
        evidenceIds: ["evidence-gap"],
        reversible: true,
      },
      {
        id: "eliminate-objective",
        candidateId: "robust-objective",
        outcome: "eliminated",
        reasonCodes: ["dominated"],
        rationale: "Lower novelty and falsifiability with higher compute cost.",
        evidenceIds: ["evidence-prior"],
        reversible: true,
      },
    ],
    decision: {
      choice: "adaptive-gate",
      status: "selected",
      rationale: "The adaptive gate is testable within the declared compute budget.",
      eliminations: [],
      alternativesConsidered: ["adaptive-gate", "robust-objective"],
      unresolvedRisks: [],
      explicitUserConfirmation: false,
    },
    brief: {
      title: { text: "Adaptive Gating for Robust Aggregation", status: "provisional" },
    },
  };
}

function candidate(input: {
  id: string;
  mechanismId: string;
  family: string;
  differentiator: string;
  distinctFrom: string[];
  innovationKind: "theory" | "algorithm";
  evidenceIds: string[];
}): ResearchDesignToolInput["candidates"][number] {
  const innovationId = `${input.id}-innovation`;
  const falsificationId = `${input.id}-falsification`;
  const failureId = `${input.id}-failure`;
  return {
    id: input.id,
    summary: `Evaluate ${input.family} for robust aggregation.`,
    mechanism: {
      id: input.mechanismId,
      family: input.family,
      description: `Use ${input.family} to improve calibration under shift.`,
      differentiator: input.differentiator,
      signature: input.family,
      distinctFrom: input.distinctFrom,
    },
    innovations: [{
      id: innovationId,
      kind: input.innovationKind,
      claim: `A ${input.family} mechanism improves shifted calibration.`,
      testablePrediction: "Expected calibration error decreases on held-out shifts.",
      evidenceIds: input.evidenceIds,
    }],
    hypotheses: [{
      id: `${input.id}-hypothesis`,
      statement: "The mechanism reduces calibration error without reducing accuracy.",
      innovationIds: [innovationId],
      falsificationIds: [falsificationId],
      failureCriterionIds: [failureId],
    }],
    falsificationConditions: [{
      id: falsificationId,
      statement: "Calibration error does not improve on any held-out shift.",
      observable: "Expected calibration error",
      threshold: "No improvement over the strongest baseline at 95% confidence.",
      severity: "high",
    }],
    failureCriteria: [{
      id: failureId,
      statement: "The method misses the primary success rule.",
      stopRule: "Stop after three seeded reruns all miss the threshold.",
      severity: "high",
    }],
    baselines: [{
      id: `${input.id}-baseline`,
      label: "Static aggregation baseline",
      rationale: "Separates the proposed mechanism from extra capacity.",
      sourceEvidenceIds: ["evidence-prior"],
      rerunRequired: true,
    }],
    evaluation: {
      protocol: "Three seeds on in-domain and held-out shifts.",
      primaryMetric: "Expected calibration error",
      metrics: ["expected calibration error", "accuracy"],
      splits: ["in-domain", "held-out shift"],
      successRule: "Lower error by at least 5% without more than 1% accuracy loss.",
      ablations: ["remove mechanism", "parameter-matched control"],
    },
    compute: {
      budget: "One GPU-day",
      hardware: "One 24 GB GPU",
      timeLimit: "24 hours",
      reproducibilityNotes: "Record seeds, environment, and per-run metrics.",
    },
    ethics: {
      risks: ["Performance may differ across demographic subgroups."],
      mitigations: ["Report subgroup calibration and stop on harmful disparity."],
      exclusions: ["No deployment claims."],
      approvalRequired: false,
    },
    evidenceIds: input.evidenceIds,
  };
}

function score(candidateId: string, objectiveId: string, value: number, evidenceIds: string[]) {
  return {
    candidateId,
    objectiveId,
    score: value,
    rationale: `Recorded score ${value} for ${objectiveId}.`,
    evidenceIds,
  };
}
