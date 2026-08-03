# Belief-Driven Orchestration: Evidence-Graph Planning for Self-Evolving Research Agents

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
