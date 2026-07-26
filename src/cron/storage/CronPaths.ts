import { resolve } from "node:path";
import { createProjectId } from "../../rigorium/paths.js";

const ROOT_DIR_NAME = "cron";

export type CronPaths = {
  rigoriumHome: string;
  projectKey: string;
  projectId: string;
  rootDir: string;
  projectDir: string;
  tasksFile: string;
  runsDir: string;
  runHistoryFile: string;
};

export function resolveCronPaths(input: { rigoriumHome: string; projectKey: string }): CronPaths {
  const rigoriumHome = resolve(input.rigoriumHome);
  const projectKey = resolve(input.projectKey);
  const projectId = createProjectId(projectKey);
  const rootDir = resolve(rigoriumHome, ROOT_DIR_NAME);
  const projectDir = resolve(rootDir, "projects", projectId);

  return {
    rigoriumHome,
    projectKey,
    projectId,
    rootDir,
    projectDir,
    tasksFile: resolve(projectDir, "tasks.json"),
    runsDir: resolve(projectDir, "runs"),
    runHistoryFile: resolve(projectDir, "run-history.jsonl"),
  };
}

export function cronRunEventsPath(paths: CronPaths, runId: string): string {
  return resolve(paths.runsDir, `${sanitizeId(runId)}.events.jsonl`);
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}
