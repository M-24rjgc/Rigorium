import type {
  ResearchConfirmationBoundary,
  ResearchPanelEntry,
  ResearchToolActivity,
  ResearchToolActivityDetailKey,
} from './types';

const RESEARCH_ACTIVITY_TOOLS = new Set([
  'research_design',
  'research_brief',
  'research_method',
  'research_title_confirm',
  'experiment_control',
  'experiment_analysis',
  'experiment_remote',
  'research_artifacts',
  'manuscript_latex',
  'research_review',
  'research_director',
]);

type ActivityInput = {
  toolName: string;
  toolId?: string;
  input: unknown;
  result: unknown;
  now?: Date;
};

export function isResearchActivityTool(toolName: string): boolean {
  return RESEARCH_ACTIVITY_TOOLS.has(normalizeToolName(toolName));
}

export function createResearchToolActivity({
  toolName,
  toolId,
  input,
  result,
  now = new Date(),
}: ActivityInput): ResearchToolActivity | null {
  const normalizedToolName = normalizeToolName(toolName);
  if (!isResearchActivityTool(normalizedToolName)) return null;

  const inputRecord = asRecord(input);
  const resultRecord = asRecord(result);
  const data = resultData(resultRecord);
  if (!data && !resultRecord) return null;

  const operation = firstText(inputRecord?.operation, data?.operation, resultRecord?.operation);
  const action = firstText(inputRecord?.action, data?.action, resultRecord?.action);
  const details = detailEntries(normalizedToolName, operation, data, resultRecord);
  const confirmationBoundaries = inferConfirmationBoundaries(normalizedToolName, operation, action, inputRecord);
  const errorText = firstText(resultRecord?.error, data?.error, resultRecord?.message);
  const requiresConfirmation = Boolean(errorText && /confirm|permission|approval|denied/iu.test(errorText));
  const status: ResearchToolActivity['status'] = requiresConfirmation
    ? 'requires_confirmation'
    : errorText || resultRecord?.isError === true
      ? 'attention'
      : 'complete';
  const stableId = firstText(
    toolId,
    data?.analysisId,
    data?.artifactId,
    data?.planId,
    data?.decisionId,
    nestedText(data, 'result', 'job', 'jobId'),
    nestedText(data, 'job', 'jobId'),
    nestedText(data, 'repository', 'repositoryId'),
  ) || 'latest';

  return {
    schemaVersion: 1,
    kind: 'research_tool_activity',
    artifactId: `research-activity:${normalizedToolName}:${stableId}`,
    createdAt: now.toISOString(),
    toolName: normalizedToolName,
    status,
    details,
    confirmationBoundaries,
  };
}

export function isResearchPanelActivity(entry: ResearchPanelEntry): entry is ResearchToolActivity {
  return entry.kind === 'research_tool_activity';
}

function detailEntries(
  toolName: string,
  operation: string | undefined,
  data: Record<string, unknown> | null,
  result: Record<string, unknown> | null,
): ResearchToolActivity['details'] {
  const details: ResearchToolActivity['details'] = [];
  appendDetail(details, 'operation', operation);
  appendDetail(details, 'action', firstText(data?.action, result?.action));
  appendDetail(details, 'analysis_id', firstText(data?.analysisId));
  appendDetail(details, 'artifact_id', firstText(data?.artifactId, nestedText(data, 'artifact', 'artifactId')));
  appendDetail(details, 'plan_id', firstText(data?.planId, nestedText(data, 'plan', 'planId'), nestedText(data, 'decision', 'planId')));
  appendDetail(details, 'decision', firstText(data?.decision, nestedText(data, 'decision', 'decision')));
  appendDetail(details, 'job_id', firstText(nestedText(data, 'result', 'job', 'jobId'), nestedText(data, 'job', 'jobId')));
  appendDetail(details, 'job_status', firstText(nestedText(data, 'result', 'job', 'status'), nestedText(data, 'job', 'status')));
  appendDetail(details, 'revision', positiveIntegerText(nestedValue(data, 'repository', 'revision')));
  appendDetail(details, 'count', countText(data, toolName));
  appendDetail(details, 'status', firstText(data?.status, nestedText(data, 'result', 'job', 'phase')));
  return details.slice(0, 6);
}

function appendDetail(
  details: ResearchToolActivity['details'],
  key: ResearchToolActivityDetailKey,
  value: string | undefined,
): void {
  if (!value || details.some((detail) => detail.key === key)) return;
  details.push({ key, value });
}

function inferConfirmationBoundaries(
  toolName: string,
  operation: string | undefined,
  action: string | undefined,
  input: Record<string, unknown> | null,
): ResearchConfirmationBoundary[] {
  const boundaries: ResearchConfirmationBoundary[] = [];
  const operationOrAction = operation ?? action;
  if (toolName === 'experiment_remote' && operationOrAction === 'submit') boundaries.push('remote_execution');
  if (toolName === 'research_artifacts' && operationOrAction === 'invalidate_descendants') boundaries.push('artifact_invalidation');
  if (toolName === 'manuscript_latex' && /render|export|compile/iu.test(operationOrAction ?? '')) boundaries.push('export');
  if (toolName === 'research_method' && operationOrAction === 'capture_snapshot') boundaries.push('snapshot');
  if (toolName === 'research_title_confirm') boundaries.push('final_title');
  if (toolName === 'research_director' && input?.request) {
    const request = JSON.stringify(input.request);
    if (/zotero|佐泰罗/iu.test(request) && /save|write|import|tag|note|写入|导入|保存|标签|笔记/iu.test(request)) {
      boundaries.push('zotero_write');
    }
    if (/export|publish|submit|pdf|导出|发布|提交/iu.test(request)) boundaries.push('export');
    if (/snapshot|checkpoint|freeze|快照|检查点|冻结/iu.test(request)) boundaries.push('snapshot');
    if (/final[_\s-]?title|confirm[_\s-]?title|最终标题|确认标题/iu.test(request)) boundaries.push('final_title');
  }
  return [...new Set(boundaries)];
}

function resultData(result: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!result) return null;
  const toolUseResult = asRecord(result.toolUseResult);
  const data = asRecord(toolUseResult?.data) ?? toolUseResult ?? asRecord(result.data);
  return data ?? result;
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().replace(/-/gu, '_');
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function nestedValue(value: Record<string, any> | null, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function nestedText(value: Record<string, any> | null, ...keys: string[]): string | undefined {
  return firstText(nestedValue(value, ...keys));
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 160);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function positiveIntegerText(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
}

function countText(data: Record<string, any> | null, toolName: string): string | undefined {
  if (!data) return undefined;
  const candidate = toolName === 'experiment_analysis'
    ? data.aggregateCount ?? data.metadata?.aggregateCount
    : data.actionCount ?? data.artifactCount ?? data.appendedRefs?.length ?? data.staleRefs?.length;
  return positiveIntegerText(candidate);
}
