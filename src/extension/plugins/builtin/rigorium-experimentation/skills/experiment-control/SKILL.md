---
name: experiment-control
description: Plan, authorize, run, inspect, and recover auditable project-local experiments with explicit execution grants and stable job identities. 在项目内规划、授权、运行、查看和恢复可审计实验，并保持显式授权与稳定任务身份。
---

# Control Experiments

Use `experiment_control` only in the current Project.

- Save a versioned spec before issuing a grant. Treat process workers as executable code and review the exact command and arguments.
- Record paper values as `reported` baselines. Use `observed` only for metrics produced by a recorded run.
- Default to `plan_only`. Use `confirm_each` when every job needs approval, and call `confirm` only after the user approves that exact stable `jobId`. Use `budget_auto` only with an explicit attempt budget.
- Reuse the same `jobId` when retrying a tool call; never create a second identity for an uncertain submission.
- Call `list` before acting on uncertain state. Call `recover` after interruption; recovery records the interruption and never resubmits work.
- Execute only the implemented `local` adapter. Treat SSH, Slurm, MLflow, Optuna, and DVC as reserved metadata.

## 实验控制（中文）

仅在当前项目中使用 `experiment_control`。

- 先保存版本化实验规格，再签发授权；把进程工作器视作可执行代码，审查精确命令及参数。
- 论文中的数值记录为 `reported` 基线；只有来自已记录运行的指标才可记录为 `observed`。
- 默认使用 `plan_only`。每个任务均需批准时使用 `confirm_each`，并且只在用户批准该精确稳定 `jobId` 后调用 `confirm`。`budget_auto` 必须有明确的尝试次数预算。
- 重试工具调用时复用同一个 `jobId`；不确定提交不能创建第二个身份。
- 状态不确定时先调用 `list`；中断后调用 `recover`，恢复只记录中断，绝不重新提交工作。
- 仅执行已实现的 `local` 适配器。SSH、Slurm、MLflow、Optuna 和 DVC 在此工具中仅作为保留元数据。
