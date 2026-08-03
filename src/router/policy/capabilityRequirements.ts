import type { CanonicalModelRequest } from "../../model/index.js";
import type { InputModality } from "../../model/index.js";
import { collectRequiredInputModalities } from "../utils/mediaRequirements.js";

/**
 * Deterministic capability-requirement derivation (Phase 2.1).
 *
 * Instead of routing first and checking media compatibility afterwards (the
 * legacy "select then reroute" path), we derive what the request *requires*
 * up front: input modalities, tool categories, and (when the agent loop or
 * the research director passes it) the research context — artifact kinds and
 * the EIG action type. Tier priors then constrain the tier classification so
 * the router never lands on a model that structurally cannot do the job.
 */

export type ToolCategory =
  | "search"
  | "content_generation"
  | "orchestration"
  | "analysis"
  | "filesystem"
  | "other";

export type ResearchRoutingHint = Readonly<{
  /** Artifact kinds the current research action produces/consumes. */
  artifactKinds?: readonly string[];
  /** EIG planner action type, e.g. "run_experiment" | "write_section". */
  actionType?: string;
}>;

/**
 * Loose parse of an untrusted `metadata.research` value (from agent submit
 * options / gateway protocol). Invalid fields are dropped, never fatal.
 */
export function parseResearchHint(value: unknown): ResearchRoutingHint | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const rawKinds = Array.isArray(record.artifactKinds)
    ? record.artifactKinds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : undefined;
  const artifactKinds = rawKinds && rawKinds.length > 0 ? rawKinds : undefined;
  const actionType = typeof record.actionType === "string" && record.actionType.length > 0
    ? record.actionType
    : undefined;
  if (!artifactKinds && !actionType) {
    return undefined;
  }
  return Object.freeze({
    ...(artifactKinds ? { artifactKinds } : {}),
    ...(actionType ? { actionType } : {}),
  });
}

export type CapabilityRequirements = Readonly<{
  modalities: readonly InputModality[];
  toolCategories: readonly ToolCategory[];
  research: ResearchRoutingHint;
  /** True when the request carries an orchestration tool (agent/subagent). */
  requiresOrchestration: boolean;
  /** True when the request mixes many tools or very large context. */
  complexitySignal: boolean;
}>;

const TOOL_CATEGORY_PATTERNS: ReadonlyArray<readonly [ToolCategory, RegExp]> = [
  ["search", /^(web_search|web_fetch|literature_search|literature_expand|deepseek_native_search|research_artifacts)$/],
  ["orchestration", /^(agent)$/],
  ["analysis", /^(experiment_analysis|experimentControl|execute_code|research_review)$/],
  ["content_generation", /^(manuscript|figure|render)/],
  ["filesystem", /^(read_file|write_file|edit_file|grep|glob|bash)$/],
];

const ORCHESTRATION_TOOL_PATTERN = /^(agent)$/;
const COMPLEXITY_TOOL_COUNT = 4;
const COMPLEXITY_MESSAGE_CHARS = 12_000;

export function categorizeTool(toolName: string): ToolCategory {
  for (const [category, pattern] of TOOL_CATEGORY_PATTERNS) {
    if (pattern.test(toolName)) {
      return category;
    }
  }
  return "other";
}

export function computeCapabilityRequirements(
  request: CanonicalModelRequest,
  research: ResearchRoutingHint = {},
): CapabilityRequirements {
  const modalities = collectRequiredInputModalities(request.messages);
  const toolCategories = new Set<ToolCategory>();
  let requiresOrchestration = false;
  for (const tool of request.tools ?? []) {
    const category = categorizeTool(tool.name);
    toolCategories.add(category);
    if (ORCHESTRATION_TOOL_PATTERN.test(tool.name)) {
      requiresOrchestration = true;
    }
  }

  let complexitySignal = toolCategories.size >= COMPLEXITY_TOOL_COUNT;
  if (!complexitySignal) {
    let totalChars = 0;
    for (const message of request.messages) {
      for (const block of message.content) {
        if (block.type === "text") {
          totalChars += block.text.length;
          if (totalChars > COMPLEXITY_MESSAGE_CHARS) break;
        }
      }
    }
    complexitySignal = totalChars > COMPLEXITY_MESSAGE_CHARS;
  }

  return Object.freeze({
    modalities: Object.freeze([...modalities]),
    toolCategories: Object.freeze([...toolCategories]),
    research: Object.freeze(research),
    requiresOrchestration,
    complexitySignal,
  });
}

/**
 * Tier priors derived from capability requirements.
 *
 * Returns tier names the requirement set *supports* (most-specific first).
 * The router consults this list after classification: if the classifier's
 * tier is not in the supported set, the first supported tier is used instead
 * (research-aware tier upgrade), so a web-research task is never pinned to a
 * "simple" greeting tier because its first message happened to be short.
 *
 * Tier names follow the tokenSaver convention (simple/medium/complex/
 * reasoning); unknown tier names pass through untouched.
 */
export function tierPriorForRequirements(
  requirements: CapabilityRequirements,
): readonly string[] {
  const priors: string[] = [];
  if (requirements.requiresOrchestration || requirements.research.actionType === "principle_revision") {
    priors.push("complex");
  }
  if (
    requirements.toolCategories.includes("search") ||
    requirements.toolCategories.includes("analysis") ||
    requirements.research.actionType === "run_experiment" ||
    requirements.research.actionType === "review" ||
    requirements.research.actionType === "literature_search"
  ) {
    priors.push("reasoning");
  }
  if (requirements.complexitySignal) {
    priors.push("reasoning");
  }
  if (requirements.research.actionType === "write_section" || requirements.toolCategories.includes("content_generation")) {
    priors.push("reasoning");
  }
  return Object.freeze([...new Set(priors)]);
}

/**
 * Apply the tier priors: **upgrade only, never downgrade**.
 *
 * The priors list expresses "tiers this requirement set supports"; a
 * classified tier that is not in the priors is only replaced by a prior tier
 * that is *strictly stronger* on the configured tier ladder
 * (`knownTiers` order, e.g. simple < medium < complex < reasoning). A
 * classified `complex` (orchestration) task whose requirements also mention
 * search/analysis is left alone — downgrading it would silently kill
 * orchestration state.
 */
export function applyTierPrior(
  classifiedTier: string,
  priors: readonly string[],
  knownTiers: readonly string[],
): { tier: string; upgraded: boolean } {
  if (priors.length === 0) {
    return { tier: classifiedTier, upgraded: false };
  }
  if (priors.includes(classifiedTier)) {
    return { tier: classifiedTier, upgraded: false };
  }
  const rank = (tier: string): number => {
    const index = knownTiers.indexOf(tier);
    return index < 0 ? -1 : index;
  };
  const classifiedRank = rank(classifiedTier);
  let target: string | undefined;
  let bestRank = -1;
  for (const tier of priors) {
    const tierRank = rank(tier);
    if (tierRank > classifiedRank && tierRank > bestRank) {
      target = tier;
      bestRank = tierRank;
    }
  }
  if (!target) {
    return { tier: classifiedTier, upgraded: false };
  }
  return { tier: target, upgraded: true };
}
