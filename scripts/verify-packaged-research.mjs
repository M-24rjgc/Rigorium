import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executable = process.argv[2] || join(process.cwd(), 'release', 'win-unpacked', 'Rigorium.exe');
const playwrightPath = process.argv[3]
  || join(process.cwd(), 'node_modules', '.pnpm', 'playwright@1.60.0', 'node_modules', 'playwright', 'index.mjs');
const { _electron: electron } = await import(pathToFileURL(playwrightPath).href);
const userData = await mkdtemp(join(tmpdir(), 'rigorium-packaged-research-'));
const executableName = executable.split(/[\\/]/u).at(-1)?.replace(/\.exe$/iu, '') || 'Rigorium';

let browserProcessCountBefore = await countBrowserProcesses();
const app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${userData}`] });
try {
  const page = await app.firstWindow({ timeout: 90_000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.openSettings === 'function', undefined, { timeout: 60_000 });

  const windows = app.windows();
  if (windows.length !== 1) throw new Error(`Expected one Rigorium window, found ${windows.length}.`);
  const runningAppProcesses = await countProcesses(executableName);
  if (runningAppProcesses < 1) throw new Error('Packaged Rigorium process was not found.');
  const browserProcessCountAfter = await countBrowserProcesses();
  if (browserProcessCountAfter > browserProcessCountBefore) {
    throw new Error(`Launching Rigorium opened an external browser process (${browserProcessCountBefore} -> ${browserProcessCountAfter}).`);
  }

  await page.evaluate(() => window.openSettings?.('research'));
  await page.getByRole('heading', { name: /Research Settings|科研设置/u, level: 2 }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: /Test Zotero|测试 Zotero/u }).click();
  await page.getByText(/Local API unavailable|Connector unavailable|Zotero is not ready|Zotero 未准备好/u).first().waitFor({ timeout: 30_000 });

  await page.getByRole('button', { name: /Browse collections|浏览 Collection/u }).click();
  await page.getByText(/Local API unavailable|fetch failed|Zotero.*not running|Zotero.*unavailable|Zotero.*未运行|Zotero.*不可用/u).first().waitFor({ timeout: 30_000 });

  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (desktopOverflow > 1) throw new Error(`Desktop research settings overflow horizontally by ${desktopOverflow}px.`);

  await page.getByRole('button', { name: /Close settings|关闭设置|Close/u }).first().click();
  await page.locator('.modal-backdrop').waitFor({ state: 'detached', timeout: 30_000 });
  const observedResearchRequests = [];
  await page.route('**/api/research/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    observedResearchRequests.push(`${request.method()} ${url.pathname}${url.search}`);

    if (url.pathname === '/api/research/settings') {
      const settings = {
        schemaVersion: 1,
        literature: {
          enabled: true,
          sources: { openalex: { enabled: true, mailto: '' } },
          search: { defaultLimit: 12, fromYear: null, toYear: null, sort: 'relevance' },
          budget: { maxResultsPerSearch: 25, requestTimeoutMs: 20_000 },
          map: { autoOpen: true, autoUpdate: true, showTopicEdges: true },
        },
        zotero: {
          enabled: true,
          baseUrl: 'http://127.0.0.1:23119',
          useSelectedCollection: false,
          collectionKey: 'VERIFYCOLL',
          collectionName: 'Verification Collection',
        },
        citation: { style: 'apa', includeDoi: true },
        privacy: { allowRemoteMetadataSearch: true, allowRemoteFullText: false },
      };
      return fulfillJson(route, {
        global: settings,
        effective: settings,
        projectOverride: null,
        paths: { global: 'verification-settings.json' },
      });
    }
    if (url.pathname === '/api/research/zotero/status') {
      return fulfillJson(route, {
        provider: 'zotero',
        available: true,
        apiReady: true,
        connectorReady: true,
        checkedAt: new Date().toISOString(),
        selectedCollection: { key: 'VERIFYCOLL', name: 'Verification Collection' },
      });
    }
    if (url.pathname === '/api/research/zotero/match') {
      return fulfillJson(route, {
        provider: 'zotero',
        available: true,
        collectionKey: 'VERIFYCOLL',
        matches: [{
          paperId: 'verification-paper',
          matched: false,
          confidence: 'none',
          reasons: [],
          inCollection: false,
        }],
      });
    }
    if (url.pathname === '/api/research/zotero/items/VERIFY01/fulltext') {
      return fulfillJson(route, {
        provider: 'zotero',
        available: true,
        attachmentKey: 'VERIFY01',
        content: 'Indexed verification text loaded only after an explicit click.',
        indexedPages: 1,
        totalPages: 1,
        indexedChars: 61,
        totalChars: 61,
        truncated: false,
      });
    }
    if (url.pathname === '/api/research/zotero/items/VERIFYITEM/export') {
      return fulfillJson(route, {
        provider: 'zotero',
        available: true,
        itemKey: 'VERIFYITEM',
        format: url.searchParams.get('format'),
        style: 'apa',
        content: '@article{rigorium2026verification, title = {Packaged Zotero item}}',
      });
    }
    if (url.pathname === '/api/research/zotero/items/VERIFYITEM') {
      return fulfillJson(route, {
        provider: 'zotero',
        available: true,
        itemKey: 'VERIFYITEM',
        detail: {
          item: {
            key: 'VERIFYITEM',
            itemType: 'journalArticle',
            title: 'Packaged Zotero item',
            creators: ['Rigorium Verification'],
            date: '2026',
            year: 2026,
            doi: '10.1000/packaged-verification',
            tags: ['verified'],
            collectionKeys: ['VERIFYCOLL'],
            identity: { zoteroKey: 'VERIFYITEM' },
          },
          data: {},
          tags: ['verified'],
          children: [],
          notes: [{
            key: 'VERIFYNOTE',
            itemType: 'note',
            title: 'Verification note',
            text: 'Packaged note content.',
            parentItem: 'VERIFYITEM',
          }],
          attachments: [{
            key: 'VERIFY01',
            itemType: 'attachment',
            title: 'verification.pdf',
            contentType: 'application/pdf',
            linkMode: 'imported_file',
            parentItem: 'VERIFYITEM',
          }],
        },
      });
    }
    if (url.pathname === '/api/research/zotero/items') {
      return fulfillJson(route, {
        provider: 'zotero',
        available: true,
        collectionKey: 'VERIFYCOLL',
        collectionName: 'Verification Collection',
        items: [{
          key: 'VERIFYITEM',
          itemType: 'journalArticle',
          title: 'Packaged Zotero item',
          creators: ['Rigorium Verification'],
          year: 2026,
          tags: ['verified'],
          collectionKeys: ['VERIFYCOLL'],
          identity: { zoteroKey: 'VERIFYITEM' },
        }],
        total: 1,
        truncated: false,
      });
    }
    return fulfillJson(route, { error: `Unhandled verification request: ${url.pathname}` }, 500);
  });
  const query = 'packaged research verification';
  await page.evaluate((artifactQuery) => {
    const paper = {
      id: 'verification-paper',
      identity: { doi: '10.1000/verification' },
      title: 'Packaged research verification paper',
      authors: ['Rigorium Verification'],
      year: 2026,
      citedByCount: 1,
      topics: [{ id: 'verification', name: 'Verification' }],
      referencedWorkIds: [],
      sourceId: 'verification',
    };
    window.dispatchEvent(new CustomEvent('rigorium:research-artifact', {
      detail: {
        artifact: {
          schemaVersion: 1,
          kind: 'literature_search',
          artifactId: 'packaged-research-verification',
          createdAt: new Date().toISOString(),
          intent: { text: artifactQuery },
          plan: { query: artifactQuery, limit: 1, sort: 'relevance', sourceIds: ['verification'] },
          papers: [paper],
          edges: [],
          sources: [{
            id: 'verification',
            name: 'Verification source',
            status: 'ok',
            retrievedAt: new Date().toISOString(),
            resultCount: 1,
            coverage: 'Packaged desktop verification artifact.',
          }],
          coverage: { status: 'complete', resultCount: 1, warnings: [] },
          presentation: { autoOpen: true },
        },
      },
    }));
  }, query);
  await page.getByText(query, { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: /Collection|文献库/u }).click();
  await page.getByText('Packaged Zotero item', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: /Show details for Packaged Zotero item|展开.*Packaged Zotero item/u }).click();
  await page.getByText('10.1000/packaged-verification', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText('Verification note', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: /Read full text for verification.pdf|读取.*verification.pdf/u }).click();
  await page.getByText('Indexed verification text loaded only after an explicit click.', { exact: true }).waitFor({ timeout: 30_000 });
  await Promise.all([
    page.waitForRequest((request) => request.url().includes('/api/research/zotero/items/VERIFYITEM/export')
      && request.url().includes('format=bibtex')),
    page.getByRole('button', { name: /Copy BibTeX|复制 BibTeX/u }).click(),
  ]);

  for (const expectedRequest of [
    'GET /api/research/zotero/items/VERIFYITEM',
    'GET /api/research/zotero/items/VERIFY01/fulltext',
    'GET /api/research/zotero/items/VERIFYITEM/export',
  ]) {
    if (!observedResearchRequests.some((request) => request.startsWith(expectedRequest))) {
      throw new Error(`Packaged research verification missed ${expectedRequest}.`);
    }
  }

  await page.setViewportSize({ width: 390, height: 800 });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (mobileOverflow > 1) throw new Error(`390px research settings overflow horizontally by ${mobileOverflow}px.`);

  console.log(JSON.stringify({
    executable,
    windows: windows.length,
    appProcesses: runningAppProcesses,
    browserProcessCountBefore,
    browserProcessCountAfter,
    desktopOverflow,
    mobileOverflow,
    title: await page.title(),
  }, null, 2));
} finally {
  await app.close().catch(() => undefined);
}

async function countBrowserProcesses() {
  const names = ['chrome', 'msedge', 'firefox', 'brave'];
  const counts = await Promise.all(names.map(countProcesses));
  return counts.reduce((total, count) => total + count, 0);
}

async function countProcesses(name) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$p=Get-Process -Name '${name.replaceAll("'", "''")}' -ErrorAction SilentlyContinue; if($p){($p | Measure-Object).Count}else{0}; exit 0`,
    ], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.once('error', reject);
    child.once('exit', () => resolve(Number.parseInt(output.trim(), 10) || 0));
  });
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
