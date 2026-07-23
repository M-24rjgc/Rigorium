import { NetworkFetchError, networkFetch } from "../network/fetch.js";
import {
  normalizeDeepSeekNativeSearchToolVariants,
  isOfficialDeepSeekNativeSearchEndpoint,
  resolveDeepSeekNativeSearchSettings,
} from "./config.js";
import {
  DeepSeekNativeSearchError,
  type DeepSeekNativeSearchCitation,
  type DeepSeekNativeSearchEvidenceBundle,
  type DeepSeekNativeSearchUsage,
  type SearchDeepSeekNativeInput,
} from "./types.js";

/**
 * Protocol behavior is adapted from RockyCode (MIT), pinned upstream at
 * cicialgo/rockycode@2a1574ca9bb32e6a4c4f01cc265a5beb54027fa1. See NOTICE.md.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 2_048;
const DEFAULT_MAX_USES = 5;
const DEFAULT_MAX_CITATIONS = 8;
const DEFAULT_MAX_ANSWER_CHARS = 8_000;
const DEFAULT_MAX_CITATION_SNIPPET_CHARS = 600;

export async function searchDeepSeekNative(
  input: SearchDeepSeekNativeInput,
): Promise<DeepSeekNativeSearchEvidenceBundle> {
  const query = input.query.trim();
  if (!query) {
    throw new DeepSeekNativeSearchError("invalid_input", "DeepSeek native search requires a non-empty query.");
  }

  const settings = resolveDeepSeekNativeSearchSettings(input, input.environment);
  const hasExplicitApiKey = input.credentialSource !== "automatic" &&
    typeof input.apiKey === "string" && input.apiKey.trim().length > 0;
  if (!hasExplicitApiKey && !isOfficialDeepSeekNativeSearchEndpoint(settings.endpoint)) {
    throw new DeepSeekNativeSearchError(
      "setup_required",
      "A custom DeepSeek native-search endpoint requires an explicit tools.deepseekNativeSearch.apiKey.",
    );
  }
  if (!settings.apiKey) {
    throw new DeepSeekNativeSearchError(
      "setup_required",
      "DeepSeek native search requires a DeepSeek API key. Configure tools.deepseekNativeSearch.apiKey, DEEPSEEK_NATIVE_SEARCH_API_KEY, or DEEPSEEK_API_KEY.",
    );
  }

  const toolVariants = normalizeDeepSeekNativeSearchToolVariants(input.toolVariants);
  const attemptedToolVariants: string[] = [];
  const timeoutMs = clampInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 120_000);
  const maxTokens = clampInteger(input.maxTokens, DEFAULT_MAX_TOKENS, 128, 8_192);
  const maxUses = clampInteger(input.maxUses, DEFAULT_MAX_USES, 1, 10);
  const maxCitations = clampInteger(input.maxCitations, DEFAULT_MAX_CITATIONS, 1, 32);
  const maxAnswerChars = clampInteger(input.maxAnswerChars, DEFAULT_MAX_ANSWER_CHARS, 256, 20_000);
  const maxCitationSnippetChars = clampInteger(
    input.maxCitationSnippetChars,
    DEFAULT_MAX_CITATION_SNIPPET_CHARS,
    80,
    2_000,
  );

  for (const toolVariant of toolVariants) {
    attemptedToolVariants.push(toolVariant);
    const response = await postSearchRequest({
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      model: settings.model,
      query,
      toolVariant,
      maxTokens,
      maxUses,
      timeoutMs,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
    });
    const responseText = await response.text().catch(() => "");

    if (!response.ok) {
      if (response.status === 400 && isUnknownToolVariant(responseText) && toolVariant !== toolVariants[toolVariants.length - 1]) {
        continue;
      }
      throw new DeepSeekNativeSearchError(
        "api_error",
        `DeepSeek native search API error (${response.status}): ${truncate(responseText || response.statusText, 500)}`,
        { status: response.status, diagnostics: { endpoint: settings.endpoint, model: settings.model, toolVariant, attemptedToolVariants } },
      );
    }

    const payload = parseResponsePayload(responseText, response.status, settings.endpoint, settings.model, toolVariant, attemptedToolVariants);
    const usage = extractUsage(payload);
    return {
      query,
      answer: extractAnswer(payload, maxAnswerChars),
      citations: extractCitations(payload, maxCitations, maxCitationSnippetChars),
      ...(usage ? { usage } : {}),
      diagnostics: {
        endpoint: settings.endpoint,
        model: settings.model,
        toolVariant,
        attemptedToolVariants,
      },
    };
  }

  throw new DeepSeekNativeSearchError(
    "api_error",
    "DeepSeek native search did not accept a supported server-tool variant.",
    { diagnostics: { endpoint: settings.endpoint, model: settings.model, attemptedToolVariants } },
  );
}

type PostSearchRequestInput = {
  endpoint: string;
  apiKey: string;
  model: string;
  query: string;
  toolVariant: string;
  maxTokens: number;
  maxUses: number;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

async function postSearchRequest(input: PostSearchRequestInput): Promise<Response> {
  try {
    return await networkFetch(input.endpoint, {
      method: "POST",
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      redirect: "error",
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        tools: [{ type: input.toolVariant, name: "web_search", max_uses: input.maxUses }],
        messages: [{ role: "user", content: buildSearchPrompt(input.query) }],
      }),
      signal: input.signal,
    }, {
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
      // Server-side web search can be billable. A POST retry might launch the
      // same search more than once after an ambiguous transport failure.
      retry: { maxRetries: 0, retryOnPost: false },
    });
  } catch (error) {
    if (error instanceof NetworkFetchError && error.code === "network_abort") {
      throw new DeepSeekNativeSearchError("aborted", "DeepSeek native search was cancelled.");
    }
    if (error instanceof NetworkFetchError && error.code === "network_timeout") {
      throw new DeepSeekNativeSearchError("timeout", "DeepSeek native search request timed out.");
    }
    throw new DeepSeekNativeSearchError(
      "request_failed",
      `DeepSeek native search request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildSearchPrompt(query: string): string {
  return [
    "Search the web and answer concisely with key facts for the query below.",
    "Cite the sources used. Do not include full page bodies.",
    `Query: ${query}`,
  ].join("\n");
}

function parseResponsePayload(
  responseText: string,
  status: number,
  endpoint: string,
  model: string,
  toolVariant: string,
  attemptedToolVariants: string[],
): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch {
    throw new DeepSeekNativeSearchError(
      "response_invalid",
      "DeepSeek native search returned a non-JSON response.",
      { status, diagnostics: { endpoint, model, toolVariant, attemptedToolVariants } },
    );
  }
  if (!isRecord(payload)) {
    throw new DeepSeekNativeSearchError(
      "response_invalid",
      "DeepSeek native search returned an invalid response object.",
      { status, diagnostics: { endpoint, model, toolVariant, attemptedToolVariants } },
    );
  }
  return payload;
}

function isUnknownToolVariant(text: string): boolean {
  return /unknown\s+variant/iu.test(text);
}

function extractAnswer(payload: Record<string, unknown>, maxChars: number): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .filter(isRecord)
    .filter((block) => block.type === "text")
    .map((block) => readString(block.text))
    .filter((value): value is string => value !== undefined)
    .join("\n")
    .trim();
  return truncate(text, maxChars);
}

function extractCitations(
  payload: Record<string, unknown>,
  maxCitations: number,
  maxSnippetChars: number,
): DeepSeekNativeSearchCitation[] {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const citations: DeepSeekNativeSearchCitation[] = [];
  const seenUrls = new Set<string>();

  for (const block of content) {
    if (!isRecord(block) || block.type !== "web_search_tool_result") continue;
    for (const result of resultItems(block)) {
      const url = readString(result.url) ?? readString(result.href) ?? readString(result.link);
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      const title = readString(result.title) ?? readString(result.name) ?? readString(result.page_title);
      const snippet = truncate(
        readString(result.snippet) ??
          readString(result.description) ??
          readString(result.text) ??
          readString(result.content) ??
          "",
        maxSnippetChars,
      );
      citations.push({
        ...(title ? { title } : {}),
        url,
        ...(snippet ? { snippet } : {}),
      });
      if (citations.length >= maxCitations) return citations;
    }
  }

  return citations;
}

function resultItems(block: Record<string, unknown>): Record<string, unknown>[] {
  const values = [block.content, block.results, block.items];
  const items: Record<string, unknown>[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      items.push(...value.filter(isRecord));
    } else if (isRecord(value)) {
      items.push(value);
    }
  }
  return items;
}

function extractUsage(payload: Record<string, unknown>): DeepSeekNativeSearchUsage | undefined {
  if (!isRecord(payload.usage)) return undefined;
  const usage = payload.usage;
  const inputTokens = readNumber(usage.input_tokens);
  const outputTokens = readNumber(usage.output_tokens);
  const cacheReadInputTokens = readNumber(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = readNumber(usage.cache_creation_input_tokens);
  const result: DeepSeekNativeSearchUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, Math.max(0, maxChars - 3))}...` : value;
}
