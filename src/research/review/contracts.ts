import type { EvidencePackArtifact } from "../literature/evidencePack.js";
import type {
  ResearchArtifactEnvelope,
  ResearchArtifactProducer,
  ResearchArtifactRef,
} from "../artifacts/index.js";
import type { RunAttempt } from "../experimentation/index.js";
import type {
  CitationSetArtifact,
  FigureTableArtifact,
  ManuscriptTarget,
  ManuscriptVersionArtifact,
  RenderRunArtifact,
} from "../manuscript/index.js";

export const RESEARCH_REVIEW_SCHEMA_VERSION = 1 as const;

export const REVIEWER_LANES = [
  "method",
  "theory",
  "statistics",
  "evidence",
  "novelty",
  "writing",
  "target_fit",
] as const;

export type ReviewerLane = typeof REVIEWER_LANES[number];
export type ReviewSeverity = "blocker" | "major" | "minor" | "note";
export type ReviewConfidence = "high" | "medium" | "low";
export type ReviewAssessment = "concern" | "cleared";
export type ReviewLaneVerdict = "pass" | "needs_changes" | "blocked";

export type ReviewFindingCategory =
  | "compile"
  | "render"
  | "citation"
  | "page_limit"
  | "anonymity"
  | "figure_provenance"
  | "table_provenance"
  | "method"
  | "theory"
  | "statistics"
  | "evidence"
  | "novelty"
  | "writing"
  | "target_fit";

export type ManuscriptLocation = Readonly<{
  sectionId: string;
  statementId?: string;
  paragraphId?: string;
  page?: number;
  lineStart?: number;
  lineEnd?: number;
  anchorText: string;
}>;

export type FindingActionKind =
  | "revise_manuscript"
  | "revise_method"
  | "rerun_experiment"
  | "add_evidence"
  | "correct_citation"
  | "repair_render"
  | "fix_provenance"
  | "reconsider_target"
  | "adjudicate"
  | "no_change";

export type FindingAction = Readonly<{
  kind: FindingActionKind;
  instruction: string;
  targetArtifactRefs: readonly ResearchArtifactRef[];
}>;

export type ReviewFindingDraft = Readonly<{
  id: string;
  dedupeKey: string;
  lane: ReviewerLane;
  reviewerId: string;
  assessment: ReviewAssessment;
  category: ReviewFindingCategory;
  severity: ReviewSeverity;
  confidence: ReviewConfidence;
  summary: string;
  rationale: string;
  location: ManuscriptLocation;
  actions: readonly FindingAction[];
  evidenceRefs: readonly ResearchArtifactRef[];
  runRefs: readonly ResearchArtifactRef[];
  affectedArtifactRefs: readonly ResearchArtifactRef[];
}>;

export type ReviewerLaneReport = Readonly<{
  lane: ReviewerLane;
  reviewerId: string;
  independent: true;
  findings: readonly ReviewFindingDraft[];
}>;

export type ReviewFindingSource = "preflight" | "reviewer" | "mixed";

export type ReviewFindingPayload = Readonly<{
  schemaVersion: 1;
  kind: "finding";
  reviewRoundId: string;
  findingId: string;
  dedupeKey: string;
  source: ReviewFindingSource;
  lanes: readonly ReviewerLane[];
  reviewerIds: readonly string[];
  assessment: ReviewAssessment;
  category: ReviewFindingCategory;
  severity: ReviewSeverity;
  confidence: ReviewConfidence;
  summary: string;
  rationale: string;
  location: ManuscriptLocation;
  actions: readonly FindingAction[];
  evidenceRefs: readonly ResearchArtifactRef[];
  runRefs: readonly ResearchArtifactRef[];
  affectedArtifactRefs: readonly ResearchArtifactRef[];
  mergedFromFindingIds: readonly string[];
  contradictionGroupId?: string;
}>;

export type ReviewFindingArtifact = ResearchArtifactEnvelope<"finding", ReviewFindingPayload>;

export type ReviewContradiction = Readonly<{
  id: string;
  dedupeKey: string;
  location: ManuscriptLocation;
  findingRefs: readonly ResearchArtifactRef[];
  status: "needs_adjudication";
}>;

export type ReviewLaneSummary = Readonly<{
  lane: ReviewerLane;
  reviewerId: string;
  independent: true;
  verdict: ReviewLaneVerdict;
  findingRefs: readonly ResearchArtifactRef[];
}>;

export type ReviewPreflightCheckId =
  | "compile_render"
  | "citation_completeness"
  | "page_limit"
  | "anonymity"
  | "figure_table_provenance"
  | "statement_evidence_provenance";

export type ReviewPreflightCheck = Readonly<{
  id: ReviewPreflightCheckId;
  status: "passed" | "failed";
  detail: string;
  findingIds: readonly string[];
}>;

export type ReviewRoundPayload = Readonly<{
  schemaVersion: 1;
  kind: "review_round";
  reviewRoundId: string;
  manuscriptRef: ResearchArtifactRef;
  renderRunRef?: ResearchArtifactRef;
  citationSetRef?: ResearchArtifactRef;
  target: ReviewTarget;
  preflightChecks: readonly ReviewPreflightCheck[];
  laneSummaries: readonly ReviewLaneSummary[];
  findingRefs: readonly ResearchArtifactRef[];
  contradictions: readonly ReviewContradiction[];
  status: ReviewLaneVerdict;
  completedAt: string;
}>;

export type ReviewRoundArtifact = ResearchArtifactEnvelope<"review_round", ReviewRoundPayload>;

export type ReviewRoundPackage = Readonly<{
  reviewRound: ReviewRoundArtifact;
  findings: readonly ReviewFindingArtifact[];
}>;

export type ReviewTarget = ManuscriptTarget;
export type ReviewableManuscriptArtifact = ManuscriptVersionArtifact;
export type ReviewRenderRunArtifact = RenderRunArtifact;
export type ReviewCitationSetArtifact = CitationSetArtifact;

export type ReviewFigureTablePayload = Readonly<{
  experimentId: string;
  runAttemptId: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  mediaType?: string;
  role: "figure" | "table";
}>;

export type ExperimentFigureTableArtifact = ResearchArtifactEnvelope<"figure_table", ReviewFigureTablePayload>;
export type ReviewFigureTableArtifact = FigureTableArtifact | ExperimentFigureTableArtifact;
export type ReviewRunAttemptArtifact = RunAttempt;

export type ReviewPreflightInput = Readonly<{
  manuscript: ReviewableManuscriptArtifact;
  renderRun?: ReviewRenderRunArtifact;
  citationSet?: ReviewCitationSetArtifact;
  figureTableArtifacts?: readonly ReviewFigureTableArtifact[];
  runAttempts?: readonly ReviewRunAttemptArtifact[];
  /** Evidence packs the manuscript statements bind to (provenance resolution). */
  evidencePacks?: readonly EvidencePackArtifact[];
}>;

export type ReviewRoundInput = ReviewPreflightInput & Readonly<{
  laneReports: readonly ReviewerLaneReport[];
  artifactId?: string;
  now?: Date;
  producer?: ResearchArtifactProducer;
}>;

export type RevisionDisposition = "revise" | "dismiss" | "defer";

export type RevisionResolutionInput = Readonly<{
  findingArtifactId: string;
  disposition: RevisionDisposition;
  rationale: string;
  targetArtifactRefs: readonly ResearchArtifactRef[];
}>;

export type RevisionDecisionEntry = Readonly<{
  findingRef: ResearchArtifactRef;
  disposition: RevisionDisposition;
  rationale: string;
  targetArtifactRefs: readonly ResearchArtifactRef[];
}>;

export type RevisionDecisionPayload = Readonly<{
  schemaVersion: 1;
  kind: "revision_decision";
  reviewRoundRef: ResearchArtifactRef;
  decisions: readonly RevisionDecisionEntry[];
  invalidationRootRefs: readonly ResearchArtifactRef[];
  status: "revision_required" | "deferred" | "no_revision";
  decidedAt: string;
}>;

export type RevisionDecisionArtifact = ResearchArtifactEnvelope<"revision_decision", RevisionDecisionPayload>;

export type RevisionDecisionInput = Readonly<{
  reviewRound: ReviewRoundArtifact;
  findings: readonly ReviewFindingArtifact[];
  resolutions: readonly RevisionResolutionInput[];
  artifacts: readonly ResearchArtifactEnvelope[];
  artifactId?: string;
  now?: Date;
  producer?: ResearchArtifactProducer;
}>;

export type AppliedRevisionDecision = Readonly<{
  decision: RevisionDecisionArtifact;
  artifacts: readonly ResearchArtifactEnvelope[];
  invalidatedArtifactRefs: readonly ResearchArtifactRef[];
}>;
