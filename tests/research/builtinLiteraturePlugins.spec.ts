import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBuiltinPlugins } from "../../src/extension/plugins/builtin/loadBuiltinPlugins.js";
import { PluginRuntime } from "../../src/extension/plugins/runtime/PluginRuntime.js";

test("literature and Zotero builtins expose real discoverable skill contributions", async () => {
  const builtins = loadBuiltinPlugins();
  const literature = builtins.find((plugin) => plugin.name === "rigorium-literature");
  const zotero = builtins.find((plugin) => plugin.name === "rigorium-zotero");
  assert.ok(literature);
  assert.ok(zotero);
  assert.deepEqual(literature.skills?.map((skill) => skill.name), ["rigorium-literature:literature-closeout"]);
  assert.deepEqual(zotero.skills?.map((skill) => skill.name), ["rigorium-zotero:zotero-library"]);
  assert.equal((literature.manifest.settings?.capabilities as string[]).includes("literature.evidence_pack"), true);
  assert.equal((zotero.manifest.settings?.capabilities as string[]).includes("library.cloud.write.confirmed"), true);

  const root = await mkdtemp(join(tmpdir(), "rigorium-plugin-runtime-"));
  const runtime = new PluginRuntime({ projectRoot: root, pilotHome: join(root, ".pilot"), builtinPlugins: builtins });
  await runtime.refresh();
  assert.equal(runtime.getAllSkills().some((skill) => skill.name === "rigorium-literature:literature-closeout"), true);
  assert.equal(runtime.getAllSkills().some((skill) => skill.name === "rigorium-zotero:zotero-library"), true);
});

test("builtin plugin enable settings can disable one contribution without hiding the other", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-plugin-toggle-"));
  const runtime = new PluginRuntime({
    projectRoot: root,
    pilotHome: join(root, ".pilot"),
    builtinPlugins: loadBuiltinPlugins(),
    builtinPluginsEnabled: { "rigorium-zotero": false },
  });
  await runtime.refresh();
  const names = runtime.snapshot().map((plugin) => plugin.name);
  assert.equal(names.includes("rigorium-literature"), true);
  assert.equal(names.includes("rigorium-zotero"), false);
});
