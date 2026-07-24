import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { createResearchDesignTool } from "../../../src/tool/builtin/researchDesign.js";
import { createResearchBriefTool } from "../../../src/tool/builtin/researchDesignBrief.js";
import { researchDesignInput } from "../../research/design/fixtures.js";

const context = {
  sessionId: "session-research-design",
  turnId: "turn-research-design",
  cwd: process.cwd(),
  permissionMode: "default" as const,
  permissionContext: createDefaultPermissionContext({ cwd: process.cwd() }),
  now: () => new Date("2026-07-25T00:00:00.000Z"),
};

test("research_design tool validates and emits the linked artifact package", async () => {
  const tool = createResearchDesignTool();
  const input = researchDesignInput();
  const validation = await tool.validateInput!(input, context);
  assert.equal(validation.ok, true);

  const output = await tool.execute(input, context);
  assert.equal(output.data?.portfolio.kind, "candidate_portfolio");
  assert.equal(output.data?.challengeReport.kind, "challenge_report");
  assert.equal(output.data?.decisionRecord.kind, "decision_record");
  assert.equal(output.data?.researchBrief.kind, "research_brief");
  assert.equal(output.data?.researchBrief.payload.title.status, "provisional");
});

test("research_brief tool increments a brief revision and rejects implicit confirmation", async () => {
  const design = (await createResearchDesignTool().execute(researchDesignInput(), context)).data!;
  const briefTool = createResearchBriefTool();
  const invalid = await briefTool.validateInput!({
    portfolio: design.portfolio,
    candidateId: "adaptive-gate",
    previousBrief: design.researchBrief,
    title: { text: "Final", status: "confirmed" },
  }, context);
  assert.equal(invalid.ok, false);

  const output = await briefTool.execute({
    portfolio: design.portfolio,
    candidateId: "adaptive-gate",
    previousBrief: design.researchBrief,
    challengeReport: design.challengeReport,
    decisionRecord: design.decisionRecord,
    title: {
      text: "Final Research Title",
      status: "confirmed",
      explicitConfirmation: true,
      confirmedBy: "user",
      confirmedAt: "2026-07-25T01:00:00.000Z",
    },
  }, { ...context, now: () => new Date("2026-07-25T01:00:00.000Z") });
  assert.equal(output.data?.revision, 2);
  assert.equal(output.data?.payload.title.status, "confirmed");
});
