import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { migrateLegacyBundledSkillCopies } from "../../../src/extension/skills/index.js";

async function writeSkill(root: string, slug: string, body: string): Promise<void> {
  const dir = join(root, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${slug}\ndescription: test\n---\n\n${body}\n`,
    "utf8",
  );
  await mkdir(join(dir, "references"), { recursive: true });
  await writeFile(join(dir, "references", "notes.md"), `${body}\n`, "utf8");
}

test("legacy bundled migration backs up only byte-identical bootstrap copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-legacy-bundled-"));
  try {
    const rigoriumHome = join(root, "rigorium-home");
    const builtinSkillsRoot = join(root, "bundled-skills");
    const backupRoot = join(root, "backups");

    await writeSkill(builtinSkillsRoot, "unchanged", "bundled body");
    await writeSkill(join(rigoriumHome, "skills"), "unchanged", "bundled body");
    await writeSkill(builtinSkillsRoot, "customized", "new bundled body");
    await writeSkill(join(rigoriumHome, "skills"), "customized", "user edited body");
    await writeSkill(join(rigoriumHome, "skills"), "user-only", "user-owned body");

    const report = migrateLegacyBundledSkillCopies({ rigoriumHome, builtinSkillsRoot, backupRoot });

    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.migrated.map((item) => item.slug), ["unchanged"]);
    await assert.rejects(access(join(rigoriumHome, "skills", "unchanged")));
    assert.match(await readFile(join(backupRoot, "unchanged", "SKILL.md"), "utf8"), /bundled body/);
    assert.match(
      await readFile(join(rigoriumHome, "skills", "customized", "SKILL.md"), "utf8"),
      /user edited body/,
    );
    assert.match(
      await readFile(join(rigoriumHome, "skills", "user-only", "SKILL.md"), "utf8"),
      /user-owned body/,
    );

    const secondRun = migrateLegacyBundledSkillCopies({ rigoriumHome, builtinSkillsRoot, backupRoot });
    assert.deepEqual(secondRun, { migrated: [], failures: [] });

    // An explicitly created override after migration must never be mistaken
    // for another bootstrap copy, even while it is still byte-identical.
    await writeSkill(join(rigoriumHome, "skills"), "unchanged", "bundled body");
    const afterUserOverride = migrateLegacyBundledSkillCopies({
      rigoriumHome,
      builtinSkillsRoot,
      backupRoot,
    });
    assert.deepEqual(afterUserOverride, { migrated: [], failures: [] });
    await access(join(rigoriumHome, "skills", "unchanged", "SKILL.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy bundled migration leaves user skills untouched when the release bundle is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-legacy-missing-bundle-"));
  try {
    const rigoriumHome = join(root, "rigorium-home");
    await writeSkill(join(rigoriumHome, "skills"), "user-skill", "keep me");

    const report = migrateLegacyBundledSkillCopies({
      rigoriumHome,
      builtinSkillsRoot: join(root, "missing-bundled-skills"),
    });

    assert.equal(report.migrated.length, 0);
    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0]?.message ?? "", /left untouched/);
    await access(join(rigoriumHome, "skills", "user-skill", "SKILL.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
