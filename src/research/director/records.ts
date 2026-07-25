import { hashResearchArtifactContent } from "../artifacts/index.js";
import type {
  ResearchDirectorDecisionRecord,
  ResearchDirectorPlanRecord,
} from "./types.js";

export function sealDirectorPlanRecord(
  value: Omit<ResearchDirectorPlanRecord, "auditHash">,
): ResearchDirectorPlanRecord {
  const frozen = deepFreeze(value);
  return deepFreeze({ ...frozen, auditHash: hashResearchArtifactContent(frozen) });
}

export function sealDirectorDecisionRecord(
  value: Omit<ResearchDirectorDecisionRecord, "auditHash">,
): ResearchDirectorDecisionRecord {
  const frozen = deepFreeze(value);
  return deepFreeze({ ...frozen, auditHash: hashResearchArtifactContent(frozen) });
}

export function directorRecordId(prefix: string, value: unknown): string {
  const hash = hashResearchArtifactContent(value).slice("sha256:".length, "sha256:".length + 24);
  return `${prefix}-${hash}`;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}
