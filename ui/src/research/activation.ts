import {
  RESEARCH_CONFIRMATION_BOUNDARIES,
  type ResearchConfirmationBoundary,
} from './types';

export const RESEARCH_PANEL_ACTIVATE_EVENT = 'rigorium:research-activate';

export type ResearchIntentKind = 'analysis' | 'direction' | 'experiment' | 'literature' | 'manuscript';

export type ResearchPanelActivation = {
  query: string;
  intents: ResearchIntentKind[];
  confirmationBoundaries: ResearchConfirmationBoundary[];
  activatedAt: string;
};

const INTENT_PATTERNS: Readonly<Record<ResearchIntentKind, readonly RegExp[]>> = {
  analysis: [
    /\b(experiment(?:al)? analysis|result analysis|statistical analysis|evaluation metric|baseline|ablation|robustness)\b/iu,
    /实验分析|结果分析|统计分析|评价指标|基线|消融|鲁棒/u,
  ],
  direction: [
    /\b(research question|hypothesis|research direction|novelty)\b/iu,
    /研究问题|假设|研究方向|创新性/u,
  ],
  experiment: [
    /\b(experiment|trial|ssh worker|slurm|cluster|remote experiment|remote run)\b/iu,
    /实验|试验|SSH 工作节点|Slurm|集群|远程实验|远程运行/iu,
  ],
  literature: [
    /\b(literature|paper|papers|citation|citations|zotero)\b/iu,
    /文献|论文|引用|引文|佐泰罗/u,
  ],
  manuscript: [
    /\b(manuscript|draft|peer review|reviewer|journal|latex)\b/iu,
    /手稿|初稿|同行评审|审稿|期刊|排版/u,
  ],
};

const BOUNDARY_PATTERNS: ReadonlyArray<readonly [ResearchConfirmationBoundary, readonly RegExp[]]> = [
  ['artifact_invalidation', [/\b(invalidate|delete|remove|discard)\b/iu, /失效|删除|移除|废弃/u]],
  ['export', [/\b(export|publish|submit)\b/iu, /导出|发布|提交/u]],
  ['final_title', [/\b(final title|confirm title)\b/iu, /最终标题|确认标题/u]],
  ['remote_execution', [
    /\b(?:execute|launch|run|submit).{0,40}(?:ssh|slurm|cluster|remote|job)|(?:ssh|slurm|cluster|remote).{0,40}(?:execute|launch|run|submit)\b/iu,
    /(?:执行|启动|运行|提交).{0,40}(?:SSH|Slurm|集群|远程|任务)|(?:SSH|Slurm|集群|远程).{0,40}(?:执行|启动|运行|提交)/iu,
  ]],
  ['snapshot', [/\b(snapshot|checkpoint|freeze)\b/iu, /快照|检查点|冻结/u]],
  ['zotero_write', [/(?:zotero.*(?:save|write|import)|(?:save|write|import).{0,80}zotero)/iu, /Zotero.*(写入|导入|保存)|(写入|导入|保存).*Zotero/u]],
];

export function detectResearchPanelActivation(value: string, now = new Date()): ResearchPanelActivation | null {
  const query = value.trim();
  if (!query || query.length > 10_000) return null;

  const intents = (Object.entries(INTENT_PATTERNS) as Array<[ResearchIntentKind, readonly RegExp[]]>)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(query)))
    .map(([intent]) => intent);
  if (intents.length === 0) return null;

  const confirmationBoundaries = BOUNDARY_PATTERNS
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(query)))
    .map(([boundary]) => boundary);

  return {
    query: query.slice(0, 500),
    intents,
    confirmationBoundaries,
    activatedAt: now.toISOString(),
  };
}

export function isResearchPanelActivation(value: unknown): value is ResearchPanelActivation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.query === 'string'
    && candidate.query.trim().length > 0
    && Array.isArray(candidate.intents)
    && candidate.intents.every((intent) => (
      intent === 'analysis'
      || intent === 'direction'
      || intent === 'experiment'
      || intent === 'literature'
      || intent === 'manuscript'
    ))
    && Array.isArray(candidate.confirmationBoundaries)
    && candidate.confirmationBoundaries.every((boundary) => (
      typeof boundary === 'string'
      && RESEARCH_CONFIRMATION_BOUNDARIES.includes(boundary as ResearchConfirmationBoundary)
    ))
    && typeof candidate.activatedAt === 'string';
}

export function requestResearchPanelActivation(value: string, projectPath?: string | null): boolean {
  const activation = detectResearchPanelActivation(value);
  if (!activation || typeof window === 'undefined') return false;
  window.dispatchEvent(new CustomEvent(RESEARCH_PANEL_ACTIVATE_EVENT, {
    detail: { activation, projectPath: projectPath || null },
  }));
  return true;
}
