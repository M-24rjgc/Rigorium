import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createResearchTitleConfirmationTool,
  type ResearchTitleConfirmationArtifact,
} from "../../../src/tool/builtin/titleConfirm.js";

const createdAt = "2026-07-23T00:00:00.000Z";

function runtimeContext() {
  const cwd = join(tmpdir(), "rigorium-title-confirm-project");
  return { cwd, now: () => new Date(createdAt) } as any;
}

function input(confirmed = false) {
  return {
    directionId: "direction-1",
    candidateTitle: "Evaluating calibration under distribution shift",
    confirmed,
    evidence: [{
      id: "evidence-1",
      paperId: "doi:10.1000/example",
      role: "prior_art" as const,
      statement: "Prior work evaluates calibration under deployment shift.",
      strength: "direct" as const,
    }],
  };
}

test("research_title_confirm records pending and confirmed states without renaming a project", async () => {
  const tool = createResearchTitleConfirmationTool();
  const pending = await tool.execute(input(false), runtimeContext());
  const confirmed = await tool.execute(input(true), runtimeContext());
  const pendingArtifact = pending.data as ResearchTitleConfirmationArtifact;
  const confirmedArtifact = confirmed.data as ResearchTitleConfirmationArtifact;

  assert.equal(tool.isReadOnly({} as any), true);
  assert.equal(pendingArtifact.result.confirmation.status, "pending");
  assert.equal(pendingArtifact.result.confirmation.projectNameUpdate.status, "not_ready");
  assert.equal(confirmedArtifact.result.confirmation.status, "confirmed");
  assert.equal(confirmedArtifact.result.confirmation.projectNameUpdate.status, "ready_for_explicit_project_action");
  assert.equal(confirmedArtifact.result.confirmation.projectNameUpdate.name, input(true).candidateTitle);
  assert.equal(confirmedArtifact.createdAt, createdAt);
});

test("research_title_confirm downgrades overclaiming titles when a neutral title is supplied", async () => {
  const tool = createResearchTitleConfirmationTool();
  const result = await tool.execute({
    ...input(true),
    candidateTitle: "A breakthrough that always solves calibration",
    neutralTitle: "Evaluating calibration interventions",
  }, runtimeContext());
  const artifact = result.data as ResearchTitleConfirmationArtifact;
  assert.equal(artifact.result.title.status, "downgraded");
  assert.match(artifact.result.title.text ?? "", /Evaluating calibration/iu);
  assert.equal(artifact.result.confirmation.status, "confirmed");
});

test("research_title_confirm rejects malformed evidence through validation", async () => {
  const tool = createResearchTitleConfirmationTool();
  const validation = await tool.validateInput?.(
    { ...input(), candidateTitle: "" },
    runtimeContext(),
  );
  assert.ok(validation);
  assert.equal(validation.ok, false);
});
