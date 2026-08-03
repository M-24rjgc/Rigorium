import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";

/**
 * The UI plugin manager writes plugins.json in the *nested* shape
 * (`{ name: { enabled: false } }`) while the gateway historically read the
 * *flat* shape (`{ name: false }`). A plugin disabled in the UI must be
 * gated out of the agent runtime in both shapes.
 */

async function createProjectWithPlugin(): Promise<{ projectRoot: string; rigoriumHome: string; name: string }> {
  const root = await mkdtemp(join(tmpdir(), "rigorium-plugin-gate-"));
  const projectRoot = join(root, "project");
  const rigoriumHome = join(root, "home");
  await mkdir(join(rigoriumHome), { recursive: true });
  await mkdir(join(projectRoot, ".rigorium", "plugins", "research-gated", "skills", "demo"), { recursive: true });
  await writeFile(
    join(projectRoot, ".rigorium", "plugins", "research-gated", "plugin.json"),
    JSON.stringify({ name: "research-gated", version: "1.0.0" }),
    "utf8",
  );
  await writeFile(
    join(projectRoot, ".rigorium", "plugins", "research-gated", "skills", "demo", "SKILL.md"),
    ["---", "name: research-gated:demo", "description: Demo skill", "---", "Demo."].join("\n"),
    "utf8",
  );
  return { projectRoot, rigoriumHome, name: "research-gated" };
}

test("plugins.json nested shape: {enabled:false} gates the plugin out", async (t) => {
  const { projectRoot, rigoriumHome, name } = await createProjectWithPlugin();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(rigoriumHome, { recursive: true, force: true }));
  const enablePath = join(rigoriumHome, "plugins.json");
  await writeFile(enablePath, JSON.stringify({ [name]: { enabled: false } }), "utf8");

  const runtime = new PluginRuntime({ projectRoot, rigoriumHome, pluginEnableConfigPath: enablePath });
  const report = await runtime.refreshWithReport();
  assert.equal(report.next.some((plugin) => plugin.name === name), false, "UI-disabled plugin must not load");
});

test("plugins.json flat shape: false gates the plugin out (legacy UI writes)", async (t) => {
  const { projectRoot, rigoriumHome, name } = await createProjectWithPlugin();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(rigoriumHome, { recursive: true, force: true }));
  const enablePath = join(rigoriumHome, "plugins.json");
  await writeFile(enablePath, JSON.stringify({ [name]: false }), "utf8");

  const runtime = new PluginRuntime({ projectRoot, rigoriumHome, pluginEnableConfigPath: enablePath });
  const report = await runtime.refreshWithReport();
  assert.equal(report.next.some((plugin) => plugin.name === name), false, "flat-disabled plugin must not load");
});

test("plugins.json nested shape: {enabled:true} and missing entry keep the plugin", async (t) => {
  const { projectRoot, rigoriumHome, name } = await createProjectWithPlugin();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(rigoriumHome, { recursive: true, force: true }));

  const enabledPath = join(rigoriumHome, "plugins.json");
  await writeFile(enabledPath, JSON.stringify({ [name]: { enabled: true } }), "utf8");
  const enabledRuntime = new PluginRuntime({ projectRoot, rigoriumHome, pluginEnableConfigPath: enabledPath });
  const enabledReport = await enabledRuntime.refreshWithReport();
  assert.equal(enabledReport.next.some((plugin) => plugin.name === name), true);

  // Missing file → everything enabled.
  await rm(enabledPath, { force: true });
  const missingRuntime = new PluginRuntime({ projectRoot, rigoriumHome, pluginEnableConfigPath: enabledPath });
  const missingReport = await missingRuntime.refreshWithReport();
  assert.equal(missingReport.next.some((plugin) => plugin.name === name), true);
});
