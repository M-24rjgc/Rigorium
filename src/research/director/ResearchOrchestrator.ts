import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { ClaimGraph } from "../claims/ClaimGraph.js";
import type { ClaimEvidenceArtifact } from "../claims/ClaimGraph.js";
import { planByInformationGain } from "./eig/planner.js";
import { detectAnomaly, applyAnomalyBoost } from "./eig/anomalyDetector.js";
import { reconcileWithBeliefs, type BeliefRevisionEvent } from "./eig/reconcile.js";
import type { EigPlan, ResearchActionType } from "./eig/types.js";
import { VenueTemplateRegistry } from "../manuscript/templates/VenueTemplateRegistry.js";
import { StyleProfileStore } from "../manuscript/style/StyleProfileStore.js";
import type { ClaimBelief } from "../claims/types.js";

/**
 * ResearchOrchestrator — the production wiring of the belief-driven loop
 * (Phase 4). This is where the Phase 1 engine meets the real project:
 *
 *   artifact DAG (project repository) ──► claim beliefs ──► EIG plan
 *       ──► anomaly boost ──► reconcile ──► ranked actions (+ venue/style
 *       context for the agent to consume) ──► agent executes ──► artifacts
 *       land ──► loop repeats.
 *
 * The orchestrator computes and recommends; the agent (or director skill)
 * executes and decides. `planNextActions` is fully offline — no LLM calls.
 */

export type OrchestratorOptions = {
  projectRoot: string;
  now?: () => Date;
  /** Artifact loader override (tests). Defaults to the project repository. */
  loadArtifacts?: () => Promise<readonly ClaimEvidenceArtifact[]>;
  /** Optional persisted previous beliefs (reconcile input). */
  previousBeliefs?: readonly ClaimBelief[];
  stopScoreThreshold?: number;
};

export type OrchestratedAction = Readonly<{
  type: ResearchActionType;
  claimId?: string;
  score: number;
  expectedInformationGain: number;
  costUnits: number;
  rationale: string;
}>;

export type OrchestrationPlan = Readonly<{
  computedAt: string;
  actions: readonly OrchestratedAction[];
  shouldStop: boolean;
  stopReason?: string;
  /** Belief revisions since the previous plan (backtracking ledger). */
  revisions: readonly BeliefRevisionEvent[];
  backtracking: boolean;
  /** Venue/style context for the agent (undefined when not yet chosen). */
  venue?: { id: string; displayName: string; styleProfileReady: boolean };
  /** Human/agent-readable markdown summary (memory-friendly). */
  summaryMarkdown: string;
  beliefs: readonly ClaimBelief[];
}>;

export class ResearchOrchestrator {
  private readonly projectRoot: string;
  private readonly now: () => Date;
  private readonly loadArtifacts: () => Promise<readonly ClaimEvidenceArtifact[]>;
  private previousBeliefs: readonly ClaimBelief[] | undefined;
  private readonly stopScoreThreshold?: number;

  constructor(options: OrchestratorOptions) {
    this.projectRoot = options.projectRoot;
    this.now = options.now ?? (() => new Date());
    this.loadArtifacts =
      options.loadArtifacts ?? (() => defaultArtifactLoader(options.projectRoot));
    this.previousBeliefs = options.previousBeliefs;
    this.stopScoreThreshold = options.stopScoreThreshold;
  }

  /**
   * Compute the next research actions from the current belief state, with
   * anomaly boosting, belief reconciliation, and venue/style context.
   */
  async planNextActions(): Promise<OrchestrationPlan> {
    const claimsDir = join(this.projectRoot, ".rigorium", "research", "claims");
    const graph = new ClaimGraph({
      projectRoot: this.projectRoot,
      now: this.now,
      loadArtifacts: this.loadArtifacts,
    });
    const snapshot = await graph.recomputeBeliefs({});
    const beliefs = snapshot.beliefs;

    let plan: EigPlan = planByInformationGain(beliefs, {
      ...(this.stopScoreThreshold !== undefined ? { stopScoreThreshold: this.stopScoreThreshold } : {}),
    });
    const anomaly = detectAnomaly(beliefs);
    plan = applyAnomalyBoost(plan, anomaly, this.stopScoreThreshold);
    const reconciled = reconcileWithBeliefs(beliefs, this.previousBeliefs, plan, {
      ...(this.stopScoreThreshold !== undefined ? { stopScoreThreshold: this.stopScoreThreshold } : {}),
    });
    this.previousBeliefs = beliefs;

    const actions: OrchestratedAction[] = reconciled.plan.ranked.map((estimate) =>
      Object.freeze({
        type: estimate.action.type,
        ...(estimate.action.claimId ? { claimId: estimate.action.claimId } : {}),
        score: estimate.score,
        expectedInformationGain: estimate.expectedInformationGain,
        costUnits: estimate.costUnits,
        rationale: estimate.rationale,
      }),
    );

    const venue = await this.resolveVenueContext();
    const summaryMarkdown = renderSummaryMarkdown({
      computedAt: this.now().toISOString(),
      beliefs,
      actions,
      shouldStop: reconciled.plan.shouldStop,
      stopReason: reconciled.plan.stopReason,
      revisions: reconciled.revisions,
      backtracking: reconciled.backtracking,
      anomalyDetected: anomaly.detected,
      anomalyScore: anomaly.anomalyScore,
      venue,
      claimsDir,
    });

    return Object.freeze({
      computedAt: this.now().toISOString(),
      actions: Object.freeze(actions),
      shouldStop: reconciled.plan.shouldStop,
      stopReason: reconciled.plan.stopReason,
      revisions: reconciled.revisions,
      backtracking: reconciled.backtracking,
      ...(venue ? { venue } : {}),
      summaryMarkdown,
      beliefs: Object.freeze(beliefs),
    });
  }

  /** Persist the plan summary for the memory layer / human review. */
  async writeSummary(summaryMarkdown: string): Promise<string> {
    const dir = join(this.projectRoot, ".rigorium", "research", "claims");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "summary.md");
    await writeFile(path, summaryMarkdown, { encoding: "utf8" });
    return path;
  }

  private async resolveVenueContext(): Promise<
    { id: string; displayName: string; styleProfileReady: boolean } | undefined
  > {
    try {
      const registry = new VenueTemplateRegistry({ projectRoot: this.projectRoot, now: this.now });
      const styleStore = new StyleProfileStore({ projectRoot: this.projectRoot, now: this.now });
      const venues = await registry.listVenues();
      if (venues.length === 0) return undefined;
      const profiles = await styleStore.list();
      const profileVenues = new Set(profiles.map((profile) => profile.venue));
      // Prefer a venue with a style profile (learning complete); otherwise
      // surface the first candidate for the agent to decide.
      const withProfile = venues.find((venue) => profileVenues.has(venue.id));
      const chosen = withProfile ?? venues[0];
      if (!chosen) return undefined;
      return Object.freeze({
        id: chosen.id,
        displayName: chosen.displayName,
        styleProfileReady: profileVenues.has(chosen.id),
      });
    } catch {
      return undefined;
    }
  }
}

/** Default loader: the project's artifact repository, latest active revisions. */
export async function defaultArtifactLoader(
  projectRoot: string,
): Promise<readonly ClaimEvidenceArtifact[]> {
  const { listLatestProjectResearchArtifacts } = await import("../artifacts/repository.js");
  const artifacts = await listLatestProjectResearchArtifacts({ projectRoot });
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
}

function renderSummaryMarkdown(input: {
  computedAt: string;
  beliefs: readonly ClaimBelief[];
  actions: readonly OrchestratedAction[];
  shouldStop: boolean;
  stopReason?: string;
  revisions: readonly BeliefRevisionEvent[];
  backtracking: boolean;
  anomalyDetected: boolean;
  anomalyScore: number;
  venue?: { id: string; displayName: string; styleProfileReady: boolean };
  claimsDir: string;
}): string {
  const lines: string[] = [
    "# Research Orchestration Summary",
    "",
    `Computed at: ${input.computedAt}`,
    "",
    "## Belief state",
    ...(input.beliefs.length === 0
      ? ["No claims yet — the research has not been structured into claims."]
      : input.beliefs.map((belief) => {
          const evidence = belief.evidenceCount > 0 ? ` (${belief.evidenceCount} evidence)` : "";
          return `- \`${belief.claimId}\` [${belief.status}] confidence ${belief.confidence.toFixed(2)}, uncertainty ${belief.uncertainty.toFixed(2)}${evidence}`;
        })),
    "",
    "## Recommended actions (EIG/cost)",
    ...(input.actions.length === 0
      ? ["None."]
      : input.actions.map(
          (action) =>
            `- **${action.type}**${action.claimId ? ` on \`${action.claimId}\`` : ""} — score ${action.score.toFixed(4)}, EIG ${action.expectedInformationGain.toFixed(2)}, cost ${action.costUnits.toFixed(1)} — ${action.rationale}`,
        )),
    "",
    `Should stop: ${input.shouldStop}${input.stopReason ? ` — ${input.stopReason}` : ""}`,
  ];
  if (input.backtracking) {
    lines.push("", "## Belief revisions (backtracking)", ...input.revisions.map((revision) => `- \`${revision.claimId}\`: ${revision.from} → ${revision.to} — ${revision.reason}`));
  }
  if (input.anomalyDetected) {
    lines.push("", `## Anomaly mode active (challenge density ${input.anomalyScore.toFixed(2)}) — principle revision is boosted.`);
  }
  if (input.venue) {
    lines.push("", `## Venue context\n- Target venue: ${input.venue.id} (${input.venue.displayName}) — style profile ${input.venue.styleProfileReady ? "ready" : "not yet learned"}.`);
  }
  lines.push("", `Claims store: \`${input.claimsDir}/claims.json\` — summary: \`${input.claimsDir}/summary.md\``);
  return lines.join("\n") + "\n";
}
