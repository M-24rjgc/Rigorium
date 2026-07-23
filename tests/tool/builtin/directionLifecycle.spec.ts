import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PermissionRuntime } from "../../../src/permission/index.js";
import {
  createResearchDirectionLifecycleTool,
  type ResearchDirectionLifecycleArtifact,
} from "../../../src/tool/builtin/directionLifecycle.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

const createdAt = new Date("2026-07-23T00:00:00.000Z");

function seed() {
  return {
    cues: [
      { id: "interest", kind: "interest" as const, text: "Reliable small-model evaluation" },
      { id: "observation", kind: "experiment_observation" as const, text: "Errors cluster under distribution shift" },
    ],
    terminology: [{ id: "shift", text: "distribution shift", cueIds: ["observation"], status: "observed" as const }],
    constraints: [{ id: "compute", kind: "compute" as const, label: "Single-device budget", status: "unknown" as const, cueIds: ["interest"] }],
    candidates: [{
      id: "candidate-1",
      summary: "Evaluate a bounded small-model intervention under distribution shift.",
      cueIds: ["interest", "observation"],
      terminologyIds: ["shift"],
      constraintIds: ["compute"],
      titleSeed: "Evaluating a bounded small-model intervention under distribution shift",
    }],
  };
}

function context(root: string) {
  return { cwd: root, now: () => createdAt } as any;
}

test("research_direction_lifecycle saves and reloads one project-local lifecycle artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-direction-lifecycle-tool-"));
  const tool = createResearchDirectionLifecycleTool();
  assert.equal(tool.isReadOnly({ operation: "load", projectRoot: root }), true);
  assert.equal(tool.isReadOnly({ operation: "save", projectRoot: root, seed: seed() }), false);
  assert.equal(tool.isConcurrencySafe({ operation: "save", projectRoot: root, seed: seed() }), false);
  assert.match(tool.description, /natural-language research discussion/u);
  assert.match(tool.description, /never renames a Project/u);

  const saved = await tool.execute({ operation: "save", projectRoot: root, seed: seed() }, context(root));
  const artifact = saved.data as ResearchDirectionLifecycleArtifact;
  assert.equal(artifact.operation, "saved");
  assert.equal(artifact.created, true);
  assert.equal(artifact.persisted, true);
  assert.equal(artifact.state?.checklist.status, "in_progress");
  assert.match(saved.content[0]?.type === "text" ? saved.content[0].text : "", /Research direction lifecycle/u);
  assert.match(saved.content[0]?.type === "text" ? saved.content[0].text : "", /研究方向生命周期/u);
  assert.equal(artifact.state?.checklist.projectNameAction.requiresExplicitUserAction, true);
  assert.equal("projectName" in (artifact.state ?? {}), false);

  const loaded = await tool.execute({ operation: "load", projectRoot: root }, context(root));
  const loadedArtifact = loaded.data as ResearchDirectionLifecycleArtifact;
  assert.equal(loadedArtifact.operation, "loaded");
  assert.equal(loadedArtifact.state?.revision, artifact.state?.revision);
  assert.equal(loadedArtifact.state?.selectedDirectionId, undefined);
});

test("research_direction_lifecycle rejects invalid state transitions before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-direction-lifecycle-tool-invalid-"));
  const tool = createResearchDirectionLifecycleTool();
  const invalidLoad = await tool.validateInput?.({ operation: "load", projectRoot: root, seed: seed() } as any, context(root));
  const invalidSave = await tool.validateInput?.({ operation: "save", projectRoot: root } as any, context(root));
  assert.equal(invalidLoad?.ok, false);
  assert.equal(invalidSave?.ok, false);

  await assert.rejects(
    tool.execute({ operation: "save", projectRoot: root } as any, context(root)),
    /save requires at least one lifecycle update field/u,
  );
});

test("research_direction_lifecycle save remains permission-gated in normal sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-direction-lifecycle-tool-permission-"));
  const registry = new ToolRegistry();
  registry.register(createResearchDirectionLifecycleTool());
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const result = await runtime.execute({
    id: "direction-lifecycle-permission",
    name: "research_direction_lifecycle",
    input: { operation: "save", projectRoot: root, seed: seed() },
  }, {
    cwd: root,
    now: () => createdAt,
    sessionId: "direction-lifecycle-session",
    turnId: "direction-lifecycle-turn",
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  } as any);
  assert.equal(result.type, "error");
  assert.equal(result.error.code, "permission_required");
});
