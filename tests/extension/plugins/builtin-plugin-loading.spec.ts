import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBuiltinPluginsFromDirectory } from "../../../src/extension/plugins/builtin/loadBuiltinPlugins.js";

test("builtin plugins load their markdown contributions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-builtin-plugins-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const pluginRoot = join(root, "research-example");
  await Promise.all([
    mkdir(join(pluginRoot, "skills", "discovery"), { recursive: true }),
    mkdir(join(pluginRoot, "commands"), { recursive: true }),
    mkdir(join(pluginRoot, "output-styles"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({
      name: "research-example",
      version: "1.0.0",
      mcpServers: { research: { instructions: "Use verified sources." } },
    }), "utf8"),
    writeFile(join(pluginRoot, "skills", "discovery", "SKILL.md"), [
      "---",
      "description: Find evidence",
      "---",
      "Find evidence with locators.",
    ].join("\n"), "utf8"),
    writeFile(join(pluginRoot, "commands", "refresh.md"), "Refresh evidence.", "utf8"),
    writeFile(join(pluginRoot, "output-styles", "report.md"), "Render an evidence report.", "utf8"),
  ]);

  const [plugin] = loadBuiltinPluginsFromDirectory(root);
  assert.ok(plugin);
  assert.equal(plugin.name, "research-example");
  assert.deepEqual(plugin.skills?.map((entry) => entry.name), ["research-example:discovery"]);
  assert.equal(plugin.skills?.[0]?.frontmatter.description, "Find evidence");
  assert.equal(plugin.skills?.[0]?.content, "Find evidence with locators.");
  assert.deepEqual(plugin.commands?.map((entry) => entry.name), ["research-example:refresh"]);
  assert.deepEqual(plugin.outputStyles?.map((entry) => entry.name), ["research-example:report"]);
  assert.deepEqual(plugin.mcpServers, { research: { instructions: "Use verified sources." } });
});
