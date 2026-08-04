import assert from "node:assert/strict";
import test from "node:test";
import { wildcardToRegExp } from "../../src/permission/policy/matchPermissionRule.js";

function matches(pattern: string, value: string): boolean {
  return wildcardToRegExp(pattern).test(value.replace(/\\/g, "/"));
}

test("glob: literal patterns match exactly", () => {
  assert.equal(matches("src/a.ts", "src/a.ts"), true);
  assert.equal(matches("src/a.ts", "src/b.ts"), false);
});

test("glob: `*` matches within one path segment only", () => {
  assert.equal(matches("src/*.ts", "src/a.ts"), true);
  assert.equal(matches("src/*.ts", "src/sub/a.ts"), false, "`*` must not cross `/`");
  assert.equal(matches("src/*", "src/a.ts"), true);
  assert.equal(matches("src/*", "src/sub/a.ts"), false);
});

test("glob: `**` crosses path segments (Claude Code Write(src/**) semantics)", () => {
  assert.equal(matches("src/**", "src/a.ts"), true);
  assert.equal(matches("src/**", "src/a/b/file.ts"), true);
  assert.equal(matches("src/**", "src/"), true, "`**` matches zero segments");
  assert.equal(matches("src/**", "other/a.ts"), false);
  assert.equal(matches("**/package.json", "package.json"), true);
  assert.equal(matches("**/package.json", "a/b/package.json"), true);
  assert.equal(matches("**/package.json", "a/package-lock.json"), false);
});

test("glob: `?` matches exactly one character within a segment", () => {
  assert.equal(matches("a?c.ts", "abc.ts"), true);
  assert.equal(matches("a?c.ts", "ac.ts"), false);
  assert.equal(matches("a?c.ts", "a/c.ts"), false, "`?` must not cross `/`");
});

test("glob: special characters are escaped literally", () => {
  assert.equal(matches("a+b.ts", "a+b.ts"), true);
  assert.equal(matches("a+b.ts", "aXb.ts"), false);
  assert.equal(matches("v1.0", "v1.0"), true);
  assert.equal(matches("v1.0", "v1X0"), false);
});
