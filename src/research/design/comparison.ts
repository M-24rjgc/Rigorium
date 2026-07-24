import type { CandidatePortfolioArtifact, EvidenceCitation } from "./contracts.js";

export type ComparisonDirection = "maximize" | "minimize";

export type ComparisonObjective = Readonly<{
  id: string;
  label: string;
  weight: number;
  direction: ComparisonDirection;
  description: string;
}>;

export type CandidateObjectiveAssessment = Readonly<{
  candidateId: string;
  objectiveId: string;
  score: number;
  rationale: string;
  evidenceIds: readonly string[];
}>;

export type CandidateComparisonRow = Readonly<{
  candidateId: string;
  normalizedScores: Readonly<Record<string, number>>;
  weightedScore: number;
  paretoDominatedBy: readonly string[];
  rank: number;
}>;

export type MultiObjectiveComparison = Readonly<{
  objectives: readonly ComparisonObjective[];
  assessments: readonly CandidateObjectiveAssessment[];
  rows: readonly CandidateComparisonRow[];
  rankedCandidateIds: readonly string[];
  paretoFrontierCandidateIds: readonly string[];
}>;

export type EliminationRecord = Readonly<{
  id: string;
  candidateId: string;
  outcome: "eliminated" | "retained" | "deferred";
  reasonCodes: readonly (
    | "dominated"
    | "constraint_blocked"
    | "contradicted"
    | "insufficient_evidence"
    | "ethics_unresolved"
    | "compute_infeasible"
    | "user_choice"
  )[];
  rationale: string;
  evidenceIds: readonly string[];
  reversible: boolean;
}>;

export function compareResearchCandidates(input: {
  portfolio: CandidatePortfolioArtifact;
  objectives: readonly ComparisonObjective[];
  assessments: readonly CandidateObjectiveAssessment[];
}): MultiObjectiveComparison {
  const candidateIds = new Set(input.portfolio.payload.candidates.map((candidate) => candidate.id));
  const citationIds = new Set(input.portfolio.payload.evidence.citations.map((citation) => citation.id));
  const objectives = normalizeObjectives(input.objectives);
  const objectiveIds = new Set(objectives.map((objective) => objective.id));
  const assessments = normalizeAssessments(input.assessments, candidateIds, objectiveIds, citationIds);
  const byPair = new Map(assessments.map((assessment) => [pairKey(assessment.candidateId, assessment.objectiveId), assessment]));

  for (const candidateId of candidateIds) {
    for (const objectiveId of objectiveIds) {
      if (!byPair.has(pairKey(candidateId, objectiveId))) {
        throw new TypeError(`Missing comparison score for candidate ${candidateId} and objective ${objectiveId}.`);
      }
    }
  }

  const normalizedByCandidate = new Map<string, Record<string, number>>();
  for (const candidateId of candidateIds) normalizedByCandidate.set(candidateId, {});
  for (const objective of objectives) {
    const values = [...candidateIds].map((candidateId) => byPair.get(pairKey(candidateId, objective.id))!.score);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    for (const candidateId of candidateIds) {
      const raw = byPair.get(pairKey(candidateId, objective.id))!.score;
      const ascending = maximum === minimum ? 1 : (raw - minimum) / (maximum - minimum);
      normalizedByCandidate.get(candidateId)![objective.id] = objective.direction === "maximize" ? ascending : 1 - ascending;
    }
  }

  const unranked = [...candidateIds].map((candidateId) => {
    const normalizedScores = normalizedByCandidate.get(candidateId)!;
    const weightedScore = objectives.reduce((total, objective) => total + normalizedScores[objective.id]! * objective.weight, 0);
    const paretoDominatedBy = [...candidateIds]
      .filter((otherId) => otherId !== candidateId && dominates(normalizedByCandidate.get(otherId)!, normalizedScores, objectives))
      .sort(compareText);
    return { candidateId, normalizedScores, weightedScore, paretoDominatedBy };
  });
  unranked.sort((left, right) => right.weightedScore - left.weightedScore || compareText(left.candidateId, right.candidateId));
  const rows = unranked.map((row, index) => Object.freeze({ ...row, weightedScore: roundScore(row.weightedScore), rank: index + 1 }));
  return Object.freeze({
    objectives: Object.freeze(objectives),
    assessments: Object.freeze(assessments),
    rows: Object.freeze(rows),
    rankedCandidateIds: Object.freeze(rows.map((row) => row.candidateId)),
    paretoFrontierCandidateIds: Object.freeze(rows.filter((row) => row.paretoDominatedBy.length === 0).map((row) => row.candidateId)),
  });
}

export function normalizeEliminationRecords(input: {
  portfolio: CandidatePortfolioArtifact;
  comparison: MultiObjectiveComparison;
  records: readonly EliminationRecord[];
}): readonly EliminationRecord[] {
  const candidateIds = new Set(input.portfolio.payload.candidates.map((candidate) => candidate.id));
  const evidenceIds = new Set(input.portfolio.payload.evidence.citations.map((citation) => citation.id));
  const ids = new Set<string>();
  const records = input.records.map((record, index) => {
    const label = `eliminations[${index}]`;
    const id = identifier(record.id, `${label}.id`);
    if (ids.has(id)) throw new TypeError(`Elimination record ${id} is duplicated.`);
    ids.add(id);
    const candidateId = identifier(record.candidateId, `${label}.candidateId`);
    if (!candidateIds.has(candidateId)) throw new TypeError(`${label} references an unknown candidate.`);
    if (!["eliminated", "retained", "deferred"].includes(record.outcome)) throw new TypeError(`${label}.outcome is invalid.`);
    const reasonCodes = unique(record.reasonCodes, `${label}.reasonCodes`);
    const normalizedEvidenceIds = unique(record.evidenceIds, `${label}.evidenceIds`);
    for (const evidenceId of normalizedEvidenceIds) {
      if (!evidenceIds.has(evidenceId)) throw new TypeError(`${label} references unknown evidence ${evidenceId}.`);
    }
    if (record.outcome === "eliminated" && reasonCodes.length === 0) throw new TypeError(`${label} requires at least one reason code.`);
    if (reasonCodes.includes("dominated")) {
      const row = input.comparison.rows.find((candidate) => candidate.candidateId === candidateId);
      if (!row || row.paretoDominatedBy.length === 0) throw new TypeError(`${label} cannot claim domination for a Pareto-frontier candidate.`);
    }
    return Object.freeze({
      id,
      candidateId,
      outcome: record.outcome,
      reasonCodes,
      rationale: text(record.rationale, `${label}.rationale`, 8_000),
      evidenceIds: normalizedEvidenceIds,
      reversible: record.reversible !== false,
    });
  });

  const byCandidate = new Map<string, EliminationRecord>();
  for (const record of records) {
    if (byCandidate.has(record.candidateId)) throw new TypeError(`Candidate ${record.candidateId} has multiple elimination outcomes.`);
    byCandidate.set(record.candidateId, record);
  }
  return Object.freeze(records);
}

function normalizeObjectives(values: readonly ComparisonObjective[]): ComparisonObjective[] {
  if (!Array.isArray(values) || values.length < 2 || values.length > 16) {
    throw new TypeError("Multi-objective comparison requires between two and sixteen objectives.");
  }
  const ids = new Set<string>();
  const objectives = values.map((value, index) => {
    const label = `objectives[${index}]`;
    const id = identifier(value.id, `${label}.id`);
    if (ids.has(id)) throw new TypeError(`Comparison objective ${id} is duplicated.`);
    ids.add(id);
    if (!Number.isFinite(value.weight) || value.weight <= 0) throw new TypeError(`${label}.weight must be positive.`);
    if (value.direction !== "maximize" && value.direction !== "minimize") throw new TypeError(`${label}.direction is invalid.`);
    return Object.freeze({
      id,
      label: text(value.label, `${label}.label`, 1_000),
      weight: value.weight,
      direction: value.direction,
      description: text(value.description, `${label}.description`, 4_000),
    });
  });
  const totalWeight = objectives.reduce((total, objective) => total + objective.weight, 0);
  return objectives.map((objective) => Object.freeze({ ...objective, weight: objective.weight / totalWeight }));
}

function normalizeAssessments(
  values: readonly CandidateObjectiveAssessment[],
  candidateIds: ReadonlySet<string>,
  objectiveIds: ReadonlySet<string>,
  citationIds: ReadonlySet<string>,
): CandidateObjectiveAssessment[] {
  const pairs = new Set<string>();
  return values.map((value, index) => {
    const label = `assessments[${index}]`;
    const candidateId = identifier(value.candidateId, `${label}.candidateId`);
    const objectiveId = identifier(value.objectiveId, `${label}.objectiveId`);
    if (!candidateIds.has(candidateId)) throw new TypeError(`${label} references an unknown candidate.`);
    if (!objectiveIds.has(objectiveId)) throw new TypeError(`${label} references an unknown objective.`);
    const key = pairKey(candidateId, objectiveId);
    if (pairs.has(key)) throw new TypeError(`Comparison score ${key} is duplicated.`);
    pairs.add(key);
    if (!Number.isFinite(value.score)) throw new TypeError(`${label}.score must be finite.`);
    const evidenceIds = unique(value.evidenceIds, `${label}.evidenceIds`);
    for (const evidenceId of evidenceIds) {
      if (!citationIds.has(evidenceId)) throw new TypeError(`${label} references unknown evidence ${evidenceId}.`);
    }
    return Object.freeze({ candidateId, objectiveId, score: value.score, rationale: text(value.rationale, `${label}.rationale`, 4_000), evidenceIds });
  });
}

function dominates(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
  objectives: readonly ComparisonObjective[],
): boolean {
  return objectives.every((objective) => left[objective.id]! >= right[objective.id]!)
    && objectives.some((objective) => left[objective.id]! > right[objective.id]!);
}

function pairKey(candidateId: string, objectiveId: string): string {
  return `${candidateId}:${objectiveId}`;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256 || value.includes("\u0000")) {
    throw new TypeError(`${label} must be a trimmed non-empty identifier.`);
  }
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\u0000")) {
    throw new TypeError(`${label} must be bounded non-empty text.`);
  }
  return value;
}

function unique<T extends string>(values: readonly T[], label: string): T[] {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array.`);
  const result = values.map((value, index) => identifier(value, `${label}[${index}]`) as T);
  if (new Set(result).size !== result.length) throw new TypeError(`${label} must not contain duplicates.`);
  return result;
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

export function evidenceById(citations: readonly EvidenceCitation[]): ReadonlyMap<string, EvidenceCitation> {
  return new Map(citations.map((citation) => [citation.id, citation]));
}
