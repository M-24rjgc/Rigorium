# Rigorium

**Personal research workspace**

Rigorium is a local-first workspace for long-term research work. It keeps projects, files, agent sessions, tasks, memory, tools, and automation together so research activity remains inspectable and reusable over time.

This initial version establishes the independent Rigorium name and visual identity while preserving the existing runtime behavior. Research-specific workflows will be added incrementally on top of the shared workspace foundation.

## Current Capabilities

- Workspace-based project and session management
- AI agent chat with files, terminal, and code tools
- Git inspection and repository operations
- Tasks, plans, cron jobs, and always-on automation
- Local memory, skills, plugins, and MCP integrations
- Configurable model providers and routing
- Web UI with Chinese and English localization
- External communication channels supported by the existing runtime

## Research Direction

Rigorium is intended to become a durable personal research environment rather than a single-purpose literature or writing tool. The current general workspace capabilities remain available; future research modules can add questions, evidence, experiments, provenance, writing, review, and reproducibility without duplicating the shared execution foundation.

## Development

Requirements:

- Node.js `>=22.13.0 <23`
- pnpm `10.32.1`

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

After a production build, both command names are available during the compatibility period:

```powershell
rigorium
pilotdeck
```

Internal paths such as `~/.pilotdeck`, `pilotdeck.yaml`, and `PILOTDECK_*` environment variables are intentionally retained in this first version so existing integrations continue to work.

## Origin And License

Rigorium is based on [OpenBMB/PilotDeck](https://github.com/OpenBMB/PilotDeck), upstream commit `15cb4c2de37f5efd8d2f97feea4e40ab787f3cf3`.

The project is distributed under the [GNU Affero General Public License v3.0](LICENSE). See [NOTICE.md](NOTICE.md) for modification and attribution details.

Chinese documentation: [README.zh.md](README.zh.md)
