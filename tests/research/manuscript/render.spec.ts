import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManuscriptVersion } from "../../../src/research/manuscript/manuscript.js";
import {
  createNodeManuscriptCommandRunner,
  detectLatexEngines,
  parseLatexDiagnostics,
  renderManuscript,
  type ManuscriptCommandRunner,
} from "../../../src/research/manuscript/render.js";
import { SYNTHETIC_NOW, minimalLatex } from "./fixtures.js";

test("engine detection records absence and timeout without treating them as availability", async () => {
  const runner: ManuscriptCommandRunner = async ({ executable }) => {
    if (executable === "latexmk") return { exitCode: null, stdout: "", stderr: "", timedOut: false, errorCode: "ENOENT" };
    if (executable === "biber") return { exitCode: null, stdout: "", stderr: "", timedOut: true };
    return { exitCode: 0, stdout: `${executable} synthetic-version\n`, stderr: "", timedOut: false };
  };
  const probes = await detectLatexEngines({ runner, timeoutMs: 10 });
  assert.equal(probes.find((probe) => probe.name === "latexmk")?.status, "absent");
  assert.equal(probes.find((probe) => probe.name === "biber")?.status, "timed_out");
  assert.equal(probes.find((probe) => probe.name === "pdflatex")?.status, "available");
});

test("diagnostic parser is deterministic and separates undefined citations", () => {
  const diagnostics = parseLatexDiagnostics([
    "Package natbib Warning: Citation `synthetic' on page 1 undefined on input line 4.",
    "Package natbib Warning: Citation `synthetic' on page 1 undefined on input line 4.",
    "Overfull \\hbox (1.0pt too wide)",
  ].join("\n"));
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics.some((entry) => entry.code === "undefined_citation"), true);
});

test("render commands omit ambient secrets and enforce each engine's verified unsafe-feature guard", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rigorium-manuscript-security-project-"));
  const manuscript = createManuscriptVersion({
    title: "Synthetic Security Fixture",
    latex: minimalLatex(),
    target: { venue: "generic", mode: "internal_draft" },
    sections: [{
      sectionId: "security",
      kind: "custom",
      title: "Security Fixture",
      requestedOutput: "preserve",
      minimumMaturity: "none",
      statements: [],
    }],
    revisionNote: "Synthetic process-boundary fixture only.",
    producer: { kind: "user" },
    now: SYNTHETIC_NOW,
  });
  const originalSecret = process.env.RIGORIUM_MANUSCRIPT_TEST_SECRET;
  process.env.RIGORIUM_MANUSCRIPT_TEST_SECRET = "must-not-reach-compiler";
  try {
    for (const engine of ["latexmk", "tectonic", "pdflatex", "xelatex", "lualatex"] as const) {
      const calls: Parameters<ManuscriptCommandRunner>[0][] = [];
      const runner: ManuscriptCommandRunner = async (request) => {
        calls.push(request);
        assert.ok(request.cwd);
        const buildDirectory = join(request.cwd, "build");
        await mkdir(buildDirectory, { recursive: true });
        await writeFile(join(buildDirectory, "main.pdf"), "%PDF-1.4\n% synthetic fixture\n", "utf8");
        await writeFile(join(buildDirectory, "main.log"), "Synthetic compiler log.\n", "utf8");
        return { exitCode: 0, stdout: "synthetic compiler output", stderr: "", timedOut: false };
      };
      const result = await renderManuscript({
        projectRoot,
        manuscript,
        engine,
        producer: { kind: "tool", toolName: "manuscript_latex" },
        now: SYNTHETIC_NOW,
      }, {
        runner,
        engineProbes: [{ name: engine, status: "available", executable: engine, version: "synthetic" }],
      });

      assert.equal(result.payload.compileStatus, "succeeded");
      const command = calls.find((call) => call.executable === engine);
      assert.ok(command);
      assert.equal(command.args.some((arg) => ["-shell-escape", "--shell-escape", "-enable-write18", "--enable-write18"].includes(arg)), false);
      if (engine === "tectonic") assert.equal(command.args.includes("--untrusted"), true);
      else assert.equal(command.args.includes("-no-shell-escape"), true);
      assert.equal(command.env?.RIGORIUM_MANUSCRIPT_TEST_SECRET, undefined);
      const allowedEnvironmentKeys = new Set([
        "PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE",
        "LANG", "LC_ALL", "SOURCE_DATE_EPOCH", "FORCE_SOURCE_DATE", "TZ",
      ]);
      assert.equal(Object.keys(command.env ?? {}).every((key) => allowedEnvironmentKeys.has(key)), true);
    }
  } finally {
    if (originalSecret === undefined) delete process.env.RIGORIUM_MANUSCRIPT_TEST_SECRET;
    else process.env.RIGORIUM_MANUSCRIPT_TEST_SECRET = originalSecret;
  }
});

test("node manuscript runner bounds timeout and pre-cancelled process termination", async () => {
  const runner = createNodeManuscriptCommandRunner();
  const timeoutStarted = Date.now();
  const timedOut = await runner({
    executable: process.execPath,
    args: ["-e", "setInterval(() => undefined, 1000)"],
    timeoutMs: 50,
  });
  assert.equal(timedOut.timedOut, true);
  assert.ok(Date.now() - timeoutStarted < 6_000);

  const controller = new AbortController();
  controller.abort();
  const abortStarted = Date.now();
  const aborted = await runner({
    executable: process.execPath,
    args: ["-e", "setInterval(() => undefined, 1000)"],
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  assert.equal(aborted.timedOut, false);
  assert.ok(Date.now() - abortStarted < 6_000);
});

test("RenderRun performs a real tiny compile when an engine exists and keeps export explicit", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rigorium-manuscript-render-project-"));
  const manuscript = createManuscriptVersion({
    title: "Synthetic Compile Fixture",
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
    revisionNote: "Synthetic compile fixture only.",
    producer: { kind: "user" },
    now: SYNTHETIC_NOW,
  });
  const probes = await detectLatexEngines({ timeoutMs: 10_000 });
  const latexmk = probes.find((probe) => probe.name === "latexmk" && probe.status === "available");
  if (!latexmk) {
    const absent = await renderManuscript({
      projectRoot,
      manuscript,
      producer: { kind: "tool", toolName: "manuscript_latex" },
      now: SYNTHETIC_NOW,
    }, { engineProbes: probes });
    assert.equal(absent.payload.compileStatus, "engine_unavailable");
    return;
  }

  const result = await renderManuscript({
    projectRoot,
    manuscript,
    engine: "latexmk",
    export: {
      confirmed: true,
      outputDirectory: "exports/synthetic-manuscript",
      include: ["pdf", "tex", "log", "diagnostics", "manifest"],
    },
    producer: { kind: "tool", toolName: "manuscript_latex" },
    now: SYNTHETIC_NOW,
  }, { engineProbes: probes });

  assert.equal(result.payload.compileStatus, "succeeded");
  assert.equal(result.payload.command.includes("-no-shell-escape"), true);
  assert.equal(result.payload.command.includes("-shell-escape"), false);
  assert.equal(result.payload.exportBoundary.performed, true);
  assert.equal(result.payload.outputs.some((output) => output.kind === "pdf" && output.exported), true);
  await access(join(projectRoot, "exports", "synthetic-manuscript", "manuscript.pdf"));
});
