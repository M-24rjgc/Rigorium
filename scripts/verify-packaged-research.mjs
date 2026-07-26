import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executable = process.argv[2] || join(process.cwd(), 'release', 'win-unpacked', 'Rigorium.exe');
const playwrightPath = process.argv[3]
  || join(process.cwd(), 'node_modules', '.pnpm', 'playwright@1.60.0', 'node_modules', 'playwright', 'index.mjs');
const { _electron: electron } = await import(pathToFileURL(playwrightPath).href);
const userData = await mkdtemp(join(tmpdir(), 'rigorium-packaged-research-'));
const rigoriumHome = join(userData, 'rigorium-home');
const executableName = executable.split(/[\\/]/u).at(-1)?.replace(/\.exe$/iu, '') || 'Rigorium';
const verificationCredential = 'x'.repeat(32);
const credentialsPath = join(userData, 'research', 'credentials.v1.json');
const arxivVerificationReportPath = join(userData, 'research', 'verification', 'arxiv-adapter.v1.json');
const openAlexExpansionVerificationReportPath = join(userData, 'research', 'verification', 'openalex-expansion.v1.json');
const terminologyVerificationReportPath = join(userData, 'research', 'verification', 'terminology-search.v1.json');
const verifyLiveArxiv = process.env.RIGORIUM_VERIFY_ARXIV_LIVE === '1';
const verifyLiveOpenAlexExpansion = process.env.RIGORIUM_VERIFY_OPENALEX_EXPANSION_LIVE === '1';

let browserProcessCountBefore = await countBrowserProcesses();
const mockBroker = await startVerificationZoteroBroker();
await writeVerificationSettings(rigoriumHome, mockBroker.origin);
let app;
try {
  app = await electron.launch({
    executablePath: executable,
    args: ['--verify-research', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      RIGORIUM_HOME: rigoriumHome,
      RIGORIUM_VERIFY_ZOTERO_BROKER_URL: mockBroker.url,
      RIGORIUM_VERIFY_ZOTERO_BROKER_TOKEN: mockBroker.token,
    },
  });
  const arxivVerification = await readArxivVerificationReport(arxivVerificationReportPath);
  const openAlexExpansionVerification = await readOpenAlexExpansionVerificationReport(openAlexExpansionVerificationReportPath);
  const terminologyVerification = await readTerminologyVerificationReport(terminologyVerificationReportPath);
  assert.equal(arxivVerification.schemaVersion, 1, 'The packaged arXiv verification report has an unexpected schema.');
  assert.equal(arxivVerification.packaged, true, 'The arXiv adapter verification did not run inside a packaged Electron app.');
  assert.equal(arxivVerification.appPathType, 'asar', 'The arXiv adapter was not loaded from app.asar.');
  assert.equal(arxivVerification.adapterLoadedFromAppAsar, true, 'The packaged adapter verification did not use app.asar.');
  assert.deepEqual(arxivVerification.parser, { name: '@rgrove/parse-xml', version: '4.2.2' });
  assert.deepEqual(arxivVerification.source, { id: 'arxiv', status: 'ok', edgeCount: 0 });
  assert.deepEqual(arxivVerification.paper, {
    arxiv: '2401.24680',
    arxivVersion: 3,
    title: 'Controlled Atom & parser verification',
    topics: ['cs.AI', 'cs.LG'],
  });
  if (verifyLiveArxiv) {
    assert.equal(arxivVerification.live?.requested, true, 'The packaged live arXiv smoke was not requested.');
    assert.equal(arxivVerification.live?.source?.id, 'arxiv', 'The packaged live arXiv smoke reported the wrong source.');
    assert.equal(arxivVerification.live?.source?.status, 'ok', `The packaged live arXiv smoke failed: ${arxivVerification.live?.error || 'unknown error'}`);
    assert.equal(
      Number.isSafeInteger(arxivVerification.live?.source?.resultCount) && arxivVerification.live.source.resultCount > 0,
      true,
      'The packaged live arXiv smoke returned no metadata records.',
    );
    assert.equal(typeof arxivVerification.live?.paper?.arxiv, 'string', 'The packaged live arXiv smoke did not normalize an arXiv identifier.');
    assert.equal(arxivVerification.live.paper.arxiv.trim().length > 0, true, 'The packaged live arXiv identifier was empty.');
    assert.equal(typeof arxivVerification.live?.paper?.title, 'string', 'The packaged live arXiv smoke did not normalize a paper title.');
    assert.equal(arxivVerification.live.paper.title.trim().length > 0, true, 'The packaged live arXiv title was empty.');
  } else {
    assert.equal(arxivVerification.live?.requested, false, 'The deterministic packaged check unexpectedly made a live arXiv request.');
  }
  assert.equal(openAlexExpansionVerification.schemaVersion, 1, 'The packaged OpenAlex expansion verification report has an unexpected schema.');
  assert.equal(openAlexExpansionVerification.packaged, true, 'The OpenAlex expansion verification did not run inside a packaged Electron app.');
  assert.equal(openAlexExpansionVerification.appPathType, 'asar', 'The OpenAlex expansion tool was not loaded from app.asar.');
  assert.equal(openAlexExpansionVerification.toolLoadedFromAppAsar, true, 'The packaged literature_expand tool did not load from app.asar.');
  assert.equal(openAlexExpansionVerification.adapterLoadedFromAppAsar, true, 'The packaged OpenAlex expansion adapter did not load from app.asar.');
  assert.deepEqual(openAlexExpansionVerification.fixtures, {
    seed: 'openalex-expansion-seed.json',
    references: 'openalex-expansion-references.json',
    citations: 'openalex-expansion-citations.json',
  });
  assert.equal(openAlexExpansionVerification.source?.id, 'openalex');
  assert.equal(openAlexExpansionVerification.source?.status, 'ok');
  assert.equal(openAlexExpansionVerification.source?.resultCount, 3);
  assert.deepEqual(openAlexExpansionVerification.seed, {
    id: 'https://openalex.org/W900000001',
    title: 'Packaged OpenAlex citation expansion seed',
    doi: '10.1234/rigorium.packaged-seed',
  });
  assert.deepEqual(
    openAlexExpansionVerification.directions?.map((direction) => ({
      direction: direction.direction,
      status: direction.status,
      resultCount: direction.resultCount,
      totalMatches: direction.totalMatches,
      requestedCount: direction.requestedCount,
      resolvedCount: direction.resolvedCount,
      truncated: direction.truncated,
    })),
    [{
      direction: 'references',
      status: 'partial',
      resultCount: 1,
      totalMatches: undefined,
      requestedCount: 3,
      resolvedCount: 1,
      truncated: true,
    }, {
      direction: 'citations',
      status: 'partial',
      resultCount: 1,
      totalMatches: 2,
      requestedCount: undefined,
      resolvedCount: undefined,
      truncated: true,
    }],
    'The packaged citation directions did not retain partial/truncated coverage details.',
  );
  assert.deepEqual(
    openAlexExpansionVerification.edges?.map((edge) => [edge.source, edge.target, edge.type, edge.inferred]),
    [
      ['https://openalex.org/W900000001', 'https://openalex.org/W900000002', 'citation', false],
      ['https://openalex.org/W900000004', 'https://openalex.org/W900000001', 'citation', false],
    ],
    'The packaged citation graph did not retain cited-work edge orientation.',
  );
  assert.equal(openAlexExpansionVerification.coverage?.status, 'partial');
  assert.equal(openAlexExpansionVerification.coverage?.resultCount, 3);
  assert.equal(Array.isArray(openAlexExpansionVerification.coverage?.warnings), true);
  assert.equal(openAlexExpansionVerification.coverage.warnings.length >= 2, true, 'The packaged expansion did not expose truncation warnings.');
  assert.equal(openAlexExpansionVerification.artifact?.kind, 'literature_expansion');
  assert.equal(openAlexExpansionVerification.artifact?.presentation?.autoOpen, true);
  for (const direction of openAlexExpansionVerification.directions ?? []) {
    const queryUrl = new URL(direction.queryUrl);
    assert.equal(queryUrl.protocol, 'https:');
    assert.equal(queryUrl.hostname, 'verification.invalid', 'The packaged expansion verification used a live OpenAlex endpoint.');
  }
  if (verifyLiveOpenAlexExpansion) {
    assert.equal(openAlexExpansionVerification.live?.requested, true, 'The packaged live OpenAlex expansion smoke was not requested.');
    assert.equal(
      openAlexExpansionVerification.live?.source?.status,
      'ok',
      `The packaged live OpenAlex expansion smoke failed: ${openAlexExpansionVerification.live?.error || 'unknown error'}`,
    );
    assert.equal(openAlexExpansionVerification.live?.seed?.id, 'https://openalex.org/W2626778328');
    assert.equal(typeof openAlexExpansionVerification.live?.seed?.title, 'string');
    assert.equal(openAlexExpansionVerification.live.seed.title.trim().length > 0, true, 'The packaged live OpenAlex seed title was empty.');
    assert.equal(typeof openAlexExpansionVerification.live?.neighbor?.id, 'string', 'The packaged live OpenAlex expansion returned no neighbour.');
    assert.equal(openAlexExpansionVerification.live.neighbor.id.trim().length > 0, true, 'The packaged live OpenAlex neighbour identifier was empty.');
    assert.deepEqual(openAlexExpansionVerification.live?.edge, {
      source: openAlexExpansionVerification.live.neighbor.id,
      target: 'https://openalex.org/W2626778328',
      type: 'citation',
      inferred: false,
    }, 'The packaged live OpenAlex expansion did not retain a real citing-work edge.');
    assert.equal(openAlexExpansionVerification.live?.direction?.resultCount >= 1, true, 'The packaged live OpenAlex expansion returned no citing work.');
  } else {
    assert.equal(openAlexExpansionVerification.live?.requested, false, 'The deterministic packaged check unexpectedly made a live OpenAlex expansion request.');
  }
  assert.equal(terminologyVerification.schemaVersion, 1, 'The packaged terminology verification report has an unexpected schema.');
  assert.equal(terminologyVerification.packaged, true, 'The terminology verification did not run inside a packaged Electron app.');
  assert.equal(terminologyVerification.appPathType, 'asar', 'The terminology verification was not loaded from app.asar.');
  assert.equal(terminologyVerification.toolLoadedFromAppAsar, true, 'The packaged literature_search tool did not load from app.asar.');
  assert.equal(terminologyVerification.adapterLoadedFromAppAsar, true, 'The packaged OpenAlex adapter did not load from app.asar.');
  assert.equal(terminologyVerification.candidatePoolLoadedFromAppAsar, true, 'The packaged candidate pool did not load from app.asar.');
  assert.equal(terminologyVerification.terminologyLoadedFromAppAsar, true, 'The packaged terminology builder did not load from app.asar.');
  assert.deepEqual(terminologyVerification.fixture, {
    sourceRecordCount: 3,
    requestCount: 2,
    host: 'verification.invalid',
    liveNetwork: false,
  });
  assert.deepEqual(terminologyVerification.rawObservation?.sourcePaperIds, [
    'https://openalex.org/W-TERM-1',
    'https://openalex.org/W-TERM-2',
    'https://openalex.org/W-TERM-3',
  ]);
  assert.equal(terminologyVerification.rawObservation?.count, 3);
  assert.equal(terminologyVerification.rawObservation?.retrievalUrlsSanitized, true, 'The packaged raw terminology observation exposed a private URL parameter.');
  assert.deepEqual(terminologyVerification.finalPool, {
    paperIds: ['https://openalex.org/W-TERM-1'],
    terminologySupportingPaperIds: ['https://openalex.org/W-TERM-1', 'https://openalex.org/W-TERM-1'],
  });
  const packagedTerminologyArtifact = terminologyVerification.artifact;
  const packagedTerminology = packagedTerminologyArtifact?.terminology;
  assert.equal(packagedTerminologyArtifact?.kind, 'literature_search');
  assert.deepEqual(packagedTerminologyArtifact?.plan?.sourceIds, ['openalex']);
  assert.equal(packagedTerminologyArtifact?.papers?.length, 1);
  assert.equal(packagedTerminologyArtifact?.papers?.[0]?.id, 'https://openalex.org/W-TERM-1');
  assert.equal(packagedTerminologyArtifact?.papers?.[0]?.identity?.doi, '10.1000/rigorium-terminology-fixture');
  assert.equal(packagedTerminology?.totalCandidateCount, 16);
  assert.equal(packagedTerminology?.candidates?.length, 8, 'The packaged terminology budget leaked too many cards to the renderer.');
  assert.equal(packagedTerminology?.truncated, true);
  assert.equal(packagedTerminology?.candidates?.every((candidate) => (
    candidate.kind === 'observed_keyword'
    && candidate.evidence.length <= 32
    && candidate.text.startsWith('Fixture Alpha keyword')
  )), true);
  assert.deepEqual(packagedTerminology?.sourcePaperIds, ['https://openalex.org/W-TERM-1']);
  assert.equal(
    JSON.stringify(packagedTerminologyArtifact).includes('fixture-secret'),
    false,
    'The packaged terminology artifact exposed a private retrieval parameter.',
  );
  const page = await app.firstWindow({ timeout: 90_000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.openSettings === 'function', undefined, { timeout: 60_000 });
  await page.route('**/api/research/zotero/status**', (route) => fulfillJson(route, {
    provider: 'zotero',
    available: false,
    apiReady: false,
    connectorReady: false,
    checkedAt: new Date().toISOString(),
    error: 'Local API unavailable in packaged verification.',
  }));
  await page.route('**/api/research/zotero/collections**', (route) => fulfillJson(route, {
    provider: 'zotero',
    available: false,
    collections: [],
    total: 0,
    truncated: false,
    error: 'Local API unavailable in packaged verification.',
  }));

  const directCloudRequest = await page.evaluate(async () => {
    const response = await fetch('/api/research/zotero/cloud/status');
    return { status: response.status, body: await response.json() };
  });
  assert.equal(directCloudRequest.status, 401, 'Renderer reached a cloud route without the private session token.');
  assert.equal(directCloudRequest.body?.error, 'Unauthorized.');
  const directImportRequest = await page.evaluate(async () => {
    const response = await fetch('/api/research/zotero/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed: true, papers: [{ id: 'unauthorized' }] }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(directImportRequest.status, 401, 'Renderer reached the local Zotero write route without the private session token.');
  assert.equal(directImportRequest.body?.error, 'Unauthorized.');

  const cloudBridge = await page.evaluate(() => {
    const bridge = window.rigoriumZoteroCloud;
    if (!bridge) return { present: false };
    return {
      present: true,
      methods: Object.keys(bridge).sort(),
      methodTypes: [typeof bridge.status, typeof bridge.sync, typeof bridge.preview, typeof bridge.confirm],
    };
  });
  assert.equal(cloudBridge.present, true, 'Packaged preload did not expose Zotero cloud access.');
  assert.deepEqual(cloudBridge.methods, ['confirm', 'preview', 'status', 'sync']);
  assert.deepEqual(cloudBridge.methodTypes, ['function', 'function', 'function', 'function']);
  const libraryBridge = await page.evaluate(() => {
    const bridge = window.rigoriumZoteroLibrary;
    return bridge ? { present: true, methods: Object.keys(bridge).sort() } : { present: false, methods: [] };
  });
  assert.equal(libraryBridge.present, true, 'Packaged preload did not expose guarded Zotero library writes.');
  assert.deepEqual(libraryBridge.methods, ['importPapers', 'openAttachment']);

  const credentialBridge = await page.evaluate(async () => {
    const bridge = window.rigoriumZoteroCredentials;
    if (!bridge) return { present: false };
    return {
      present: true,
      methods: Object.keys(bridge).sort(),
      methodTypes: [typeof bridge.status, typeof bridge.save, typeof bridge.clear],
      initial: await bridge.status(),
    };
  });
  assert.equal(credentialBridge.present, true, 'Packaged preload did not expose Zotero credential access.');
  assert.deepEqual(credentialBridge.methods, ['clear', 'save', 'status']);
  assert.deepEqual(credentialBridge.methodTypes, ['function', 'function', 'function']);
  assertCredentialStatus(credentialBridge.initial, false, 'initial credential status');
  assert.equal(credentialBridge.initial.encryptionAvailable, true, 'Windows packaged credential storage is unavailable.');

  const savedCredentialStatus = await page.evaluate(async () => {
    return window.rigoriumZoteroCredentials.save('x'.repeat(32));
  });
  assertCredentialStatus(savedCredentialStatus, true, 'saved credential status');
  const storedCredentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
  assert.deepEqual(Object.keys(storedCredentials).sort(), ['ciphertext', 'version']);
  assert.equal(storedCredentials.version, 1);
  assert.equal(typeof storedCredentials.ciphertext, 'string');
  assert.equal(storedCredentials.ciphertext.length > 0, true);
  const storedCredentialText = JSON.stringify(storedCredentials);
  assert.equal(storedCredentialText.includes(verificationCredential), false, 'Credential fixture was stored as plaintext.');
  assert.equal(
    storedCredentialText.includes(Buffer.from(verificationCredential, 'utf8').toString('base64')),
    false,
    'Credential fixture was stored as base64 plaintext.',
  );
  const rejectedCredentialClear = await page.evaluate(async () => {
    try {
      await window.rigoriumZoteroCredentials.clear({ confirmed: false });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(rejectedCredentialClear, true, 'Credential removal did not require explicit confirmation.');
  const afterRejectedClear = await page.evaluate(() => window.rigoriumZoteroCredentials.status());
  assertCredentialStatus(afterRejectedClear, true, 'credential status after rejected clear');
  assert.equal((await page.content()).includes(verificationCredential), false, 'Credential fixture reached renderer markup.');

  const cloudStatus = await page.evaluate(() => window.rigoriumZoteroCloud.status());
  assert.equal(cloudStatus.provider, 'zotero-cloud');
  assert.equal(cloudStatus.status, 'ready');
  assert.equal(cloudStatus.available, true);
  assert.equal(cloudStatus.writable, true);
  assert.deepEqual(cloudStatus.library, { type: 'user', id: '4242', path: '/users/4242' });

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
          sources: {
            openalex: { enabled: true, mailto: '' },
            arxiv: { enabled: true },
            crossref: { enabled: true, mailto: '' },
          },
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
          cloud: {
            enabled: true,
            libraryType: 'user',
            libraryId: null,
          },
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
  await page.evaluate(({ artifactQuery, artifactTerminology }) => {
    const retrievedAt = new Date().toISOString();
    const queryVariants = [{
      id: 'primary',
      query: artifactQuery,
      requestLimit: 1,
      category: 'primary',
    }, {
      id: 'alternative-1',
      query: 'packaged research systems',
      requestLimit: 1,
      category: 'adjacent_field',
      rationale: 'Packaged alternative terminology verification',
    }];
    const sourceDefinitions = [{
      id: 'openalex',
      name: 'OpenAlex',
    }, {
      id: 'arxiv',
      name: 'arXiv',
    }, {
      id: 'crossref',
      name: 'Crossref',
    }];
    const queryAudit = queryVariants.flatMap((variant) => sourceDefinitions.map((source) => ({
      ...source,
      queryVariantId: variant.id,
      status: 'ok',
      retrievedAt,
      queryUrl: `https://verification.invalid/${source.id}?q=${encodeURIComponent(variant.query)}`,
      resultCount: 1,
      coverage: `Packaged ${source.name} ${variant.id} query verification.`,
      ...(source.id === 'openalex' ? {
        rateLimit: {
          limit: 1000,
          remaining: 998,
          resetSeconds: 60,
          costUsd: 0.001,
          remainingUsd: 0.0998,
        },
      } : {}),
    })));
    const paper = {
      id: 'https://openalex.org/W-TERM-1',
      identity: { doi: '10.1000/verification', arxiv: '2401.12345', arxivVersion: 2 },
      title: 'Packaged research verification paper',
      authors: ['Rigorium Verification'],
      year: 2026,
      citedByCount: 1,
      topics: [{ id: 'verification', name: 'Verification' }],
      referencedWorkIds: [],
      sourceId: 'openalex',
      sourceIds: ['openalex', 'arxiv', 'crossref'],
      provenance: [{
        sourceId: 'openalex',
        sourceRecordId: 'https://openalex.org/W-VERIFY',
        rank: 1,
        queryVariantId: 'primary',
        retrievedAt,
      }, {
        sourceId: 'arxiv',
        sourceRecordId: 'https://arxiv.org/abs/2401.12345v2',
        rank: 1,
        queryVariantId: 'primary',
        retrievedAt,
      }, {
        sourceId: 'crossref',
        sourceRecordId: '10.1000/verification',
        rank: 1,
        queryVariantId: 'alternative-1',
        retrievedAt,
      }],
    };
    const secondPaper = {
      ...paper,
      id: 'https://openalex.org/W-TERM-2',
      identity: { doi: '10.1000/verification-second' },
      title: 'Second packaged terminology support paper',
      citedByCount: 0,
      sourceIds: ['openalex'],
      provenance: [{
        sourceId: 'openalex',
        sourceRecordId: 'https://openalex.org/W-VERIFY-2',
        rank: 2,
        queryVariantId: 'alternative-1',
        retrievedAt,
      }],
    };
    const terminology = artifactTerminology;
    window.dispatchEvent(new CustomEvent('rigorium:research-artifact', {
      detail: {
        artifact: {
          schemaVersion: 1,
          kind: 'literature_search',
          artifactId: 'packaged-research-verification',
          createdAt: retrievedAt,
          intent: { text: artifactQuery },
          plan: {
            query: artifactQuery,
            limit: 2,
            sort: 'relevance',
            classifications: [{ scheme: 'arxiv', include: ['cs.AI'] }],
            sourceIds: ['openalex', 'arxiv', 'crossref'],
            queryVariants,
          },
          papers: [paper, secondPaper],
          edges: [],
          sources: [{
            id: 'openalex',
            name: 'OpenAlex',
            status: 'ok',
            retrievedAt,
            resultCount: 2,
            coverage: 'Packaged OpenAlex verification artifact.',
            rateLimit: {
              limit: 1000,
              remaining: 998,
              resetSeconds: 60,
              costUsd: 0.001,
              remainingUsd: 0.0998,
            },
          }, {
            id: 'arxiv',
            name: 'arXiv',
            status: 'ok',
            retrievedAt,
            resultCount: 1,
            coverage: 'Packaged arXiv verification artifact.',
            applied: {
              dateField: 'submitted',
              sort: 'relevance:descending',
              classifications: ['cs.AI'],
            },
          }, {
            id: 'crossref',
            name: 'Crossref',
            status: 'ok',
            retrievedAt,
            resultCount: 1,
            coverage: 'Packaged Crossref verification artifact.',
          }],
          queryAudit,
          terminology,
          coverage: {
            status: 'complete',
            resultCount: 2,
            warnings: [],
            requestedSourceIds: ['openalex', 'arxiv', 'crossref'],
            successfulSourceIds: ['openalex', 'arxiv', 'crossref'],
            failedSourceIds: [],
          },
          presentation: { autoOpen: true },
        },
      },
    }));
  }, { artifactQuery: query, artifactTerminology: packagedTerminology });
  await page.getByText(query, { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByText(/Coverage complete|覆盖完整/u, { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText('OpenAlex', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByText('arXiv', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByText('Crossref', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByText(/cs\.AI/u).first().waitFor({ timeout: 30_000 });
  const queryAudit = page.getByTestId('research-query-audit');
  await queryAudit.getByText(/Primary query|主查询/u, { exact: true }).first().waitFor({ timeout: 30_000 });
  await queryAudit.getByText(/Alternative query|替代查询/u, { exact: true }).first().waitFor({ timeout: 30_000 });
  for (const category of ['primary', 'adjacent_field']) {
    const badges = queryAudit.getByTestId(`research-query-category-${category}`);
    await badges.first().waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await badges.count(), 3, `Expected three ${category} query-category badges.`);
    await Promise.all(Array.from({ length: 3 }, (_, index) => (
      badges.nth(index).waitFor({ state: 'visible', timeout: 30_000 })
    )));
  }
  await queryAudit.getByText('packaged research systems', { exact: true }).first().waitFor({ timeout: 30_000 });
  const queryLinks = queryAudit.getByRole('link', { name: /Open query|打开查询/u });
  assert.equal(await queryLinks.count(), 6, 'The packaged query audit did not expose every query-source URL.');
  assert.equal(
    (await queryLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href'))))
      .every((href) => href?.startsWith('https://verification.invalid/')),
    true,
    'The packaged query audit exposed an unexpected query URL.',
  );
  await queryAudit.getByTestId('research-query-rate-limit-primary-openalex').getByText(/998 \/ 1000/u).waitFor({ timeout: 30_000 });
  await page.getByTestId('research-source-rate-limit-openalex').getByText(/998 \/ 1000/u).waitFor({ timeout: 30_000 });

  const terminology = page.getByTestId('research-terminology-summary');
  await terminology.waitFor({ state: 'visible', timeout: 30_000 });
  await terminology.getByText(/not synonyms or author keywords|不是同义词或作者关键词/u).waitFor({ timeout: 30_000 });
  await terminology.getByText('Fixture Alpha keyword 01', { exact: true }).waitFor({ timeout: 30_000 });
  await terminology.getByText('Fixture Alpha keyword 08', { exact: true }).waitFor({ timeout: 30_000 });
  await terminology.getByText(/8\s+of\s+16/u).waitFor({ timeout: 30_000 });
  const terminologyGroups = terminology.locator('[data-testid^="research-terminology-group-"]');
  assert.equal(await terminologyGroups.count(), 1, 'The packaged terminology panel did not render the bounded fixture evidence kind.');
  const terminologyDetails = terminology.locator('details');
  assert.equal(await terminologyDetails.count(), 8, 'The packaged terminology panel did not preserve the bounded candidate count.');
  await terminologyDetails.first().locator('summary').click();
  const terminologyLinks = terminologyDetails.first().getByRole('link');
  await terminologyLinks.first().waitFor({ state: 'visible', timeout: 30_000 });
  const terminologyHrefs = await terminologyLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  assert.equal(terminologyHrefs.some((href) => href?.startsWith('https://openalex.org/')), true);
  assert.equal(terminologyHrefs.some((href) => href?.startsWith('https://verification.invalid/')), true);
  assert.equal(
    terminologyHrefs.every((href) => href && !href.includes('fixture-secret')),
    true,
    'The packaged terminology panel exposed a private retrieval parameter.',
  );
  await page.getByRole('tab', { name: /Collection|文献库/u }).click();
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

  const cloudPlan = await page.evaluate(async () => {
    const result = await window.rigoriumZoteroCloud.preview({
      kind: 'tags',
      itemKey: 'VERIFYITEM',
      operation: 'add',
      tags: ['cloud-verified'],
    });
    return result.plan;
  });
  assert.equal(cloudPlan.kind, 'tags');
  assert.equal(cloudPlan.itemKey, 'VERIFYITEM');
  assert.equal(cloudPlan.itemVersion, 7);
  assert.equal(cloudPlan.requiresConfirmation, true);
  assert.deepEqual(cloudPlan.beforeTags, ['verified']);
  assert.deepEqual(cloudPlan.afterTags, ['verified', 'cloud-verified']);

  const cloudConfirmation = await page.evaluate((plan) => window.rigoriumZoteroCloud.confirm(plan), cloudPlan);
  assert.equal(cloudConfirmation.status, 'succeeded');
  assert.equal(cloudConfirmation.executed, true);
  assert.equal(cloudConfirmation.retryCount, 0);
  assert.deepEqual(cloudConfirmation.successful, [{ index: 0, key: 'VERIFYITEM', version: 8 }]);
  assert.deepEqual(
    mockBroker.requests.map((request) => `${request.method} ${request.path}`),
    [
      'GET /keys/current',
      'GET /users/4242/items?format=versions&limit=1',
      'GET /keys/current',
      'GET /users/4242/items?format=versions&limit=1',
      'GET /keys/current',
      'GET /users/4242/items?format=versions&limit=1',
      'GET /users/4242/items/VERIFYITEM',
      'PATCH /users/4242/items/VERIFYITEM',
    ],
    'Cloud preview and confirmation did not use the expected mock broker path.',
  );
  const patchRequest = mockBroker.requests.at(-1);
  assert.equal(patchRequest?.headers?.['If-Unmodified-Since-Version'], '7');
  assert.deepEqual(patchRequest?.body, { tags: [{ tag: 'verified' }, { tag: 'cloud-verified' }] });
  assert.equal(JSON.stringify(mockBroker.requests).includes(verificationCredential), false, 'Cloud broker received the credential fixture.');

  const localImport = await page.evaluate(() => window.rigoriumZoteroLibrary.importPapers([{
    id: 'packaged-import-verification',
    identity: { doi: '10.1000/packaged-import' },
    title: 'Packaged import verification',
    authors: ['Rigorium Verification'],
    year: 2026,
    sourceId: 'verification',
  }]));
  assert.equal(localImport.importedCount, 1);
  assert.equal(mockBroker.localRequests.some((request) => request.method === 'POST' && request.path.startsWith('/connector/import?session=')), true);

  await page.evaluate((artifact) => {
    window.dispatchEvent(new CustomEvent('rigorium:research-artifact', {
      detail: { artifact },
    }));
  }, openAlexExpansionVerification.artifact);
  const expansionSeed = page.getByTestId('research-expansion-seed');
  await expansionSeed.waitFor({ timeout: 30_000 });
  await expansionSeed.getByText('Packaged OpenAlex citation expansion seed', { exact: false }).waitFor({ timeout: 30_000 });
  const referenceDirection = page.getByTestId('research-expansion-direction-references');
  const citationDirection = page.getByTestId('research-expansion-direction-citations');
  await referenceDirection.getByText(/Partial|部分完成/u).waitFor({ timeout: 30_000 });
  await citationDirection.getByText(/Partial|部分完成/u).waitFor({ timeout: 30_000 });
  await referenceDirection.getByText(/Truncated|已截断/u).waitFor({ timeout: 30_000 });
  await citationDirection.getByText(/Truncated|已截断/u).waitFor({ timeout: 30_000 });
  await page.getByRole('tab', { name: /Map|地图/u }).click();
  await page.getByTestId('literature-map').waitFor({ timeout: 30_000 });
  assert.equal(
    await page.getByTestId('literature-map-node-https://openalex.org/W900000001').getAttribute('data-seed'),
    'true',
    'The packaged citation expansion did not mark the resolved seed node.',
  );
  const renderedExpansionEdges = await page.locator('svg[aria-label^="Literature network"] line[data-source][data-target]').evaluateAll((lines) => (
    lines.map((line) => [line.getAttribute('data-source'), line.getAttribute('data-target')])
  ));
  assert.deepEqual(
    renderedExpansionEdges,
    [
      ['https://openalex.org/W900000001', 'https://openalex.org/W900000002'],
      ['https://openalex.org/W900000004', 'https://openalex.org/W900000001'],
      ['https://openalex.org/W900000002', 'https://openalex.org/W900000004'],
    ],
    'The packaged research panel did not render the compiled citation edge directions.',
  );

  await page.setViewportSize({ width: 390, height: 800 });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (mobileOverflow > 1) throw new Error(`390px research settings overflow horizontally by ${mobileOverflow}px.`);

  const clearedCredentialStatus = await page.evaluate(async () => {
    return window.rigoriumZoteroCredentials.clear({ confirmed: true });
  });
  assertCredentialStatus(clearedCredentialStatus, false, 'cleared credential status');
  assert.equal(await pathExists(credentialsPath), false, 'Credential ciphertext remained after explicit removal.');
  const desktopLog = await readOptionalText(join(userData, 'desktop.log'));
  assert.equal(desktopLog.includes(verificationCredential), false, 'Credential fixture reached the desktop log.');

  console.log(JSON.stringify({
    executable,
    windows: windows.length,
    appProcesses: runningAppProcesses,
    browserProcessCountBefore,
    browserProcessCountAfter,
    desktopOverflow,
    mobileOverflow,
    arxivVerification,
    openAlexExpansionVerification,
    cloudBrokerRequests: mockBroker.requests.map((request) => `${request.method} ${request.path}`),
    localZoteroRequests: mockBroker.localRequests.map((request) => `${request.method} ${request.path}`),
    title: await page.title(),
  }, null, 2));
} catch (error) {
  const desktopLog = await readOptionalText(join(userData, 'desktop.log'));
  if (desktopLog.trim()) {
    console.error(`Packaged Rigorium desktop log:\n${desktopLog.trimEnd()}`);
  }
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await mockBroker.close();
}

async function startVerificationZoteroBroker() {
  const token = randomBytes(32).toString('base64url');
  const requests = [];
  const localRequests = [];
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const bodyText = await readVerificationRequestBody(request);
      if (requestUrl.pathname === '/v1/zotero/request') {
        if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) {
          return writeVerificationJson(response, 401, { error: 'Unauthorized.' });
        }
        const payload = JSON.parse(bodyText || '{}');
        requests.push({
          method: payload.method,
          path: payload.path,
          headers: payload.headers ?? {},
          body: payload.body,
        });
        const brokerResponse = verificationBrokerResponse(payload);
        return writeVerificationJson(response, brokerResponse.status, {
          status: brokerResponse.status,
          headers: brokerResponse.headers ?? {},
          body: JSON.stringify(brokerResponse.body ?? {}),
        });
      }

      localRequests.push({ method: request.method, path: `${requestUrl.pathname}${requestUrl.search}`, body: bodyText });
      if (requestUrl.pathname === '/connector/getSelectedCollection') {
        return writeVerificationJson(response, 404, { error: 'No active collection in verification.' });
      }
      if (requestUrl.pathname === '/connector/import') {
        if (request.method !== 'POST' || !bodyText.includes('Packaged import verification')) {
          return writeVerificationJson(response, 400, { error: 'Invalid verification import.' });
        }
        return writeVerificationJson(response, 201, { imported: 1 });
      }
      return writeVerificationJson(response, 404, { error: 'Not found.' });
    } catch {
      return writeVerificationJson(response, 500, { error: 'Verification broker failed.' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Verification broker did not receive a port.');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/v1/zotero/request`,
    origin,
    token,
    requests,
    localRequests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function verificationBrokerResponse(payload) {
  if (payload.method === 'GET' && payload.path === '/keys/current') {
    return {
      status: 200,
      body: { userID: 4242, username: 'verification', access: { user: { library: true, write: true } } },
    };
  }
  if (payload.method === 'GET' && payload.path === '/users/4242/items?format=versions&limit=1') {
    return { status: 200, headers: { 'last-modified-version': '7' }, body: {} };
  }
  if (payload.method === 'GET' && payload.path === '/users/4242/items/VERIFYITEM') {
    return {
      status: 200,
      headers: { 'last-modified-version': '7' },
      body: {
        key: 'VERIFYITEM',
        version: 7,
        data: { key: 'VERIFYITEM', itemType: 'journalArticle', tags: [{ tag: 'verified' }] },
      },
    };
  }
  if (payload.method === 'PATCH' && payload.path === '/users/4242/items/VERIFYITEM') {
    return {
      status: 200,
      headers: { 'last-modified-version': '8' },
      body: { successful: { 0: { key: 'VERIFYITEM', version: 8 } } },
    };
  }
  return { status: 404, body: { error: 'Unhandled verification request.' } };
}

async function readVerificationRequestBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('Verification request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeVerificationJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function writeVerificationSettings(rigoriumHome, baseUrl) {
  const settingsDirectory = join(rigoriumHome, 'research');
  await mkdir(settingsDirectory, { recursive: true });
  await writeFile(join(rigoriumHome, 'rigorium.yaml'), `schemaVersion: 1
agent:
  model: verification/verification
model:
  providers:
    verification:
      protocol: openai
      url: http://127.0.0.1:9
      apiKey: verification-not-a-secret
      models:
        verification:
          capabilities:
            maxOutputTokens: 4096
adapters:
  feishu:
    enabled: false
    appId: ""
    appSecret: ""
router:
  enabled: false
cron:
  enabled: false
  timezone: Asia/Shanghai
  maxConcurrentRuns: 1
  runTimeoutMinutes: 5
`, 'utf8');
  await writeFile(join(settingsDirectory, 'settings.json'), `${JSON.stringify({
    schemaVersion: 1,
    literature: {
      enabled: true,
      sources: {
        openalex: { enabled: true, mailto: '' },
        arxiv: { enabled: true },
        crossref: { enabled: true, mailto: '' },
      },
      search: { defaultLimit: 12, fromYear: null, toYear: null, sort: 'relevance' },
      budget: { maxResultsPerSearch: 25, requestTimeoutMs: 20_000 },
      map: { autoOpen: true, autoUpdate: true, showTopicEdges: true },
    },
    zotero: {
      enabled: true,
      baseUrl,
      useSelectedCollection: false,
      collectionKey: 'VERIFYCOLL',
      collectionName: 'Verification Collection',
      cloud: { enabled: true, libraryType: 'user', libraryId: null },
    },
    citation: { style: 'apa', includeDoi: true },
    privacy: { allowRemoteMetadataSearch: true, allowRemoteFullText: false },
  }, null, 2)}\n`, 'utf8');
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

function assertCredentialStatus(value, configured, label) {
  assert.deepEqual(Object.keys(value).sort(), ['configured', 'encryptionAvailable'], `${label} shape is invalid.`);
  assert.equal(typeof value.encryptionAvailable, 'boolean', `${label} must include encryptionAvailable.`);
  assert.equal(typeof value.configured, 'boolean', `${label} must include configured.`);
  assert.equal(value.configured, configured, `${label} configured value is invalid.`);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return '';
    throw error;
  }
}

async function readArxivVerificationReport(path, timeoutMs = 30_000) {
  return readResearchVerificationReport(path, 'arXiv adapter', timeoutMs);
}

async function readOpenAlexExpansionVerificationReport(path, timeoutMs = 30_000) {
  return readResearchVerificationReport(path, 'OpenAlex expansion', timeoutMs);
}

async function readTerminologyVerificationReport(path, timeoutMs = 30_000) {
  return readResearchVerificationReport(path, 'terminology search', timeoutMs);
}

async function readResearchVerificationReport(path, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (!error || typeof error !== 'object' || (error.code !== 'ENOENT' && !(error instanceof SyntaxError))) {
        throw error;
      }
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Packaged ${label} verification did not produce a report within ${timeoutMs}ms: ${lastError?.message || 'unknown error'}`);
}
