# Rigorium

**长期个人科研工作台**

Rigorium 是一个本地优先的长期科研工作空间。它把项目、文件、智能体会话、任务、记忆、工具和自动化放在同一工作区中，使研究活动能够持续积累、检查和复用。

当前初始版本先建立独立的 Rigorium 名称和视觉身份，同时保持现有运行能力不变。科研专用工作流将在共享工作区基础上逐步增加。

## 当前能力

- 以 Workspace 为核心的项目与会话管理
- 可使用文件、终端和代码工具的 AI Agent 对话
- Git 状态查看与仓库操作
- 任务、计划、定时任务和 Always-on 自动执行
- 本地记忆、Skills、插件和 MCP 扩展
- 可配置的模型 Provider 与智能路由
- 中英文 Web UI
- 现有运行时支持的外部通信渠道

## 科研方向

Rigorium 的目标是成为长期个人科研环境，而不是只处理文献或论文写作的单一工具。现有通用工作区能力继续保留；后续可以逐步增加研究问题、证据、实验、溯源、写作、评审和复现能力，并共享同一套执行基础。

## 开发运行

环境要求：

- Node.js `>=22.13.0 <23`
- pnpm `10.32.1`

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

生产构建后，兼容阶段同时提供两个命令：

```powershell
rigorium
pilotdeck
```

首个版本暂时保留 `~/.pilotdeck`、`pilotdeck.yaml` 和 `PILOTDECK_*` 等内部路径与环境变量，避免破坏现有配置和第三方接入。

## 来源与许可证

Rigorium 基于 [OpenBMB/PilotDeck](https://github.com/OpenBMB/PilotDeck) 的上游提交 `15cb4c2de37f5efd8d2f97feea4e40ab787f3cf3` 修改而来。

本项目按照 [GNU Affero General Public License v3.0](LICENSE) 发布。修改说明和上游署名见 [NOTICE.md](NOTICE.md)。

English documentation: [README.md](README.md)
