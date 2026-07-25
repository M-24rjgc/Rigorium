---
name: research-review
description: Run a manuscript review round with deterministic preflight, seven independent substantive lanes, anchored findings, contradiction preservation, and explicit artifact-routed revision decisions. Use when checking a versioned manuscript before revision or recording what upstream research artifacts must change.
---

# Review a Research Manuscript

Start from one active `ManuscriptVersion` and, when available, its exact `RenderRun`, `CitationSet`, figure/table artifacts, and producing run attempts.

Use `research_review` with `run_review` to create one auditable round. Supply exactly one independent report for each method, theory, statistics, evidence, novelty, writing, and target-fit lane.

- Run deterministic checks for compilation and PDF output, citation-to-evidence bindings, configured main-matter limits, anonymous-submission state, and figure/table hashes with producing-run provenance.
- Anchor every finding to a declared manuscript section and an exact statement, paragraph, page, line span, or short source anchor. Do not return free-floating ratings or generic review scores.
- Keep concern and cleared assessments distinct. Merge only compatible findings with the same deduplication key and location; preserve opposing assessments in an adjudication group.
- Keep evidence references, run references, affected artifacts, action targets, severity, confidence, rationale, and reviewer identity attached to each finding.
- Treat target-fit rules as versioned constraints. Do not copy third-party style or checklist sources when the inspected upstream bundle lacks a suitable distribution license.

Use `research_review` with `decide_revision` only after reviewing every finding. Resolve each one exactly once as `revise`, `dismiss`, or `defer`.

- A `revise` decision must identify a non-empty subset of that finding's affected artifact references.
- `dismiss` and `defer` record rationale but do not invalidate artifacts.
- Invalidation marks active descendants stale while leaving the selected roots and unrelated artifacts active.
- Keep the decision as a research artifact. Do not edit manuscript files, contact reviewers, create a rebuttal, submit a paper, or advance a fixed workflow stage.
