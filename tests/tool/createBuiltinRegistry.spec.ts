import assert from "node:assert/strict";
import test from "node:test";
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";

const unrelatedToolsDisabled = {
  webSearch: false,
  webFetch: false,
  agent: false,
  structuredOutput: false,
  askUserQuestion: false,
  planMode: false,
} as const;

test("builtin registry registers literature deep search by default and permits explicit disablement", () => {
  const defaultRegistry = createBuiltinRegistry(unrelatedToolsDisabled);
  assert.equal(defaultRegistry.has("literature_expand"), true);
  assert.equal(defaultRegistry.has("literature_deep_search"), true);
  assert.equal(defaultRegistry.has("literature_map_maintenance"), true);
  assert.equal(defaultRegistry.has("direction_assess"), true);
  assert.equal(defaultRegistry.has("research_direction_seed"), true);
  assert.equal(defaultRegistry.has("research_direction_lifecycle"), true);
  assert.equal(defaultRegistry.has("research_title_confirm"), true);
  assert.equal(defaultRegistry.has("deepseek_native_search"), true);

  const disabledRegistry = createBuiltinRegistry({
    ...unrelatedToolsDisabled,
    literatureExpansion: false,
    literatureDeepSearch: false,
    literatureMapMaintenance: false,
    directionAssessment: false,
    researchDirectionSeed: false,
    researchDirectionLifecycle: false,
    researchTitleConfirmation: false,
    deepseekNativeSearch: false,
  });
  assert.equal(disabledRegistry.has("literature_expand"), false);
  assert.equal(disabledRegistry.has("literature_deep_search"), false);
  assert.equal(disabledRegistry.has("literature_map_maintenance"), false);
  assert.equal(disabledRegistry.has("direction_assess"), false);
  assert.equal(disabledRegistry.has("research_direction_seed"), false);
  assert.equal(disabledRegistry.has("research_direction_lifecycle"), false);
  assert.equal(disabledRegistry.has("research_title_confirm"), false);
  assert.equal(disabledRegistry.has("deepseek_native_search"), false);
  assert.equal(disabledRegistry.has("literature_search"), true);
});
