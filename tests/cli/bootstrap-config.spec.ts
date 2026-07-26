import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("config bootstrap does not copy bundled skills into user storage", () => {
  const rigoriumHome = mkdtempSync(join(tmpdir(), "rigorium-bootstrap-"));
  try {
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "bootstrap-rigorium-config.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env, RIGORIUM_HOME: rigoriumHome },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(rigoriumHome, "rigorium.yaml")), true);
    assert.equal(existsSync(join(rigoriumHome, "skills")), false);
  } finally {
    rmSync(rigoriumHome, { recursive: true, force: true });
  }
});
