import type { RigoriumHookEvent } from "../protocol/events.js";

export type RigoriumHookExecutionEvent =
  | {
      type: "started";
      hookName: string;
      hookEvent: RigoriumHookEvent;
    }
  | {
      type: "response";
      hookName: string;
      hookEvent: RigoriumHookEvent;
      stdout: string;
      stderr: string;
      exitCode?: number;
      outcome: "success" | "blocking" | "non_blocking_error" | "cancelled" | "timeout";
    };

export type RigoriumHookExecutionEventHandler = (event: RigoriumHookExecutionEvent) => void;

export class HookExecutionEventBus {
  private handlers = new Set<RigoriumHookExecutionEventHandler>();

  subscribe(handler: RigoriumHookExecutionEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: RigoriumHookExecutionEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
