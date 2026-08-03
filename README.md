# Rigorium

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/M-24rjgc/Rigorium)](https://github.com/M-24rjgc/Rigorium/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](https://github.com/M-24rjgc/Rigorium#download)

**Personal Research Workspace** | [中文文档](./README.zh.md)

<p align="center">
  <img src="./branding/rigorium/rigorium-lockup.svg" alt="Rigorium" width="480">
</p>

> From research direction to complete paper. Research is not a dead pipeline — it's an evidence network you can fork, roll back, and redo.

---

## What Is This

Rigorium is not a chatbot, nor a reference manager. It is an **evidence-traceable, long-term research execution environment** — from literature search and idea incubation through method design, experiment execution, remote runs, LaTeX drafting, and seven-lane independent cross-review, all in a single workspace.

Key differences from existing tools:

- **Not a ChatBot** — The Agent operates on your filesystem, runs terminal commands, reads/writes code, and controls a browser. It doesn't just offer text suggestions
- **Not a reference manager** — Rigorium has a full Research Artifact DAG (directed acyclic graph). Every intermediate output is a content-addressed, immutable envelope with version hashes and provenance
- **Not a fixed workflow** — The Research Director dynamically decides what to do next based on artifact state, not a predefined stage machine

---

## Core Design

### 🧬 Research Artifact DAG

All research intermediates are persisted as **immutable Artifact envelopes**, each content-addressed via `sha256` with type, provenance, parent references, and revision number.

**18 Artifact kinds:**
evidence_pack · candidate_portfolio · method_spec · experiment_spec · run_attempt · baseline_observation · metric_observation · figure_table · citation_set · manuscript_version · render_run · review_round · finding · revision_decision · implementation_snapshot · execution_grant · challenge_report · decision_record

**Status lifecycle:**
```
active → stale       (upstream changed or revision decision received)
active → superseded  (auto-superseded when a new revision is appended)
active → rejected
active → archived
```

When an upstream Artifact changes, the **invalidation engine** automatically BFS-walks the dependency graph, marking all downstream artifacts as `stale` — you know exactly which conclusions need revisiting without starting from scratch.

Data lives in each project's `.rigorium/research/artifacts/manifest.json`, with file locking + atomic writes. Maximum repository size: 64 MiB.

### 🎯 Research Director

The Director is not a fixed stage machine. It is a **capability-dependency planning engine** that reads current goals, existing artifacts, budget, and permissions, then outputs parallel-ready action batches.

**Operating modes:**
- `advance` — No stale artifacts; drive the project forward
- `repair` — Stale artifacts or unresolved findings exist; initiate repair

**6 decision outcomes:**
| Decision | Meaning |
|---|---|
| `branch` | New candidate direction detected, fork exploration |
| `eliminate` | Direction not viable, eliminate |
| `rescan` | Insufficient evidence, re-scan |
| `revise` | Existing output needs revision |
| `recover` | Recoverable failure, retry |
| `stop` | Objective satisfied or cancelled |

**Confirmation boundaries** (require explicit user approval):
`zotero_write` · `export` · `snapshot` · `final_title` · `budget_auto`

### 🤖 Agent Execution Engine

Rigorium's Agent is not a thin API wrapper. It has a full execution cycle (`AgentLoop`) with production-grade resilience built in:

**Multi-phase error recovery:**
- **Auto token doubling**: Output truncated? One-shot automatic retry with doubled tokens
- **Continuation recovery**: Up to 50 continuation prompts to resume from where the model was cut off
- **JSON self-correction**: Up to 3 automatic retries for invalid JSON tool arguments
- **Empty response recovery**: When the model produces thinking-only output (no visible text), auto-prompt with retry instructions
- **Large file repair**: Detects truncated `write_file`/`edit_file` calls and injects structured recovery prompts
- **Circuit breaker**: Same tool fails identically 3 times in a row? One grace prompt, then loop termination

**Transparent synthetic prompts:**
Recovery prompts carry `synthetic: true` + `transient: true` metadata and are automatically removed from the transcript once resolved.

**Sub-Agent system (4 presets):**
| Type | Allowed Tools | Read-Only | Description |
|---|---|---|---|
| `general-purpose` | All | No | General delegated tasks |
| `explore` | read, grep, glob, bash | Yes | Code/file exploration |
| `plan` | read, grep, glob | Yes | Planning only, no execution |
| `verify` | read, grep, glob, bash | Yes | Verify generated output |

Sub-agents run in isolated sessions with only the delegated directive in context. Output must follow a 5-field structured report (`Scope / Result / Key files / Files changed / Issues`).

### 🧠 Intelligent Model Router

Not just calling an API. Rigorium ships a full routing engine (`RouterRuntime`) with:

- **Scenario-based routing**: Auto-select models by task type
- **Token Saver**: Cheap models for simple tasks, powerful models for complex ones
- **Cache-aware switching**: Weighs the cost of re-prefilling vs. continuing with cached context
- **Fallback chains**: Cross-provider fallback on failure
- **Zero-usage retry**: Detects zero-token responses and retries
- **Session affinity**: Keeps the same model for cache continuity
- **Custom routers**: Register routing strategies via the extension system
- **Usage analytics**: Per-project, per-model, per-tier token and cost tracking

**Supported model providers:** Anthropic (Claude), OpenAI, Google (Gemini), OpenAI-Responses.

### 📦 Three-Tier Context Compaction

Long conversations demand smart context management. Rigorium implements three escalating compression tiers:

1. **Micro** — Time-based pruning of old tool_result content
2. **Snip** — Remove middle turns, keeping head + tail with a `<snip-boundary>` marker
3. **Full** — Model-based summarization of early conversation into structured Markdown

**Thresholds:** Auto-triggered at 80% (warning) or 95% (blocking) of context budget. A post-routing re-evaluation adapts to the selected model's window size.

**Large result offloading:** `ToolResultBudget` automatically persists tool results > 200KB to disk, replacing them with reference placeholders in-context.

### 🔌 Tool System

30+ built-in tools covering the full Agent execution surface:

**General tools (partial list):**
`read_file` · `write_file` · `edit_file` · `bash` · `grep` · `glob` · `web_fetch` · `web_search` · `agent` · `ask_user_question` · `structured_output` · `todo_write` · `plan_file` · `plan_mode` · `read_skill` · `get_current_time` · `send_attachment` · `title_confirm` · `mcp_tool` · `mcp_resources` · `task_tools`

**Research-specific tools:**
`literature_search` · `literature_deep_search` · `literature_expand` · `literature_maintenance` · `literature_closeout` · `research_artifacts` · `research_director` · `research_design` · `research_design_brief` · `research_method` · `research_review` · `direction_assess` · `direction_seed` · `direction_lifecycle` · `experiment_remote` · `experiment_control` · `experiment_analysis` · `manuscript_latex`

All tool calls are audited. Execution is governed by three permission tiers (preview / approve / auto).

### 🔐 Permission & Security

- **Three permission tiers:** `default` (confirm before risky ops), `plan` (read-only), `bypassPermissions` (full trust)
- **Confirmation boundaries:** Zotero writes, file exports, budget changes require explicit authorization
- **Lifecycle hooks:** `PreModelRequest`, `Stop`, `StopFailure` events can inject security checks
- **Project isolation:** Each project has its own Artifact repository, memory, sessions, and configuration

---

## Research Workflow

### 📚 Multi-Source Literature Search

Search **arXiv**, **OpenAlex**, **Crossref**, and **OpenReview** simultaneously:

- **arXiv** — Official API, 3-second minimum interval, defensive ATOM XML parsing
- **OpenAlex** — Configurable endpoint, pagination, retry, rate limiting
- **Crossref** — Cursor-based pagination, polite pool support
- **OpenReview** — Only queries with official venue IDs; no unconstrained search

**Deduplication:** **Reciprocal-rank fusion (RRF, K=60)**. Strong identifiers (DOI, arXiv ID) take precedence. A strict weak matcher requires exact normalized title + same year + same first author when no strong identifier exists.

**Literature map:** Live paper relationship graph with identity resolution (multi-source ID merging), status transitions (`candidate → relevant → core → irrelevant`), and diff computation.

**Evidence Pack:** Content snapshots with precise locators (source, page, paragraph, character range) and content hashes. Max 256 entries, 2 MB per entry.

**Novelty re-scan:** Periodically re-assess candidate directions against new literature, scoring novelty (`gap_signal / crowded / not_established`) and value (`promising / mixed / weak`).

### 🧪 Experiment & Remote Execution

Three execution backends (`local` / `ssh` / `slurm`):

- **Local Worker:** Isolated workspace, input JSON, stdout/stderr capture, forced timeout
- **SSH:** OpenSSH transport, strict known-host verification, remote agent lifecycle
- **Slurm:** Slurm submission args, queue and accounting parsing

**Authorization modes:** `plan_only` · `confirm_each` · `budget_auto`

**Budget tracking:** Wall-time and USD cost with reservations and settlements. Hard budget ceilings. Kahan summation for precision.

**Analysis capabilities:**
- Student's t-test (95% CI)
- Hedges' g effect size (small-sample correction)
- Pareto front computation
- Multi-objective linear scalarization
- Early-stop policies

### 📝 LaTeX Manuscript Pipeline

A complete LaTeX writing workflow:

- **Citation sets:** Generated from Zotero items or BibTeX, collision detection, back-linked to source records
- **Section audit:** Validates all citations resolve in the citation set, all figure/table refs have matching artifacts
- **Related work planning:** Auto-organized from literature maps and evidence packs
- **Template probing:** ICLR 2026 support with commit-pinned SHA256 verification
- **Multi-engine rendering:** `latexmk` / `tectonic` / `pdflatex` / `xelatex` / `lualatex`, auto-detect available engines
- **Compilation diagnostics:** Errors, warnings, and info with file + line numbers
- **Compliance checks:** Compilation, anonymity, page limit, citation completeness, appendix, template conformance

### 🔍 Seven-Lane Independent Review

After drafting, Rigorium runs **seven independent review lanes**:

1. **method** — Methodology
2. **theory** — Theoretical framework
3. **statistics** — Statistical methods
4. **evidence** — Evidence sufficiency
5. **novelty** — Novelty assessment
6. **writing** — Writing quality
7. **target_fit** — Target venue alignment

**Preflight:** Purely deterministic, no AI involved —
1. Successful render with PDF output
2. Citation completeness (every in-text citation resolves)
3. Page limit compliance
4. Anonymity check (no identity leaks in anonymous mode)
5. Figure/table provenance (every figure has a matching run record)

**Revision decisions:** Every review finding must be resolved —
`revise` (triggers cascade invalidation) | `dismiss` | `defer`

---

## Architecture Overview

<p align="center">
  <img src="./output/imagegen/rigorium-features-architecture.png" alt="Rigorium Features & Architecture" width="100%">
</p>

### Communication Layer

20+ external channels, all sharing the same Agent runtime:

Feishu · WeChat · QQ · WeCom · DingTalk · Discord · Slack · Telegram · Signal · WhatsApp · Matrix · Mattermost · Email · SMS · Home Assistant · Webhook · CLI · TUI · Web API

Each adapter implements the same `ChannelAdapter` interface — inbound messages map chat IDs to session keys, outbound responses stream through the gateway with channel-specific rendering and message chunking (Slack: 39K, Discord: 2K, Telegram: 4K, etc.).

### Projects & Sessions

- Each project has its own workspace, config, Artifact repository, memory space, and MCP server config
- **Session forking:** Branch a new conversation from any prior message
- Auto-generated session titles
- Idle sessions auto-reclaimed (default 30 min)
- Session state persists across restarts

### Desktop App (Electron)

- Child process management: Gateway (port 18789) + UI Server, auto start/stop
- Zotero secure credentials: OS-level encrypted storage via `safeStorage`
- Zotero Broker: Local HTTP proxy with ephemeral token auth
- Startup research module verification (arXiv, OpenAlex, terminology pipeline) against fixture data
- Auto-update: Checks GitHub Releases, verifies SHA-256 integrity
- Logging: `desktop.log` in user data directory

### Local Memory System

A file-based, multi-tier memory architecture:

- **User memory** (global scope): Identity background, preferences, constraints — stored as markdown with YAML frontmatter
- **Project memory** (project scope): Current stage, decisions, blockers, next steps — stored per-project
- **Feedback memory** (project scope): Rules, rationale, how-to-apply guidance
- **L0 sessions** (raw episodic): Conversation turns stored in SQLite

**Indexing pipeline (Heartbeat):** Runs every 30 minutes or when 20+ turns accumulate. The LLM classifies each turn, extracts structured memory candidates, and persists them to markdown files.

**Consolidation (Dream):** Runs every 60 minutes. Clusters, deduplicates, resolves conflicts, and rewrites user profile. Supports snapshot + rollback.

---

## Download & Install

### Windows Desktop App

Download from [GitHub Releases](https://github.com/M-24rjgc/Rigorium/releases/latest) (current v0.2.1, ~142 MB). Built-in auto-update with SHA-256 verification.

### macOS Desktop App

Download the DMG for your Mac from [GitHub Releases](https://github.com/M-24rjgc/Rigorium/releases/latest):

- Apple Silicon (M-series): `Rigorium-Setup-<version>-mac-arm64.dmg`
- Intel: `Rigorium-Setup-<version>-mac-x64.dmg`

Open the DMG and drag Rigorium into Applications. The desktop updater selects the matching architecture and verifies its SHA-256 checksum before opening an update installer.

### Docker

```bash
docker compose up -d
```

Gateway on port 18789, Web UI on port 3001. See [Docker Guide](./README_DOCKER.md) for details.

### From Source

Requirements: Node.js `>=22.13.0 <23`, pnpm `10.32.1`

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

After a production build:

```powershell
rigorium
```

See [Source Install Guide](./README_SOURCE_INSTALL.md) for details.

---

## Current Status

v0.2.1 · Early development

**Shipped:**
- Full Agent execution loop (multi-phase recovery, circuit breaker, transparent synthetic prompts)
- 4 sub-agent presets (general-purpose / explore / plan / verify)
- Intelligent model router (scenario routing / Token Saver / fallback chains / cache-aware switching, health tracking)
- Three-tier context compaction (Micro / Snip / Full) with ToolResultBudget
- 30+ built-in tools + research-specific tool suite
- Multi-source literature search (arXiv / OpenAlex / Crossref / OpenReview)
- Research Artifact DAG (18 types, content-addressed, invalidation propagation)
- Research Director (6 decision types, capability-dependency planning)
- Remote experiment execution (local / SSH / Slurm, 3 authorization modes)
- LaTeX manuscript pipeline (citations / rendering / compliance checks)
- Seven-lane independent review + preflight + revision decisions
- 20+ communication channel adapters
- Bilingual Web UI (Chinese/English) + Electron desktop + auto-update
- Cron scheduling + Always-On autonomous execution
- Local file-based memory (MEMORY.md / user profile / project memory)
- Dashboard (cost tracking / usage analytics)
- Plugin system + 30+ bundled skills + MCP protocol extension

**Building:**
- Literature evidence packs and automated surveys
- Experiment analysis pipeline (statistical tests / optimization / failure analysis)
- Research direction lifecycle management
- Research method formalization

---

## Repository & License

Rigorium is independently built, released, and updated at [M-24rjgc/Rigorium](https://github.com/M-24rjgc/Rigorium). This project is derived from [OpenBMB/PilotDeck](https://github.com/OpenBMB/PilotDeck) and distributed under the [GNU Affero General Public License v3.0](LICENSE). For full attribution and third-party notices, see [NOTICE.md](NOTICE.md).

---

<p align="center">
  <sub>LOCAL-FIRST · PROJECT-ISOLATED · EVIDENCE-TRACEABLE · PERMISSION-AWARE</sub>
</p>
