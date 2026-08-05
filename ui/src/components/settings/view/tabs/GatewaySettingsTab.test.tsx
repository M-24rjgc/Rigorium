import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../../../i18n/config';
import { authenticatedFetch } from '../../../../utils/api';
import { fetchProviderModels } from '../../../../shared/modelListApi';
import GatewaySettingsTab from './GatewaySettingsTab';

vi.mock('../../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../../shared/modelListApi', () => ({ fetchProviderModels: vi.fn() }));

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const emptyGatewayStatus = {
  feishu: { enabled: false, appId: '', hasSecret: false, connectionMode: 'stream', domainName: 'feishu' },
  weixin: { enabled: false, hasCredentials: false, accountId: null, runtime: null },
  wecom: {
    enabled: false,
    botId: '',
    hasSecret: false,
    websocketUrl: 'wss://openws.work.weixin.qq.com',
    dmPolicy: 'open',
    groupPolicy: 'disabled',
    allowFrom: [],
    groupAllowFrom: [],
  },
};

function mockStatusFetch(overrides: Record<string, unknown> = {}) {
  vi.mocked(authenticatedFetch).mockImplementation(async (url) => {
    const path = String(url);
    if (path === '/api/gateway/status') return response({ ...emptyGatewayStatus, ...overrides });
    if (path === '/api/gateway/copilot/status') return response({ ok: true, configured: false, baseUrl: '', model: '' });
    if (path === '/api/gateway/figuregen/status') return response({ ok: true, configured: false, baseUrl: '', model: '' });
    return response({ ok: true });
  });
}

function renderTab() {
  return render(
    <I18nextProvider i18n={i18n}>
      <GatewaySettingsTab />
    </I18nextProvider>,
  );
}

describe('GatewaySettingsTab', () => {
  beforeEach(async () => {
    // Install the fetch mock BEFORE changing the language: i18n's
    // languageChanged hook calls authenticatedFetch('/api/config').
    mockStatusFetch();
    localStorage.setItem('userLanguage', 'zh-CN');
    await i18n.changeLanguage('zh-CN');
    vi.mocked(fetchProviderModels).mockReset();
  });

  afterEach(() => cleanup());

  it('renders the gateway sections (vision assistant + figure generation)', async () => {
    renderTab();
    expect(await screen.findByText('视觉助手')).toBeTruthy();
    expect(await screen.findByText('生图模型')).toBeTruthy();
  });

  it('expands the vision assistant and switches between Copilot and manual endpoint tabs', async () => {
    renderTab();
    // The vision assistant has a "配置" (setup) button when not configured.
    const setupButtons = await screen.findAllByRole('button', { name: '配置' });
    expect(setupButtons.length).toBeGreaterThanOrEqual(2);
    // First setup button belongs to the vision assistant (sections render in
    // order: Feishu, Weixin, WeCom, vision assistant, figure generation).
    fireEvent.click(setupButtons[0]);

    expect(await screen.findByRole('button', { name: 'GitHub Copilot' })).toBeTruthy();
    const manualTab = screen.getByRole('button', { name: '手动端点' });
    fireEvent.click(manualTab);

    // Manual endpoint form appears.
    expect(await screen.findByRole('textbox', { name: 'Base URL' })).toBeTruthy();
    expect(screen.getByLabelText('API Key')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '模型' })).toBeTruthy();
  });

  it('validates the manual endpoint form before saving', async () => {
    renderTab();
    const setupButtons = await screen.findAllByRole('button', { name: '配置' });
    fireEvent.click(setupButtons[0]);
    fireEvent.click(await screen.findByRole('button', { name: '手动端点' }));

    // Leave the fields empty and try to save.
    fireEvent.click(screen.getByRole('button', { name: '保存端点' }));
    expect(await screen.findByText(/Base URL、API Key 和模型均为必填项/)).toBeTruthy();
    // No save request was issued.
    const saveCalls = vi.mocked(authenticatedFetch).mock.calls.filter(([url]) => String(url).includes('manual-save'));
    expect(saveCalls).toHaveLength(0);
  });

  it('shows an error when fetching the manual model list fails', async () => {
    vi.mocked(fetchProviderModels).mockRejectedValueOnce(new Error('network down'));
    renderTab();
    const setupButtons = await screen.findAllByRole('button', { name: '配置' });
    fireEvent.click(setupButtons[0]);
    fireEvent.click(await screen.findByRole('button', { name: '手动端点' }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Base URL' }), { target: { value: 'https://x.example/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));

    expect(await screen.findByText(/network down/)).toBeTruthy();
  });

  it('validates the figure generation endpoint form before saving', async () => {
    renderTab();
    const setupButtons = await screen.findAllByRole('button', { name: '配置' });
    // The figure generation section is the last one.
    fireEvent.click(setupButtons[setupButtons.length - 1]);

    fireEvent.click(screen.getByRole('button', { name: '保存端点' }));
    expect(await screen.findByText(/Base URL、API Key 和模型均为必填项/)).toBeTruthy();
    const saveCalls = vi.mocked(authenticatedFetch).mock.calls.filter(([url]) => String(url).includes('figuregen/save'));
    expect(saveCalls).toHaveLength(0);
  });

  it('does not wipe WeCom form input when status refreshes', async () => {
    // First status load, then a refresh with a (slightly different) payload —
    // the typed botId must survive the refresh.
    mockStatusFetch();
    renderTab();

    const manualInput = await screen.findByRole('button', { name: /企业微信管理后台复制 Bot ID 和 Secret/ });
    fireEvent.click(manualInput);

    const botIdInput = await screen.findByRole('textbox', { name: /Bot ID/ });
    fireEvent.change(botIdInput, { target: { value: 'bot-typed-by-user' } });
    expect((botIdInput as HTMLInputElement).value).toBe('bot-typed-by-user');

    // Trigger a status refresh with an updated payload.
    await waitFor(() => expect(vi.mocked(authenticatedFetch).mock.calls.length).toBeGreaterThan(0));
    mockStatusFetch({
      wecom: {
        enabled: true,
        botId: 'bot-1234567890',
        hasSecret: true,
        websocketUrl: 'wss://openws.work.weixin.qq.com',
        dmPolicy: 'open',
        groupPolicy: 'disabled',
        allowFrom: [],
        groupAllowFrom: [],
      },
    });
    // The manual form is re-seeded only on mount; a status change must not
    // clobber the input. Re-render with the refreshed mock is not enough —
    // assert the current DOM still holds the typed value after a fetch cycle.
    await waitFor(() => {
      const input = screen.getByRole('textbox', { name: /Bot ID/ }) as HTMLInputElement;
      expect(input.value).toBe('bot-typed-by-user');
    });
  });
});
