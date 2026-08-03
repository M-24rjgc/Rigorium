#!/usr/bin/env node
/**
 * Import open-source research skills into the project's user skill library.
 *
 * The platform's skill compliance validator (`SkillManager.validate`) gates
 * every import: skills that fail hard checks (missing SKILL.md, unsafe
 * paths, too many files, missing frontmatter) are rejected; skills that pass
 * are copied into `~/.rigorium/skills/` under a `sourced-` prefix.
 *
 * Usage:
 *   node scripts/import-open-science-skills.mjs <sourceDir> [--dry-run] [--prefix sourced-]
 *
 * `<sourceDir>` is any directory of SKILL.md directories (e.g. a clone of
 * synthetic-sciences/openscience or scdenney/open-science-skills). Run with
 * --dry-run first to see what would be imported.
 *
 * This script is the *mechanism*; which skills to import is a human/agent
 * decision made by reviewing the dry-run report against the project's needs.
 */
import { mkdir, readdir, readFile, copyFile, stat, lstat, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

// Hard-fail constants mirrored from src/extension/skills/SkillManager.ts.
const MAX_FILE_COUNT = 500; // recursive, like the platform's walkDir
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const args = process.argv.slice(2);
const sourceDirArg = args.find((arg) => !arg.startsWith("--"));
const dryRun = args.includes("--dry-run");
const prefix = args.find((arg) => arg.startsWith("--prefix="))?.split("=")[1] ?? "sourced-";

if (!sourceDirArg) {
  console.error("Usage: node scripts/import-open-science-skills.mjs <sourceDir> [--dry-run] [--prefix=name-]");
  process.exit(1);
}

const sourceDir = resolve(sourceDirArg);
const targetDir = join(homedir(), ".rigorium", "skills");

/** Mirrors the platform's hard-fail rules (SkillManager compliance validator). */
async function validateSkillDir(dir, name) {
  const hardFails = [];
  const warnings = [];
  let skillMd = null;
  let fileCount = 0;
  let totalBytes = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      fileCount += 1;
      if (entry.name.toLowerCase() === "skill.md") {
        skillMd = entry;
      }
    }
  } catch {
    return { name, ok: false, reasons: ["unreadable directory"] };
  }
  if (!skillMd) hardFails.push("no_skill_md");
  if (fileCount > MAX_FILE_COUNT) hardFails.push("too_many_files");
  if (hardFails.length === 0) {
    try {
      const content = await readFile(join(dir, skillMd.name), "utf8");
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
      if (!frontmatter) hardFails.push("frontmatter_missing");
      else if (!/name\s*:/u.test(frontmatter[1]) || !/description\s*:/u.test(frontmatter[1])) {
        hardFails.push("frontmatter_missing_name_or_description");
      }
    } catch {
      hardFails.push("unreadable_skill_md");
    }
  }
  // Recursive walk with the platform's limits: total bytes, per-file bytes,
  // symlinks. Counting only the top level lets deeply nested bundles slip
  // past the script only to be rejected by the platform itself.
  if (hardFails.length === 0) {
    const stats = await walkSkillDir(dir, hardFails, warnings);
    totalBytes = stats.totalBytes;
  }
  if (totalBytes > MAX_TOTAL_BYTES) hardFails.push("total_too_large");
  return { name, ok: hardFails.length === 0, reasons: hardFails, warnings };
}

async function walkSkillDir(dir, hardFails, warnings) {
  const stats = { fileCount: 0, totalBytes: 0 };
  const stack = [dir];
  while (stack.length > 0 && stats.fileCount <= MAX_FILE_COUNT) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (stats.fileCount > MAX_FILE_COUNT) break;
      const abs = join(current, entry.name);
      let info;
      try {
        info = await lstat(abs);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) {
        warnings.push(`contains_symlink: ${entry.name}`);
        continue;
      }
      if (info.isDirectory()) {
        stack.push(abs);
        continue;
      }
      stats.fileCount += 1;
      stats.totalBytes += info.size;
      if (info.size > MAX_FILE_BYTES) {
        hardFails.push(`file_too_large: ${entry.name}`);
      }
    }
  }
  return stats;
}

/** Recursively copy a skill directory (files and subdirectories, no symlinks). */
async function copySkillTree(source, target) {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    let info;
    try {
      info = await lstat(from);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copySkillTree(from, to);
      continue;
    }
    await copyFile(from, to);
  }
}

async function main() {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    console.error(`Cannot read source directory ${sourceDir}: ${error.message}`);
    process.exit(1);
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const fullPath = join(sourceDir, entry.name);
    const statResult = await stat(fullPath);
    if (!statResult.isDirectory()) continue;
    // Skip plugin-style directories that only wrap skills.
    try {
      const nested = await readdir(fullPath);
      if (nested.includes("plugin.json") || nested.includes("manifest.json")) continue;
    } catch {
      continue;
    }
    candidates.push({ dir: fullPath, name: entry.name });
  }

  const results = [];
  for (const candidate of candidates) {
    const validation = await validateSkillDir(candidate.dir, candidate.name);
    results.push({ ...validation, dir: candidate.dir });
  }

  const passing = results.filter((result) => result.ok);
  const failing = results.filter((result) => !result.ok);

  console.log(`Scanned ${results.length} skill directories in ${sourceDir}`);
  console.log(`- pass: ${passing.length}`);
  console.log(`- fail: ${failing.length}`);
  if (failing.length > 0) {
    console.log("\nRejected skills:");
    for (const result of failing) {
      console.log(`  - ${result.name}: ${result.reasons.join(", ")}`);
    }
  }

  if (dryRun) {
    console.log("\n[dry-run] would import:");
    for (const result of passing) {
      console.log(`  + ${prefix}${result.name}`);
    }
    console.log("\nReview the list, then re-run without --dry-run to import.");
    return;
  }

  await mkdir(targetDir, { recursive: true });
  let imported = 0;
  let skipped = 0;
  for (const result of passing) {
    const target = join(targetDir, `${prefix}${result.name}`);
    try {
      const existing = await stat(target);
      if (existing.isDirectory()) {
        console.log(`  ~ ${result.name}: already imported (skip)`);
        skipped += 1;
        continue;
      }
    } catch {
      // does not exist — proceed
    }
    await mkdir(target, { recursive: true });
    try {
      await copySkillTree(result.dir, target);
    } catch (error) {
      // A partial import leaves a broken skill behind; remove the target so a
      // re-run can retry instead of skipping it as "already imported".
      console.error(`  ! ${result.name}: copy failed (${error.message}); removing partial target`);
      try {
        await rm(target, { recursive: true, force: true });
      } catch {
        // ignore cleanup failure
      }
      continue;
    }
    console.log(`  + imported ${prefix}${result.name}`);
    imported += 1;
  }
  console.log(`\nDone: ${imported} imported, ${skipped} skipped, ${failing.length} rejected.`);
  console.log(`Target: ${targetDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
