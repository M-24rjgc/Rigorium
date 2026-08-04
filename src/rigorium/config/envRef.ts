/**
 * `${VAR}` environment-reference expansion for config credential fields.
 *
 * Config files should be able to say `apiKey: "${OPENAI_API_KEY}"` and get
 * the value at load time, matching the model-provider path
 * (resolveCredentials.resolveApiKey). Unlike that path, this helper is
 * tolerant: an unset variable leaves the raw literal in place, so the
 * caller's completeness checks report the section as incomplete instead of
 * crashing boot. Credential-bearing env values are trimmed (a trailing
 * newline from a `.env` file would otherwise be pasted into a Bearer token).
 */

export const ENV_REFERENCE_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export function expandEnvReference(value: string, env: Record<string, string | undefined> = process.env): string {
  const match = ENV_REFERENCE_PATTERN.exec(value.trim());
  if (!match) {
    return value;
  }
  const raw = env[match[1]];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : value;
}

/** True when `value` is a `${VAR}` reference (possibly unresolved). */
export function isEnvReference(value: string): boolean {
  return ENV_REFERENCE_PATTERN.test(value.trim());
}
