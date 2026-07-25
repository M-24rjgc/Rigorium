---
name: experiment-remote
description: Register, inspect, preflight, submit, query, recover, and cancel auditable Project-local SSH or Slurm experiments with stable job identities and explicit grants. 在当前项目中登记、查看、预检、提交、查询、恢复和取消可审计的 SSH 或 Slurm 实验，并保持稳定任务身份与显式授权。
---

# Remote Experiments / 远程实验

Use `experiment_remote` only in the current Project. Its local storage root is always the runtime Project cwd.

- Register a fixed connection before using it. Use strict known-host verification and a fixed remote-agent command.
- Treat `stage` as a local hash preflight only. It checks Project files and the registered workspace boundary, but does not contact the host or write remote files.
- Use `submit` for the actual authorized network action. Remote staging occurs inside that submission only after the execution grant and stable `jobId` are reserved.
- Keep the same `jobId` and terms for retries. For `submission_uncertain`, use `query` or `recover`; never submit a second identity.
- `plan_only` never executes. `confirm_each` needs `confirm` after approval of that exact job. `budget_auto` needs the grant's explicit approval and `automaticGrantConfirmed: true` at submit time.
- Treat `cancel` as an explicit user action. Query, recover, and cancel contact the remote agent; inspect their recorded result before taking a follow-up action.

仅在当前项目中使用 `experiment_remote`，本地存储根目录始终固定为运行时的项目 cwd。

- 使用前先登记固定连接，并使用严格的 known-host 校验和固定远端代理命令。
- 将 `stage` 视为仅在本地进行的哈希预检：它检查项目文件和已登记的工作区边界，不连接主机，也不写入远端文件。
- 实际的已授权网络操作使用 `submit`。远端暂存只会在提交内部、执行授权与稳定 `jobId` 已保留之后发生。
- 重试时必须保持相同的 `jobId` 和执行条款。遇到 `submission_uncertain` 时使用 `query` 或 `recover`，绝不再提交第二个身份。
- `plan_only` 永不执行；`confirm_each` 必须在用户批准该精确任务后调用 `confirm`；`budget_auto` 需要已明确批准的授权，并在提交时提供 `automaticGrantConfirmed: true`。
- `cancel` 属于显式用户操作。`query`、`recover` 和 `cancel` 会联系远端代理；后续操作前应检查其记录结果。
