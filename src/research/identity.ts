/**
 * Canonical, provider-neutral paper identifiers.
 *
 * These helpers intentionally accept the common display forms returned by
 * metadata providers (resolver URLs, `doi:`/`arXiv:` prefixes, and versioned
 * arXiv URLs), but only return identifiers that are safe to use for identity
 * matching. They do not perform network resolution.
 */

export type NormalizedArxivIdentifier = {
  /** Versionless canonical arXiv identifier, lower-cased for stable matching. */
  id: string;
  /** Numeric version as supplied by arXiv, for example 3, when one is present. */
  version?: number;
};

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/u;
const ARXIV_ID_PATTERN = "(?:[a-z-]+(?:\\.[a-z-]+)?\\/\\d{7}|\\d{4}\\.\\d{4,5})";
const ARXIV_DIRECT_PATTERN = new RegExp(
  `^(?:arxiv:\\s*)?(${ARXIV_ID_PATTERN})(?:\\s*(v\\d+))?(?:\\.pdf)?$`,
  "iu",
);
const ARXIV_EMBEDDED_PATTERN = new RegExp(
  `(?:arxiv(?:\\.org\\/(?:abs|pdf)\\/|:\\s*|\\s+))(${ARXIV_ID_PATTERN})(?:\\s*(v\\d+))?(?:\\.pdf)?`,
  "iu",
);

export function normalizeDoi(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const doi = raw
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
    .replace(/^doi:\s*/iu, "")
    .replace(/[\s.,;]+$/u, "")
    .toLowerCase();
  return DOI_PATTERN.test(doi) ? doi : undefined;
}

/**
 * Parses modern and legacy arXiv identifiers and preserves the supplied
 * version separately from the canonical, versionless identity.
 */
export function normalizeArxivIdentifier(value: unknown): NormalizedArxivIdentifier | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const match = ARXIV_DIRECT_PATTERN.exec(raw) ?? ARXIV_EMBEDDED_PATTERN.exec(raw);
  const id = match?.[1]?.toLowerCase();
  if (!id) return undefined;
  const version = normalizeArxivVersion(match?.[2]);
  return { id, ...(version !== undefined ? { version } : {}) };
}

/** Returns only the versionless canonical arXiv identifier. */
export function normalizeArxiv(value: unknown): string | undefined {
  return normalizeArxivIdentifier(value)?.id;
}

/** Accept only a canonical arXiv version marker such as v12. */
export function normalizeArxivVersion(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  const text = stringValue(value)?.toLowerCase();
  if (!text || !/^v\d+$/u.test(text)) return undefined;
  const version = Number(text.slice(1));
  return Number.isSafeInteger(version) && version >= 1 ? version : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 4_096) : undefined;
}
