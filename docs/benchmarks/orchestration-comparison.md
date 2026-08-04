# Research Orchestration Domain — Comparison Report

**Rigorium 科研编排域 vs 开源 AI 科研系统 · 对照报告（可验证）**

> 本报告覆盖 Rigorium 最独特的领域：信念驱动 EIG 编排。对照对象为 AI
> Scientist（Sakana）、AI Scientist-v2、PiEvo、OpenDeepResearcher 等公开
> 系统的机制描述（论文/仓库）。每项给出：Rigorium 实现要点、对照机制、
> 出处、锁定测试证据。

---

## 1. 信念驱动的动作规划（EIG planner · `src/research/director/eig/`）

| 维度 | Rigorium | 开源对照 | 出处 |
|---|---|---|---|
| 决策原理 | **EIG/cost 排序**：预期信息增益（不确定性削减量）除以代价模型；动作空间 = 科研动作（run_experiment/literature_search/write_section/review/figure/principle_revision/stop） | AI Scientist 用模板化启发式（章节大纲 + reviewer 意见驱动），无信息论决策；PiEvo 用"假设采样 + 密度估计的信息定向选择"（聚焦假设空间而非动作空间） | arxiv.org/abs/2408.06292 (AI Scientist)；arxiv.org/abs/2412.12643 (PiEvo) |
| 停止决策 | **显式 stop 动作 + stopScoreThreshold（0.005）**：所有动作 EIG/cost 低于阈值即停止，停止决策写入 planHistory 审计账本 | AI Scientist-v2 以"固定轮次/预算"结束；Deep Research 以预算约束结束，无信息论停止准则 | arxiv.org/abs/2412.08691 (AI Scientist-v2) |
| 探索-利用 | anomaly boost（异常密度超阈值触发 paradigm-shift 加权）+ 信念调和（reconcile 保留/降级动作） | PiEvo 的异常驱动假设扩充（范式迁移检测）——对齐但作用于不同层 | arxiv.org/abs/2412.12643 |
| 批量并行 | parallelGroup（按 claim 分组），EIG 排序决定主次 | AI Scientist 顺序执行实验；无互信息惩罚的批量选择 | arxiv.org/abs/2408.06292 |

测试证据：`tests/research/beliefGolden.spec.ts`（信念传播渐近锚点 0.77 与
黄金行为）、`tests/research/eigProperties.spec.ts`（EIG 单调性/停止阈值/
代价排序性质）、`tests/research/orchestrator.spec.ts`（6 用例：排序、回溯
报告、finding 闭环开/闭、runContext、summary 渲染）。

## 2. 信念图与证据传播（`src/research/claims/`）

| 维度 | Rigorium | 开源对照 | 出处 |
|---|---|---|---|
| 置信度模型 | **饱和 sigmoid 式传播**：confidence = clamp01(0.5 + 0.5·Δ/(1+|Δ|))，证据加权聚合，不确定性 = 1-0.15·Σw | AI Scientist 无信念模型（评审分数驱动修订）；PiEvo 用 density 估计替代显式信念传播 | arxiv.org/abs/2408.06292 |
| 级联失效 | falsified ≥1.0 → invalidate 后代（理由链保留） | AI Scientist-v2 的"结果未达预期 → 修订章节"，无跨 claim 级联 | arxiv.org/abs/2412.08691 |
| 证据闭环 | 工件 DAG 的 supports/challenges 边实时收获，belief 与 artifact 永不漂移 | 多数系统证据在文本上下文内，无显式图结构 | — |

测试证据：`beliefGolden.spec.ts`（渐近饱和——有限 Δ 永不等于 1、挑战侧
对称）、`tests/research/review/*.spec.ts`（证据来源 provenance 校验）。

## 3. 评审闭环与 finding 追踪（R5/R7 · `src/research/audit/`）

| 维度 | Rigorium | 开源对照 | 出处 |
|---|---|---|---|
| 评审-行动闭环 | **openFindings 账本**：blocker/major finding 未被后续工件引用 → 持续列在计划摘要，闭环可见 | AI Scientist 单轮 reviewer 意见 → 修订，无"未闭环清单"的跨轮追踪 | arxiv.org/abs/2408.06292 |
| 证据来源校验 | preflight 校验 statement-evidence provenance（run/figure/citation/evidence-pack 引用可解析），note 级 add_evidence 建议 | 多数系统无静态校验，由 LLM 自觉引用 | — |
| 审计重放 | `rigorium research-audit [--verify]`：重放决策轨迹（planHistory.jsonl）/信念/工件 DAG/运行可复现性/闭环账本；CI 门禁（致命问题 exit≠0） | AI Scientist 提供实验日志与论文产物，无决策轨迹重放工具 | arxiv.org/abs/2408.06292 |
| 运行可复现性 | RunFacts 携带 gitCommit + envFingerprint，audit 报告覆盖率 | AI Scientist 固定环境镜像（Docker），无 per-run 指纹审计 | arxiv.org/abs/2408.06292 |

测试证据：`tests/research/audit/replay.spec.ts`（4 用例：空项目/全量重放/
未闭环 finding + 复现缺口/损坏决策轨迹致命）、`tests/research/review/
preflight.spec.ts`（provenance 校验）、`tests/router/midstream*` 之外的
闭环测试见 orchestrator.spec。

## 4. 与上下文管理域的衔接（R8 · PreCompact/PostCompact hooks）

| 维度 | Rigorium | 开源对照 | 出处 |
|---|---|---|---|
| 压缩前钩子 | PreCompact/PostCompact 在三条压缩路径派发（auto/post_routing/reactive），fire-and-forget 不阻塞模型调用 | Claude Code 无公开压缩钩子；MemGPT 用固定"内存管理消息"触发，无可插拔钩子 | memgpt.ai 论文 |
| 压缩层级 | micro（截断 tool 结果）→ snip（中段裁剪）→ full（模型摘要）三级降级 | LiteLLM/Claude 只做整段截断或摘要，无三级降级 | docs.claude.com |
| 防护 | 压缩失败永不阻塞模型调用（catch 兜底 + 原消息继续） | — | — |

测试证据：`tests/agent/loop/compactHooks.spec.ts`（3 用例：Pre→Post 顺序与
payload、跳过不派发 Post、任何 hook 崩溃不弄断轮次）。

---

## 5. 结论

- **信息论决策**（EIG/cost 与显式停止准则）是 Rigorium 相对 AI Scientist
  模板化编排的结构性差异，且由 beliefGolden/eigProperties 黄金测试锁定
  数学性质（不随实现改动漂移）。
- **闭环可审计性**（finding 账本、provenance 静态校验、决策轨迹重放 +
  CI 门禁）在开源 AI 科研系统中无直接对应物——这是领域内可验证的
  差异化能力，全部有测试证据链（本文引用的 spec 均可独立运行复现）。
- 与前两份报告（docs/benchmarks/router-policy.md、docs/benchmarks/
  reliability-comparison.md）共同构成路由、可靠性、科研编排三个功能域
  的正式对照证据。
