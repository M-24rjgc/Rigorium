import type {
  DeepSeekNativeSearchSettings,
  ResolvedDeepSeekNativeSearchSettings,
} from "./types.js";

export const DEEPSEEK_NATIVE_SEARCH_DEFAULT_ENDPOINT =
  "https://api.deepseek.com/anthropic/v1/messages";
export const DEEPSEEK_NATIVE_SEARCH_DEFAULT_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_NATIVE_SEARCH_TOOL_VARIANTS = [
  "web_search_20260209",
  "web_search_20250305",
] as const;

export function isOfficialDeepSeekNativeSearchEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}

export function resolveDeepSeekNativeSearchSettings(
  settings: DeepSeekNativeSearchSettings = {},
  environment: Record<string, string | undefined> = process.env,
): ResolvedDeepSeekNativeSearchSettings {
  return {
    apiKey:
      readConfiguredValue(settings.apiKey) ??
      readEnvironmentValue(environment, "DEEPSEEK_NATIVE_SEARCH_API_KEY") ??
      readEnvironmentValue(environment, "DEEPSEEK_API_KEY"),
    endpoint:
      readConfiguredValue(settings.endpoint) ??
      readEnvironmentValue(environment, "DEEPSEEK_NATIVE_SEARCH_ENDPOINT") ??
      DEEPSEEK_NATIVE_SEARCH_DEFAULT_ENDPOINT,
    model:
      readConfiguredValue(settings.model) ??
      readEnvironmentValue(environment, "DEEPSEEK_NATIVE_SEARCH_MODEL") ??
      DEEPSEEK_NATIVE_SEARCH_DEFAULT_MODEL,
  };
}

export function normalizeDeepSeekNativeSearchToolVariants(value: readonly string[] | undefined): string[] {
  const values = value && value.length > 0 ? value : DEEPSEEK_NATIVE_SEARCH_TOOL_VARIANTS;
  const unique = new Set<string>();
  for (const candidate of values) {
    const trimmed = candidate.trim();
    if (trimmed) unique.add(trimmed);
  }
  return unique.size > 0 ? [...unique] : [...DEEPSEEK_NATIVE_SEARCH_TOOL_VARIANTS];
}

function readConfiguredValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readEnvironmentValue(environment: Record<string, string | undefined>, name: string): string | undefined {
  return readConfiguredValue(environment[name]);
}
