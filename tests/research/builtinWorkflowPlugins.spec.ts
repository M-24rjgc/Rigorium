import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadBuiltinPluginsFromDirectory } from "../../src/extension/plugins/builtin/loadBuiltinPlugins.js";
import { loadBuiltinPlugins } from "../../src/extension/plugins/builtin/loadBuiltinPlugins.js";
import { PluginRuntime } from "../../src/extension/plugins/runtime/PluginRuntime.js";
import * as Research from "../../src/research/index.js";

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
      plugin: "rigorium-experimentation",
      skill: "rigorium-experimentation:experiment-analysis",
      frontmatterName: "experiment-analysis",
      toolName: "experiment_analysis",
    },
    {
      plugin: "rigorium-experimentation",
      skill: "rigorium-experimentation:experiment-remote",
      frontmatterName: "experiment-remote",
      toolName: "experiment_remote",
    },
    {
      plugin: "rigorium-research-director",
      skill: "rigorium-research-director:research-director",
      frontmatterName: "research-director",
      toolName: "research_director",
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

test("workflow builtin enablement preserves and removes new skill contributions by plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-workflow-plugin-runtime-"));
  const builtinPlugins = loadBuiltinPlugins();
  const defaultRuntime = new PluginRuntime({
    projectRoot: root,
    rigoriumHome: join(root, ".rigorium"),
    builtinPlugins,
  });
  await defaultRuntime.refresh();
  const defaultSkills = defaultRuntime.getAllSkills().map((skill) => skill.name);
  for (const name of [
    "rigorium-experimentation:experiment-analysis",
    "rigorium-experimentation:experiment-remote",
    "rigorium-research-director:research-director",
  ]) {
    assert.equal(defaultSkills.includes(name), true, `Missing enabled builtin skill ${name}.`);
  }

  const disabledRuntime = new PluginRuntime({
    projectRoot: root,
    rigoriumHome: join(root, ".rigorium-disabled"),
    builtinPlugins,
    builtinPluginsEnabled: {
      "rigorium-experimentation": false,
      "rigorium-research-director": false,
    },
  });
  await disabledRuntime.refresh();
  const disabledSkills = disabledRuntime.getAllSkills().map((skill) => skill.name);
  assert.equal(disabledSkills.includes("rigorium-experimentation:experiment-analysis"), false);
  assert.equal(disabledSkills.includes("rigorium-experimentation:experiment-remote"), false);
  assert.equal(disabledSkills.includes("rigorium-research-director:research-director"), false);
  assert.equal(disabledSkills.includes("rigorium-research-design:research-design"), true);
});

test("research director skill requires Project-local artifact persistence before planning", () => {
  const plugins = loadBuiltinPluginsFromDirectory(builtinDirectory);
  const director = plugins.find((plugin) => plugin.name === "rigorium-research-director");
  const skill = director?.skills?.find((entry) => entry.name === "rigorium-research-director:research-director");
  assert.ok(skill);
  assert.match(skill.content, /\bresearch_artifacts\b/u);
  assert.match(skill.content, /\bappend_batch\b/u);
  assert.match(skill.content, /persisted artifact state/u);
});

test("new research modules remain reachable from the public research module", () => {
  assert.equal(typeof Research.getProjectResearchArtifactPaths, "function");
  assert.equal(typeof Research.ExperimentAnalysis.createExperimentAnalysisReport, "function");
  assert.equal(typeof Research.ExperimentRemote.getRemoteExecutionPaths, "function");
  assert.equal(typeof Research.ResearchDirector.createResearchDirectorPlan, "function");
});
