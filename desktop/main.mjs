import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { startZoteroBroker } from './zotero-broker.mjs';

const STARTUP_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 8_000;
const LOCAL_HOST = '127.0.0.1';
const isSmokeTest = process.argv.includes('--smoke-test');
const isWindowSmokeTest = process.argv.includes('--window-smoke-test');
const isResearchVerification = process.argv.includes('--verify-research');
const shouldRunLiveArxivVerification = isResearchVerification && process.env.RIGORIUM_VERIFY_ARXIV_LIVE === '1';

let gatewayProcess;
let uiProcess;
let mainWindow;
let isQuitting = false;
let uiPort;
let zoteroBrokerServer;
let zoteroBrokerUrl;
let zoteroBrokerToken;
let zoteroCloudRouteToken;

const ZOTERO_CREDENTIALS_DIRECTORY = 'research';
const ZOTERO_CREDENTIALS_FILENAME = 'credentials.v1.json';
const ZOTERO_CLOUD_SESSION_HEADER = 'x-rigorium-zotero-cloud-session';
const ZOTERO_CLOUD_MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
const RESEARCH_VERIFICATION_DIRECTORY = 'verification';
const ARXIV_VERIFICATION_REPORT_FILENAME = 'arxiv-adapter.v1.json';

function zoteroCredentialsPath() {
  return join(app.getPath('userData'), ZOTERO_CREDENTIALS_DIRECTORY, ZOTERO_CREDENTIALS_FILENAME);
}

function parseStoredZoteroCredentials() {
  const credentialsPath = zoteroCredentialsPath();
  if (!existsSync(credentialsPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    if (!parsed || parsed.version !== 1 || typeof parsed.ciphertext !== 'string' || parsed.ciphertext.length === 0) {
      return undefined;
    }
    const ciphertext = Buffer.from(parsed.ciphertext, 'base64');
    if (ciphertext.length === 0 || ciphertext.toString('base64') !== parsed.ciphertext) return undefined;
    return ciphertext;
  } catch {
    return undefined;
  }
}

function readStoredZoteroApiKey() {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  const ciphertext = parseStoredZoteroCredentials();
  if (!ciphertext) return undefined;
  try {
    return safeStorage.decryptString(ciphertext);
  } catch {
    return undefined;
  }
}

function zoteroCredentialStatus() {
  const encryptionAvailable = safeStorage.isEncryptionAvailable();
  return {
    encryptionAvailable,
    configured: encryptionAvailable && Boolean(readStoredZoteroApiKey()),
  };
}

function validateZoteroApiKey(value) {
  if (typeof value !== 'string' || value !== value.trim() || !/^[A-Za-z0-9_-]{16,256}$/.test(value)) {
    throw new Error('Enter a valid Zotero API key.');
  }
  return value;
}

function saveZoteroApiKey(value) {
  const apiKey = validateZoteroApiKey(value);
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this device.');
  }
  const encrypted = safeStorage.encryptString(apiKey).toString('base64');
  const credentialsPath = zoteroCredentialsPath();
  mkdirSync(join(app.getPath('userData'), ZOTERO_CREDENTIALS_DIRECTORY), { recursive: true });
  writeFileSync(credentialsPath, `${JSON.stringify({ version: 1, ciphertext: encrypted })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return zoteroCredentialStatus();
}

function clearZoteroApiKey(options) {
  if (!options || options.confirmed !== true) {
    throw new Error('Credential removal requires explicit confirmation.');
  }
  const credentialsPath = zoteroCredentialsPath();
  if (existsSync(credentialsPath)) unlinkSync(credentialsPath);
  return zoteroCredentialStatus();
}

function assertTrustedMainWindowCaller(event) {
  if (
    event.sender !== mainWindow?.webContents
    || event.senderFrame !== mainWindow?.webContents.mainFrame
    || !isTrustedAppPageUrl(event.senderFrame?.url || '')
  ) {
    throw new Error('Zotero access is limited to the main Rigorium application.');
  }
}

function registerZoteroIpc() {
  ipcMain.handle('rigorium:zotero-credentials:status', (event) => {
    assertTrustedMainWindowCaller(event);
    return zoteroCredentialStatus();
  });
  ipcMain.handle('rigorium:zotero-credentials:save', (event, apiKey) => {
    assertTrustedMainWindowCaller(event);
    return saveZoteroApiKey(apiKey);
  });
  ipcMain.handle('rigorium:zotero-credentials:clear', (event, options) => {
    assertTrustedMainWindowCaller(event);
    return clearZoteroApiKey(options);
  });
  ipcMain.handle('rigorium:zotero-cloud:status', (event, options) => {
    assertTrustedMainWindowCaller(event);
    return requestDesktopZotero('cloud/status', { query: normalizeCloudOptions(options) });
  });
  ipcMain.handle('rigorium:zotero-cloud:sync', (event, options) => {
    assertTrustedMainWindowCaller(event);
    const normalized = normalizeCloudOptions(options);
    const sinceVersion = options?.sinceVersion;
    if (sinceVersion !== undefined && (!Number.isSafeInteger(sinceVersion) || sinceVersion < 0)) {
      throw new Error('Zotero sync version must be a non-negative integer.');
    }
    return requestDesktopZotero('cloud/sync', {
      query: { ...normalized, ...(sinceVersion === undefined ? {} : { sinceVersion: String(sinceVersion) }) },
    });
  });
  ipcMain.handle('rigorium:zotero-cloud:preview', (event, intent, options) => {
    assertTrustedMainWindowCaller(event);
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
      throw new Error('A Zotero cloud write intent is required.');
    }
    return requestDesktopZotero('cloud/writes/preview', {
      method: 'POST',
      body: { ...normalizeCloudOptions(options), intent },
    });
  });
  ipcMain.handle('rigorium:zotero-cloud:confirm', (event, plan, options) => {
    assertTrustedMainWindowCaller(event);
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      throw new Error('A reviewed Zotero cloud write plan is required.');
    }
    return requestDesktopZotero('cloud/writes/confirm', {
      method: 'POST',
      body: { ...normalizeCloudOptions(options), plan, confirmed: true },
    });
  });
  ipcMain.handle('rigorium:zotero-library:import', (event, papers, options) => {
    assertTrustedMainWindowCaller(event);
    if (!Array.isArray(papers) || papers.length < 1 || papers.length > 50) {
      throw new Error('Select between 1 and 50 papers to import into Zotero.');
    }
    return requestDesktopZotero('import', {
      method: 'POST',
      body: { ...normalizeCloudOptions(options), papers, confirmed: true },
    });
  });
}

function normalizeCloudOptions(value) {
  const projectPath = value?.projectPath;
  if (projectPath === undefined || projectPath === null || projectPath === '') return {};
  if (typeof projectPath !== 'string' || projectPath.length > 32_768 || projectPath !== projectPath.trim()) {
    throw new Error('The Zotero project path is invalid.');
  }
  return { projectPath };
}

async function requestDesktopZotero(path, options = {}) {
  if (!uiPort || !zoteroCloudRouteToken) throw new Error('The desktop Zotero service is not ready.');
  const url = new URL(`/api/research/zotero/${path}`, `http://${LOCAL_HOST}:${uiPort}`);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  const request = {
    method: options.method ?? 'GET',
    headers: { [ZOTERO_CLOUD_SESSION_HEADER]: zoteroCloudRouteToken },
  };
  if (options.body !== undefined) {
    const body = JSON.stringify(options.body);
    if (body.length > 512 * 1024) throw new Error('The Zotero desktop request is too large.');
    request.headers['content-type'] = 'application/json';
    request.body = body;
  }

  let response;
  try {
    response = await fetch(url, request);
  } catch {
    throw new Error('Unable to contact the local Zotero service.');
  }
  const text = await response.text();
  if (text.length > ZOTERO_CLOUD_MAX_RESPONSE_CHARS) throw new Error('The Zotero desktop response is too large.');
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('The Zotero desktop service returned an invalid response.');
  }
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error.slice(0, 400) : 'Zotero desktop request failed.';
    throw new Error(message);
  }
  return payload;
}

function writeDesktopLog(label, value) {
  try {
    const logDirectory = app.getPath('userData');
    mkdirSync(logDirectory, { recursive: true });
    appendFileSync(
      join(logDirectory, 'desktop.log'),
      `[${new Date().toISOString()}] [${label}] ${String(value).trimEnd()}\n`,
      'utf8',
    );
  } catch {
    // Logging must never interfere with the desktop runtime.
  }
}

/**
 * This checks the exact main-process module path that Electron Builder places
 * in app.asar. It is deliberately only reachable through --verify-research:
 * no IPC or renderer API is added for this diagnostic.
 */
async function verifyResearchArxivAdapter() {
  const appRoot = app.getAppPath();
  const appPathType = appRoot.toLowerCase().endsWith('.asar') ? 'asar' : 'directory';
  const adapterPath = join(appRoot, 'dist', 'src', 'research', 'literature', 'arxivSource.js');
  const parserManifestPath = join(appRoot, 'node_modules', '@rgrove', 'parse-xml', 'package.json');
  const fixturePath = join(appRoot, 'desktop', 'fixtures', 'arxiv-packaged-verification.atom');

  const parserManifest = JSON.parse(readFileSync(parserManifestPath, 'utf8'));
  assertResearchVerification(parserManifest?.name === '@rgrove/parse-xml', 'The packaged parser manifest name is invalid.');
  assertResearchVerification(parserManifest?.version === '4.2.2', 'The packaged parser version is not the pinned 4.2.2 release.');

  const adapter = await import(pathToFileURL(adapterPath).href);
  assertResearchVerification(typeof adapter.createArxivSource === 'function', 'The packaged arXiv adapter did not export createArxivSource.');
  const fixture = readFileSync(fixturePath, 'utf8');
  const requestedUrls = [];
  const source = adapter.createArxivSource({
    endpoint: 'https://verification.invalid/arxiv',
    timeoutMs: 5_000,
    minimumIntervalMs: 1,
    fetchImpl: async (input) => {
      requestedUrls.push(String(input));
      return new Response(fixture, {
        status: 200,
        headers: {
          'content-length': String(Buffer.byteLength(fixture, 'utf8')),
          'content-type': 'application/atom+xml; charset=utf-8',
        },
      });
    },
  });
  const result = await source.search({
    query: 'packaged arXiv adapter verification',
    limit: 1,
    fromYear: 2024,
    toYear: 2024,
    sort: 'publication_date',
    classifications: [{ scheme: 'arxiv', include: ['cs.AI'] }],
    sourceIds: ['arxiv'],
  });

  const paper = result.papers[0];
  assertResearchVerification(requestedUrls.length === 1, 'The local Atom fixture was not requested exactly once.');
  const requestUrl = new URL(requestedUrls[0]);
  assertResearchVerification(requestUrl.hostname === 'verification.invalid', 'The verification adapter attempted to use a non-local endpoint.');
  assertResearchVerification(requestUrl.searchParams.get('sortBy') === 'submittedDate', 'The packaged adapter did not apply its production date-sort mapping.');
  assertResearchVerification(
    requestUrl.searchParams.get('search_query')?.includes('submittedDate:[202401010000 TO 202412312359]'),
    'The packaged adapter did not apply its production submitted-date bounds.',
  );
  assertResearchVerification(result.source.id === 'arxiv' && result.source.status === 'ok', 'The fixture did not produce an arXiv success result.');
  assertResearchVerification(result.edges.length === 0, 'The arXiv adapter fabricated citation edges for the fixture.');
  assertResearchVerification(result.papers.length === 1 && Boolean(paper), 'The fixture did not produce exactly one normalized paper.');
  assertResearchVerification(paper?.sourceId === 'arxiv', 'The normalized fixture paper has the wrong source ID.');
  assertResearchVerification(paper?.identity.arxiv === '2401.24680', 'The fixture arXiv identifier was not normalized.');
  assertResearchVerification(paper?.identity.arxivVersion === 3, 'The fixture arXiv version was not parsed.');
  assertResearchVerification(paper?.title === 'Controlled Atom & parser verification', 'The fixture title was not parsed from Atom XML.');
  assertResearchVerification(
    JSON.stringify(paper?.topics.map((topic) => topic.name)) === JSON.stringify(['cs.AI', 'cs.LG']),
    'The fixture categories were not parsed from Atom XML.',
  );
  const live = shouldRunLiveArxivVerification
    ? await verifyResearchArxivLiveSource(adapter)
    : { requested: false };

  const reportDirectory = join(app.getPath('userData'), ZOTERO_CREDENTIALS_DIRECTORY, RESEARCH_VERIFICATION_DIRECTORY);
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(join(reportDirectory, ARXIV_VERIFICATION_REPORT_FILENAME), `${JSON.stringify({
    schemaVersion: 1,
    packaged: app.isPackaged,
    appPathType,
    adapterLoadedFromAppAsar: appPathType === 'asar',
    parser: { name: parserManifest.name, version: parserManifest.version },
    source: { id: result.source.id, status: result.source.status, edgeCount: result.edges.length },
    paper: {
      arxiv: paper.identity.arxiv,
      arxivVersion: paper.identity.arxivVersion,
      title: paper.title,
      topics: paper.topics.map((topic) => topic.name),
    },
    live,
  })}\n`, { encoding: 'utf8', mode: 0o600 });
}

/**
 * An opt-in release check for the actual production transport. This deliberately
 * uses the dynamically loaded adapter with its default endpoint and default
 * process-wide 3-second / single-connection gate. It fetches metadata only,
 * one first-page record, and records a structured failure instead of hiding it
 * behind an absent verification report.
 */
async function verifyResearchArxivLiveSource(adapter) {
  try {
    const result = await adapter.createArxivSource().search({
      query: 'machine learning',
      limit: 1,
      sort: 'relevance',
      sourceIds: ['arxiv'],
    });
    const paper = result.papers[0];
    return {
      requested: true,
      source: {
        id: result.source.id,
        status: result.source.status,
        resultCount: result.source.resultCount,
        ...(result.source.queryUrl ? { queryUrl: result.source.queryUrl } : {}),
      },
      ...(paper ? {
        paper: {
          ...(paper.identity.arxiv ? { arxiv: paper.identity.arxiv } : {}),
          ...(paper.title ? { title: paper.title } : {}),
        },
      } : {}),
      ...(result.source.error ? { error: result.source.error } : {}),
    };
  } catch (error) {
    return {
      requested: true,
      source: { id: 'arxiv', status: 'error', resultCount: 0 },
      error: researchVerificationErrorMessage(error),
    };
  }
}

function researchVerificationErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}

function assertResearchVerification(condition, message) {
  if (!condition) throw new Error(`Research verification failed: ${message}`);
}

function runtimeWorkingDirectory() {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

function startNodeProcess(label, args, environment, readyPattern, options = {}) {
  const {
    RIGORIUM_VERIFY_ZOTERO_BROKER_URL: _verificationBrokerUrl,
    RIGORIUM_VERIFY_ZOTERO_BROKER_TOKEN: _verificationBrokerToken,
    ...parentEnvironment
  } = process.env;
  const esbuildBinaryPath = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
    : undefined;
  const child = spawn(process.execPath, args, {
    cwd: runtimeWorkingDirectory(),
    env: {
      ...parentEnvironment,
      ...environment,
      ...(esbuildBinaryPath ? { ESBUILD_BINARY_PATH: esbuildBinaryPath } : {}),
      ELECTRON_RUN_AS_NODE: '1',
      FORCE_COLOR: '0',
    },
    stdio: options.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let recentOutput = '';
  let isReady = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timeout = setTimeout(() => {
    if (!isReady) {
      rejectReady(new Error(`${label} did not start within ${Math.round(STARTUP_TIMEOUT_MS / 1_000)} seconds.\n${recentOutput}`));
    }
  }, STARTUP_TIMEOUT_MS);

  const appendOutput = (chunk) => {
    const text = String(chunk);
    recentOutput = `${recentOutput}${text}`.slice(-4_000);
    writeDesktopLog(label, text);
    if (isReady) return;
    const match = recentOutput.match(readyPattern);
    if (!match) return;
    const port = Number.parseInt(match[1], 10);
    if (!Number.isFinite(port) || port <= 0) return;
    isReady = true;
    clearTimeout(timeout);
    resolveReady(port);
  };

  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);
  if (options.onMessage) child.on('message', (message) => options.onMessage(message, child));
  child.once('error', (error) => {
    writeDesktopLog(label, `failed to launch: ${error.stack || error.message}`);
    if (!isReady) {
      clearTimeout(timeout);
      rejectReady(new Error(`${label} failed to launch: ${error.message}\n${recentOutput}`));
    }
  });
  child.once('exit', (code, signal) => {
    if (!isQuitting && code !== 0) {
      writeDesktopLog(label, `stopped unexpectedly: code=${code}, signal=${signal}`);
    }
    if (!isReady) {
      clearTimeout(timeout);
      rejectReady(new Error(`${label} exited before it was ready (code=${code}, signal=${signal}).\n${recentOutput}`));
    }
  });
  return { child, ready };
}

async function startDesktopZoteroBroker() {
  if (zoteroBrokerUrl) return;
  const verificationBroker = researchVerificationBrokerConfig();
  zoteroCloudRouteToken = randomBytes(32).toString('base64url');
  if (verificationBroker) {
    zoteroBrokerUrl = verificationBroker.url;
    zoteroBrokerToken = verificationBroker.token;
    return;
  }
  const token = randomBytes(32).toString('base64url');
  const broker = await startZoteroBroker({
    token,
    getApiKey: readStoredZoteroApiKey,
    host: LOCAL_HOST,
  });
  zoteroBrokerServer = broker.server;
  zoteroBrokerUrl = broker.url;
  zoteroBrokerToken = token;
}

function researchVerificationBrokerConfig() {
  if (!isResearchVerification) return undefined;
  const url = process.env.RIGORIUM_VERIFY_ZOTERO_BROKER_URL;
  const token = process.env.RIGORIUM_VERIFY_ZOTERO_BROKER_TOKEN;
  if (!url && !token) return undefined;
  if (typeof url !== 'string' || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
    throw new Error('The research verification broker configuration is invalid.');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('The research verification broker configuration is invalid.');
  }
  if (
    parsedUrl.protocol !== 'http:'
    || parsedUrl.hostname !== LOCAL_HOST
    || !/^[1-9]\d{0,4}$/u.test(parsedUrl.port)
    || Number(parsedUrl.port) > 65_535
    || parsedUrl.pathname !== '/v1/zotero/request'
    || parsedUrl.search
    || parsedUrl.hash
    || parsedUrl.username
    || parsedUrl.password
  ) {
    throw new Error('The research verification broker must be a loopback endpoint.');
  }
  return { url: parsedUrl.href, token };
}

function stopDesktopZoteroBroker() {
  const server = zoteroBrokerServer;
  zoteroBrokerServer = undefined;
  zoteroBrokerUrl = undefined;
  zoteroBrokerToken = undefined;
  zoteroCloudRouteToken = undefined;
  if (!server) return Promise.resolve();

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, SERVICE_STOP_TIMEOUT_MS);
    try {
      server.close(finish);
      server.closeIdleConnections?.();
    } catch {
      finish();
    }
  });
}

async function startServices() {
  await startDesktopZoteroBroker();
  const appRoot = app.getAppPath();
  const gateway = startNodeProcess(
    'gateway',
    [join(appRoot, 'dist', 'src', 'cli', 'pilotdeck.js'), 'server', '--port', '0'],
    {
      HOST: LOCAL_HOST,
    },
    /Rigorium server listening:\s+https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/i,
  );
  gatewayProcess = gateway.child;
  const gatewayPort = await gateway.ready;

  let uiBrokerConfigSent = false;
  const ui = startNodeProcess(
    'ui',
    [
      '--import',
      pathToFileURL(join(appRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
      join(appRoot, 'desktop', 'ui-server-bootstrap.mjs'),
    ],
    {
      HOST: LOCAL_HOST,
      SERVER_PORT: '0',
      PILOTDECK_DESKTOP: '1',
      PILOTDECK_SKIP_BROWSER_OPEN: '1',
      PILOTDECK_GATEWAY_PORT: String(gatewayPort),
      PILOTDECK_GATEWAY_URL: `ws://${LOCAL_HOST}:${gatewayPort}/ws`,
    },
    /Server URL:[\s\S]{0,40}?https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/i,
    {
      ipc: true,
      onMessage(message, child) {
        if (message?.type === 'rigorium:ui-bootstrap-ready' && !uiBrokerConfigSent && child.connected) {
          uiBrokerConfigSent = true;
          child.send({
            type: 'rigorium:zotero-broker-config',
            url: zoteroBrokerUrl,
            token: zoteroBrokerToken,
            routeToken: zoteroCloudRouteToken,
          });
          return;
        }
        if (message?.type === 'rigorium:ui-bootstrap-configured' && child.connected) child.disconnect();
      },
    },
  );
  uiProcess = ui.child;
  uiPort = await ui.ready;
}

function stopProcess(child) {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, SERVICE_STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function stopServices() {
  await Promise.all([stopProcess(uiProcess), stopProcess(gatewayProcess), stopDesktopZoteroBroker()]);
}

function isLocalAppUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && parsed.hostname === LOCAL_HOST && Number(parsed.port) === uiPort;
  } catch {
    return false;
  }
}

function isTrustedAppPageUrl(url) {
  if (!isLocalAppUrl(url)) return false;
  try {
    return !new URL(url).pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: '#171B1E',
    title: 'Rigorium',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(app.getAppPath(), 'desktop', 'preload.cjs'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedAppPageUrl(url)) {
      event.preventDefault();
      if (/^https?:/i.test(url) && !isLocalAppUrl(url)) void shell.openExternal(url);
    }
  });
  mainWindow.once('ready-to-show', () => {
    if (!isWindowSmokeTest) mainWindow?.show();
  });
  mainWindow.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
    if (!isWindowSmokeTest) return;
    writeDesktopLog('main', `window load failed: ${errorCode} ${errorDescription}`);
    isQuitting = true;
    void stopServices().finally(() => app.exit(1));
  });
  mainWindow.webContents.once('did-finish-load', () => {
    if (!isWindowSmokeTest) return;
    setTimeout(() => {
      isQuitting = true;
      void stopServices().finally(() => app.quit());
    }, 3_000);
  });
  void mainWindow.loadURL(`http://${LOCAL_HOST}:${uiPort}`);
}

app.setName('Rigorium');
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();
  void stopServices().finally(() => app.quit());
});

app.whenReady().then(async () => {
  registerZoteroIpc();
  try {
    if (isResearchVerification) await verifyResearchArxivAdapter();
    await startServices();
    if (isSmokeTest) {
      isQuitting = true;
      await stopServices();
      app.quit();
      return;
    }
    createWindow();
  } catch (error) {
    isQuitting = true;
    await stopServices();
    if (isSmokeTest || isResearchVerification) {
      writeDesktopLog('main', error instanceof Error ? error.stack || error.message : String(error));
      app.exit(1);
      return;
    }
    dialog.showErrorBox(
      'Rigorium could not start',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  }
});
