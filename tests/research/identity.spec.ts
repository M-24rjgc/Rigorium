import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeArxivIdentifier,
  normalizeArxivVersion,
  normalizeDoi,
} from "../../src/research/identity.js";

test("shared paper identity normalizers reject unsafe DOI whitespace and preserve numeric arXiv versions", () => {
  assert.equal(normalizeDoi("HTTPS://DOI.ORG/10.1000/ABC."), "10.1000/abc");
  assert.equal(normalizeDoi("doi: 10.1000/foo bar"), undefined);
  assert.equal(normalizeDoi("10.1000/foo\nbar"), undefined);
  assert.deepEqual(normalizeArxivIdentifier("https://arxiv.org/abs/hep-th/9901001v12"), {
    id: "hep-th/9901001",
    version: 12,
  });
  assert.deepEqual(normalizeArxivIdentifier("arXiv:2401.12345v2"), {
    id: "2401.12345",
    version: 2,
  });
  assert.equal(normalizeArxivVersion("v3"), 3);
  assert.equal(normalizeArxivVersion("v0"), undefined);
});
