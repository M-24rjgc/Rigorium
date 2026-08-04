import type { ResearchArtifactEnvelope } from "../artifacts/types.js";

/**
 * Blocker/major review findings that no later non-review artifact has
 * referenced (via a parent edge) — i.e. the correction loop has not visibly
 * acted on them yet. Review rounds reference their own findings, which does
 * not count as closure.
 *
 * Shared by the orchestrator (plan/summary context) and the research-audit
 * replay tool (closure ledger), so both always agree on what is open.
 */
export type OpenReviewFinding = Readonly<{
  findingId: string;
  severity: string;
  summary: string;
}>;

export function computeOpenReviewFindings(
  artifacts: readonly ResearchArtifactEnvelope[],
): readonly OpenReviewFinding[] {
  const findings = artifacts.filter((artifact) => artifact.kind === "finding");
  if (findings.length === 0) {
    return [];
  }
  const referencedFindingIds = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.kind === "finding" || artifact.kind === "review_round") {
      continue;
    }
    for (const parent of artifact.parents ?? []) {
      if (parent.artifact.kind === "finding") {
        referencedFindingIds.add(parent.artifact.artifactId);
      }
    }
  }
  return Object.freeze(
    findings
      .filter((finding) => {
        const severity = (finding.payload as { severity?: string } | undefined)?.severity;
        return (severity === "blocker" || severity === "major") && !referencedFindingIds.has(finding.artifactId);
      })
      .map((finding) => {
        const payload = finding.payload as { severity?: string; summary?: string };
        return Object.freeze({
          findingId: finding.artifactId,
          severity: payload.severity ?? "major",
          summary: (payload.summary ?? "").slice(0, 200),
        });
      }),
  );
}
