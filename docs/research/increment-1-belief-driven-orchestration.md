# Increment 1 — 信念驱动的科研编排引擎（核心创新）

日期：2026-08-03 · 状态：核心引擎已合入 · 全量测试：559/559 绿（`--test-concurrency=4`）

## 背景与创新定位

现有自动科研系统把科研建模为流水线（六阶段法）、决策树 / agentic tree search
（AI Scientist v2）、或 DAG（工件图）。本 increment 提出并实现了第三种范式：

> **科研 = claim 图上的信念系统演化**。
> 证据工件经 DAG 的 `supports`/`challenges` 边指向主张；信念引擎把它们聚合成
> 置信度与不确定性；规划器按「期望信息增益 / 成本」选择下一步动作；失败即信念
> 修正（级联失效 → 从修正后的信念状态重规划）；异常累积触发原则演化；真实评审
> 结果在线校准平台自身的「品味」（evaluative taste）。

与 PiEvo 的关系：PiEvo 把 GP 信息定向假设选择用在**假设采样空间**；本引擎把
信息增益原则作用在 **Agent 动作空间**（跑实验/查文献/评审/写作），且以可审计的
持久化 claim 图为状态。与 tree search 的关系：树搜索无信念状态、回溯是栈弹出；
本引擎的回溯是**信念修正**（级联失效带理由链，可复现可审计）。

## 1.1 Claim 图（`src/research/claims/`）

- `types.ts`：`Claim`（主张 + 可证伪条件 + 父主张）、`EvidenceContribution`
  （证据边：来源工件、强度、supports/challenges）、`ClaimBelief`（置信度/
  不确定性/状态）、`BeliefSnapshot`。
- `beliefPropagation.ts`：**信念传播引擎**（纯函数）——
  - 强度映射：`replicated_result 0.4 > review_consensus 0.3 > observed 0.25 >
    baseline 0.2 > citation 0.1`；
  - 更新规则（单调、有界、可解释）：`confidence' = confidence + (delta>0 ?
    delta(1-c) : delta·c)`；`uncertainty' = max(0, 1 - 0.15·min(1, Σw))`；
  - 状态机：`challenged`（挑战权重 ≥0.5 且压倒支持）→ `falsified`（置信度 <0.25）；
  - `aggregateContributions`：从工件 DAG 的 supports/challenges 父边收割证据——
    **claim 图与工件图永不漂移**（证据只读自工件）。
- `ClaimGraph.ts`：项目本地持久化（`<project>/.rigorium/research/claims/claims.json`，
  原子写 + 16MiB 上限，项目隔离由路径根保证）；`supersedeClaim` 带**级联**（后代
  主张传递性失效）；`mostUncertainClaims` 供规划器取数。
- `taste.ts`：**TasteCalibrator**（见 1.4）。

设计决策：claim **不**作为新工件 kind 混入 20 种工件枚举（避免破坏既有
exhaustive 分支），而是独立领域实体，通过工件边双向关联。比计划的「新增工件
种类」更稳，已在文档中记录。

## 1.2 EIG 规划器（`src/research/director/eig/`）

- `estimate.ts`：`EIG = uncertainty × gainFactor(action) × maturityDiscount(claim)`；
  - 动作谱系：`run_experiment(0.7)` / `literature_search(0.35)` / `review(0.4)` /
    `write_section(0)` / `principle_revision(×aggregate)`；
  - `write_section` 刻意零 EIG——写作不削减不确定性、只消费证据成熟度（与手稿
    证据门控一致）；`principle_revision` 的增益 × 全局平均不确定性——科研整体
    尘埃落定时它自然失去吸引力；
  - 成本模型：默认成本表 + 工件成本模型（TokenStatsCollector 学到的观测成本）。
- `planner.ts`：`planByInformationGain` —— 按 score=EIG/cost 排序，**批量选择带
  去冗余**（每 claim 至多一个动作；不同 claim 可并行——与现有并行子代理机制
  天然对接）；**stop 是一等公民**：无动作达标时诚实输出 stop，而不是硬跑固定
  序列。

## 1.3 信念修正回溯（`eig/reconcile.ts`）

`reconcileWithBeliefs(current, previous, plan)`：
- 产出**修订账本**（哪条 claim 从何状态变为何状态、理由）；
- `backtracking` 标志：任何 active → challenged/falsified/superseded 的降级；
- 目标已失效的动作从计划中剔除 → 从**修正后的信念状态**重规划（非栈弹出）。

## 1.4 原则演化 + Taste 校准

- `eig/anomalyDetector.ts`：**异常累积检测器**——挑战证据密度 ≥0.5 且 ≥2 条
  claim 被挑战 → 异常模式；`principle_revision` 增益 ×(1+3·anomalyScore)，
  范式转移在异常主导时变得有竞争力（PiEvo 异常驱动扩充的 Agent 化）。
- `claims/taste.ts`：**evaluative taste 校准**——代理分（平台自评）vs 真实分
  （7-lane 评审聚合）的 EMA 在线回归（α=0.3，钳制 [0.5, 2.0]，冷启动 ≥3 观测
  才生效），每项目持久化 `taste.json`。平台品味随真实评审收敛（词汇表论文的
  evaluative taste 落地）。

## 测试（新增 29 项，全部通过）

- `tests/research/claims.spec.ts`（10）：信念公式、状态机、证据收割、持久化
  往返、级联 supersede、不确定性排名；
- `tests/research/eigPlanner.spec.ts`（7）：EIG 公式、成熟度折扣、成本模型、
  排序语义、批量去冗余、stop 条件、失效 claim 排除；
- `tests/research/beliefLoop.spec.ts`（12）：异常检测、异常增益提升、回溯账本、
  升级恢复、taste 校准（冷启动/学习/持久化/钳制）。

## 验收对照（计划）

- [x] 信念闭环：evidence → belief → EIG plan → reconcile（backtracking）→ replan
- [x] 回溯产生完整修订账本（claimId/from/to/reason），可审计
- [x] 原则演化：异常密度驱动 paradigm-shift 优先级
- [x] taste 校准：代理分随评审轮次收敛（EMA），每项目隔离持久化
- [ ] 三份样例课题端到端跑通（依赖 Phase 2 路由 + Phase 3 写作）→ 计划 Phase 4 自举验收

## 遗留

- EIG 增益因子与成本模型的**经验校准**（当前为先验启发式）→ 由 taste 回路学习；
- director 的 `plan-execute-reconcile` 决策词（branch/eliminate/...）与 EigPlan
  的对接（把 ranked actions 翻译成 director 计划）→ Phase 4 平台整合；
- claim 图 UI（当前为文件级持久化，无面板）→ 待 UI 阶段。

## 已知问题（既有，与本 increment 无关）

Windows 上 node:test 默认高并发时，实验模块的 `.manifest.lock` 原子锁偶发 EPERM
（三个测试轮流触发，单跑恒绿）。已用 `--test-concurrency=4` 验证全量 559/559。
建议后续为实验仓库的锁文件加 EPERM 重试（属实验模块独立问题，未列入本路线图）。
