# Increment 0 — 基础加固：路由、能力注册表、单文件拆分

日期：2026-08-03 · 状态：已合入 · 全量测试：530/530 绿

## 背景

Phase 0 是「自进化科研平台」路线图的地基层，目标是不改变任何外部行为的前提下，
把后续创新（信念驱动编排、科研感知路由、论文工坊）要站立的土地夯实。三件事：

1. **路由机制加固**（0.3）——修复审查发现的四个真实缺陷；
2. **统一能力注册表**（0.2）——把互不相通的双插件系统收敛到一份 manifest、一个注册表；
3. **单文件巨兽拆分**（0.1）——AgentLoop 3267 行、RouterRuntime 1400 行拆成内聚模块。

## 0.3 路由加固（behavior-preserving + 新能力）

### 0.3a 全局 ProviderHealthTracker（`src/router/`）

- **问题**：`ProviderHealthTracker` 按 session 实例化。provider 故障是 provider 级事实，
  却要每个会话各自重新发现（审计弱点评 #3）。
- **改动**：`RouterRuntimeDeps.healthTracker?` 可选注入；`ProjectRuntimeRegistry` 持有一个
  `sharedHealthTracker` 传给所有项目运行时的 router（`createLocalGateway.ts`）。未注入时
  保留 per-session 行为（兼容）。
- **附带修复**：`sharedSessionStore` 此前声明但从未传给 `createRouterRuntime`，粘性状态在
  配置热重载时会丢失——现已接上。

### 0.3b Sticky TTL + 质量信号退化释放（`src/router/policy/stickyGuard.ts`）

- **问题**：sticky 命中后同一模型可能被无限期钉住（审计弱点评 #4），且没有质量反馈。
- **改动**：
  - 新配置 `router.sticky = { enabled, ttlMs(默认30min), maxQualityFailures(默认2) }`；
  - `decide()` 中 sticky 只在「新鲜（updatedAt+ttl 未过期）且未达质量失败阈值」时命中，
    否则重新 judge；
  - `execute()` 在**总失败**（回退链耗尽）与**首选模型确定性错误触发回退**时
    记 `qualityFailures`；成功回合清零；
  - 计数跟随模型：同一模型续钉时保留计数，换模型清零（`SessionRoutingState.qualityFailures`）。

### 0.3c TierClassifier 接口（`src/router/tokenSaver/tierClassifier.ts`）

- `TierClassifier.classify(input)` 策略接口 + `JudgeTierClassifier`（行为不变的 judge 封装）。
- `RouterRuntimeDeps.tierClassifier?` 注入点已就绪——Phase 2 的不确定性门控 judge 在此替换。

## 0.2 统一能力注册表（Capability Registry）

### 现状问题

两个插件系统：UI 进程插件（`ui/server/utils/plugin-loader.js`，manifest.json +
entry/server）与网关数据插件（`src/extension/plugins/`，plugin.json + skills/hooks），
manifest 不同、发现目录却相同（`~/.rigorium/plugins/`），互不识别；marketplace 是 stub。

### 改动

1. **统一 manifest v2**（`src/extension/plugins/protocol/manifest.ts`）：一份 schema 同时承载
   UI 字段（displayName/entry/server/slot/permissions）与网关字段（skills/hooks/commands/
   settings.capabilities），双向可选。
2. **双文件名发现**：网关侧 `plugin.json` → `manifest.json` 回退；UI 侧 `manifest.json` →
   `plugin.json` 回退。同一个安装目录，两个系统都能发现。
3. **UI 校验放宽**：仅 `name` 必填；`entry`/`server` 存在才校验；纯网关插件
   （无 entry）不渲染 tab（`useAppTabs` 按 `hasUi` 过滤）。
4. **CapabilityRegistry**（`src/extension/capabilities/`）：
   - `RigoriumCapability` 契约：`{id, accepts, produces, dependsOnCapabilityIds,
     modalityRequirements, concurrencySafe, estimatedCostUnits, estimatedDurationMs, ...}`——
     与 director 的 `ResearchDirectorCapability` 字段对齐；
   - 解析：`settings.capabilities` 兼容字符串数组（legacy）与契约对象数组；
   - 校验：悬空依赖检测（`validateDependencies()`）；
   - 网关 RPC `capability_list`（InProcess/Remote/WS 全链路），UI 可枚举；
   - `PluginRuntime.refresh()` 时重建注册表，内置 6 个科研插件的 50+ 能力已全部提取成功。
5. **gateway 侧加载 UI 插件**：UI 安装的插件现在同时贡献 skills/hooks/capabilities 给 agent。

## 0.1 单文件拆分（纯抽取，行为不变）

### RouterRuntime.ts：1400 → ~1100 行

| 新模块 | 内容 |
|---|---|
| `execution/abortable.ts` | abort 感知延时 |
| `execution/attemptPlanning.ts` | attempt 计划排序、maxOutputTokens 钳制、媒体降级 |
| `execution/errors.ts` | 错误分类/构造、重试延迟、协议解析 |
| `execution/streamAttempt.ts` | 流式 attempt + outcome 哨兵 |
| `policy/stickyGuard.ts` | sticky TTL + 质量失败守卫 |
| `policy/cacheAwareSwitching.ts` | 缓存感知切换成本比较 |
| `policy/mediaCapability.ts` | 媒体能力检查 + 媒体重路由 |

### AgentLoop.ts：3267 → ~2350 行（约 -28%）

| 新模块 | 内容 |
|---|---|
| `recovery/constants.ts` | 熔断/心跳/输出预算常量 |
| `recovery/messages.ts` | 消息规范化、截断、图片剥离、transient 清理 |
| `recovery/toolFailures.ts` | 失败指纹、重复失败检测/标注、权限拒绝收集 |
| `recovery/status.ts` | 全部 20+ 状态构造器 + 模型错误分类（含 i18n） |
| `recovery/usage.ts` | usage 合并、token 计算、AbortSignal 组合 |
| `assembly.ts` | 工具 schema 转换、生命周期块查找、状态克隆、权限模式 |

## 测试

- 新增 `tests/router/stickyHealth.spec.ts`（5）：共享健康跟踪跨实例传播、sticky TTL、
  质量失败释放、成功重置、跨 provider 跳过；
- 新增 `tests/router/policyUnits.spec.ts`（10）：stickyGuard/cacheAware/attemptPlanning/errors；
- 新增 `tests/extension/capabilities.spec.ts`（6）：manifest 解析（字符串/对象/非法输入）、
  注册表查询、依赖校验；
- 新增 `tests/agent/loop/recovery.spec.ts`（17）：消息/工具失败/usage/status 模块；
- 既有测试从 497 → 530，**全量绿**；`experimentControl` 偶发 EPERM 为 Windows 临时目录
  原子重命名竞态（既有问题，单独跑恒绿）。

## 验收对照（计划）

- [x] 全量测试绿；行为与重构前一致（对照 router events.jsonl 抽样）
- [x] 双插件系统共存：同一 `~/.rigorium/plugins/` 目录双文件名发现
- [x] 能力注册表可枚举全部内置能力（冒烟输出 50+ 能力 id）
- [x] 路由：全局健康状态跨会话共享；sticky 有 TTL 与质量释放；judge 有策略扩展点

## 遗留（后续阶段）

- marketplace 落地（git 安装上移网关）→ Phase 4 技能生态
- 不确定性门控 judge（TierClassifier 的第二个实现）→ Phase 2
- director 能力图与 CapabilityRegistry 的合并 → Phase 1
