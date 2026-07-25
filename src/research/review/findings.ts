import { createHash } from "node:crypto";
import {
  createResearchArtifact,
  type ResearchArtifactProducer,
  type ResearchArtifactRef,
} from "../artifacts/index.js";
import {
  REVIEWER_LANES,
  type FindingAction,
  type FindingActionKind,
  type ReviewAssessment,
  type ReviewConfidence,
  type ReviewContradiction,
  type ReviewFindingArtifact,
  type ReviewFindingCategory,
  type ReviewFindingDraft,
  type ReviewFindingSource,
  type ReviewerLane,
  type ReviewSeverity,
} from "./contracts.js";
import {
  fullRefKey,
  identifier,
  locationKey,
  mergeRefs,
  normalizeLocation,
  normalizeWords,
  text,
  uniqueRefs,
} from "./validation.js";

const ASSESSMENTS = new Set<ReviewAssessment>(["concern", "cleared"]);
const CATEGORIES = new Set<ReviewFindingCategory>([
  "compile", "render", "citation", "page_limit", "anonymity", "figure_provenance",
  "table_provenance", "method", "theory", "statistics", "evidence", "novelty",
  "writing", "target_fit",
]);
const SEVERITIES = new Set<ReviewSeverity>(["blocker", "major", "minor", "note"]);
const CONFIDENCES = new Set<ReviewConfidence>(["high", "medium", "low"]);
const ACTION_KINDS = new Set<FindingActionKind>([
  "revise_manuscript", "revise_method", "rerun_experiment", "add_evidence",
  "correct_citation", "repair_render", "fix_provenance", "reconsider_target",
  "adjudicate", "no_change",
]);
const LANE_INDEX = new Map<ReviewerLane, number>(REVIEWER_LANES.map((lane, index) => [lane, index]));
const SEVERITY_INDEX = new Map<ReviewSeverity, number>([
  ["blocker", 0], ["major", 1], ["minor", 2], ["note", 3],
]);
const CONFIDENCE_INDEX = new Map<ReviewConfidence, number>([
  ["high", 0], ["medium", 1], ["low", 2],
]);

type SourcedDraft = ReviewFindingDraft & Readonly<{ source?: "preflight" }>;

export type AggregateReviewFindingsInput = Readonly<{
  reviewRoundId: string;
  manuscriptRef: ResearchArtifactRef;
  drafts: readonly SourcedDraft[];
  producer: ResearchArtifactProducer;
  now?: Date;
}>;

export type AggregatedReviewFindings = Readonly<{
  findings: readonly ReviewFindingArtifact[];
  contradictions: readonly ReviewContradiction[];
}>;

export function aggregateReviewFindings(input: AggregateReviewFindingsInput): AggregatedReviewFindings {
  const reviewRoundId = identifier(input.reviewRoundId, "reviewRoundId");
  if (!Array.isArray(input.drafts)) throw new TypeError("Review finding drafts must be an array.");
  const normalized = input.drafts.map((draft, index) => normalizeDraft(draft, index));
  const ids = new Set<string>();
  for (const draft of normalized) {
    if (ids.has(draft.id)) throw new TypeError(`Review finding draft ${draft.id} is duplicated.`);
    ids.add(draft.id);
  }

  const groups = new Map<string, NormalizedDraft[]>();
  for (const draft of normalized) {
    const key = `${draft.dedupeKey}\n${locationKey(draft.location)}`;
    const group = groups.get(key) ?? [];
    group.push(draft);
    groups.set(key, group);
  }

  const findings: ReviewFindingArtifact[] = [];
  const contradictions: ReviewContradiction[] = [];
  for (const [groupKey, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const contradictionGroupId = hasOpposingAssessments(group)
      ? `adjudication-${digest(`${reviewRoundId}\n${groupKey}`)}`
      : undefined;
    const compatible = new Map<string, NormalizedDraft[]>();
    for (const draft of group) {
      const key = [draft.assessment, draft.category, normalizeWords(draft.summary)].join("\n");
      const bucket = compatible.get(key) ?? [];
      bucket.push(draft);
      compatible.set(key, bucket);
    }
    const groupFindings: ReviewFindingArtifact[] = [];
    for (const [compatibilityKey, drafts] of [...compatible.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))) {
      const findingId = `finding-${digest(`${reviewRoundId}\n${groupKey}\n${compatibilityKey}`)}`;
      const artifact = createMergedFinding({
        reviewRoundId,
        findingId,
        manuscriptRef: input.manuscriptRef,
        drafts,
        producer: input.producer,
        ...(contradictionGroupId === undefined ? {} : { contradictionGroupId }),
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      findings.push(artifact);
      groupFindings.push(artifact);
    }
    if (contradictionGroupId) {
      contradictions.push(Object.freeze({
        id: contradictionGroupId,
        dedupeKey: group[0]!.dedupeKey,
        location: group[0]!.location,
        findingRefs: Object.freeze(groupFindings.map((finding) => Object.freeze({
          artifactId: finding.artifactId,
          revision: finding.revision,
          kind: finding.kind,
          contentHash: finding.contentHash,
        })).sort(compareRefs)),
        status: "needs_adjudication" as const,
      }));
    }
  }
  findings.sort((left, right) => left.artifactId.localeCompare(right.artifactId, "en"));
  contradictions.sort((left, right) => left.id.localeCompare(right.id, "en"));
  return Object.freeze({ findings: Object.freeze(findings), contradictions: Object.freeze(contradictions) });
}

type NormalizedDraft = ReviewFindingDraft & Readonly<{ source: "preflight" | "reviewer" }>;

function normalizeDraft(draft: SourcedDraft, index: number): NormalizedDraft {
  if (!draft || typeof draft !== "object") throw new TypeError(`Review finding draft ${index} must be an object.`);
  if (!REVIEWER_LANES.includes(draft.lane)) throw new TypeError(`Review finding draft ${index} has an invalid lane.`);
  if (!ASSESSMENTS.has(draft.assessment)) throw new TypeError(`Review finding draft ${index} has an invalid assessment.`);
  if (!CATEGORIES.has(draft.category)) throw new TypeError(`Review finding draft ${index} has an invalid category.`);
  if (!SEVERITIES.has(draft.severity)) throw new TypeError(`Review finding draft ${index} has an invalid severity.`);
  if (!CONFIDENCES.has(draft.confidence)) throw new TypeError(`Review finding draft ${index} has an invalid confidence.`);
  const affectedArtifactRefs = uniqueRefs(draft.affectedArtifactRefs, `finding ${index} affectedArtifactRefs`);
  if (affectedArtifactRefs.length === 0) throw new TypeError(`Review finding draft ${index} must affect at least one artifact.`);
  const affected = new Set(affectedArtifactRefs.map(fullRefKey));
  if (!Array.isArray(draft.actions) || draft.actions.length === 0) {
    throw new TypeError(`Review finding draft ${index} must include at least one action.`);
  }
  const actions = draft.actions.map((action, actionIndex) => normalizeAction(action, index, actionIndex, affected));
  const evidenceRefs = uniqueRefs(draft.evidenceRefs, `finding ${index} evidenceRefs`);
  const runRefs = uniqueRefs(draft.runRefs, `finding ${index} runRefs`);
  if (runRefs.some((ref) => ref.kind !== "run_attempt")) {
    throw new TypeError(`Review finding draft ${index} runRefs must reference run_attempt artifacts.`);
  }
  return Object.freeze({
    id: identifier(draft.id, `finding ${index} id`),
    dedupeKey: identifier(draft.dedupeKey, `finding ${index} dedupeKey`),
    lane: draft.lane,
    reviewerId: identifier(draft.reviewerId, `finding ${index} reviewerId`),
    assessment: draft.assessment,
    category: draft.category,
    severity: draft.severity,
    confidence: draft.confidence,
    summary: text(draft.summary, `finding ${index} summary`, 4_000),
    rationale: text(draft.rationale, `finding ${index} rationale`, 8_000),
    location: normalizeLocation(draft.location, `finding ${index} location`),
    actions: Object.freeze(actions),
    evidenceRefs: Object.freeze(evidenceRefs),
    runRefs: Object.freeze(runRefs),
    affectedArtifactRefs: Object.freeze(affectedArtifactRefs),
    source: draft.source === "preflight" && draft.reviewerId === "deterministic-preflight"
      ? "preflight" as const
      : "reviewer" as const,
  });
}

function normalizeAction(
  action: FindingAction,
  findingIndex: number,
  actionIndex: number,
  affected: ReadonlySet<string>,
): FindingAction {
  if (!action || typeof action !== "object" || !ACTION_KINDS.has(action.kind)) {
    throw new TypeError(`Review finding ${findingIndex} action ${actionIndex} has an invalid kind.`);
  }
  const targetArtifactRefs = uniqueRefs(
    action.targetArtifactRefs,
    `finding ${findingIndex} actions[${actionIndex}].targetArtifactRefs`,
  );
  if (targetArtifactRefs.some((ref) => !affected.has(fullRefKey(ref)))) {
    throw new TypeError(`Review finding ${findingIndex} action ${actionIndex} targets an unaffected artifact.`);
  }
  return Object.freeze({
    kind: action.kind,
    instruction: text(action.instruction, `finding ${findingIndex} action ${actionIndex} instruction`, 8_000),
    targetArtifactRefs: Object.freeze(targetArtifactRefs),
  });
}

function createMergedFinding(input: {
  reviewRoundId: string;
  findingId: string;
  manuscriptRef: ResearchArtifactRef;
  drafts: readonly NormalizedDraft[];
  producer: ResearchArtifactProducer;
  contradictionGroupId?: string;
  now?: Date;
}): ReviewFindingArtifact {
  const ordered = [...input.drafts].sort((left, right) => left.id.localeCompare(right.id, "en"));
  const first = ordered[0]!;
  const sources = new Set(ordered.map((draft) => draft.source));
  const source: ReviewFindingSource = sources.size > 1 ? "mixed" : first.source;
  const rationale = mergeText(ordered.map((draft) => draft.rationale), 8_000, "merged finding rationale");
  const actions = mergeActions(ordered.flatMap((draft) => draft.actions));
  const lanes = [...new Set(ordered.map((draft) => draft.lane))]
    .sort((left, right) => LANE_INDEX.get(left)! - LANE_INDEX.get(right)!);
  const reviewerIds = [...new Set(ordered.map((draft) => draft.reviewerId))].sort(compareText);
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "finding" as const,
    reviewRoundId: input.reviewRoundId,
    findingId: input.findingId,
    dedupeKey: first.dedupeKey,
    source,
    lanes: Object.freeze(lanes),
    reviewerIds: Object.freeze(reviewerIds),
    assessment: first.assessment,
    category: first.category,
    severity: strongest(ordered.map((draft) => draft.severity), SEVERITY_INDEX),
    confidence: strongest(ordered.map((draft) => draft.confidence), CONFIDENCE_INDEX),
    summary: first.summary,
    rationale,
    location: first.location,
    actions: Object.freeze(actions),
    evidenceRefs: Object.freeze(mergeRefs(ordered.map((draft) => draft.evidenceRefs))),
    runRefs: Object.freeze(mergeRefs(ordered.map((draft) => draft.runRefs))),
    affectedArtifactRefs: Object.freeze(mergeRefs(ordered.map((draft) => draft.affectedArtifactRefs))),
    mergedFromFindingIds: Object.freeze(ordered.map((draft) => draft.id)),
    ...(input.contradictionGroupId === undefined ? {} : { contradictionGroupId: input.contradictionGroupId }),
  });
  return createResearchArtifact({
    kind: "finding",
    artifactId: `review-${input.findingId}`,
    payload,
    producer: input.producer,
    parents: [{ relation: "derived_from", artifact: input.manuscriptRef }],
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

function mergeActions(actions: readonly FindingAction[]): FindingAction[] {
  const merged = new Map<string, FindingAction>();
  for (const action of actions) {
    const key = `${action.kind}\n${normalizeWords(action.instruction)}\n${action.targetArtifactRefs.map(fullRefKey).sort(compareText).join("\n")}`;
    merged.set(key, action);
  }
  return [...merged.entries()].sort(([left], [right]) => compareText(left, right)).map(([, action]) => action);
}

function mergeText(values: readonly string[], maximum: number, label: string): string {
  const merged = [...new Set(values)].sort(compareText).join("\n\n");
  return text(merged, label, maximum);
}

function strongest<T extends string>(values: readonly T[], ranks: ReadonlyMap<T, number>): T {
  return [...values].sort((left, right) => ranks.get(left)! - ranks.get(right)!)[0]!;
}

function hasOpposingAssessments(drafts: readonly NormalizedDraft[]): boolean {
  const assessments = new Set(drafts.map((draft) => draft.assessment));
  return assessments.has("concern") && assessments.has("cleared");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20);
}

function compareRefs(left: ResearchArtifactRef, right: ResearchArtifactRef): number {
  return compareText(fullRefKey(left), fullRefKey(right));
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}
