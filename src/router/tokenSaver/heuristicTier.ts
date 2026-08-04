/**
 * Zero-cost deterministic heuristic tier pre-filter (LiteLLM Auto Router
 * complexity-scorer semantics, adapted to Rigorium's conservative posture).
 *
 * Design principles (from the heuristic-routing research round):
 * - Only the latest user message text is inspected — never the system prompt
 *   (it would inflate complexity artificially).
 * - The heuristic only ever decides ONE thing: "this request is obviously
 *   simple". Anything else falls through to the judge / learned path. This
 *   is the asymmetric single-sided logic LiteLLM's `simple` boundary uses
 *   (score < 0.15 requires strong evidence): 宁可少拦，不可错拦.
 * - SIMPLE requires ALL of: a simple indicator hit, a short message, and
 *   ZERO exclusion hits (code / reasoning / technical markers). Any complex
 *   marker forbids the simple verdict.
 * - Continuations are handled by the caller (isShortContinuation) BEFORE
 *   this heuristic — they inherit the previous tier and never count as
 *   "simple" (an agent-session short message is usually a complex task's
 *   continuation, not a new simple request).
 *
 * Word lists are deliberately conservative subsets of LiteLLM's tuned lists
 * (e.g. "ok" is excluded because it matches "token"/"book"; single-word
 * keywords use word-boundary regexes).
 */

const SIMPLE_MAX_CHARS = 60; // ≈ 15 tokens via len//4 (LiteLLM token estimate)

const SIMPLE_INDICATORS = [
  /\bwhat is\b/i,
  /\bwhat's\b/i,
  /\bdefine\b/i,
  /\bexplain briefly\b/i,
  /\bhello\b/i,
  /\bhi\b/i,
  /\bhey\b/i,
  /\bthanks\b/i,
  /\bthank you\b/i,
  /\bgood morning\b/i,
  /\bgood evening\b/i,
  /\bgoodbye\b/i,
  /\bbye\b/i,
  /\bwho are you\b/i,
];

const CODE_MARKERS = [
  /\bfunction\b/i,
  /\bclass\b/i,
  /\bdef\b/i,
  /\bimport\b/i,
  /\basync\b/i,
  /\berror\b/i,
  /\bdebug\b/i,
  /\bapi\b/i,
  /\bsql\b/i,
  /\brefactor\b/i,
  /\bpython\b/i,
  /\bdocker\b/i,
  /\bkubernetes\b/i,
  /\bgit\b/i,
  /\btest\b/i,
  /\bimplement\b/i,
  /\bfix\b/i,
  /\bwrite code\b/i,
  /\bcod(e|ing|ebase)\b/i,
  /\bbug\b/i,
  /\bcompile\b/i,
  /\bruntime\b/i,
  /\bcallback\b/i,
  /\bregex\b/i,
];

const REASONING_MARKERS = [
  /\bstep by step\b/i,
  /\bthink through\b/i,
  /\bchain of thought\b/i,
  /\bpros and cons\b/i,
  /\bevaluate\b/i,
  /\bderive\b/i,
  /\bprove\b/i,
  /\bcompare\b/i,
  /\banalyze\b/i,
  /\bdesign\b/i,
  /\boptimize\b/i,
  /\balgorithm\b/i,
  /\bmathematical\b/i,
  /\bproof\b/i,
  /\bhypothes[i]s\b/i,
  /\bexperiment\b/i,
  /\bliterature\b/i,
  /\bmanuscript\b/i,
  /\breview\b/i,
];

const TECHNICAL_MARKERS = [
  /\barchitecture\b/i,
  /\bdistributed\b/i,
  /\bencryption\b/i,
  /\bgpu\b/i,
  /\btcp\b/i,
  /\bprotocol\b/i,
  /\bschema\b/i,
  /\bconcurrency\b/i,
  /\blatency\b/i,
  /\bthroughput\b/i,
  /\bgradient\b/i,
  /\bneural\b/i,
  /\bbaseline\b/i,
  /\bmetric\b/i,
  /\bstatistical\b/i,
];

/**
 * Markers that forbid the simple verdict even when simple indicators hit.
 * Deliberately conservative: any hit → not simple (LiteLLM's reasoning
 * override inverted — we use it as a hard exclusion, not an upgrade).
 */
export function hasComplexMarkers(userMessage: string): boolean {
  const trimmed = userMessage.trim();
  return (
    countHits(CODE_MARKERS, trimmed) > 0 ||
    countHits(REASONING_MARKERS, trimmed) > 0 ||
    countHits(TECHNICAL_MARKERS, trimmed) > 0
  );
}

export type HeuristicSimpleResult = {
  isSimple: boolean;
  /** Human-readable signals for telemetry / debugging (LiteLLM-style). */
  signals: string[];
};

export function classifyHeuristicSimple(userMessage: string): HeuristicSimpleResult {
  const trimmed = userMessage.trim();
  const signals: string[] = [];

  if (trimmed.length === 0) {
    return { isSimple: false, signals: [] };
  }

  const simpleHits = countHits(SIMPLE_INDICATORS, trimmed);
  if (simpleHits === 0) {
    return { isSimple: false, signals: [] };
  }
  signals.push(`simple (${simpleHits})`);

  if (trimmed.length > SIMPLE_MAX_CHARS) {
    signals.push(`long (${trimmed.length} chars)`);
    return { isSimple: false, signals };
  }
  signals.push(`short (${trimmed.length} chars)`);

  const codeHits = countHits(CODE_MARKERS, trimmed);
  const reasoningHits = countHits(REASONING_MARKERS, trimmed);
  const technicalHits = countHits(TECHNICAL_MARKERS, trimmed);
  if (codeHits > 0) {
    signals.push(`code (${codeHits})`);
    return { isSimple: false, signals };
  }
  if (reasoningHits > 0) {
    signals.push(`reasoning (${reasoningHits})`);
    return { isSimple: false, signals };
  }
  if (technicalHits > 0) {
    signals.push(`technical (${technicalHits})`);
    return { isSimple: false, signals };
  }

  return { isSimple: true, signals };
}

function countHits(patterns: RegExp[], text: string): number {
  let hits = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) hits += 1;
  }
  return hits;
}
