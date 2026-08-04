export type RouterScenarioType =
  | "default"
  | "subagent"
  | "explicit";

export type RouterDecisionResolution =
  | "explicit"
  | "scenario"
  | "tokenSaver"
  | "custom"
  | "fallback"
  | "judge"
  | "default"
  | "learned"
  | "heuristic"
  | "continuation";

export type RouterMutationsLog = {
  systemPromptSlim?: { from: number; to: number; preservedKeywords: string[] };
  toolsStripped?: { before: number; after: number; mode?: "allowlist" | "blocklist"; patterns: string[] };
  orchestrationPromptInjected?: { tier: string; chars: number };
  orchestrationActivated?: { tier: string; continued: boolean };
  asyncAgentLaunchedRewritten?: boolean;
  subagentTagStripped?: boolean;
  mediaCapabilityRerouted?: {
    required: import("../../model/protocol/multimodal.js").InputModality[];
    from: string;
    to: string;
  };
  cacheAwareSwitch?: {
    action: "kept_sticky" | "switched";
    from: string;
    to: string;
    cachedCost: number;
    prefillCost: number;
    estimatedInputTokens: number;
  };
  /** Phase 2: research-aware tier upgrade applied after classification. */
  researchAwareTierUpgraded?: {
    from: string;
    to: string;
    reason: string;
  };
};

export type RouterRequestPatch = Pick<
  import("../../model/protocol/canonical.js").CanonicalModelRequest,
  "messages" | "tools" | "systemPrompt"
>;

export type RouterDecision = {
  provider: string;
  model: string;
  scenarioType: RouterScenarioType;
  tokenSaverTier?: string;
  isSubagent: boolean;
  orchestrating: boolean;
  resolvedFrom: RouterDecisionResolution;
  mutations: RouterMutationsLog;
  requestPatch?: Partial<RouterRequestPatch>;
};

export type SessionRoutingState = {
  sessionId: string;
  isSubagent: boolean;
  tokenSaverTier?: string;
  stickyProvider?: string;
  stickyModel?: string;
  orchestrating: boolean;
  /**
   * Number of turns in the current orchestration run (1 = the triggering
   * turn). Bumped while orchestrating, cleared on exit — lets the router
   * bound a run (maxContinuationTurns) and observe when it ends.
   */
  orchestrationContinuations?: number;
  lastUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /**
   * Consecutive routed-turn failures observed on this sticky selection
   * (empty responses, exhausted fallback chains). Once this reaches the
   * sticky `maxQualityFailures` threshold, `decide()` ignores the sticky
   * so the request is re-classified instead of retrying a degraded model.
   */
  qualityFailures?: number;
  updatedAt: number;
};

export type RouterDecisionInputUsageHint = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type RouterDecisionInput = {
  request: import("../../model/protocol/canonical.js").CanonicalModelRequest;
  sessionId: string;
  isMainAgent: boolean;
  metadata?: {
    lastUsage?: RouterDecisionInputUsageHint;
    explicitProvider?: string;
    explicitModel?: string;
    /** Tier from the previous turn; fed to the judge for context-aware classification. */
    previousTier?: string;
    previousProvider?: string;
    previousModel?: string;
    /** Research context (artifact kinds + EIG action type) for research-aware routing. */
    research?: import("../../router/policy/capabilityRequirements.js").ResearchRoutingHint;
  };
};

export type RouterExecuteContext = {
  sessionId: string;
  turnId: string;
  projectPath?: string;
  abortSignal?: AbortSignal;
};
