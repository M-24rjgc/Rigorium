import type { AlwaysOnConfig } from "../../always-on/config/parseAlwaysOnConfig.js";
import type { CronConfig } from "../../cron/config/parseCronConfig.js";
import type { ModelConfig } from "../../model/protocol/canonical.js";
import type { RouterConfig } from "../../router/config/schema.js";

export type RigoriumConfigSourceKind = "default" | "project" | "env";
export type RigoriumConfigSourcePhase = "bootstrap" | "merge";
export type RigoriumConfigDiagnosticSeverity = "info" | "warning" | "error" | "fatal";
export type RigoriumConfigChangeClass =
  | "runtime-live"
  | "next-request"
  | "next-runtime"
  | "restart-required"
  | "invalid";

export type RigoriumConfigSource = {
  kind: RigoriumConfigSourceKind;
  priority: number;
  loadedAt: Date;
  path?: string;
  contentHash?: string;
  phase?: RigoriumConfigSourcePhase;
};

export type RigoriumConfigDiagnostic = {
  code: string;
  severity: RigoriumConfigDiagnosticSeverity;
  message: string;
  path?: string;
  source?: Pick<RigoriumConfigSource, "kind" | "path" | "phase">;
  hint?: string;
  redactedValue?: string;
  recoverable?: boolean;
};

export type RigoriumRawConfig = {
  schemaVersion?: unknown;
  agent?: unknown;
  model?: unknown;
  extension?: unknown;
  memory?: unknown;
  gateway?: unknown;
  adapters?: unknown;
  router?: unknown;
  alwaysOn?: unknown;
  cron?: unknown;
  tools?: unknown;
  telemetry?: unknown;
  proxy?: unknown;
  webui?: unknown;
  /** Phase 3.3: vision assistant (describe_image / automatic enrichment). */
  vision?: unknown;
  /** Phase 3.4: figure generation (figure_generate). */
  figureGen?: unknown;
};

export type RigoriumExtensionConfig = {
  builtinPluginsEnabled: Record<string, boolean>;
  includeHookEvents: boolean;
};

export type RigoriumAgentModelSelection = {
  id: string;
  provider: string;
  model: string;
};

export type RigoriumAgentConfig = {
  model: RigoriumAgentModelSelection;
  /**
   * Override the model catalog's context window size (tokens). When set,
   * auto-compaction thresholds (80% warn / 95% block) are computed against
   * this value instead of the catalog default. Useful for proxy providers
   * or when you want compaction to kick in earlier.
   */
  maxContextTokens?: number;
  /** Override the selected model catalog's output-token cap. */
  maxOutputTokens?: number;
  thinking?: { enabled: boolean; budgetTokens?: number };
  subagents?: {
    timeoutMs?: number;
  };
};

/**
 * Re-export of the router's structured config so callers that already depend
 * on `RigoriumConfig` keep a single import path. The actual definition lives in
 * `src/router/config/schema.ts`.
 */
export type RigoriumRouterConfig = RouterConfig;

export type RigoriumMemoryApiType =
  | "openai-responses"
  | "responses"
  | "openai-completions"
  | "anthropic"
  | "google";
export type RigoriumMemoryReasoningMode = "answer_first" | "accuracy_first";

export type RigoriumMemoryScheduleConfig = {
  reasoningMode?: RigoriumMemoryReasoningMode;
  autoIndexIntervalMinutes?: number;
  autoDreamIntervalMinutes?: number;
};

export type RigoriumMemoryConfig = {
  enabled: boolean;
  provider: "edgeclaw";
  rootDir?: string;
  captureStrategy: "last_turn" | "full_session";
  includeAssistant: boolean;
  maxMessageChars?: number;
  retrievalTimeoutMs?: number;
  /** "provider/model" string referencing model.providers, e.g. "openai/gpt-4.1-mini" */
  model?: string;
  apiType?: RigoriumMemoryApiType;
  schedule?: RigoriumMemoryScheduleConfig;
  heartbeatBatchSize?: number;
};

export type RigoriumGatewayConfig = {
  port: number;
  bindAddress: "127.0.0.1";
  idleSessionTimeoutMinutes: number;
  idleSweepIntervalSeconds: number;
  memoryDiagnostics: boolean;
  staticAssetsPath?: string;
  /**
   * Maximum number of concurrent per-session MCP instances (e.g. browser-use
   * browser processes).  When the limit is reached, new sessions fall back
   * to the shared project-level MCP runtime.  Default 5.
   */
  maxPerSessionMcpInstances?: number;
};

export type RigoriumWebSearchProvider = "glm" | "tavily" | "custom";
export type RigoriumWebSearchCustomAuth = "bearer" | "bodyApiKey" | "queryApiKey" | "none";
export type RigoriumWebSearchCustomMethod = "GET" | "POST";

export type RigoriumWebSearchCustomProviderConfig = {
  name?: string;
  auth?: RigoriumWebSearchCustomAuth;
  method?: RigoriumWebSearchCustomMethod;
  queryParam?: string;
  apiKeyParam?: string;
  resultsPath?: string;
  titleField?: string;
  urlField?: string;
  snippetField?: string;
  sourceField?: string;
  publishedAtField?: string;
};

/**
 * Per-tool runtime config for `web_search`. Exactly one provider is active at
 * runtime; `apiKey` and `endpoint` apply to the selected provider.
 */
export type RigoriumWebSearchConfig = {
  provider?: RigoriumWebSearchProvider;
  apiKey?: string;
  endpoint?: string;
  customProvider?: RigoriumWebSearchCustomProviderConfig;
};

/** Independent configuration for the DeepSeek server-side native-search capability. */
export type RigoriumDeepSeekNativeSearchConfig = {
  apiKey?: string;
  endpoint?: string;
  model?: string;
};

export type RigoriumToolsConfig = {
  webSearch?: RigoriumWebSearchConfig;
  deepseekNativeSearch?: RigoriumDeepSeekNativeSearchConfig;
};

export type RigoriumProxyConfig = {
  url: string;
  noProxy?: string;
};

export type RigoriumPlatformAdapterConfig = {
  enabled: boolean;
  token?: string;
  apiKey?: string;
  webhookUrl?: string;
  extra?: Record<string, unknown>;
};

export type RigoriumAdaptersConfig = {
  cli?: {
    autoConnectServer: boolean;
  };
  tui?: {
    autoConnectServer: boolean;
  };
  feishu?: {
    enabled: boolean;
    appId?: string;
    appSecret?: string;
    encryptKey?: string;
    verifyToken?: string;
    defaultSessionLabel: string;
    connectionMode?: "stream" | "webhook";
    domainName?: "feishu" | "lark";
  };
  weixin?: { enabled: boolean };
  qq?: {
    enabled: boolean;
    appId?: string;
    clientSecret?: string;
    allowGroups?: string[];
    triggerPrefixes?: string[];
    maxMessageLength?: number;
  };
  telegram?: RigoriumPlatformAdapterConfig;
  discord?: RigoriumPlatformAdapterConfig;
  slack?: RigoriumPlatformAdapterConfig;
  matrix?: RigoriumPlatformAdapterConfig;
  mattermost?: RigoriumPlatformAdapterConfig;
  signal?: RigoriumPlatformAdapterConfig;
  whatsapp?: RigoriumPlatformAdapterConfig;
  bluebubbles?: RigoriumPlatformAdapterConfig;
  dingtalk?: RigoriumPlatformAdapterConfig;
  wecom?: RigoriumPlatformAdapterConfig;
  wecomCallback?: RigoriumPlatformAdapterConfig;
  email?: RigoriumPlatformAdapterConfig;
  sms?: RigoriumPlatformAdapterConfig;
  homeassistant?: RigoriumPlatformAdapterConfig;
  apiServer?: RigoriumPlatformAdapterConfig;
  webhook?: RigoriumPlatformAdapterConfig;
};

export type RigoriumTelemetryConfig = {
  enabled: boolean;
};

/**
 * Vision-assistant configuration (Phase 3.3, Codex read-image pattern).
 *
 * When the main agent model has no vision capability, images are delegated to
 * this OpenAI-compatible vision endpoint (works with GitHub Copilot's model
 * gateway and any OpenAI-compatible service). The `describe_image` tool
 * exposes it explicitly; automatic injection at the multimodal boundary is
 * wired in the platform-integration phase.
 */
export type RigoriumVisionConfig = {
  /** Master switch; when off, vision tools report not-configured. */
  enabled?: boolean;
  /** OpenAI-compatible base URL, e.g. https://models.github.ai/v1 or https://api.openai.com/v1. */
  baseUrl: string;
  apiKey: string;
  /** Vision model id, e.g. gpt-4o / gpt-4o-mini / glm-4.6v-flash. */
  model: string;
  timeoutMs?: number;
};

export type FigureGenConfig = {
  /** Master switch; when off, figure_generate reports not-configured. */
  enabled?: boolean;
  /** OpenAI-compatible base URL (e.g. https://api.openai.com/v1). */
  baseUrl: string;
  apiKey: string;
  /** Image model id (gpt-image-1 / gpt-image-2 — verify with the endpoint). */
  model: string;
  timeoutMs?: number;
};

export type RigoriumConfig = {
  agent: RigoriumAgentConfig;
  model: ModelConfig;
  extension: RigoriumExtensionConfig;
  memory?: RigoriumMemoryConfig;
  gateway?: RigoriumGatewayConfig;
  adapters?: RigoriumAdaptersConfig;
  router?: RouterConfig;
  alwaysOn?: AlwaysOnConfig;
  cron?: CronConfig;
  tools?: RigoriumToolsConfig;
  telemetry?: RigoriumTelemetryConfig;
  proxy?: RigoriumProxyConfig;
  /** Vision-assistant (describe_image) configuration. */
  vision?: RigoriumVisionConfig;
  /**
   * Figure-generation configuration (figure_generate tool).
   *
   * CONFIG-SURFACE ONLY: not yet validated against a live endpoint. The user
   * supplies baseUrl/apiKey/model (e.g. an OpenAI-compatible image endpoint
   * with gpt-image-1/gpt-image-2) and validates it; see README.
   */
  figureGen?: FigureGenConfig;
};

export type RigoriumConfigSnapshot = {
  version: number;
  schemaVersion: number;
  loadedAt: Date;
  contentHash: string;
  sources: RigoriumConfigSource[];
  diagnostics: RigoriumConfigDiagnostic[];
  config: RigoriumConfig;
};

export type RigoriumConfigLoadOptions = {
  env?: Record<string, string | undefined>;
  projectRoot?: string;
  version?: number;
};

export type RigoriumConfigReloadEvent = {
  previousSnapshot: RigoriumConfigSnapshot;
  nextSnapshot: RigoriumConfigSnapshot;
  changedPaths: string[];
  changeClasses: RigoriumConfigChangeClass[];
};

export class RigoriumConfigError extends Error {
  readonly name = "RigoriumConfigError";

  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics: RigoriumConfigDiagnostic[] = [],
  ) {
    super(message);
  }
}
