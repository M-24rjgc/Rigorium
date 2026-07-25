---
name: experiment-analysis
description: Analyze completed Rigorium experiment runs, repeated metrics, baselines, ablations, robustness slices, route tradeoffs, budgets, and deterministic next-trial options without executing new work. 分析已完成的实验运行、重复指标、基线、消融、鲁棒性切片、路线权衡、预算和确定性后续试验选项，不执行新工作。
---

# Analyze Experiments

Use `experiment_analysis` only with immutable RunAttempt, MetricObservation, and BaselineObservation envelopes from the current research project.

- Include all run revisions when available. The analyzer selects the latest revision per run identity and records older revisions as ignored inputs.
- Supply trial descriptors for named routes, parameter values, robustness slices, cost, and wall time. Never place measured outcomes in a descriptor.
- Keep literature values as reported baselines. Use observed baseline provenance only when it resolves to the exact succeeded run and metric.
- Treat confidence intervals and Hedges g as descriptive unless the study design supports the assumptions listed in the report. A missing or zero-variance effect is not evidence of no effect.
- Read data-quality issues before interpreting aggregates. Failed, incomplete, unlisted, or orphaned measurements are excluded rather than repaired by inference.
- Treat Pareto membership as a mean-based route comparison, not a significance claim.
- Treat deterministic-grid proposals as `proposed_not_executed`. The tool neither predicts their measurements nor launches them.
- Supply figure and table data, script, output paths, and hashes explicitly. The analyzer records provenance but writes no files.

## 实验分析（中文）

仅使用当前研究项目中不可变的 RunAttempt、MetricObservation 和 BaselineObservation 封装调用 `experiment_analysis`。

- 如能取得全部运行修订版，应一并提供；分析器会选择每个运行身份的最新修订，并记录被忽略的旧版本。
- 为命名路线、参数值、鲁棒性切片、成本和耗时提供试验描述符；不得将测量结果放入描述符。
- 文献数值保持为 `reported` 基线。只有能够解析到精确成功运行和指标时，才使用 `observed` 基线来源。
- 置信区间和 Hedges g 仅在报告中所列研究设计假设成立时才可作描述性解释；缺失或零方差效应不代表没有效应。
- 解读聚合结果前先阅读数据质量问题。失败、不完整、未列出或孤立的测量会被排除，而非由推断修补。
- Pareto 成员资格是基于均值的路线比较，不是显著性主张。
- 确定性网格提案属于 `proposed_not_executed`；工具既不预测其测量结果，也不会启动它们。
- 图表数据、脚本、输出路径和哈希必须显式提供。分析器记录来源，但不写入文件。
