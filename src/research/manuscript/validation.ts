import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

export const MANUSCRIPT_LIMITS = Object.freeze({
  maxIdentifier: 256,
  maxText: 64_000,
  maxLatex: 4_000_000,
  maxCitations: 5_000,
  maxFigureTableItems: 512,
  maxSections: 128,
});

export function hashText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function hashBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function requireHash(value: string, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hash with the sha256: prefix.`);
  }
  return value;
}

export function requireIdentifier(value: string, label: string): string {
  const normalized = requireText(value, label, MANUSCRIPT_LIMITS.maxIdentifier);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized)) {
    throw new TypeError(`${label} must be a safe identifier.`);
  }
  return normalized;
}

export function requireCitationKey(value: string, label = "citationKey"): string {
  const normalized = requireText(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_:.+-]*$/u.test(normalized)) {
    throw new TypeError(`${label} contains characters that are unsafe in BibTeX and LaTeX citation commands.`);
  }
  return normalized;
}

export function requireText(value: string, label: string, maximum: number = MANUSCRIPT_LIMITS.maxText): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum) {
    throw new TypeError(`${label} must be trimmed non-empty text no longer than ${maximum} characters.`);
  }
  if (/\u0000/u.test(value)) throw new TypeError(`${label} must not contain NUL characters.`);
  return value;
}

export function requireLatex(value: string, label = "latex"): string {
  return requireText(value, label, MANUSCRIPT_LIMITS.maxLatex);
}

export function requireSafeRelativePath(value: string, label: string): string {
  const normalized = requireText(value, label, 4_096).replace(/\\/gu, "/");
  if (isAbsolute(normalized) || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new TypeError(`${label} must be project-relative.`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(`${label} must not contain empty, current-directory, or parent-directory segments.`);
  }
  return normalized;
}

export function resolveWithin(root: string, path: string, label = "path"): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolvedPath;
  throw new TypeError(`${label} must remain within the current Project.`);
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

export function stripLatexComments(source: string): string {
  return source.split(/\r?\n/u).map((line) => {
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]!;
      if (character === "%" && !escaped) return line.slice(0, index);
      if (character === "\\") {
        escaped = !escaped;
      } else {
        escaped = false;
      }
    }
    return line;
  }).join("\n");
}

export function requirePositiveInteger(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
