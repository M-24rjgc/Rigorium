import { ClaimGraph } from "../../research/claims/ClaimGraph.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult, RigoriumToolInputSchema } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";

/**
 * claim_monitor — turn the claim graph into a literature-watching surface.
 *
 * For every active claim, the tool derives a search query from the claim
 * statement and reports the current evidence count. The agent (or a cron job
 * whose message calls this tool + literature_search) then checks whether new
 * publications support or challenge each claim. The tool only prepares the
 * queries — running them and judging the evidence is the agent's job.
 */

export type ClaimMonitorToolInput = Readonly<{
  action: "check";
  /** Limit on how many claims to monitor per check. */
  limit?: number;
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

export type ClaimMonitorToolResult = Readonly<{
  action: "check";
  monitored: readonly MonitoredClaim[];
  totalClaims: number;
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
    title: "Monitor Claims Against New Literature",
    description: `Derive literature-search queries from the project's active claims so the agent (or a scheduled cron job) can watch for new supporting or challenging evidence.

Use action=check to list active claims with their evidence counts and a ready-made search query per claim. Then run literature_search with those queries, evaluate any new papers against the claim's falsification condition, and record supports/challenges evidence into the claim graph (via artifact DAG parent relations) when warranted. For continuous watching, create a cron job whose message calls claim_monitor then literature_search; the monitor itself never writes to Zotero, exports, or changes the claim graph — it only prepares the watch.`,
    kind: "custom",
    inputSchema: claimMonitorInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 1_000_000,
    isReadOnly: () => true,
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
      const snapshot = await graph.recomputeBeliefs();
      const statementByClaim = new Map(
        (await graph.listClaims()).map((claim) => [claim.claimId, claim.statement]),
      );
      const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
      const monitored: MonitoredClaim[] = snapshot.beliefs
        .filter((belief) => belief.status === "active")
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
  if (!input || input.action !== "check") {
    return { ok: false, issues: [issue("claim_monitor only supports action=check")] };
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) {
    return { ok: false, issues: [issue("limit must be an integer between 1 and 50")] };
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
      action: { type: "string", enum: ["check"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  };
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
