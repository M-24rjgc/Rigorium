import type {
  DirectionConstraintKind,
  DirectionConstraintStatus,
} from "./directionAssessment.js";

/**
 * A small, traceable hand-off from an agent's natural-language understanding
 * to the existing evidence-backed direction assessment. It is not a workflow
 * state machine and it never creates or renames a Project.
 */
export const RESEARCH_DIRECTION_SEED_LIMITS = {
  maxCues: 24,
  maxTerminology: 48,
  maxConstraints: 32,
  maxCandidates: 12,
  maxTerminologyPerCandidate: 16,
  maxConstraintsPerCandidate: 16,
  maxHypothesesPerCandidate: 8,
  maxContributionsPerCandidate: 8,
  maxTextLength: 1_000,
  maxTitleLength: 180,
  maxIdentifierLength: 180,
  maxSourceReferenceLength: 2_000,
} as const;

export type ResearchCueKind =
  | "interest"
  | "question"
  | "paper"
  | "algorithm"
  | "data"
  | "experiment_observation";

/** A bounded piece of the user's starting context, preserved verbatim after whitespace normalization. */
export type ResearchCue = Readonly<{
  id: string;
  kind: ResearchCueKind;
  text: string;
  /** Optional local identifier, DOI, URL, or filename; this module never resolves it. */
  sourceReference?: string;
}>;

/** A term selected or inferred by the agent, always linked back to its input cues. */
export type ResearchDirectionTerminology = Readonly<{
  id: string;
  text: string;
  cueIds: readonly string[];
  status?: "observed" | "inferred";
}>;

/** A feasibility fact or unknown retained at cue level before direction assessment has paper evidence. */
export type ResearchDirectionConstraint = Readonly<{
  id: string;
  kind: DirectionConstraintKind;
  label: string;
  status: DirectionConstraintStatus;
  required?: boolean;
  cueIds: readonly string[];
}>;

export type ResearchDirectionHypothesisDraft = Readonly<{
  id: string;
  statement: string;
  cueIds: readonly string[];
  terminologyIds?: readonly string[];
  constraintIds?: readonly string[];
}>;

export type ResearchDirectionContributionDraft = Readonly<{
  id: string;
  statement: string;
  cueIds: readonly string[];
  terminologyIds?: readonly string[];
  constraintIds?: readonly string[];
}>;

export type ResearchDirectionCandidateInput = Readonly<{
  id: string;
  summary: string;
  cueIds: readonly string[];
  terminologyIds?: readonly string[];
  constraintIds?: readonly string[];
  hypotheses?: readonly ResearchDirectionHypothesisDraft[];
  contributions?: readonly ResearchDirectionContributionDraft[];
  /** Agent-proposed wording. When absent, the summary provides a visibly provisional fallback. */
  titleSeed?: string;
  /** Neutral replacement for an overcommitting title seed. */
  neutralTitle?: string;
}>;

export type ResearchDirectionSeedInput = Readonly<{
  cues: readonly ResearchCue[];
  terminology?: readonly ResearchDirectionTerminology[];
  constraints?: readonly ResearchDirectionConstraint[];
  candidates: readonly ResearchDirectionCandidateInput[];
}>;

export type PendingResearchDirectionTitle = Readonly<{
  status: "proposed" | "downgraded" | "rejected";
  text?: string;
  origin: "agent_seed" | "summary_fallback";
  reasonCodes: Array<"provisional" | "summary_fallback" | "overcommitting_claim" | "sensitive_content">;
  cueIds: string[];
  terminologyIds: string[];
  constraintIds: string[];
  confirmation: Readonly<{
    status: "pending";
    confirmed: false;
    requiresExplicitUserAction: true;
    /** This seed has no authority to rename a Project. */
    projectNameUpdate: Readonly<{
      status: "not_ready";
      requiresExplicitUserAction: true;
    }>;
  }>;
}>;

export type NormalizedResearchDirectionCandidate = Readonly<{
  id: string;
  summary: string;
  cueIds: string[];
  terminologyIds: string[];
  constraintIds: string[];
  hypotheses: ResearchDirectionHypothesisDraft[];
  contributions: ResearchDirectionContributionDraft[];
  provisionalTitle: PendingResearchDirectionTitle;
}>;

export type ResearchDirectionConstraintCoverage = Readonly<{
  status: "not_provided" | "unresolved" | "specified";
  suppliedConstraintIds: string[];
  unresolvedConstraintIds: string[];
}>;

export type ResearchDirectionSeed = Readonly<{
  cues: ResearchCue[];
  terminology: ResearchDirectionTerminology[];
  constraints: ResearchDirectionConstraint[];
  constraintCoverage: ResearchDirectionConstraintCoverage;
  candidateDirections: NormalizedResearchDirectionCandidate[];
}>;

const CUE_KINDS = new Set<ResearchCueKind>([
  "interest",
  "question",
  "paper",
  "algorithm",
  "data",
  "experiment_observation",
]);
const CONSTRAINT_KINDS = new Set<DirectionConstraintKind>([
  "venue",
  "time",
  "data",
  "compute",
  "ethics",
  "baseline",
  "evaluation",
]);
const CONSTRAINT_STATUSES = new Set<DirectionConstraintStatus>(["satisfied", "unknown", "blocked"]);
const TITLE_PREFIX = "Provisional: ";
const OVERCOMMITTING_TITLE = /\b(?:always|never|proves?|guarantees?|guaranteed|optimal|state[- ]of[- ]the[- ]art|sota|breakthrough|solves?|causal|first|novel|unprecedented|definitive|best|superior|outperform(?:s|ing|ed)?)\b|\u9996\u4e2a|\u9996\u6b21|\u7a81\u7834|\u6700\u4f18|\u9886\u5148|\u65b0\u9896/iu;
const SENSITIVE_TITLE_MARKER = /(?:api[_-]?key|access[_-]?token|bearer\s+|password\s*=|secret\s*=)/iu;

/**
 * Validates and canonicalizes an agent-selected research seed. Every derived
 * record keeps the source cue IDs that justified it; no literature evidence,
 * feasibility defaults, Project mutation, or research workflow is inferred.
 */
export function normalizeResearchDirectionSeed(input: ResearchDirectionSeedInput): ResearchDirectionSeed {
  if (!input || typeof input !== "object") throw new Error("Research direction seed input must be an object.");
  const rawCues = requiredArray(input.cues, "cues");
  const rawTerminology = optionalArray(input.terminology, "terminology");
  const rawConstraints = optionalArray(input.constraints, "constraints");
  const rawCandidates = requiredArray(input.candidates, "candidates");
  assertCount(rawCues, RESEARCH_DIRECTION_SEED_LIMITS.maxCues, "cues");
  assertCount(rawTerminology, RESEARCH_DIRECTION_SEED_LIMITS.maxTerminology, "terminology");
  assertCount(rawConstraints, RESEARCH_DIRECTION_SEED_LIMITS.maxConstraints, "constraints");
  assertCount(rawCandidates, RESEARCH_DIRECTION_SEED_LIMITS.maxCandidates, "candidates");
  if (rawCues.length === 0) throw new Error("Research direction seed requires at least one cue.");
  if (rawCandidates.length === 0) throw new Error("Research direction seed requires at least one candidate.");

  const cues = rawCues.map(normalizeCue);
  const cueById = uniqueMap(cues, "cue");
  const terminology = rawTerminology.map((term) => normalizeTerminology(term, cueById));
  const terminologyById = uniqueMap(terminology, "terminology");
  const constraints = rawConstraints.map((constraint) => normalizeConstraint(constraint, cueById));
  const constraintsById = uniqueMap(constraints, "constraint");
  const candidateDirections = rawCandidates.map((candidate) => normalizeCandidate(candidate, {
    cueById,
    terminologyById,
    constraintsById,
  }));
  uniqueMap(candidateDirections, "candidate direction");

  const sortedConstraints = sortById(constraints);
  return {
    cues: sortById(cues),
    terminology: sortById(terminology),
    constraints: sortedConstraints,
    constraintCoverage: constraintCoverage(sortedConstraints),
    candidateDirections: sortById(candidateDirections),
  };
}

function normalizeCue(value: ResearchCue): ResearchCue {
  assertRecord(value, "cue");
  const id = identifier(value.id, "cue ID");
  if (!CUE_KINDS.has(value.kind)) throw new Error(`Unsupported cue kind for ${id}.`);
  const sourceReference = optionalText(value.sourceReference, "cue sourceReference", RESEARCH_DIRECTION_SEED_LIMITS.maxSourceReferenceLength);
  return {
    id,
    kind: value.kind,
    text: text(value.text, `cue ${id} text`, RESEARCH_DIRECTION_SEED_LIMITS.maxTextLength),
    ...(sourceReference ? { sourceReference } : {}),
  };
}

function normalizeTerminology(
  value: ResearchDirectionTerminology,
  cues: ReadonlyMap<string, ResearchCue>,
): ResearchDirectionTerminology {
  assertRecord(value, "terminology");
  const id = identifier(value.id, "terminology ID");
  if (value.status !== undefined && value.status !== "observed" && value.status !== "inferred") {
    throw new Error(`Unsupported terminology status for ${id}.`);
  }
  return {
    id,
    text: text(value.text, `terminology ${id} text`, RESEARCH_DIRECTION_SEED_LIMITS.maxTextLength),
    cueIds: references(value.cueIds, `terminology ${id} cue IDs`, cues, RESEARCH_DIRECTION_SEED_LIMITS.maxCues),
    ...(value.status ? { status: value.status } : {}),
  };
}

function normalizeConstraint(
  value: ResearchDirectionConstraint,
  cues: ReadonlyMap<string, ResearchCue>,
): ResearchDirectionConstraint {
  assertRecord(value, "constraint");
  const id = identifier(value.id, "constraint ID");
  if (!CONSTRAINT_KINDS.has(value.kind)) throw new Error(`Unsupported constraint kind for ${id}.`);
  if (!CONSTRAINT_STATUSES.has(value.status)) throw new Error(`Unsupported constraint status for ${id}.`);
  return {
    id,
    kind: value.kind,
    label: text(value.label, `constraint ${id} label`, RESEARCH_DIRECTION_SEED_LIMITS.maxTextLength),
    status: value.status,
    ...(value.required === undefined ? {} : { required: value.required }),
    cueIds: references(value.cueIds, `constraint ${id} cue IDs`, cues, RESEARCH_DIRECTION_SEED_LIMITS.maxCues),
  };
}

function normalizeCandidate(
  value: ResearchDirectionCandidateInput,
  lookup: Readonly<{
    cueById: ReadonlyMap<string, ResearchCue>;
    terminologyById: ReadonlyMap<string, ResearchDirectionTerminology>;
    constraintsById: ReadonlyMap<string, ResearchDirectionConstraint>;
  }>,
): NormalizedResearchDirectionCandidate {
  assertRecord(value, "candidate direction");
  const id = identifier(value.id, "candidate direction ID");
  const cueIds = references(value.cueIds, `candidate ${id} cue IDs`, lookup.cueById, RESEARCH_DIRECTION_SEED_LIMITS.maxCues);
  const terminologyIds = optionalReferences(
    value.terminologyIds,
    `candidate ${id} terminology IDs`,
    lookup.terminologyById,
    RESEARCH_DIRECTION_SEED_LIMITS.maxTerminologyPerCandidate,
  );
  const constraintIds = optionalReferences(
    value.constraintIds,
    `candidate ${id} constraint IDs`,
    lookup.constraintsById,
    RESEARCH_DIRECTION_SEED_LIMITS.maxConstraintsPerCandidate,
  );
  const hypotheses = optionalArray(value.hypotheses, `candidate ${id} hypotheses`);
  const contributions = optionalArray(value.contributions, `candidate ${id} contributions`);
  assertCount(hypotheses, RESEARCH_DIRECTION_SEED_LIMITS.maxHypothesesPerCandidate, `candidate ${id} hypotheses`);
  assertCount(contributions, RESEARCH_DIRECTION_SEED_LIMITS.maxContributionsPerCandidate, `candidate ${id} contributions`);
  const normalizedHypotheses = hypotheses.map((draft) => normalizeDraft(draft, "hypothesis", lookup));
  const normalizedContributions = contributions.map((draft) => normalizeDraft(draft, "contribution", lookup));
  uniqueMap(normalizedHypotheses, `candidate ${id} hypothesis`);
  uniqueMap(normalizedContributions, `candidate ${id} contribution`);
  const summary = text(value.summary, `candidate ${id} summary`, RESEARCH_DIRECTION_SEED_LIMITS.maxTextLength);

  return {
    id,
    summary,
    cueIds,
    terminologyIds,
    constraintIds,
    hypotheses: sortById(normalizedHypotheses),
    contributions: sortById(normalizedContributions),
    provisionalTitle: pendingTitle({
      candidate: value,
      summary,
      cueIds,
      terminologyIds,
      constraintIds,
    }),
  };
}

function normalizeDraft(
  value: ResearchDirectionHypothesisDraft | ResearchDirectionContributionDraft,
  label: "hypothesis" | "contribution",
  lookup: Readonly<{
    cueById: ReadonlyMap<string, ResearchCue>;
    terminologyById: ReadonlyMap<string, ResearchDirectionTerminology>;
    constraintsById: ReadonlyMap<string, ResearchDirectionConstraint>;
  }>,
): ResearchDirectionHypothesisDraft | ResearchDirectionContributionDraft {
  assertRecord(value, label);
  const id = identifier(value.id, `${label} ID`);
  return {
    id,
    statement: text(value.statement, `${label} ${id} statement`, RESEARCH_DIRECTION_SEED_LIMITS.maxTextLength),
    cueIds: references(value.cueIds, `${label} ${id} cue IDs`, lookup.cueById, RESEARCH_DIRECTION_SEED_LIMITS.maxCues),
    terminologyIds: optionalReferences(
      value.terminologyIds,
      `${label} ${id} terminology IDs`,
      lookup.terminologyById,
      RESEARCH_DIRECTION_SEED_LIMITS.maxTerminologyPerCandidate,
    ),
    constraintIds: optionalReferences(
      value.constraintIds,
      `${label} ${id} constraint IDs`,
      lookup.constraintsById,
      RESEARCH_DIRECTION_SEED_LIMITS.maxConstraintsPerCandidate,
    ),
  };
}

function pendingTitle(input: Readonly<{
  candidate: ResearchDirectionCandidateInput;
  summary: string;
  cueIds: string[];
  terminologyIds: string[];
  constraintIds: string[];
}>): PendingResearchDirectionTitle {
  const origin: PendingResearchDirectionTitle["origin"] = input.candidate.titleSeed === undefined
    ? "summary_fallback"
    : "agent_seed";
  const rawTitle = origin === "agent_seed"
    ? text(input.candidate.titleSeed, "candidate titleSeed", titleInputLength())
    : truncateTitle(input.summary);
  const neutralTitle = input.candidate.neutralTitle === undefined
    ? undefined
    : text(input.candidate.neutralTitle, "candidate neutralTitle", titleInputLength());
  const base = {
    origin,
    cueIds: input.cueIds,
    terminologyIds: input.terminologyIds,
    constraintIds: input.constraintIds,
    confirmation: {
      status: "pending" as const,
      confirmed: false as const,
      requiresExplicitUserAction: true as const,
      projectNameUpdate: {
        status: "not_ready" as const,
        requiresExplicitUserAction: true as const,
      },
    },
  };
  const fallbackReason = origin === "summary_fallback" ? ["summary_fallback" as const] : [];
  if (SENSITIVE_TITLE_MARKER.test(rawTitle)) {
    return { ...base, status: "rejected", reasonCodes: ["provisional", "sensitive_content", ...fallbackReason] };
  }
  if (OVERCOMMITTING_TITLE.test(rawTitle)) {
    if (!neutralTitle || SENSITIVE_TITLE_MARKER.test(neutralTitle) || OVERCOMMITTING_TITLE.test(neutralTitle)) {
      return { ...base, status: "rejected", reasonCodes: ["provisional", "overcommitting_claim", ...fallbackReason] };
    }
    return {
      ...base,
      status: "downgraded",
      text: withProvisionalPrefix(neutralTitle),
      reasonCodes: ["provisional", "overcommitting_claim", ...fallbackReason],
    };
  }
  return {
    ...base,
    status: "proposed",
    text: withProvisionalPrefix(rawTitle),
    reasonCodes: ["provisional", ...fallbackReason],
  };
}

function constraintCoverage(constraints: readonly ResearchDirectionConstraint[]): ResearchDirectionConstraintCoverage {
  const suppliedConstraintIds = constraints.map((item) => item.id);
  const unresolvedConstraintIds = constraints
    .filter((item) => item.status !== "satisfied")
    .map((item) => item.id);
  return {
    status: constraints.length === 0 ? "not_provided" : unresolvedConstraintIds.length > 0 ? "unresolved" : "specified",
    suppliedConstraintIds,
    unresolvedConstraintIds,
  };
}

function references<T>(
  value: readonly string[],
  label: string,
  records: ReadonlyMap<string, T>,
  maximum: number,
): string[] {
  const ids = requiredArray(value, label);
  assertCount(ids, maximum, label);
  if (ids.length === 0) throw new Error(`${label} must contain at least one reference.`);
  return uniqueSorted(ids.map((id) => {
    const normalized = identifier(id, label);
    if (!records.has(normalized)) throw new Error(`Unknown ${label.slice(0, -1)}: ${normalized}.`);
    return normalized;
  }));
}

function optionalReferences<T>(
  value: readonly string[] | undefined,
  label: string,
  records: ReadonlyMap<string, T>,
  maximum: number,
): string[] {
  return value === undefined ? [] : references(value, label, records, maximum);
}

function requiredArray<T>(value: readonly T[], label: string): readonly T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function optionalArray<T>(value: readonly T[] | undefined, label: string): readonly T[] {
  return value === undefined ? [] : requiredArray(value, label);
}

function uniqueMap<T extends { id: string }>(items: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.id)) throw new Error(`Duplicate ${label} ID: ${item.id}.`);
    result.set(item.id, item);
  }
  return result;
}

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => compareText(left.id, right.id));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function assertCount(values: readonly unknown[], maximum: number, label: string): void {
  if (values.length > maximum) throw new Error(`${label} exceeds the maximum of ${maximum}.`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > RESEARCH_DIRECTION_SEED_LIMITS.maxIdentifierLength) {
    throw new Error(`${label} must be a trimmed non-empty string no longer than ${RESEARCH_DIRECTION_SEED_LIMITS.maxIdentifierLength} characters.`);
  }
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(normalized)) {
    throw new Error(`${label} must be a bounded, printable string.`);
  }
  return normalized;
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : text(value, label, maximum);
}

function titleInputLength(): number {
  return RESEARCH_DIRECTION_SEED_LIMITS.maxTitleLength - TITLE_PREFIX.length;
}

function truncateTitle(value: string): string {
  const maximum = titleInputLength();
  return value.length <= maximum ? value : value.slice(0, maximum).trimEnd();
}

function withProvisionalPrefix(value: string): string {
  return `${TITLE_PREFIX}${value.replace(/^provisional:\s*/iu, "")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
