import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  buildResearchAuditReport,
  renderResearchAuditMarkdown,
  verifyResearchAudit,
} from "../../research/audit/replay.js";

/**
 * `rigorium research-audit [projectRoot] [--out <path>] [--verify]`
 *
 * Replays a project's persisted research state (beliefs, decision trail,
 * artifact DAG, run reproducibility, finding closure) into an audit report.
 * `--verify` exits non-zero when the replay surfaces fatal integrity issues
 * (e.g. a corrupt decision trail) — the CI gate for research reproducibility.
 */
export async function runResearchAuditCli(argv: string[]): Promise<void> {
  const positional: string[] = [];
  let outPath: string | undefined;
  let verifyOnly = false;

  for (const arg of argv) {
    if (arg === "--verify") {
      verifyOnly = true;
    } else if (arg === "--out") {
      outPath = argv[argv.indexOf(arg) + 1];
      if (!outPath) {
        console.error("rigorium research-audit: --out requires a file path.");
        process.exitCode = 1;
        return;
      }
    } else if (arg.startsWith("-")) {
      console.error(`rigorium research-audit: unknown option ${arg}`);
      process.exitCode = 1;
      return;
    } else {
      positional.push(arg);
    }
  }

  const projectRoot = resolve(positional[0] ?? process.cwd());
  let report;
  try {
    report = await buildResearchAuditReport({ projectRoot });
  } catch (error) {
    console.error(`rigorium research-audit: failed for ${projectRoot}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (outPath) {
    await writeFile(outPath, renderResearchAuditMarkdown(report), { encoding: "utf8" });
    console.log(`[research-audit] report written to ${outPath}`);
  } else if (!verifyOnly) {
    console.log(renderResearchAuditMarkdown(report));
  }

  const verified = verifyResearchAudit(report);
  if (!verified) {
    console.error("[research-audit] verification FAILED: fatal integrity issues found.");
    process.exitCode = 1;
  } else if (verifyOnly) {
    console.log(`[research-audit] verification passed (${report.issues.length} warning(s), no fatal issues).`);
  }
}
