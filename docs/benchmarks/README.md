# Rigorium Benchmarks — Evidence Index

可复现的「同功能对照基准」证据集合。所有报告基于确定性种子与锁定测试，
命令均可独立复现。

## 报告

- **[验收审计](ACCEPTANCE.md)**：目标逐项核查清单（已证实/开放项 + 解锁方式）

| 域 | 报告 | 复现命令 | 锁定测试 |
|---|---|---|---|
| 路由策略 | [router-policy.md](router-policy.md) | `node scripts/benchmark-router-policy.mjs --seeds 42,43,44,45,46` | `tests/benchmark/router-policy.spec.ts`（6 用例） |
| 可靠性机制 | [reliability-comparison.md](reliability-comparison.md) | `node scripts/benchmark-circuit-breaker.mjs 200 7` | `tests/router/providerHealth.spec.ts` 等 4 个 spec（29 用例） |
| 科研编排 | [orchestration-comparison.md](orchestration-comparison.md) | 见报告内测试清单 | beliefGolden/eigProperties/orchestrator/replay/compactHooks（29 用例） |

## 核心数字（多 seed 均值 ± 标准差，5 seeds）

- **gate**：judge 调用 -82.8% ± 7.1，成功率 +3.1pp（RouteLLM 同量级：-86% 强模型调用）
- **sticky+gate**：-90.2% ± 1.8 judge 调用
- **gate+explore**：-76.5% ± 5.5，探索质量保障
- **heuristic+judge**（无 learning 部署）：-31.5% ± 10.6，零误拦截
- **熔断探测窗口**：64.3% 无谓重开削减（vs Hystrix 单探测，解析自验证）

## 复现环境

- 全部基准离线运行（无外部 API 依赖），确定性种子，机器无关。
- **端到端路由对比 harness**（`scripts/benchmark-router-e2e.mjs`）：
  - 无 key：内置 mock OpenAI 兼容端点，验证协议/解析/指标链路（锁定测试
    断言 7/7 拦截与 judge 100% 一致）
  - 有 key：`RIGORIUM_E2E_BASE_URL + RIGORIUM_E2E_API_KEY` 即跑真实端点
    对比（judge-only vs heuristic+judge 的调用数/延迟 p50/p95/一致性）
