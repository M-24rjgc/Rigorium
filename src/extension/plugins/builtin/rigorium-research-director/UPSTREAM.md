# Research Director upstream record

Verified on 2026-07-25. Upstream heads, releases, binaries, and license terms can change; refresh this record before copying code, redistributing a binary, or changing the execution boundary.

## Adopted mechanisms

| Candidate | Verified pin | License | Adopted boundary |
| --- | --- | --- | --- |
| [OpenScience](https://github.com/synthetic-sciences/openscience) | commit `083ef91ac29e7083c01aa97ae7db835dc87a6e94`; release `v1.3.4` Windows x64 archive SHA-256 `9379b2e26432977819da05200e008f09b289f827068fd10e8e1cb32b2e96f407` | Apache-2.0 | Its TaskTool demonstrates permission-before-task execution, cancellation propagation, isolated task context, and structured completion receipts. Rigorium adopts those contract ideas, not OpenScience's child sessions or another AgentLoop. |
| [LangGraphJS](https://github.com/langchain-ai/langgraphjs) | commit `07ba620415532c3d9935ff8946bda3685412444a` | MIT | Pregel/BSP-style ready sets, dependency-safe parallel work, deterministic merge points, and checkpoint-shaped records inform the planner. No package or runtime dependency is added. |
| [Temporal TypeScript SDK](https://github.com/temporalio/sdk-typescript) | commit `bf386923048c03158922fa6af36a87364f5da2b1` | MIT | Cancellation must propagate, and recovery must be driven by recorded failure semantics rather than blind resubmission. No Temporal worker, server, or workflow runtime is introduced. |

The hash-verified OpenScience Windows executable reported version `1.3.4`; `--help` exposed its ACP server, MCP tool management, agent, session, sandbox, export/import, and project commands. The probe ran from a unique system temporary directory and did not install or register OpenScience.

## Excluded control planes

| Candidate | License | Decision |
| --- | --- | --- |
| [Dagu](https://github.com/dagu-org/dagu) | GPL-3.0 | Excluded. Embedding it would add a second workflow control plane and creates an unsuitable redistribution boundary for this increment. |

## Rigorium ownership boundary

The Director is a pure plan-and-reconcile module. It reads the research goal, artifact DAG, findings, budget, permission snapshot, explicit approvals, and capability availability. It emits auditable actions and structured decisions. Existing Rigorium AgentLoop, ToolRuntime, permission checks, and concurrent scheduler remain the only execution path.

No upstream source or binary is vendored. The local implementation uses only existing project and Node.js facilities and records stable canonical hashes for plans and decisions.
