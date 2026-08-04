type FrameHandle = number;

type SmoothTextStreamOptions = {
  emit: (content: string) => void;
  finalize?: () => void;
  now?: () => number;
  scheduleFrame?: (callback: () => void) => FrameHandle;
  cancelFrame?: (handle: FrameHandle) => void;
  frameMs?: number;
  fallbackFrameMs?: number;
  targetLagMs?: number;
  maxLagMs?: number;
  minCharsPerFrame?: number;
  maxCharsPerFrame?: number;
};

export type SmoothTextStreamSnapshot = {
  targetLength: number;
  renderedLength: number;
  averageCharsPerSecond: number;
  pendingChars: number;
  isScheduled: boolean;
};

const DEFAULT_FRAME_MS = 16;
const DEFAULT_TARGET_LAG_MS = 30;
const DEFAULT_MAX_LAG_MS = 80;
const DEFAULT_MIN_CHARS_PER_FRAME = 1;
const DEFAULT_MAX_CHARS_PER_FRAME = 4;
const DEFAULT_AVERAGE_CHARS_PER_SECOND = 120;
const DEFAULT_FALLBACK_FRAME_MS = 32;
const RATE_ALPHA = 0.22;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smooth(previous: number, next: number): number {
  return previous * (1 - RATE_ALPHA) + next * RATE_ALPHA;
}

function isPreferredBoundary(char: string): boolean {
  return /[\s,.;:!?，。！？、；：）\])}]/.test(char);
}

function findBoundary(content: string, minLength: number, desiredLength: number, maxLength: number): number {
  const safeMax = clamp(maxLength, minLength, content.length);
  const safeDesired = clamp(desiredLength, minLength, safeMax);
  const backwardLimit = Math.max(minLength, safeDesired - 12);
  for (let index = safeDesired; index >= backwardLimit; index -= 1) {
    if (isPreferredBoundary(content[index - 1] || '')) {
      return index;
    }
  }

  const forwardLimit = Math.min(safeMax, safeDesired + 12);
  for (let index = safeDesired + 1; index <= forwardLimit; index += 1) {
    if (isPreferredBoundary(content[index - 1] || '')) {
      return index;
    }
  }

  return safeDesired;
}

export class SmoothTextStream {
  private targetContent = '';
  private renderedContent = '';
  private frame: FrameHandle | null = null;
  private fallbackTimer: number | null = null;
  private lastChunkAtMs: number | null = null;
  private lastFrameAtMs: number | null = null;
  private averageCharsPerSecond = DEFAULT_AVERAGE_CHARS_PER_SECOND;
  private paused = false;

  /** Called when draining completes (after flush(true) finishes pumping). */
  onDrainComplete: (() => void) | null = null;

  constructor(private readonly options: SmoothTextStreamOptions) {}

  append(text: string): void {
    if (!text) return;
    this.targetContent += text;
    if (!this.paused) {
      this.updateAverageRate(text.length);
      // The first chunk renders synchronously so the UI shows content
      // immediately instead of waiting for the first frame; everything after
      // that is pumped on the frame schedule.
      if (this.renderedContent.length === 0 && this.targetContent.length > 0) {
        this.pump();
      } else {
        this.schedulePump();
      }
    }
  }

  /** Track the observed chunk cadence so the pump adapts to real throughput. */
  private updateAverageRate(chunkLength: number): void {
    const nowMs = this.now();
    if (this.lastChunkAtMs != null && nowMs > this.lastChunkAtMs) {
      const intervalMs = nowMs - this.lastChunkAtMs;
      const instantCharsPerSecond = (chunkLength * 1000) / intervalMs;
      this.averageCharsPerSecond = smooth(this.averageCharsPerSecond, instantCharsPerSecond);
    }
    this.lastChunkAtMs = nowMs;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    if (this.renderedContent.length < this.targetContent.length) {
      this.schedulePump();
    } else if (this.draining) {
      this.finalizeDone();
    }
  }

  /**
   * Signal that no more content will arrive but keep pumping at normal rate.
   * When all buffered content is rendered, calls finalizeDone() which triggers
   * onDrainComplete. Use this for thinking→content transitions where we want
   * a smooth finish rather than an abrupt dump.
   */
  drain(): void {
    this.draining = true;
    if (this.renderedContent.length < this.targetContent.length) {
      this.schedulePump();
    } else {
      this.finalizeDone();
    }
  }

  flush(finalize = false): void {
    this.cancelScheduledFrame();
    if (finalize) {
      // Immediately dump all remaining content and finalize.
      // Gradual draining caused multiple smoothers to accumulate, each
      // triggering expensive React re-renders that blocked the main thread
      // and throttled rAF to 1fps.
      if (this.renderedContent !== this.targetContent) {
        this.renderedContent = this.targetContent;
        this.options.emit(this.renderedContent);
      }
      this.finalizeDone();
      return;
    }
    // Non-finalize flush: just ensure pump is scheduled to continue gradual rendering.
    if (this.renderedContent !== this.targetContent) {
      this.schedulePump();
    }
  }

  private draining = false;

  private finalizeDone(): void {
    this.draining = false;
    this.options.finalize?.();
    this.onDrainComplete?.();
    this.onDrainComplete = null;
    this.targetContent = '';
    this.renderedContent = '';
    this.lastChunkAtMs = null;
    this.lastFrameAtMs = null;
  }

  cancel(): void {
    this.cancelScheduledFrame();
  }

  getSnapshot(): SmoothTextStreamSnapshot {
    const pendingChars = this.targetContent.length - this.renderedContent.length;
    return {
      targetLength: this.targetContent.length,
      renderedLength: this.renderedContent.length,
      averageCharsPerSecond: this.averageCharsPerSecond,
      pendingChars,
      isScheduled: this.frame != null,
    };
  }

  private now(): number {
    // Guard against environments where `performance` is absent (fake window
    // stubs in tests, very old WebViews).
    if (this.options.now) return this.options.now();
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  private scheduleFrame(callback: () => void): FrameHandle {
    if (this.options.scheduleFrame) {
      return this.options.scheduleFrame(callback);
    }
    // Prefer requestAnimationFrame for display-synced pacing; fall back to a
    // fixed 16ms timeout where rAF is unavailable (fake window stubs, old
    // WebViews). The fallback timer (scheduleFallbackPump) covers rAF being
    // throttled by the host.
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      return window.requestAnimationFrame(callback) as unknown as FrameHandle;
    }
    return window.setTimeout(callback, 16) as unknown as FrameHandle;
  }

  private cancelFrame(handle: FrameHandle): void {
    if (this.options.cancelFrame) {
      this.options.cancelFrame(handle);
      return;
    }
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(handle as unknown as number);
      return;
    }
    window.clearTimeout(handle as unknown as number);
  }

  private cancelScheduledFrame(): void {
    if (this.frame != null) {
      this.cancelFrame(this.frame);
      this.frame = null;
    }
    this.cancelFallbackTimer();
  }

  private cancelFallbackTimer(): void {
    if (this.fallbackTimer == null) return;
    clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private schedulePump(): void {
    if (this.frame != null) return;
    this.frame = this.scheduleFrame(() => this.pump());
    this.scheduleFallbackPump();
  }

  private scheduleFallbackPump(): void {
    // Browser rAF can be delayed or paused by WebView/tab throttling. The first
    // chunk is emitted synchronously; this timeout keeps the rest moving without
    // giving up smooth per-frame rendering when rAF is healthy.
    if (this.options.scheduleFrame || this.fallbackTimer != null || typeof window === 'undefined') {
      return;
    }
    this.fallbackTimer = window.setTimeout(() => {
      this.fallbackTimer = null;
      if (this.frame == null) return;
      this.cancelFrame(this.frame);
      this.frame = null;
      this.pump();
    }, this.options.fallbackFrameMs ?? DEFAULT_FALLBACK_FRAME_MS);
  }

  private pump(): void {
    this.frame = null;
    this.cancelFallbackTimer();

    // If paused, don't emit — just reschedule if draining so we can finish
    // when resume() is called. This prevents phantom re-renders that block
    // the main thread while the smoother is supposed to be waiting.
    if (this.paused) {
      return;
    }

    const remaining = this.targetContent.length - this.renderedContent.length;
    if (remaining <= 0) {
      if (this.draining) {
        this.finalizeDone();
      }
      return;
    }

    // Frame size adapts to the observed chunk rate (getCharsForFrame) and
    // prefers whitespace/punctuation boundaries when the budget allows;
    // draining uses the full per-frame cap for a quick, smooth finish.
    // When almost everything is rendered, boundary search would clamp the
    // cut back to minCharsPerFrame and shrink the output — never do that.
    const chars = this.draining
      ? Math.min(this.maxCharsPerFrame, remaining)
      : this.getCharsForFrame(remaining);
    const desiredLength = Math.min(
      this.targetContent.length,
      this.renderedContent.length + chars,
    );
    // Boundary search works in absolute positions: the cut must advance by at
    // least minCharsPerFrame (never stall) and must not overshoot the desired
    // cut. Passing the per-frame *increments* as bounds would clamp a larger
    // desired cut back to the previous position and freeze rendering.
    const nextLength =
      this.draining || remaining <= this.maxCharsPerFrame
        ? desiredLength
        : findBoundary(
            this.targetContent,
            Math.min(this.targetContent.length, this.renderedContent.length + this.minCharsPerFrame),
            desiredLength,
            desiredLength,
          );

    this.renderedContent = this.targetContent.slice(0, nextLength);
    this.options.emit(this.renderedContent);

    if (this.renderedContent.length < this.targetContent.length) {
      this.schedulePump();
    } else if (this.draining) {
      this.finalizeDone();
    }
  }

  private get frameMs(): number {
    return this.options.frameMs ?? DEFAULT_FRAME_MS;
  }

  private get targetLagMs(): number {
    return this.options.targetLagMs ?? DEFAULT_TARGET_LAG_MS;
  }

  private get maxLagMs(): number {
    return Math.max(this.targetLagMs, this.options.maxLagMs ?? DEFAULT_MAX_LAG_MS);
  }

  private get minCharsPerFrame(): number {
    return this.options.minCharsPerFrame ?? DEFAULT_MIN_CHARS_PER_FRAME;
  }

  private get maxCharsPerFrame(): number {
    return this.options.maxCharsPerFrame ?? DEFAULT_MAX_CHARS_PER_FRAME;
  }

  private getCharsForFrame(remaining: number): number {
    const targetPendingChars = Math.max(
      this.minCharsPerFrame,
      Math.round(this.averageCharsPerSecond * (this.targetLagMs / 1000)),
    );
    const maxPendingChars = Math.max(
      targetPendingChars,
      Math.round(this.averageCharsPerSecond * (this.maxLagMs / 1000)),
    );
    const baseChars = Math.ceil(this.averageCharsPerSecond * (this.frameMs / 1000));
    const excessChars = Math.max(0, remaining - targetPendingChars);
    const catchUpChars = remaining > maxPendingChars ? Math.ceil((remaining - maxPendingChars) / 12) : 0;
    const desired = Math.max(this.minCharsPerFrame, baseChars, Math.ceil(excessChars / 20), catchUpChars);
    return clamp(desired, this.minCharsPerFrame, Math.min(this.maxCharsPerFrame, remaining));
  }
}
