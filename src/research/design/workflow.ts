import {
  buildResearchArtifactGraph,
  canonicalJson,
  createResearchArtifact,
  researchArtifactKey,
  type ResearchArtifactEnvelope,
  type ResearchArtifactInvalidation,
  type ResearchArtifactParent,
  type ResearchArtifactRef,
} from "../artifacts/index.js";
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
  /** Complete, normalized external ancestor closure supplied by the caller. */
  sourceArtifacts: readonly ResearchArtifactEnvelope[];
  /** The self-contained external closure followed by artifacts created for this design. */
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
    /** Explicit external parents for the generated ResearchBrief. */
    parents?: ResearchBriefBuildInput["parents"];
  }>;
  /**
   * Complete immutable envelope closure for explicit external parents. It is
   * included in the returned package so the design DAG remains verifiable.
   */
  sourceArtifacts?: readonly ResearchArtifactEnvelope[];
  now?: Date;
}>;

/**
 * Materialize one complete design decision without creating a stage machine.
 * Every transition is an artifact edge; callers can revise any artifact and
 * invalidate descendants through the shared artifact graph.
 */
export function createResearchDesignPackage(input: ResearchDesignPackageInput): ResearchDesignPackage {
  requireIndependentDesignChecks(input);
  const sourceArtifacts = normalizeSourceArtifacts(input.sourceArtifacts);
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
    parents: input.brief?.parents,
    producer: { kind: "tool", toolName: "research_brief" },
    now,
  });
  const producedArtifacts: readonly ResearchArtifactEnvelope[] = [portfolio, challengeReport, decisionRecord, researchBrief];
  const artifacts: readonly ResearchArtifactEnvelope[] = [...sourceArtifacts, ...producedArtifacts];
  assertSourceArtifactClosure({ sourceArtifacts, artifacts, producedArtifacts });
  return Object.freeze({
    entry: portfolio.payload.entry,
    portfolio,
    challengeReport,
    comparison,
    decisionRecord,
    researchBrief,
    sourceArtifacts,
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

function normalizeSourceArtifacts(value: unknown): readonly ResearchArtifactEnvelope[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError("sourceArtifacts must be an array of complete research artifact envelopes.");
  const artifacts = new Map<string, ResearchArtifactEnvelope>();
  for (const [index, entry] of value.entries()) {
    const artifact = normalizeSourceArtifactEnvelope(entry, `sourceArtifacts[${index}]`);
    const key = researchArtifactKey(artifact);
    const previous = artifacts.get(key);
    if (previous) {
      if (sameCanonicalJson(previous, artifact)) {
        throw new TypeError(`sourceArtifacts contains a duplicate envelope for ${key}.`);
      }
      throw new TypeError(`sourceArtifacts contains conflicting envelopes for ${key}.`);
    }
    artifacts.set(key, artifact);
  }
  return Object.freeze([...artifacts.values()].sort(compareArtifacts));
}

function normalizeSourceArtifactEnvelope(value: unknown, label: string): ResearchArtifactEnvelope {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.kind !== "string"
    || typeof value.artifactId !== "string" || !Number.isSafeInteger(value.revision)
    || typeof value.status !== "string" || typeof value.contentHash !== "string"
    || !Array.isArray(value.parents) || !Array.isArray(value.sources) || !isRecord(value.producer)
    || !("payload" in value)) {
    throw new TypeError(`${label} must be a complete research artifact envelope.`);
  }
  const createdAt = requireArtifactTimestamp(value.createdAt, `${label}.createdAt`);
  const updatedAt = requireArtifactTimestamp(value.updatedAt, `${label}.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new TypeError(`${label}.updatedAt cannot precede createdAt.`);
  }
  let rebuilt: ResearchArtifactEnvelope;
  try {
    rebuilt = createResearchArtifact({
      kind: value.kind as ResearchArtifactEnvelope["kind"],
      artifactId: value.artifactId,
      revision: value.revision as number,
      status: value.status as ResearchArtifactEnvelope["status"],
      // Detach the caller-owned object before returning it as part of the
      // package closure. Artifact envelopes are content-addressed snapshots.
      payload: cloneCanonicalJson(value.payload),
      producer: value.producer as ResearchArtifactEnvelope["producer"],
      parents: value.parents as ResearchArtifactParent[],
      sources: value.sources as ResearchArtifactEnvelope["sources"],
      now: new Date(createdAt),
    });
  } catch (error) {
    throw new TypeError(`${label} is not a valid research artifact envelope: ${messageOf(error)}`);
  }
  if (rebuilt.contentHash !== value.contentHash) {
    throw new TypeError(`${label}.contentHash does not match its immutable content.`);
  }
  const invalidation = value.invalidation === undefined
    ? undefined
    : normalizeArtifactInvalidation(value.invalidation, `${label}.invalidation`);
  return deepFreeze({
    ...rebuilt,
    createdAt,
    updatedAt,
    ...(invalidation === undefined ? {} : { invalidation }),
  });
}

function normalizeArtifactInvalidation(value: unknown, label: string): ResearchArtifactInvalidation {
  if (!isRecord(value) || !Array.isArray(value.roots) || value.roots.length === 0) {
    throw new TypeError(`${label} must contain one or more root references.`);
  }
  if (![
    "upstream_changed", "evidence_withdrawn", "run_failed", "review_finding", "manual",
  ].includes(value.reason as string)) {
    throw new TypeError(`${label}.reason is invalid.`);
  }
  const roots = value.roots.map((root, index) => normalizeArtifactRef(root, `${label}.roots[${index}]`));
  const rootKeys = new Set<string>();
  for (const root of roots) {
    const key = artifactReferenceKey(root);
    if (rootKeys.has(key)) throw new TypeError(`${label}.roots contains a duplicate reference.`);
    rootKeys.add(key);
  }
  return Object.freeze({
    invalidatedAt: requireArtifactTimestamp(value.invalidatedAt, `${label}.invalidatedAt`),
    reason: value.reason as ResearchArtifactInvalidation["reason"],
    roots,
  });
}

function normalizeArtifactRef(value: unknown, label: string): ResearchArtifactRef {
  try {
    const probe = createResearchArtifact({
      kind: "evidence_pack",
      artifactId: "research-design-reference-validation",
      revision: 1,
      payload: { label },
      producer: { kind: "tool", toolName: "research_design" },
      parents: [{ relation: "uses", artifact: value as ResearchArtifactRef }],
      now: new Date(0),
    });
    return probe.parents[0]!.artifact;
  } catch (error) {
    throw new TypeError(`${label} must be a valid research artifact reference: ${messageOf(error)}`);
  }
}

function assertSourceArtifactClosure(input: {
  sourceArtifacts: readonly ResearchArtifactEnvelope[];
  artifacts: readonly ResearchArtifactEnvelope[];
  producedArtifacts: readonly ResearchArtifactEnvelope[];
}): void {
  const producedKeys = new Set(input.producedArtifacts.map(researchArtifactKey));
  for (const artifact of input.sourceArtifacts) {
    const key = researchArtifactKey(artifact);
    if (producedKeys.has(key)) {
      throw new TypeError(`sourceArtifacts cannot duplicate the generated research design artifact ${key}.`);
    }
  }
  let graph: ReturnType<typeof buildResearchArtifactGraph>;
  try {
    graph = buildResearchArtifactGraph(input.artifacts);
    if (graph.missingParents.length > 0) {
      throw new TypeError(`Artifact graph has ${graph.missingParents.length} missing parent reference(s).`);
    }
  } catch (error) {
    throw new TypeError(`Research design sourceArtifacts must form a complete, valid Artifact DAG closure: ${messageOf(error)}`);
  }
  const reachable = ancestorArtifactKeys(
    input.producedArtifacts.map(researchArtifactKey),
    graph.artifacts,
  );
  for (const artifact of input.sourceArtifacts) {
    const key = researchArtifactKey(artifact);
    if (!reachable.has(key)) {
      throw new TypeError(`sourceArtifact ${key} is not an ancestor of a generated research design artifact.`);
    }
    for (const root of artifact.invalidation?.roots ?? []) {
      const target = graph.artifacts.get(researchArtifactKey(root));
      if (!target || target.kind !== root.kind || target.contentHash !== root.contentHash) {
        throw new TypeError(`sourceArtifact invalidation root ${artifactReferenceKey(root)} is not resolved by the supplied closure.`);
      }
    }
  }
}

function ancestorArtifactKeys(
  roots: readonly string[],
  artifacts: ReadonlyMap<string, ResearchArtifactEnvelope>,
): ReadonlySet<string> {
  const reachable = new Set<string>();
  const queue = [...roots];
  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index];
    if (!key || reachable.has(key)) continue;
    const artifact = artifacts.get(key);
    if (!artifact) continue;
    reachable.add(key);
    for (const parent of artifact.parents) queue.push(researchArtifactKey(parent.artifact));
  }
  return reachable;
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function cloneCanonicalJson(value: unknown): unknown {
  return JSON.parse(canonicalJson(value)) as unknown;
}

function compareArtifacts(left: ResearchArtifactEnvelope, right: ResearchArtifactEnvelope): number {
  return researchArtifactKey(left).localeCompare(researchArtifactKey(right), "en");
}

function artifactReferenceKey(ref: ResearchArtifactRef): string {
  return `${ref.kind}:${researchArtifactKey(ref)}:${ref.contentHash}`;
}

function requireArtifactTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}
