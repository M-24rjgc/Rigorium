import express from 'express';
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;
const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.RIGORIUM_HOME;
  delete process.env.RIGORIUM_CONFIG_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('gateway WeCom routes', () => {
  it('returns WeCom status from rigorium.yaml', async () => {
    const { request } = await createGatewayApp({
      adapters: {
        wecom: {
          enabled: true,
          token: 'bot-1234567890',
          extra: {
            secret: 'secret',
            websocket_url: 'wss://custom.example',
            dm_policy: 'open',
            group_policy: 'disabled',
            allow_from: ['user-a'],
            group_allow_from: ['group-a'],
          },
        },
      },
    });

    const status = await request('/api/gateway/status');

    expect(status.wecom).toEqual({
      enabled: true,
      botId: 'bot-…7890',
      hasSecret: true,
      websocketUrl: 'wss://custom.example',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: ['user-a'],
      groupAllowFrom: ['group-a'],
    });
  });

  it('saves manual WeCom config to rigorium.yaml', async () => {
    const { request, configPath } = await createGatewayApp({});

    const result = await request('/api/gateway/wecom/save', {
      method: 'POST',
      body: JSON.stringify({
        botId: 'bot-manual',
        secret: 'secret-manual',
        websocketUrl: 'wss://custom.example',
        dmPolicy: 'allowlist',
        groupPolicy: 'allowlist',
        allowFrom: 'user-a, user-b',
        groupAllowFrom: ['group-a', 'group-b'],
      }),
    });

    expect(result.ok).toBe(true);
    const config = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(config.adapters.wecom).toEqual({
      enabled: true,
      token: 'bot-manual',
      extra: {
        secret: 'secret-manual',
        websocket_url: 'wss://custom.example',
        dm_policy: 'allowlist',
        group_policy: 'allowlist',
        allow_from: ['user-a', 'user-b'],
        group_allow_from: ['group-a', 'group-b'],
      },
    });
  });

  it('preserves existing WeCom credentials on settings-only saves', async () => {
    const { request, configPath } = await createGatewayApp({
      adapters: {
        wecom: {
          enabled: true,
          token: 'bot-existing',
          extra: {
            secret: 'secret-existing',
            websocket_url: 'wss://old.example',
            dm_policy: 'open',
            group_policy: 'disabled',
          },
        },
      },
    });

    const result = await request('/api/gateway/wecom/save', {
      method: 'POST',
      body: JSON.stringify({
        websocketUrl: 'wss://new.example',
        dmPolicy: 'disabled',
        groupPolicy: 'open',
      }),
    });

    expect(result.ok).toBe(true);
    const config = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(config.adapters.wecom).toEqual({
      enabled: true,
      token: 'bot-existing',
      extra: {
        secret: 'secret-existing',
        websocket_url: 'wss://new.example',
        dm_policy: 'disabled',
        group_policy: 'open',
      },
    });
  });

  it('disables WeCom config', async () => {
    const { request, configPath } = await createGatewayApp({
      adapters: {
        wecom: {
          enabled: true,
          token: 'bot-id',
          extra: { secret: 'secret' },
        },
      },
    });

    const result = await request('/api/gateway/wecom/disable', { method: 'POST' });

    expect(result.ok).toBe(true);
    const config = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(config.adapters.wecom.enabled).toBe(false);
  });

  it('writes WeCom config after successful QR polling', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const href = String(url);
      if (href.includes('/generate')) {
        return jsonResponse({
          data: {
            scode: 'scan-code',
            auth_url: 'https://work.weixin.qq.com/scan',
          },
        });
      }
      return jsonResponse({
        data: {
          status: 'success',
          bot_info: {
            botid: 'bot-from-qr',
            secret: 'secret-from-qr',
          },
        },
      });
    }));
    const { request, configPath } = await createGatewayApp({});

    const begin = await request('/api/gateway/wecom/qr-begin', { method: 'POST' });
    expect(begin.ok).toBe(true);
    expect(begin.qrUrl).toBe('https://work.weixin.qq.com/scan');

    const poll = await request('/api/gateway/wecom/qr-poll');
    expect(poll).toEqual({ ok: true, botId: 'bot-…m-qr' });

    const config = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(config.adapters.wecom).toEqual({
      enabled: true,
      token: 'bot-from-qr',
      extra: {
        secret: 'secret-from-qr',
        websocket_url: 'wss://openws.work.weixin.qq.com',
        dm_policy: 'open',
        group_policy: 'disabled',
      },
    });
  });
});

async function createGatewayApp(initialConfig) {
  const rigoriumHome = mkdtempSync(join(tmpdir(), 'rigorium-wecom-gateway-'));
  tempDirs.push(rigoriumHome);
  const configPath = join(rigoriumHome, 'rigorium.yaml');
  writeFileSync(configPath, stringifyYaml(initialConfig), 'utf-8');

  process.env.RIGORIUM_HOME = rigoriumHome;
  process.env.RIGORIUM_CONFIG_PATH = configPath;
  vi.resetModules();
  vi.doMock('../services/rigoriumConfigWatcher.js', () => ({
    suppressNextWatchEvent: vi.fn(),
  }));
  vi.doMock('../services/rigoriumConfigReloader.js', () => ({
    reloadRigoriumConfig: vi.fn(async () => undefined),
  }));
  vi.doMock('../services/rigoriumConfig.js', () => ({
    readRigoriumConfigFile: vi.fn(() => ({ config: {} })),
  }));
  vi.doMock('../rigorium-bridge.js', () => ({
    getRigoriumGateway: vi.fn(async () => ({ reloadConfig: vi.fn(async () => undefined) })),
  }));

  const { default: gatewayRoutes } = await import('./gateway.js');
  const app = express();
  app.use(express.json());
  app.use('/api/gateway', gatewayRoutes);

  return {
    configPath,
    request: (path, init) => requestJson(app, path, init),
  };
}

async function requestJson(app, path, init = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      ...init,
    });
    return response.json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
}

describe('gateway Copilot routes', () => {
  it('reports vision not configured when empty or placeholder', async () => {
    const { request } = await createGatewayApp({});
    const empty = await request('/api/gateway/copilot/status');
    expect(empty.configured).toBe(false);

    const { request: request2 } = await createGatewayApp({
      vision: { enabled: true, baseUrl: 'https://placeholder.invalid', apiKey: 'x', model: 'm' },
    });
    const placeholder = await request2('/api/gateway/copilot/status');
    expect(placeholder.configured).toBe(false);
  });

  it('copilot/qr-begin returns the user code from GitHub', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        device_code: 'dc-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-1234',
        expires_in: 900,
        interval: 5,
      }),
    })));
    const { request } = await createGatewayApp({});
    const res = await request('/api/gateway/copilot/qr-begin', { method: 'POST' });
    expect(res.ok).toBe(true);
    expect(res.userCode).toBe('ABCD-1234');
    expect(res.sessionId).toBeTruthy();
    expect(res.interval).toBe(5);
    expect(res.verificationUriComplete).toContain('user_code=ABCD-1234');
  });

  it('copilot/qr-poll stays pending until the user confirms, then writes vision config', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, json: async () => ({ device_code: 'dc-123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }) };
      }
      // First poll: still pending. Second poll: token granted.
      if (calls === 2) return { ok: true, json: async () => ({ error: 'authorization_pending' }) };
      return { ok: true, json: async () => ({ access_token: 'ghu-copilot-token', scope: 'copilot' }) };
    }));
    const { request, configPath } = await createGatewayApp({});
    const begin = await request('/api/gateway/copilot/qr-begin', { method: 'POST' });
    expect(begin.ok).toBe(true);

    const pending = await request(`/api/gateway/copilot/qr-poll?sessionId=${begin.sessionId}`);
    expect(pending.pending).toBe(true);

    const done = await request(`/api/gateway/copilot/qr-poll?sessionId=${begin.sessionId}`);
    expect(done.ok).toBe(true);

    const saved = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(saved.vision).toEqual({
      enabled: true,
      baseUrl: 'https://api.githubcopilot.com',
      apiKey: 'ghu-copilot-token',
      model: 'gpt-4o',
    });
  });

  it('copilot concurrent logins keep separate sessions (second begin must not clobber the first)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ device_code: 'dc-shared', user_code: 'X', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }),
    })));
    const { request } = await createGatewayApp({});
    const first = await request('/api/gateway/copilot/qr-begin', { method: 'POST' });
    const second = await request('/api/gateway/copilot/qr-begin', { method: 'POST' });
    expect(first.sessionId).toBeTruthy();
    expect(second.sessionId).toBeTruthy();
    expect(first.sessionId).not.toBe(second.sessionId);

    // Polling the FIRST session still works even though a second begin ran.
    const pollFirst = await request(`/api/gateway/copilot/qr-poll?sessionId=${first.sessionId}`);
    expect(pollFirst.pending).toBe(true);

    // A bogus session id must not accidentally match.
    const pollBogus = await request('/api/gateway/copilot/qr-poll?sessionId=nope');
    expect(pollBogus.ok).toBe(false);

    // Cancel only the second session; the first stays cancellable/alive.
    const cancelSecond = await request('/api/gateway/copilot/qr-cancel', {
      method: 'POST',
      body: JSON.stringify({ sessionId: second.sessionId }),
    });
    expect(cancelSecond.ok).toBe(true);
    const pollFirstAfter = await request(`/api/gateway/copilot/qr-poll?sessionId=${first.sessionId}`);
    expect(pollFirstAfter.pending).toBe(true);
    const pollSecondGone = await request(`/api/gateway/copilot/qr-poll?sessionId=${second.sessionId}`);
    expect(pollSecondGone.ok).toBe(false);
  });

  it('copilot/qr-poll handles denied login', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, json: async () => ({ device_code: 'dc-1', user_code: 'X', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }) };
      return { ok: true, json: async () => ({ error: 'access_denied' }) };
    }));
    const { request } = await createGatewayApp({});
    const begin = await request('/api/gateway/copilot/qr-begin', { method: 'POST' });
    const res = await request(`/api/gateway/copilot/qr-poll?sessionId=${begin.sessionId}`);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('denied');
  });

  it('copilot/qr-poll reports slow_down with the backoff interval', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, json: async () => ({ device_code: 'dc-1', user_code: 'X', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }) };
      return { ok: true, json: async () => ({ error: 'slow_down' }) };
    }));
    const { request } = await createGatewayApp({});
    const begin = await request('/api/gateway/copilot/qr-begin', { method: 'POST' });
    const res = await request(`/api/gateway/copilot/qr-poll?sessionId=${begin.sessionId}`);
    expect(res.pending).toBe(true);
    // GitHub adds 5s to the interval on slow_down; the client must wait 10s.
    expect(res.interval).toBe(10);
  });

  it('copilot/qr-poll surfaces a GitHub network failure instead of endless pending', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      // begin succeeds; the token poll then hits a network failure.
      if (calls === 1) return { ok: true, json: async () => ({ device_code: 'dc-1', user_code: 'X', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }) };
      throw new Error('ECONNRESET: socket hang up');
    }));
    const { request } = await createGatewayApp({});
    const begin = await request('/api/gateway/copilot/qr-begin', { method: 'POST' });
    expect(begin.ok).toBe(true);
    const res = await request(`/api/gateway/copilot/qr-poll?sessionId=${begin.sessionId}`);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('连接 GitHub 失败');
    expect(res.pending).toBeUndefined();
  });

  it('copilot/qr-poll expired_token clears the session', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, json: async () => ({ device_code: 'dc-x', user_code: 'X', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }) };
      return { ok: true, json: async () => ({ error: 'expired_token' }) };
    }));
    const { request } = await createGatewayApp({});
    const begin = await request('/api/gateway/copilot/qr-begin', { method: 'POST' });
    const res = await request(`/api/gateway/copilot/qr-poll?sessionId=${begin.sessionId}`);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('expired');
    // The session must actually be removed so a follow-up poll fails fast.
    const after = await request(`/api/gateway/copilot/qr-poll?sessionId=${begin.sessionId}`);
    expect(after.ok).toBe(false);
    expect(after.error).toContain('No Copilot login session');
  });

  it('copilot/disable clears the vision api key', async () => {
    const { request, configPath } = await createGatewayApp({
      vision: { enabled: true, baseUrl: 'https://api.githubcopilot.com', apiKey: 'ghu-x', model: 'gpt-4o' },
    });
    const res = await request('/api/gateway/copilot/disable', { method: 'POST' });
    expect(res.ok).toBe(true);
    const saved = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(saved.vision.enabled).toBe(false);
    expect(saved.vision.apiKey).toBeUndefined();
  });

  it('copilot/manual-save writes an OpenAI-compatible vision endpoint', async () => {
    const { request, configPath } = await createGatewayApp({});
    const res = await request('/api/gateway/copilot/manual-save', {
      method: 'POST',
      body: JSON.stringify({
        baseUrl: 'https://api.newapi.example/v1/',
        apiKey: 'sk-manual-123',
        model: 'gpt-4o-mini',
      }),
    });
    expect(res.ok).toBe(true);
    const saved = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(saved.vision.enabled).toBe(true);
    expect(saved.vision.baseUrl).toBe('https://api.newapi.example/v1'); // trailing slash trimmed
    expect(saved.vision.apiKey).toBe('sk-manual-123');
    expect(saved.vision.model).toBe('gpt-4o-mini');

    const status = await request('/api/gateway/copilot/status');
    expect(status.configured).toBe(true);
    expect(status.baseUrl).toBe('https://api.newapi.example/v1');
    expect(status.model).toBe('gpt-4o-mini');
  });

  it('copilot/manual-save rejects missing fields', async () => {
    const { request } = await createGatewayApp({});
    const missingModel = await request('/api/gateway/copilot/manual-save', {
      method: 'POST',
      body: JSON.stringify({ baseUrl: 'https://x.example', apiKey: 'sk-1' }),
    });
    expect(missingModel.ok).toBe(false);
    expect(missingModel.error).toContain('required');

    const emptyKey = await request('/api/gateway/copilot/manual-save', {
      method: 'POST',
      body: JSON.stringify({ baseUrl: 'https://x.example', apiKey: '', model: 'm' }),
    });
    expect(emptyKey.ok).toBe(false);
  });

  it('copilot/models lists subscription models with the saved token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'claude-sonnet-4' }] }),
    })));
    const { request } = await createGatewayApp({
      vision: { enabled: true, baseUrl: 'https://api.githubcopilot.com', apiKey: 'ghu-token', model: 'gpt-4o' },
    });
    const res = await request('/api/gateway/copilot/models');
    expect(res.ok).toBe(true);
    expect(res.models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4']);
    // The request must carry the saved token.
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.githubcopilot.com/models',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer ghu-token' }) }),
    );
  });

  it('copilot/models requires a signed-in session', async () => {
    const { request } = await createGatewayApp({});
    const res = await request('/api/gateway/copilot/models');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Sign in');
  });

  it('copilot/model-save updates only the vision model', async () => {
    const { request, configPath } = await createGatewayApp({
      vision: { enabled: true, baseUrl: 'https://api.githubcopilot.com', apiKey: 'ghu-token', model: 'gpt-4o' },
    });
    const res = await request('/api/gateway/copilot/model-save', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o-mini' }),
    });
    expect(res.ok).toBe(true);
    const saved = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(saved.vision.model).toBe('gpt-4o-mini');
    expect(saved.vision.apiKey).toBe('ghu-token'); // token untouched
  });

  it('figuregen/status reports not configured when empty or placeholder', async () => {
    const { request } = await createGatewayApp({});
    const empty = await request('/api/gateway/figuregen/status');
    expect(empty.configured).toBe(false);

    const { request: request2 } = await createGatewayApp({
      figureGen: { enabled: true, baseUrl: 'https://placeholder.invalid', apiKey: 'x', model: 'm' },
    });
    const placeholder = await request2('/api/gateway/figuregen/status');
    expect(placeholder.configured).toBe(false);
  });

  it('figuregen/save writes the figure endpoint and rejects missing fields', async () => {
    const { request, configPath } = await createGatewayApp({});
    const res = await request('/api/gateway/figuregen/save', {
      method: 'POST',
      body: JSON.stringify({
        baseUrl: 'https://api.newapi.example/v1/',
        apiKey: 'sk-figure-1',
        model: 'gpt-image-2',
      }),
    });
    expect(res.ok).toBe(true);
    const saved = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(saved.figureGen.enabled).toBe(true);
    expect(saved.figureGen.baseUrl).toBe('https://api.newapi.example/v1');
    expect(saved.figureGen.model).toBe('gpt-image-2');

    const status = await request('/api/gateway/figuregen/status');
    expect(status.configured).toBe(true);

    const bad = await request('/api/gateway/figuregen/save', {
      method: 'POST',
      body: JSON.stringify({ baseUrl: 'https://x.example' }),
    });
    expect(bad.ok).toBe(false);
  });

  it('figuregen/disable clears the figure api key', async () => {
    const { request, configPath } = await createGatewayApp({
      figureGen: { enabled: true, baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-fig', model: 'gpt-image-2' },
    });
    const res = await request('/api/gateway/figuregen/disable', { method: 'POST' });
    expect(res.ok).toBe(true);
    const saved = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(saved.figureGen.enabled).toBe(false);
    expect(saved.figureGen.apiKey).toBeUndefined();
  });

  it('refuses to overwrite a config file with broken YAML', async () => {
    const { request, configPath } = await createGatewayApp({});
    // Corrupt the file after app creation: the write paths must refuse to
    // save instead of overwriting the whole config with a near-empty doc.
    writeFileSync(configPath, 'adapters: [unclosed\n  broken: {', 'utf-8');
    const res = await request('/api/gateway/copilot/manual-save', {
      method: 'POST',
      body: JSON.stringify({ baseUrl: 'https://x.example/v1', apiKey: 'sk-1', model: 'm' }),
    });
    expect(res.ok).toBe(false);
    const onDisk = readFileSync(configPath, 'utf-8');
    expect(onDisk).toContain('unclosed'); // file untouched
  });

  it('copilot/manual-save reuses the stored api key when blank', async () => {
    const { request, configPath } = await createGatewayApp({
      vision: { enabled: true, baseUrl: 'https://old.example/v1', apiKey: 'sk-stored', model: 'm1' },
    });
    const res = await request('/api/gateway/copilot/manual-save', {
      method: 'POST',
      body: JSON.stringify({ baseUrl: 'https://new.example/v1', apiKey: '', model: 'm2' }),
    });
    expect(res.ok).toBe(true);
    const saved = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(saved.vision.apiKey).toBe('sk-stored');
    expect(saved.vision.baseUrl).toBe('https://new.example/v1');
    expect(saved.vision.model).toBe('m2');
  });

  it('copilot/manual-save still requires a key when nothing is stored', async () => {
    const { request } = await createGatewayApp({});
    const res = await request('/api/gateway/copilot/manual-save', {
      method: 'POST',
      body: JSON.stringify({ baseUrl: 'https://x.example/v1', apiKey: '', model: 'm' }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('apiKey');
  });

  it('figuregen/save reuses the stored api key when blank', async () => {
    const { request, configPath } = await createGatewayApp({
      figureGen: { enabled: true, baseUrl: 'https://old.example/v1', apiKey: 'sk-fig', model: 'gpt-image-1' },
    });
    const res = await request('/api/gateway/figuregen/save', {
      method: 'POST',
      body: JSON.stringify({ baseUrl: 'https://new.example/v1', apiKey: '', model: 'gpt-image-2' }),
    });
    expect(res.ok).toBe(true);
    const saved = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(saved.figureGen.apiKey).toBe('sk-fig');
    expect(saved.figureGen.model).toBe('gpt-image-2');
  });

  it('copilot/disable removes the standalone token file', async () => {
    const { request, configPath } = await createGatewayApp({
      vision: { enabled: true, baseUrl: 'https://api.githubcopilot.com', apiKey: 'ghu-x', model: 'gpt-4o' },
    });
    const tokenFile = join(dirname(configPath), 'copilot-token.json');
    writeFileSync(tokenFile, JSON.stringify({ accessToken: 'ghu-x' }), 'utf-8');
    const res = await request('/api/gateway/copilot/disable', { method: 'POST' });
    expect(res.ok).toBe(true);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it('copilot/models treats a non-array payload as failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ object: 'list' }), // no .data array
    })));
    const { request } = await createGatewayApp({
      vision: { enabled: true, baseUrl: 'https://api.githubcopilot.com', apiKey: 'ghu-token', model: 'gpt-4o' },
    });
    const res = await request('/api/gateway/copilot/models');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unexpected');
  });
});
