---
name: experiment-control
description: Plan, authorize, run, inspect, and recover auditable project-local experiments with explicit execution grants and stable job identities. Use for experiment specs, reported or observed baselines, local worker runs, metrics, artifacts, or interrupted experiment recovery.
---

# Control Experiments

Use `experiment_control` only in the current Project.

- Save a versioned spec before issuing a grant. Treat process workers as executable code and review the exact command and arguments.
- Record paper values as `reported` baselines. Use `observed` only for metrics produced by a recorded run.
- Default to `plan_only`. Use `confirm_each` when every job needs approval, and call `confirm` only after the user approves that exact stable `jobId`. Use `budget_auto` only with an explicit attempt budget.
- Reuse the same `jobId` when retrying a tool call; never create a second identity for an uncertain submission.
- Call `list` before acting on uncertain state. Call `recover` after interruption; recovery records the interruption and never resubmits work.
- Execute only the implemented `local` adapter. Treat SSH, Slurm, MLflow, Optuna, and DVC as reserved metadata.
