import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

const requestedTag = process.env.RIGORIUM_PUBLIC_RELEASE_TAG || process.argv[2];
const currentVersion = process.env.RIGORIUM_PUBLIC_CURRENT_VERSION || process.argv[3];
const repository = process.env.RIGORIUM_UPDATE_REPOSITORY || 'M-24rjgc/Rigorium';

assert.match(requestedTag || '', /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, 'A semantic release tag is required.');
assert.match(currentVersion || '', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, 'The simulated current version is required.');

const temporaryRoot = resolve(tmpdir());
const cacheRoot = await mkdtemp(join(temporaryRoot, 'rigorium-public-update-'));
assertSafeProbeDirectory(cacheRoot);

process.env.RIGORIUM_DESKTOP = '1';
process.env.RIGORIUM_DESKTOP_VERSION = currentVersion;
process.env.RIGORIUM_UPDATE_REPOSITORY = repository;
process.env.RIGORIUM_UPDATE_CACHE_DIR = cacheRoot;

const { default: updateRouter } = await import('../ui/server/routes/update.js');
const app = express();
app.use(express.json());
app.use('/api/update', updateRouter);

const server = createServer(app);
let origin = null;

try {
  origin = await listen(server);
  const status = await requestJson('/api/update/desktop/check', { method: 'POST' });
  assert.equal(status.status, 200, `status check failed: ${status.body?.message || status.status}`);
  assert.equal(status.body?.repository, repository);
  // The check resolves the *latest* public release. A newer release published
  // after the requested one supersedes it — that is a healthy chain, not a
  // failure. Fail only when the public latest is OLDER than the requested
  // tag (the requested release is no longer the newest — broken chain).
  const verifiedTag = status.body?.latest?.tagName;
  assert.match(verifiedTag || '', /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, 'the latest release must be a semantic version');
  assert.ok(
    semverGte(verifiedTag, requestedTag),
    `expected the public latest (${verifiedTag}) to be >= the requested tag (${requestedTag})`,
  );
  assert.equal(status.body?.hasUpdate, true, `expected ${requestedTag} to be newer than ${currentVersion}`);
  assert.equal(status.body?.checkUnavailable, false, status.body?.message || 'no compatible installer is available');
  assert.ok(status.body?.latest?.selectedAsset, 'no compatible installer asset was selected');

  const started = await requestJson('/api/update/desktop/download', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force: true }),
  });
  assert.equal(started.status, 202, `download start failed: ${started.body?.message || started.status}`);

  const download = await waitForTerminalDownload();
  assert.equal(download.state, 'downloaded', download.error || 'installer download did not finish');
  assert.equal(download.verified, true, 'service did not mark the installer as verified');
  assert.equal(download.sha256, download.expectedSha256, 'service checksum differs from the expected checksum');
  assert.ok(download.filePath, 'service did not report a downloaded installer path');

  const installerPath = resolve(download.filePath);
  assertContainedIn(cacheRoot, installerPath, 'installer path');
  const [installerStats, actualSha256] = await Promise.all([stat(installerPath), hashFile(installerPath)]);
  assert.equal(installerStats.size, download.receivedBytes, 'installer size differs from streamed byte count');
  assert.equal(actualSha256, download.expectedSha256, 'independent SHA-256 calculation failed');

  console.log(JSON.stringify({
    result: 'verified-public-update-download',
    repository,
    requestedTag,
    tag: status.body.latest.tagName,
    asset: status.body.latest.selectedAsset.name,
    bytes: installerStats.size,
    sha256: actualSha256,
  }, null, 2));
} finally {
  if (origin) await cancelActiveDownload();
  await close(server);
  assertSafeProbeDirectory(cacheRoot);
  await rm(cacheRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  assert.equal(existsSync(cacheRoot), false, 'probe cache cleanup failed');
}

/** True when `tagA` is >= `tagB` in semantic-version order (prerelease-aware). */
function semverGte(tagA, tagB) {
  const parse = (tag) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/u.exec(String(tag ?? '').trim());
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? '' };
  };
  const a = parse(tagA);
  const b = parse(tagB);
  if (!a || !b) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  if (a.pre === b.pre) return true;
  if (a.pre === '') return true; // release > prerelease
  if (b.pre === '') return false;
  return a.pre >= b.pre;
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, options);
  return { status: response.status, body: await response.json() };
}

async function waitForTerminalDownload(timeoutMs = 20 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let nextProgressReport = 0;
  while (Date.now() < deadline) {
    const result = await requestJson('/api/update/desktop/download/status');
    assert.equal(result.status, 200, `download status failed: ${result.status}`);
    const download = result.body?.download;
    if (['downloaded', 'failed', 'cancelled'].includes(download?.state)) return download;
    if (Date.now() >= nextProgressReport) {
      console.log(`Public update download: ${download?.receivedBytes || 0}/${download?.totalBytes || 0} bytes`);
      nextProgressReport = Date.now() + 30_000;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 500));
  }
  throw new Error('public installer download did not reach a terminal state within 20 minutes');
}

async function cancelActiveDownload() {
  try {
    const active = await requestJson('/api/update/desktop/download/status');
    if (active.body?.download?.state === 'downloading') {
      await requestJson('/api/update/desktop/download/cancel', { method: 'POST' });
      await waitForTerminalDownload(15_000).catch(() => {});
    }
  } catch {
    // The dedicated cache is removed after the local verification server closes.
  }
}

function hashFile(filePath) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const input = createReadStream(filePath);
    input.once('error', rejectHash);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('end', () => resolveHash(hash.digest('hex')));
  });
}

function assertSafeProbeDirectory(candidate) {
  const relativePath = relative(temporaryRoot, candidate);
  assert.ok(relativePath.startsWith('rigorium-public-update-'), 'probe cache must use its dedicated prefix');
  assert.equal(relativePath.includes(sep), false, 'probe cache must be a direct child of the system temp directory');
}

function assertContainedIn(parent, candidate, label) {
  const relativePath = relative(resolve(parent), resolve(candidate));
  assert.ok(relativePath && !relativePath.startsWith('..') && !relativePath.includes(`${sep}..${sep}`) && !isAbsolute(relativePath), `${label} is outside the probe cache`);
}

function listen(instance) {
  return new Promise((resolveOrigin, rejectListen) => {
    instance.once('error', rejectListen);
    instance.listen(0, '127.0.0.1', () => {
      instance.off('error', rejectListen);
      const address = instance.address();
      resolveOrigin(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(instance) {
  if (!instance.listening) return Promise.resolve();
  return new Promise((resolveClose) => instance.close(resolveClose));
}
