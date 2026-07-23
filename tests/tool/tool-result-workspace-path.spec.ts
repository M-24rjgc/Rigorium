import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, relative, win32 } from "node:path";
import { tmpdir } from "node:os";

import { ToolResultBudget } from "../../src/context/budget/ToolResultBudget.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { resolvePilotDeckWorkspacePath } from "../../src/tool/builtin/filesystem/pathSafety.js";

function context(
  cwd: string,
  permissionMode: "default" | "bypassPermissions" = "bypassPermissions",
) {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode,
    permissionContext: {
      mode: permissionMode,
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    now: () => new Date("2026-07-09T00:00:00.000Z"),
  };
}

test("large tool results are persisted under workspace .pilotdeck and readable by read_file", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-readable-tool-result-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-home-"));
  try {
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "web:s_test",
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    assert.match(relative(projectRoot, storage.toolResultsDir), /^\.pilotdeck[\/\\]tool-results[\/\\]/);

    const budget = new ToolResultBudget({
      toolResultsDir: storage.toolResultsDir,
      maxResultSizeChars: 64,
      maxResultSizeTokens: 20,
      previewBytes: 32,
    });
    const message = await budget.applyToMessage({
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "call-large",
        content: [{ type: "text", text: `alpha\n${"x".repeat(200)}\nomega` }],
      }],
    }, { turnId: "turn-1" });

    const ref = message.content.find((block) => block.type === "tool_result_reference");
    assert.ok(ref, "expected a persisted tool_result_reference");
    assert.match(relative(projectRoot, ref.path), /^\.pilotdeck[\/\\]tool-results[\/\\]/);
    assert.equal(ref.path.includes(String.fromCharCode(92)), false, "protocol paths use forward slashes");
    assert.equal(ref.readFilePath, ".pilotdeck/tool-results/refs/result-0001.txt");
    assert.equal(ref.readFilePath.includes(String.fromCharCode(92)), false, "read_file aliases use forward slashes");
    assert.equal(await readFile(join(projectRoot, ref.readFilePath), "utf8"), `alpha\n${"x".repeat(200)}\nomega`);

    const read = await createReadFileTool().execute({ file_path: ref.readFilePath, offset: 1, limit: 2 }, context(projectRoot));
    const text = read.content[0]?.type === "text" ? read.content[0].text : "";
    assert.match(text, /alpha/);
    assert.match(text, /2\|x+/);

    const backslashInput = ref.readFilePath.split("/").join(win32.sep);
    const readWithBackslashes = await createReadFileTool().execute(
      { file_path: backslashInput, offset: 1, limit: 2 },
      context(projectRoot),
    );
    const backslashText = readWithBackslashes.content[0]?.type === "text" ? readWithBackslashes.content[0].text : "";
    assert.match(backslashText, /alpha/);
    assert.match(backslashText, /2\|x+/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("workspace paths accept both separator styles, emit protocol paths, and reject escapes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-path-boundary-"));
  try {
    const secureContext = context(projectRoot, "default");
    const forward = resolvePilotDeckWorkspacePath("nested/file.txt", secureContext);
    const backslash = resolvePilotDeckWorkspacePath(
      ["nested", "file.txt"].join(win32.sep),
      secureContext,
    );
    const escaped = resolvePilotDeckWorkspacePath(
      ["..", "outside.txt"].join(win32.sep),
      secureContext,
    );

    assert.ok(forward.ok);
    assert.ok(backslash.ok);
    assert.equal(forward.absolutePath, join(projectRoot, "nested", "file.txt"));
    assert.equal(backslash.absolutePath, join(projectRoot, "nested", "file.txt"));
    assert.equal(forward.relativePath, "nested/file.txt");
    assert.equal(backslash.relativePath, "nested/file.txt");
    assert.equal(escaped.ok, false);
    if (!escaped.ok) {
      assert.equal(escaped.error.code, "path_not_allowed");
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("large tool result read_file aliases are short and sequential", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-readable-tool-result-seq-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-home-"));
  try {
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "web:s_test",
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    const budget = new ToolResultBudget({
      toolResultsDir: storage.toolResultsDir,
      maxResultSizeChars: 16,
      maxResultSizeTokens: 5,
      previewBytes: 8,
    });

    const first = await budget.applyToMessage({
      role: "user",
      content: [{ type: "tool_result", toolCallId: "call-a", content: [{ type: "text", text: "first\n" + "a".repeat(80) }] }],
    }, { turnId: "turn-1" });
    const second = await budget.applyToMessage({
      role: "user",
      content: [{ type: "tool_result", toolCallId: "call-b", content: [{ type: "text", text: "second\n" + "b".repeat(80) }] }],
    }, { turnId: "turn-1" });

    const firstRef = first.content.find((block) => block.type === "tool_result_reference");
    const secondRef = second.content.find((block) => block.type === "tool_result_reference");
    assert.ok(firstRef);
    assert.ok(secondRef);
    assert.equal(firstRef.readFilePath, ".pilotdeck/tool-results/refs/result-0001.txt");
    assert.equal(secondRef.readFilePath, ".pilotdeck/tool-results/refs/result-0002.txt");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
