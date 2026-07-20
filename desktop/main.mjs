import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STARTUP_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 8_000;
const LOCAL_HOST = '127.0.0.1';
const isSmokeTest = process.argv.includes('--smoke-test');

let gatewayProcess;
let uiProcess;
let mainWindow;
let isQuitting = false;
let uiPort;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runtimeWorkingDirectory() {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, LOCAL_HOST, () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('Could not reserve a local TCP port.'));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: LOCAL_HOST, port });
    const finish = (connected) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function waitForPort(port, label) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await delay(250);
  }
  throw new Error(`${label} did not start within ${Math.round(STARTUP_TIMEOUT_MS / 1_000)} seconds.`);
}

function startNodeProcess(label, args, environment) {
  const child = spawn(process.execPath, args, {
    cwd: runtimeWorkingDirectory(),
    env: {
      ...process.env,
      ...environment,
      ELECTRON_RUN_AS_NODE: '1',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout?.on('data', (chunk) => console.log(`[${label}] ${chunk}`));
  child.stderr?.on('data', (chunk) => console.error(`[${label}] ${chunk}`));
  child.once('error', (error) => console.error(`[${label}] failed to launch`, error));
  child.once('exit', (code, signal) => {
    if (!isQuitting && code !== 0) {
      console.error(`[${label}] stopped unexpectedly`, { code, signal });
    }
  });
  return child;
}

async function startServices() {
  const appRoot = app.getAppPath();
  const [gatewayPort, selectedUiPort] = await Promise.all([reservePort(), reservePort()]);
  uiPort = selectedUiPort;

  gatewayProcess = startNodeProcess(
    'gateway',
    [join(appRoot, 'dist', 'src', 'cli', 'pilotdeck.js'), 'server', '--port', String(gatewayPort)],
    {
      PILOTDECK_GATEWAY_PORT: String(gatewayPort),
      HOST: LOCAL_HOST,
    },
  );
  await waitForPort(gatewayPort, 'Rigorium gateway');

  uiProcess = startNodeProcess(
    'ui',
    [
      '--import',
      pathToFileURL(join(appRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
      join(appRoot, 'ui', 'server', 'index.js'),
    ],
    {
      HOST: LOCAL_HOST,
      SERVER_PORT: String(uiPort),
      PILOTDECK_GATEWAY_PORT: String(gatewayPort),
      PILOTDECK_GATEWAY_URL: `ws://${LOCAL_HOST}:${gatewayPort}/ws`,
    },
  );
  await waitForPort(uiPort, 'Rigorium desktop service');
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
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  void mainWindow.loadURL(`http://${LOCAL_HOST}:${uiPort}`);
}

app.setName('Rigorium');
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
      console.error(error);
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
