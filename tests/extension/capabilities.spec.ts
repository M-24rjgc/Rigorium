import assert from "node:assert/strict";
import test from "node:test";

import { CapabilityRegistry } from "../../src/extension/capabilities/CapabilityRegistry.js";
import { parsePluginCapabilities } from "../../src/extension/capabilities/parseCapabilities.js";

test("parsePluginCapabilities: legacy string declarations become id-only contracts", () => {
  const capabilities = parsePluginCapabilities(
    {
      capabilities: [
        "manuscript.render.deterministic_diagnostics",
        "literature.identity.normalize",
      ],
    },
    "rigorium-manuscript",
  );
  assert.equal(capabilities.length, 2);
  assert.deepEqual(capabilities[0], {
    id: "manuscript.render.deterministic_diagnostics",
    plugin: "rigorium-manuscript",
  });
  assert.equal(capabilities[1].id, "literature.identity.normalize");
});

test("parsePluginCapabilities: contract objects keep their fields", () => {
  const capabilities = parsePluginCapabilities(
    {
      capabilities: [
        {
          id: "figures.render",
          name: "Figure rendering",
          accepts: ["figure_table", "style_profile"],
          produces: ["render_run"],
          dependsOnCapabilityIds: ["manuscript.template.iclr2026_pin"],
          modalityRequirements: ["text", "image"],
          estimatedCostUnits: 12,
          estimatedDurationMs: 90_000,
        },
      ],
    },
    "rigorium-figures",
  );
  assert.equal(capabilities.length, 1);
  const contract = capabilities[0]!;
  assert.equal(contract.id, "figures.render");
  assert.deepEqual(contract.accepts, ["figure_table", "style_profile"]);
  assert.deepEqual(contract.produces, ["render_run"]);
  assert.deepEqual(contract.modalityRequirements, ["text", "image"]);
  assert.equal(contract.estimatedCostUnits, 12);
  assert.equal(contract.plugin, "rigorium-figures");
});

test("parsePluginCapabilities: drops invalid entries and dedupes ids", () => {
  const capabilities = parsePluginCapabilities(
    {
      capabilities: [
        "valid.one",
        "",
        42,
        { id: "valid.two", accepts: "not-an-array" },
        { noId: true },
        "valid.one",
        { id: "  ", name: "blank id" },
      ],
    },
    "test-plugin",
  );
  assert.deepEqual(
    capabilities.map((capability) => capability.id),
    ["valid.one", "valid.two"],
  );
  // Invalid `accepts` (string instead of array) is dropped, not fatal.
  assert.equal(capabilities[1]!.accepts, undefined);
});

test("parsePluginCapabilities: missing or malformed settings yields empty", () => {
  assert.deepEqual(parsePluginCapabilities(undefined, "p"), []);
  assert.deepEqual(parsePluginCapabilities({}, "p"), []);
  assert.deepEqual(parsePluginCapabilities({ capabilities: "string" }, "p"), []);
  assert.deepEqual(parsePluginCapabilities(null, "p"), []);
});

test("CapabilityRegistry: register, query, producers/acceptors, dependency validation", () => {
  const registry = new CapabilityRegistry();
  registry.replaceAll([
    { id: "lit.search", plugin: "rigorium-literature", produces: ["evidence_pack"] },
    {
      id: "ms.render",
      plugin: "rigorium-manuscript",
      accepts: ["manuscript_version"],
      produces: ["render_run"],
      dependsOnCapabilityIds: ["lit.search"],
    },
    {
      id: "fig.draft",
      plugin: "rigorium-figures",
      produces: ["figure_table"],
      dependsOnCapabilityIds: ["missing.capability"],
    },
  ]);

  assert.equal(registry.size(), 3);
  assert.equal(registry.has("lit.search"), true);
  assert.equal(registry.get("ms.render")?.plugin, "rigorium-manuscript");
  assert.deepEqual(
    registry.findProducers("render_run").map((capability) => capability.id),
    ["ms.render"],
  );
  assert.deepEqual(
    registry.findAcceptors("manuscript_version").map((capability) => capability.id),
    ["ms.render"],
  );
  assert.deepEqual(
    registry.forPlugin("rigorium-literature").map((capability) => capability.id),
    ["lit.search"],
  );

  const issues = registry.validateDependencies();
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.capabilityId, "fig.draft");
  assert.equal(issues[0]!.code, "dangling_dependency");
  assert.match(issues[0]!.message, /missing\.capability/);
});

test("CapabilityRegistry: replaceAll is a full swap", () => {
  const registry = new CapabilityRegistry();
  registry.replaceAll([
    { id: "a.one", plugin: "p1" },
    { id: "b.two", plugin: "p2" },
  ]);
  registry.replaceAll([{ id: "c.three", plugin: "p3" }]);
  assert.equal(registry.size(), 1);
  assert.equal(registry.get("c.three")?.plugin, "p3");
  assert.equal(registry.has("a.one"), false);
});
