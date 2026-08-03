#!/usr/bin/env node
/**
 * Bootstrap the framework paper project — the self-bootstrapping milestone
 * ("use the platform to write the platform paper").
 *
 * Creates a project at `bootstrap/framework-paper/` (or `--project <dir>`)
 * with:
 *
 *   README.md                  — project brief + how to run the loop
 *   paper/outline.md           — ICLR 2026 paper outline (story line per section)
 *   paper/claims.md            — human-readable claim seeds + falsification
 *   paper/venue-pin.md         — the venue decision record (ICLR 2026, verified)
 *   paper/eig-plan.md          — first EIG plan computed with the REAL planner
 *   .rigorium/research/claims/claims.json — seed claim graph (runtime state)
 *   .rigorium/research/venues/venues.json — venue pin override (runtime state)
 *
 * The `paper/` materials are committed; the `.rigorium/` state is generated
 * (gitignored) so the project can be regenerated at any time. The claim graph
 * and venue registry are written in the exact on-disk formats the production
 * code reads, so the project is *immediately usable*: opening it in the
 * platform, the orchestrator sees the seed beliefs and plans the first
 * literature-search actions.
 *
 * Usage:
 *   node scripts/bootstrap-framework-paper.mjs [--project <dir>] [--plan] [--dry-run]
 *
 * `--plan` (default on) computes the first EIG plan from the compiled planner
 * (`npx tsc -p tsconfig.json` first). Without a build, the plan file is
 * deferred with a note instead of embedded by hand — the plan is a *derived
 * report*, never a duplicated copy of the math.
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const args = process.argv.slice(2);
const projectArg =
  args.find((arg) => arg.startsWith("--project="))?.split("=")[1] ??
  (() => {
    const index = args.indexOf("--project");
    return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
  })();
const projectRoot = resolve(projectArg ?? join(repoRoot, "bootstrap", "framework-paper"));
const wantPlan = !args.includes("--no-plan");
const dryRun = args.includes("--dry-run");

// ---------------------------------------------------------------------------
// Claim seeds — the framework paper's belief system, stated as falsifiable
// claims with parent (derivation) edges. This is the *source of truth*; the
// runtime claims.json below is derived from it.
// ---------------------------------------------------------------------------

const CLAIM_SEEDS = Object.freeze([
  {
    claimId: "c-thesis",
    statement:
      "A belief-driven orchestration loop — claims-and-evidence graph, EIG/cost action ranking, and belief-revision backtracking — outperforms fixed-pipeline orchestration for open-ended AI research agents.",
    falsificationCondition:
      "On the evaluation protocol, a fixed pipeline baseline matches or beats belief-driven orchestration on all of: paper quality score, cost per unit quality, and falsification-recovery success.",
  },
  {
    claimId: "c-eig-selection",
    statement:
      "Ranking (claim, action) pairs by expected information gain per unit cost selects actions whose executed outcomes resolve more belief uncertainty per token than template-based stage progression.",
    falsificationCondition:
      "A greedy equal-cost action scheduler achieves equal-or-better uncertainty resolution per token on the benchmark corpus.",
    parentClaimIds: ["c-thesis"],
  },
  {
    claimId: "c-batch",
    statement:
      "Diversity-aware batch selection with a mutual-information penalty preserves at least 90% of single-action expected information gain when parallelizing independent claims.",
    falsificationCondition:
      "Top-k batch selection without the MI penalty achieves within 10% of the diversity-aware batch's realized gain at equal parallelism.",
    parentClaimIds: ["c-thesis"],
  },
  {
    claimId: "c-backtrack",
    statement:
      "Cascading supersede plus replanning from the revised belief state recovers from claim falsification with lower wasted cost than stack-based rollback.",
    falsificationCondition:
      "Stack-based rollback recovers equivalent belief states at equal-or-lower cumulative cost in ≥50% of falsification episodes.",
    parentClaimIds: ["c-thesis"],
  },
  {
    claimId: "c-taste",
    statement:
      "An EMA-calibrated taste model, regressing proxy scores against 7-lane reviews, converges within five review rounds and tracks expert judgment.",
    falsificationCondition:
      "Calibration error against held-out review rounds fails to decrease monotonically after five rounds.",
    parentClaimIds: ["c-thesis"],
  },
  {
    claimId: "c-routing",
    statement:
      "Research-aware routing with capability priors and an uncertainty-gated amortized ranker reduces judge-model calls by at least 50% at equal end-task quality.",
    falsificationCondition:
      "Judge call rate reduction exceeds zero but end-task quality drops by more than 3% on the benchmark suite.",
    parentClaimIds: ["c-thesis"],
  },
  {
    claimId: "c-multimodal",
    statement:
      "Vision-assistant enrichment lets text-only models consume figures with accuracy within five points of native multimodal models on figure-grounded tasks.",
    falsificationCondition:
      "Text-only + enrichment trails native multimodal by more than five accuracy points on figure-grounded tasks.",
    parentClaimIds: ["c-thesis"],
  },
  {
    claimId: "c-bootstrap",
    statement:
      "The platform can autonomously produce a publishable description of its own orchestration architecture, without a human-authored manuscript.",
    falsificationCondition:
      "The final manuscript requires human-written prose beyond templated assembly in any major section.",
    parentClaimIds: ["c-thesis"],
  },
]);

/** Fixed seed timestamp keeps the generated claims.json deterministic in git. */
const SEED_AT = "2026-08-03T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Venue pin — ICLR 2026 with the integrity-verified Master-Template commit.
// Written as a registry override so the decision is machine-readable: the
// venue-template tool and orchestrator resolve exactly this source.
// ---------------------------------------------------------------------------

const VENUE_PIN = Object.freeze({
  schemaVersion: 1,
  venues: [
    {
      id: "iclr",
      kind: "conference",
      displayName: "International Conference on Learning Representations",
      publisher: "ICLR",
      anonymousSubmission: true,
      defaultPageLimit: 9,
      sources: [
        {
          year: 2026,
          officialPageUrl: "https://iclr.cc/Conferences/2026/AuthorGuide",
          archiveUrl:
            "https://raw.githubusercontent.com/ICLR/Master-Template/a28d335b0d46a3c39b205704a65faf41c9748433/iclr2026.zip",
          repositoryUrl: "https://github.com/ICLR/Master-Template",
          commit: "a28d335b0d46a3c39b205704a65faf41c9748433",
          archiveSha256: "sha256:b6d63b29992e153f804bb6d170c57db156c011b5bedf96a9f31d58813b909acf",
          archiveBytes: 241296,
          requiredFiles: [
            "fancyhdr.sty",
            "iclr2026_conference.bst",
            "iclr2026_conference.sty",
            "math_commands.tex",
            "natbib.sty",
          ],
          verified: true,
          notes:
            "Pinned by the bootstrap: ICLR 2026 official Master-Template at the verified commit. Anonymous submission is the default mode.",
        },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// Paper materials (committed)
// ---------------------------------------------------------------------------

const OUTLINE_MD = `# Belief-Driven Orchestration: Evidence-Graph Planning for Self-Evolving Research Agents

*Target: ICLR 2026 (template pinned — see venue-pin.md). Working title; the
agent may refine it during writing, but the contribution triangle below is
fixed by the claim graph (c-thesis).*

## Contribution triangle (must all survive review)
1. **Belief-driven orchestration**: research actions are ranked by expected
   information gain per unit cost over a claims-and-evidence graph — no fixed
   pipeline, stop is a first-class decision (claims: c-thesis, c-eig-selection).
2. **Falsification-first backtracking**: belief revision (cascading supersede)
   + replanning from the revised state, fully artifact-auditable (c-backtrack).
3. **Self-bootstrapping evaluation**: the platform wrote this paper through its
   own loop; every section cites claim-graph evidence artifacts (c-bootstrap).

## Section story line (ICLR structure)
- **Abstract**: the problem (open-ended research ≠ fixed pipeline), the
  mechanism (beliefs + EIG/cost), the evidence (this paper as a witness).
- **1 Introduction**: LLM research agents exist but orchestrate via stage
  templates; argue that under epistemic uncertainty action selection needs a
  principled objective; state contributions 1–3 and the falsification protocol.
- **2 Related Work**: AI Scientist / agent-for-science systems; AutoML and
  Bayesian optimization (cost-aware acquisition); BALD / expected information
  gain (acquisition on data vs. on research actions — our departure); belief
  revision / truth maintenance systems (our graph analog); mixture-of-agents
  and routing literature (for the routing section).
- **3 Preliminaries**: artifact DAG; claim graph; belief propagation (weights,
  saturation, challenged/falsified thresholds); cost model. Formal definitions
  in one clean block — reviewers must not have to re-derive the math.
- **4 Belief-Driven Orchestration**: 4.1 EIG estimator and gain factors; 4.2
  batch selection with MI penalty (BatchBALD connection); 4.3 belief-revision
  backtracking (supersede cascade + replan); 4.4 anomaly detection → principle
  revision boost; 4.5 taste calibration (EMA proxy regression).
- **5 Research-Aware Routing**: capability requirements → tier priors;
  amortized per-bucket ranker; uncertainty-gated judge (latency/cost claim
  c-routing); vision-assistant enrichment (c-multimodal).
- **6 Evaluation**: 6.1 benchmark protocol (task corpus, cost accounting,
  review harness — 7-lane); 6.2 belief-driven vs. pipeline baselines; 6.3
  ablations (batch MI, backtracking, taste calibration); 6.4 routing
  (judge-call reduction at equal quality); 6.5 the bootstrap witness: this
  paper's own artifact trail (claim graph → evidence → manuscript versions).
- **7 Discussion & Limitations**: cost of graph bookkeeping; where pipelines
  win (well-specified tasks); evaluator bias in self-bootstrapping.
- **8 Conclusion**: contribution restated against falsification protocol.
- **Ethics Statement** (required by ICLR): agent cost/energy, review harness
  fairness, no deception about provenance (the paper discloses it was
  platform-generated).

## Writing-time rules (from venue style learning)
- Each section must cite at least one claim-graph artifact as evidence
  (manuscript_version parents point at the claims they support).
- Figures: architecture diagram (Figure 1) and EIG-vs-pipeline curves
  (Figures 2–3); style parameters come from the learned ICLR style profile.
- Reviewers' prior questions (from style corpus): always preempt "what breaks
  if the gain factors are wrong?" — answer with the calibration loop.
`;

const CLAIMS_MD = `# Framework paper — claim seeds

The belief system this paper starts from. Written as falsifiable claims with
derivation edges; the claim graph lives in
\`.rigorium/research/claims/claims.json\` (generated by
\`scripts/bootstrap-framework-paper.mjs\`). Evidence lands on claims through
the artifact DAG's \`supports\` / \`challenges\` parent relations — every
literature pack, experiment run, and review round in this project updates the
beliefs below, and the EIG planner schedules the next action from them.

| claim | statement (abridged) | falsification condition | parents |
|---|---|---|---|
${CLAIM_SEEDS.map(
  (claim) =>
    `| \`${claim.claimId}\` | ${claim.statement} | ${claim.falsificationCondition} | ${(claim.parentClaimIds ?? []).join(", ") || "—"} |`,
).join("\n")}

## Reading the graph
- \`c-thesis\` is the root: everything must accumulate evidence for it.
- \`c-eig-selection\` / \`c-batch\` / \`c-backtrack\` are the mechanism claims
  (Section 4); \`c-routing\` / \`c-multimodal\` are the system claims
  (Section 5); \`c-taste\` is the learning claim; \`c-bootstrap\` is the
  meta-claim this very project demonstrates.
- At seed time every claim has uncertainty 1.0 — the first plan is therefore
  *literature_search across all claims* (see eig-plan.md), exactly what the
  platform recommends when starting from zero.
`;

const VENUE_PIN_MD = `# Venue pin — ICLR 2026

Decision record (made at project start, per PaperStudio protocol):

- **Venue**: ICLR (International Conference on Learning Representations),
  conference, anonymous submission, 9-page limit.
- **Year**: 2026 — the official ICLR 2026 author kit exists and is
  integrity-verified in the built-in registry (commit
  \`a28d335b0d46a3c39b205704a65faf41c9748433\`, sha256 pinned). If the target
  year moves to 2027 before the kit ships, use the 2026 kit and adjust the
  year token (the registry's documented fallback policy).
- **Machine-readable**: written as a project-level venue override at
  \`.rigorium/research/venues/venues.json\`, so the venue-template tool and
  the orchestrator resolve exactly the pinned source without code changes.
- **Style learning**: before writing, download ~10 high-scoring ICLR 2024–2025
  papers into the venue corpus and learn the style profile (sentence/paragraph
  templates, story line, figure conventions) into the project memory.
`;

const README_MD = `# Framework Paper — bootstrap project

**The self-bootstrapping milestone**: this project is the platform writing the
platform paper. Everything in this directory is *material*; the runtime state
(\`.rigorium/\`) is generated and gitignored.

## What is here
- \`paper/outline.md\` — ICLR 2026 paper outline (story line per section).
- \`paper/claims.md\` — the claim seeds (belief system) with falsification.
- \`paper/venue-pin.md\` — the venue decision record.
- \`paper/eig-plan.md\` — the first EIG plan (regenerate with \`--plan\`).

## How to regenerate the project
\`\`\`bash
npx tsc -p tsconfig.json   # build the platform (needed for --plan)
node scripts/bootstrap-framework-paper.mjs --project bootstrap/framework-paper
\`\`\`

## How to run the research loop (the point)
1. Open this project in Rigorium (or point the gateway at it).
2. The orchestrator reads the seed claim graph and plans the first actions —
   with zero evidence, every claim has uncertainty 1.0, so the plan is
   literature-first (see eig-plan.md). The agent executes those actions with
   the venue-template, venue-corpus, and style-learning tools.
3. Evidence artifacts land in the DAG with \`supports\`/\`challenges\` edges;
   beliefs update; the planner re-ranks; experiments begin once literature
   evidence makes them the best gain/cost.
4. When a claim is challenged/falsified, belief revision cascades and the
   plan replans from the revised state (never stack-pop).
5. The claim_monitor tool watches the literature for evidence against any
   active claim and alerts the orchestrator.
6. Writing starts when evidence maturity allows (write_section carries zero
   EIG by design — writing consumes evidence, it does not resolve
   uncertainty); figures come from figure_generate with the learned style
   profile; vision-assistant enrichment keeps text-only models figure-aware.
7. The 7-lane review loop feeds the taste calibrator; reviews land as
   \`finding\` artifacts and drive the final revision.

## Acceptance (self-bootstrap criterion)
The final manuscript must be producible by the platform's own loop: outline →
evidence → sections, with every section citing claim-graph evidence, and a
complete artifact trail (\`claims.json\`, artifact manifest, review rounds)
that a reader can audit.
`;

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function claimsJson() {
  return {
    schemaVersion: 1,
    claims: CLAIM_SEEDS.map((seed) => ({
      claim: {
        claimId: seed.claimId,
        statement: seed.statement,
        falsificationCondition: seed.falsificationCondition,
        parentClaimIds: seed.parentClaimIds ?? undefined,
        createdAt: SEED_AT,
      },
    })),
  };
}

/** Render an EIG plan into markdown (mirrors the orchestrator's summary style). */
function renderPlanMarkdown(plan, beliefs) {
  const statementById = new Map(CLAIM_SEEDS.map((seed) => [seed.claimId, seed.statement]));
  const lines = [
    "# First EIG plan (seed state)",
    "",
    `Computed at: ${plan.computedAt}`,
    "",
    "## Belief state (seed — no evidence yet)",
    ...beliefs.map((belief) => {
      const statement = statementById.get(belief.claimId) ?? "";
      const label = statement ? `"${statement.slice(0, 60)}${statement.length > 60 ? "…" : ""}"` : belief.claimId;
      return `- \`${belief.claimId}\` [${belief.status}] confidence ${belief.confidence.toFixed(2)}, uncertainty ${belief.uncertainty.toFixed(2)} — ${label}`;
    }),
    "",
    "## Recommended actions (EIG/cost)",
    ...(plan.ranked.length === 0
      ? ["None."]
      : plan.ranked.map(
          (estimate) =>
            `- **${estimate.action.type}**${estimate.action.claimId ? ` on \`${estimate.action.claimId}\`` : ""} — score ${estimate.score.toFixed(4)}, EIG ${estimate.expectedInformationGain.toFixed(2)}, cost ${estimate.costUnits.toFixed(1)} — ${estimate.rationale}`,
        )),
    "",
    `Should stop: ${plan.shouldStop}${plan.stopReason ? ` — ${plan.stopReason}` : ""}`,
    "",
    "## How to read this",
    "With every claim at uncertainty 1.0, literature search dominates: it is",
    "the cheapest way to turn prior-less claims into informed ones. The agent",
    "should execute these searches (venue corpus + claim_monitor queries),",
    "land evidence_pack artifacts with supports/challenges edges, then",
    "re-plan — the planner will start proposing experiments as beliefs",
    "firm up. Regenerate this report with `node scripts/bootstrap-framework-paper.mjs --plan`.",
    "",
  ];
  return lines.join("\n");
}

async function computePlan() {
  // Use the REAL production planner: seed beliefs → EIG plan. No duplicated
  // math in this script — the report is derived from the platform itself.
  const plannerUrl = pathToFileURL(join(repoRoot, "dist", "src", "research", "director", "eig", "planner.js"));
  const graphUrl = pathToFileURL(join(repoRoot, "dist", "src", "research", "claims", "ClaimGraph.js"));
  const planner = await import(plannerUrl.href);
  const { ClaimGraph } = await import(graphUrl.href);
  const graph = new ClaimGraph({
    projectRoot,
    loadArtifacts: async () => [],
  });
  const snapshot = await graph.recomputeBeliefs({});
  const plan = planner.planByInformationGain(snapshot.beliefs, {});
  return { plan, beliefs: snapshot.beliefs };
}

async function main() {
  const planNotice =
    wantPlan
      ? "  (plan computation skipped — run `npx tsc -p tsconfig.json` first, then re-run with --plan)"
      : "  (deferred — run with --plan after building)";

  // Pass 1: write every file EXCEPT the plan. The plan report is *derived*
  // from the on-disk claim graph (the real production read path), so the
  // seed state must exist before it is computed — otherwise a clean checkout
  // would yield an empty plan that contradicts the project's own story.
  const files = new Map();
  files.set(join(projectRoot, "README.md"), README_MD);
  files.set(join(projectRoot, "paper", "outline.md"), OUTLINE_MD);
  files.set(join(projectRoot, "paper", "claims.md"), CLAIMS_MD);
  files.set(join(projectRoot, "paper", "venue-pin.md"), VENUE_PIN_MD);
  files.set(join(projectRoot, ".rigorium", "research", "claims", "claims.json"), `${JSON.stringify(claimsJson(), null, 2)}\n`);
  files.set(join(projectRoot, ".rigorium", "research", "venues", "venues.json"), `${JSON.stringify(VENUE_PIN, null, 2)}\n`);

  if (dryRun) {
    console.log(`[dry-run] would create ${files.size + 1} files under ${projectRoot}`);
    for (const path of files.keys()) console.log(`  + ${path}`);
    console.log(`  + ${join(projectRoot, "paper", "eig-plan.md")}${wantPlan ? "" : planNotice}`);
    return;
  }

  for (const [path, content] of files) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { encoding: "utf8" });
    console.log(`  + ${path}`);
  }

  // Pass 2: compute the plan from the freshly written seed state.
  const planPath = join(projectRoot, "paper", "eig-plan.md");
  let planText = null;
  if (wantPlan) {
    try {
      const computed = await computePlan();
      planText = renderPlanMarkdown(computed.plan, computed.beliefs);
    } catch (error) {
      if (error && error.code === "ERR_MODULE_NOT_FOUND") {
        console.warn(`dist build not found at ${repoRoot}\\dist — ${planNotice}`);
      } else {
        throw error;
      }
    }
  }
  if (planText === null) {
    planText =
      "# First EIG plan (seed state)\n\n_Not yet computed._\n\n" +
      "This report is derived from the platform's own planner, never handwritten. " +
      "Build the platform (`npx tsc -p tsconfig.json`) and re-run:\n\n" +
      "```bash\nnode scripts/bootstrap-framework-paper.mjs --project " +
      projectRoot +
      " --plan\n```\n";
  }
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, planText, { encoding: "utf8" });
  console.log(`  + ${planPath}`);

  console.log(`\nBootstrap project ready: ${projectRoot}`);
  console.log("Open it in the platform to start the research loop. Regenerate with the same command.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
