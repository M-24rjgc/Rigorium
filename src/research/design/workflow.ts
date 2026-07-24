import { buildResearchArtifactGraph, type ResearchArtifactEnvelope } from "../artifacts/index.js";
import {
  createCandidatePortfolioArtifact,
  createChallengeReportArtifact,
  createDecisionRecordArtifact,
  createResearchBriefArtifact,
  type CandidatePortfolioArtifact,
  type CandidatePortfolioBuildInput,
  type ChallengeReportArtifact,
  type ChallengeReportBuildInput,
  type DecisionRecordArtifact,
  type DecisionRecordPayload,
  type ResearchBriefArtifact,
  type ResearchBriefBuildInput,
} from "./contracts.js";
import {
  compareResearchCandidates,
  type CandidateObjectiveAssessment,
  type ComparisonObjective,
  type EliminationRecord,
  type MultiObjectiveComparison,
} from "./comparison.js";

export type ResearchDesignPackage = Readonly<{
  entry: CandidatePortfolioBuildInput["entry"];
  portfolio: CandidatePortfolioArtifact;
  challengeReport: ChallengeReportArtifact;
  comparison: MultiObjectiveComparison;
  decisionRecord: DecisionRecordArtifact;
  researchBrief: ResearchBriefArtifact;
  artifacts: readonly ResearchArtifactEnvelope[];
}>;

export type ResearchDesignPackageInput = Readonly<{
  portfolio: CandidatePortfolioBuildInput;
  challenge: Omit<ChallengeReportBuildInput, "portfolio" | "producer" | "now">;
  comparison: Readonly<{
    objectives: readonly ComparisonObjective[];
    assessments: readonly CandidateObjectiveAssessment[];
  }>;
  decision: Readonly<{
    choice: string | null;
    status: DecisionRecordPayload["status"];
    rationale: string;
    eliminations: readonly EliminationRecord[];
    alternativesConsidered?: readonly string[];
    unresolvedRisks?: readonly string[];
    explicitUserConfirmation?: boolean;
  }>;
  brief?: Readonly<{
    question?: string;
    title?: ResearchBriefBuildInput["title"];
  }>;
  now?: Date;
}>;

/**
 * Materialize one complete design decision without creating a stage machine.
 * Every transition is an artifact edge; callers can revise any artifact and
 * invalidate descendants through the shared artifact graph.
 */
export function createResearchDesignPackage(input: ResearchDesignPackageInput): ResearchDesignPackage {
  requireIndependentDesignChecks(input);
  const now = input.now;
  const portfolio = createCandidatePortfolioArtifact({ ...input.portfolio, now });
  const challengeReport = createChallengeReportArtifact({
    ...input.challenge,
    portfolio,
    producer: { kind: "tool", toolName: "research_design" },
    now,
  });
  const comparison = compareResearchCandidates({ portfolio, ...input.comparison });
  const decisionRecord = createDecisionRecordArtifact({
    portfolio,
    challengeReport,
    comparison,
    ...input.decision,
    producer: { kind: "tool", toolName: "research_design" },
    now,
  });
  const researchBrief = createResearchBriefArtifact({
    portfolio,
    candidateId: input.decision.choice,
    challengeReport,
    decisionRecord,
    question: input.brief?.question,
    title: input.brief?.title,
    producer: { kind: "tool", toolName: "research_brief" },
    now,
  });
  const artifacts: ResearchArtifactEnvelope[] = [portfolio, challengeReport, decisionRecord, researchBrief];
  const graph = buildResearchArtifactGraph(artifacts);
  if (graph.missingParents.length > 0) throw new TypeError("Research design package contains unresolved artifact parents.");
  return Object.freeze({
    entry: portfolio.payload.entry,
    portfolio,
    challengeReport,
    comparison,
    decisionRecord,
    researchBrief,
    artifacts: Object.freeze(artifacts),
  });
}

export function discoverResearchIdeas(
  input: Omit<ResearchDesignPackageInput, "portfolio"> & {
    portfolio: Omit<CandidatePortfolioBuildInput, "entry">;
  },
): ResearchDesignPackage {
  return createResearchDesignPackage({
    ...input,
    portfolio: { ...input.portfolio, entry: "discover" },
  });
}

export function completeResearchIdea(
  input: Omit<ResearchDesignPackageInput, "portfolio"> & {
    portfolio: Omit<CandidatePortfolioBuildInput, "entry">;
  },
): ResearchDesignPackage {
  if (input.portfolio.idea.source !== "user") {
    throw new TypeError("The complete entry requires an idea whose source is user.");
  }
  return createResearchDesignPackage({
    ...input,
    portfolio: { ...input.portfolio, entry: "complete" },
  });
}

function requireIndependentDesignChecks(input: ResearchDesignPackageInput): void {
  if ((input.challenge.independentCriticisms?.length ?? 0) === 0) {
    throw new TypeError("A complete research design requires at least one independent criticism.");
  }
  if ((input.challenge.similarWorkRescans?.length ?? 0) === 0) {
    throw new TypeError("A complete research design requires a similar-work rescan input.");
  }
  if ((input.challenge.evidenceRescans?.length ?? 0) === 0) {
    throw new TypeError("A complete research design requires an evidence rescan input.");
  }
}
