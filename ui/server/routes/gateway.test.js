import express from 'express';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

    const pending = await request('/api/gateway/copilot/qr-poll');
    expect(pending.pending).toBe(true);

    const done = await request('/api/gateway/copilot/qr-poll');
    expect(done.ok).toBe(true);

    const saved = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(saved.vision).toEqual({
      enabled: true,
      baseUrl: 'https://api.githubcopilot.com',
      apiKey: 'ghu-copilot-token',
      model: 'gpt-4o',
    });
  });

  it('copilot/qr-poll handles denied login', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, json: async () => ({ device_code: 'dc-1', user_code: 'X', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }) };
      return { ok: true, json: async () => ({ error: 'access_denied' }) };
    }));
    const { request } = await createGatewayApp({});
    await request('/api/gateway/copilot/qr-begin', { method: 'POST' });
    const res = await request('/api/gateway/copilot/qr-poll');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('denied');
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
});
