import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import {
  createResearchArtifact,
  toResearchArtifactRef,
  type ResearchArtifactEnvelope,
} from "../../../src/research/artifacts/index.js";
import type { ResearchDirectorCapability } from "../../../src/research/director/index.js";
import { createResearchDirectorTool } from "../../../src/tool/builtin/researchDirector.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

const NOW = new Date("2026-07-25T11:00:00.000Z");

test("research_director is read-only and never dispatches downstream tools", async () => {
  let recursiveToolCalls = 0;
  const tool = createResearchDirectorTool();
  const input = {
    action: "plan" as const,
    request: {
      goal: { objective: "Plan a traceable research action." },
      artifacts: [],
      capabilities: [capability("search", "search", "evidence_pack")],
      budget: { limitUnits: 10, spentUnits: 0 },
      permissions: { defaultAccess: "allow" as const },
    },
  };
  const context = {
    sessionId: "session-research-director",
    turnId: "turn-research-director",
    cwd: process.cwd(),
    permissionMode: "default" as const,
    permissionContext: createDefaultPermissionContext({ cwd: process.cwd() }),
    now: () => NOW,
    executeTool: async () => {
      recursiveToolCalls += 1;
      throw new Error("Director must not execute downstream tools.");
    },
  };

  assert.equal(tool.isReadOnly(input), true);
  assert.equal(tool.isConcurrencySafe(input), true);
  assert.equal((await tool.validateInput!(input, context)).ok, true);
  const output = await tool.execute(input, context);
  assert.equal(output.data?.action, "plan");
  assert.equal(recursiveToolCalls, 0);
  if (output.data?.action !== "plan") throw new Error("Expected Director plan result.");
  assert.equal(output.data.plan.readyBatches.length, 1);
});

test("research_director stays non-interactive when approval receipts are supplied as planning evidence", async () => {
  const tool = createResearchDirectorTool();
  const exportCapability = capability("exporter", "export_pdf", "render_run");
  const unapproved = {
    action: "plan" as const,
    request: {
      goal: { objective: "Prepare a versioned export." },
      artifacts: [],
      capabilities: [exportCapability],
      budget: { limitUnits: 10, spentUnits: 0 },
      permissions: { defaultAccess: "allow" as const },
    },
  };
  assert.equal(tool.requiresUserInteraction!(unapproved), false);

  const approved = {
    action: "plan" as const,
    request: {
      ...unapproved.request,
      approvals: [{
        receiptId: "approval-export",
        boundary: "export" as const,
        capabilityId: "exporter",
        status: "approved" as const,
        decidedBy: "user",
        decidedAt: NOW.toISOString(),
      }],
    },
  };
  assert.equal(tool.requiresUserInteraction!(approved), false);
  const context = {
    sessionId: "session-research-director",
    turnId: "turn-research-director-approved",
    cwd: process.cwd(),
    permissionMode: "default" as const,
    permissionContext: createDefaultPermissionContext({ cwd: process.cwd() }),
    now: () => NOW,
  };
  const output = await tool.execute(approved, context);
  if (output.data?.action !== "plan") throw new Error("Expected Director plan result.");
  assert.equal(output.data.plan.actions[0]!.confirmationBoundary, "export");
  assert.equal(output.data.plan.actions[0]!.blockedBoundaryIds.length, 0);
});

test("builtin Registry bridges persisted Project artifacts into a Director plan", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rigorium-registry-director-"));
  const registry = createBuiltinRegistry({
    webSearch: false,
    webFetch: false,
    agent: false,
    structuredOutput: false,
    askUserQuestion: false,
    planMode: false,
  });
  const artifactsTool = registry.get("research_artifacts");
  const directorTool = registry.get("research_director");
  assert.ok(artifactsTool, "research_artifacts must be registered.");
  assert.ok(directorTool, "research_director must be registered.");

  const evidence = createResearchArtifact({
    kind: "evidence_pack",
    artifactId: "registry-evidence",
    producer: { kind: "tool", toolName: "literature_closeout" },
    payload: { query: "robust representation learning", sources: ["openalex"] },
    now: NOW,
  });
  await artifactsTool.execute({ operation: "append_batch", artifacts: [evidence] } as never, context(projectRoot));
  const listed = await artifactsTool.execute({ operation: "list", kind: "evidence_pack" } as never, context(projectRoot));
  const persistedArtifacts = (listed.data as { artifacts?: readonly ResearchArtifactEnvelope[] } | undefined)?.artifacts;
  assert.equal(persistedArtifacts?.length, 1);
  const persistedEvidence = persistedArtifacts?.[0];
  assert.ok(persistedEvidence, "The Project repository must return the persisted EvidencePack.");

  const planned = await directorTool.execute({
    action: "plan",
    request: {
      goal: { objective: "Develop a defensible candidate research direction." },
      artifacts: [persistedEvidence],
      capabilities: [{
        ...capability("idea-discovery", "discover", "candidate_portfolio"),
        accepts: ["evidence_pack"],
      }],
      budget: { limitUnits: 10, spentUnits: 0 },
      permissions: { defaultAccess: "allow" },
    },
  } as never, context(projectRoot));
  const result = planned.data as { action: "plan"; plan: { actions: readonly { inputArtifactRefs: readonly unknown[] }[] } } | undefined;
  assert.equal(result?.action, "plan");
  assert.deepEqual(result?.plan.actions[0]?.inputArtifactRefs, [toResearchArtifactRef(persistedEvidence)]);
});

function capability(
  capabilityId: string,
  operation: string,
  produces: ResearchDirectorCapability["produces"][number],
): ResearchDirectorCapability {
  return {
    capabilityId,
    toolName: `tool_${capabilityId}`,
    operation,
    available: true,
    concurrencySafe: true,
    accepts: [],
    produces: [produces],
    dependsOnCapabilityIds: [],
    estimatedCostUnits: 1,
    estimatedDurationMs: 100,
  };
}

function context(cwd: string) {
  return {
    sessionId: "registry-director-test",
    turnId: "registry-director-turn",
    cwd,
    permissionMode: "default" as const,
    permissionContext: createDefaultPermissionContext({ cwd }),
    now: () => NOW,
  };
}
