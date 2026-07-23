import {
  DEEPSEEK_NATIVE_SEARCH_DEFAULT_ENDPOINT,
  isOfficialDeepSeekNativeSearchEndpoint,
} from "../../deepseek-native-search/config.js";
import type { DeepSeekNativeSearchSettings } from "../../deepseek-native-search/types.js";
import type { PilotDeepSeekNativeSearchConfig } from "./types.js";

type DeepSeekModelProviderCandidate = {
  id?: unknown;
  url?: unknown;
  apiKey?: unknown;
};

export type ResolveDeepSeekNativeSearchConfigInput = {
  nativeSearch?: PilotDeepSeekNativeSearchConfig | DeepSeekNativeSearchSettings;
  modelProviders?: Record<string, DeepSeekModelProviderCandidate | undefined>;
  environment?: Record<string, string | undefined>;
};

export type DeepSeekNativeSearchConfigResolution = {
  settings: DeepSeekNativeSearchSettings;
  apiKeySource?: "native_search" | "environment" | "model_provider";
  reusedProviderId?: string;
};

/**
 * Bridge application configuration to the independent native-search module.
 * The search module itself only understands explicit settings and environment
 * variables; this adapter owns PilotDeck's optional model-provider reuse.
 */
export function resolveDeepSeekNativeSearchConfig(
  input: ResolveDeepSeekNativeSearchConfigInput,
): DeepSeekNativeSearchConfigResolution {
  const environment = input.environment ?? process.env;
  const nativeSearch = input.nativeSearch;
  const nativeApiKey = resolveCredential(nativeSearch?.apiKey, environment);
  const endpoint = readNonEmptyString(nativeSearch?.endpoint);
  const model = readNonEmptyString(nativeSearch?.model);
  const effectiveEndpoint = endpoint ??
    readNonEmptyString(environment.DEEPSEEK_NATIVE_SEARCH_ENDPOINT) ??
    DEEPSEEK_NATIVE_SEARCH_DEFAULT_ENDPOINT;

  if (nativeApiKey) {
    return {
      settings: {
        apiKey: nativeApiKey,
        ...(endpoint ? { endpoint } : {}),
        ...(model ? { model } : {}),
      },
      apiKeySource: "native_search",
    };
  }

  // Preserve the core module's documented environment precedence before
  // falling back to a model-provider credential.
  const environmentApiKey =
    readNonEmptyString(environment.DEEPSEEK_NATIVE_SEARCH_API_KEY) ??
    readNonEmptyString(environment.DEEPSEEK_API_KEY);
  if (environmentApiKey && isOfficialDeepSeekNativeSearchEndpoint(effectiveEndpoint)) {
    return {
      settings: {
        apiKey: environmentApiKey,
        ...(endpoint ? { endpoint } : {}),
        ...(model ? { model } : {}),
      },
      apiKeySource: "environment",
    };
  }

  const reusableProvider = isOfficialDeepSeekNativeSearchEndpoint(effectiveEndpoint)
    ? findReusableDeepSeekModelProvider(input.modelProviders, environment)
    : undefined;
  return {
    settings: {
      ...(reusableProvider ? { apiKey: reusableProvider.apiKey } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(model ? { model } : {}),
    },
    ...(reusableProvider
      ? { apiKeySource: "model_provider" as const, reusedProviderId: reusableProvider.id }
      : {}),
  };
}

export function isDeepSeekModelProvider(
  providerId: string,
  provider: DeepSeekModelProviderCandidate | undefined,
): boolean {
  // A name alone is not a credential boundary: users often name proxies
  // "deepseek". Only credentials configured against the official host may
  // be reused for the native-search endpoint.
  void providerId;
  return isOfficialDeepSeekApiUrl(provider?.url);
}

export function isOfficialDeepSeekApiUrl(value: unknown): boolean {
  const url = readNonEmptyString(value);
  if (!url) return false;
  try {
    return isOfficialDeepSeekNativeSearchEndpoint(url);
  } catch {
    return false;
  }
}

function findReusableDeepSeekModelProvider(
  providers: Record<string, DeepSeekModelProviderCandidate | undefined> | undefined,
  environment: Record<string, string | undefined>,
): { id: string; apiKey: string } | undefined {
  if (!providers) return undefined;

  const entries = Object.entries(providers)
    .map(([id, provider]) => ({ id, provider, apiKey: resolveCredential(provider?.apiKey, environment) }))
    .filter((entry): entry is { id: string; provider: DeepSeekModelProviderCandidate; apiKey: string } =>
      Boolean(entry.provider && entry.apiKey && isDeepSeekModelProvider(entry.id, entry.provider)),
    );

  const byId = entries.find(({ id, provider }) =>
    normalizeProviderId(id) === "deepseek" || normalizeProviderId(provider.id) === "deepseek",
  );
  const match = byId ?? entries[0];
  return match ? { id: match.id, apiKey: match.apiKey } : undefined;
}

function resolveCredential(
  value: unknown,
  environment: Record<string, string | undefined>,
): string | undefined {
  const configured = readNonEmptyString(value);
  if (!configured) return undefined;
  const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(configured);
  return reference ? readNonEmptyString(environment[reference[1]]) : configured;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeProviderId(value: unknown): string {
  return readNonEmptyString(value)?.toLowerCase() ?? "";
}
