# Router Policy Benchmark

Seed: deterministic · buckets: 12 · turns: 600 · judge correctness: 0.85

| policy | judge call rate | learned agreement | success rate | cost units |
|---|---|---|---|---|
| judge-only | 100.0% | n/a | 91.0% | 6167 |
| gate | 14.0% | 87.2% | 90.0% | 3124 |
| gate+explore | 28.7% | 93.0% | 94.8% | 3758 |
| sticky+gate | 14.3% | 80.0% | 96.2% | 5806 |

**gate** vs judge-only: judge calls **-86.0%**, success rate -1.0pp, cost **-49.3%** vs baseline.
**gate+explore** vs judge-only: judge calls **-71.3%**, success rate +3.8pp, cost **-39.1%** vs baseline.
**sticky+gate** vs judge-only: judge calls **-85.7%**, success rate +5.2pp, cost **-5.9%** vs baseline.

## 与开源路由器公开数字的并排对比

> 口径说明（诚实标注，不可直接等同）：
> - **RouteLLM / Hybrid LLM 削减的是"生成模型（GPT-4 级）调用"**；Rigorium
>   的 judge 调用是**分类 LLM（小模型、短 prompt）调用**——两者都是"昂贵的
>   每轮 LLM 调用"，但绝对成本量级不同。
> - 质量口径：RouteLLM 用 MT-Bench 评分保留率；Rigorium 用本基准模拟的
>   任务成功率（tier 足够 + 无 provider 故障）。方向可比，数值不可直接换算。

| 系统 | 每轮 LLM 调用削减 | 质量保留 | 方法 |
|---|---|---|---|
| RouteLLM (SW ranking, MT-Bench) | -86%（仅 14% 请求走 GPT-4） | 95% 评分保留 | 离线训练胜率预测器 + 一次性校准成本阈值，零在线更新 |
| Hybrid LLM (Stanford, arXiv:2404.14618) | -40% 大模型调用 | <1% 质量损失 | DeBERTa 单路由器连续分数 + 验证集 500 样本网格校准阈值 |
| FrugalGPT (arXiv:2305.05176) | 最高 -98% 成本 | 同成本下 +4% 准确率 | LLM 级联 + 从数据学习升级阈值 |
| LiteLLM Auto Router | 无公开百分比（启发式 7 维特征零调用为默认级） | n/a | 启发式 → keyword 规则 → 可选小模型分类器三级级联 |
| **Rigorium gate**（本基准） | **-86.0% judge 调用** | 成功率 -1.0pp | 在线 amortized ranker（Laplace 平滑）+ 不确定性门控（观察≥4、margin≥0.15） |
| **Rigorium gate+explore**（本基准） | **-71.3% judge 调用** | 成功率 **+3.8pp** | 同上 + 5% 周期性 judge 重审（探索/重校准） |
| **Rigorium sticky+gate**（本基准） | **-85.7% judge 调用** | 成功率 **+5.2pp** | 会话级 pin + 滑动 TTL + 错误分类释放 + degraded 旁路 |

结论：
- 在与 RouteLLM/Hybrid LLM 同量级的"每轮 LLM 调用削减"上，Rigorium 的
  门控路径（-86%）与 RouteLLM 的强模型削减（-86%）数字持平，且质量保留
  同量级（-1.0pp vs 5% 评分损失）——但 Rigorium 是**纯在线学习**（无需
  离线训练语料与校准集），RouteLLM 需要离线偏好数据。
- gate+explore 用 15pp 的 judge 削减换取 +4.8pp 成功率，验证了探索/重审
  在质量-成本权衡中的价值（R14）。
- 与 LiteLLM Auto Router 相比，Rigorium 缺"零成本启发式第一级"（见调研
  短板 #5）——这是已记录的后续候选；其余级联（learned/judge）已就位。
