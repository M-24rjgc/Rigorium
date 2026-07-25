import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import {
  buildResearchArtifactGraph,
  toResearchArtifactRef,
} from "../../../src/research/artifacts/index.js";
import { createEvidencePackArtifact } from "../../../src/research/literature/evidencePack.js";
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

test("research_design tool carries an explicit external artifact closure into its package", async () => {
  const root = createEvidencePackArtifact({
    artifactId: "tool-design-evidence-root",
    entries: [evidenceEntry("tool-root-evidence", "Tool root evidence.")],
    producer: { kind: "import", id: "tool-test" },
    now: new Date("2026-07-25T00:00:00.000Z"),
  });
  const evidence = createEvidencePackArtifact({
    artifactId: "tool-design-evidence",
    entries: [evidenceEntry("tool-external-evidence", "Tool child evidence.")],
    producer: { kind: "import", id: "tool-test" },
    parents: [{ relation: "derived_from", artifact: toResearchArtifactRef(root) }],
    now: new Date("2026-07-25T00:01:00.000Z"),
  });
  const externalParent = { relation: "uses" as const, artifact: toResearchArtifactRef(evidence) };
  const input = {
    ...researchDesignInput(),
    parents: [externalParent],
    brief: { parents: [externalParent] },
    sourceArtifacts: [root, evidence],
  };
  const tool = createResearchDesignTool();

  const validation = await tool.validateInput!(input, context);
  assert.equal(validation.ok, true);
  const output = await tool.execute(input, context);
  assert.equal(output.data?.sourceArtifacts.length, 2);
  assert.equal(output.metadata?.sourceArtifactCount, 2);
  assert.equal(buildResearchArtifactGraph(output.data!.artifacts).missingParents.length, 0);

  const incomplete = await tool.validateInput!({ ...input, sourceArtifacts: [evidence] }, context);
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.match(incomplete.issues[0]!.message, /complete, valid Artifact DAG closure/iu);
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

function evidenceEntry(id: string, content: string) {
  return {
    id,
    paperId: `${id}-paper`,
    locator: { sourceId: "synthetic", recordId: id, page: 1 },
    snapshot: { content },
  };
}
