import {
  RESEARCH_ARTIFACT_KINDS,
  canonicalJson,
  hashResearchArtifactContent,
  toResearchArtifactRef,
  type ResearchArtifactEnvelope,
  type ResearchArtifactProducer,
  type ResearchArtifactRef,
} from "../../artifacts/index.js";
import {
  EXECUTION_GRANT_MODES,
  EXPERIMENT_ADAPTER_IDS,
  EXPERIMENT_FAILURE_CATEGORIES,
  EXPERIMENT_RUN_STATUSES,
  type BaselineObservation,
  type MetricObservation,
  type RunAttempt,
} from "../contracts.js";
import type {
  AblationFactorSpec,
  AnalysisBudget,
  AnalysisDataIssue,
  AnalysisFigureTableInput,
  AnalysisObjective,
  AnalysisScalar,
  DeterministicSearchSpace,
  EarlyStopPolicy,
  ExperimentAnalysisInput,
  RobustnessDimensionSpec,
  TrialDescriptor,
} from "./contracts.js";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ARTIFACT_STATUSES = new Set(["active", "stale", "superseded", "rejected", "archived"]);
const ARTIFACT_RELATIONS = new Set(["derived_from", "uses", "supports", "challenges", "supersedes"]);
const PRODUCER_KINDS = new Set(["user", "agent", "tool", "import"]);
const ANALYSIS_LIMITS = Object.freeze({
  runAttempts: 100_000,
  metricObservations: 500_000,
  baselineObservations: 100_000,
  trialDescriptors: 100_000,
  objectives: 64,
  dimensions: 128,
  searchDomains: 32,
  searchValuesPerDomain: 1_000,
  searchCombinations: 100_000,
  proposals: 1_000,
});
const ANALYSIS_INPUT_KEYS = new Set([
  "runAttempts",
  "metricObservations",
  "baselineObservations",
  "trialDescriptors",
  "objectives",
  "ablationFactors",
  "robustnessDimensions",
  "earlyStop",
  "budget",
  "searchSpace",
  "figureTable",
  "confidenceLevel",
  "analysisId",
  "producer",
  "now",
]);

export type ValidatedExperimentAnalysisInput = Readonly<{
  runAttempts: readonly RunAttempt[];
  ignoredRunRevisionRefs: readonly ResearchArtifactRef[];
  metricObservations: readonly MetricObservation[];
  baselineObservations: readonly BaselineObservation[];
  trialDescriptors: readonly TrialDescriptor[];
  objectives: readonly AnalysisObjective[];
  ablationFactors: readonly AblationFactorSpec[];
  robustnessDimensions: readonly RobustnessDimensionSpec[];
  dataIssues: readonly AnalysisDataIssue[];
  earlyStop?: EarlyStopPolicy;
  budget?: AnalysisBudget;
  searchSpace?: DeterministicSearchSpace;
  figureTable?: AnalysisFigureTableInput;
  analysisId?: string;
  producer?: ResearchArtifactProducer;
  now?: Date;
}>;

/**
 * Rejects malformed domain input while retaining link-level data problems as
 * reportable issues. Downstream analysis therefore never has to guess whether
 * a measurement belongs to a completed run.
 */
export function validateExperimentAnalysisInput(value: unknown): ValidatedExperimentAnalysisInput {
  const input = requireRecord(value, "Experiment analysis input") as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ANALYSIS_INPUT_KEYS.has(key)) throw new TypeError(`Experiment analysis input does not accept ${key}.`);
  }
  const runAttempts = latestRunAttempts(requireEnvelopeArray(input.runAttempts, "runAttempts", "run_attempt"));
  const metricCandidates = latestArtifacts(requireEnvelopeArray(input.metricObservations, "metricObservations", "metric_observation"));
  const baselineCandidates = latestArtifacts(requireEnvelopeArray(input.baselineObservations, "baselineObservations", "baseline_observation"));

  for (const run of requireEnvelopeArray(input.runAttempts, "runAttempts", "run_attempt")) validateRunPayload(run);
  for (const metric of metricCandidates) validateMetricPayload(metric);
  for (const baseline of baselineCandidates) validateBaselinePayload(baseline);

  const latestRunValues = runAttempts.latest;
  const runsByAttemptId = uniqueBy(latestRunValues, (run) => run.payload.attemptId, "run attemptId");
  const metricsById = uniqueBy(metricCandidates, (metric) => metric.artifactId, "metric artifactId");
  const issues: AnalysisDataIssue[] = [];
  const validMetrics: MetricObservation[] = [];

  for (const metric of metricCandidates) {
    const run = runsByAttemptId.get(metric.payload.runAttemptId);
    if (!run) {
      issues.push(dataIssue("metric_missing_run", metric, `Run ${metric.payload.runAttemptId} is not present.`));
      continue;
    }
    if (run.payload.status !== "succeeded") {
      issues.push(dataIssue(
        "metric_from_unsuccessful_run",
        metric,
        `Run ${run.payload.attemptId} has status ${run.payload.status}.`,
      ));
      continue;
    }
    if (run.payload.experimentId !== metric.payload.experimentId
      || !run.payload.metricObservationIds.includes(metric.artifactId)) {
      issues.push(dataIssue(
        "metric_not_listed_by_run",
        metric,
        `Run ${run.payload.attemptId} does not list this matching metric observation.`,
      ));
      continue;
    }
    validMetrics.push(metric);
  }

  const validMetricIds = new Set(validMetrics.map((metric) => metric.artifactId));
  const validBaselines: BaselineObservation[] = [];
  for (const baseline of baselineCandidates) {
    if (baseline.payload.provenance.kind === "reported") {
      validBaselines.push(baseline);
      continue;
    }
    const provenance = baseline.payload.provenance;
    const run = runsByAttemptId.get(provenance.runAttemptId);
    if (!run) {
      issues.push(dataIssue(
        "observed_baseline_missing_run",
        baseline,
        `Observed baseline run ${provenance.runAttemptId} is not present.`,
      ));
      continue;
    }
    const metric = metricsById.get(provenance.metricObservationId);
    if (!metric) {
      issues.push(dataIssue(
        "observed_baseline_missing_metric",
        baseline,
        `Observed baseline metric ${provenance.metricObservationId} is not present.`,
      ));
      continue;
    }
    if (!validMetricIds.has(metric.artifactId)
      || run.payload.status !== "succeeded"
      || run.payload.experimentId !== baseline.payload.experimentId
      || metric.payload.runAttemptId !== run.payload.attemptId
      || metric.payload.experimentId !== baseline.payload.experimentId
      || metric.payload.name !== baseline.payload.metricName
      || metric.payload.value !== baseline.payload.value
      || metric.payload.direction !== baseline.payload.direction
      || metric.payload.split !== baseline.payload.split
      || metric.payload.unit !== baseline.payload.unit
      || !run.payload.metricObservationIds.includes(metric.artifactId)) {
      issues.push(dataIssue(
        "observed_baseline_mismatch",
        baseline,
        "Observed baseline fields do not exactly match its succeeded run and metric provenance.",
      ));
      continue;
    }
    validBaselines.push(baseline);
  }

  const trialDescriptors = validateTrialDescriptors(input.trialDescriptors, runsByAttemptId);
  const objectives = validateObjectives(input.objectives);
  const ablationFactors = validateAblationFactors(input.ablationFactors);
  const robustnessDimensions = validateRobustnessDimensions(input.robustnessDimensions);
  const earlyStop = validateEarlyStop(input.earlyStop, objectives);
  const budget = validateBudget(input.budget);
  const searchSpace = validateSearchSpace(input.searchSpace);
  const figureTable = validateFigureTableInput(input.figureTable);
  const producer = validateProducer(input.producer);
  const analysisId = input.analysisId === undefined ? undefined : requireIdentifier(input.analysisId, "analysisId");
  const now = validateDate(input.now, "now");
  if (input.confidenceLevel !== undefined && input.confidenceLevel !== 0.95) {
    throw new TypeError("confidenceLevel must be exactly 0.95.");
  }

  return Object.freeze({
    runAttempts: freezeSorted(latestRunValues, envelopeOrder),
    ignoredRunRevisionRefs: freezeSorted(runAttempts.ignored, refOrder),
    metricObservations: freezeSorted(validMetrics, envelopeOrder),
    baselineObservations: freezeSorted(validBaselines, envelopeOrder),
    trialDescriptors: Object.freeze(trialDescriptors),
    objectives: Object.freeze(objectives),
    ablationFactors: Object.freeze(ablationFactors),
    robustnessDimensions: Object.freeze(robustnessDimensions),
    dataIssues: Object.freeze(issues.sort(issueOrder)),
    ...(earlyStop === undefined ? {} : { earlyStop }),
    ...(budget === undefined ? {} : { budget }),
    ...(searchSpace === undefined ? {} : { searchSpace }),
    ...(figureTable === undefined ? {} : { figureTable }),
    ...(analysisId === undefined ? {} : { analysisId }),
    ...(producer === undefined ? {} : { producer }),
    ...(now === undefined ? {} : { now }),
  });
}

export function analysisScalarKey(value: AnalysisScalar): string {
  return canonicalJson([typeof value, Object.is(value, -0) ? 0 : value]);
}

export function analysisObjectiveKey(objective: AnalysisObjective): string {
  return canonicalJson([
    objective.experimentId,
    objective.metricName,
    objective.direction,
    objective.split ?? null,
    objective.unit ?? null,
  ]);
}

function latestRunAttempts(values: readonly RunAttempt[]): Readonly<{
  latest: RunAttempt[];
  ignored: ResearchArtifactRef[];
}> {
  const latest = latestArtifacts(values);
  const latestKeys = new Set(latest.map((run) => `${run.artifactId}@${run.revision}`));
  const ignored = values
    .filter((run) => !latestKeys.has(`${run.artifactId}@${run.revision}`))
    .map(toResearchArtifactRef);
  return { latest, ignored };
}

function latestArtifacts<T extends ResearchArtifactEnvelope>(values: readonly T[]): T[] {
  const latest = new Map<string, T>();
  const revisions = new Set<string>();
  for (const value of values) {
    const revisionKey = `${value.artifactId}@${value.revision}`;
    if (revisions.has(revisionKey)) throw new TypeError(`Artifact revision ${revisionKey} is duplicated.`);
    revisions.add(revisionKey);
    const previous = latest.get(value.artifactId);
    if (!previous || previous.revision < value.revision) latest.set(value.artifactId, value);
  }
  return [...latest.values()];
}

function requireEnvelopeArray<K extends "run_attempt" | "metric_observation" | "baseline_observation">(
  value: unknown,
  label: string,
  kind: K,
): Array<Extract<RunAttempt | MetricObservation | BaselineObservation, { kind: K }>> {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const maximum = ANALYSIS_LIMITS[label as keyof Pick<typeof ANALYSIS_LIMITS, "runAttempts" | "metricObservations" | "baselineObservations">];
  if (value.length > maximum) throw new TypeError(`${label} cannot contain more than ${maximum} artifacts.`);
  return value.map((entry, index) => validateEnvelope(entry, `${label}[${index}]`, kind)) as Array<
    Extract<RunAttempt | MetricObservation | BaselineObservation, { kind: K }>
  >;
}

function validateEnvelope<K extends "run_attempt" | "metric_observation" | "baseline_observation">(
  value: unknown,
  label: string,
  expectedKind: K,
): ResearchArtifactEnvelope<K, unknown> {
  const envelope = requireRecord(value, label);
  if (envelope.schemaVersion !== 1) throw new TypeError(`${label}.schemaVersion must be 1.`);
  if (envelope.kind !== expectedKind) throw new TypeError(`${label}.kind must be ${expectedKind}.`);
  requireIdentifier(envelope.artifactId, `${label}.artifactId`);
  requirePositiveInteger(envelope.revision, `${label}.revision`);
  if (!ARTIFACT_STATUSES.has(String(envelope.status))) throw new TypeError(`${label}.status is invalid.`);
  requireIsoDate(envelope.createdAt, `${label}.createdAt`);
  requireIsoDate(envelope.updatedAt, `${label}.updatedAt`);
  requireHash(envelope.contentHash, `${label}.contentHash`);
  validateProducer(envelope.producer, `${label}.producer`, true);
  if (!Array.isArray(envelope.parents)) throw new TypeError(`${label}.parents must be an array.`);
  for (const [index, parentValue] of envelope.parents.entries()) {
    const parent = requireRecord(parentValue, `${label}.parents[${index}]`);
    if (!ARTIFACT_RELATIONS.has(String(parent.relation))) throw new TypeError(`${label}.parents[${index}].relation is invalid.`);
    validateRef(parent.artifact, `${label}.parents[${index}].artifact`);
  }
  if (!Array.isArray(envelope.sources)) throw new TypeError(`${label}.sources must be an array.`);
  for (const [index, sourceValue] of envelope.sources.entries()) {
    const source = requireRecord(sourceValue, `${label}.sources[${index}]`);
    requireIdentifier(source.sourceId, `${label}.sources[${index}].sourceId`);
    if (source.contentHash !== undefined) requireHash(source.contentHash, `${label}.sources[${index}].contentHash`);
  }
  requireRecord(envelope.payload, `${label}.payload`);
  const expectedHash = hashResearchArtifactContent({
    artifactId: envelope.artifactId,
    revision: envelope.revision,
    kind: envelope.kind,
    parents: envelope.parents,
    sources: envelope.sources,
    payload: envelope.payload,
  });
  if (expectedHash !== envelope.contentHash) throw new TypeError(`${label}.contentHash does not match its canonical content.`);
  return envelope as unknown as ResearchArtifactEnvelope<K, unknown>;
}

function validateRunPayload(run: RunAttempt): void {
  const payload = requireRecord(run.payload, `run ${run.artifactId}.payload`);
  const attemptId = requireIdentifier(payload.attemptId, "run attemptId");
  if (attemptId !== run.artifactId) throw new TypeError(`Run ${run.artifactId} payload attemptId must match its artifactId.`);
  requireIdentifier(payload.experimentId, "run experimentId");
  requirePositiveInteger(payload.specRevision, "run specRevision");
  requireHash(payload.specDigest, "run specDigest");
  if (!(EXPERIMENT_ADAPTER_IDS as readonly unknown[]).includes(payload.adapterId)) throw new TypeError("Run adapterId is invalid.");
  requireIdentifier(payload.jobId, "run jobId");
  if (!(EXPERIMENT_RUN_STATUSES as readonly unknown[]).includes(payload.status)) throw new TypeError("Run status is invalid.");
  if (!(EXECUTION_GRANT_MODES as readonly unknown[]).includes(payload.grantMode)) throw new TypeError("Run grantMode is invalid.");
  requireIsoDate(payload.preparedAt, "run preparedAt");
  for (const timestamp of ["queuedAt", "startedAt", "finishedAt"] as const) {
    if (payload[timestamp] !== undefined) requireIsoDate(payload[timestamp], `run ${timestamp}`);
  }
  validateStringArray(payload.artifactIds, "run artifactIds");
  validateStringArray(payload.metricObservationIds, "run metricObservationIds");
  if (payload.failure !== undefined) {
    const failure = requireRecord(payload.failure, "run failure");
    if (!(EXPERIMENT_FAILURE_CATEGORIES as readonly unknown[]).includes(failure.category)) {
      throw new TypeError("Run failure category is invalid.");
    }
    if (typeof failure.retryable !== "boolean") throw new TypeError("Run failure retryable must be boolean.");
    requireText(failure.message, "run failure message", 16_000);
    requireIsoDate(failure.observedAt, "run failure observedAt");
  }
  if (payload.runFacts !== undefined) validateRunFacts(payload.runFacts);
  if (payload.baselineRerun !== undefined) validateBaselineRerun(payload.baselineRerun);
  if (payload.remoteCancellationReconciliation !== undefined) {
    validateRemoteCancellationReconciliation(payload.remoteCancellationReconciliation);
  }
}

function validateRunFacts(value: unknown): void {
  const facts = requireRecord(value, "runFacts");
  const allowedKeys = new Set([
    "routeId",
    "parameters",
    "slices",
    "budgetReservation",
    "actualWallTimeMs",
    "actualCost",
  ]);
  for (const key of Object.keys(facts)) {
    if (!allowedKeys.has(key)) throw new TypeError(`runFacts does not accept ${key}.`);
  }
  requireIdentifier(facts.routeId, "runFacts.routeId");
  if (validateScalarRecord(facts.parameters, "runFacts.parameters") === undefined) {
    throw new TypeError("runFacts.parameters must be an object.");
  }
  if (validateScalarRecord(facts.slices, "runFacts.slices") === undefined) {
    throw new TypeError("runFacts.slices must be an object.");
  }
  if (facts.budgetReservation !== undefined) validateRunBudgetReservation(facts.budgetReservation);
  const actualWallTimeMs = facts.actualWallTimeMs;
  if (actualWallTimeMs !== undefined) {
    if (typeof actualWallTimeMs !== "number" || !Number.isSafeInteger(actualWallTimeMs) || actualWallTimeMs < 0) {
      throw new TypeError("runFacts.actualWallTimeMs must be a non-negative integer.");
    }
  }
  if (facts.actualCost !== undefined) validateActualCostRecord(facts.actualCost);
}

function validateRunBudgetReservation(value: unknown): void {
  const reservation = requireRecord(value, "runFacts.budgetReservation");
  for (const key of Object.keys(reservation)) {
    if (key !== "wallTimeMs" && key !== "cost") {
      throw new TypeError(`runFacts.budgetReservation does not accept ${key}.`);
    }
  }
  if (reservation.wallTimeMs !== undefined) requirePositiveInteger(reservation.wallTimeMs, "runFacts.budgetReservation.wallTimeMs");
  if (reservation.cost !== undefined) {
    const cost = requireRecord(reservation.cost, "runFacts.budgetReservation.cost");
    for (const key of Object.keys(cost)) {
      if (key !== "usd" && key !== "source" && key !== "reference") {
        throw new TypeError(`runFacts.budgetReservation.cost does not accept ${key}.`);
      }
    }
    requireNonNegativeNumber(cost.usd, "runFacts.budgetReservation.cost.usd");
    if (cost.source !== "provider_quote" && cost.source !== "user_confirmed") {
      throw new TypeError("runFacts.budgetReservation.cost.source is invalid.");
    }
    requireText(cost.reference, "runFacts.budgetReservation.cost.reference");
  }
  if (reservation.wallTimeMs === undefined && reservation.cost === undefined) {
    throw new TypeError("runFacts.budgetReservation must reserve wall time, cost, or both.");
  }
}

function validateActualCostRecord(value: unknown): void {
  const cost = requireRecord(value, "runFacts.actualCost");
  for (const key of Object.keys(cost)) {
    if (key !== "usd" && key !== "source" && key !== "reference" && key !== "recordedAt") {
      throw new TypeError(`runFacts.actualCost does not accept ${key}.`);
    }
  }
  requireNonNegativeNumber(cost.usd, "runFacts.actualCost.usd");
  if (cost.source !== "provider_reported" && cost.source !== "user_confirmed") {
    throw new TypeError("runFacts.actualCost.source is invalid.");
  }
  requireText(cost.reference, "runFacts.actualCost.reference");
  requireIsoDate(cost.recordedAt, "runFacts.actualCost.recordedAt");
}

function validateBaselineRerun(value: unknown): void {
  const rerun = requireRecord(value, "run baselineRerun");
  for (const key of Object.keys(rerun)) {
    if (key !== "baselineId" && key !== "purpose" && key !== "confirmedAt") {
      throw new TypeError(`run baselineRerun does not accept ${key}.`);
    }
  }
  requireIdentifier(rerun.baselineId, "run baselineRerun.baselineId");
  if (rerun.purpose !== "reproduce_reported_baseline" && rerun.purpose !== "compare_reported_baseline") {
    throw new TypeError("run baselineRerun.purpose is invalid.");
  }
  requireIsoDate(rerun.confirmedAt, "run baselineRerun.confirmedAt");
}

function validateRemoteCancellationReconciliation(value: unknown): void {
  const reconciliation = requireRecord(value, "run remoteCancellationReconciliation");
  for (const key of Object.keys(reconciliation)) {
    if (key !== "source" && key !== "reference" && key !== "confirmedAt") {
      throw new TypeError(`run remoteCancellationReconciliation does not accept ${key}.`);
    }
  }
  if (reconciliation.source !== "scheduler_audit" && reconciliation.source !== "operator_confirmed") {
    throw new TypeError("run remoteCancellationReconciliation.source is invalid.");
  }
  requireText(reconciliation.reference, "run remoteCancellationReconciliation.reference");
  requireIsoDate(reconciliation.confirmedAt, "run remoteCancellationReconciliation.confirmedAt");
}

function validateMetricPayload(metric: MetricObservation): void {
  const payload = requireRecord(metric.payload, `metric ${metric.artifactId}.payload`);
  const observationId = requireIdentifier(payload.observationId, "metric observationId");
  if (observationId !== metric.artifactId) throw new TypeError(`Metric ${metric.artifactId} observationId must match its artifactId.`);
  requireIdentifier(payload.experimentId, "metric experimentId");
  requireIdentifier(payload.runAttemptId, "metric runAttemptId");
  requireText(payload.name, "metric name", 512);
  requireFiniteNumber(payload.value, "metric value");
  if (!(["minimize", "maximize", "neutral"] as readonly unknown[]).includes(payload.direction)) {
    throw new TypeError("Metric direction is invalid.");
  }
  if (payload.split !== undefined) requireText(payload.split, "metric split", 512);
  if (payload.unit !== undefined) requireText(payload.unit, "metric unit", 512);
  requireIsoDate(payload.observedAt, "metric observedAt");
}

function validateBaselinePayload(baseline: BaselineObservation): void {
  const payload = requireRecord(baseline.payload, `baseline ${baseline.artifactId}.payload`);
  const baselineId = requireIdentifier(payload.baselineId, "baseline baselineId");
  if (baselineId !== baseline.artifactId) throw new TypeError(`Baseline ${baseline.artifactId} baselineId must match its artifactId.`);
  requireIdentifier(payload.experimentId, "baseline experimentId");
  requireText(payload.metricName, "baseline metricName", 512);
  requireFiniteNumber(payload.value, "baseline value");
  if (!(["minimize", "maximize", "neutral"] as readonly unknown[]).includes(payload.direction)) {
    throw new TypeError("Baseline direction is invalid.");
  }
  if (payload.split !== undefined) requireText(payload.split, "baseline split", 512);
  if (payload.unit !== undefined) requireText(payload.unit, "baseline unit", 512);
  requireIsoDate(payload.recordedAt, "baseline recordedAt");
  const provenance = requireRecord(payload.provenance, "baseline provenance");
  if (provenance.kind === "reported") {
    const citation = requireRecord(provenance.citation, "reported baseline citation");
    requireText(citation.text, "reported baseline citation text", 16_000);
    if (provenance.rerunStatus !== "not_rerun") throw new TypeError("Reported baseline rerunStatus must be not_rerun.");
  } else if (provenance.kind === "observed") {
    requireIdentifier(provenance.runAttemptId, "observed baseline runAttemptId");
    requireIdentifier(provenance.metricObservationId, "observed baseline metricObservationId");
  } else {
    throw new TypeError("Baseline provenance kind is invalid.");
  }
}

function validateTrialDescriptors(
  value: unknown,
  runsByAttemptId: ReadonlyMap<string, RunAttempt>,
): TrialDescriptor[] {
  const persistedDescriptors = [...runsByAttemptId.values()]
    .filter((run) => run.payload.runFacts !== undefined)
    .map((run) => persistedTrialDescriptor(run));
  if (value === undefined) return persistedDescriptors;
  if (!Array.isArray(value)) throw new TypeError("trialDescriptors must be an array.");
  if (value.length > ANALYSIS_LIMITS.trialDescriptors) {
    throw new TypeError(`trialDescriptors cannot contain more than ${ANALYSIS_LIMITS.trialDescriptors} entries.`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const descriptor = requireRecord(entry, `trialDescriptors[${index}]`);
    const attemptId = requireIdentifier(descriptor.attemptId, `trialDescriptors[${index}].attemptId`);
    const run = runsByAttemptId.get(attemptId);
    if (!run) throw new TypeError(`Trial descriptor run ${attemptId} is not present.`);
    if (run.payload.runFacts !== undefined) {
      throw new TypeError(`trialDescriptors cannot override persisted run facts for ${attemptId}.`);
    }
    if (seen.has(attemptId)) throw new TypeError(`Trial descriptor ${attemptId} is duplicated.`);
    seen.add(attemptId);
    const routeId = requireIdentifier(descriptor.routeId, `trialDescriptors[${index}].routeId`);
    const parameters = validateScalarRecord(descriptor.parameters, `trialDescriptors[${index}].parameters`);
    const slices = validateScalarRecord(descriptor.slices, `trialDescriptors[${index}].slices`);
    const costUsd = optionalNonNegativeNumber(descriptor.costUsd, `trialDescriptors[${index}].costUsd`);
    const wallTimeMs = optionalNonNegativeNumber(descriptor.wallTimeMs, `trialDescriptors[${index}].wallTimeMs`);
    return Object.freeze({
      attemptId,
      routeId,
      ...(parameters === undefined ? {} : { parameters }),
      ...(slices === undefined ? {} : { slices }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(wallTimeMs === undefined ? {} : { wallTimeMs }),
    });
  }).concat(persistedDescriptors).sort((left, right) => left.attemptId.localeCompare(right.attemptId, "en"));
}

function persistedTrialDescriptor(run: RunAttempt): TrialDescriptor {
  const facts = run.payload.runFacts;
  if (!facts) throw new TypeError(`Run ${run.artifactId} is missing persisted run facts.`);
  return Object.freeze({
    attemptId: run.payload.attemptId,
    routeId: facts.routeId,
    parameters: facts.parameters,
    slices: facts.slices,
    ...(facts.actualCost === undefined ? {} : { costUsd: facts.actualCost.usd }),
    ...(facts.actualWallTimeMs === undefined ? {} : { wallTimeMs: facts.actualWallTimeMs }),
  });
}

function validateObjectives(value: unknown): AnalysisObjective[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("objectives must contain at least one objective.");
  if (value.length > ANALYSIS_LIMITS.objectives) throw new TypeError(`objectives cannot contain more than ${ANALYSIS_LIMITS.objectives} entries.`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const objective = requireRecord(entry, `objectives[${index}]`);
    const normalized: AnalysisObjective = Object.freeze({
      experimentId: requireIdentifier(objective.experimentId, `objectives[${index}].experimentId`),
      metricName: requireText(objective.metricName, `objectives[${index}].metricName`, 512),
      direction: requireObjectiveDirection(objective.direction, `objectives[${index}].direction`),
      ...(objective.split === undefined ? {} : { split: requireText(objective.split, `objectives[${index}].split`, 512) }),
      ...(objective.unit === undefined ? {} : { unit: requireText(objective.unit, `objectives[${index}].unit`, 512) }),
    });
    const key = canonicalJson([
      normalized.experimentId,
      normalized.metricName,
      normalized.split ?? null,
      normalized.unit ?? null,
    ]);
    if (seen.has(key)) throw new TypeError(`Objective ${normalized.metricName} is duplicated.`);
    seen.add(key);
    return normalized;
  });
}

function validateAblationFactors(value: unknown): AblationFactorSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("ablationFactors must be an array.");
  if (value.length > ANALYSIS_LIMITS.dimensions) throw new TypeError(`ablationFactors cannot contain more than ${ANALYSIS_LIMITS.dimensions} entries.`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const factor = requireRecord(entry, `ablationFactors[${index}]`);
    const name = requireIdentifier(factor.name, `ablationFactors[${index}].name`);
    if (seen.has(name)) throw new TypeError(`Ablation factor ${name} is duplicated.`);
    seen.add(name);
    return Object.freeze({ name, controlValue: requireScalar(factor.controlValue, `ablationFactors[${index}].controlValue`) });
  });
}

function validateRobustnessDimensions(value: unknown): RobustnessDimensionSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("robustnessDimensions must be an array.");
  if (value.length > ANALYSIS_LIMITS.dimensions) throw new TypeError(`robustnessDimensions cannot contain more than ${ANALYSIS_LIMITS.dimensions} entries.`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const dimension = requireRecord(entry, `robustnessDimensions[${index}]`);
    const name = requireIdentifier(dimension.name, `robustnessDimensions[${index}].name`);
    if (seen.has(name)) throw new TypeError(`Robustness dimension ${name} is duplicated.`);
    seen.add(name);
    return Object.freeze({ name });
  });
}

function validateEarlyStop(value: unknown, objectives: readonly AnalysisObjective[]): EarlyStopPolicy | undefined {
  if (value === undefined) return undefined;
  const policy = requireRecord(value, "earlyStop");
  const objective = validateObjectives([policy.objective])[0]!;
  if (!objectives.some((candidate) => analysisObjectiveKey(candidate) === analysisObjectiveKey(objective))) {
    throw new TypeError("earlyStop.objective must be one of objectives.");
  }
  return Object.freeze({
    objective,
    ...(policy.routeId === undefined ? {} : { routeId: requireIdentifier(policy.routeId, "earlyStop.routeId") }),
    patience: requirePositiveInteger(policy.patience, "earlyStop.patience"),
    minimumImprovement: requireNonNegativeNumber(policy.minimumImprovement, "earlyStop.minimumImprovement"),
    ...(policy.minimumMeasuredRuns === undefined
      ? {}
      : { minimumMeasuredRuns: requirePositiveInteger(policy.minimumMeasuredRuns, "earlyStop.minimumMeasuredRuns") }),
  });
}

function validateBudget(value: unknown): AnalysisBudget | undefined {
  if (value === undefined) return undefined;
  const budget = requireRecord(value, "budget");
  return Object.freeze({
    maxAttempts: requirePositiveInteger(budget.maxAttempts, "budget.maxAttempts"),
    ...(budget.maxWallTimeMs === undefined ? {} : { maxWallTimeMs: requireNonNegativeNumber(budget.maxWallTimeMs, "budget.maxWallTimeMs") }),
    ...(budget.maxCostUsd === undefined ? {} : { maxCostUsd: requireNonNegativeNumber(budget.maxCostUsd, "budget.maxCostUsd") }),
  });
}

function validateSearchSpace(value: unknown): DeterministicSearchSpace | undefined {
  if (value === undefined) return undefined;
  const search = requireRecord(value, "searchSpace");
  if (!Array.isArray(search.parameters) || search.parameters.length === 0) {
    throw new TypeError("searchSpace.parameters must contain at least one domain.");
  }
  if (search.parameters.length > ANALYSIS_LIMITS.searchDomains) {
    throw new TypeError(`searchSpace.parameters cannot contain more than ${ANALYSIS_LIMITS.searchDomains} domains.`);
  }
  const names = new Set<string>();
  let combinationCount = 1;
  const parameters = search.parameters.map((entry, index) => {
    const domain = requireRecord(entry, `searchSpace.parameters[${index}]`);
    const name = requireIdentifier(domain.name, `searchSpace.parameters[${index}].name`);
    if (names.has(name)) throw new TypeError(`Search parameter ${name} is duplicated.`);
    names.add(name);
    if (!Array.isArray(domain.values) || domain.values.length === 0) {
      throw new TypeError(`Search parameter ${name} must contain at least one value.`);
    }
    if (domain.values.length > ANALYSIS_LIMITS.searchValuesPerDomain) {
      throw new TypeError(`Search parameter ${name} cannot contain more than ${ANALYSIS_LIMITS.searchValuesPerDomain} values.`);
    }
    combinationCount *= domain.values.length;
    if (combinationCount > ANALYSIS_LIMITS.searchCombinations) {
      throw new TypeError(`searchSpace cannot exceed ${ANALYSIS_LIMITS.searchCombinations} discrete combinations.`);
    }
    const values = domain.values.map((entryValue, valueIndex) => requireScalar(
      entryValue,
      `searchSpace.parameters[${index}].values[${valueIndex}]`,
    ));
    if (new Set(values.map(analysisScalarKey)).size !== values.length) {
      throw new TypeError(`Search parameter ${name} contains duplicate values.`);
    }
    return Object.freeze({ name, values: Object.freeze(values) });
  });
  return Object.freeze({
    routeId: requireIdentifier(search.routeId, "searchSpace.routeId"),
    parameters: Object.freeze(parameters),
    ...(search.maxProposals === undefined
      ? {}
      : { maxProposals: requirePositiveInteger(search.maxProposals, "searchSpace.maxProposals", ANALYSIS_LIMITS.proposals) }),
    ...(search.estimatedWallTimeMsPerTrial === undefined
      ? {}
      : { estimatedWallTimeMsPerTrial: requireNonNegativeNumber(search.estimatedWallTimeMsPerTrial, "searchSpace.estimatedWallTimeMsPerTrial") }),
    ...(search.estimatedCostUsdPerTrial === undefined
      ? {}
      : { estimatedCostUsdPerTrial: requireNonNegativeNumber(search.estimatedCostUsdPerTrial, "searchSpace.estimatedCostUsdPerTrial") }),
  });
}

function validateFigureTableInput(value: unknown): AnalysisFigureTableInput | undefined {
  if (value === undefined) return undefined;
  const figureTable = requireRecord(value, "figureTable");
  if (!Array.isArray(figureTable.items) || figureTable.items.length === 0) {
    throw new TypeError("figureTable.items must contain at least one caller-supplied item.");
  }
  return value as AnalysisFigureTableInput;
}

function validateProducer(value: unknown, label = "producer", required = false): ResearchArtifactProducer | undefined {
  if (value === undefined) {
    if (required) throw new TypeError(`${label} is required.`);
    return undefined;
  }
  const producer = requireRecord(value, label);
  if (!PRODUCER_KINDS.has(String(producer.kind))) throw new TypeError(`${label}.kind is invalid.`);
  if (producer.id !== undefined) requireText(producer.id, `${label}.id`, 512);
  if (producer.toolName !== undefined) requireText(producer.toolName, `${label}.toolName`, 512);
  return value as ResearchArtifactProducer;
}

function validateRef(value: unknown, label: string): ResearchArtifactRef {
  const ref = requireRecord(value, label);
  requireIdentifier(ref.artifactId, `${label}.artifactId`);
  requirePositiveInteger(ref.revision, `${label}.revision`);
  if (!(RESEARCH_ARTIFACT_KINDS as readonly unknown[]).includes(ref.kind)) throw new TypeError(`${label}.kind is invalid.`);
  requireHash(ref.contentHash, `${label}.contentHash`);
  return value as ResearchArtifactRef;
}

function validateScalarRecord(value: unknown, label: string): Readonly<Record<string, AnalysisScalar>> | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, label);
  const normalized: Record<string, AnalysisScalar> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right, "en"))) {
    requireIdentifier(key, `${label} key`);
    normalized[key] = requireScalar(record[key], `${label}.${key}`);
  }
  return Object.freeze(normalized);
}

function requireScalar(value: unknown, label: string): AnalysisScalar {
  if (typeof value === "string") return requireText(value, label, 4_096);
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  throw new TypeError(`${label} must be a finite number, boolean, or non-empty string.`);
}

function validateStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const values = value.map((entry, index) => requireIdentifier(entry, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError(`${label} contains duplicates.`);
}

function dataIssue(
  code: AnalysisDataIssue["code"],
  artifact: ResearchArtifactEnvelope,
  detail: string,
): AnalysisDataIssue {
  return Object.freeze({ code, artifactRef: toResearchArtifactRef(artifact), detail });
}

function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) throw new TypeError(`${label} ${key} is duplicated across artifact identities.`);
    result.set(key, value);
  }
  return result;
}

function freezeSorted<T>(values: readonly T[], compare: (left: T, right: T) => number): readonly T[] {
  return Object.freeze([...values].sort(compare));
}

function envelopeOrder(left: ResearchArtifactEnvelope, right: ResearchArtifactEnvelope): number {
  return left.artifactId.localeCompare(right.artifactId, "en") || left.revision - right.revision;
}

function refOrder(left: ResearchArtifactRef, right: ResearchArtifactRef): number {
  return left.artifactId.localeCompare(right.artifactId, "en") || left.revision - right.revision;
}

function issueOrder(left: AnalysisDataIssue, right: AnalysisDataIssue): number {
  return left.code.localeCompare(right.code, "en")
    || left.artifactRef.artifactId.localeCompare(right.artifactRef.artifactId, "en")
    || left.artifactRef.revision - right.artifactRef.revision;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string, maximum = 16_000): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\u0000") || value.length > maximum) {
    throw new TypeError(`${label} must be bounded non-empty text.`);
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  const text = requireText(value, label, 256);
  if (!IDENTIFIER_PATTERN.test(text)) throw new TypeError(`${label} must be a safe identifier.`);
  return text;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new TypeError(`${label} must be a SHA-256 content hash.`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
  return Object.is(value, -0) ? 0 : value;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);
  if (number < 0) throw new TypeError(`${label} must be non-negative.`);
  return number;
}

function optionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requireNonNegativeNumber(value, label);
}

function requireIsoDate(value: unknown, label: string): string {
  const text = requireText(value, label, 128);
  if (Number.isNaN(Date.parse(text))) throw new TypeError(`${label} must be an ISO date.`);
  return text;
}

function validateDate(value: unknown, label: string): Date | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(`${label} must be a valid Date.`);
  return new Date(value.getTime());
}

function requireObjectiveDirection(value: unknown, label: string): "minimize" | "maximize" {
  if (value !== "minimize" && value !== "maximize") throw new TypeError(`${label} must be minimize or maximize.`);
  return value;
}
