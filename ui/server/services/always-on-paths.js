import path from 'path';
import { resolveRigoriumHome, resolveProjectStorageId } from '../utils/rigoriumPaths.js';

export function getAlwaysOnRoot(projectRoot) {
  const rigoriumHome = resolveRigoriumHome();
  const projectId = resolveProjectStorageId(path.resolve(projectRoot), rigoriumHome);
  return path.join(rigoriumHome, 'always-on', 'projects', projectId);
}

export function getAlwaysOnDiscoveryLockPath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'locks', 'discovery.lock');
}

export function getAlwaysOnDiscoveryStatePath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'state.json');
}

export function getAlwaysOnRunHistoryPath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'run-history.jsonl');
}

export function getAlwaysOnRunsDir(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'runs');
}
