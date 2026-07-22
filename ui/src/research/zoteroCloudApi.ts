import type {
  ZoteroCloudStatus,
  ZoteroCloudWriteIntent,
  ZoteroCloudWritePlan,
  ZoteroCloudWriteResult,
} from './types';

type ProjectOptions = { projectPath?: string };

export async function getZoteroCloudStatus(options: ProjectOptions = {}): Promise<ZoteroCloudStatus> {
  return desktopBridge().status(options) as Promise<ZoteroCloudStatus>;
}

export async function previewZoteroCloudWrite(
  intent: ZoteroCloudWriteIntent,
  options: ProjectOptions = {},
): Promise<ZoteroCloudWritePlan> {
  const result = await desktopBridge().preview(intent, options) as { plan?: ZoteroCloudWritePlan };
  if (!result.plan) throw new Error('Zotero returned no write preview.');
  return result.plan;
}

export async function confirmZoteroCloudWrite(
  plan: ZoteroCloudWritePlan,
  options: ProjectOptions = {},
): Promise<ZoteroCloudWriteResult> {
  return desktopBridge().confirm(plan, options) as Promise<ZoteroCloudWriteResult>;
}

export async function importPapersIntoZotero(papers: unknown[], options: ProjectOptions = {}): Promise<unknown> {
  const bridge = window.rigoriumZoteroLibrary;
  if (!bridge) throw new Error('Zotero library writes require the Rigorium desktop app.');
  return bridge.importPapers(papers, options);
}

function desktopBridge() {
  const bridge = window.rigoriumZoteroCloud;
  if (!bridge) throw new Error('Zotero cloud access requires the Rigorium desktop app.');
  return bridge;
}
