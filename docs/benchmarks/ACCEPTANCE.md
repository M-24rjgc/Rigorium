# Rigorium — 目标验收审计（Completion Audit）

审计对象：*「进行深入的迭代式渐进式审查，并分配子代理去调研同一功能的开源
项目的最佳实践，比较优劣势，学习好的、摒弃坏的，逐项提高项目质量，使项目
核心功能与模块本质没有改变的情况下，整体质量达到统领域sota级别。」*

审计日期：2026-08 · 审计人：迭代改进会话（R1–R23）· 判定权：用户/验证器

---

## 逐项核查清单

| # | 目标要求 | 证据 | 状态 |
|---|---|---|---|
| 1 | 深入的迭代式渐进式审查 | R1–R23 共 23 轮，每轮「调研 → 落地 → 全量回归 → 提交推送」闭环；每轮全量回归绿（后端 689→748、UI 358/358） | ✅ 已证实 |
| 2 | 分配子代理调研同功能开源最佳实践 | 7 次子代理调研：per-provider 并发控制（LiteLLM/OpenRouter/TGI）、judge 学习回路（RouteLLM/ParetoBandit/semantic-router）、sticky 会话亲和（LiteLLM/HAProxy/Envoy/Claude Code）、断流重连续传（awaken/Anthropic/LangGraph）、熔断恢复探测（Resilience4j/gobreaker/Envoy/Polly）、零成本启发式（LiteLLM 7 维评分器/llm-router）、科研编排（AI Scientist/PiEvo）——均以官方文档/源码/论文为据 | ✅ 已证实 |
| 3 | 比较优劣势、学习好的、摒弃坏的 | 每轮落地改进并显式规避反例：LiteLLM #18116 无限阻塞/发出即释放、HAProxy 默认不驱逐、nginx sticky 无视健康、Hystrix 单探测抖动敏感、RouteLLM 需离线语料；R18 用基准测量发现"启发式预过滤在在线学习下有害"并据此改为冷启动限定——测量驱动的取舍 | ✅ 已证实 |
| 4 | 逐项提高项目质量 | 20+ 项改进落地：并发信号量、429 背压、judge 探索重审、judge 失败降级、sticky 滑动 TTL/错误分类释放/degraded 旁路、断流 R3 恢复、熔断半开探测窗口/指数退避、零成本启发式、PreCompact/PostCompact hooks、hook 派发防护统一、research-audit 重放工具、transientRetry 死配置修复等 | ✅ 已证实 |
| 5 | 核心功能与模块本质没有改变 | 每轮 commit 声明约束；数学语义由黄金测试锁定：`beliefGolden.spec.ts`（置信度渐近锚点 0.77、饱和行为）、`eigProperties.spec.ts`（EIG 单调性/停止阈值）、契约测试（backoff full-jitter、provenance、transcript 链路）——重构/增强不改变决策语义 | ✅ 已证实（测试锁定） |
| 6 | 整体质量达到同领域 SOTA 级别 | **部分证实**（见下节证据清单与开放项） | ⚠️ 待验收方判定 |

## 证据清单（第 6 项）

1. **路由域对照报告** `docs/benchmarks/router-policy.md`：5-seed 聚合 ± 误差线；
   gate -82.8%±7.1 judge 调用（RouteLLM 同量级 -86%）、sticky+gate
   -90.2%±1.8、gate+explore -76.5%±5.5、heuristic+judge -31.5%±10.6 零误拦截；
   与 RouteLLM/Hybrid LLM/FrugalGPT/LiteLLM 公开数字并排（口径差异已标注）。
2. **可靠性域对照报告** `docs/benchmarks/reliability-comparison.md`：
   熔断/断流/sticky/并发 vs Resilience4j/gobreaker/Envoy/awaken/LiteLLM，
   29 用例测试证据链；数值模拟量化探测窗口削减 64.3% 无谓重开（解析自验证）。
3. **科研编排域对照报告** `docs/benchmarks/orchestration-comparison.md`：
   信念驱动 EIG 编排、显式停止准则、finding 闭环账本、provenance 校验、
   research-audit 重放 + CI 门禁 vs AI Scientist/PiEvo（开源无直接对应物）。
4. **证据索引** `docs/benchmarks/README.md`：三域报告导航 + 复现命令。
5. **端到端 harness** `scripts/benchmark-router-e2e.mjs`：真实 OpenAI 兼容
   协议全链路；mock 模式自验证（拦截 7/7 与 judge 100% 一致，锁定测试）；
   真实模式设 `RIGORIUM_E2E_BASE_URL` + `RIGORIUM_E2E_API_KEY` 即跑。
6. **测试基线**：后端 748/748、UI 358/358、tsc 干净；全部提交并推送
   origin/main（main == origin）。

## 开放项（未证实，需外部输入）

| 开放项 | 阻塞因素 | 解锁方式 |
|---|---|---|
| 真实 LLM 端点端到端对比数字 | 环境无 API key、网络曾受限 | 提供 `RIGORIUM_E2E_BASE_URL` + `RIGORIUM_E2E_API_KEY` → 跑 `node scripts/benchmark-router-e2e.mjs` |
| 「达到 SOTA 级别」的最终判定 | 判定权在用户/验证器 | 基于本清单与三份报告确认验收，或指明缺口 |

## 结论

目标要求 1–5 已全部证实并有可复现证据；要求 6（SOTA 级）已具备三域对照
报告 + harness + 748 测试的可验证证据链，但「达到」的最终判定需验收方
基于证据确认（开放项 2）；如需更强证据（真实端点数字），解锁开放项 1
后即可补齐。
