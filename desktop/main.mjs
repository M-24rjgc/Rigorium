import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STARTUP_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 8_000;
const LOCAL_HOST = '127.0.0.1';
const isSmokeTest = process.argv.includes('--smoke-test');
const isWindowSmokeTest = process.argv.includes('--window-smoke-test');

let gatewayProcess;
let uiProcess;
let mainWindow;
let isQuitting = false;
let uiPort;

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

function runtimeWorkingDirectory() {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

function startNodeProcess(label, args, environment, readyPattern) {
  const esbuildBinaryPath = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
    : undefined;
  const child = spawn(process.execPath, args, {
    cwd: runtimeWorkingDirectory(),
    env: {
      ...process.env,
      ...environment,
      ...(esbuildBinaryPath ? { ESBUILD_BINARY_PATH: esbuildBinaryPath } : {}),
      ELECTRON_RUN_AS_NODE: '1',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
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

async function startServices() {
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

  const ui = startNodeProcess(
    'ui',
    [
      '--import',
      pathToFileURL(join(appRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
      join(appRoot, 'ui', 'server', 'index.js'),
    ],
    {
      HOST: LOCAL_HOST,
      SERVER_PORT: '0',
      PILOTDECK_GATEWAY_PORT: String(gatewayPort),
      PILOTDECK_GATEWAY_URL: `ws://${LOCAL_HOST}:${gatewayPort}/ws`,
    },
    /Server URL:[\s\S]{0,40}?https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/i,
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
  await Promise.all([stopProcess(uiProcess), stopProcess(gatewayProcess)]);
}

function isLocalAppUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && parsed.hostname === LOCAL_HOST && Number(parsed.port) === uiPort;
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
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocalAppUrl(url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
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
  try {
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
    if (isSmokeTest) {
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
