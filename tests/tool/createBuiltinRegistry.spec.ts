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
  assert.equal(defaultRegistry.has("literature_closeout"), true);
  assert.equal(defaultRegistry.has("research_design"), true);
  assert.equal(defaultRegistry.has("research_brief"), true);
  assert.equal(defaultRegistry.has("research_method"), true);
  assert.equal(defaultRegistry.has("experiment_control"), true);
  assert.equal(defaultRegistry.has("experiment_analysis"), true);
  assert.equal(defaultRegistry.has("experiment_remote"), true);
  assert.equal(defaultRegistry.has("manuscript_latex"), true);
  assert.equal(defaultRegistry.has("research_review"), true);
  assert.equal(defaultRegistry.has("research_artifacts"), true);
  assert.equal(defaultRegistry.has("research_director"), true);
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
    literatureCloseout: false,
    researchDesign: false,
    researchBrief: false,
    researchMethod: false,
    experimentControl: false,
    experimentAnalysis: false,
    experimentRemote: false,
    manuscript: false,
    researchReview: false,
    researchArtifacts: false,
    researchDirector: false,
    directionAssessment: false,
    researchDirectionSeed: false,
    researchDirectionLifecycle: false,
    researchTitleConfirmation: false,
    deepseekNativeSearch: false,
  });
  assert.equal(disabledRegistry.has("literature_expand"), false);
  assert.equal(disabledRegistry.has("literature_deep_search"), false);
  assert.equal(disabledRegistry.has("literature_map_maintenance"), false);
  assert.equal(disabledRegistry.has("literature_closeout"), false);
  assert.equal(disabledRegistry.has("research_design"), false);
  assert.equal(disabledRegistry.has("research_brief"), false);
  assert.equal(disabledRegistry.has("research_method"), false);
  assert.equal(disabledRegistry.has("experiment_control"), false);
  assert.equal(disabledRegistry.has("experiment_analysis"), false);
  assert.equal(disabledRegistry.has("experiment_remote"), false);
  assert.equal(disabledRegistry.has("manuscript_latex"), false);
  assert.equal(disabledRegistry.has("research_review"), false);
  assert.equal(disabledRegistry.has("research_artifacts"), false);
  assert.equal(disabledRegistry.has("research_director"), false);
  assert.equal(disabledRegistry.has("direction_assess"), false);
  assert.equal(disabledRegistry.has("research_direction_seed"), false);
  assert.equal(disabledRegistry.has("research_direction_lifecycle"), false);
  assert.equal(disabledRegistry.has("research_title_confirm"), false);
  assert.equal(disabledRegistry.has("deepseek_native_search"), false);
  assert.equal(disabledRegistry.has("literature_search"), true);
});
