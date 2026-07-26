# Rigorium

**长期个人科研工作台**

Rigorium 是一个本地优先的长期科研工作空间。它把项目、文件、智能体会话、任务、记忆、工具和自动化放在同一工作区中，使研究活动能够持续积累、检查和复用。

Rigorium 拥有独立的仓库、发布通道和桌面应用身份；科研专用工作流将在共享工作区基础上逐步增加。

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

## 下载

可从 [GitHub Releases](https://github.com/M-24rjgc/Rigorium/releases/latest) 下载当前 Windows 安装包。桌面应用会检查该发布通道，并在启动安装程序前验证 SHA-256 完整性。

## 开发运行

环境要求：

- Node.js `>=22.13.0 <23`
- pnpm `10.32.1`

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

生产构建后，可通过以下命令启动命令行应用：

```powershell
rigorium
```

## 仓库与许可证

Rigorium 通过 [M-24rjgc/Rigorium](https://github.com/M-24rjgc/Rigorium) 独立构建、发布和更新。许可证及必须保留的第三方声明见 [NOTICE.md](NOTICE.md)。

本项目按照 [GNU Affero General Public License v3.0](LICENSE) 发布。

English documentation: [README.md](README.md)
