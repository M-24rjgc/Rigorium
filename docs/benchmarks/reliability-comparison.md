# Reliability Domain — Comparison Report

**Rigorium 可靠性机制 vs 开源同功能实现 · 对照报告（可验证）**

> 本报告覆盖路由域之外的四个可靠性机制（熔断、断流恢复、sticky 驱逐、
> 并发控制）。每个机制给出：Rigorium 实现要点、开源对照机制（含出处）、
> 以及锁定该行为的测试证据。所有对照对象均为上一轮调研中逐行核对的
> 官方文档/源码。

---

## 1. 熔断器半开探测（R17 · `src/router/health/ProviderHealthTracker.ts`）

| 维度 | Rigorium | 开源对照 | 出处 |
|---|---|---|---|
| 半开探测请求量 | 探测窗口 `halfOpenProbes`（默认 3），预算用尽即不再放行 | Resilience4j `permittedNumberOfCallsInHalfOpenState`（默认 10）；gobreaker `MaxRequests`（默认 1） | resilience4j.readme.io；github.com/sony/gobreaker |
| 探测失败判定 | 窗口内**失败比例**（默认 ≥0.5 重开），单次偶发失败不重开 | Resilience4j `failureRateThreshold`（默认 50%）；gobreaker 连续成功计数 | resilience4j.readme.io |
| open 时长 | **指数退避** base×2^(openCount-1)，封顶 5min，恢复后重置 | Envoy `base_ejection_time × count` 封顶 + jitter；Polly v8 `BreakDurationGenerator` | envoyproxy.io outlier_detection；pollydocs.org |
| 恢复语义 | 探测窗口全比例通过 → healthy | Envoy 主动健康检查成功一次即摘除 | envoyproxy.io |

测试证据：`tests/router/providerHealth.spec.ts`（5 个用例）——预算准入、
全成功窗口恢复、比例重开 + 退避记忆与重置、单次抖动容忍、openCount 按
转换计数。

## 2. 断流重连续传（R16 · `src/router/RouterRuntime.ts`）

| 维度 | Rigorium | 开源对照 | 出处 |
|---|---|---|---|
| 首 token 前错误 | 整请求重试（transientRetry，指数退避 + full jitter） | OpenAI/Anthropic/Google SDK 一致：仅 TTFT 前重试 | platform.openai.com error-handling |
| 流中断续传 | 纯客户端 continuation：已产出文本作 assistant 前缀 + 续写指令 | Anthropic stop-reason 官方续写范式；OpenRouter 生态实践 | platform.claude.com handling-stop-reasons |
| 部分 tool_call | **丢弃并继续文本**（awaken R3 TruncateBeforeTool），绝不续用不可靠参数 | awaken 决策表 R1-R4；LangGraph 对孤儿 tool_call 的 INVALID_CHAT_HISTORY 处理 | github.com/awakenworks/awaken |
| 重试计数/退避 | maxAttempts=2、尊重 retry-after 且上限可配（retryAfterCapMs） | SDK 基线 2-4 次、retry-after 尊重 | openai-python constants |

测试证据：`tests/router/midstream-continuation.spec.ts`（2 个用例）——部分
tool_call 块被丢弃、文本续传成功；重试耗尽后错误浮出而非挂起。

## 3. Sticky 会话亲和驱逐（R15 · `src/router/session/SessionRouterStore.ts` + `stickyGuard.ts`）

| 维度 | Rigorium | 开源对照 | 出处 |
|---|---|---|---|
| TTL 语义 | **滑动**（命中刷新 updatedAt + 条目存活期） | LiteLLM `session_affinity` 3600s 滑动刷新；HAProxy stick-table expire-on-match | docs.litellm.ai auto_routing；haproxy.com stick-tables |
| 质量信号 | **错误分类**：仅 provider 故障码计入释放；账户级/请求形状错误不驱逐 | Claude Code fallbackModel 白名单（529/5xx）与黑名单（429/401/413） | docs.claude.com |
| 降级交互 | **degraded 即时旁路**（pin 保留，恢复后复用） | Envoy 不健康 host 移出哈希环；OpenRouter 失败即重路由 | envoyproxy.io excluded；openrouter.ai |
| 失败计数 | 全链失败才计数、失败轮不刷新 pin | OpenRouter 缓存"出错不更新、下请求重路由" | openrouter.ai |

测试证据：`tests/router/stickyHealth.spec.ts`（8 个用例）——滑动 TTL 活跃
会话不过期、请求形状错误不累计释放、degraded 旁路保留 pin、成功重置计数。

## 4. 每 provider 并发控制（R6/R9 · `src/router/execution/providerConcurrency.ts`）

| 维度 | Rigorium | 开源对照 | 出处 |
|---|---|---|---|
| 信号量粒度 | provider 级、进程内共享（跨会话） | LiteLLM per-deployment semaphore；OpenRouter per-key 限额 | docs.litellm.ai load_balancing |
| 等待语义 | FIFO + 有界等待（waitTimeoutMs），超时 → retryable 错误走既有退避/fallback | LiteLLM 无限阻塞（反例）；TGI 超限即 429 | github.com/BerriAI/litellm #18116；huggingface TGI |
| 持槽生命周期 | 覆盖完整流式请求（stream 结束才释放，finally 兜底） | LiteLLM #18116 教训：发出即释放会打穿限额 | github.com/BerriAI/litellm #18116 |
| 429 背压 | 收到 429/overloaded → 该 provider 并发窗口临时减半（retry-after 上限 60s） | OpenRouter x-ratelimit-remaining 主动降速；LiteLLM cooldown+failover | openrouter.ai limits |

测试证据：`tests/router/provider-concurrency.spec.ts`（14 个用例）——FIFO
交接、超时错误契约、abort 传播、per-provider 隔离、流全生命周期持槽、
429 收缩窗口与恢复。

---

## 5. 结论

四项可靠性机制均按"调研 → 对照 → 落地 → 测试锁定"闭环完成，且针对开源
实现的反例（LiteLLM 无限阻塞/发出即释放、HAProxy 默认不驱逐、nginx sticky
无视健康、Hystrix 单探测抖动敏感）做了显式规避，机制选择均有出处与测试
证据可回溯。与路由域报告（docs/benchmarks/router-policy.md）共同构成
「同功能 benchmark 对照」的两份正式证据。

## 6. 数值模拟：探测窗口 vs 单探测（Hystrix 反例的量化规避）

`node scripts/benchmark-circuit-breaker.mjs 200 7`（确定性种子，200 个故障周期，
10% 抖动失败率，解析期望与蒙特卡洛自验证）：

| policy | 无谓重开（MC） | 探测数 | 解析期望 |
|---|---|---|---|
| single-probe (Hystrix) | 14 | 200 | 14.0 |
| window-3 (Rigorium R17) | 5 | 600 | 3.9 |

**结论**：探测窗口用 3× 探测量换取 **64.3% 的无谓重开削减**——provider 已恢复
时的一次偶发失败不再触发整轮冷却（Hystrix 单探测模型的抖动敏感代价被量化）。
