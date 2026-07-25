import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { createManuscriptVersion } from "../../../src/research/manuscript/manuscript.js";
import type { ManuscriptCommandRunner } from "../../../src/research/manuscript/render.js";
import {
  createManuscriptTool,
  type ManuscriptRenderInput,
} from "../../../src/tool/builtin/manuscript.js";
import { PilotDeckToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { SYNTHETIC_NOW, minimalLatex } from "../../research/manuscript/fixtures.js";

function context(projectRoot: string): PilotDeckToolRuntimeContext {
  return {
    sessionId: "manuscript-tool-test",
    turnId: "turn-1",
    cwd: projectRoot,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: projectRoot }),
    now: () => SYNTHETIC_NOW,
  };
}

function syntheticManuscript() {
  return createManuscriptVersion({
    title: "Synthetic Tool Fixture",
    latex: minimalLatex(),
    target: { venue: "generic", mode: "internal_draft", maxMainPages: 2 },
    sections: [{
      sectionId: "synthetic",
      kind: "custom",
      title: "Synthetic Fixture",
      requestedOutput: "preserve",
      minimumMaturity: "none",
      statements: [],
    }],
    revisionNote: "Synthetic tool fixture only.",
    producer: { kind: "user" },
    now: SYNTHETIC_NOW,
  });
}

test("manuscript_latex creates a deterministic CitationSet from structured entry data", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rigorium-manuscript-tool-citations-"));
  const tool = createManuscriptTool();
  const input = {
    action: "citation_set" as const,
    artifactId: "tool-citations",
    bibtexEntries: [{
      citationKey: "synthetic2026",
      entryType: "article",
      paperId: "paper-synthetic",
      fields: { title: "Synthetic source", author: "Synthetic Author", year: "2026" },
    }],
  };

  assert.equal(tool.isReadOnly(input), true);
  const output = await tool.execute(input, context(projectRoot));
  assert.equal(output.data?.action, "citation_set");
  if (output.data?.action !== "citation_set") assert.fail("expected citation_set result");
  assert.deepEqual(output.data.artifact.payload.citationKeys, ["synthetic2026"]);
  assert.match(output.data.artifact.payload.bibtex, /@article\{synthetic2026,/u);
});

test("manuscript_latex keeps immature result statements outline-only", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rigorium-manuscript-tool-sections-"));
  const tool = createManuscriptTool();
  const output = await tool.execute({
    action: "section_audit",
    sections: [{
      sectionId: "results",
      kind: "results",
      title: "Synthetic Results",
      requestedOutput: "draft",
      minimumMaturity: "observed_result",
      statements: [{
        statementId: "result-1",
        kind: "result",
        maturity: "citation_only",
        citationKeys: ["synthetic2026"],
        evidenceRefs: [],
        figureTableRefs: [],
        textOrigin: "agent_assisted",
      }],
    }],
  }, context(projectRoot));

  assert.equal(output.data?.action, "section_audit");
  if (output.data?.action !== "section_audit") assert.fail("expected section_audit result");
  assert.equal(output.data.audits[0]?.status, "blocked");
  assert.equal(output.data.audits[0]?.allowedOutput, "outline_only");
  assert.equal(output.data.audits[0]?.blockers.some((blocker) => blocker.code === "missing_observed_result"), true);
});

test("manuscript_latex does not infer an ICLR 2027 template", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rigorium-manuscript-tool-template-"));
  const output = await createManuscriptTool().execute({
    action: "template_probe",
    conferenceYear: 2027,
  }, context(projectRoot));

  assert.equal(output.data?.action, "template_probe");
  if (output.data?.action !== "template_probe") assert.fail("expected template_probe result");
  assert.equal(output.data.probe.status, "unverified_year");
  assert.equal(output.data.probe.pin, undefined);
});

test("manuscript_latex marks render side effects and returns a synthetic compile artifact", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rigorium-manuscript-tool-render-"));
  const runner: ManuscriptCommandRunner = async (request) => {
    assert.ok(request.cwd);
    const buildDirectory = join(request.cwd, "build");
    await mkdir(buildDirectory, { recursive: true });
    await writeFile(join(buildDirectory, "main.pdf"), "%PDF-1.4\n% synthetic tool fixture\n", "utf8");
    await writeFile(join(buildDirectory, "main.log"), "Synthetic compiler log.\n", "utf8");
    return { exitCode: 0, stdout: "synthetic latexmk", stderr: "", timedOut: false };
  };
  const tool = createManuscriptTool({
    render: {
      runner,
      engineProbes: [{ name: "latexmk", status: "available", executable: "latexmk", version: "synthetic" }],
    },
  });
  const input: ManuscriptRenderInput = {
    action: "render",
    manuscript: syntheticManuscript(),
    engine: "latexmk",
  };

  assert.equal(tool.isReadOnly(input), false);
  assert.equal(tool.isConcurrencySafe(input), false);
  assert.equal(tool.isDestructive?.(input), false);
  assert.equal(tool.requiresUserInteraction?.(input), false);
  assert.equal(tool.isDestructive?.({
    ...input,
    export: { confirmed: false, overwrite: true, outputDirectory: "exports/manuscript", include: ["pdf"] },
  }), false);
  assert.equal(tool.requiresUserInteraction?.({
    ...input,
    export: { confirmed: false, outputDirectory: "exports/manuscript", include: ["pdf"] },
  }), true);
  assert.equal(tool.isDestructive?.({
    ...input,
    export: { confirmed: true, overwrite: true, outputDirectory: "exports/manuscript", include: ["pdf"] },
  }), true);
  assert.equal(tool.requiresUserInteraction?.({
    ...input,
    export: { confirmed: true, overwrite: true, outputDirectory: "exports/manuscript", include: ["pdf"] },
  }), true);

  const output = await tool.execute(input, context(projectRoot));
  assert.equal(output.data?.action, "render");
  if (output.data?.action !== "render") assert.fail("expected render result");
  assert.equal(output.data.artifact.payload.compileStatus, "succeeded");
  assert.equal(output.data.artifact.payload.exportBoundary.performed, false);
});

test("manuscript_latex rejects action-specific fields and maps path validation to invalid_tool_input", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rigorium-manuscript-tool-validation-"));
  const tool = createManuscriptTool();
  const validation = await tool.validateInput!({
    action: "citation_set",
    bibtexEntries: [{ citationKey: "synthetic2026", entryType: "article", fields: { title: "Synthetic source" } }],
    engine: "latexmk",
  } as never, context(projectRoot));
  assert.equal(validation.ok, false);
  if (validation.ok) assert.fail("expected validation failure");
  assert.match(validation.issues[0]?.message ?? "", /citation_set\.engine is not supported/u);

  await assert.rejects(
    tool.execute({
      action: "render",
      manuscript: syntheticManuscript(),
      templateDirectory: "../outside-project",
    }, context(projectRoot)),
    (error: unknown) => error instanceof PilotDeckToolRuntimeError && error.code === "invalid_tool_input",
  );
});
