# Increment 5 — 平台整合、自举闭环与严格验收

> 日期：2026-08-03 · 状态：完成
>
> 本增量完成 Phase 4（平台整合 + 自举闭环）的最后三块：技能生态导入、
> 自举论文的离线材料、以及 **三个并行审查代理的严格验收**。审查发现的
> 全部 CRITICAL / MAJOR 问题均已修复并有测试护航；全量回归 639/639 绿。

---

## 1. 本增量交付

### 1.1 技能生态导入机制（P4-E）
- `scripts/import-open-science-skills.mjs`：批量导入开源科研技能（synthetic-
  sciences/OpenScience、scdenney/open-science-skills 等）到
  `~/.rigorium/skills/`，带 `sourced-` 前缀、`--dry-run` 预览、跳过已导入。
- 校验规则与平台 `SkillManager` 的硬失败常量**逐项对齐**（审查后修复）：
  递归文件计数（≤500）、总量 ≤50MB、单文件 ≤10MB、SKILL.md 与 frontmatter
  强制项、符号链接警告。
- 复制改为**递归复制**，失败时清理残缺目标（此前顶层 `copyFile` 遇到子目录
  直接 EISDIR 崩溃并留下无法重导的半成品）。

### 1.2 自举材料（P4-F）— "用平台写平台论文"
- `scripts/bootstrap-framework-paper.mjs` + 生成物 `bootstrap/framework-paper/`：
  - `README.md`：项目简报 + 研究循环操作说明；
  - `paper/outline.md`：ICLR 2026 论文大纲（每节故事线 + 贡献三角 + 写作规则）；
  - `paper/claims.md`：8 条可证伪 claim 种子（c-thesis 根主张 + 机制/系统/元主张）；
  - `paper/venue-pin.md`：venue 决策记录（ICLR 2026，verified commit 钉扎）；
  - `paper/eig-plan.md`：**由真实 planner 离线计算**的首个 EIG 计划
    （零证据 → 6× literature_search，stop=false）；
  - `.rigorium/` 运行时状态（gitignore）：claims.json + venues.json，格式与
    生产读取路径逐字段一致（ClaimGraph / VenueTemplateRegistry 实测加载）。
- 生成顺序修复（审查 CRITICAL）：先落盘 claims.json 再计算计划——干净检出下
  不再产出"空 belief + should stop"的矛盾文档。

### 1.3 生产闭环接线（审查 CRITICAL 修复）
- 新增内置工具 **`research_plan`**（`src/tool/builtin/researchPlan.ts`）：
  ResearchOrchestrator 的生产入口——读 claim 图 + artifact DAG → 信念 →
  EIG 排序动作（含 anomaly boost、belief reconcile、venue/style 上下文、
  stop 建议）。全离线、零 LLM 调用；`persistSummary=true` 落盘 summary.md。
  注册进 `createBuiltinRegistry`（默认开启）。
- `src/research/director/index.ts` 补导出 Orchestrator 与整个 EIG 域
  （此前只有测试可达，属于"只有测试没有接线"的验收违例）。

### 1.4 配置面补齐（审查 CRITICAL 修复 ×2）
- `loadRigoriumConfig` 新增 **`vision` / `figureGen` 配置节解析**：
  baseUrl/apiKey/model/timeoutMs，容错（不完整 → warning 并丢弃，绝不
  fatal），apiKey 纳入 redact。此前配置被 `CONFIG_UNKNOWN_FIELD` 警告丢弃，
  导致 describe_image / figure_generate / 自动视觉富集在生产路径全部不可达。
- `parseRouterConfig` 新增 **`sticky` / `researchAware` / `learning` 三节
  解析**（含数值校验）——此前被静默丢弃，`router.learning.enabled` 恒为
  false，AmortizedRanker / UncertaintyGatedTierClassifier 在生产中根本无法
  实例化。

### 1.5 UI 插件开关贯通（审查 CRITICAL 修复）
- `PluginRuntime.readPluginEnableConfig` 统一兼容 UI 写的**嵌套形**
  （`{name: {enabled: false}}`）与旧**扁平形**（`{name: false}`）——
  此前 UI 禁用的插件在 gateway 侧恒为启用，违反"禁用即零贡献"承诺。

### 1.6 数据完整性修复（审查 MAJOR 修复）
- **claim_monitor 默认 loader 补 `parents`/`updatedAt`**：此前生产路径证据
  边丢失 → 每个 claim 恒 evidenceCount=0、状态恒 active（监控证据盲）。
- **VenueCorpus 按 venue 逐出**：收集第二个 venue 不再静默逐出第一个
  venue 的范文；逐出行为显式返回（工具输出报告 evicted）。
- **venue_template pin 合并内置 sources**：pin 后其他年份/evergreen 回退
  候选保留（此前 pin 直接重建 `[pinned]`，年份回退解析断裂）。
- **ClaimGraph**：形状损坏（能解析但结构错误）的文件同样拒绝覆盖；
  save 失败时临时文件真正清理（原为自我 rename 空操作）。
- **router learning 持久化按项目分文件**（`learning-<hash>.json`）：
  多项目共享一个 gateway 时，A 项目关机不再抹掉 B 项目的学习数据。
- **claim 证据写入边界**（审查代理遗漏、验收测试发现的新 CRITICAL）：
  artifact 仓库的 parent-ref 校验拒绝 `kind: "claim"`——证据边（supports/
  challenges）在生产中根本无法落盘指向 claim。修复：`ResearchArtifactRefKind`
  加宽为 `ResearchArtifactKind | "claim"`，`normalizeRef` 运行时放行，
  `buildResearchArtifactGraph` 将 claim 父节点视为外部图节点（不计入
  missing parents，由信念引擎在收获期对照 claim 图校验）。

### 1.7 MINOR 项
- `supersedeClaim` 校验被指向 claim 真实存在（防悬空修订链）；
- `applyAnomalyBoost` 停止阈值与调用方配置解耦（原硬编码 0.005）；
- `estimateEig` 对 gainFactors 的 NaN 防御；`computeBelief` 跳过未知 relation
  （不再默认计为挑战）；
- 路由决策日志去掉 per-decide `console.log` 噪声（已有
  `rigorium_router_decision` 事件携带完整决策）；
- `resolvedFrom: "learned"` 透传到 RouterDecision（此前统一落为
  "tokenSaver"，learned 路由不可观测）；`RouterDecisionResolution` 加宽
  judge/default/learned；
- bootstrap 脚本支持 `--project <dir>` 与 `--project=<dir>` 两种形式。

---

## 2. 验收过程

三个并行审查代理（PaperStudio/视觉/生图域、研究引擎域、路由/网关/插件域）
独立审查，只读、跑 tsc + 定向测试，按 CRITICAL/MAJOR/MINOR 报告。

### 2.1 审查发现总览（全部修复）

| 域 | CRITICAL | MAJOR | 结论 |
|---|---|---|---|
| PaperStudio/视觉/生图 | 1（vision/figureGen 配置面断裂） | 2（VenueCorpus 跨 venue 逐出、pin 破坏年份回退） | 有条件 → 修复后通过 |
| 研究引擎 | 2（Orchestrator 未接线、bootstrap 空计划） | 3（claim_monitor 丢 parents、bootstrap 未提交、ClaimGraph 损坏路径） | 有条件 → 修复后通过 |
| 路由/网关/插件 | 2（router 配置节丢弃、plugins.json 结构不匹配） | 4（无 research producer、bootstrap 空计划、import 脚本不一致、learning 互覆盖） | 有条件 → 修复后通过 |
| 验收测试新发现 | 1（claim 证据写入边界拒绝 `kind:"claim"`） | — | 修复后通过 |

### 2.2 测试

- 新增测试 21 项（tests/rigorium/config-parsing、tests/extension/plugins/
  enable-gating、tests/tool/researchPlan、claimMonitor 生产 loader、
  VenueCorpus per-venue 逐出、venue pin 合并、ClaimGraph 形状损坏 +
  supersede 校验、research 元数据端到端 ×2）；
- 全量回归：**639/639 通过**（`--test-concurrency=4`；EPERM 属 Windows
  原子 rename 并发抖动，单跑复跑确认 0 失败）。

---

## 3. 自举闭环怎么跑（下一步）

```bash
npx tsc -p tsconfig.json
node scripts/bootstrap-framework-paper.mjs   # 生成/刷新 bootstrap/framework-paper
```

然后在该项目打开平台：agent 用 `research_plan` 拿到首个计划 →
`literature_search` + `claim_monitor` 查询 → 证据经 `research_artifacts`
落盘（supports/challenges 边指向 claim）→ `venue_template`/`venue_corpus`
学习 ICLR 风格 → `research_plan` 重排（实验动作随信念成熟上升）→
`figure_generate`（配置面）出图 → 7-lane 评审 → `research_plan` 回溯
修订 → `manuscript_latex` 成稿。每个环节的工件链完整可审计。

## 4. 已知边界

- `figure_generate` / 视觉端点标注"配置面先行、待用户提供 Key 后实测"
  （与 Phase 3.4 承诺一致，不阻塞）。
- research 元数据（GatewaySubmitTurnInput.research）链路已端到端测试
  覆盖；生产侧 producer 目前是 `research_plan` 工具输出的 actionType，
  外部宿主亦可显式提交——完整的"计划 → 自动下发 turn"调度器留给自举
  论文的实际执行阶段按需落地。
