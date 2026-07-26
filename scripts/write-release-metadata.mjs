import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const outputPath = resolve(projectRoot, process.argv[2] || 'dist/release-metadata.json');
const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
const repository = normalizeRepository(
  process.env.RIGORIUM_UPDATE_REPOSITORY
    || process.env.GITHUB_REPOSITORY
    || repositoryValue(packageJson.repository),
);
const version = firstNonEmpty(
  stripVersionPrefix(process.env.RIGORIUM_RELEASE_VERSION) || process.env.RIGORIUM_RELEASE_VERSION,
  stripVersionPrefix(process.env.GITHUB_REF_NAME),
  packageJson.version,
) || '0.0.0';
const commit = firstNonEmpty(process.env.GITHUB_SHA, readGitValue(['rev-parse', 'HEAD']));
const buildTime = firstNonEmpty(
  process.env.RIGORIUM_BUILD_TIME,
  process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : null,
  readGitValue(['log', '-1', '--format=%cI', 'HEAD']),
  new Date().toISOString(),
);
const channel = process.env.RIGORIUM_UPDATE_CHANNEL || (version.includes('-') ? 'prerelease' : 'stable');

const metadata = {
  schemaVersion: 1,
  product: 'Rigorium',
  version,
  repository,
  commit: commit || null,
  buildTime,
  channel,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
console.log(`[release] Wrote ${outputPath}`);

function repositoryValue(value) {
  if (typeof value === 'string') return value;
  return value?.url;
}

function normalizeRepository(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//iu.test(raw) || raw.startsWith('git+')) {
    try {
      const url = new URL(raw.replace(/^git\+/iu, ''));
      const parts = url.pathname.replace(/^\/+|\.git$/gu, '').split('/');
      return parts.length >= 2 && parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : null;
    } catch {
      return null;
    }
  }
  const match = raw.replace(/\.git$/iu, '').match(/^([^/\s]+)\/([^/\s]+)$/u);
  return match ? `${match[1]}/${match[2]}` : null;
}

function stripVersionPrefix(value) {
  const raw = String(value || '').trim();
  return /^v\d/u.test(raw) ? raw.slice(1) : null;
}

function readGitValue(args) {
  try {
    return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim();
}
