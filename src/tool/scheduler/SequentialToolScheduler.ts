import type { RigoriumToolResult } from "../protocol/result.js";
import type { RigoriumToolCall, RigoriumToolRuntimeContext } from "../protocol/types.js";
import type { ToolRuntime } from "../execution/ToolRuntime.js";
import type { RigoriumToolScheduler } from "./ToolScheduler.js";

export class SequentialToolScheduler implements RigoriumToolScheduler {
  constructor(private readonly runtime: ToolRuntime) {}

  async executeAll(
    calls: RigoriumToolCall[],
    context: RigoriumToolRuntimeContext,
  ): Promise<RigoriumToolResult[]> {
    const results: RigoriumToolResult[] = [];
    for (const call of calls) {
      results.push(await this.runtime.execute(call, context));
    }
    return results;
  }
}
