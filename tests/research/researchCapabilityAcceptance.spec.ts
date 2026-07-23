import assert from "node:assert/strict";
import test from "node:test";
import {
  assessResearchDirections,
  buildLiteratureSearchCoverageAudit,
  confirmProvisionalTitle,
  runLiteratureSearchSession,
  type DirectionAssessmentInput,
  type LiteratureSearchArtifact,
  type LiteratureSearchSessionPlan,
  type ResearchDirectionSeedInput,
  type ResearchPaper,
  type ResearchSourceStatus,
  type SearchPlan,
} from "../../src/research/index.js";
import { createResearchDirectionSeedTool } from "../../src/tool/builtin/directionSeed.js";

const retrievedAt = "2026-07-23T00:00:00.000Z";
const now = () => new Date(retrievedAt);

const seedInput: ResearchDirectionSeedInput = {
  cues: [
    { id: "interest", kind: "interest", text: "Reliable small-model evaluation" },
    { id: "paper", kind: "paper", text: "Prior work reports calibration failures under distribution shift", sourceReference: "doi:10.1000/prior" },
    { id: "data", kind: "data", text: "A labeled benchmark is available for the target setting" },
    { id: "observation", kind: "experiment_observation", text: "Errors cluster after the deployment distribution changes" },
  ],
  terminology: [
    { id: "calibration", text: "calibration", cueIds: ["paper", "observation"], status: "observed" },
    { id: "shift", text: "distribution shift", cueIds: ["observation"], status: "observed" },
  ],
  constraints: [
    { id: "data-available", kind: "data", label: "Labeled benchmark access", status: "satisfied", cueIds: ["data"] },
    { id: "compute-budget", kind: "compute", label: "Single-device compute budget", status: "satisfied", cueIds: ["interest"] },
  ],
  candidates: [
    {
      id: "calibration-under-shift",
      summary: "Evaluate calibration interventions for small models under distribution shift.",
      cueIds: ["interest", "paper", "observation"],
      terminologyIds: ["calibration", "shift"],
      constraintIds: ["data-available", "compute-budget"],
      hypotheses: [
        {
          id: "calibration-effect",
          statement: "Calibration intervention quality changes under distribution shift.",
          cueIds: ["paper", "observation"],
          terminologyIds: ["calibration", "shift"],
        },
      ],
      contributions: [
        {
          id: "comparison-protocol",
          statement: "A bounded comparison protocol for calibration under shift.",
          cueIds: ["interest", "observation"],
          constraintIds: ["data-available"],
        },
      ],
      titleSeed: "The first breakthrough that always solves calibration",
      neutralTitle: "Evaluating calibration interventions for small models under distribution shift",
    },
  ],
};

function searchPlan(query: string): SearchPlan {
  return {
    query,
    limit: 2,
    sort: "relevance",
    sourceIds: ["openalex"],
    queryVariants: [{ id: "primary", query, requestLimit: 2, category: "primary" }],
  };
}

function source(queryVariantId = "primary"): ResearchSourceStatus {
  return {
    id: "openalex",
    name: "OpenAlex",
    queryVariantId,
    status: "ok",
    retrievedAt,
    queryUrl: "https://api.openalex.org/works?search=calibration",
    resultCount: 2,
    coverage: "Test fixture covers the supplied calibration query.",
  };
}

function paper(id: string, title: string): ResearchPaper {
  return {
    id,
    identity: { doi: id.replace(/^doi:/u, "") },
    title,
    authors: ["Ada Lovelace"],
    year: 2025,
    citedByCount: 1,
    topics: [],
    referencedWorkIds: [],
    sourceId: "openalex",
    sourceIds: ["openalex"],
    provenance: [{
      sourceId: "openalex",
      sourceRecordId: id,
      queryVariantId: "primary",
      rank: 1,
      retrievedAt,
      queryUrl: "https://api.openalex.org/works?search=calibration",
    }],
  };
}

function successfulSearchArtifact(plan: SearchPlan): LiteratureSearchArtifact {
  const queryAudit = [source()];
  return {
    schemaVersion: 1,
    kind: "literature_search",
    artifactId: "literature-search-evidence",
    createdAt: retrievedAt,
    intent: { text: "Find evidence for calibration under distribution shift" },
    plan,
    papers: [
      paper("doi:10.1000/prior", "Calibration under deployment distribution shift"),
      paper("doi:10.1000/gap", "Evaluation gaps for calibration interventions"),
    ],
    edges: [],
    sources: queryAudit.map(({ queryVariantId: _queryVariantId, ...status }) => status),
    queryAudit,
    coverageAudit: buildLiteratureSearchCoverageAudit({ plan, queryAudit }),
    coverage: {
      status: "complete",
      resultCount: 2,
      warnings: [],
      requestedSourceIds: ["openalex"],
      successfulSourceIds: ["openalex"],
      failedSourceIds: [],
    },
    presentation: { autoOpen: false },
  };
}

function sessionPlan(): LiteratureSearchSessionPlan {
  return {
    sessionId: "research-capability-acceptance",
    intent: { text: "Find literature evidence for a calibration direction" },
    totalResultBudget: 4,
    maxConcurrentTasks: 2,
    tasks: [
      {
        id: "evidence-search",
        kind: "search",
        queryKind: "broad",
        intent: { text: "Find prior art and evaluation gaps" },
        plan: searchPlan("calibration intervention distribution shift"),
      },
      {
        id: "failed-recall",
        kind: "search",
        queryKind: "broad",
        intent: { text: "Try a broader recall query" },
        plan: searchPlan("reliability calibration small models"),
      },
    ],
  };
}

function assessmentInput(evidence: DirectionAssessmentInput["evidence"]): DirectionAssessmentInput {
  return {
    evidence,
    constraints: [
      { id: "data-available", kind: "data", label: "Labeled benchmark access", status: "satisfied" },
      { id: "compute-budget", kind: "compute", label: "Single-device compute budget", status: "satisfied", required: true },
      { id: "reference-baseline", kind: "baseline", label: "Reference calibration baseline", status: "satisfied" },
      { id: "evaluation-protocol", kind: "evaluation", label: "Predeclared calibration evaluation", status: "satisfied" },
    ],
    candidates: [
      {
        id: "calibration-under-shift",
        summary: "Evaluate calibration interventions for small models under distribution shift.",
        titleSeed: "The first breakthrough that always solves calibration",
        evidenceIds: ["prior-art", "evaluation-gap"],
        constraintIds: ["data-available", "compute-budget"],
        hypotheses: [
          {
            id: "calibration-effect",
            statement: "Calibration intervention quality changes under distribution shift.",
            failureCriterion: "The intervention does not improve the predeclared calibration metric over the reference baseline.",
            evidenceIds: ["prior-art", "evaluation-gap"],
            evaluationConstraintId: "evaluation-protocol",
            baselineConstraintIds: ["reference-baseline"],
          },
        ],
      },
    ],
  };
}

function assertTraceableEvidence(
  trace: Readonly<{ evidenceIds: string[]; paperIds: string[] }>,
  evidenceById: ReadonlyMap<string, NonNullable<DirectionAssessmentInput["evidence"]>[number]>,
  searchablePaperIds: ReadonlySet<string>,
): void {
  assert.equal(trace.evidenceIds.every((id) => evidenceById.has(id)), true);
  const expectedPaperIds = [...new Set(trace.evidenceIds.map((id) => evidenceById.get(id)!.paperId))].sort();
  assert.deepEqual([...trace.paperIds].sort(), expectedPaperIds);
  assert.equal(trace.paperIds.every((paperId) => searchablePaperIds.has(paperId)), true);
}

test("accepts a traceable research capability slice without prescribing a workflow or mutating a Project", async () => {
  const seedTool = createResearchDirectionSeedTool();
  const seedOutput = await seedTool.execute(seedInput, { now } as any);
  const seededCandidate = seedOutput.data?.result.candidateDirections[0];

  assert.ok(seededCandidate);
  assert.equal(seedOutput.data?.kind, "research_direction_seed");
  assert.equal(seedTool.isReadOnly({} as any), true);
  assert.equal(seededCandidate.cueIds.every((id) => seedOutput.data!.result.cues.some((cue) => cue.id === id)), true);
  assert.equal(seededCandidate.terminologyIds.every((id) => seedOutput.data!.result.terminology.some((term) => term.id === id)), true);
  assert.equal(seededCandidate.constraintIds.every((id) => seedOutput.data!.result.constraints.some((constraint) => constraint.id === id)), true);
  assert.equal(seededCandidate.provisionalTitle.status, "downgraded");
  assert.doesNotMatch(seededCandidate.provisionalTitle.text ?? "", /first|breakthrough|always|solves/iu);
  assert.equal(seededCandidate.provisionalTitle.confirmation.projectNameUpdate.status, "not_ready");

  const session = await runLiteratureSearchSession(sessionPlan(), {
    search: async (task, plan) => {
      if (task.id === "failed-recall") throw new Error("fixture provider unavailable");
      return successfulSearchArtifact(plan);
    },
  }, { now });

  assert.equal(session.status, "partial");
  assert.deepEqual(session.coverage.successfulTaskIds, ["evidence-search"]);
  assert.deepEqual(session.coverage.failedTaskIds, ["failed-recall"]);
  assert.deepEqual(session.artifacts.map((artifact) => artifact.taskId), ["evidence-search"]);
  assert.deepEqual(session.sourceAudit.map((entry) => [entry.taskId, entry.source.id]), [["evidence-search", "openalex"]]);

  const retainedArtifact = session.artifacts[0]?.artifact;
  assert.ok(retainedArtifact && retainedArtifact.kind === "literature_search");
  const retainedPapers = retainedArtifact.papers;
  const searchablePaperIds = new Set(retainedPapers.map((paper) => paper.id));
  assert.deepEqual([...searchablePaperIds].sort(), ["doi:10.1000/gap", "doi:10.1000/prior"]);
  assert.equal(
    searchablePaperIds.has(seedOutput.data!.result.cues.find((cue) => cue.id === "paper")?.sourceReference ?? ""),
    true,
  );
  assert.equal(retainedPapers.every((item) => item.provenance.every((provenance) => provenance.sourceId === "openalex")), true);

  const evidence: NonNullable<DirectionAssessmentInput["evidence"]> = [
    {
      id: "prior-art",
      paperId: retainedPapers.find((paper) => paper.id === "doi:10.1000/prior")!.id,
      role: "prior_art",
      strength: "direct",
      statement: "Prior work establishes the deployment-shift evaluation setting.",
    },
    {
      id: "evaluation-gap",
      paperId: retainedPapers.find((paper) => paper.id === "doi:10.1000/gap")!.id,
      role: "gap",
      strength: "direct",
      statement: "Existing work leaves calibration interventions under distribution shift incompletely evaluated.",
    },
  ];
  const input = assessmentInput(evidence);
  const assessment = assessResearchDirections(input).assessments[0];

  assert.ok(assessment);
  assert.equal(assessment.directionId, seededCandidate.id);
  assert.equal(assessment.minimumViability.status, "viable");
  assert.equal(assessment.novelty.status, "gap_evidenced");
  assert.equal(assessment.falsifiableHypotheses[0]?.status, "ready");
  assert.equal(assessment.provisionalTitle.status, "downgraded");
  assert.doesNotMatch(assessment.provisionalTitle.text ?? "", /first|breakthrough|always|solves/iu);

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  assertTraceableEvidence(assessment.score, evidenceById, searchablePaperIds);
  assertTraceableEvidence(assessment.novelty, evidenceById, searchablePaperIds);
  assertTraceableEvidence(assessment.falsifiableHypotheses[0]!, evidenceById, searchablePaperIds);
  assertTraceableEvidence(assessment.provisionalTitle, evidenceById, searchablePaperIds);

  const blockedAssessment = assessResearchDirections({
    ...input,
    constraints: input.constraints!.map((constraint) => constraint.id === "compute-budget"
      ? { ...constraint, status: "blocked" as const, required: true }
      : constraint),
  }).assessments[0]!;
  assert.equal(blockedAssessment.minimumViability.status, "blocked");
  assert.equal(blockedAssessment.unmetEvidenceGaps.some((gap) =>
    gap.code === "constraint_blocked" && gap.constraintIds.includes("compute-budget")), true);
  assert.equal(blockedAssessment.minimumViability.reasons.some((reason) =>
    reason.code === "constraint_blocked" && reason.constraintIds.includes("compute-budget")), true);

  const titleInput = {
    directionId: assessment.directionId,
    candidateTitle: "The first breakthrough that always solves calibration",
    neutralTitle: "Evaluating calibration interventions for small models under distribution shift",
    evidence,
  };
  const pendingTitle = confirmProvisionalTitle(titleInput);
  assert.equal(pendingTitle.title.status, "downgraded");
  assert.doesNotMatch(pendingTitle.title.text ?? "", /first|breakthrough|always|solves/iu);
  assert.equal(pendingTitle.confirmation.status, "pending");
  assert.equal(pendingTitle.confirmation.projectNameUpdate.status, "not_ready");
  assertTraceableEvidence(pendingTitle.title, evidenceById, searchablePaperIds);

  const confirmedTitle = confirmProvisionalTitle({ ...titleInput, confirmed: true });
  assert.equal(confirmedTitle.confirmation.status, "confirmed");
  assert.equal(confirmedTitle.confirmation.projectNameUpdate.status, "ready_for_explicit_project_action");
  assert.equal(confirmedTitle.confirmation.projectNameUpdate.name, confirmedTitle.title.text);
  assert.equal(confirmedTitle.confirmation.projectNameUpdate.requiresExplicitUserAction, true);
  assertTraceableEvidence(confirmedTitle.title, evidenceById, searchablePaperIds);
});
