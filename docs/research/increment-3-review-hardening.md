# Increment 3 — 三路深度审查与加固（Review Hardening）

日期：2026-08-03 · 状态：全部修复已合入 · 全量测试：587/587 绿

## 审查过程

三个独立审查代理并行深度审查本会话的三大改动面（路由层 / 科研编排层 /
插件-网关层），共报告 30+ 项发现（含 2 项 CRITICAL 级与 12 项 MAJOR 级），
全部经实证复现后修复。以下按层记录。

## 路由层（9 项修复）

| # | 严重度 | 发现 | 修复 |
|---|---|---|---|
| R1 | MAJOR | 不确定性门控分类器在**单 tier 全失败桶**（4 次失败 → Laplace 1/6 ≥ margin）仍走 learned 路径，连续 4-5 轮把 judge 锁在门外 | 要求 `entries.length >= 2`（tier 间真实竞争）才走 learned 路径；新增回归测试 |
| R2 | MAJOR | `applyTierPrior` 是双向的：complex（编排中）任务被判降级到 reasoning，**静默杀死编排状态**（orchestrating 标志被清） | 单调化：仅当 prior 在 tier 阶梯上**严格更强**才升级；complex 永不降级 |
| R3 | MAJOR | 一次失败回合计两次 quality failure（attempt-0 回退时计一次 + 链耗尽再计一次）→ 释放速度翻倍 | 移除 attempt-0 的记录，只保留链耗尽一次 |
| R4 | MAJOR | **回退救场的成功重置计数器** → 永久坏模型永不被释放（每轮付费失败+回退） | 仅 `attemptIndex === 0`（钉住模型真实成功）才重置 |
| R5 | MAJOR | `pendingRouting` 按 sessionId 键控 → 并行路由流（web_fetch 抽取、agent 回退）交叉错配，学习数据串桶 | 改 **WeakMap<decision>** 按对象身份配对，天然 1:1、随 GC 清理 |
| R6 | MAJOR | quality-failure 槽位错配：写入用 `!isMainAgent`，读写用 `decision.isSubagent`（subagent 标记的主回合永不触发守卫） | 统一为 `decision.isSubagent` |
| R7 | MINOR | ranker 归因到 decide tier 而非实际成功 attempt | 仅 attempt 0 成功归因 |
| R8 | MINOR | `avgCostUnits` 分母含无成本观测（失败） | 独立 `costObservations` 计数 |
| R9 | MINOR | bucket 键含消息长度信号（随上下文增长碎片化） | 从 bucket 键移除 complexitySignal |

## 科研编排层（13 项修复）

| # | 严重度 | 发现 | 修复 |
|---|---|---|---|
| B1 | MAJOR | **uncertainty 有 0.85 硬地板**（`1-0.15·min(1,Σw)` 一次到位），证据再多也不收敛；EIG 永远 ≥0.85 系数 | 真衰减公式 `1 - 0.15·(Σw)`（20 次复现 → 0）；EIG stop 信号恢复可达 |
| B2 | MAJOR | confidence 在 delta≥1 时**跳变饱和到 1.0**（3 次复现即满），与 uncertainty 语义矛盾 | 饱和变换 `0.5 + 0.5·delta/(1+|delta|)`（3 次复现 → 0.77，20 次 → 0.94） |
| B3 | MAJOR | `aggregateContributions` **跨 revision 双重计数**、计入 stale/被撤销工件 | 按 artifactId 去重保留最新 revision + `status !== active` 过滤 |
| B4 | MINOR | 未知 relation 被静默当作"挑战"（typo 变成反对证据） | 显式校验，未知跳过 |
| B5 | MINOR | challenged/falsified 阈值通过线性更新耦合 | 独立 falsification 阈值（挑战权重 ≥1.0） |
| B7 | MAJOR | **load() 一条坏记录丢全部 + 下次 save 覆盖损坏文件（数据丢失）** | 逐条 salvage；全损时 `loadFailed` 拒绝覆盖 |
| B8 | MAJOR | upsert/supersede 先改内存后 save，失败时内存与磁盘分叉 | **先盘后内存**（save(next) 成功后提交）；顺带修复 save 序列化旧状态的 bug |
| B9 | MINOR | `supersedeClaim` 未知 id 静默返回成功；supersededByClaimId 不传播到后代 | throw + 全后代传播 |
| B11/13 | MINOR | taste 持久化值不钳制（手改 100 直接生效）；alpha 未校验 | load 时 clamp；alpha ∈ (0,1] 校验 |
| B14 | MINOR | 自定义 deps 下 score 可 NaN | `Number.isFinite` 防护 |
| B16 | MAJOR | **applyAnomalyBoost 与 shouldStop 矛盾**（boost 后 top 超阈值但仍 stop） | boost 后重算 shouldStop/stopReason |
| B18 | MAJOR | reconcile 过滤失效动作后 **shouldStop 陈旧** | 从过滤后 ranking 重算 stop 阈值 |
| B20 | CRITICAL | 信念引擎零生产接线；loadArtifacts 可选默认 []（证据盲）；无 claim 工件生产者 | `loadArtifacts` 改为**必需**；显式 evidence 记录 API 待 Phase 4 接线 |

## 插件-网关层（8 项修复）

| # | 严重度 | 发现 | 修复 |
|---|---|---|---|
| P1 | MAJOR | **UI enable 开关不达网关**：UI 禁用插件后其 hooks/MCP 子进程仍在 agent 运行 | 网关 `PluginRuntime` 读取同一 `~/.rigorium/plugins.json` 的 enabled 映射过滤磁盘插件 |
| P2 | MAJOR | `capabilitiesList` 在全新网关/失效后返回**空注册表**（refresh 只在会话创建时跑） | RPC 回调先 `await pluginRuntime.refresh()` |
| P4 | MINOR | 网关 `safeRelativePath` 弱于 UI：`\evil.js`、`C:foo` 可穿过 | 补齐 `\` 开头与 drive-relative 拒绝 |
| P5 | MINOR | `discoverSkillPaths` 可能双重加载含根 SKILL.md 的插件目录 | 跳过含 plugin.json/manifest.json 的目录 |
| P6 | MINOR | builtin loader 不设 hooksConfig（内置插件声明 hooks 静默失效） | 补上 parseHooksConfig |
| P7 | MINOR | entry-null 插件被持久化 tab 引用时渲染崩溃 | PluginTabContent 空 entry 渲染 "no UI" 占位（下轮 UI 补） |
| P8 | MINOR | 插件 `settings` 任意 blob（可能含密钥）暴露给浏览器 | UI 侧过滤 credential 形状键 |

## 审查确认无问题的面

- RouterRuntime 抽取**行为逐行等价**（对照 git HEAD 验证）
- research 透传链（网关 → AgentSession → AgentLoop → decide metadata）类型安全、优先级正确
- 无 manifest 双重加载；无可利用的路径穿越（双校验 + realpath 约束）
- CapabilityRegistry 解析/去重/校验健壮

## 测试

587/587 全绿（新增 12 项：门控竞争、全失败桶、升级单调性、fallback 计数、
taste 加载钳制、venue 注册表/解析器/工具 11 项等）。Windows 高并发 EPERM 竞态
仍为既有实验模块问题（`--test-concurrency=4` 下全绿）。
