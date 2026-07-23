import type {
  LiteratureQueryLanguage,
  LiteratureQueryVariantProvenance,
  LiteratureSearchMode,
  LiteratureSpecificQueryScope,
  SearchQueryVariantCategory,
} from "../types.js";

export type {
  LiteratureQueryLanguage,
  LiteratureQueryVariantProvenance,
  LiteratureSearchMode,
  LiteratureSpecificQueryScope,
} from "../types.js";

/**
 * Semantic metadata for the literature tools.  It deliberately records an
 * agent's selection rather than translating, expanding, or changing a query
 * by itself.  Source adapters continue to receive the exact query text.
 */

export const LITERATURE_SEARCH_MODES = ["broad", "specific", "citation", "deep"] as const;

export const LITERATURE_QUERY_VARIANT_PROVENANCE_KINDS = [
  "agent_selected",
  "terminology_candidate",
  "translation",
] as const;

export type LiteratureQueryVariantProvenanceKind =
  (typeof LITERATURE_QUERY_VARIANT_PROVENANCE_KINDS)[number];

export type LiteratureQueryVariantSemantics = {
  id: string;
  query: string;
  language: LiteratureQueryLanguage;
  provenance: LiteratureQueryVariantProvenance;
  category?: SearchQueryVariantCategory;
  rationale?: string;
};

export type LiteratureSearchQuerySemantics = {
  mode: "broad" | "specific";
  query: string;
  language: LiteratureQueryLanguage;
  specificity?: LiteratureSpecificQueryScope;
  queryVariants: LiteratureQueryVariantSemantics[];
};

export type LiteratureQueryVariantSemanticsInput = {
  query: unknown;
  language?: unknown;
  category?: unknown;
  rationale?: unknown;
  provenance?: unknown;
};

export type LiteratureSearchQuerySemanticsInput = {
  mode?: unknown;
  query: unknown;
  language?: unknown;
  specificity?: unknown;
  queryVariants?: unknown;
};

export class LiteratureSearchSemanticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiteratureSearchSemanticsError";
  }
}

/**
 * Normalize a declared mode without turning prose into an execution plan.
 * Citation and deep modes are consumed by their existing dedicated tools.
 */
export function normalizeLiteratureSearchMode(
  value: unknown,
  fallback: LiteratureSearchMode = "broad",
): LiteratureSearchMode {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !LITERATURE_SEARCH_MODES.includes(value as LiteratureSearchMode)) {
    throw new LiteratureSearchSemanticsError(
      "Literature search mode must be broad, specific, citation, or deep.",
    );
  }
  return value as LiteratureSearchMode;
}

/**
 * Produce auditable broad/specific query semantics. This does not infer
 * terminology or translate text; multilingual variants are always supplied by
 * the caller and retain their declared provenance.
 */
export function normalizeLiteratureSearchQuerySemantics(
  input: LiteratureSearchQuerySemanticsInput,
): LiteratureSearchQuerySemantics {
  if (!isRecord(input)) {
    throw new LiteratureSearchSemanticsError("Literature search semantics require an input object.");
  }
  const mode = normalizeLiteratureSearchMode(input.mode);
  if (mode === "citation" || mode === "deep") {
    throw new LiteratureSearchSemanticsError(
      `${mode} mode requires its dedicated literature tool rather than a query-search plan.`,
    );
  }

  const query = requiredText(input.query, "Literature search query");
  const language = normalizeLiteratureQueryLanguage(input.language, "query language");
  const specificity = mode === "specific"
    ? normalizeSpecificity(input.specificity)
    : undefined;
  if (mode === "broad" && input.specificity !== undefined) {
    throw new LiteratureSearchSemanticsError(
      "Broad literature search mode cannot include a specific-query scope.",
    );
  }

  const alternatives = normalizeAlternativeInputs(input.queryVariants);
  if (alternatives.length > 3) {
    throw new LiteratureSearchSemanticsError("Literature search accepts at most three alternative query variants.");
  }

  const variants: LiteratureQueryVariantSemantics[] = [{
    id: "primary",
    query,
    language,
    provenance: { kind: "agent_selected" },
    category: "primary",
  }];
  const fingerprints = new Set([queryFingerprint(query)]);

  for (const alternative of alternatives) {
    const alternativeQuery = requiredText(alternative.query, "Alternative query variant");
    const fingerprint = queryFingerprint(alternativeQuery);
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);

    const id = `alternative-${variants.length}`;
    const alternativeLanguage = normalizeLiteratureQueryLanguage(alternative.language, `${id} language`);
    const category = normalizeAlternativeCategory(alternative.category, id);
    const rationale = optionalText(alternative.rationale, `${id} rationale`);
    const provenance = normalizeVariantProvenance(
      alternative.provenance,
      variants,
      alternativeLanguage,
    );
    variants.push({
      id,
      query: alternativeQuery,
      language: alternativeLanguage,
      provenance,
      ...(category ? { category } : {}),
      ...(rationale ? { rationale } : {}),
    });
  }

  return {
    mode,
    query,
    language,
    ...(specificity ? { specificity } : {}),
    queryVariants: variants,
  };
}

/** Canonicalize a single declared BCP-47 tag without attempting language detection. */
export function normalizeLiteratureQueryLanguage(
  value: unknown,
  label = "language",
): LiteratureQueryLanguage {
  if (value === undefined) return { tag: "und", source: "undetermined" };
  if (typeof value !== "string" || !value.trim()) {
    throw new LiteratureSearchSemanticsError(`${label} must be a non-empty BCP-47 language tag when provided.`);
  }
  const supplied = value.trim();
  if (supplied.length > 64) {
    throw new LiteratureSearchSemanticsError(`${label} exceeds the maximum BCP-47 tag length.`);
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(supplied);
    if (!canonical) throw new Error("No canonical tag returned.");
    return { tag: canonical, source: "declared" };
  } catch {
    throw new LiteratureSearchSemanticsError(`${label} must be a valid BCP-47 language tag.`);
  }
}

function normalizeSpecificity(value: unknown): LiteratureSpecificQueryScope {
  if (!isRecord(value)) {
    throw new LiteratureSearchSemanticsError("Specific literature search mode requires a specific-query scope.");
  }
  const focus = optionalText(value.focus, "Specific-query focus");
  const requiredConcepts = normalizeConcepts(value.requiredConcepts, "Specific-query required concepts");
  const excludedConcepts = normalizeConcepts(value.excludedConcepts, "Specific-query excluded concepts");
  if (!focus && requiredConcepts.length === 0 && excludedConcepts.length === 0) {
    throw new LiteratureSearchSemanticsError(
      "Specific literature search mode requires a focus, required concept, or excluded concept.",
    );
  }
  return {
    ...(focus ? { focus } : {}),
    requiredConcepts,
    excludedConcepts,
  };
}

function normalizeAlternativeInputs(value: unknown): LiteratureQueryVariantSemanticsInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new LiteratureSearchSemanticsError("Alternative query variants must be an array when provided.");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new LiteratureSearchSemanticsError(`Alternative query variant ${index + 1} must be an object.`);
    }
    return {
      query: item.query,
      ...(item.language !== undefined ? { language: item.language } : {}),
      ...(item.category !== undefined ? { category: item.category } : {}),
      ...(item.rationale !== undefined ? { rationale: item.rationale } : {}),
      ...(item.provenance !== undefined ? { provenance: item.provenance } : {}),
    };
  });
}

function normalizeVariantProvenance(
  value: unknown,
  earlierVariants: LiteratureQueryVariantSemantics[],
  language: LiteratureQueryLanguage,
): LiteratureQueryVariantProvenance {
  if (value === undefined) {
    if (isDeclaredCrossLanguage(earlierVariants[0]?.language, language)) {
      throw new LiteratureSearchSemanticsError(
        "A cross-language query variant needs translation or terminology provenance.",
      );
    }
    return { kind: "agent_selected" };
  }
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new LiteratureSearchSemanticsError("Query variant provenance requires a known kind.");
  }

  switch (value.kind) {
    case "agent_selected":
      if (isDeclaredCrossLanguage(earlierVariants[0]?.language, language)) {
        throw new LiteratureSearchSemanticsError(
          "A cross-language query variant needs translation or terminology provenance.",
        );
      }
      return { kind: "agent_selected" };
    case "terminology_candidate": {
      const artifactId = requiredText(value.artifactId, "Terminology artifact ID");
      const candidateIds = normalizeStableIds(value.candidateIds, "Terminology candidate IDs");
      if (candidateIds.length === 0) {
        throw new LiteratureSearchSemanticsError("Terminology provenance requires at least one candidate ID.");
      }
      return { kind: "terminology_candidate", artifactId, candidateIds };
    }
    case "translation": {
      const sourceVariantId = requiredText(value.sourceVariantId, "Translation source variant ID");
      const sourceVariant = earlierVariants.find((variant) => variant.id === sourceVariantId);
      if (!sourceVariant) {
        throw new LiteratureSearchSemanticsError(
          "Translation provenance must reference an earlier query variant in the same search.",
        );
      }
      const sourceLanguage = normalizeLiteratureQueryLanguage(value.sourceLanguage, "Translation source language");
      if (sourceLanguage.tag !== sourceVariant.language.tag) {
        throw new LiteratureSearchSemanticsError(
          "Translation source language must match the referenced source query variant.",
        );
      }
      if (sameBaseLanguage(sourceLanguage.tag, language.tag)) {
        throw new LiteratureSearchSemanticsError(
          "Translation provenance must target a different language from its source variant.",
        );
      }
      const method = value.method === undefined ? "agent_selected" : value.method;
      if (method !== "agent_selected" && method !== "user_supplied") {
        throw new LiteratureSearchSemanticsError("Translation provenance method must be agent_selected or user_supplied.");
      }
      return {
        kind: "translation",
        sourceVariantId,
        sourceLanguage: sourceLanguage.tag,
        method,
      };
    }
    default:
      throw new LiteratureSearchSemanticsError(
        "Query variant provenance must be agent_selected, terminology_candidate, or translation.",
      );
  }
}

function normalizeAlternativeCategory(
  value: unknown,
  variantId: string,
): Exclude<SearchQueryVariantCategory, "primary"> | undefined {
  if (value === undefined) return undefined;
  if (
    value !== "synonym"
    && value !== "abbreviation"
    && value !== "historical_term"
    && value !== "adjacent_field"
  ) {
    throw new LiteratureSearchSemanticsError(
      `${variantId} category must be synonym, abbreviation, historical_term, or adjacent_field.`,
    );
  }
  return value;
}

function normalizeConcepts(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) {
    throw new LiteratureSearchSemanticsError(`${label} must contain at most twelve text values.`);
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of value) {
    const text = requiredText(item, label);
    const fingerprint = queryFingerprint(text);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    values.push(text);
  }
  return values;
}

function normalizeStableIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 24) {
    throw new LiteratureSearchSemanticsError(`${label} must contain at most twenty-four stable IDs.`);
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    const id = requiredText(item, label);
    if (id.length > 512) {
      throw new LiteratureSearchSemanticsError(`${label} contains an ID that is too long.`);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, label);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LiteratureSearchSemanticsError(`${label} must be non-empty text.`);
  }
  const text = value.trim();
  if (text.length > 2_000) {
    throw new LiteratureSearchSemanticsError(`${label} is too long.`);
  }
  return text;
}

function queryFingerprint(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function sameBaseLanguage(left: string, right: string): boolean {
  return left.split("-", 1)[0].toLocaleLowerCase("en-US") === right.split("-", 1)[0].toLocaleLowerCase("en-US");
}

function isDeclaredCrossLanguage(
  source: LiteratureQueryLanguage | undefined,
  target: LiteratureQueryLanguage,
): boolean {
  return Boolean(
    source
    && source.source === "declared"
    && target.source === "declared"
    && !sameBaseLanguage(source.tag, target.tag),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
