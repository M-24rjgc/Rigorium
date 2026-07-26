import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
} from 'fs';
import { rm } from 'fs/promises';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const USER_AGENT = 'Rigorium-Updater/0.1';
const CHECKSUM_MAX_BYTES = 1024 * 1024;
const DEFAULT_INSTALLER_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const HASH_BUFFER_BYTES = 1024 * 1024;

let cachedStatus = null;
let downloadJob = createIdleDownloadJob();
let downloadAbortController = null;

export function compareVersions(current, latest) {
  const currentParts = parseVersionParts(current);
  const latestParts = parseVersionParts(latest);
  const length = Math.max(currentParts.length, latestParts.length);

  for (let index = 0; index < length; index += 1) {
    const left = currentParts[index] ?? 0;
    const right = latestParts[index] ?? 0;
    if (left < right) return -1;
    if (left > right) return 1;
  }

  return 0;
}

export function parseVersionParts(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/^rigorium[-_ ]?/i, '')
    .replace(/^pilotdeck[-_ ]?/i, '')
    .replace(/^desktop[-_ ]?/i, '')
    .replace(/^v/i, '');
  const matches = normalized.match(/\d+/g);
  return matches?.map((part) => Number.parseInt(part, 10)).filter(Number.isFinite) ?? [0];
}

export function normalizeRepository(value) {
  const raw = String(value || '').trim().replace(/^git\+/i, '');
  if (!raw) return null;

  if (/^(?:https?|git|ssh):\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) return null;
      return normalizeRepositoryPath(url.pathname);
    } catch {
      return null;
    }
  }

  const sshMatch = raw.match(/^(?:git@)?github\.com:([^\s]+)$/i);
  if (sshMatch) return normalizeRepositoryPath(sshMatch[1]);
  return normalizeRepositoryPath(raw);
}

function normalizeRepositoryPath(value) {
  const parts = String(value || '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/');
  if (parts.length !== 2) return null;
  const [owner, repository] = parts;
  const validPart = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
  return validPart.test(owner) && validPart.test(repository) ? `${owner}/${repository}` : null;
}

export function mapGitHubRelease(release) {
  const tagName = String(release?.tag_name || '').trim();
  const version = tagName.replace(/^v/i, '') || String(release?.name || '').trim();
  const assets = Array.isArray(release?.assets)
    ? release.assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        size: asset.size,
        downloadUrl: asset.browser_download_url,
        contentType: asset.content_type,
        createdAt: asset.created_at,
        updatedAt: asset.updated_at,
        digest: asset.digest || null,
      }))
    : [];

  return {
    id: release?.id,
    tagName,
    version,
    name: release?.name || tagName,
    body: release?.body || '',
    htmlUrl: release?.html_url || '',
    publishedAt: release?.published_at || release?.created_at || null,
    prerelease: Boolean(release?.prerelease),
    draft: Boolean(release?.draft),
    assets,
  };
}

export function selectDesktopAsset(release, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const scored = assets
    .map((asset) => ({
      asset,
      score: scoreAsset(asset, platform, arch),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  return scored[0]?.asset ?? null;
}

export async function getCurrentDesktopVersion(options = {}) {
  const env = options.env || process.env;
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  const releaseMetadata = readReleaseMetadata(projectRoot);
  const packageVersion = readPackageVersion(projectRoot);
  const commit = await getCurrentCommit(projectRoot, env, releaseMetadata);
  const buildTime = await getBuildTime(projectRoot, env, releaseMetadata);

  return {
    version:
      firstNonEmpty(
        env.PILOTDECK_DESKTOP_VERSION,
        env.PILOTDECK_VERSION,
        env.APP_VERSION,
        env.npm_package_version,
        releaseMetadata?.version,
        packageVersion,
      ) || '0.0.0',
    buildTime,
    commit,
    platform: process.platform,
    arch: process.arch,
    desktop: env.PILOTDECK_DESKTOP === '1' || Boolean(env.PILOTDECK_DESKTOP_VERSION),
  };
}

export async function getDesktopUpdateStatus(options = {}) {
  const env = options.env || process.env;
  const force = Boolean(options.force);
  const now = options.now || new Date();

  if (!force && cachedStatus && Date.now() - cachedStatus.cachedAt < CACHE_TTL_MS) {
    return { ...cachedStatus.status, cached: true };
  }

  const current = await getCurrentDesktopVersion({ env, projectRoot: options.projectRoot });
  const repository = resolveUpdateRepository({ env, projectRoot: options.projectRoot || PROJECT_ROOT });

  if (!repository) {
    const status = {
      source: 'github-releases',
      scope: 'desktop',
      repository: null,
      status: 'unavailable',
      hasUpdate: false,
      updateAvailable: false,
      checkUnavailable: true,
      current,
      latest: null,
      lastCheckedAt: now.toISOString(),
      message: 'Rigorium update repository is not configured.',
    };
    cachedStatus = { cachedAt: Date.now(), status };
    return status;
  }

  try {
    const latest = await fetchLatestRelease({ env, repository, includePrerelease: shouldIncludePrerelease(env) });
    const selectedAsset = selectDesktopAsset(latest, {
      platform: options.platform || process.platform,
      arch: options.arch || process.arch,
    });
    const comparison = compareVersions(current.version, latest.version || latest.tagName);
    const hasUpdate = comparison < 0;
    const status = {
      source: 'github-releases',
      scope: 'desktop',
      repository,
      status: hasUpdate ? 'update-available' : 'up-to-date',
      hasUpdate,
      updateAvailable: hasUpdate,
      checkUnavailable: false,
      current,
      latest: {
        ...latest,
        selectedAsset,
      },
      lastCheckedAt: now.toISOString(),
    };

    cachedStatus = { cachedAt: Date.now(), status };
    return status;
  } catch (error) {
    const status = {
      source: 'github-releases',
      scope: 'desktop',
      repository,
      status: 'unavailable',
      hasUpdate: false,
      updateAvailable: false,
      checkUnavailable: true,
      current,
      latest: null,
      lastCheckedAt: now.toISOString(),
      message: error instanceof Error ? error.message : String(error),
    };
    cachedStatus = { cachedAt: Date.now(), status };
    return status;
  }
}

export async function listDesktopReleases(options = {}) {
  const env = options.env || process.env;
  const repository = resolveUpdateRepository({ env, projectRoot: options.projectRoot || PROJECT_ROOT });
  if (!repository) {
    throw new Error('Rigorium update repository is not configured.');
  }
  const limit = clampInteger(options.limit, 1, 30, 10);
  const releases = await fetchReleases({
    env,
    repository,
    limit,
    includePrerelease: options.includePrerelease ?? shouldIncludePrerelease(env),
  });
  return {
    source: 'github-releases',
    scope: 'desktop',
    repository,
    releases,
  };
}

export function getDesktopDownloadStatus() {
  return { ...downloadJob };
}

export async function startDesktopUpdateDownload(options = {}) {
  if (downloadJob.state === 'downloading') {
    const error = new Error('Desktop update download already in progress.');
    error.statusCode = 409;
    throw error;
  }

  const status = options.status || await getDesktopUpdateStatus({ force: options.force });
  if (status.checkUnavailable || !status.latest) {
    const error = new Error(status.message || 'Unable to resolve the latest desktop release.');
    error.statusCode = 503;
    throw error;
  }

  const asset = resolveDownloadAsset(status.latest, options);
  if (!asset) {
    const error = new Error('No compatible desktop installer asset was found for this platform.');
    error.statusCode = 404;
    throw error;
  }

  const env = options.env || process.env;
  const maxBytes = getInstallerDownloadLimit(env);
  const checksum = await resolveExpectedInstallerChecksum(status.latest, asset, env, status.repository);
  if (!checksum?.sha256) {
    const error = new Error('The release does not include a SHA-256 checksum for the selected installer.');
    error.statusCode = 422;
    throw error;
  }

  const destinationDir = getUpdateCacheDir(env, status.latest.tagName || status.latest.version);
  mkdirSync(destinationDir, { recursive: true });
  const destinationPath = path.join(destinationDir, sanitizeFilename(asset.name || 'pilotdeck-update'));
  const partialPath = `${destinationPath}.download`;
  await clearDownloadFiles(partialPath, destinationPath);

  downloadAbortController = new AbortController();
  downloadJob = {
    id: `${Date.now()}`,
    state: 'downloading',
    progress: 0,
    receivedBytes: 0,
    totalBytes: asset.size ?? null,
    asset,
    checksumAsset: checksum.asset,
    expectedSha256: checksum.sha256,
    sha256: null,
    verified: false,
    maxBytes,
    release: {
      tagName: status.latest.tagName,
      version: status.latest.version,
      name: status.latest.name,
      htmlUrl: status.latest.htmlUrl,
    },
    filePath: destinationPath,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };

  runDownload(asset, partialPath, destinationPath, {
    signal: downloadAbortController.signal,
    env,
    expectedSha256: checksum.sha256,
    maxBytes,
    repository: status.repository,
  })
    .then((result) => {
      downloadJob = {
        ...downloadJob,
        state: 'downloaded',
        progress: 1,
        receivedBytes: result.receivedBytes,
        totalBytes: result.totalBytes ?? downloadJob.totalBytes,
        sha256: result.sha256,
        verified: true,
        completedAt: new Date().toISOString(),
      };
      downloadAbortController = null;
    })
    .catch((error) => {
      downloadJob = {
        ...downloadJob,
        state: error?.name === 'AbortError' ? 'cancelled' : 'failed',
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      };
      downloadAbortController = null;
      removeDownloadFiles(partialPath, destinationPath).catch(() => {});
    });

  return getDesktopDownloadStatus();
}

export function cancelDesktopUpdateDownload() {
  if (downloadJob.state !== 'downloading' || !downloadAbortController) {
    return { cancelled: false, download: getDesktopDownloadStatus() };
  }
  downloadAbortController.abort();
  return { cancelled: true, download: getDesktopDownloadStatus() };
}

export function launchDownloadedDesktopUpdate(options = {}) {
  const filePath = options.filePath || downloadJob.filePath;
  if (!filePath || !existsSync(filePath)) {
    const error = new Error('No downloaded desktop update installer is available.');
    error.statusCode = 404;
    throw error;
  }
  if (downloadJob.state !== 'downloaded' || downloadJob.verified !== true || !downloadJob.sha256) {
    const error = new Error('The downloaded installer has not passed SHA-256 verification.');
    error.statusCode = 409;
    throw error;
  }

  const cacheRoot = getUpdateCacheRoot(options.env || process.env);
  const resolvedPath = path.resolve(filePath);
  const relativeToCache = path.relative(path.resolve(cacheRoot), resolvedPath);
  if (relativeToCache.startsWith('..') || path.isAbsolute(relativeToCache)) {
    const error = new Error('Installer path is outside the Rigorium update cache.');
    error.statusCode = 400;
    throw error;
  }
  if (path.resolve(downloadJob.filePath) !== resolvedPath) {
    const error = new Error('Installer path does not match the verified desktop update.');
    error.statusCode = 400;
    throw error;
  }
  if (!isLaunchableInstallerPath(resolvedPath, process.platform)) {
    const error = new Error('The verified release asset is not a launchable installer for this platform.');
    error.statusCode = 409;
    throw error;
  }

  assertInstallerFileIntegrity(resolvedPath, {
    expectedSha256: downloadJob.expectedSha256,
    expectedBytes: downloadJob.receivedBytes,
    maxBytes: downloadJob.maxBytes || getInstallerDownloadLimit(options.env || process.env),
  });

  const { command, args } = getOpenFileSpawnCommand(resolvedPath);
  const child = spawn(command, args, {
    cwd: path.dirname(resolvedPath),
    detached: true,
    stdio: 'ignore',
    windowsHide: process.platform === 'win32',
  });
  child.unref();
  child.on('error', () => {});

  return {
    launched: true,
    filePath: resolvedPath,
    needsRestart: true,
    message: 'Installer launched. Complete the installer flow, then restart Rigorium.',
  };
}

export function resetDesktopUpdateStateForTesting() {
  cachedStatus = null;
  downloadJob = createIdleDownloadJob();
  downloadAbortController = null;
}

async function fetchLatestRelease(options) {
  if (options.includePrerelease) {
    const releases = await fetchReleases({ ...options, limit: 10 });
    const release = releases.find((item) => !item.draft);
    if (!release) throw new Error('No GitHub releases are available.');
    return release;
  }

  const url = `https://api.github.com/repos/${options.repository}/releases/latest`;
  return mapGitHubRelease(await fetchJson(url, options.env));
}

async function fetchReleases(options) {
  const url = `https://api.github.com/repos/${options.repository}/releases?per_page=${options.limit}`;
  const releases = await fetchJson(url, options.env);
  if (!Array.isArray(releases)) {
    throw new Error('GitHub releases response was not a list.');
  }

  return releases
    .map(mapGitHubRelease)
    .filter((release) => !release.draft)
    .filter((release) => options.includePrerelease || !release.prerelease)
    .slice(0, options.limit);
}

async function fetchJson(url, env) {
  const timeoutMs = clampInteger(env.PILOTDECK_UPDATE_TIMEOUT_MS, 1_000, 120_000, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: createGitHubHeaders(env),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`GitHub release request failed (${response.status} ${response.statusText})`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBoundedText(url, env, maxBytes = CHECKSUM_MAX_BYTES, options = {}) {
  const timeoutMs = clampInteger(env.PILOTDECK_UPDATE_TIMEOUT_MS, 1_000, 120_000, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: createGitHubHeaders(env, options),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Checksum download failed (${response.status} ${response.statusText})`);
    const declaredLength = parseContentLength(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('Checksum response is too large.');
    if (!response.body) throw new Error('Checksum response did not include a body.');
    const chunks = [];
    let receivedBytes = 0;
    for await (const chunk of response.body) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) throw new Error('Checksum response is too large.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

function createGitHubHeaders(env, options = {}) {
  const token = firstNonEmpty(env.PILOTDECK_GITHUB_TOKEN, env.GITHUB_TOKEN);
  return {
    Accept: options.accept || 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    ...(token && options.includeAuthorization !== false ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function runDownload(asset, partialPath, destinationPath, options) {
  const { signal, env, expectedSha256, maxBytes, repository } = options;
  const request = resolveReleaseAssetRequest(asset, repository);
  const idleTimeout = createDownloadIdleTimeout(
    signal,
    clampInteger(
      env.RIGORIUM_UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS,
      1_000,
      MAX_DOWNLOAD_IDLE_TIMEOUT_MS,
      DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS,
    ),
  );
  let writer = null;

  try {
    const response = await fetch(request.url, {
      headers: createGitHubHeaders(env, request.headers),
      signal: idleTimeout.signal,
    });
    idleTimeout.touch();
    if (!response.ok) {
      throw new Error(`Installer download failed (${response.status} ${response.statusText})`);
    }
    if (!response.body) {
      throw new Error('Installer download response did not include a body.');
    }

    const totalBytes = parseContentLength(response.headers.get('content-length'));
    if (Number.isFinite(totalBytes) && totalBytes > maxBytes) {
      throw new Error(`Installer exceeds the configured download limit (${maxBytes} bytes).`);
    }
    writer = createWriteStream(partialPath, { flags: 'wx' });
    const hash = createHash('sha256');
    let writeError = null;
    writer.on('error', (error) => {
      writeError = error;
    });
    let receivedBytes = 0;

    for await (const chunk of response.body) {
      idleTimeout.touch();
      if (writeError) throw writeError;
      if (signal.aborted) {
        const error = new Error('Download cancelled.');
        error.name = 'AbortError';
        throw error;
      }

      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) throw new Error(`Installer exceeds the configured download limit (${maxBytes} bytes).`);
      hash.update(chunk);
      downloadJob = {
        ...downloadJob,
        receivedBytes,
        totalBytes: Number.isFinite(totalBytes) ? totalBytes : downloadJob.totalBytes,
        progress: Number.isFinite(totalBytes) && totalBytes > 0
          ? Math.min(receivedBytes / totalBytes, 0.999)
          : 0,
      };

      if (!writer.write(chunk)) {
        await waitForDrain(writer);
      }
    }

    if (writeError) throw writeError;
    await finishWriter(writer);
    writer = null;
    const sha256 = hash.digest('hex');
    if (sha256 !== expectedSha256) {
      throw new Error(`Installer SHA-256 mismatch (expected ${expectedSha256}, received ${sha256}).`);
    }
    renameSync(partialPath, destinationPath);
    return {
      receivedBytes,
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
      sha256,
    };
  } catch (error) {
    if (writer) await destroyWriter(writer);
    await removeDownloadFiles(partialPath, destinationPath);
    if (idleTimeout.timedOut()) {
      const timeoutError = new Error('Installer download timed out while waiting for data.');
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw error;
  } finally {
    idleTimeout.dispose();
  }
}

function finishWriter(writer) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      writer.off('close', onClose);
      reject(error);
    };
    const onClose = () => {
      writer.off('error', onError);
      resolve();
    };
    writer.once('error', onError);
    writer.once('close', onClose);
    writer.end();
  });
}

function waitForDrain(writer) {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      writer.off('error', onError);
      resolve();
    };
    const onError = (error) => {
      writer.off('drain', onDrain);
      reject(error);
    };
    writer.once('drain', onDrain);
    writer.once('error', onError);
  });
}

function destroyWriter(writer) {
  if (writer.closed || writer.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    writer.once('close', resolve);
    writer.destroy();
  });
}

function createDownloadIdleTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  let timedOut = false;
  const onAbort = () => controller.abort(signal.reason);
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      const error = new Error('Installer download timed out while waiting for data.');
      error.name = 'TimeoutError';
      controller.abort(error);
    }, timeoutMs);
  };

  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  arm();

  return {
    signal: controller.signal,
    touch: () => {
      if (!controller.signal.aborted) arm();
    },
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function parseContentLength(value) {
  const text = String(value || '').trim();
  if (!/^\d+$/u.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function getInstallerDownloadLimit(env) {
  return clampInteger(
    env.RIGORIUM_UPDATE_MAX_BYTES,
    1024 * 1024,
    DEFAULT_INSTALLER_MAX_BYTES,
    DEFAULT_INSTALLER_MAX_BYTES,
  );
}

async function clearDownloadFiles(partialPath, destinationPath) {
  await Promise.all([
    rm(partialPath, { force: true, maxRetries: 3, retryDelay: 100 }),
    rm(destinationPath, { force: true, maxRetries: 3, retryDelay: 100 }),
  ]);
  if (existsSync(partialPath) || existsSync(destinationPath)) {
    throw new Error('Unable to clear a previous desktop update download.');
  }
}

async function removeDownloadFiles(partialPath, destinationPath) {
  await Promise.allSettled([
    rm(partialPath, { force: true, maxRetries: 3, retryDelay: 100 }),
    rm(destinationPath, { force: true, maxRetries: 3, retryDelay: 100 }),
  ]);
}

function assertInstallerFileIntegrity(filePath, options) {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    const error = new Error('The verified desktop update installer is no longer available.');
    error.statusCode = 404;
    throw error;
  }
  if (!stats.isFile()) {
    const error = new Error('The verified desktop update installer is not a file.');
    error.statusCode = 409;
    throw error;
  }
  if (stats.size > options.maxBytes || stats.size !== options.expectedBytes) {
    const error = new Error('The downloaded installer changed after verification.');
    error.statusCode = 409;
    throw error;
  }
  const sha256 = hashFileSha256(filePath);
  if (sha256 !== options.expectedSha256 || sha256 !== downloadJob.sha256) {
    const error = new Error('The downloaded installer changed after verification.');
    error.statusCode = 409;
    throw error;
  }
}

function hashFileSha256(filePath) {
  const handle = openSync(filePath, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    let offset = 0;
    while (true) {
      const bytesRead = readSync(handle, buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest('hex');
}

function getOpenFileSpawnCommand(filePath, platform = process.platform) {
  if (platform === 'win32') {
    return { command: filePath, args: [] };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [filePath] };
  }
  return { command: 'xdg-open', args: [filePath] };
}

function resolveDownloadAsset(release, options = {}) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  let candidate = null;
  if (options.assetId !== undefined && options.assetId !== null && options.assetId !== '') {
    const id = Number(options.assetId);
    candidate = assets.find((asset) => Number(asset.id) === id) ?? null;
  } else if (options.assetName) {
    candidate = assets.find((asset) => asset.name === options.assetName) ?? null;
  } else if (release?.selectedAsset) {
    candidate = assets.find((asset) => Number(asset.id) === Number(release.selectedAsset.id))
      || assets.find((asset) => asset.name === release.selectedAsset.name)
      || null;
  }

  candidate ||= selectDesktopAsset(release, { platform: process.platform, arch: process.arch });
  return isCompatibleDesktopInstallerAsset(candidate, process.platform, process.arch) ? candidate : null;
}

export function resolveReleaseAssetRequest(asset, repository) {
  const assetId = Number(asset?.id);
  const normalizedRepository = normalizeRepository(repository);
  if (normalizedRepository && Number.isSafeInteger(assetId) && assetId > 0) {
    return {
      url: `https://api.github.com/repos/${normalizedRepository}/releases/assets/${assetId}`,
      headers: { accept: 'application/octet-stream' },
    };
  }

  const downloadUrl = String(asset?.downloadUrl || '').trim();
  if (!/^https?:\/\//i.test(downloadUrl)) {
    throw new Error('Release asset does not provide a valid download URL.');
  }
  return {
    url: downloadUrl,
    // Browser download URLs may redirect to an asset CDN. Never leak a GitHub token to that initial URL.
    headers: { includeAuthorization: false },
  };
}

export function selectChecksumAsset(release, installerAsset) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const installerName = String(installerAsset?.name || '');
  if (!installerName) return null;
  const names = [
    `${installerName}.sha256`,
    `${installerName}.sha256.txt`,
    'SHA256SUMS.txt',
    'sha256sums.txt',
  ];
  for (const name of names) {
    const match = assets.find((asset) => String(asset?.name || '').toLowerCase() === name.toLowerCase());
    if (match) return match;
  }
  return null;
}

export function parseInstallerSha256(value, installerName, options = {}) {
  const text = String(value || '').replace(/^\uFEFF/u, '');
  const bare = text.trim().match(/^([a-fA-F0-9]{64})$/u);
  if (bare && options.allowBare !== false) return bare[1].toLowerCase();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/u);
    if (match && match[2].trim() === installerName) return match[1].toLowerCase();
  }
  return null;
}

async function resolveExpectedInstallerChecksum(release, installerAsset, env, repository) {
  const digest = String(installerAsset?.digest || '').match(/^sha256:([a-fA-F0-9]{64})$/u);
  if (digest) return { sha256: digest[1].toLowerCase(), asset: null };
  const checksumAsset = selectChecksumAsset(release, installerAsset);
  if (!checksumAsset) return null;
  const request = resolveReleaseAssetRequest(checksumAsset, repository);
  const manifest = await fetchBoundedText(request.url, env, CHECKSUM_MAX_BYTES, request.headers);
  const sha256 = parseInstallerSha256(manifest, installerAsset.name, {
    allowBare: isDedicatedChecksumAsset(checksumAsset, installerAsset),
  });
  return sha256 ? { sha256, asset: checksumAsset } : null;
}

function isDedicatedChecksumAsset(checksumAsset, installerAsset) {
  const checksumName = String(checksumAsset?.name || '').toLowerCase();
  const installerName = String(installerAsset?.name || '').toLowerCase();
  return checksumName === `${installerName}.sha256` || checksumName === `${installerName}.sha256.txt`;
}

function scoreAsset(asset, platform, arch) {
  const name = String(asset?.name || '').toLowerCase();
  if (!name || /\.(?:blockmap|yml|yaml|sha256|sha512|sig|asc|txt)$/i.test(name)) return 0;
  if (/source[ -_]?code/.test(name)) return 0;
  if (!isLaunchableInstallerPath(name, platform)) return 0;
  if (!isCompatibleAssetArch(name, arch)) return 0;

  const platformScore = scorePlatform(name, platform);
  if (platformScore <= 0) return 0;

  return platformScore + scoreExtension(name, platform) + scoreArch(name, arch);
}

function scorePlatform(name, platform) {
  if (platform === 'darwin') {
    if (/(mac|macos|darwin|osx|\.dmg$|\.pkg$)/.test(name)) return 100;
    return 0;
  }
  if (platform === 'win32') {
    if (/(win|windows|setup|installer|\.exe$|\.msi$)/.test(name)) return 100;
    return 0;
  }
  if (platform === 'linux') {
    if (/(linux|appimage|\.deb$|\.rpm$|\.tar\.gz$)/.test(name)) return 100;
    return 0;
  }
  return 0;
}

function scoreExtension(name, platform) {
  const priorities = {
    darwin: [['.dmg', 40], ['.pkg', 35]],
    win32: [['.exe', 40]],
    linux: [['.appimage', 40], ['.deb', 35], ['.rpm', 30]],
  };
  return priorities[platform]?.find(([extension]) => name.endsWith(extension))?.[1] ?? 0;
}

function isCompatibleDesktopInstallerAsset(asset, platform, arch) {
  return Boolean(asset) && scoreAsset(asset, platform, arch) > 0;
}

function isCompatibleAssetArch(name, arch) {
  if (/(?:^|[._-])(?:universal|all)(?:[._-]|$)/u.test(name)) return true;
  let assetArch = null;
  if (/(?:^|[._-])(?:arm64|aarch64)(?:[._-]|$)/u.test(name)) assetArch = 'arm64';
  else if (/(?:^|[._-])(?:x64|x86_64|amd64)(?:[._-]|$)/u.test(name)) assetArch = 'x64';
  else if (/(?:^|[._-])(?:ia32|i386|x86)(?:[._-]|$)/u.test(name)) assetArch = 'ia32';
  return assetArch === null || assetArch === arch;
}

function isLaunchableInstallerPath(filePath, platform) {
  const name = String(filePath || '').toLowerCase();
  if (platform === 'win32') return name.endsWith('.exe');
  if (platform === 'darwin') return name.endsWith('.dmg') || name.endsWith('.pkg');
  if (platform === 'linux') return name.endsWith('.appimage') || name.endsWith('.deb') || name.endsWith('.rpm');
  return false;
}

function scoreArch(name, arch) {
  if (/(universal|all)/.test(name)) return 20;
  if (arch === 'arm64') return /(arm64|aarch64)/.test(name) ? 25 : 0;
  if (arch === 'x64') return /(x64|x86_64|amd64)/.test(name) ? 25 : 0;
  if (arch === 'ia32') return /(ia32|x86|i386)/.test(name) ? 25 : 0;
  return 0;
}

function readPackageVersion(projectRoot) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    return parsed.version || null;
  } catch {
    return null;
  }
}

function readPackageMetadata(projectRoot) {
  try {
    return JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readReleaseMetadata(projectRoot) {
  try {
    const metadata = JSON.parse(readFileSync(path.join(projectRoot, 'dist', 'release-metadata.json'), 'utf8'));
    return metadata?.schemaVersion === 1 ? metadata : null;
  } catch {
    return null;
  }
}

export function resolveUpdateRepository(options = {}) {
  const env = options.env || process.env;
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  const releaseMetadata = readReleaseMetadata(projectRoot);
  const packageMetadata = readPackageMetadata(projectRoot);
  const configured = firstNonEmpty(
    env.RIGORIUM_UPDATE_REPOSITORY,
    env.PILOTDECK_UPDATE_REPOSITORY,
    env.PILOTDECK_RELEASE_REPOSITORY,
    releaseMetadata?.repository,
    typeof packageMetadata?.repository === 'string' ? packageMetadata.repository : packageMetadata?.repository?.url,
  );
  return normalizeRepository(configured);
}

async function getCurrentCommit(projectRoot, env, releaseMetadata) {
  const fromEnv = firstNonEmpty(env.PILOTDECK_COMMIT_SHA, env.GIT_COMMIT, env.VERCEL_GIT_COMMIT_SHA);
  if (fromEnv) return fromEnv;
  if (releaseMetadata?.commit) return releaseMetadata.commit;

  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getBuildTime(projectRoot, env, releaseMetadata) {
  const fromEnv = firstNonEmpty(
    env.PILOTDECK_DESKTOP_BUILD_TIME,
    env.PILOTDECK_BUILD_TIME,
    env.BUILD_TIME,
    env.npm_package_build_time,
  );
  if (fromEnv) return fromEnv;
  if (releaseMetadata?.buildTime) return releaseMetadata.buildTime;

  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%cI', 'HEAD'], { cwd: projectRoot });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function shouldIncludePrerelease(env) {
  return env.PILOTDECK_UPDATE_INCLUDE_PRERELEASE === '1'
    || env.PILOTDECK_UPDATE_CHANNEL === 'beta'
    || env.PILOTDECK_UPDATE_CHANNEL === 'nightly';
}

function getUpdateCacheRoot(env) {
  return env.PILOTDECK_UPDATE_CACHE_DIR
    ? path.resolve(env.PILOTDECK_UPDATE_CACHE_DIR)
    : path.join(os.homedir(), '.pilotdeck', 'updates');
}

function getUpdateCacheDir(env, releaseName) {
  return path.join(getUpdateCacheRoot(env), sanitizeFilename(releaseName || 'latest'));
}

function sanitizeFilename(value) {
  return String(value || 'download')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+$/, 'download')
    .trim() || 'download';
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function createIdleDownloadJob() {
  return {
    id: null,
    state: 'idle',
    progress: 0,
    receivedBytes: 0,
    totalBytes: null,
    asset: null,
    checksumAsset: null,
    expectedSha256: null,
    sha256: null,
    verified: false,
    release: null,
    filePath: null,
    startedAt: null,
    completedAt: null,
    error: null,
  };
}
