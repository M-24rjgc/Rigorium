# First EIG plan (seed state)

Computed at: 2026-08-03T08:51:47.448Z

## Belief state (seed — no evidence yet)
- `c-thesis` [active] confidence 0.50, uncertainty 1.00 — "A belief-driven orchestration loop — claims-and-evidence gra…"
- `c-eig-selection` [active] confidence 0.50, uncertainty 1.00 — "Ranking (claim, action) pairs by expected information gain p…"
- `c-batch` [active] confidence 0.50, uncertainty 1.00 — "Diversity-aware batch selection with a mutual-information pe…"
- `c-backtrack` [active] confidence 0.50, uncertainty 1.00 — "Cascading supersede plus replanning from the revised belief …"
- `c-taste` [active] confidence 0.50, uncertainty 1.00 — "An EMA-calibrated taste model, regressing proxy scores again…"
- `c-routing` [active] confidence 0.50, uncertainty 1.00 — "Research-aware routing with capability priors and an uncerta…"
- `c-multimodal` [active] confidence 0.50, uncertainty 1.00 — "Vision-assistant enrichment lets text-only models consume fi…"
- `c-bootstrap` [active] confidence 0.50, uncertainty 1.00 — "The platform can autonomously produce a publishable descript…"

## Recommended actions (EIG/cost)
- **literature_search** on `c-thesis` — score 0.1750, EIG 0.35, cost 2.0 — literature_search on "c-thesis": uncertainty 1.00 × factor 0.35 × maturity 1.00
- **literature_search** on `c-eig-selection` — score 0.1750, EIG 0.35, cost 2.0 — literature_search on "c-eig-selection": uncertainty 1.00 × factor 0.35 × maturity 1.00
- **literature_search** on `c-batch` — score 0.1750, EIG 0.35, cost 2.0 — literature_search on "c-batch": uncertainty 1.00 × factor 0.35 × maturity 1.00
- **literature_search** on `c-backtrack` — score 0.1750, EIG 0.35, cost 2.0 — literature_search on "c-backtrack": uncertainty 1.00 × factor 0.35 × maturity 1.00
- **literature_search** on `c-taste` — score 0.1750, EIG 0.35, cost 2.0 — literature_search on "c-taste": uncertainty 1.00 × factor 0.35 × maturity 1.00
- **literature_search** on `c-routing` — score 0.1750, EIG 0.35, cost 2.0 — literature_search on "c-routing": uncertainty 1.00 × factor 0.35 × maturity 1.00

Should stop: false

## How to read this
With every claim at uncertainty 1.0, literature search dominates: it is
the cheapest way to turn prior-less claims into informed ones. The agent
should execute these searches (venue corpus + claim_monitor queries),
land evidence_pack artifacts with supports/challenges edges, then
re-plan — the planner will start proposing experiments as beliefs
firm up. Regenerate this report with `node scripts/bootstrap-framework-paper.mjs --plan`.
