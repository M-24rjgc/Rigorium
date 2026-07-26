/**
 * Pure-JS port of the path helpers from `src/rigorium/paths.ts`.
 *
 * Lets `ui/server/` resolve `~/.rigorium` and encode project IDs the
 * same way the gateway server does, WITHOUT pulling `dist/src/rigorium/`
 * into the express bridge. Keeping the math here means the UI server
 * can run from source without needing the TypeScript output to exist
 * on disk first.
 *
 * Keep this in sync with `src/rigorium/paths.ts` — both must round-trip
 * identically or `~/.rigorium/projects/<id>/.cwd` markers written by
 * the bridge will not be found by `gateway.listProjects()` and vice
 * versa.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

export const DEFAULT_RIGORIUM_HOME = '~/.rigorium';

function normalizeHomePath(p) {
    if (p === '~') return homedir();
    if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
    return resolve(p);
}

/**
 * Resolve the active Rigorium home directory. Honors `RIGORIUM_HOME` so
 * tests / multi-instance setups can isolate state. Defaults to
 * `~/.rigorium`.
 *
 * @param {Record<string, string | undefined>} [env] Environment to read.
 * @returns {string} Absolute path.
 */
export function resolveRigoriumHome(env = process.env) {
    return normalizeHomePath(env.RIGORIUM_HOME ?? DEFAULT_RIGORIUM_HOME);
}

/**
 * Encode an absolute project path into the on-disk project ID used under
 * `~/.rigorium/projects/<id>/`.
 *
 * This is the legacy lossy encoding. New UI-created projects use
 * `createCollisionResistantProjectId()` only when this id is already claimed
 * by a different `.cwd` marker.
 *
 * @param {string} projectRoot Absolute filesystem path.
 * @returns {string} Encoded project ID.
 */
export function createProjectId(projectRoot) {
    const normalizedRoot = resolve(projectRoot);
    return createLegacyProjectId(normalizedRoot);
}

export function createCollisionResistantProjectId(projectRoot) {
    const normalizedRoot = resolve(projectRoot);
    const legacyId = createLegacyProjectId(normalizedRoot);
    const digest = createHash('sha1').update(normalizedRoot).digest('hex').slice(0, 10);
    return `${legacyId}--${digest}`;
}

/**
 * Resolve the on-disk project directory name for a workspace.
 *
 * `.cwd` markers disambiguate paths that collapse to the same legacy slug.
 * If no valid marker exists, preserve the legacy ID for compatibility with
 * unregistered workspaces.
 *
 * @param {string} projectRoot Absolute filesystem path.
 * @param {string} [rigoriumHome] Active Rigorium home directory.
 * @returns {string} Project directory name under `<rigoriumHome>/projects`.
 */
export function resolveProjectStorageId(projectRoot, rigoriumHome = resolveRigoriumHome()) {
    return findStoredProjectId(projectRoot, rigoriumHome) ?? createProjectId(projectRoot);
}

/**
 * Sanitize a sessionId for safe use as a filename component.
 *
 * TUI/CLI sessionKeys embed the absolute project path (e.g.
 * `tui:project=/Users/foo/work/repo:default`). Without sanitization
 * the raw `/` characters make `path.resolve()` treat it as multiple
 * path segments, burying the transcript in nested dirs that
 * `listProjectSessions` can't find.
 *
 * Keep in sync with `src/session/storage/ProjectSessionStorage.ts`.
 *
 * @param {string} sessionId Raw session key.
 * @returns {string} Filename-safe session identifier.
 */
export function sanitizeSessionIdForPath(sessionId) {
    const illegal = process.platform === 'win32' ? /[\\/:<>"|?*]+/g : /[\\/]+/g;
    return sessionId.replace(illegal, '-').replace(/^-+|-+$/g, '') || 'session';
}

function createLegacyProjectId(projectRoot) {
    // Normalize to forward slashes so the same physical path produces the same
    // project ID on Windows (\) and Unix (/). Also strip a Windows drive-letter
    // prefix (e.g. "C:") so "C:\Users\foo" slugifies identically to "/Users/foo".
    const normalized = projectRoot.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
    return normalized.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function findStoredProjectId(projectRoot, rigoriumHome) {
    const projectsDir = resolve(rigoriumHome, 'projects');
    if (!existsSync(projectsDir)) return null;

    const target = normalizeProjectPathForMarkerComparison(projectRoot);
    try {
        for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const markerPath = resolve(projectsDir, entry.name, '.cwd');
            let marker;
            try {
                marker = readFileSync(markerPath, 'utf8').trim();
            } catch {
                continue;
            }
            if (!marker || normalizeProjectPathForMarkerComparison(marker) !== target) continue;
            try {
                if (statSync(marker).isDirectory()) return entry.name;
            } catch {
                continue;
            }
        }
    } catch {
        return null;
    }
    return null;
}

function normalizeProjectPathForMarkerComparison(projectRoot) {
    const resolved = resolve(projectRoot);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
