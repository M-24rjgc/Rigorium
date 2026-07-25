import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { createResearchMethodTool } from "../../../src/tool/builtin/researchMethod.js";
import { createReadyBrief, methodSpecInput } from "../../research/method/fixtures.js";

async function roots() {
  const base = await mkdtemp(join(tmpdir(), "rigorium-method-tool-"));
  const projectRoot = join(base, "project");
  const workspaceRoot = join(base, "workspace");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(join(workspaceRoot, "src"), { recursive: true }),
    mkdir(join(workspaceRoot, "tests"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspaceRoot, "src", "model.js"), "export const score = 0.91;\n", "utf8"),
    writeFile(join(workspaceRoot, "tests", "model.test.js"), "// method tool test\n", "utf8"),
    writeFile(join(workspaceRoot, "method.config.json"), "{\"seed\":7}\n", "utf8"),
  ]);
  return { projectRoot, workspaceRoot };
}

function context(cwd: string, hour = 4) {
  return {
    sessionId: "session-research-method",
    turnId: "turn-research-method",
    cwd,
    permissionMode: "default" as const,
    permissionContext: createDefaultPermissionContext({ cwd }),
    now: () => new Date(`2026-07-25T${String(hour).padStart(2, "0")}:00:00.000Z`),
  };
}

test("research_method action wrapper creates, revises, verifies, and snapshots one isolated route", async () => {
  const { projectRoot, workspaceRoot } = await roots();
  const runtime = context(projectRoot);
  const tool = createResearchMethodTool();
  const brief = createReadyBrief();
  const createInput = { action: "create_spec" as const, brief, spec: methodSpecInput() };
  assert.equal((await tool.validateInput!(createInput, runtime)).ok, true);
  const created = await tool.execute(createInput, runtime);
  assert.equal(created.data?.action, "create_spec");
  if (created.data?.action !== "create_spec") throw new Error("Expected create_spec result.");
  assert.equal(created.data.methodSpec.kind, "method_spec");

  const baseRevision = methodSpecInput();
  const { artifactId: _artifactId, revision: _revision, ...revisionSpec } = baseRevision;
  const revised = await tool.execute({
    action: "revise_spec",
    brief,
    previousMethodSpec: created.data.methodSpec,
    spec: {
      ...revisionSpec,
      nonGoals: [...(revisionSpec.nonGoals ?? []), "No claim outside the declared evaluation."],
    },
  }, context(projectRoot, 5));
  assert.equal(revised.data?.action, "revise_spec");
  if (revised.data?.action !== "revise_spec") throw new Error("Expected revise_spec result.");
  assert.equal(revised.data.methodSpec.revision, 2);

  const runInput = {
    action: "run_checks" as const,
    methodSpec: revised.data.methodSpec,
    routeId: "route-node",
    workspaceRoot,
  };
  assert.equal(tool.isReadOnly(runInput), false);
  const checked = await tool.execute(runInput, context(projectRoot, 6));
  assert.equal(checked.data?.action, "run_checks");
  if (checked.data?.action !== "run_checks") throw new Error("Expected run_checks result.");
  assert.equal(checked.data.verificationRecords.length, 3);
  assert.equal(checked.data.verificationRecords.every((record) => record.status === "passed"), true);

  const captureInput = {
    action: "capture_snapshot" as const,
    methodSpec: revised.data.methodSpec,
    routeId: "route-node",
    workspaceRoot,
    configFiles: ["method.config.json"],
    verificationRecords: checked.data.verificationRecords,
    observedConclusions: [{
      id: "observed-tool-checks",
      expectedConclusionId: "expected-calibration",
      statement: "All declared route checks passed through the action wrapper.",
      outcome: "supported" as const,
      verificationRecordIds: checked.data.verificationRecords.map((record) => record.id),
    }],
  };
  assert.equal(tool.isReadOnly(captureInput), true);
  const captured = await tool.execute(captureInput, context(projectRoot, 7));
  assert.equal(captured.data?.action, "capture_snapshot");
  if (captured.data?.action !== "capture_snapshot") throw new Error("Expected capture_snapshot result.");
  assert.equal(captured.data.snapshot.kind, "implementation_snapshot");
  assert.equal(captured.data.snapshot.payload.capturePolicy.autoCommit, false);
  assert.equal(captured.data.snapshot.payload.verificationRecords.length, 3);
});

test("research_method fixes the project root to runtime cwd and rejects a workspace inside it", async () => {
  const { projectRoot } = await roots();
  const nestedWorkspace = join(projectRoot, "nested-workspace");
  await mkdir(nestedWorkspace);
  const tool = createResearchMethodTool();
  const brief = createReadyBrief();
  const created = await tool.execute({ action: "create_spec", brief, spec: methodSpecInput() }, context(projectRoot));
  if (created.data?.action !== "create_spec") throw new Error("Expected create_spec result.");

  const validation = await tool.validateInput!({
    action: "run_checks",
    methodSpec: created.data.methodSpec,
    routeId: "route-node",
    workspaceRoot: nestedWorkspace,
  }, context(projectRoot));
  assert.equal(validation.ok, false);
  if (validation.ok) throw new Error("Expected invalid workspace result.");
  assert.match(validation.issues[0]?.message ?? "", /separate from the project root/iu);
  assert.equal("projectRoot" in tool.inputSchema.properties!, false);
});
