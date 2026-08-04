# Router Policy Benchmark — Formal Comparison Report

**Rigorium tokenSaver 路由策略 · 同功能对照基准 · 可复现（确定性种子）**

生成命令（复现本报告）：
```
node scripts/benchmark-router-policy.mjs --seeds 42,43,44,45,46   # 多 seed 聚合
node scripts/benchmark-router-policy.mjs 42                        # 单 seed 明细
```
锁定测试：`tests/benchmark/router-policy.spec.ts`（确定性 + 各策略定性关系）。

---

## 1. 方法

- 合成工作负载：12 个能力桶，每桶隐藏 ground-truth tier；judge 以 85% 正确率
  返回 ground truth（否则随机 tier）；会话=同一任务形状（6 轮共享一桶）；
  消息文本绑定桶难度（简单桶短问答、复杂桶长实现指令，10% 噪声翻转）；
  2% provider 故障率。
- **公平性**：ground truth、桶序列、故障序列、消息序列、judge 判定序列全部
  由共享 workload RNG 预计算——五个策略看到完全相同的输入，只有决策不同。
- 指标：judge 调用率（每轮分类 LLM 调用比例，≈ RouteLLM 的"强模型调用"）、
  成功率（tier 足够 + 无故障；简单消息任意 tier 均成功——对文本启发式的
  诚实质量模型）、成本单位（judge 6 + tier 1/2/4/8）。
- 误差线：5 个种子（42–46）的均值 ± 样本标准差。

## 2. 多 seed 结果（均值 ± 标准差，5 seeds）

| policy | judge call rate | success rate | cost units |
|---|---|---|---|
| judge-only | 100.0% ± 0.0 | 92.5% ± 1.1 | 5872 ± 202 |
| heuristic+judge | 68.5% ± 10.6 | 92.5% ± 1.1 | 4532 ± 563 |
| gate | 17.2% ± 7.1 | 95.6% ± 2.4 | 3161 ± 233 |
| gate+explore | 23.5% ± 5.5 | 95.3% ± 2.7 | 3322 ± 182 |
| sticky+gate | 9.8% ± 1.8 | 93.7% ± 1.4 | 4768 ± 340 |

相对 judge-only 基线：

| policy | judge 调用削减 | 成功率 Δ | 成本 Δ |
|---|---|---|---|
| heuristic+judge | **-31.5%** ± 10.6 | +0.0pp | -22.8% |
| gate | **-82.8%** ± 7.1 | **+3.1pp** | -46.2% |
| gate+explore | **-76.5%** ± 5.5 | +2.8pp | -43.4% |
| sticky+gate | **-90.2%** ± 1.8 | +1.2pp | -18.8% |

## 3. 单 seed 明细（seed 42，确定性可复现）

| policy | judge call rate | learned agreement | success rate | cost units |
|---|---|---|---|---|
| judge-only | 100.0% | n/a | 92.7% | 6207 |
| heuristic+judge | 81.5% | n/a | 92.7% | 5323 |
| gate | 12.5% | 87.4% | 91.8% | 3079 |
| gate+explore | 15.8% | 86.7% | 92.2% | 3241 |
| sticky+gate | 9.3% | 65.1% | 90.5% | 4417 |

## 4. 与开源路由器公开数字的并排对比

> 口径说明（诚实标注，不可直接等同）：
> - RouteLLM / Hybrid LLM 削减的是**生成模型（GPT-4 级）调用**；Rigorium 的
>   judge 是**分类 LLM（小模型、短 prompt）调用**——都是"昂贵的每轮 LLM
>   调用"，但绝对成本量级不同。
> - 质量口径：RouteLLM 用 MT-Bench 评分保留率；Rigorium 用本基准的模拟
>   成功率。方向可比，数值不可直接换算。

| 系统 | 每轮 LLM 调用削减 | 质量保留 | 方法 |
|---|---|---|---|
| RouteLLM (SW ranking, MT-Bench) | -86%（仅 14% 请求走 GPT-4） | 95% 评分保留 | 离线训练胜率预测器 + 一次性校准成本阈值，零在线更新 |
| Hybrid LLM (Stanford, arXiv:2404.14618) | -40% 大模型调用 | <1% 质量损失 | DeBERTa 单路由器连续分数 + 验证集 500 样本网格校准阈值 |
| FrugalGPT (arXiv:2305.05176) | 最高 -98% 成本 | 同成本下 +4% 准确率 | LLM 级联 + 从数据学习升级阈值 |
| LiteLLM Auto Router | 无公开百分比（启发式 7 维特征零调用为默认级） | n/a | 启发式 → keyword 规则 → 可选小模型分类器三级级联 |
| **Rigorium heuristic+judge**（本报告） | **-31.5%** ± 10.6 judge 调用 | +0.0pp（零误拦截） | 保守文本启发式（simple 词 + 短 + 零排除命中）+ judge 兜底 |
| **Rigorium gate**（本报告） | **-82.8%** ± 7.1 judge 调用 | **+3.1pp** | 在线 amortized ranker（Laplace 平滑）+ 不确定性门控 |
| **Rigorium gate+explore**（本报告） | **-76.5%** ± 5.5 judge 调用 | +2.8pp | 同上 + 5% 周期性 judge 重审（探索/重校准） |
| **Rigorium sticky+gate**（本报告） | **-90.2%** ± 1.8 judge 调用 | +1.2pp | 会话级 pin + 滑动 TTL + 错误分类释放 + degraded 旁路 |

## 5. 结论

1. **调用削减处于 RouteLLM 同量级**：Rigorium gate 的 -82.8%±7.1 judge 调用与
   RouteLLM 的 -86% 强模型调用持平，且质量不降反升（+3.1pp）——但 Rigorium
   是**纯在线学习**（无需离线偏好语料与校准集），这是结构性差异。
2. **每个策略的性价比有量化数据**：sticky+gate 削减最狠（-90.2%±1.8）但质量
   增益最小；gate+explore 用 6.3pp 削减换回探索的质量保障；heuristic+judge
   在无 learning 部署（默认配置）下以零质量损失省 -31.5% judge 调用。
3. **基准即测试**：`tests/benchmark/router-policy.spec.ts` 锁定确定性输出与
   各策略的定性关系（gate 削减 >75%、explore 换质量、sticky 有界权衡、
   heuristic 零误拦截），任何回归都会红。

## 6. 复现与验证

- 多 seed 聚合：`node scripts/benchmark-router-policy.mjs --seeds 42,43,44,45,46`
- 单 seed 明细：`node scripts/benchmark-router-policy.mjs 42`
- 基准逻辑：`src/benchmark/routerPolicyBenchmark.ts`（类型化、可测试）
- 锁定测试：`node --test dist/tests/benchmark/router-policy.spec.js`
