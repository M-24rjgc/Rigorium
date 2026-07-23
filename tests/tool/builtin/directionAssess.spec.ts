import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PermissionRuntime } from "../../../src/permission/index.js";
import {
  createDirectionAssessTool,
  type DirectionAssessInput,
} from "../../../src/tool/builtin/directionAssess.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

const createdAt = "2026-07-23T00:00:00.000Z";

function validInput(): DirectionAssessInput {
  return {
    evidence: [
      {
        id: "evidence-prior",
        paperId: "paper-prior",
        role: "prior_art",
        statement: "The cited paper establishes the task setting.",
        strength: "direct",
      },
      {
        id: "evidence-gap",
        paperId: "paper-gap",
        role: "gap",
        statement: "The cited paper identifies an unresolved evaluation limitation.",
        strength: "direct",
      },
    ],
    constraints: [
      { id: "baseline", kind: "baseline", label: "Reference baseline", status: "satisfied" },
      { id: "evaluation", kind: "evaluation", label: "Evaluation protocol", status: "satisfied" },
    ],
    candidates: [
      {
        id: "evidence-backed",
        summary: "Evaluate a bounded comparison against a reference baseline.",
        titleSeed: "Evaluating a bounded comparison against a reference baseline",
        evidenceIds: ["evidence-prior", "evidence-gap"],
        constraintIds: ["baseline", "evaluation"],
        hypotheses: [
          {
            id: "hypothesis-1",
            statement: "The comparison can be evaluated under the cited setting.",
            failureCriterion: "The comparison does not meet the predeclared evaluation criterion.",
            evidenceIds: ["evidence-prior", "evidence-gap"],
            evaluationConstraintId: "evaluation",
            baselineConstraintIds: ["baseline"],
          },
        ],
      },
      {
        id: "downgraded-title",
        summary: "Evaluate a bounded comparison.",
        titleSeed: "The First SOTA Breakthrough for Every Task",
      },
      {
        id: "rejected-title",
        summary: "A Novel Breakthrough That Solves Every Task",
      },
    ],
  };
}

function runtimeContext() {
  const cwd = join(tmpdir(), "rigorium-direction-assess-project");
  return {
    cwd,
    now: () => new Date(createdAt),
    sessionId: "direction-assess-test-session",
    turnId: "direction-assess-test-turn",
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

test("direction_assess returns a traceable artifact and preserves provisional title states", async () => {
  const tool = createDirectionAssessTool();
  const output = await tool.execute(validInput(), runtimeContext());
  const artifact = output.data;

  assert.equal(artifact?.schemaVersion, 1);
  assert.equal(artifact?.kind, "direction_assessment");
  assert.match(artifact?.artifactId ?? "", /^direction-assessment-/);
  assert.equal(artifact?.createdAt, createdAt);

  const evidenceBacked = artifact?.result.assessments.find((assessment) => assessment.directionId === "evidence-backed");
  assert.deepEqual(evidenceBacked?.score.evidenceIds, ["evidence-gap", "evidence-prior"]);
  assert.deepEqual(evidenceBacked?.score.paperIds, ["paper-gap", "paper-prior"]);
  assert.deepEqual(evidenceBacked?.provisionalTitle.paperIds, ["paper-gap", "paper-prior"]);

  const downgraded = artifact?.result.assessments.find((assessment) => assessment.directionId === "downgraded-title");
  assert.equal(downgraded?.provisionalTitle.status, "downgraded");
  assert.match(downgraded?.provisionalTitle.text ?? "", /^Provisional: Evaluate a bounded comparison\.$/);
  assert.equal(downgraded?.provisionalTitle.reasonCodes.includes("overcommitting_claim"), true);

  const rejected = artifact?.result.assessments.find((assessment) => assessment.directionId === "rejected-title");
  assert.equal(rejected?.provisionalTitle.status, "rejected");
  assert.equal(rejected?.provisionalTitle.text, undefined);
  assert.equal(rejected?.provisionalTitle.reasonCodes.includes("overcommitting_claim"), true);

  const text = output.content.find((content) => content.type === "text");
  assert.match(text && "text" in text ? text.text : "", /provisional title downgraded: Provisional: Evaluate a bounded comparison\./);
  assert.match(text && "text" in text ? text.text : "", /provisional title rejected: no title proposed/);
});

test("direction_assess reports unknown evidence references as invalid tool input through ToolRuntime", async () => {
  const registry = new ToolRegistry();
  registry.register(createDirectionAssessTool());
  const runtime = new ToolRuntime(registry, new PermissionRuntime());

  const result = await runtime.execute({
    id: "invalid-direction-assessment",
    name: "direction_assess",
    input: {
      candidates: [{
        id: "invalid-direction",
        summary: "Evaluate a candidate with an unknown source reference.",
        evidenceIds: ["missing-evidence"],
      }],
    },
  }, runtimeContext());

  assert.equal(result.type, "error");
  assert.equal(result.error.code, "invalid_tool_input");
});
