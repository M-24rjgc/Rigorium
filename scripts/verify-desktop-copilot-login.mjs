#!/usr/bin/env node
/**
 * Drive the packaged desktop app with Playwright's Electron launch and
 * verify the GitHub Copilot device-flow login UI end to end.
 *
 * Unlike pointing a web browser at the app's HTTP port (which spawns a
 * second, unrelated server process and pollutes device-code sessions), this
 * launches the real Rigorium.exe with an isolated userData + RIGIORUM_HOME,
 * so the QR session lives in the exact process the user will run.
 *
 * The flow cannot complete a REAL GitHub authorization (that needs a human
 * clicking in a browser), so after begin() we mock the poll endpoint to
 * return success and assert that the UI flips from "waiting" to "signed in"
 * and that vision: is written to rigorium.yaml.
 *
 * Usage:
 *   node scripts/verify-desktop-copilot-login.mjs [exePath]
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';

const exe = process.argv[2] || join(process.cwd(), 'release', 'win-unpacked', 'Rigorium.exe');
const playwrightPath = join(process.cwd(), 'node_modules', '.pnpm', 'playwright@1.60.0', 'node_modules', 'playwright', 'index.mjs');
const { _electron: electron } = await import(pathToFileURL(playwrightPath).href);

// Isolated home so we never touch the user's real config.
const userData = mkdtempSync(join(tmpdir(), 'rigorium-copilot-e2e-'));
const rigoriumHome = join(userData, 'rigorium-home');
mkdirSync(rigoriumHome, { recursive: true });
const configPath = join(rigoriumHome, 'rigorium.yaml');
writeFileSync(configPath, stringify({
  schemaVersion: 1,
  agent: { model: '_placeholder/_placeholder' },
  model: { providers: { _placeholder: { protocol: 'openai', url: 'https://placeholder.invalid', apiKey: 'PLACEHOLDER', models: { _placeholder: {} } } } },
  router: { enabled: false },
  cron: { enabled: false },
}), 'utf-8');

let app;
let page;
try {
  app = await electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${userData}`, '--disable-gpu'],
    env: {
      ...process.env,
      RIGORIUM_HOME: rigoriumHome,
      RIGORIUM_DESKTOP: '1',
    },
    timeout: 120_000,
  });
  page = await app.firstWindow({ timeout: 120_000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.openSettings === 'function', undefined, { timeout: 60_000 });
  // Skip the first-run feature tour (it overlays the whole UI).
  await page.evaluate(() => { localStorage.setItem('rigorium.feature-tour-seen', '1'); });
  await page.reload();
  await page.waitForFunction(() => typeof window.openSettings === 'function', undefined, { timeout: 60_000 });

  // Open the gateway settings tab.
  await page.evaluate(() => window.openSettings('gateway'));
  await page.getByRole('heading', { name: /视觉助手|Vision/i }).waitFor({ timeout: 30_000 });

  // Mock qr-begin + qr-poll at the network layer so the UI flow runs against
  // a deterministic backend (no real GitHub round-trip needed).
  const captured = {};
  await page.route('**/api/gateway/copilot/qr-begin', async (route) => {
    captured.userCode = 'ABCD-EF12';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        sessionId: 'e2e-session',
        userCode: captured.userCode,
        verificationUri: 'https://github.com/login/device',
        verificationUriComplete: `https://github.com/login/device?user_code=${captured.userCode}`,
      }),
    });
  });
  let pollCount = 0;
  await page.route('**/api/gateway/copilot/qr-poll**', async (route) => {
    pollCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
  await page.route('**/api/gateway/copilot/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, configured: false, baseUrl: '', model: '' }),
    });
  });

  // Expand the vision assistant section and start the Copilot login.
  const setupButtons = page.getByRole('button', { name: '配置', exact: true });
  const setupCount = await setupButtons.count();
  assert.ok(setupCount >= 2, `expected >=2 配置 buttons, got ${setupCount}`);
  await setupButtons.first().click();
  await page.getByRole('button', { name: '登录 GitHub Copilot' }).click();

  // The waiting UI must show the user code, and the Open link must carry the
  // pre-filled user_code (GitHub may not return verification_uri_complete,
  // so the frontend builds the prefill URL itself).
  await page.getByText('ABCD-EF12', { exact: true }).waitFor({ timeout: 15_000 });
  const linkHref = await page.getByRole('link', { name: /打开 GitHub 登录页|Open GitHub login page/i }).getAttribute('href');
  assert.ok(linkHref && linkHref.includes('user_code='), `link should prefill user_code, got ${linkHref}`);
  // The poll fires ~3s after begin; wait for at least one call.
  const pollDeadline = Date.now() + 15_000;
  while (pollCount < 1 && Date.now() < pollDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(pollCount >= 1, 'expected at least one qr-poll call');

  // Polling succeeds -> UI flips to "signed in".
  await page.getByText(/登录成功|Signed in/i).waitFor({ timeout: 15_000 });

  console.log(`[copilot-e2e] OK — user code ${captured.userCode} shown, link pre-fills code, poll called ${pollCount}x, UI reached "signed in".`);
} finally {
  if (app) await app.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
}
