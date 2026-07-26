import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBuiltinPlugins } from "../../../src/extension/plugins/builtin/loadBuiltinPlugins.js";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";

test("rigorium-manuscript exposes a natural-language Skill without vendoring an unlicensed venue archive", async () => {
  const builtins = loadBuiltinPlugins();
  const manuscript = builtins.find((plugin) => plugin.name === "rigorium-manuscript");
  assert.ok(manuscript);
  assert.deepEqual(manuscript.skills?.map((skill) => skill.name), ["rigorium-manuscript:manuscript-latex"]);
  assert.equal(manuscript.manifest.settings?.stageMachine, "none");
  assert.equal((manuscript.manifest.settings?.capabilities as string[]).includes("manuscript.render.deterministic_diagnostics"), true);

  const pluginRoot = join(process.cwd(), "src", "extension", "plugins", "builtin", "rigorium-manuscript");
  const files = await readdir(pluginRoot, { recursive: true });
  assert.equal(files.some((file) => /\.(?:zip|sty|bst|cls)$/iu.test(String(file))), false);

  const root = await mkdtemp(join(tmpdir(), "rigorium-manuscript-plugin-"));
  const runtime = new PluginRuntime({ projectRoot: root, rigoriumHome: join(root, ".rigorium"), builtinPlugins: builtins });
  await runtime.refresh();
  assert.equal(runtime.getAllSkills().some((skill) => skill.name === "rigorium-manuscript:manuscript-latex"), true);
});

