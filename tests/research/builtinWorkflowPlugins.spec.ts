import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadBuiltinPluginsFromDirectory } from "../../src/extension/plugins/builtin/loadBuiltinPlugins.js";

const builtinDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/extension/plugins/builtin");

test("research workflow plugins expose model-discoverable skills", () => {
  const plugins = loadBuiltinPluginsFromDirectory(builtinDirectory);
  const expectations = [
    {
      plugin: "rigorium-research-design",
      skill: "rigorium-research-design:research-design",
      frontmatterName: "research-design",
      toolName: "research_design",
    },
    {
      plugin: "rigorium-experimentation",
      skill: "rigorium-experimentation:experiment-control",
      frontmatterName: "experiment-control",
      toolName: "experiment_control",
    },
    {
      plugin: "rigorium-method",
      skill: "rigorium-method:research-method",
      frontmatterName: "research-method",
      toolName: "research_method",
    },
  ];
  for (const expected of expectations) {
    const plugin = plugins.find((candidate) => candidate.name === expected.plugin);
    assert.ok(plugin, `Missing builtin plugin ${expected.plugin}.`);
    const skill = plugin.skills?.find((candidate) => candidate.name === expected.skill);
    assert.ok(skill, `Missing builtin skill ${expected.skill}.`);
    assert.equal(skill.isSkill, true);
    assert.equal(skill.frontmatter.name, expected.frontmatterName);
    assert.equal(typeof skill.frontmatter.description, "string");
    assert.match(skill.content, new RegExp(`\\b${expected.toolName}\\b`, "u"));
  }
});
