/**
 * Shared retry backoff for all model-request retry paths.
 *
 * SOTA practice (AWS "Exponential Backoff and Jitter", OpenAI/Anthropic SDKs):
 * - exponential growth capped at `maxDelayMs`;
 * - **full jitter** — wait is uniform in `[0, exponential]`, avoiding
 *   thundering herds when many requests retry together;
 * - a server-provided `retryAfterMs` takes precedence (the server knows its
 *   own cooling time) and is capped at 60s (the OpenAI SDK ceiling) rather
 *   than the local transient-retry cap — Anthropic 429s routinely return
 *   30-60s retry-after values, and clamping them to 8s guarantees the next
 *   attempt still eats a 429.
 *
 * Previously each retry site had its own linear (or linear+additive-jitter)
 * formula; linear waits are far too short on later attempts and additive
 * jitter still herds. This is the single implementation every site uses.
 */

/** Cap for server-provided retry-after values (OpenAI SDK parity). */
export const SERVER_RETRY_AFTER_CAP_MS = 60_000;

export function exponentialBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(retryAfterMs, SERVER_RETRY_AFTER_CAP_MS);
  }
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt));
  // full jitter: uniform in [0, exponential]
  return Math.floor(Math.random() * (exponential + 1));
}
