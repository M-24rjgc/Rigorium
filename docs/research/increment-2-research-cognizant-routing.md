# Increment 2 — 科研感知路由（Research-Cognizant Routing）

日期：2026-08-03 · 状态：核心已合入（2.1 + 2.2）· 全量测试：574/574 绿

## 背景

路由系统的三个已知弱点：① judge LLM 每轮一次 5-15s 往返；② 先选模型、媒体不
匹配再事后换（滞后路径）；③ 分类与科研上下文完全脱节（一个检索任务因首条消息
很短被钉在 simple 档）。本 increment 让路由**感知科研**：能力需求前置推导、
摊销学习、不确定性门控、EIG 动作类型参与分档。

## 2.1 确定性能力需求推导（`src/router/policy/capabilityRequirements.ts`）

- `computeCapabilityRequirements(request, research?)`：一次推导出请求的全部能力
  需求——输入模态（复用 `collectRequiredInputModalities`）、工具类别
  （search/orchestration/analysis/content_generation/filesystem 模式表）、
  编排需求（agent 工具）、复杂度信号（工具类别数 ≥4 或文本 >12k 字符）、
  科研上下文（`metadata.research = { artifactKinds, actionType }`）。
- `tierPriorForRequirements`：需求 → 建议 tier 列表——
  - `agent` 工具 / `principle_revision` → complex；
  - search/analysis 工具、`run_experiment`/`review`/`literature_search` 动作、
    复杂度信号、`write_section`/写作工具 → reasoning。
- `applyTierPrior`：分类结果不在建议集时升级到第一个已知的建议 tier
  （**research-aware tier upgrade**，仅升级不降级）。
- 配置 `router.researchAware = { enabled, tierUpgrade }`，默认关闭（行为不变）。

## 2.2 摊销学习排序 + 不确定性门控 judge（`src/router/learning/`）

- `AmortizedRanker`：**每项目**（每个 project runtime 一个 router 实例 = 天然
  项目隔离）的能力签名桶统计——`bucketKey(requirements)` 稳定哈希（工具类别 ×
  模态 × 编排 × 复杂度 × actionType × artifactKinds）；Laplace 平滑成功率、
  每 tier 观测数、平均成本。
- `UncertaintyGatedTierClassifier implements TierClassifier`：
  - 桶内观测 ≥ `minObservations`（默认 4）且 top tier 领先 margin ≥
    `minMargin`（默认 0.15）→ 直接采用 learned 决策（**跳过 judge**，
    resolvedFrom: "learned"）；
  - 冷启动/新任务形态/低置信 → 回退 judge（行为不变）。
- **闭环**：`decide()` 计算 requirements → 存桶；`execute()` 成功/总失败时
  `observe(bucket, tier, outcome, costUnits≈tokens/1000)` 回喂排序器——
  重复的任务形态（科研平台的主旋律）随使用自动变快变准。
- 配置 `router.learning = { enabled, minObservations, minMargin }`，默认关闭；
  `createLocalGateway` 在启用时构造 gated classifier + ranker 注入。

## 2.3/2.4 一体化通道（已接线）

- **全链路接线完成**：`GatewaySubmitTurnInput.research` → InProcessGateway →
  `AgentSubmitOptions.researchContext`（或 `metadata.research`）→ AgentSession
  （`parseResearchHint` 宽松解析）→ TurnRunner → AgentLoopInput →
  `decide()` 的 `metadata.research` → `tierPriorForRequirements`。
  研究 director 派发 EIG 动作时只需在网关提交时带上 `research` 字段，
  路由就会按动作类型（run_experiment→reasoning / principle_revision→complex
  / write_section→reasoning）选择档位。
- 路由成本观测（`observeRoutingOutcome` 的 costUnits）与 taste 校准回路
  （Phase 1.4）共享同一学习哲学：观测驱动、可解释、每项目隔离。
- 级联质量估计（弱模型先出、低质升级）→ Phase 4 与 taste 校准合并实现。

## 测试（新增 16 项）

- `tests/router/researchAwareRouting.spec.ts`（11）：工具分类、需求推导、
  tier 先验、applyTierPrior 语义、桶稳定性、Laplace 评分、门控分类器
  （冷启动→judge / 高置信→learned / 低 margin→judge）；
- `tests/router/researchAwareIntegration.spec.ts`（4）：decide→execute 全链路
  （simple→reasoning 升级 + mutation、充分分类不动、成功/失败观察回喂 ranker）。

## 验收对照（计划）

- [x] judge 调用率下降：高置信桶跳过 judge（测试验证 learned 路径零 judge 调用）
- [x] 路由决策事件含能力需求依据（`researchAwareTierUpgraded` mutation）
- [x] 失败回退路径有测试覆盖（失败观察 + sticky 质量信号，Phase 0.3 已有）
- [x] 默认关闭、行为不变（全量 574 绿）
- [ ] 真实统计对比（judge 调用率 ≥50% 下降）→ 需长期运行数据，Phase 4 评估

## 遗留

- ranker 持久化（当前每实例内存，重启即失）→ 可序列化到 `~/.rigorium/router/`；
- research director 端到端派发（EIG 计划 → 网关 research 字段 → 路由）→ Phase 4
  平台整合（自举论文时首次真实运行）。
