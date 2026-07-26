/**
 * Elicitation channel — abstraction over how a synchronous user prompt is
 * delivered (CLI / TUI / Feishu / in-memory test). Owned by the host
 * (Gateway / Adapter), wired into the ToolRuntime via
 * `RigoriumToolRuntimeContext.elicitation`.
 *
 * Behaviour parity with the legacy upstream elicitation handler:
 *   E1 a single round-trip per invocation; channel returns one Result.
 *   E2 user can decline; channel returns `cancelled: true`.
 *   E3 free-form notes per question are optional.
 *   E4 multi-select answers are emitted as `Array<string>` in answers.
 *
 * Coordination with the cron PR (§1.3.1, §5.1):
 *   Gateway protocol naming for this surface is `elicitation_request` /
 *   `elicitation_answer` (no overlap with `cron_*`).
 */
export type RigoriumElicitationOption = {
  label: string;
  description: string;
  preview?: string;
};

export type RigoriumElicitationQuestion = {
  question: string;
  header: string;
  options: RigoriumElicitationOption[];
  multiSelect?: boolean;
};

export type RigoriumElicitationRequest = {
  /** Stable identifier of the underlying tool call. */
  toolCallId: string;
  toolName: string;
  /** Format hint forwarded to the channel. `html` = render previews as HTML. */
  previewFormat?: "html" | "markdown";
  questions: RigoriumElicitationQuestion[];
  /** Free-form metadata forwarded verbatim (e.g. `source: "remember"`). */
  metadata?: Record<string, unknown>;
  /** Cancellation signal: channels MUST honor abort. */
  signal?: AbortSignal;
};

export type RigoriumElicitationAnswer =
  | { type: "answered"; answers: Record<string, string | string[]>; annotations?: Record<string, { preview?: string; notes?: string }> }
  | { type: "cancelled"; reason?: string };

export type RigoriumElicitationChannel = {
  /** Send a question batch to the user and await one answer batch. */
  askUser(request: RigoriumElicitationRequest): Promise<RigoriumElicitationAnswer>;
};

/**
 * Test/in-memory channel: pre-canned answers keyed by question text.
 * Throws if a question is asked that does not have an answer registered.
 */
export class InMemoryElicitationChannel implements RigoriumElicitationChannel {
  private readonly answers: Map<string, string | string[]>;
  private readonly cancelOnAsk: boolean;

  constructor(
    answers: Record<string, string | string[]> = {},
    options: { cancelOnAsk?: boolean } = {},
  ) {
    this.answers = new Map(Object.entries(answers));
    this.cancelOnAsk = options.cancelOnAsk ?? false;
  }

  async askUser(request: RigoriumElicitationRequest): Promise<RigoriumElicitationAnswer> {
    if (this.cancelOnAsk) {
      return { type: "cancelled", reason: "in-memory cancel" };
    }
    const answers: Record<string, string | string[]> = {};
    for (const q of request.questions) {
      if (!this.answers.has(q.question)) {
        throw new Error(`InMemoryElicitationChannel: no canned answer for "${q.question}"`);
      }
      answers[q.question] = this.answers.get(q.question)!;
    }
    return { type: "answered", answers };
  }
}
