import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assessResearchDirections,
  type DirectionAssessment,
  type DirectionAssessmentInput,
  type DirectionAssessmentResult,
  type DirectionConstraint,
} from "./directionAssessment.js";
import {
  normalizeResearchDirectionSeed,
  type ResearchDirectionSeed,
  type ResearchDirectionSeedInput,
} from "./directionSeed.js";
import {
  confirmProvisionalTitle,
  type TitleConfirmationInput,
  type TitleConfirmationResult,
} from "./titleConfirmation.js";

/** The persisted document version, intentionally separate from source artifacts. */
export const RESEARCH_DIRECTION_LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const MAX_RESEARCH_DIRECTION_LIFECYCLE_FILE_BYTES = 4 * 1024 * 1024;

export const RESEARCH_DIRECTION_LIFECYCLE_STAGE_IDS = [
  "cue_classification",
  "terminology",
  "constraints",
  "evidence_gap_analysis",
  "candidate_comparison",
  "novelty_value_rescan",
  "feasibility_ethics_evaluation",
  "falsifiable_hypotheses_contributions",
  "minimum_viability",
  "provisional_title",
  "project_name_confirmation",
] as const;

export type ResearchDirectionLifecycleStageId = typeof RESEARCH_DIRECTION_LIFECYCLE_STAGE_IDS[number];
export type ResearchDirectionLifecycleStageStatus =
  | "not_started"
  | "needs_input"
  | "needs_evidence"
  | "blocked"
  | "awaiting_confirmation"
  | "complete";

/** Stable codes allow the right panel to localize status text without parsing English prose. */
export type ResearchDirectionLifecycleStage = Readonly<{
  id: ResearchDirectionLifecycleStageId;
  status: ResearchDirectionLifecycleStageStatus;
  candidateId?: string;
  evidenceIds: string[];
  constraintIds: string[];
  reasonCodes: string[];
}>;

export type ResearchDirectionLifecycleChecklist = Readonly<{
  items: ResearchDirectionLifecycleStage[];
  completedStageIds: ResearchDirectionLifecycleStageId[];
  nextStageId?: ResearchDirectionLifecycleStageId;
  status: "in_progress" | "blocked" | "awaiting_title_confirmation" | "ready_for_explicit_project_name_action";
  /** A caller may surface this intent, but no lifecycle function changes a Project name. */
  projectNameAction: Readonly<{
    status: "not_ready" | "ready_for_explicit_project_action";
    name?: string;
    requiresExplicitUserAction: true;
  }>;
}>;

export type ResearchDirectionLifecycleAssessmentSnapshot = Readonly<{
  input: DirectionAssessmentInput;
  result: DirectionAssessmentResult;
}>;

export type ResearchDirectionLifecycleTitleConfirmationSnapshot = Readonly<{
  input: TitleConfirmationInput;
  result: TitleConfirmationResult;
}>;

/**
 * Project-local, recoverable progress from conversational cues to a
 * provisional title. It deliberately stores no Project name and has no
 * mutation path outside its own research JSON file.
 */
export type ResearchDirectionLifecycleState = Readonly<{
  schemaVersion: 1;
  kind: "research_direction_lifecycle";
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Original bounded cue input retained so persisted normalization can be revalidated. */
  seedInput: ResearchDirectionSeedInput;
  seed: ResearchDirectionSeed;
  assessment?: ResearchDirectionLifecycleAssessmentSnapshot;
  selectedDirectionId?: string;
  titleConfirmation?: ResearchDirectionLifecycleTitleConfirmationSnapshot;
  checklist: ResearchDirectionLifecycleChecklist;
}>;

export type ResearchDirectionLifecycleUpdate = Readonly<{
  /** Replacing a changed seed invalidates later artifacts unless supplied again in this update. */
  seed?: ResearchDirectionSeedInput;
  assessment?: DirectionAssessmentInput;
  /** `null` explicitly clears a previous selection and its stale title confirmation. */
  selectedDirectionId?: string | null;
  /** `confirmed: true` is only valid after the user explicitly confirms the proposed title. */
  titleConfirmation?: TitleConfirmationInput;
}>;

export type ResearchDirectionLifecycleRepositoryErrorCode =
  | "invalid_input"
  | "invalid_project_root"
  | "path_violation"
  | "io_error"
  | "file_too_large"
  | "corrupt_json"
  | "invalid_schema"
  | "revision_conflict";

export type ResearchDirectionLifecycleRepositoryDiagnostic = Readonly<{
  code: ResearchDirectionLifecycleRepositoryErrorCode;
  message: string;
  path?: string;
  operation?: string;
}>;

export class ResearchDirectionLifecycleRepositoryError extends Error {
  readonly code: ResearchDirectionLifecycleRepositoryErrorCode;
  readonly diagnostic: ResearchDirectionLifecycleRepositoryDiagnostic;

  constructor(
    code: ResearchDirectionLifecycleRepositoryErrorCode,
    message: string,
    context: Omit<ResearchDirectionLifecycleRepositoryDiagnostic, "code" | "message"> = {},
  ) {
    super(message);
    this.name = "ResearchDirectionLifecycleRepositoryError";
    this.code = code;
    this.diagnostic = Object.freeze({ code, message, ...context });
  }
}

export type ProjectResearchDirectionLifecyclePaths = Readonly<{
  projectRoot: string;
  pilotDeckDir: string;
  researchDir: string;
  lifecyclePath: string;
}>;

export type ProjectResearchDirectionLifecycleResult = Readonly<{
  path: string;
  state: ResearchDirectionLifecycleState;
  created: boolean;
  /** False when the semantic update was idempotent. */
  persisted: boolean;
}>;

export function getProjectResearchDirectionLifecyclePaths(input: {
  projectRoot: string;
}): ProjectResearchDirectionLifecyclePaths {
  const projectRoot = resolveProjectRoot(input.projectRoot);
  const pilotDeckDir = join(projectRoot, ".pilotdeck");
  const researchDir = join(pilotDeckDir, "research");
  const lifecyclePath = join(researchDir, "direction-lifecycle.json");
  for (const candidate of [pilotDeckDir, researchDir, lifecyclePath]) {
    assertWithinProject(projectRoot, candidate);
  }
  return Object.freeze({ projectRoot, pilotDeckDir, researchDir, lifecyclePath });
}

/** Loads the lifecycle without manufacturing a missing project artifact. */
export async function loadProjectResearchDirectionLifecycle(input: {
  projectRoot: string;
}): Promise<ResearchDirectionLifecycleState | undefined> {
  const paths = getProjectResearchDirectionLifecyclePaths(input);
  const repositoryExists = await assertReadableRepository(paths);
  if (!repositoryExists) return undefined;
  const raw = await readBoundedJson(paths.lifecyclePath, "load_lifecycle");
  return raw === undefined ? undefined : validateLifecycleDocument(raw, paths.lifecyclePath);
}

/**
 * Applies a bounded lifecycle update through a project-local atomic write.
 * This function never creates a snapshot, calls Zotero, exports data, or
 * changes the Project name.
 */
export async function updateProjectResearchDirectionLifecycle(input: {
  projectRoot: string;
  update: ResearchDirectionLifecycleUpdate;
  expectedRevision?: number;
  now?: Date;
}): Promise<ProjectResearchDirectionLifecycleResult> {
  const paths = getProjectResearchDirectionLifecyclePaths({ projectRoot: input.projectRoot });
  const existing = await loadProjectResearchDirectionLifecycle({ projectRoot: paths.projectRoot });
  assertExpectedRevision(existing?.revision ?? 0, input.expectedRevision, paths.lifecyclePath);
  const applied = applyResearchDirectionLifecycleUpdate({ existing, update: input.update, now: input.now });
  if (!applied.changed && existing) {
    return { path: paths.lifecyclePath, state: existing, created: false, persisted: false };
  }

  await ensureRepositoryDirectories(paths);
  validateLifecycleDocument(applied.state, paths.lifecyclePath);
  await writeJsonAtomically(paths.lifecyclePath, applied.state, "update_lifecycle");
  return {
    path: paths.lifecyclePath,
    state: applied.state,
    created: !existing,
    persisted: true,
  };
}

/**
 * Pure update logic used by the repository and focused tests. A changed seed,
 * assessment, or selected direction invalidates any earlier title confirmation
 * unless a replacement title confirmation is provided in the same update.
 */
export function applyResearchDirectionLifecycleUpdate(input: {
  existing?: ResearchDirectionLifecycleState;
  update: ResearchDirectionLifecycleUpdate;
  now?: Date;
}): Readonly<{ state: ResearchDirectionLifecycleState; changed: boolean }> {
  if (!input.update || typeof input.update !== "object" || Array.isArray(input.update)) {
    throw lifecycleError("invalid_input", "Research direction lifecycle update must be an object.", {
      operation: "apply_update",
    });
  }
  const existing = input.existing;
  const hasSeed = hasOwn(input.update, "seed");
  const hasAssessment = hasOwn(input.update, "assessment");
  const hasSelection = hasOwn(input.update, "selectedDirectionId");
  const hasTitleConfirmation = hasOwn(input.update, "titleConfirmation");

  if (!existing && !hasSeed) {
    throw lifecycleError("invalid_input", "Creating a research direction lifecycle requires a seed.", {
      operation: "apply_update",
    });
  }

  const nextSeedInput: ResearchDirectionSeedInput = hasSeed
    ? input.update.seed as ResearchDirectionSeedInput
    : existing!.seedInput;
  const nextSeed = normalizeSeed(nextSeedInput);
  const seedChanged = !existing || !sameJson(nextSeed, existing.seed);

  const nextAssessment = hasAssessment
    ? normalizeAssessment(input.update.assessment)
    : seedChanged
      ? undefined
      : existing?.assessment;
  const assessmentChanged = !sameJson(nextAssessment, existing?.assessment);

  let selectedDirectionId = hasSelection
    ? normalizeSelectedDirectionId(input.update.selectedDirectionId)
    : existing?.selectedDirectionId;
  if (selectedDirectionId && !nextSeed.candidateDirections.some((candidate) => candidate.id === selectedDirectionId)) {
    throw lifecycleError("invalid_input", `Selected direction does not exist in the current seed: ${selectedDirectionId}.`, {
      operation: "apply_update",
    });
  }
  if (nextAssessment) {
    assertAssessmentMatchesSeed(nextAssessment, nextSeed);
    if (selectedDirectionId && !nextAssessment.result.assessments.some((candidate) => candidate.directionId === selectedDirectionId)) {
      throw lifecycleError("invalid_input", `Selected direction is not present in the current assessment: ${selectedDirectionId}.`, {
        operation: "apply_update",
      });
    }
  }
  const selectionChanged = selectedDirectionId !== existing?.selectedDirectionId;

  const nextTitleConfirmation = hasTitleConfirmation
    ? normalizeTitleConfirmation(input.update.titleConfirmation)
    : seedChanged || assessmentChanged || selectionChanged
      ? undefined
      : existing?.titleConfirmation;
  if (nextTitleConfirmation) {
    if (!nextAssessment) {
      throw lifecycleError("invalid_input", "Title confirmation requires a current direction assessment.", {
        operation: "apply_update",
      });
    }
    if (!selectedDirectionId) {
      throw lifecycleError("invalid_input", "Title confirmation requires an explicitly selected direction.", {
        operation: "apply_update",
      });
    }
    assertTitleMatchesAssessment(nextTitleConfirmation, selectedDirectionId, nextAssessment);
  }

  const payload = {
    seedInput: nextSeedInput,
    seed: nextSeed,
    ...(nextAssessment ? { assessment: nextAssessment } : {}),
    ...(selectedDirectionId ? { selectedDirectionId } : {}),
    ...(nextTitleConfirmation ? { titleConfirmation: nextTitleConfirmation } : {}),
  };
  const existingPayload = existing ? lifecyclePayload(existing) : undefined;
  if (existing && sameJson(payload, existingPayload)) {
    return { state: existing, changed: false };
  }

  const timestamp = nowIso(input.now);
  const base = {
    schemaVersion: RESEARCH_DIRECTION_LIFECYCLE_SCHEMA_VERSION,
    kind: "research_direction_lifecycle" as const,
    revision: (existing?.revision ?? 0) + 1,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    ...payload,
  };
  const state: ResearchDirectionLifecycleState = {
    ...base,
    checklist: buildResearchDirectionLifecycleChecklist(base),
  };
  return { state, changed: true };
}

/** Rebuilds the UI-ready checklist from traceable source artifacts only. */
export function buildResearchDirectionLifecycleChecklist(input: Pick<
  ResearchDirectionLifecycleState,
  "seed" | "assessment" | "selectedDirectionId" | "titleConfirmation"
>): ResearchDirectionLifecycleChecklist {
  const selectedAssessment = input.selectedDirectionId
    ? input.assessment?.result.assessments.find((item) => item.directionId === input.selectedDirectionId)
    : undefined;
  const selectedAssessmentInput = input.selectedDirectionId
    ? input.assessment?.input.candidates.find((item) => item.id === input.selectedDirectionId)
    : undefined;
  const selectedSeedCandidate = input.selectedDirectionId
    ? input.seed.candidateDirections.find((item) => item.id === input.selectedDirectionId)
    : undefined;
  const selectedCandidateId = input.selectedDirectionId;

  const cueClassification = stage(
    "cue_classification",
    "complete",
    undefined,
    input.seed.cues.map((cue) => cue.id),
    [],
    [],
  );
  const terminology = input.seed.terminology.length > 0
    ? stage("terminology", "complete", undefined, input.seed.terminology.flatMap((term) => term.cueIds), [], [])
    : stage("terminology", "needs_input", undefined, [], [], ["terminology_missing"]);
  const constraints = assessSeedConstraints(input.seed);
  const evidenceGapAnalysis = input.assessment
    ? stage(
      "evidence_gap_analysis",
      "complete",
      selectedCandidateId,
      selectedAssessment?.score.evidenceIds ?? aggregateEvidenceIds(input.assessment.result),
      selectedAssessment?.score.constraintIds ?? [],
      selectedAssessment?.unmetEvidenceGaps.map((gap) => gap.code) ?? [],
    )
    : stage("evidence_gap_analysis", "needs_input", selectedCandidateId, [], [], ["assessment_missing"]);
  const candidateComparison = !input.assessment
    ? stage("candidate_comparison", "needs_input", selectedCandidateId, [], [], ["assessment_missing"])
    : !selectedCandidateId
      ? stage("candidate_comparison", "needs_input", undefined, [], [], ["direction_selection_missing"])
      : stage(
        "candidate_comparison",
        "complete",
        selectedCandidateId,
        selectedAssessment?.score.evidenceIds ?? [],
        selectedAssessment?.score.constraintIds ?? [],
        [],
      );
  const noveltyValueRescan = assessNovelty(selectedAssessment, selectedCandidateId);
  const feasibilityEthicsEvaluation = assessFeasibility(
    selectedAssessment,
    selectedAssessmentInput,
    input.assessment?.input.constraints,
    selectedCandidateId,
  );
  const hypothesesContributions = assessHypothesesAndContributions(
    selectedAssessment,
    selectedSeedCandidate,
    selectedCandidateId,
  );
  const minimumViability = assessMinimumViability(selectedAssessment, selectedCandidateId);
  const provisionalTitle = assessProvisionalTitle(input.titleConfirmation, selectedCandidateId);
  const projectNameConfirmation = assessProjectNameConfirmation(input.titleConfirmation, selectedCandidateId);
  const items = [
    cueClassification,
    terminology,
    constraints,
    evidenceGapAnalysis,
    candidateComparison,
    noveltyValueRescan,
    feasibilityEthicsEvaluation,
    hypothesesContributions,
    minimumViability,
    provisionalTitle,
    projectNameConfirmation,
  ];
  const completedStageIds = items
    .filter((item) => item.status === "complete")
    .map((item) => item.id);
  const nextStageId = items.find((item) => item.status !== "complete")?.id;
  const projectNameAction = input.titleConfirmation?.result.confirmation.projectNameUpdate ?? {
    status: "not_ready" as const,
    requiresExplicitUserAction: true as const,
  };
  const status = items.some((item) => item.status === "blocked")
    ? "blocked"
    : projectNameConfirmation.status === "awaiting_confirmation"
      ? "awaiting_title_confirmation"
      : items.every((item) => item.status === "complete")
        ? "ready_for_explicit_project_name_action"
        : "in_progress";
  return {
    items,
    completedStageIds,
    ...(nextStageId ? { nextStageId } : {}),
    status,
    projectNameAction,
  };
}

function assessSeedConstraints(seed: ResearchDirectionSeed): ResearchDirectionLifecycleStage {
  if (seed.constraints.length === 0) {
    return stage("constraints", "needs_input", undefined, [], [], ["constraints_missing"]);
  }
  const blocked = seed.constraints.filter((constraint) => constraint.status === "blocked" && constraint.required !== false);
  const unresolved = seed.constraints.filter((constraint) => constraint.status !== "satisfied");
  return stage(
    "constraints",
    blocked.length > 0 ? "blocked" : unresolved.length > 0 ? "needs_evidence" : "complete",
    undefined,
    seed.constraints.flatMap((constraint) => constraint.cueIds),
    seed.constraints.map((constraint) => constraint.id),
    blocked.length > 0
      ? ["required_constraint_blocked"]
      : unresolved.length > 0
        ? ["constraint_unverified"]
        : [],
  );
}

function assessNovelty(
  assessment: DirectionAssessment | undefined,
  candidateId: string | undefined,
): ResearchDirectionLifecycleStage {
  if (!assessment) return stage("novelty_value_rescan", "needs_input", candidateId, [], [], ["selected_assessment_missing"]);
  return stage(
    "novelty_value_rescan",
    assessment.novelty.status === "gap_evidenced" ? "complete" : "needs_evidence",
    candidateId,
    assessment.novelty.evidenceIds,
    assessment.novelty.constraintIds,
    assessment.novelty.status === "gap_evidenced" ? [] : ["gap_evidence_missing"],
  );
}

function assessFeasibility(
  assessment: DirectionAssessment | undefined,
  candidate: DirectionAssessmentInput["candidates"][number] | undefined,
  constraints: readonly DirectionConstraint[] | undefined,
  candidateId: string | undefined,
): ResearchDirectionLifecycleStage {
  if (!assessment || !candidate || !constraints) {
    return stage("feasibility_ethics_evaluation", "needs_input", candidateId, [], [], ["selected_assessment_missing"]);
  }
  const constraintById = new Map(constraints.map((constraint) => [constraint.id, constraint]));
  const candidateConstraintIds = new Set<string>(candidate.constraintIds ?? []);
  for (const hypothesis of candidate.hypotheses ?? []) {
    if (hypothesis.evaluationConstraintId) candidateConstraintIds.add(hypothesis.evaluationConstraintId);
    for (const id of hypothesis.baselineConstraintIds ?? []) candidateConstraintIds.add(id);
  }
  const relevant = [...candidateConstraintIds]
    .map((id) => constraintById.get(id))
    .filter((constraint): constraint is DirectionConstraint => constraint !== undefined);
  const ethics = relevant.filter((constraint) => constraint.kind === "ethics");
  const evaluation = relevant.filter((constraint) => constraint.kind === "evaluation");
  const missingKinds = [
    ...(ethics.length === 0 ? ["ethics_constraint_missing"] : []),
    ...(evaluation.length === 0 ? ["evaluation_constraint_missing"] : []),
  ];
  const blocked = relevant.filter((constraint) => constraint.status === "blocked" && constraint.required !== false);
  const unresolved = relevant.filter((constraint) => constraint.status !== "satisfied");
  const evidenceIds = relevant.flatMap((constraint) => constraint.evidenceIds ?? []);
  const reasonCodes = blocked.length > 0
    ? ["required_constraint_blocked"]
    : missingKinds.length > 0
      ? missingKinds
      : unresolved.length > 0
        ? ["constraint_unverified"]
        : [];
  return stage(
    "feasibility_ethics_evaluation",
    blocked.length > 0 ? "blocked" : missingKinds.length > 0 ? "needs_input" : unresolved.length > 0 ? "needs_evidence" : "complete",
    candidateId,
    evidenceIds,
    relevant.map((constraint) => constraint.id),
    reasonCodes,
  );
}

function assessHypothesesAndContributions(
  assessment: DirectionAssessment | undefined,
  seedCandidate: ResearchDirectionSeed["candidateDirections"][number] | undefined,
  candidateId: string | undefined,
): ResearchDirectionLifecycleStage {
  if (!assessment || !seedCandidate) {
    return stage("falsifiable_hypotheses_contributions", "needs_input", candidateId, [], [], ["selected_direction_missing"]);
  }
  const readyHypotheses = assessment.falsifiableHypotheses.filter((hypothesis) => hypothesis.status === "ready");
  const blockedHypotheses = assessment.falsifiableHypotheses.filter((hypothesis) => hypothesis.status === "blocked");
  const hasContributions = seedCandidate.contributions.length > 0;
  const reasonCodes = [
    ...(readyHypotheses.length === 0 ? ["falsifiable_hypothesis_missing"] : []),
    ...(hasContributions ? [] : ["contribution_draft_missing"]),
  ];
  return stage(
    "falsifiable_hypotheses_contributions",
    blockedHypotheses.length > 0 && readyHypotheses.length === 0
      ? "blocked"
      : readyHypotheses.length > 0 && hasContributions
        ? "complete"
        : "needs_input",
    candidateId,
    assessment.falsifiableHypotheses.flatMap((hypothesis) => hypothesis.evidenceIds),
    assessment.falsifiableHypotheses.flatMap((hypothesis) => hypothesis.constraintIds),
    blockedHypotheses.length > 0 && readyHypotheses.length === 0 ? ["hypothesis_blocked"] : reasonCodes,
  );
}

function assessMinimumViability(
  assessment: DirectionAssessment | undefined,
  candidateId: string | undefined,
): ResearchDirectionLifecycleStage {
  if (!assessment) return stage("minimum_viability", "needs_input", candidateId, [], [], ["selected_assessment_missing"]);
  return stage(
    "minimum_viability",
    assessment.minimumViability.status === "viable"
      ? "complete"
      : assessment.minimumViability.status === "blocked"
        ? "blocked"
        : "needs_evidence",
    candidateId,
    assessment.minimumViability.reasons.flatMap((reason) => reason.evidenceIds),
    assessment.minimumViability.reasons.flatMap((reason) => reason.constraintIds),
    assessment.minimumViability.reasons.map((reason) => reason.code),
  );
}

function assessProvisionalTitle(
  titleConfirmation: ResearchDirectionLifecycleTitleConfirmationSnapshot | undefined,
  candidateId: string | undefined,
): ResearchDirectionLifecycleStage {
  if (!titleConfirmation) return stage("provisional_title", "needs_input", candidateId, [], [], ["title_confirmation_missing"]);
  const title = titleConfirmation.result.title;
  const complete = title.text !== undefined && (title.status === "accepted" || title.status === "downgraded");
  return stage(
    "provisional_title",
    complete ? "complete" : "needs_input",
    candidateId,
    title.evidenceIds,
    title.constraintIds,
    complete ? [] : title.reasonCodes,
  );
}

function assessProjectNameConfirmation(
  titleConfirmation: ResearchDirectionLifecycleTitleConfirmationSnapshot | undefined,
  candidateId: string | undefined,
): ResearchDirectionLifecycleStage {
  if (!titleConfirmation?.result.title.text) {
    return stage("project_name_confirmation", "not_started", candidateId, [], [], ["provisional_title_missing"]);
  }
  const confirmation = titleConfirmation.result.confirmation;
  return stage(
    "project_name_confirmation",
    confirmation.confirmed ? "complete" : "awaiting_confirmation",
    candidateId,
    titleConfirmation.result.title.evidenceIds,
    titleConfirmation.result.title.constraintIds,
    confirmation.confirmed ? [] : ["explicit_user_confirmation_required"],
  );
}

function stage(
  id: ResearchDirectionLifecycleStageId,
  status: ResearchDirectionLifecycleStageStatus,
  candidateId: string | undefined,
  evidenceIds: readonly string[],
  constraintIds: readonly string[],
  reasonCodes: readonly string[],
): ResearchDirectionLifecycleStage {
  return {
    id,
    status,
    ...(candidateId ? { candidateId } : {}),
    evidenceIds: sortedUnique(evidenceIds),
    constraintIds: sortedUnique(constraintIds),
    reasonCodes: sortedUnique(reasonCodes),
  };
}

function aggregateEvidenceIds(result: DirectionAssessmentResult): string[] {
  return result.assessments.flatMap((assessment) => assessment.score.evidenceIds);
}

function normalizeSeed(value: ResearchDirectionSeedInput | undefined): ResearchDirectionSeed {
  try {
    return normalizeResearchDirectionSeed(value as ResearchDirectionSeedInput);
  } catch (error) {
    throw lifecycleError("invalid_input", `Invalid research direction seed: ${messageOf(error)}.`, { operation: "apply_update" });
  }
}

function normalizeAssessment(value: DirectionAssessmentInput | undefined): ResearchDirectionLifecycleAssessmentSnapshot {
  try {
    return { input: value as DirectionAssessmentInput, result: assessResearchDirections(value as DirectionAssessmentInput) };
  } catch (error) {
    throw lifecycleError("invalid_input", `Invalid direction assessment: ${messageOf(error)}.`, { operation: "apply_update" });
  }
}

function normalizeTitleConfirmation(
  value: TitleConfirmationInput | undefined,
): ResearchDirectionLifecycleTitleConfirmationSnapshot {
  try {
    return { input: value as TitleConfirmationInput, result: confirmProvisionalTitle(value as TitleConfirmationInput) };
  } catch (error) {
    throw lifecycleError("invalid_input", `Invalid title confirmation: ${messageOf(error)}.`, { operation: "apply_update" });
  }
}

function normalizeSelectedDirectionId(value: string | null | undefined): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw lifecycleError("invalid_input", "selectedDirectionId must be a trimmed direction ID or null.", { operation: "apply_update" });
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 180 || normalized !== value || normalized.includes("\u0000")) {
    throw lifecycleError("invalid_input", "selectedDirectionId must be a trimmed direction ID or null.", { operation: "apply_update" });
  }
  return normalized;
}

function assertAssessmentMatchesSeed(
  assessment: ResearchDirectionLifecycleAssessmentSnapshot,
  seed: ResearchDirectionSeed,
): void {
  const seedIds = new Set(seed.candidateDirections.map((candidate) => candidate.id));
  const unmatched = assessment.result.assessments.find((candidate) => !seedIds.has(candidate.directionId));
  if (unmatched) {
    throw lifecycleError("invalid_input", `Assessment candidate is missing from the current seed: ${unmatched.directionId}.`, {
      operation: "apply_update",
    });
  }
}

function assertTitleMatchesAssessment(
  title: ResearchDirectionLifecycleTitleConfirmationSnapshot,
  selectedDirectionId: string,
  assessment: ResearchDirectionLifecycleAssessmentSnapshot,
): void {
  if (title.result.directionId !== selectedDirectionId || title.input.directionId !== selectedDirectionId) {
    throw lifecycleError("invalid_input", "Title confirmation must target the explicitly selected direction.", {
      operation: "apply_update",
    });
  }
  const assessmentEvidence = new Set((assessment.input.evidence ?? []).map((evidence) => evidence.id));
  const unknownEvidence = title.result.title.evidenceIds.find((id) => !assessmentEvidence.has(id));
  if (unknownEvidence) {
    throw lifecycleError("invalid_input", `Title confirmation references evidence outside the current assessment: ${unknownEvidence}.`, {
      operation: "apply_update",
    });
  }
}

function lifecyclePayload(state: ResearchDirectionLifecycleState): Omit<ResearchDirectionLifecycleState, "schemaVersion" | "kind" | "revision" | "createdAt" | "updatedAt" | "checklist"> {
  return {
    seedInput: state.seedInput,
    seed: state.seed,
    ...(state.assessment ? { assessment: state.assessment } : {}),
    ...(state.selectedDirectionId ? { selectedDirectionId: state.selectedDirectionId } : {}),
    ...(state.titleConfirmation ? { titleConfirmation: state.titleConfirmation } : {}),
  };
}

function resolveProjectRoot(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw lifecycleError("invalid_project_root", "A non-empty project root is required.", { operation: "resolve_paths" });
  }
  return resolve(value.trim());
}

async function assertReadableRepository(paths: ProjectResearchDirectionLifecyclePaths): Promise<boolean> {
  await assertProjectRootDirectory(paths.projectRoot);
  const hasPilotDeckDirectory = await assertExistingSafeDirectory(paths.projectRoot, paths.pilotDeckDir);
  if (!hasPilotDeckDirectory) return false;
  const hasResearchDirectory = await assertExistingSafeDirectory(paths.projectRoot, paths.researchDir);
  if (!hasResearchDirectory) return false;
  return true;
}

async function ensureRepositoryDirectories(paths: ProjectResearchDirectionLifecyclePaths): Promise<void> {
  await assertProjectRootDirectory(paths.projectRoot);
  await ensureSafeDirectory(paths.projectRoot, paths.pilotDeckDir);
  await ensureSafeDirectory(paths.projectRoot, paths.researchDir);
}

async function assertProjectRootDirectory(projectRoot: string): Promise<void> {
  const stats = await lstatIfExists(projectRoot, "validate_project_root");
  if (!stats) {
    throw lifecycleError("invalid_project_root", "The project root does not exist.", {
      path: projectRoot,
      operation: "validate_project_root",
    });
  }
  assertSafeDirectory(stats, projectRoot, "validate_project_root");
}

async function assertExistingSafeDirectory(projectRoot: string, directory: string): Promise<boolean> {
  assertWithinProject(projectRoot, directory);
  const stats = await lstatIfExists(directory, "inspect_repository");
  if (!stats) return false;
  assertSafeDirectory(stats, directory, "inspect_repository");
  return true;
}

async function ensureSafeDirectory(projectRoot: string, directory: string): Promise<void> {
  assertWithinProject(projectRoot, directory);
  const segments = relative(projectRoot, directory).split(sep).filter(Boolean);
  let current = projectRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const existing = await lstatIfExists(current, "ensure_repository");
    if (!existing) {
      try {
        await mkdir(current);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw asIoError(error, current, "ensure_repository");
      }
    }
    const verified = await lstatIfExists(current, "ensure_repository");
    if (!verified) {
      throw lifecycleError("io_error", "Lifecycle repository creation did not produce the expected directory.", {
        path: current,
        operation: "ensure_repository",
      });
    }
    assertSafeDirectory(verified, current, "ensure_repository");
  }
}

function assertSafeDirectory(stats: Stats, path: string, operation: string): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw lifecycleError("path_violation", "Research direction lifecycle paths must be real directories inside the project.", {
      path,
      operation,
    });
  }
}

async function readBoundedJson(path: string, operation: string): Promise<unknown | undefined> {
  const stats = await lstatIfExists(path, operation);
  if (!stats) return undefined;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw lifecycleError("path_violation", "Research direction lifecycle data must be a regular project-local file.", {
      path,
      operation,
    });
  }
  if (stats.size > MAX_RESEARCH_DIRECTION_LIFECYCLE_FILE_BYTES) {
    throw lifecycleError("file_too_large", "Research direction lifecycle data exceeds the configured file-size limit.", {
      path,
      operation,
    });
  }
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    throw asIoError(error, path, operation);
  }
  if (raw.byteLength > MAX_RESEARCH_DIRECTION_LIFECYCLE_FILE_BYTES) {
    throw lifecycleError("file_too_large", "Research direction lifecycle data exceeds the configured file-size limit.", {
      path,
      operation,
    });
  }
  try {
    return JSON.parse(raw.toString("utf8").replace(/^\uFEFF/u, "")) as unknown;
  } catch {
    throw lifecycleError("corrupt_json", "Research direction lifecycle data is not valid JSON.", { path, operation });
  }
}

async function writeJsonAtomically(targetPath: string, value: unknown, operation: string): Promise<void> {
  const serialized = serializeJson(value, targetPath, operation);
  const existing = await lstatIfExists(targetPath, operation);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw lifecycleError("path_violation", "Research direction lifecycle data must be a regular project-local file.", {
      path: targetPath,
      operation,
    });
  }
  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let committed = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
    committed = true;
  } catch (error) {
    if (error instanceof ResearchDirectionLifecycleRepositoryError) throw error;
    throw asIoError(error, targetPath, operation);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The original error is more useful than a best-effort close failure.
      }
    }
    if (!committed) await removeTemporaryFile(temporaryPath);
  }
}

function serializeJson(value: unknown, path: string, operation: string): Buffer {
  let text: string;
  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    throw lifecycleError("invalid_schema", "Research direction lifecycle data cannot be serialized as JSON.", { path, operation });
  }
  const serialized = Buffer.from(text, "utf8");
  if (serialized.byteLength > MAX_RESEARCH_DIRECTION_LIFECYCLE_FILE_BYTES) {
    throw lifecycleError("file_too_large", "Research direction lifecycle data exceeds the configured file-size limit.", {
      path,
      operation,
    });
  }
  return serialized;
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      // A randomized temp file cannot overwrite lifecycle data; retaining it is safer than an unbounded cleanup path.
    }
  }
}

function validateLifecycleDocument(value: unknown, path: string): ResearchDirectionLifecycleState {
  const document = expectRecord(value, "research direction lifecycle", path);
  if (document.schemaVersion !== RESEARCH_DIRECTION_LIFECYCLE_SCHEMA_VERSION || document.kind !== "research_direction_lifecycle") {
    invalidSchema(path, "Unsupported research direction lifecycle document schema.");
  }
  const revision = expectPositiveInteger(document.revision, "revision", path);
  const createdAt = expectTimestamp(document.createdAt, "createdAt", path);
  const updatedAt = expectTimestamp(document.updatedAt, "updatedAt", path);
  const seedInput = document.seedInput as ResearchDirectionSeedInput;
  const seed = validateStoredSeed(seedInput, document.seed, path);
  const assessment = document.assessment === undefined ? undefined : validateStoredAssessment(document.assessment, path);
  const selectedDirectionId = document.selectedDirectionId === undefined
    ? undefined
    : expectIdentifier(document.selectedDirectionId, "selectedDirectionId", path);
  const titleConfirmation = document.titleConfirmation === undefined
    ? undefined
    : validateStoredTitleConfirmation(document.titleConfirmation, path);
  const base = {
    schemaVersion: RESEARCH_DIRECTION_LIFECYCLE_SCHEMA_VERSION,
    kind: "research_direction_lifecycle" as const,
    revision,
    createdAt,
    updatedAt,
    seedInput,
    seed,
    ...(assessment ? { assessment } : {}),
    ...(selectedDirectionId ? { selectedDirectionId } : {}),
    ...(titleConfirmation ? { titleConfirmation } : {}),
  };
  try {
    if (assessment) assertAssessmentMatchesSeed(assessment, seed);
    if (selectedDirectionId && !seed.candidateDirections.some((candidate) => candidate.id === selectedDirectionId)) {
      invalidSchema(path, `Selected direction is missing from the seed: ${selectedDirectionId}.`);
    }
    if (assessment && selectedDirectionId && !assessment.result.assessments.some((candidate) => candidate.directionId === selectedDirectionId)) {
      invalidSchema(path, `Selected direction is missing from the assessment: ${selectedDirectionId}.`);
    }
    if (titleConfirmation) {
      if (!assessment || !selectedDirectionId) invalidSchema(path, "Title confirmation requires an assessment and selected direction.");
      assertTitleMatchesAssessment(titleConfirmation, selectedDirectionId, assessment);
    }
  } catch (error) {
    if (error instanceof ResearchDirectionLifecycleRepositoryError) {
      invalidSchema(path, error.message);
    }
    throw error;
  }
  const checklist = buildResearchDirectionLifecycleChecklist(base);
  if (!sameJson(document.checklist, checklist)) {
    invalidSchema(path, "Persisted lifecycle checklist does not match its traceable source artifacts.");
  }
  return { ...base, checklist };
}

function validateStoredSeed(input: ResearchDirectionSeedInput, value: unknown, path: string): ResearchDirectionSeed {
  try {
    const seed = normalizeResearchDirectionSeed(input);
    if (!sameJson(seed, value)) invalidSchema(path, "Persisted research direction seed is not canonical.");
    return seed;
  } catch (error) {
    if (error instanceof ResearchDirectionLifecycleRepositoryError) throw error;
    invalidSchema(path, `Invalid persisted research direction seed: ${messageOf(error)}.`);
  }
}

function validateStoredAssessment(value: unknown, path: string): ResearchDirectionLifecycleAssessmentSnapshot {
  const snapshot = expectRecord(value, "assessment", path);
  try {
    const input = snapshot.input as DirectionAssessmentInput;
    const result = assessResearchDirections(input);
    if (!sameJson(snapshot.result, result)) invalidSchema(path, "Persisted direction assessment result does not match its input.");
    return { input, result };
  } catch (error) {
    if (error instanceof ResearchDirectionLifecycleRepositoryError) throw error;
    invalidSchema(path, `Invalid persisted direction assessment: ${messageOf(error)}.`);
  }
}

function validateStoredTitleConfirmation(
  value: unknown,
  path: string,
): ResearchDirectionLifecycleTitleConfirmationSnapshot {
  const snapshot = expectRecord(value, "titleConfirmation", path);
  try {
    const input = snapshot.input as TitleConfirmationInput;
    const result = confirmProvisionalTitle(input);
    if (!sameJson(snapshot.result, result)) invalidSchema(path, "Persisted title confirmation result does not match its input.");
    return { input, result };
  } catch (error) {
    if (error instanceof ResearchDirectionLifecycleRepositoryError) throw error;
    invalidSchema(path, `Invalid persisted title confirmation: ${messageOf(error)}.`);
  }
}

async function lstatIfExists(path: string, operation: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw asIoError(error, path, operation);
  }
}

function assertExpectedRevision(actual: number, expected: number | undefined, path: string): void {
  if (expected === undefined) return;
  if (!Number.isInteger(expected) || expected < 0) {
    throw lifecycleError("invalid_input", "expectedRevision must be a non-negative integer.", {
      path,
      operation: "update_lifecycle",
    });
  }
  if (expected !== actual) {
    throw lifecycleError("revision_conflict", `Expected lifecycle revision ${expected}, found ${actual}.`, {
      path,
      operation: "update_lifecycle",
    });
  }
}

function expectRecord(value: unknown, location: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidSchema(path, `${location} must be an object.`);
  return value as Record<string, unknown>;
}

function expectIdentifier(value: unknown, location: string, path: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 180 || value.includes("\u0000")) {
    invalidSchema(path, `${location} must be a trimmed non-empty identifier.`);
  }
  return value;
}

function expectPositiveInteger(value: unknown, location: string, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) invalidSchema(path, `${location} must be a positive integer.`);
  return value as number;
}

function expectTimestamp(value: unknown, location: string, path: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) invalidSchema(path, `${location} must be an ISO timestamp.`);
  return value;
}

function invalidSchema(path: string, message: string): never {
  throw lifecycleError("invalid_schema", message, { path, operation: "validate" });
}

function assertWithinProject(projectRoot: string, candidate: string): void {
  const relativePath = relative(projectRoot, candidate);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) return;
  throw lifecycleError("path_violation", "Research direction lifecycle paths must stay inside the project root.", {
    path: candidate,
    operation: "resolve_paths",
  });
}

function nowIso(value: Date | undefined): string {
  const date = value ?? new Date();
  if (Number.isNaN(date.valueOf())) {
    throw lifecycleError("invalid_input", "now must be a valid Date.", { operation: "apply_update" });
  }
  return date.toISOString();
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && (value as NodeJS.ErrnoException).code === code;
}

function asIoError(error: unknown, path: string, operation: string): ResearchDirectionLifecycleRepositoryError {
  return lifecycleError("io_error", `Research direction lifecycle storage failed: ${messageOf(error)}.`, { path, operation });
}

function lifecycleError(
  code: ResearchDirectionLifecycleRepositoryErrorCode,
  message: string,
  context: Omit<ResearchDirectionLifecycleRepositoryDiagnostic, "code" | "message"> = {},
): ResearchDirectionLifecycleRepositoryError {
  return new ResearchDirectionLifecycleRepositoryError(code, message, context);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
