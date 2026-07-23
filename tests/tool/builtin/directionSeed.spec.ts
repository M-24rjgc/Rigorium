import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PermissionRuntime } from "../../../src/permission/index.js";
import {
  createResearchDirectionSeedTool,
  type ResearchDirectionSeedToolInput,
} from "../../../src/tool/builtin/directionSeed.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

const createdAt = "2026-07-23T00:00:00.000Z";

function validInput(): ResearchDirectionSeedToolInput {
  return {
    cues: [
      { id: "interest", kind: "interest", text: "Efficient scientific machine learning" },
      { id: "algorithm", kind: "algorithm", text: "A low-rank solver" },
    ],
    terminology: [{ id: "term-low-rank", text: "low-rank approximation", cueIds: ["algorithm"], status: "observed" }],
    candidates: [{
      id: "candidate-1",
      summary: "Evaluate a low-rank solver under a bounded scientific workload.",
      cueIds: ["interest", "algorithm"],
      terminologyIds: ["term-low-rank"],
    }],
  };
}

function runtimeContext() {
  const cwd = join(tmpdir(), "rigorium-direction-seed-project");
  return {
    cwd,
    now: () => new Date(createdAt),
    sessionId: "direction-seed-test-session",
    turnId: "direction-seed-test-turn",
    permissionMode: "bypassPermissions" as const,
    permissionContext: {
      mode: "bypassPermissions" as const,
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  } as any;
}

test("research_direction_seed creates a read-only traceable artifact for natural-language agent use", async () => {
  const tool = createResearchDirectionSeedTool();
  const output = await tool.execute(validInput(), runtimeContext());
  const artifact = output.data;

  assert.equal(artifact?.schemaVersion, 1);
  assert.equal(artifact?.kind, "research_direction_seed");
  assert.match(artifact?.artifactId ?? "", /^research-direction-seed-/);
  assert.equal(artifact?.createdAt, createdAt);
  assert.equal(artifact?.result.constraintCoverage.status, "not_provided");
  assert.deepEqual(artifact?.result.candidateDirections[0]?.cueIds, ["algorithm", "interest"]);
  assert.equal(artifact?.result.candidateDirections[0]?.provisionalTitle.confirmation.status, "pending");
  assert.equal(artifact?.result.candidateDirections[0]?.provisionalTitle.confirmation.projectNameUpdate.status, "not_ready");
  assert.match(tool.description, /natural-language research lead/);
  assert.match(tool.description, /does not need to type a slash command/);
  assert.equal(tool.isReadOnly({} as any), true);
});

test("research_direction_seed reports empty cue input through ToolRuntime", async () => {
  const registry = new ToolRegistry();
  registry.register(createResearchDirectionSeedTool());
  const runtime = new ToolRuntime(registry, new PermissionRuntime());

  const result = await runtime.execute({
    id: "invalid-direction-seed",
    name: "research_direction_seed",
    input: { ...validInput(), cues: [] },
  }, runtimeContext());

  assert.equal(result.type, "error");
  assert.equal(result.error.code, "invalid_tool_input");
});
