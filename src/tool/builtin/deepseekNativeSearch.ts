import type { PermissionResult } from "../../permission/index.js";
import {
  DeepSeekNativeSearchError,
  isOfficialDeepSeekNativeSearchEndpoint,
  resolveDeepSeekNativeSearchSettings,
  searchDeepSeekNative,
  type DeepSeekNativeSearchEvidenceBundle,
} from "../../deepseek-native-search/index.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type {
  RigoriumToolAvailabilityContext,
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";

export type DeepSeekNativeSearchInput = {
  query: string;
};

export type CreateDeepSeekNativeSearchToolOptions = {
  apiKey?: string;
  /** Internal adapter marker for credentials inherited from app configuration. */
  credentialSource?: "automatic";
  endpoint?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  maxUses?: number;
  maxCitations?: number;
  maxAnswerChars?: number;
  /** Test-only override for the public server-tool compatibility fallback. */
  toolVariants?: readonly string[];
};

export function createDeepSeekNativeSearchTool(
  options: CreateDeepSeekNativeSearchToolOptions = {},
): RigoriumToolDefinition<DeepSeekNativeSearchInput, DeepSeekNativeSearchEvidenceBundle> {
  return {
    name: "deepseek_native_search",
    title: "DeepSeek Native Search",
    aliases: ["DeepSeekNativeSearch"],
    description: `Search the web with DeepSeek's server-side native search and return a compact evidence bundle.

Use this tool for current information when concise sourced evidence is more useful than full page content. The result contains a bounded answer, structured citations, usage, and request diagnostics. It is read-only and does not fetch or return full web pages.

Requires a DeepSeek API key configured in tools.deepseekNativeSearch.apiKey, DEEPSEEK_NATIVE_SEARCH_API_KEY, or DEEPSEEK_API_KEY.`,
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Focused current-information query. Include a product, version, date, or factual question where relevant.",
        },
      },
    },
    maxResultBytes: 100_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkAvailability: (context) => checkAvailability(options, context),
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "ask",
      reason: {
        type: "tool",
        toolName: "deepseek_native_search",
        message: "DeepSeek native search requires network access.",
      },
      request: {
        toolCallId: "",
        toolName: "deepseek_native_search",
        inputSummary: "DeepSeek native search",
        reason: {
          type: "tool",
          toolName: "deepseek_native_search",
          message: "DeepSeek native search requires network access.",
        },
        options: [
          { id: "allow_once", label: "Allow search" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    execute: async (input, context) => executeDeepSeekNativeSearch(options, input, context),
  };
}

function checkAvailability(
  options: CreateDeepSeekNativeSearchToolOptions,
  context: RigoriumToolAvailabilityContext,
) {
  const settings = resolveDeepSeekNativeSearchSettings(options, context.env ?? process.env);
  const hasExplicitApiKey = options.credentialSource !== "automatic" &&
    typeof options.apiKey === "string" && options.apiKey.trim().length > 0;
  if (!hasExplicitApiKey && !isOfficialDeepSeekNativeSearchEndpoint(settings.endpoint)) {
    return {
      ok: false as const,
      code: "setup_required" as const,
      reason: "A custom DeepSeek native-search endpoint requires an explicit DeepSeek API key.",
    };
  }
  if (!settings.apiKey) {
    return {
      ok: false as const,
      code: "setup_required" as const,
      reason: "DeepSeek native search requires a DeepSeek API key.",
    };
  }
  return { ok: true as const };
}

async function executeDeepSeekNativeSearch(
  options: CreateDeepSeekNativeSearchToolOptions,
  input: DeepSeekNativeSearchInput,
  context: RigoriumToolRuntimeContext,
): Promise<RigoriumToolExecutionOutput<DeepSeekNativeSearchEvidenceBundle>> {
  try {
    const evidence = await searchDeepSeekNative({
      ...options,
      query: input.query,
      environment: context.env ?? process.env,
      signal: context.abortSignal,
    });
    return {
      // `content` is model-visible. Keep one bounded representation here;
      // structured evidence remains available to hosts through `data`.
      content: [{ type: "text", text: formatEvidence(evidence) }],
      data: evidence,
      metadata: {
        provider: "deepseek",
        endpoint: evidence.diagnostics.endpoint,
        model: evidence.diagnostics.model,
        toolVariant: evidence.diagnostics.toolVariant,
        citationCount: evidence.citations.length,
        ...(evidence.usage ? { usage: evidence.usage } : {}),
      },
    };
  } catch (error) {
    throw toToolRuntimeError(error);
  }
}

function formatEvidence(evidence: DeepSeekNativeSearchEvidenceBundle): string {
  const lines = [`DeepSeek native search evidence for: ${evidence.query}`];
  if (evidence.answer) lines.push("", evidence.answer);
  if (evidence.citations.length > 0) {
    lines.push("", "Citations:");
    for (const citation of evidence.citations) {
      lines.push(`- ${citation.title ?? citation.url}: ${citation.url}`);
      if (citation.snippet) lines.push(`  ${citation.snippet}`);
    }
  }
  if (!evidence.answer && evidence.citations.length === 0) {
    lines.push("", "No compact answer or citations were returned.");
  }
  return lines.join("\n");
}

function toToolRuntimeError(error: unknown): RigoriumToolRuntimeError {
  if (!(error instanceof DeepSeekNativeSearchError)) {
    return new RigoriumToolRuntimeError(
      "tool_execution_failed",
      `DeepSeek native search failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const code = error.code === "setup_required"
    ? "setup_required"
    : error.code === "invalid_input"
      ? "invalid_tool_input"
      : error.code === "aborted"
        ? "tool_aborted"
      : error.code === "timeout"
        ? "tool_timeout"
        : "tool_execution_failed";
  return new RigoriumToolRuntimeError(code, error.message, { tool: "deepseek_native_search" });
}
