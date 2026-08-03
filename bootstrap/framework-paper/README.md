# Framework Paper — bootstrap project

**The self-bootstrapping milestone**: this project is the platform writing the
platform paper. Everything in this directory is *material*; the runtime state
(`.rigorium/`) is generated and gitignored.

## What is here
- `paper/outline.md` — ICLR 2026 paper outline (story line per section).
- `paper/claims.md` — the claim seeds (belief system) with falsification.
- `paper/venue-pin.md` — the venue decision record.
- `paper/eig-plan.md` — the first EIG plan (regenerate with `--plan`).

## How to regenerate the project
```bash
npx tsc -p tsconfig.json   # build the platform (needed for --plan)
node scripts/bootstrap-framework-paper.mjs --project bootstrap/framework-paper
```

## How to run the research loop (the point)
1. Open this project in Rigorium (or point the gateway at it).
2. The orchestrator reads the seed claim graph and plans the first actions —
   with zero evidence, every claim has uncertainty 1.0, so the plan is
   literature-first (see eig-plan.md). The agent executes those actions with
   the venue-template, venue-corpus, and style-learning tools.
3. Evidence artifacts land in the DAG with `supports`/`challenges` edges;
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
   `finding` artifacts and drive the final revision.

## Acceptance (self-bootstrap criterion)
The final manuscript must be producible by the platform's own loop: outline →
evidence → sections, with every section citing claim-graph evidence, and a
complete artifact trail (`claims.json`, artifact manifest, review rounds)
that a reader can audit.
