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

test("builtin registry registers literature_expand by default and permits explicit disablement", () => {
  const defaultRegistry = createBuiltinRegistry(unrelatedToolsDisabled);
  assert.equal(defaultRegistry.has("literature_expand"), true);

  const disabledRegistry = createBuiltinRegistry({
    ...unrelatedToolsDisabled,
    literatureExpansion: false,
  });
  assert.equal(disabledRegistry.has("literature_expand"), false);
  assert.equal(disabledRegistry.has("literature_search"), true);
});
