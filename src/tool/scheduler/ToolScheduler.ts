import type { RigoriumToolResult } from "../protocol/result.js";
import type { RigoriumToolCall, RigoriumToolRuntimeContext } from "../protocol/types.js";

export type RigoriumToolScheduler = {
  executeAll(calls: RigoriumToolCall[], context: RigoriumToolRuntimeContext): Promise<RigoriumToolResult[]>;
};
