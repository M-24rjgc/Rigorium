import type {
  LiteratureTerminology,
  LiteratureTerminologyCandidate,
  LiteratureTerminologyCandidateKind,
  LiteratureTerminologyEvidence,
  LiteratureTerminologyInference,
  LiteratureTerminologyObservation,
  LiteratureTerminologyObservationTruncation,
  LiteratureTerminologyProviderField,
  LiteratureTerminologySourceRecord,
  LiteratureTerminologyTaxonomyLevelRecord,
} from "../types.js";

export const OPENALEX_KEYWORD_MIN_SCORE = 0.3;
export const OPENALEX_TOPIC_MIN_SCORE = 0.5;
export const OPENALEX_TERMINOLOGY_PER_PAPER_LIMIT = 8;
/** Maximum display candidates retained for each evidence kind. */
export const LITERATURE_TERMINOLOGY_CANDIDATES_PER_KIND_LIMIT = 8;
/** Maximum evidence records retained for a single display candidate. */
export const LITERATURE_TERMINOLOGY_EVIDENCE_PER_CANDIDATE_LIMIT = 32;
/** UTF-8 JSON ceiling for the terminology summary embedded in a tool artifact. */
export const LITERATURE_TERMINOLOGY_SUMMARY_MAX_UTF8_BYTES = 160_000;
const MINIMUM_ADJACENT_FIELD_SUPPORT = 2;
const SENSITIVE_RETRIEVAL_QUERY_PARAMETERS = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "bearertoken",
  "clientsecret",
  "credential",
  "email",
  "key",
  "mailto",
  "password",
  "secret",
  "signature",
  "sig",
  "token",
  "xapikey",
]);

type ObservedField = "keywords" | "topics";
type TaxonomyLevel = "subfield" | "field";

type SelectedRecords = {
  records: LiteratureTerminologySourceRecord[];
  truncation: LiteratureTerminologyObservationTruncation;
};

type MutableCandidate = {
  id: string;
  text: string;
  kind: LiteratureTerminologyCandidateKind;
  supportingPaperIds: Set<string>;
  evidence: Map<string, LiteratureTerminologyEvidence>;
  observationTruncation: Map<string, LiteratureTerminologyObservationTruncation>;
  inference?: LiteratureTerminologyInference;
};

type TaxonomyBucket = {
  record: LiteratureTerminologyTaxonomyLevelRecord;
  evidence: LiteratureTerminologyEvidence[];
};

/**
 * Remove retrieval credentials before URL values leave a provider adapter.
 * The request itself must still use the original URL so provider routing and
 * polite-pool contact parameters retain their intended behavior.
 */
export function sanitizeRetrievalUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_RETRIEVAL_QUERY_PARAMETERS.has(normalizedRetrievalQueryParameter(key))) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizedRetrievalQueryParameter(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Turn raw OpenAlex search-attempt observations into a display-safe artifact.
 * This function deliberately accepts only observations mapped by the candidate
 * pool, so unselected source records never influence terminology output.
 */
export function buildLiteratureTerminology(
  observations: LiteratureTerminologyObservation[],
): LiteratureTerminology | undefined {
  const candidates = new Map<string, MutableCandidate>();
  const taxonomy = new Map<TaxonomyLevel, Map<string, TaxonomyBucket>>([
    ["subfield", new Map()],
    ["field", new Map()],
  ]);

  for (const observation of observations) {
    if (!isUsableObservation(observation)) continue;
    const retrievalUrl = sanitizeRetrievalUrl(observation.retrievalUrl);
    if (!retrievalUrl) continue;

    const keywords = selectObservedRecords(observation, "keywords");
    for (const record of keywords.records) {
      const evidence = evidenceFor(observation, retrievalUrl, record, "keywords");
      if (!evidence) continue;
      addCandidateEvidence(
        candidates,
        "observed_keyword",
        record.providerRecordId,
        record.text,
        evidence,
        keywords.truncation,
      );
    }

    const topics = selectObservedRecords(observation, "topics");
    for (const record of topics.records) {
      const evidence = evidenceFor(observation, retrievalUrl, record, "topics");
      if (evidence) {
        addCandidateEvidence(
          candidates,
          "observed_topic",
          record.providerRecordId,
          record.text,
          evidence,
          topics.truncation,
        );
      }
      addTaxonomyRecords(taxonomy, observation, retrievalUrl, record, "topics");
    }

    const primaryTopic = observation.primaryTopic;
    if (isUsableSourceRecord(primaryTopic) && hasMinimumScore(primaryTopic.score, OPENALEX_TOPIC_MIN_SCORE)) {
      addTaxonomyRecords(taxonomy, observation, retrievalUrl, primaryTopic, "primary_topic");
    }
  }

  addAdjacentFieldCandidates(candidates, taxonomy);
  const finalized = [...candidates.values()]
    .map(finalizeCandidate)
    .sort(compareCandidates);
  if (finalized.length === 0) return undefined;

  // Calculate all counts before applying display and transport budgets. The
  // per-candidate total is deliberately retained by `limitCandidateEvidence`.
  return fitTerminologySummary(
    limitTerminologyCandidates(finalized),
    finalized.length,
  );
}

/**
 * Apply the deterministic, per-kind candidate cap before serializing an
 * artifact. `finalized` already follows the public candidate priority order.
 */
function limitTerminologyCandidates(
  finalized: LiteratureTerminologyCandidate[],
): LiteratureTerminologyCandidate[] {
  const retained: LiteratureTerminologyCandidate[] = [];
  for (const kind of terminologyCandidateKinds()) {
    retained.push(...finalized
      .filter((candidate) => candidate.kind === kind)
      .slice(0, LITERATURE_TERMINOLOGY_CANDIDATES_PER_KIND_LIMIT)
      .map((candidate) => limitCandidateEvidence(candidate, LITERATURE_TERMINOLOGY_EVIDENCE_PER_CANDIDATE_LIMIT)));
  }
  return retained;
}

/**
 * Fit an already statically bounded summary into its artifact budget. Evidence
 * is removed from the least-priority candidates first, while retaining one
 * evidence record per candidate. Only then are tail candidates removed.
 */
function fitTerminologySummary(
  initialCandidates: LiteratureTerminologyCandidate[],
  totalCandidateCount: number,
): LiteratureTerminology {
  let candidates = initialCandidates;
  let summary = summarizeTerminology(candidates, totalCandidateCount);

  // The fixed caps normally keep artifacts small. Long provider URLs can still
  // overflow the UTF-8 transport budget, so reduce evidence before dropping a
  // candidate and retain the existing deterministic ordering throughout.
  for (let index = candidates.length - 1;
    summaryUtf8Bytes(summary) > LITERATURE_TERMINOLOGY_SUMMARY_MAX_UTF8_BYTES && index >= 0;
    index -= 1) {
    while (
      candidates[index].evidence.length > 1
      && summaryUtf8Bytes(summary) > LITERATURE_TERMINOLOGY_SUMMARY_MAX_UTF8_BYTES
    ) {
      const next = [...candidates];
      next[index] = limitCandidateEvidence(candidates[index], candidates[index].evidence.length - 1);
      candidates = next;
      summary = summarizeTerminology(candidates, totalCandidateCount);
    }
  }

  while (
    candidates.length > 0
    && summaryUtf8Bytes(summary) > LITERATURE_TERMINOLOGY_SUMMARY_MAX_UTF8_BYTES
  ) {
    candidates = candidates.slice(0, -1);
    summary = summarizeTerminology(candidates, totalCandidateCount);
  }

  return summary;
}

function summarizeTerminology(
  candidates: LiteratureTerminologyCandidate[],
  totalCandidateCount: number,
): LiteratureTerminology {
  return {
    candidates,
    // Derive support from retained evidence rather than the original raw
    // candidate. This prevents truncated evidence from leaking source IDs.
    sourcePaperIds: uniqueSorted(candidates.flatMap((candidate) =>
      candidate.evidence.map((evidence) => evidence.supportingPaperId),
    )),
    totalCandidateCount,
    truncated: candidates.length < totalCandidateCount
      || candidates.some((candidate) => candidate.evidenceTruncated),
  };
}

function summaryUtf8Bytes(summary: LiteratureTerminology): number {
  return Buffer.byteLength(JSON.stringify(summary), "utf8");
}

/**
 * Rebuild all derived candidate fields after any evidence reduction. In
 * particular, observation truncation is evidence-scoped so it cannot carry
 * unretained raw observations through a capped artifact.
 */
function limitCandidateEvidence(
  candidate: LiteratureTerminologyCandidate,
  limit: number,
): LiteratureTerminologyCandidate {
  const evidence = candidate.evidence.slice(0, Math.max(0, limit));
  const retainedObservationKeys = new Set(evidence
    .filter((item) => item.providerField === "keywords" || item.providerField === "topics")
    .map((item) => observationEvidenceKey(item)));
  const observationTruncation = (candidate.observationTruncation ?? [])
    .filter((item) => retainedObservationKeys.has(truncationObservationKey(item)))
    .slice(0, Math.min(LITERATURE_TERMINOLOGY_EVIDENCE_PER_CANDIDATE_LIMIT, evidence.length));
  const {
    evidence: _previousEvidence,
    supportingPaperIds: _previousSupportingPaperIds,
    observationTruncation: _previousObservationTruncation,
    ...rest
  } = candidate;
  return {
    ...rest,
    evidence,
    supportingPaperIds: uniqueSorted(evidence.map((item) => item.supportingPaperId)),
    evidenceTruncated: candidate.evidenceTruncated || candidate.totalEvidenceCount > evidence.length,
    ...(observationTruncation.length > 0 ? { observationTruncation } : {}),
  };
}

function observationEvidenceKey(evidence: LiteratureTerminologyEvidence): string {
  return [
    evidence.supportingPaperId,
    evidence.queryVariantId ?? "",
    evidence.providerField,
  ].join("\u0000");
}

function truncationObservationKey(truncation: LiteratureTerminologyObservationTruncation): string {
  return [
    truncation.supportingPaperId,
    truncation.queryVariantId ?? "",
    truncation.providerField,
  ].join("\u0000");
}

function terminologyCandidateKinds(): LiteratureTerminologyCandidateKind[] {
  return ["observed_keyword", "observed_topic", "adjacent_field"];
}

function isUsableObservation(observation: LiteratureTerminologyObservation): boolean {
  return observation.providerId === "openalex"
    && !observation.isParatext
    && typeof observation.supportingPaperId === "string"
    && Boolean(observation.supportingPaperId.trim())
    && typeof observation.retrievedAt === "string"
    && Boolean(observation.retrievedAt.trim());
}

function selectObservedRecords(
  observation: LiteratureTerminologyObservation,
  providerField: ObservedField,
): SelectedRecords {
  const source = Array.isArray(observation[providerField]) ? observation[providerField] : [];
  const threshold = providerField === "keywords" ? OPENALEX_KEYWORD_MIN_SCORE : OPENALEX_TOPIC_MIN_SCORE;
  const valid = source.filter(isUsableSourceRecord);
  const fieldCounts = observation.fieldCounts?.[providerField];
  const sourceRecordCount = nonNegativeInteger(fieldCounts?.sourceRecordCount) ?? source.length;
  const invalidRecordCount = nonNegativeInteger(fieldCounts?.invalidRecordCount)
    ?? Math.max(0, sourceRecordCount - valid.length);
  const eligible = valid
    .filter((record) => hasMinimumScore(record.score, threshold))
    .sort(compareSourceRecords);
  const records = eligible.slice(0, OPENALEX_TERMINOLOGY_PER_PAPER_LIMIT);
  return {
    records,
    truncation: {
      supportingPaperId: observation.supportingPaperId,
      ...(observation.queryVariantId ? { queryVariantId: observation.queryVariantId } : {}),
      providerField,
      scoreThreshold: threshold,
      perPaperLimit: OPENALEX_TERMINOLOGY_PER_PAPER_LIMIT,
      sourceRecordCount,
      validRecordCount: valid.length,
      eligibleCount: eligible.length,
      retainedCount: records.length,
      filteredByScoreCount: valid.length - eligible.length,
      invalidRecordCount,
      truncatedByLimit: eligible.length > records.length,
    },
  };
}

function addTaxonomyRecords(
  taxonomy: Map<TaxonomyLevel, Map<string, TaxonomyBucket>>,
  observation: LiteratureTerminologyObservation,
  retrievalUrl: string,
  sourceRecord: LiteratureTerminologySourceRecord,
  sourceField: "primary_topic" | "topics",
): void {
  for (const level of ["subfield", "field"] as const) {
    const record = sourceRecord[level];
    if (!isUsableTaxonomyRecord(record)) continue;
    const providerField = `${sourceField}.${level}` as LiteratureTerminologyProviderField;
    const evidence = evidenceFor(observation, retrievalUrl, {
      providerRecordId: record.providerRecordId,
      ...(record.providerUrl ? { providerUrl: record.providerUrl } : {}),
      ...(sourceRecord.score !== undefined ? { score: sourceRecord.score } : {}),
    }, providerField);
    if (!evidence) continue;
    const levelBuckets = taxonomy.get(level);
    if (!levelBuckets) continue;
    const existing = levelBuckets.get(record.providerRecordId);
    if (existing) {
      existing.evidence.push(evidence);
      if (compareText(record.text, existing.record.text) < 0) existing.record = record;
    } else {
      levelBuckets.set(record.providerRecordId, { record, evidence: [evidence] });
    }
  }
}

function addAdjacentFieldCandidates(
  candidates: Map<string, MutableCandidate>,
  taxonomy: Map<TaxonomyLevel, Map<string, TaxonomyBucket>>,
): void {
  for (const level of ["subfield", "field"] as const) {
    const buckets = taxonomy.get(level);
    if (!buckets || buckets.size === 0) continue;
    const entries = [...buckets.entries()];
    const core = [...entries].sort((left, right) => {
      const supportDifference = uniqueSupportingPaperCount(right[1].evidence) - uniqueSupportingPaperCount(left[1].evidence);
      if (supportDifference !== 0) return supportDifference;
      return compareText(left[0], right[0]) || compareText(left[1].record.text, right[1].record.text);
    })[0];
    if (!core) continue;

    for (const [recordId, bucket] of entries) {
      if (recordId === core[0] || uniqueSupportingPaperCount(bucket.evidence) < MINIMUM_ADJACENT_FIELD_SUPPORT) continue;
      const inference: LiteratureTerminologyInference = {
        basis: "multi_paper_taxonomy_contrast",
        level,
        coreRecordId: core[0],
        coreText: core[1].record.text,
        minimumSupportingPapers: MINIMUM_ADJACENT_FIELD_SUPPORT,
      };
      for (const evidence of bucket.evidence) {
        addCandidateEvidence(
          candidates,
          "adjacent_field",
          recordId,
          bucket.record.text,
          evidence,
          undefined,
          inference,
        );
      }
    }
  }
}

function evidenceFor(
  observation: LiteratureTerminologyObservation,
  retrievalUrl: string,
  record: Pick<LiteratureTerminologySourceRecord, "providerRecordId" | "providerUrl" | "score">,
  providerField: LiteratureTerminologyProviderField,
): LiteratureTerminologyEvidence | undefined {
  const providerUrl = sanitizeRetrievalUrl(record.providerUrl);
  const providerScore = normalizedProviderScore(record.score);
  if (!providerUrl) return undefined;
  return {
    supportingPaperId: observation.supportingPaperId,
    ...(observation.queryVariantId ? { queryVariantId: observation.queryVariantId } : {}),
    retrievalUrl,
    retrievedAt: observation.retrievedAt,
    ...(providerScore !== undefined ? { providerScore } : {}),
    providerId: "openalex",
    providerRecordId: record.providerRecordId,
    providerUrl,
    providerField,
  };
}

function addCandidateEvidence(
  candidates: Map<string, MutableCandidate>,
  kind: LiteratureTerminologyCandidateKind,
  providerRecordId: string,
  text: string,
  evidence: LiteratureTerminologyEvidence,
  truncation?: LiteratureTerminologyObservationTruncation,
  inference?: LiteratureTerminologyInference,
): void {
  const id = `openalex:${kind}:${providerRecordId}`;
  let candidate = candidates.get(id);
  if (!candidate) {
    candidate = {
      id,
      text,
      kind,
      supportingPaperIds: new Set(),
      evidence: new Map(),
      observationTruncation: new Map(),
      ...(inference ? { inference } : {}),
    };
    candidates.set(id, candidate);
  } else if (compareText(text, candidate.text) < 0) {
    candidate.text = text;
  }
  candidate.supportingPaperIds.add(evidence.supportingPaperId);
  candidate.evidence.set(evidenceKey(evidence), evidence);
  if (truncation) candidate.observationTruncation.set(truncationKey(truncation), truncation);
}

function finalizeCandidate(candidate: MutableCandidate): LiteratureTerminologyCandidate {
  const evidence = [...candidate.evidence.values()].sort(compareEvidence);
  const truncation = [...candidate.observationTruncation.values()].sort(compareTruncation);
  return {
    id: candidate.id,
    text: candidate.text,
    kind: candidate.kind,
    supportingPaperIds: uniqueSorted([...candidate.supportingPaperIds]),
    evidence,
    totalEvidenceCount: evidence.length,
    evidenceTruncated: false,
    ...(truncation.length > 0 ? { observationTruncation: truncation } : {}),
    ...(candidate.inference ? { inference: candidate.inference } : {}),
  };
}

function isUsableSourceRecord(value: unknown): value is LiteratureTerminologySourceRecord {
  if (!isRecord(value)) return false;
  return nonEmptyString(value.providerRecordId) !== undefined
    && nonEmptyString(value.text) !== undefined
    && normalizedProviderScore(value.score) !== undefined;
}

function isUsableTaxonomyRecord(value: unknown): value is LiteratureTerminologyTaxonomyLevelRecord {
  if (!isRecord(value)) return false;
  return nonEmptyString(value.providerRecordId) !== undefined && nonEmptyString(value.text) !== undefined;
}

function hasMinimumScore(value: unknown, minimum: number): boolean {
  const score = normalizedProviderScore(value);
  return score !== undefined && score >= minimum;
}

function compareSourceRecords(left: LiteratureTerminologySourceRecord, right: LiteratureTerminologySourceRecord): number {
  const scoreDifference = (right.score ?? Number.NEGATIVE_INFINITY) - (left.score ?? Number.NEGATIVE_INFINITY);
  if (scoreDifference !== 0) return scoreDifference;
  return compareText(left.providerRecordId, right.providerRecordId) || compareText(left.text, right.text);
}

function compareCandidates(left: LiteratureTerminologyCandidate, right: LiteratureTerminologyCandidate): number {
  const kindDifference = candidateKindOrder(left.kind) - candidateKindOrder(right.kind);
  if (kindDifference !== 0) return kindDifference;
  const supportDifference = right.supportingPaperIds.length - left.supportingPaperIds.length;
  if (supportDifference !== 0) return supportDifference;
  return compareText(left.text, right.text) || compareText(left.id, right.id);
}

function candidateKindOrder(kind: LiteratureTerminologyCandidateKind): number {
  return kind === "observed_keyword" ? 0 : kind === "observed_topic" ? 1 : 2;
}

function uniqueSupportingPaperCount(evidence: LiteratureTerminologyEvidence[]): number {
  return new Set(evidence.map((item) => item.supportingPaperId)).size;
}

function evidenceKey(evidence: LiteratureTerminologyEvidence): string {
  return [
    evidence.supportingPaperId,
    evidence.queryVariantId ?? "",
    evidence.retrievalUrl,
    evidence.providerId,
    evidence.providerRecordId,
    evidence.providerUrl ?? "",
    evidence.providerField,
  ].join("\u0000");
}

function truncationKey(truncation: LiteratureTerminologyObservationTruncation): string {
  return [
    truncation.supportingPaperId,
    truncation.queryVariantId ?? "",
    truncation.providerField,
  ].join("\u0000");
}

function compareEvidence(left: LiteratureTerminologyEvidence, right: LiteratureTerminologyEvidence): number {
  return compareText(left.supportingPaperId, right.supportingPaperId)
    || compareText(left.queryVariantId ?? "", right.queryVariantId ?? "")
    || compareText(left.retrievalUrl, right.retrievalUrl)
    || compareText(left.providerField, right.providerField)
    || compareText(left.providerRecordId, right.providerRecordId);
}

function compareTruncation(
  left: LiteratureTerminologyObservationTruncation,
  right: LiteratureTerminologyObservationTruncation,
): number {
  return compareText(left.supportingPaperId, right.supportingPaperId)
    || compareText(left.queryVariantId ?? "", right.queryVariantId ?? "")
    || compareText(left.providerField, right.providerField);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))].sort(compareText);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedProviderScore(value: unknown): number | undefined {
  const score = finiteNumber(value);
  return score !== undefined && score >= 0 && score <= 1 ? score : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
