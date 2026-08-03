# Increment 4 — PaperStudio 论文工坊（Phase 3 全部落地）

日期：2026-08-03 · 状态：P3.1-3.4 全部合入 · 全量测试：604/604 绿

## 总纲

P3 把「论文写作」从单一 LaTeX 工具升级为**开放的论文工坊**：目标 venue 前置
敲定、模板注册表（18 个内置 venue）、范文语料与细粒度风格画像、视觉辅助、
文生图。所有模块坚持同一设计哲学：**平台提供能力与数据面，agent 拥有全部
决策权**——没有一条定死的写作流水线。

## 3.1 泛用模板服务（`src/research/manuscript/templates/`）

- **内置 Venue 注册表**（`venueRegistry.ts`）：10 会议（ICLR/ICML/NeurIPS/
  ACL/EMNLP/NAACL/CVPR/ICCV/AAAI/COLM）+ 8 期刊（JMLR/TMLR/TPAMI/
  IEEE Trans/Neural Computation/Nature MI/Science Advances/PNAS），每个
  venue 带官方入口 URL、候选模板源、匿名/页数约定；ICLR 2026 保留已验证
  pin，其余标记 `verified: false`——**候选而非裁决**。
- **年份回退解析**（`templateResolver.ts`）：精确年 → evergreen → 近三年
  回退（`yearAdjusted` 标注 + 改年份指引），回退决策显式可审计。
- **项目级扩展**（`VenueTemplateRegistry`）：`<project>/.rigorium/research/
  venues/venues.json` 注册自定义期刊，零代码；`pin` 记录 agent 验证过的
  模板（verified 源排最前）。
- **`venue_template` 工具**（list/resolve/pin）+ **`venue-template` skill**
  （rigorium-manuscript 插件）：agent 的完整决策流程（选 venue → 解析 →
  回退策略 → 下载验证 → pin → 范文学习）。

## 3.2 范文语料 + 细粒度风格画像（`src/research/manuscript/style/`）

- **`VenueCorpus`**：每 venue 至多 10 篇范文（best_paper/high_score/survey/
  user 四类选择理由），持久化 + 去重 + 上限淘汰（学习要深度不要广度）。
- **`StyleProfile`** 细粒度结构：storyArc（段落级节拍）、sentenceTemplates
  （槽位模板 + 原文例句 + 位置）、paragraphPatterns（句级结构 + 过渡）、
  figureConventions（配色/字幕模式/绘制方式）、latexConventions（宏包/
  记号/定理环境/引文密度）、writingVoice——**agent 从 ~10 篇逐篇学习后
  综合产出**，存储校验结构（防劣质分析污染后续写作），同 venue 保存即
  替换（supersede）。
- **`venue_corpus` 工具**（papers_list/paper_add/paper_remove/style_get/
  style_save/style_list）+ **`style-learning` skill**（每篇逐句学习要求、
  跨篇综合规则、硬性规则：引用真实例句、一 venue 一画像、写作前先学习）。

## 3.3 视觉辅助子系统（Codex read-image 模式，原生实现）

- **`VisionAssistant`**（`src/model/vision/`）：OpenAI 兼容 chat/completions
  传输（GitHub Copilot 模型网关与常规端点同协议）、base64 图片、超时/
  错误归一化、fetch 可注入（测试零网络）。
- 配置面 `vision: { enabled, baseUrl, apiKey, model, timeoutMs }`。
- **`describe_image` 工具**：读项目内图片 → 视觉模型描述 → 文本返回；
  未配置时给出指向 `vision:` 配置的可操作提示。多模态边界自动注入
  （无视觉模型 + 图片 → 自动描述）→ Phase 4 接线项。

## 3.4 GPT Image 2 生图（配置面先行）

- **`ImageGenerator`**（`src/model/vision/ImageGenerator.ts`）：OpenAI 兼容
  `images/generations`（b64_json）、可注入 fetch、超时/错误归一化。
- 配置面 `figureGen: { enabled, baseUrl, apiKey, model, timeoutMs }`。
- **`figure_generate` 工具**：figureType（architecture/data/concept/other）+
  描述 + 风格引用 + 输出路径 → 生成 PNG 存项目并返回路径；数据图仍建议
  代码绘制，生图只用于真正适合生成的图（架构图/概念图）。
- ⚠️ **标注待测**：figureGen 是配置面先行——README/工具描述/报错提示均
  注明「需要用户提供 Key 后验证，尚未对真实端点测试」，无 Key 时给出
  指向 `figureGen:` 的可操作提示。

## 测试（新增 27 项）

- `tests/research/venueTemplate.spec.ts`（11）：注册表覆盖、回退解析、
  项目级扩展、工具 list/resolve/pin 往返、未知 venue 拒绝；
- `tests/research/styleProfile.spec.ts`（6）：语料增删往返、画像保存/
  替换/校验、工具往返；
- `tests/model/visionAssistant.spec.ts`（6）：请求形状、禁用/HTTP/超时
  错误归一化、工具读图/未配置/缺文件；
- `tests/model/imageGenerator.spec.ts`（4）：请求形状、禁用、写盘、校验。

## 遗留（Phase 4 接线项）

- 多模态边界自动视觉注入（无视觉模型 + 图片 → 自动 describe_image）；
- figure_generate 真实端点验证（等用户 Key）；
- venue 选择 → director 计划集成（EIG 的 write_section 动作消费 style
  profile）；自举论文端到端。
