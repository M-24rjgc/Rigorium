import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaimGraph } from "../claims/ClaimGraph.js";
import { defaultArtifactLoader } from "../director/ResearchOrchestrator.js";
import { computeOpenReviewFindings, type OpenReviewFinding } from "./openFindings.js";

/**
 * Research-audit replay: turns a project's persisted research state back
 * into an audit report — the orchestration decision trail (planHistory),
 * the claim/belief timeline, the artifact DAG summary, run reproducibility
 * coverage, and the finding-closure ledger. Pure offline reads; never
 * mutates project state.
 */

export type AuditPlanRecord = Readonly<{
  computedAt: string;
  shouldStop: boolean;
  stopReason?: string;
  topScore: number;
  actionCount: number;
  actionTypes: readonly string[];
}>;

export type AuditClaimRecord = Readonly<{
  claimId: string;
  status: string;
  confidence: number;
  uncertainty: number;
  supportsWeight: number;
  challengesWeight: number;
  evidenceCount: number;
}>;

export type AuditRunSummary = Readonly<{
  totalRuns: number;
  failedRuns: number;
  failureRate: number;
  /** Runs whose run-facts carry gitCommit + envFingerprint (reproducible). */
  withReproMetadata: number;
  /** Runs missing either gitCommit or envFingerprint. */
  missingReproMetadata: number;
}>;

export type AuditIssueSeverity = "warning" | "fatal";

export type AuditIssue = Readonly<{
  severity: AuditIssueSeverity;
  code: string;
  message: string;
}>;

export type ResearchAuditReport = Readonly<{
  projectRoot: string;
  generatedAt: string;
  claims: readonly AuditClaimRecord[];
  plans: readonly AuditPlanRecord[];
  /** Latest-revision artifact timeline, oldest first. */
  artifacts: readonly {
    artifactId: string;
    kind: string;
    status: string;
    createdAt: string;
    producerKind: string;
    parentCount: number;
  }[];
  artifactKindCounts: Readonly<Record<string, number>>;
  runs?: AuditRunSummary;
  openFindings: readonly OpenReviewFinding[];
  issues: readonly AuditIssue[];
}>;

export async function buildResearchAuditReport(input: {
  projectRoot: string;
  now?: () => Date;
}): Promise<ResearchAuditReport> {
  const { projectRoot } = input;
  const now = input.now ?? (() => new Date());
  const issues: AuditIssue[] = [];

  // 1. Claim beliefs (fresh recompute from the artifact DAG — the same
  //    computation the planner sees).
  const graph = new ClaimGraph({
    projectRoot,
    now,
    loadArtifacts: () => defaultArtifactLoader(projectRoot),
  });
  const beliefs = await graph.recomputeBeliefs({});
  const claims: AuditClaimRecord[] = beliefs.beliefs.map((belief) =>
    Object.freeze({
      claimId: belief.claimId,
      status: belief.status,
      confidence: belief.confidence,
      uncertainty: belief.uncertainty,
      supportsWeight: belief.supportsWeight,
      challengesWeight: belief.challengesWeight,
      evidenceCount: belief.evidenceCount,
    }),
  );
  if (claims.length === 0) {
    issues.push(Object.freeze({
      severity: "warning",
      code: "no_claims",
      message: "No claims registered yet — the belief-driven loop has not started.",
    }));
  }

  // 2. Orchestration decision trail (planHistory.jsonl, append-only).
  const plans: AuditPlanRecord[] = [];
  const planHistoryPath = join(projectRoot, ".rigorium", "research", "claims", "planHistory.jsonl");
  try {
    const content = await readFile(planHistoryPath, "utf8");
    for (const [index, line] of content.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as AuditPlanRecord;
        plans.push(Object.freeze(record));
      } catch {
        issues.push(Object.freeze({
          severity: "fatal",
          code: "plan_history_corrupt",
          message: `planHistory.jsonl line ${index + 1} is not valid JSON — the decision trail has a gap.`,
        }));
      }
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      issues.push(Object.freeze({
        severity: "fatal",
        code: "plan_history_unreadable",
        message: `planHistory.jsonl could not be read: ${error instanceof Error ? error.message : String(error)}`,
      }));
    }
  }
  if (plans.length > 0) {
    const stoppedPlans = plans.filter((plan) => plan.shouldStop);
    if (stoppedPlans.length === 0) {
      issues.push(Object.freeze({
        severity: "warning",
        code: "never_stopped",
        message: `The orchestrator ran ${plans.length} planning rounds without a stop decision.`,
      }));
    }
  }

  // 3. Artifact DAG (latest revisions) + run reproducibility.
  const { listLatestProjectResearchArtifacts } = await import("../artifacts/repository.js");
  const artifacts = await listLatestProjectResearchArtifacts({ projectRoot });
  const sorted = [...artifacts].sort((a, b) =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const artifactRows = sorted.map((artifact) =>
    Object.freeze({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      status: artifact.status,
      createdAt: artifact.createdAt,
      producerKind: artifact.producer.kind,
      parentCount: artifact.parents?.length ?? 0,
    }),
  );
  const artifactKindCounts: Record<string, number> = {};
  for (const artifact of sorted) {
    artifactKindCounts[artifact.kind] = (artifactKindCounts[artifact.kind] ?? 0) + 1;
  }

  const runs = sorted.filter((artifact) => artifact.kind === "run_attempt");
  let runSummary: AuditRunSummary | undefined;
  if (runs.length > 0) {
    const failedRuns = runs.filter(
      (artifact) => (artifact.payload as { status?: string } | undefined)?.status === "failed",
    ).length;
    let withReproMetadata = 0;
    for (const run of runs) {
      const payload = run.payload as { runFacts?: { gitCommit?: string; envFingerprint?: string } };
      if (payload.runFacts?.gitCommit && payload.runFacts.envFingerprint) {
        withReproMetadata += 1;
      }
    }
    runSummary = Object.freeze({
      totalRuns: runs.length,
      failedRuns,
      failureRate: failedRuns / runs.length,
      withReproMetadata,
      missingReproMetadata: runs.length - withReproMetadata,
    });
    if (runSummary.missingReproMetadata > 0) {
      issues.push(Object.freeze({
        severity: "warning",
        code: "run_reproducibility_gap",
        message: `${runSummary.missingReproMetadata}/${runSummary.totalRuns} runs lack gitCommit/envFingerprint reproducibility metadata.`,
      }));
    }
    if (runSummary.failureRate > 0.5) {
      issues.push(Object.freeze({
        severity: "warning",
        code: "high_run_failure_rate",
        message: `${Math.round(runSummary.failureRate * 100)}% of runs failed (${runSummary.failedRuns}/${runSummary.totalRuns}).`,
      }));
    }
  }

  // 4. Finding-closure ledger (same computation as the planner's summary).
  const openFindings = computeOpenReviewFindings(artifacts);
  for (const finding of openFindings) {
    issues.push(Object.freeze({
      severity: "warning",
      code: "open_finding",
      message: `Open ${finding.severity} finding ${finding.findingId}: ${finding.summary}`,
    }));
  }

  return Object.freeze({
    projectRoot,
    generatedAt: now().toISOString(),
    claims,
    plans,
    artifacts: artifactRows,
    artifactKindCounts: Object.freeze(artifactKindCounts),
    ...(runSummary ? { runs: runSummary } : {}),
    openFindings,
    issues,
  });
}

export function renderResearchAuditMarkdown(report: ResearchAuditReport): string {
  const lines: string[] = [
    "# Research Audit Report",
    "",
    `Project: \`${report.projectRoot}\``,
    `Generated: ${report.generatedAt}`,
    "",
    "## Claims (belief state)",
    "",
  ];
  if (report.claims.length === 0) {
    lines.push("_No claims registered._", "");
  } else {
    lines.push("| claim | status | confidence | uncertainty | supports | challenges | evidence |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const claim of report.claims) {
      lines.push(
        `| ${claim.claimId} | ${claim.status} | ${claim.confidence.toFixed(3)} | ` +
        `${claim.uncertainty.toFixed(3)} | ${claim.supportsWeight.toFixed(2)} | ` +
        `${claim.challengesWeight.toFixed(2)} | ${claim.evidenceCount} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Orchestration decision trail", "");
  if (report.plans.length === 0) {
    lines.push("_No planning rounds recorded yet._", "");
  } else {
    lines.push("| computedAt | stop | reason | topScore | actions |");
    lines.push("|---|---|---|---|---|");
    for (const plan of report.plans) {
      lines.push(
        `| ${plan.computedAt} | ${plan.shouldStop} | ${plan.stopReason ?? "-"} | ` +
        `${plan.topScore.toFixed(4)} | ${plan.actionTypes.join(", ")} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Artifacts", "");
  if (report.artifacts.length === 0) {
    lines.push("_No artifacts yet._", "");
  } else {
    lines.push(`Total: ${report.artifacts.length} (latest revisions)`);
    lines.push("");
    const kinds = Object.entries(report.artifactKindCounts)
      .map(([kind, count]) => `${kind}: ${count}`)
      .join("; ");
    lines.push(`By kind: ${kinds}`, "");
    lines.push("| artifact | kind | status | created | producer | parents |");
    lines.push("|---|---|---|---|---|---|");
    for (const artifact of report.artifacts) {
      lines.push(
        `| ${artifact.artifactId} | ${artifact.kind} | ${artifact.status} | ` +
        `${artifact.createdAt} | ${artifact.producerKind} | ${artifact.parentCount} |`,
      );
    }
    lines.push("");
  }

  if (report.runs) {
    const { runs } = report;
    lines.push(
      "## Run reproducibility",
      "",
      `Runs: ${runs.totalRuns} (failed ${runs.failedRuns}, ` +
      `${Math.round(runs.failureRate * 100)}%)`,
      `With gitCommit+envFingerprint: ${runs.withReproMetadata}/${runs.totalRuns}`,
      "",
    );
  }

  lines.push("## Open review findings (closure ledger)", "");
  if (report.openFindings.length === 0) {
    lines.push("_All blocker/major findings are referenced by later work._", "");
  } else {
    for (const finding of report.openFindings) {
      lines.push(`- **[${finding.severity}]** \`${finding.findingId}\` — ${finding.summary}`);
    }
    lines.push("");
  }

  lines.push("## Audit issues", "");
  if (report.issues.length === 0) {
    lines.push("_No integrity issues detected._");
  } else {
    for (const issue of report.issues) {
      lines.push(`- [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Integrity gate for CI: true when the report has no fatal issues. */
export function verifyResearchAudit(report: ResearchAuditReport): boolean {
  return !report.issues.some((issue) => issue.severity === "fatal");
}
