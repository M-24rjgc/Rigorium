import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;
const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.RIGORIUM_HOME;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('commands routes', () => {
  it('executes user commands discovered under custom RIGORIUM_HOME', async () => {
    const rigoriumHome = mkdtempSync(join(tmpdir(), 'rigorium-commands-route-'));
    tempDirs.push(rigoriumHome);
    process.env.RIGORIUM_HOME = rigoriumHome;

    const commandsDir = join(rigoriumHome, 'commands');
    mkdirSync(commandsDir, { recursive: true });
    const commandPath = join(commandsDir, 'hello.md');
    writeFileSync(commandPath, '---\ndescription: Says hello\n---\nHello $1', 'utf8');

    const { request } = await createCommandsApp();

    const result = await request('/api/commands/execute', {
      method: 'POST',
      body: JSON.stringify({
        commandName: '/hello',
        commandPath,
        args: ['Rigorium'],
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      type: 'custom',
      command: '/hello',
      content: 'Hello Rigorium',
    });
  });

  it('loads project commands through native Windows separators', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), 'rigorium-project-command-'));
    tempDirs.push(projectRoot);
    const commandsDir = join(projectRoot, '.rigorium', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    const commandPath = join(commandsDir, 'focus.md');
    writeFileSync(commandPath, '---\ndescription: Focus work\n---\nFocus', 'utf8');

    const { request } = await createCommandsApp();
    const result = await request('/api/commands/load', {
      method: 'POST',
      body: JSON.stringify({ commandPath }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      path: commandPath,
      content: 'Focus',
    });
  });

  it('keeps project Skills on the passthrough path with native Windows separators', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), 'rigorium-project-skill-'));
    tempDirs.push(projectRoot);
    const skillDir = join(projectRoot, '.rigorium', 'skills', 'focus');
    mkdirSync(skillDir, { recursive: true });
    const commandPath = join(skillDir, 'SKILL.md');
    writeFileSync(commandPath, '# Focus\n', 'utf8');

    const { request } = await createCommandsApp();
    const result = await request('/api/commands/execute', {
      method: 'POST',
      body: JSON.stringify({
        commandName: '/focus',
        commandPath,
        args: ['now'],
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      type: 'custom',
      command: '/focus',
      content: '/focus now',
      metadata: { type: 'skill', passthrough: true },
    });
  });
});

async function createCommandsApp() {
  vi.doMock('../../shared/modelConstants.js', () => ({
    CODEX_MODELS: [],
    CURSOR_MODELS: [],
  }));
  vi.doMock('../utils/claude-runtime-config.js', () => ({
    getClaudeRuntimeModelConfig: vi.fn(() => ({})),
    getClaudeRuntimeModelValues: vi.fn(() => []),
  }));
  vi.doMock('../services/rigoriumConfig.js', () => ({
    readRigoriumConfigFile: vi.fn(() => ({ config: {} })),
    resolveModel: vi.fn((model) => model),
  }));
  vi.doMock('../turnkey-slash.js', () => ({
    executeTurnkeySlashCommand: vi.fn(async () => ({})),
  }));
  vi.doMock('../../../src/adapters/channel/protocol/ChannelCommandRegistry.js', () => ({
    getRegisteredCommands: vi.fn(() => []),
  }));
  vi.doMock('../../../src/cli/commands/chatSearch.js', () => ({
    runChatSearchFormatted: vi.fn(async () => ({ result: {}, text: '' })),
  }));

  const { default: commandsRoutes } = await import('./commands.js');
  const app = express();
  app.use(express.json());
  app.use('/api/commands', commandsRoutes);

  return {
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
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
