---
name: research-director
description: Build a capability-driven research action plan from a goal and the current artifact graph, then reconcile structured execution receipts into a branch, eliminate, rescan, revise, recover, or stop decision. Use when coordinating research work without introducing a second agent loop or a fixed stage machine.
---

# Direct Research Work

Use `research_director` with `action=plan` before dispatching research work.

First persist every newly produced Design, Method, Experiment, Manuscript, or Review envelope with `research_artifacts` using `operation=append_batch`. That tool is fixed to the runtime Project cwd. Use `list`, `latest`, `get`, or `history` to recover the persisted artifact state after a restart, then supply those persisted versioned artifacts and findings to the Director. Do not build a DAG plan from transient in-memory tool output alone.

Use `research_artifacts` with `operation=invalidate_descendants` only when an explicit artifact root and invalidation reason are known. Its append and invalidation operations are Project-local append-only repository changes; they do not execute downstream research work or replace normal ToolRuntime checks.

Supply the research objective and success criteria, the current persisted versioned artifacts and findings, a fresh capability snapshot, the remaining budget, the effective permission snapshot, and any explicit approval receipts. Treat capability `accepts`, `produces`, and `dependsOnCapabilityIds` as the execution graph.

- Keep only the latest revision of each artifact actionable.
- Recompute latest stale artifacts and route active unresolved findings to capabilities that can produce the affected artifact kind.
- Keep unaffected active artifacts intact.
- Respect the returned action dependencies and ready batches. Parallelize only actions marked concurrency-safe; run a non-concurrency-safe action alone.
- Do not dispatch an action carrying blocked boundary IDs.
- Require explicit approval for Zotero writes, export, snapshot capture, final-title confirmation, and automatic budget actions.
- Treat a Director approval as planning evidence only. The real downstream tool must still pass ToolRuntime permission and confirmation checks.

Dispatch ready action IDs through the existing AgentLoop, ToolRuntime, and scheduler. The Director record is not an executor and must never be translated into an unmediated shell, filesystem, MCP, Zotero, export, or snapshot operation.

After execution, use `research_director` with `action=decide`. Supply the exact plan and structured receipts containing action and capability IDs, status, output artifact references, actual cost and duration, and an explicit outcome where available.

- `branch` continues supported alternatives or remaining dependency-safe work.
- `eliminate` closes a rejected or non-recoverable alternative.
- `rescan` refreshes insufficient evidence.
- `revise` routes work back to the affected artifact contract.
- `recover` retries only blocked or explicitly retryable failed actions after their boundary is resolved.
- `stop` records completion, cancellation, or the absence of justified work.

Create a fresh plan after the artifact graph, findings, permissions, budget, availability, or approvals change. Never infer progress from a fixed stage name.
