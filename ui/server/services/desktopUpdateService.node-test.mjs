import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  getCurrentDesktopVersion,
  getDesktopDownloadStatus,
  launchDownloadedDesktopUpdate,
  normalizeRepository,
  parseInstallerSha256,
  resetDesktopUpdateStateForTesting,
  resolveReleaseAssetRequest,
  resolveUpdateRepository,
  selectChecksumAsset,
  startDesktopUpdateDownload,
} from './desktopUpdateService.js';

test('release metadata supplies the packaged repository, version, commit, and build time', async (t) => {
  const projectRoot = await createTempDirectory(t, 'rigorium-update-metadata-');
  await mkdir(join(projectRoot, 'dist'), { recursive: true });
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ version: '0.1.0' }), 'utf8');
  await writeFile(join(projectRoot, 'dist', 'release-metadata.json'), JSON.stringify({
    schemaVersion: 1,
    repository: 'research-team/rigorium',
    version: '0.2.0',
    commit: 'abc123',
    buildTime: '2026-07-26T00:00:00.000Z',
  }), 'utf8');

  assert.equal(resolveUpdateRepository({ projectRoot, env: {} }), 'research-team/rigorium');
  const current = await getCurrentDesktopVersion({ projectRoot, env: { PILOTDECK_DESKTOP: '1' } });
  assert.equal(current.version, '0.2.0');
  assert.equal(current.commit, 'abc123');
  assert.equal(current.buildTime, '2026-07-26T00:00:00.000Z');
});

test('checksum selection and parsing are deterministic', () => {
  const installer = { name: 'Rigorium-Setup-0.2.0.exe' };
  const checksum = { name: 'Rigorium-Setup-0.2.0.exe.sha256', downloadUrl: 'https://example.invalid/checksum' };
  const fallback = { name: 'SHA256SUMS.txt', downloadUrl: 'https://example.invalid/sums' };
  assert.equal(selectChecksumAsset({ assets: [fallback, checksum] }, installer), checksum);
  const hash = 'a'.repeat(64);
  assert.equal(parseInstallerSha256(hash, installer.name), hash);
  assert.equal(parseInstallerSha256(hash, installer.name, { allowBare: false }), null);
  assert.equal(parseInstallerSha256(`${'b'.repeat(64)}  ${installer.name}\n${hash}  other.exe\n`, installer.name), 'b'.repeat(64));
  assert.equal(parseInstallerSha256(`${hash}  another.exe`, installer.name), null);
});

test('repository normalization accepts GitHub forms and rejects ambiguous remote URLs', () => {
  assert.equal(normalizeRepository('research-team/rigorium'), 'research-team/rigorium');
  assert.equal(normalizeRepository('git+https://github.com/research-team/rigorium.git'), 'research-team/rigorium');
  assert.equal(normalizeRepository('git@github.com:research-team/rigorium.git'), 'research-team/rigorium');
  assert.equal(normalizeRepository('https://example.invalid/research-team/rigorium'), null);
  assert.equal(normalizeRepository('research-team/rigorium?release=1'), null);
});

test('private release assets use the GitHub asset API and browser URLs never receive an auth header', () => {
  assert.deepEqual(
    resolveReleaseAssetRequest({ id: 42, downloadUrl: 'https://github.com/research-team/rigorium/releases/download/v1/setup.exe' }, 'research-team/rigorium'),
    {
      url: 'https://api.github.com/repos/research-team/rigorium/releases/assets/42',
      headers: { accept: 'application/octet-stream' },
    },
  );
  assert.deepEqual(
    resolveReleaseAssetRequest({ downloadUrl: 'https://github.com/research-team/rigorium/releases/download/v1/setup.exe' }, null),
    {
      url: 'https://github.com/research-team/rigorium/releases/download/v1/setup.exe',
      headers: { includeAuthorization: false },
    },
  );
});

test('the Node runtime strips bearer authentication across a cross-origin asset redirect', async (t) => {
  let receivedAuthorization = null;
  const target = createServer((request, response) => {
    receivedAuthorization = request.headers.authorization || null;
    response.end('asset');
  });
  await new Promise((resolve, reject) => {
    target.once('error', reject);
    target.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => target.close(resolve)));
  const targetPort = target.address().port;

  const source = createServer((_request, response) => {
    response.writeHead(302, { location: `http://localhost:${targetPort}/asset` });
    response.end();
  });
  await new Promise((resolve, reject) => {
    source.once('error', reject);
    source.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => source.close(resolve)));
  const sourcePort = source.address().port;

  const response = await fetch(`http://127.0.0.1:${sourcePort}/release`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(await response.text(), 'asset');
  assert.equal(receivedAuthorization, null);
});

test('desktop update downloads only an installer that matches its release checksum', async (t) => {
  resetDesktopUpdateStateForTesting();
  const cacheRoot = await createTempDirectory(t, 'rigorium-update-cache-');
  const installerBody = Buffer.from('verified Rigorium installer fixture');
  const sha256 = createHash('sha256').update(installerBody).digest('hex');
  const server = await createFixtureServer(t, installerBody, sha256);
  const installer = {
    id: 1,
    name: 'Rigorium-Setup-0.2.0.exe',
    size: installerBody.length,
    downloadUrl: `${server.origin}/installer`,
  };
  const checksum = {
    id: 2,
    name: `${installer.name}.sha256`,
    size: 65,
    downloadUrl: `${server.origin}/checksum`,
  };
  const status = {
    checkUnavailable: false,
    latest: {
      tagName: 'v0.2.0',
      version: '0.2.0',
      name: 'Rigorium v0.2.0',
      htmlUrl: 'https://example.invalid/release',
      assets: [installer, checksum],
      selectedAsset: installer,
    },
  };

  const started = await startDesktopUpdateDownload({
    status,
    env: { PILOTDECK_UPDATE_CACHE_DIR: cacheRoot },
  });
  assert.equal(started.state, 'downloading');
  const finished = await waitForDownload();
  assert.equal(finished.state, 'downloaded');
  assert.equal(finished.verified, true);
  assert.equal(finished.sha256, sha256);
  assert.equal(await readFile(finished.filePath, 'utf8'), installerBody.toString('utf8'));

  await writeFile(finished.filePath, 'replaced after download', 'utf8');
  assert.throws(
    () => launchDownloadedDesktopUpdate({ filePath: finished.filePath, env: { PILOTDECK_UPDATE_CACHE_DIR: cacheRoot } }),
    /changed after verification/u,
  );
});

test('checksum mismatch fails closed and removes the downloaded file', async (t) => {
  resetDesktopUpdateStateForTesting();
  const cacheRoot = await createTempDirectory(t, 'rigorium-update-mismatch-');
  const installerBody = Buffer.from('tampered installer fixture');
  const server = await createFixtureServer(t, installerBody, '0'.repeat(64));
  const installer = {
    name: 'Rigorium-Setup-0.3.0.exe',
    size: installerBody.length,
    downloadUrl: `${server.origin}/installer`,
  };
  await startDesktopUpdateDownload({
    status: {
      checkUnavailable: false,
      latest: {
        tagName: 'v0.3.0',
        version: '0.3.0',
        assets: [installer, { name: `${installer.name}.sha256`, downloadUrl: `${server.origin}/checksum` }],
        selectedAsset: installer,
      },
    },
    env: { PILOTDECK_UPDATE_CACHE_DIR: cacheRoot },
  });
  const finished = await waitForDownload();
  assert.equal(finished.state, 'failed');
  assert.equal(finished.verified, false);
  assert.match(finished.error, /SHA-256 mismatch/u);
  assert.equal(existsSync(finished.filePath), false);
  assert.equal(existsSync(`${finished.filePath}.download`), false);
});

test('stalled installer downloads time out and clean their partial file', async (t) => {
  resetDesktopUpdateStateForTesting();
  const cacheRoot = await createTempDirectory(t, 'rigorium-update-timeout-');
  const server = await createStalledFixtureServer(t, 'a'.repeat(64));
  const installer = {
    id: 3,
    name: 'Rigorium-Setup-0.3.1.exe',
    downloadUrl: `${server.origin}/installer`,
  };
  await startDesktopUpdateDownload({
    status: {
      checkUnavailable: false,
      latest: {
        tagName: 'v0.3.1',
        version: '0.3.1',
        assets: [installer, { id: 4, name: `${installer.name}.sha256`, downloadUrl: `${server.origin}/checksum` }],
        selectedAsset: installer,
      },
    },
    env: {
      PILOTDECK_UPDATE_CACHE_DIR: cacheRoot,
      RIGORIUM_UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS: '1000',
    },
  });
  const finished = await waitForDownload(5_000);
  assert.equal(finished.state, 'failed');
  assert.match(finished.error, /timed out while waiting for data/u);
  assert.equal(existsSync(finished.filePath), false);
  assert.equal(existsSync(`${finished.filePath}.download`), false);
});

test('assetId and assetName cannot bypass the current platform installer filter', async () => {
  resetDesktopUpdateStateForTesting();
  const asset = { id: 7, name: 'SHA256SUMS.txt', downloadUrl: 'https://example.invalid/SHA256SUMS.txt' };
  const incompatibleArch = process.arch === 'arm64' ? 'x64' : 'arm64';
  const wrongArchitectureInstaller = {
    id: 8,
    name: `Rigorium-Setup-0.4.0-${incompatibleArch}.exe`,
    downloadUrl: 'https://example.invalid/wrong-architecture.exe',
  };
  const status = {
    checkUnavailable: false,
    latest: {
      tagName: 'v0.4.0',
      version: '0.4.0',
      assets: [asset, wrongArchitectureInstaller],
      selectedAsset: asset,
    },
  };
  await assert.rejects(
    () => startDesktopUpdateDownload({ status, assetId: asset.id, env: {} }),
    /No compatible desktop installer asset/u,
  );
  await assert.rejects(
    () => startDesktopUpdateDownload({ status, assetName: asset.name, env: {} }),
    /No compatible desktop installer asset/u,
  );
  await assert.rejects(
    () => startDesktopUpdateDownload({ status, assetId: wrongArchitectureInstaller.id, env: {} }),
    /No compatible desktop installer asset/u,
  );
});

test('installer launch rejects files that were not verified by the active download job', async (t) => {
  resetDesktopUpdateStateForTesting();
  const cacheRoot = await createTempDirectory(t, 'rigorium-update-launch-');
  const filePath = join(cacheRoot, 'unverified.exe');
  await writeFile(filePath, 'not an installer', 'utf8');
  assert.throws(
    () => launchDownloadedDesktopUpdate({ filePath, env: { PILOTDECK_UPDATE_CACHE_DIR: cacheRoot } }),
    /has not passed SHA-256 verification/u,
  );
});

async function createTempDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    if (directory.startsWith(tmpdir())) await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function createFixtureServer(t, installerBody, sha256) {
  const server = createServer((request, response) => {
    if (request.url === '/installer') {
      response.writeHead(200, { 'content-length': installerBody.length, 'content-type': 'application/octet-stream' });
      response.end(installerBody);
      return;
    }
    if (request.url === '/checksum') {
      const body = `${sha256}\n`;
      response.writeHead(200, { 'content-length': Buffer.byteLength(body), 'content-type': 'text/plain' });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}` };
}

async function createStalledFixtureServer(t, sha256) {
  const server = createServer((request, response) => {
    if (request.url === '/installer') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.flushHeaders();
      return;
    }
    if (request.url === '/checksum') {
      const body = `${sha256}\n`;
      response.writeHead(200, { 'content-length': Buffer.byteLength(body), 'content-type': 'text/plain' });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}` };
}

async function waitForDownload(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const download = getDesktopDownloadStatus();
    if (['downloaded', 'failed', 'cancelled'].includes(download.state)) return download;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Desktop update did not reach a terminal state.');
}
