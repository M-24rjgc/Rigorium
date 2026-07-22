import type {
  DirectionEvidence,
  ProvisionalDirectionTitle,
} from "./directionAssessment.js";

export const TITLE_CONFIRMATION_LIMITS = {
  maxTitleLength: 180,
  maxEvidence: 48,
  maxEvidenceStatementLength: 1_000,
} as const;

export type TitleConfirmationInput = Readonly<{
  directionId: string;
  candidateTitle: string;
  evidence: readonly DirectionEvidence[];
  /** A neutral fallback may be used when the candidate overclaims. */
  neutralTitle?: string;
  /** This flag is the user's explicit title-confirmation action. */
  confirmed?: boolean;
}>;

export type TitleConfirmationResult = Readonly<{
  directionId: string;
  title: ProvisionalDirectionTitle;
  confirmation: Readonly<{
    status: "pending" | "confirmed";
    confirmed: boolean;
    /** This is an intent for the caller; this function never renames a Project. */
    projectNameUpdate: Readonly<{
      status: "not_ready" | "ready_for_explicit_project_action";
      name?: string;
      requiresExplicitUserAction: true;
    }>;
  }>;
}>;

const OVERCOMMITTING_TITLE = /\b(?:always|never|proves?|guarantees?|guaranteed|optimal|state[- ]of[- ]the[- ]art|sota|breakthrough|solves?|causal)\b/iu;
const SENSITIVE_TITLE_MARKER = /(?:api[_-]?key|access[_-]?token|bearer\s+|password\s*=|secret\s*=)/iu;

/**
 * Produces a traceable title proposal and an explicit, side-effect-free
 * confirmation intent. It does not update a Project, settings file, or
 * persisted research artifact.
 */
export function confirmProvisionalTitle(input: TitleConfirmationInput): TitleConfirmationResult {
  const directionId = requireText(input.directionId, "directionId", 180);
  const candidateTitle = requireText(input.candidateTitle, "candidateTitle", TITLE_CONFIRMATION_LIMITS.maxTitleLength);
  const evidence = normalizeEvidence(input.evidence);
  const trace = traceFor(evidence);
  const overcommitting = OVERCOMMITTING_TITLE.test(candidateTitle);

  let title: ProvisionalDirectionTitle;
  if (evidence.length === 0 || SENSITIVE_TITLE_MARKER.test(candidateTitle)) {
    title = {
      ...trace,
      status: "rejected",
      reasonCodes: ["provisional"],
    };
  } else if (overcommitting) {
    const neutralTitle = input.neutralTitle === undefined
      ? undefined
      : requireText(input.neutralTitle, "neutralTitle", TITLE_CONFIRMATION_LIMITS.maxTitleLength);
    if (!neutralTitle || OVERCOMMITTING_TITLE.test(neutralTitle) || SENSITIVE_TITLE_MARKER.test(neutralTitle)) {
      title = {
        ...trace,
        status: "rejected",
        reasonCodes: ["provisional", "overcommitting_claim"],
      };
    } else {
      title = {
        ...trace,
        status: "downgraded",
        text: neutralTitle,
        reasonCodes: ["provisional", "overcommitting_claim"],
      };
    }
  } else {
    title = {
      ...trace,
      status: "accepted",
      text: candidateTitle,
      reasonCodes: ["provisional"],
    };
  }

  const confirmed = input.confirmed === true && title.text !== undefined;
  return {
    directionId,
    title,
    confirmation: {
      status: confirmed ? "confirmed" : "pending",
      confirmed,
      projectNameUpdate: confirmed
        ? {
            status: "ready_for_explicit_project_action",
            name: title.text,
            requiresExplicitUserAction: true,
          }
        : {
            status: "not_ready",
            requiresExplicitUserAction: true,
          },
    },
  };
}

function normalizeEvidence(value: readonly DirectionEvidence[] | undefined): DirectionEvidence[] {
  if (!Array.isArray(value) || value.length > TITLE_CONFIRMATION_LIMITS.maxEvidence) return [];
  const seen = new Set<string>();
  const result: DirectionEvidence[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return [];
    const id = requireText(item.id, "evidence.id", 180);
    const paperId = requireText(item.paperId, "evidence.paperId", 180);
    const statement = requireText(item.statement, "evidence.statement", TITLE_CONFIRMATION_LIMITS.maxEvidenceStatementLength);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ ...item, id, paperId, statement });
  }
  return result;
}

function traceFor(evidence: readonly DirectionEvidence[]): Pick<ProvisionalDirectionTitle, "evidenceIds" | "paperIds" | "constraintIds"> {
  return {
    evidenceIds: evidence.map((item) => item.id),
    paperIds: [...new Set(evidence.map((item) => item.paperId))],
    constraintIds: [],
  };
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(normalized)) {
    throw new TypeError(`${field} must be a bounded, printable string.`);
  }
  return normalized;
}
