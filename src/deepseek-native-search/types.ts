export type DeepSeekNativeSearchCitation = {
  title?: string;
  url: string;
  snippet?: string;
};

export type DeepSeekNativeSearchUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

export type DeepSeekNativeSearchDiagnostics = {
  endpoint: string;
  model: string;
  toolVariant: string;
  attemptedToolVariants: string[];
};

/** A bounded evidence bundle suitable for tool output or direct prefetch use. */
export type DeepSeekNativeSearchEvidenceBundle = {
  query: string;
  answer: string;
  citations: DeepSeekNativeSearchCitation[];
  usage?: DeepSeekNativeSearchUsage;
  diagnostics: DeepSeekNativeSearchDiagnostics;
};

export type DeepSeekNativeSearchSettings = {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  /** Internal adapter marker. Automatic credentials cannot authorize a custom endpoint. */
  credentialSource?: "automatic";
};

export type ResolvedDeepSeekNativeSearchSettings = {
  apiKey?: string;
  endpoint: string;
  model: string;
};

export type SearchDeepSeekNativeInput = DeepSeekNativeSearchSettings & {
  query: string;
  environment?: Record<string, string | undefined>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  maxUses?: number;
  maxCitations?: number;
  maxAnswerChars?: number;
  maxCitationSnippetChars?: number;
  /** Override only for compatibility testing or a documented API migration. */
  toolVariants?: readonly string[];
};

export type DeepSeekNativeSearchErrorCode =
  | "setup_required"
  | "invalid_input"
  | "aborted"
  | "timeout"
  | "request_failed"
  | "api_error"
  | "response_invalid";

export class DeepSeekNativeSearchError extends Error {
  readonly name = "DeepSeekNativeSearchError";

  constructor(
    readonly code: DeepSeekNativeSearchErrorCode,
    message: string,
    readonly details?: { status?: number; diagnostics?: Partial<DeepSeekNativeSearchDiagnostics> },
  ) {
    super(message);
  }
}
