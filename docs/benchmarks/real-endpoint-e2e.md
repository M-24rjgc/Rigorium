# Real-Endpoint End-to-End Routing Comparison

**真实 LLM 端点端到端对比 · DeepSeek · 2026-08**

> 端点：`https://api.deepseek.com/v1` · 模型：`deepseek-v4-flash`（推理模型）
> 样本：20 条混合消息（问候/简单问答/代码/架构/科研任务）
> 复现：`RIGORIUM_E2E_BASE_URL=... RIGORIUM_E2E_API_KEY=... RIGORIUM_E2E_MODEL=deepseek-v4-flash node scripts/benchmark-router-e2e.mjs`
> （key 不写入本仓库；harness 亦可自动读取 rigorium.yaml 中的 provider）

## 结果

| path | judge 调用 | 延迟 p50 | 延迟 p95 |
|---|---|---|---|
| judge-only | 20 | 1802ms | 6261ms |
| heuristic+judge | 13 | 2849ms | 4719ms |

- 启发式拦截：7/20（35%）
- **启发式拦截消息与真实 judge 判定一致率：7/7（100%）**——零误拦截在真实
  推理模型上成立
- 说明：deepseek-v4-flash 为推理模型，单次 judge 分类含思考延迟（p50 ~1.8s、
  p95 ~6.3s）；启发式拦截的 7 条请求零接口调用、零延迟——每拦截一条即省
  约 2-6 秒与一次计费。

## 与模拟基准的一致性

模拟基准（5-seed）中 heuristic+judge 的"零误拦截"性质，在真实端点得到
端到端确认；judge 调用削减幅度（35%）与模拟中该策略的拦截比例同量级。

## harness 修正（本次真实测试暴露并修复）

1. 端点路径拼接：接受 `https://host` 与 `https://host/v1` 两种写法
2. judge 请求补充分类指令（此前只发原始消息，真实模型无法分类）
3. `max_tokens` 32 → 512：推理模型（如 deepseek-v4-flash）会先用完小额度
   思考、正式回答为空（实测复现：finish=length、content=""）
