import { ClaimGraph } from "../../research/claims/ClaimGraph.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult, RigoriumToolInputSchema } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";

/**
 * claim_monitor — turn the claim graph into a literature-watching surface,
 * and give the agent the production entry into the belief-revision loop.
 *
 * For every active claim, the tool derives a search query from the claim
 * statement and reports the current evidence count. The agent (or a cron job
 * whose message calls this tool + literature_search) then checks whether new
 * publications support or challenge each claim.
 *
 * action=claim_create / action=claim_supersede are the production write
 * paths into the claim graph (the belief-revision loop): research starts by
 * registering claims, and a falsified claim is superseded by its successor —
 * the revision trail is what downstream replanning reads.
 */

export type ClaimMonitorToolInput =
  | Readonly<{ action: "check"; limit?: number }>
  | Readonly<{
      action: "claim_create";
      claimId: string;
      statement: string;
      falsificationCondition?: string;
      parentClaimIds?: string[];
      sourceArtifactId?: string;
    }>
  | Readonly<{
      action: "claim_supersede";
      claimId: string;
      supersededByClaimId: string;
      reason?: string;
    }>;

export type MonitoredClaim = Readonly<{
  claimId: string;
  statement: string;
  status: string;
  confidence: number;
  evidenceCount: number;
  /** Derived literature-search query (title/abstract keywords). */
  query: string;
}>;

export type ClaimMonitorToolResult =
  | Readonly<{ action: "check"; monitored: readonly MonitoredClaim[]; totalClaims: number }>
  | Readonly<{
      action: "claim_create";
      claim: Readonly<{
        claimId: string;
        statement: string;
        falsificationCondition?: string;
        parentClaimIds?: readonly string[];
        sourceArtifactId?: string;
      }>;
    }>
  | Readonly<{
      action: "claim_supersede";
      /** Claim ids marked superseded (the superseded claim + its descendants). */
      affected: readonly string[];
      supersededByClaimId: string;
    }>;

export type CreateClaimMonitorToolOptions = Readonly<{
  maxResultBytes?: number;
  loadArtifacts?: () => Promise<
    readonly {
      artifactId: string;
      revision: number;
      kind: string;
      status?: string;
      parents?: readonly { relation: string; artifact: { artifactId: string; kind: string } }[];
      updatedAt?: string;
    }[]
  >;
}>;

const MAX_QUERY_CHARS = 200;

export function createClaimMonitorTool(
  options: CreateClaimMonitorToolOptions = {},
): RigoriumToolDefinition<ClaimMonitorToolInput, ClaimMonitorToolResult> {
  return {
    name: "claim_monitor",
    title: "Monitor Claims and Revise the Belief Graph",
    description: `Derive literature-search queries from the project's active claims so the agent (or a scheduled cron job) can watch for new supporting or challenging evidence — and register or supersede claims, which is how research questions enter and leave the belief graph.

Use action=check to list active claims with their evidence counts and a ready-made search query per claim. Then run literature_search with those queries, evaluate any new papers against the claim's falsification condition, and record supports/challenges evidence into the claim graph (via artifact DAG parent relations) when warranted. Use action=claim_create at the start of a research line to register a claim (id, statement, optional falsification condition and parent claims); use action=claim_supersede when evidence falsifies a claim — the superseding claim id propagates to the claim and its descendants so the belief graph re-plans from the revised state. For continuous watching, create a cron job whose message calls claim_monitor then literature_search.`,
    kind: "custom",
    inputSchema: claimMonitorInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 1_000_000,
    isReadOnly: (input) => input.action === "check",
    isConcurrencySafe: () => true,
    isOpenWorld: () => false,
    validateInput: async (input) => validateInput(input),
    execute: async (input, context) => {
      const projectRoot = context.cwd;
      const graph = new ClaimGraph({
        projectRoot,
        loadArtifacts:
          options.loadArtifacts ??
          (async () => {
            const { listLatestProjectResearchArtifacts } = await import("../../research/artifacts/repository.js");
            const artifacts = await listLatestProjectResearchArtifacts({ projectRoot });
            // Map the full evidence surface — parents (supports/challenges
            // edges) and updatedAt must survive, or the belief engine sees
            // zero contributions and every claim stays at prior confidence.
            return artifacts.map((artifact) =>
              Object.freeze({
                artifactId: artifact.artifactId,
                revision: artifact.revision,
                kind: artifact.kind,
                status: artifact.status,
                parents: artifact.parents,
                updatedAt: artifact.updatedAt,
              }),
            );
          }),
      });

      if (input.action === "claim_create") {
        const claim = await graph.upsertClaim({
          claimId: input.claimId,
          statement: input.statement,
          ...(input.falsificationCondition !== undefined ? { falsificationCondition: input.falsificationCondition } : {}),
          ...(input.parentClaimIds !== undefined ? { parentClaimIds: input.parentClaimIds } : {}),
          ...(input.sourceArtifactId !== undefined ? { sourceArtifactId: input.sourceArtifactId } : {}),
        });
        const result: ClaimMonitorToolResult = Object.freeze({
          action: "claim_create",
          claim: Object.freeze({
            claimId: claim.claimId,
            statement: claim.statement,
            ...(claim.falsificationCondition ? { falsificationCondition: claim.falsificationCondition } : {}),
            ...(claim.parentClaimIds ? { parentClaimIds: Object.freeze([...claim.parentClaimIds]) } : {}),
            ...(claim.sourceArtifactId ? { sourceArtifactId: claim.sourceArtifactId } : {}),
          }),
        });
        return {
          content: [
            {
              type: "text",
              text: `Registered claim ${claim.claimId}: "${claim.statement}"${
                claim.falsificationCondition ? `\nfalsification condition: ${claim.falsificationCondition}` : ""
              }`,
            },
          ],
          data: result,
        };
      }

      if (input.action === "claim_supersede") {
        const affected = await graph.supersedeClaim({
          claimId: input.claimId,
          supersededByClaimId: input.supersededByClaimId,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        });
        const result: ClaimMonitorToolResult = Object.freeze({
          action: "claim_supersede",
          affected: Object.freeze(affected),
          supersededByClaimId: input.supersededByClaimId,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `Superseded ${affected.length} claim(s) by "${input.supersededByClaimId}":\n` +
                affected.map((claimId) => `- ${claimId}`).join("\n"),
            },
          ],
          data: result,
        };
      }

      const snapshot = await graph.recomputeBeliefs();
      const statementByClaim = new Map(
        (await graph.listClaims()).map((claim) => [claim.claimId, claim.statement]),
      );
      const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
      const monitored: MonitoredClaim[] = snapshot.beliefs
        .filter((belief) => belief.status === "active")
        // Watch the most uncertain claims first — the truncation must not
        // silently skip the claims that need evidence the most.
        .sort((a, b) => b.uncertainty - a.uncertainty)
        .slice(0, limit)
        .map((belief) => {
          const statement = statementByClaim.get(belief.claimId) ?? belief.claimId;
          return Object.freeze({
            claimId: belief.claimId,
            statement,
            status: belief.status,
            confidence: belief.confidence,
            evidenceCount: belief.evidenceCount,
            query: deriveQuery(statement, belief.claimId),
          });
        });
      const result: ClaimMonitorToolResult = Object.freeze({
        action: "check",
        monitored: Object.freeze(monitored),
        totalClaims: snapshot.beliefs.length,
      });
      return {
        content: [
          {
            type: "text",
            text:
              `Active claims to monitor (${result.monitored.length}/${result.totalClaims}):\n` +
              result.monitored
                .map(
                  (claim) =>
                    `- ${claim.claimId} [${claim.status}, confidence ${claim.confidence.toFixed(2)}, ${claim.evidenceCount} evidence] "${claim.statement}"\n  query: ${claim.query}`,
                )
                .join("\n"),
          },
        ],
        data: result,
      };
    },
  };
}

/** Derive a literature query from the claim statement (stop-word aware). */
export function deriveQuery(statement: string, claimId: string): string {
  const cleaned = statement
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word.toLowerCase()))
    .slice(0, 8)
    .join(" ");
  const query = cleaned.trim();
  if (query.length === 0) {
    return claimId;
  }
  return query.length > MAX_QUERY_CHARS ? query.slice(0, MAX_QUERY_CHARS) : query;
}

const STOP_WORDS = new Set([
  "that", "this", "with", "from", "have", "been", "were", "will", "their", "there",
  "which", "while", "where", "when", "than", "then", "them", "they", "these",
  "those", "into", "over", "under", "about", "between", "after", "before",
  "improves", "improve", "better", "shows", "show", "using", "used", "use",
  "based", "large", "small", "also", "such", "our", "the", "and", "for", "not",
]);

async function validateInput(input: ClaimMonitorToolInput): Promise<RigoriumToolValidationResult> {
  if (!input || typeof input.action !== "string") {
    return { ok: false, issues: [issue("claim_monitor requires an action: check, claim_create, or claim_supersede")] };
  }
  if (input.action === "check") {
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) {
      return { ok: false, issues: [issue("limit must be an integer between 1 and 50")] };
    }
    return { ok: true, input };
  }
  if (input.action === "claim_create") {
    if (typeof input.claimId !== "string" || input.claimId.trim() === "") {
      return { ok: false, issues: [issue("claim_create requires a non-empty claimId")] };
    }
    if (typeof input.statement !== "string" || input.statement.trim() === "") {
      return { ok: false, issues: [issue("claim_create requires a non-empty statement")] };
    }
    if (
      input.parentClaimIds !== undefined &&
      (!Array.isArray(input.parentClaimIds) || input.parentClaimIds.some((id) => typeof id !== "string"))
    ) {
      return { ok: false, issues: [issue("parentClaimIds must be an array of strings")] };
    }
    return { ok: true, input };
  }
  // claim_supersede
  if (typeof input.claimId !== "string" || input.claimId.trim() === "") {
    return { ok: false, issues: [issue("claim_supersede requires a non-empty claimId")] };
  }
  if (typeof input.supersededByClaimId !== "string" || input.supersededByClaimId.trim() === "") {
    return { ok: false, issues: [issue("claim_supersede requires a non-empty supersededByClaimId")] };
  }
  return { ok: true, input };
}

function issue(message: string): RigoriumToolValidationIssue {
  return { path: "", code: "invalid_type", message };
}

function claimMonitorInputSchema(): RigoriumToolInputSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["check", "claim_create", "claim_supersede"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      claimId: { type: "string" },
      statement: { type: "string" },
      falsificationCondition: { type: "string" },
      parentClaimIds: { type: "array", items: { type: "string" } },
      sourceArtifactId: { type: "string" },
      supersededByClaimId: { type: "string" },
      reason: { type: "string" },
    },
  };
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
