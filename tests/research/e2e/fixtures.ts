import { createHash } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import type {
  ResearchArtifactEnvelope,
  ResearchArtifactRef,
} from "../../../src/research/artifacts/index.js";
import {
  REVIEWER_LANES,
  type ReviewerLaneReport,
} from "../../../src/research/review/index.js";

const TEST_ROOT_PREFIX = "rigorium-e2e-";
const TIMELINE_START = Date.UTC(2026, 6, 25, 0, 0, 0);

export async function createE2eTemporaryRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${TEST_ROOT_PREFIX}${label}-`));
}

export function timelineDate(minute: number): Date {
  return new Date(TIMELINE_START + minute * 60_000);
}

export function sha256Text(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function latestArtifactRevisions<T extends ResearchArtifactEnvelope>(artifacts: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const artifact of artifacts) {
    const previous = latest.get(artifact.artifactId);
    if (!previous || artifact.revision > previous.revision) latest.set(artifact.artifactId, artifact);
  }
  return [...latest.values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId, "en"));
}

export function artifactStatus(
  artifacts: readonly ResearchArtifactEnvelope[],
  ref: ResearchArtifactRef,
): ResearchArtifactEnvelope["status"] | undefined {
  return artifacts.find((artifact) => artifact.artifactId === ref.artifactId
    && artifact.revision === ref.revision && artifact.kind === ref.kind && artifact.contentHash === ref.contentHash)?.status;
}

export function cleanLaneReports(): ReviewerLaneReport[] {
  return REVIEWER_LANES.map((lane, index) => Object.freeze({
    lane,
    reviewerId: `e2e-reviewer-${index + 1}-${lane}`,
    independent: true as const,
    findings: Object.freeze([]),
  }));
}

export async function removeValidatedE2eTemporaryRoot(root: string): Promise<void> {
  const temporaryRoot = await realpath(tmpdir());
  const resolvedRoot = await realpath(root);
  const relation = relative(temporaryRoot, resolvedRoot);
  const stats = await lstat(resolvedRoot);
  const isTestRoot = relation !== "" && !relation.startsWith("..") && !isAbsolute(relation)
    && basename(resolvedRoot).startsWith(TEST_ROOT_PREFIX) && stats.isDirectory() && !stats.isSymbolicLink();
  if (!isTestRoot) throw new Error(`Refusing to remove an unvalidated E2E test root: ${resolvedRoot}`);
  await rm(resolvedRoot, { recursive: true, force: false });
}
