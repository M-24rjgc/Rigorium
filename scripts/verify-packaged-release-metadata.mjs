import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const projectRoot = resolve(import.meta.dirname, '..');
const asarPath = resolve(projectRoot, process.argv[2] || 'release/win-unpacked/resources/app.asar');
const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));

assert.equal(existsSync(asarPath), true, `Packaged app archive was not found: ${asarPath}`);

const metadata = await readPackagedMetadata(asarPath);
const expectedRepository = normalizeRepository(
  process.env.RIGORIUM_UPDATE_REPOSITORY
    || process.env.GITHUB_REPOSITORY
    || repositoryValue(packageJson.repository),
);

assert.equal(metadata?.schemaVersion, 1, 'Packaged release metadata has an unsupported schema version.');
assert.equal(metadata?.product, 'Rigorium', 'Packaged release metadata has the wrong product name.');
assert.equal(metadata?.version, packageJson.version, 'Packaged release metadata does not match package.json version.');
assert.equal(metadata?.repository, expectedRepository, 'Packaged release metadata has the wrong GitHub repository.');
assert.equal(typeof metadata?.buildTime, 'string', 'Packaged release metadata does not include a build time.');
assert.equal(Number.isNaN(Date.parse(metadata.buildTime)), false, 'Packaged release metadata build time is invalid.');
assert.equal(
  metadata?.channel,
  packageJson.version.includes('-') ? 'prerelease' : 'stable',
  'Packaged release metadata has the wrong update channel.',
);

const updateManifest = await verifyWindowsUpdateManifest({
  releaseDirectory: resolve(projectRoot, 'release'),
  product: metadata.product,
  version: metadata.version,
});

if (process.env.GITHUB_SHA) {
  assert.equal(metadata.commit, process.env.GITHUB_SHA, 'Packaged release metadata does not match GITHUB_SHA.');
}

console.log(JSON.stringify({
  asarPath,
  product: metadata.product,
  version: metadata.version,
  repository: metadata.repository,
  commit: metadata.commit,
  buildTime: metadata.buildTime,
  channel: metadata.channel,
  updateManifest,
  verified: true,
}));

async function readPackagedMetadata(archivePath) {
  const require = createRequire(import.meta.url);
  const builderPackagePath = require.resolve('electron-builder/package.json');
  const asarModulePath = require.resolve('@electron/asar', { paths: [dirname(builderPackagePath)] });
  const { extractFile } = await import(pathToFileURL(asarModulePath).href);
  return JSON.parse(extractFile(archivePath, 'dist/release-metadata.json').toString('utf8'));
}

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

async function verifyWindowsUpdateManifest({ releaseDirectory, product, version }) {
  const installerName = `${product}-Setup-${version}.exe`;
  const installerPath = resolve(releaseDirectory, installerName);
  const blockmapPath = `${installerPath}.blockmap`;
  const manifestPath = resolve(releaseDirectory, 'latest.yml');

  assert.equal(existsSync(installerPath), true, `Windows installer was not found: ${installerPath}`);
  assert.equal(existsSync(blockmapPath), true, `Windows installer block map was not found: ${blockmapPath}`);
  assert.equal(existsSync(manifestPath), true, `Windows update manifest was not found: ${manifestPath}`);

  const manifest = parseYaml(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest?.version, version, 'Windows update manifest does not match package.json version.');
  assert.equal(manifest?.path, installerName, 'Windows update manifest does not point to the installer.');

  const installerEntry = Array.isArray(manifest?.files)
    ? manifest.files.find((entry) => entry?.url === installerName)
    : null;
  assert.equal(typeof installerEntry?.sha512, 'string', 'Windows update manifest is missing the installer SHA-512.');
  assert.equal(typeof manifest?.sha512, 'string', 'Windows update manifest is missing the primary SHA-512.');

  const sha512 = await hashFileSha512(installerPath);
  assert.equal(installerEntry.sha512, sha512, 'Windows update manifest installer SHA-512 is incorrect.');
  assert.equal(manifest.sha512, sha512, 'Windows update manifest primary SHA-512 is incorrect.');

  return {
    path: 'latest.yml',
    installer: installerName,
    blockmap: `${installerName}.blockmap`,
    sha512,
  };
}

async function hashFileSha512(filePath) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('base64');
}
