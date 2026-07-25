import type { ResearchArtifactRef } from "../artifacts/index.js";
import type {
  EvidenceMaturity,
  ManuscriptSectionKind,
  ManuscriptStatementBinding,
  SectionGenerationAudit,
  SectionGenerationContract,
} from "./types.js";
import { MANUSCRIPT_LIMITS, requireCitationKey, requireIdentifier, requireText, uniqueSorted } from "./validation.js";

const MATURITY_RANK: Readonly<Record<EvidenceMaturity, number>> = Object.freeze({
  none: 0,
  citation_only: 1,
  evidence_snapshot: 2,
  observed_result: 3,
  replicated_result: 4,
});

export function defaultMinimumMaturityForSection(kind: ManuscriptSectionKind): EvidenceMaturity {
  if (kind === "results" || kind === "discussion" || kind === "conclusion") return "observed_result";
  if (kind === "related_work" || kind === "abstract") return "evidence_snapshot";
  if (kind === "introduction" || kind === "method" || kind === "experiments") return "citation_only";
  return "none";
}

export function normalizeSectionGenerationContract(contract: SectionGenerationContract): SectionGenerationContract {
  if (!contract || typeof contract !== "object") throw new TypeError("Section generation contracts must be objects.");
  if (!Object.hasOwn(MATURITY_RANK, contract.minimumMaturity)) throw new TypeError("Section minimumMaturity is invalid.");
  if (!["outline", "draft", "preserve"].includes(contract.requestedOutput)) throw new TypeError("Section requestedOutput is invalid.");
  if (!Array.isArray(contract.statements)) throw new TypeError("Section statements must be an array.");
  const statements = contract.statements.map(normalizeStatementBinding);
  const ids = new Set<string>();
  for (const statement of statements) {
    if (ids.has(statement.statementId)) throw new TypeError(`Statement ${statement.statementId} is duplicated within its section.`);
    ids.add(statement.statementId);
  }
  return Object.freeze({
    sectionId: requireIdentifier(contract.sectionId, "sectionId"),
    kind: contract.kind,
    title: requireText(contract.title, "section title", 512),
    requestedOutput: contract.requestedOutput,
    minimumMaturity: contract.minimumMaturity,
    statements: Object.freeze(statements),
    ...(contract.scopeNote === undefined ? {} : { scopeNote: requireText(contract.scopeNote, "section scopeNote", 4_000) }),
  });
}

export function auditSectionGeneration(contract: SectionGenerationContract): SectionGenerationAudit {
  const normalized = normalizeSectionGenerationContract(contract);
  const blockers: Array<SectionGenerationAudit["blockers"][number]> = [];
  let strongest: EvidenceMaturity = "none";
  for (const statement of normalized.statements) {
    if (MATURITY_RANK[statement.maturity] > MATURITY_RANK[strongest]) strongest = statement.maturity;
    if (MATURITY_RANK[statement.maturity] < MATURITY_RANK[normalized.minimumMaturity]) {
      blockers.push(Object.freeze({
        code: "insufficient_maturity" as const,
        statementId: statement.statementId,
        message: `${statement.statementId} is ${statement.maturity}; ${normalized.minimumMaturity} is required.`,
      }));
    }
    if ((statement.kind === "context" || statement.kind === "prior_work")
      && MATURITY_RANK[statement.maturity] >= MATURITY_RANK.citation_only
      && statement.citationKeys.length === 0) {
      blockers.push(Object.freeze({
        code: "missing_citation" as const,
        statementId: statement.statementId,
        message: `${statement.statementId} needs at least one citation key.`,
      }));
    }
    if (MATURITY_RANK[statement.maturity] >= MATURITY_RANK.evidence_snapshot
      && statement.evidenceRefs.length === 0
      && statement.figureTableRefs.length === 0) {
      blockers.push(Object.freeze({
        code: "missing_evidence" as const,
        statementId: statement.statementId,
        message: `${statement.statementId} declares evidence maturity without an evidence or figure/table artifact.`,
      }));
    }
    if (statement.kind === "result" && MATURITY_RANK[statement.maturity] < MATURITY_RANK.observed_result) {
      blockers.push(Object.freeze({
        code: "missing_observed_result" as const,
        statementId: statement.statementId,
        message: `${statement.statementId} cannot be drafted as a result before an observed result is linked.`,
      }));
    }
  }
  if (normalized.statements.length === 0 && MATURITY_RANK[normalized.minimumMaturity] > MATURITY_RANK.none) {
    blockers.push(Object.freeze({
      code: "insufficient_maturity" as const,
      message: `Section ${normalized.sectionId} has no evidence-bound statements.`,
    }));
  }
  blockers.sort((left, right) => {
    const byStatement = (left.statementId ?? "").localeCompare(right.statementId ?? "", "en");
    return byStatement || left.code.localeCompare(right.code, "en");
  });
  const ready = blockers.length === 0;
  const allowedOutput = normalized.requestedOutput === "preserve"
    ? "preserve_only"
    : normalized.requestedOutput === "draft" && ready
      ? "draft_allowed"
      : "outline_only";
  return Object.freeze({
    sectionId: normalized.sectionId,
    status: ready ? "ready" : "blocked",
    allowedOutput,
    strongestMaturity: strongest,
    blockers: Object.freeze(blockers),
  });
}

export function normalizeStatementBinding(binding: ManuscriptStatementBinding): ManuscriptStatementBinding {
  if (!binding || typeof binding !== "object") throw new TypeError("Statement bindings must be objects.");
  if (!Object.hasOwn(MATURITY_RANK, binding.maturity)) throw new TypeError("Statement maturity is invalid.");
  if (!["context", "prior_work", "method", "result", "interpretation", "limitation"].includes(binding.kind)) {
    throw new TypeError("Statement kind is invalid.");
  }
  if (!["user", "import", "agent_assisted"].includes(binding.textOrigin)) throw new TypeError("Statement textOrigin is invalid.");
  return Object.freeze({
    statementId: requireIdentifier(binding.statementId, "statementId"),
    kind: binding.kind,
    maturity: binding.maturity,
    citationKeys: Object.freeze(uniqueSorted((binding.citationKeys ?? []).map((key) => requireCitationKey(key)))),
    evidenceRefs: Object.freeze(uniqueRefs(binding.evidenceRefs ?? [], "evidenceRefs")),
    figureTableRefs: Object.freeze(uniqueRefs(binding.figureTableRefs ?? [], "figureTableRefs", "figure_table")),
    textOrigin: binding.textOrigin,
  });
}

export function validateSectionCollection(sections: readonly SectionGenerationContract[]): SectionGenerationContract[] {
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > MANUSCRIPT_LIMITS.maxSections) {
    throw new TypeError(`Manuscript sections must contain between 1 and ${MANUSCRIPT_LIMITS.maxSections} entries.`);
  }
  const normalized = sections.map(normalizeSectionGenerationContract);
  const seen = new Set<string>();
  for (const section of normalized) {
    if (seen.has(section.sectionId)) throw new TypeError(`Section ${section.sectionId} is duplicated.`);
    seen.add(section.sectionId);
  }
  return normalized;
}

function uniqueRefs(
  refs: readonly ResearchArtifactRef[],
  label: string,
  expectedKind?: ResearchArtifactRef["kind"],
): ResearchArtifactRef[] {
  const seen = new Set<string>();
  return refs.map((ref, index) => {
    if (!ref || typeof ref !== "object") throw new TypeError(`${label}[${index}] must be an artifact reference.`);
    if (expectedKind !== undefined && ref.kind !== expectedKind) throw new TypeError(`${label}[${index}] must reference ${expectedKind}.`);
    const key = `${ref.artifactId}@${ref.revision}`;
    if (seen.has(key)) throw new TypeError(`${label} contains duplicate ${key}.`);
    seen.add(key);
    return Object.freeze({ ...ref });
  });
}

