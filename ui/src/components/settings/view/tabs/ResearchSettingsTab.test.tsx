import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../../../i18n/config';
import type { ResearchSettings } from '../../../../research/types';
import { authenticatedFetch } from '../../../../utils/api';
import ResearchSettingsTab from './ResearchSettingsTab';

vi.mock('../../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));

const settings: ResearchSettings = {
  schemaVersion: 1,
  literature: {
    enabled: true,
    sources: {
      openalex: { enabled: true, mailto: '' },
      crossref: { enabled: true, mailto: '' },
    },
    search: { defaultLimit: 12, fromYear: null, toYear: null, sort: 'relevance' },
    budget: { maxResultsPerSearch: 25, requestTimeoutMs: 20_000 },
    map: { autoOpen: true, autoUpdate: true, showTopicEdges: true },
  },
  zotero: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:23119',
    useSelectedCollection: true,
    collectionKey: null,
    collectionName: null,
    cloud: { enabled: false, libraryType: 'user', libraryId: null },
  },
  citation: { style: 'apa', includeDoi: true },
  privacy: { allowRemoteMetadataSearch: true, allowRemoteFullText: false },
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requestBody(call: readonly unknown[] | undefined): string {
  const options = call?.[1];
  return String(options && typeof options === 'object' && 'body' in options ? options.body : '');
}

function requestOptions(value: unknown): RequestInit {
  return value && typeof value === 'object' ? value as RequestInit : {};
}

describe('ResearchSettingsTab Zotero collections', () => {
  let collectionsPayload: unknown;
  let credentialSave: ReturnType<typeof vi.fn>;
  let credentialClear: ReturnType<typeof vi.fn>;

  afterEach(() => cleanup());

  beforeEach(() => {
    credentialSave = vi.fn().mockResolvedValue({ encryptionAvailable: true, configured: true });
    credentialClear = vi.fn().mockResolvedValue({ encryptionAvailable: true, configured: false });
    Object.defineProperty(window, 'rigoriumZoteroCredentials', {
      configurable: true,
      value: {
        status: vi.fn().mockResolvedValue({ encryptionAvailable: true, configured: false }),
        save: credentialSave,
        clear: credentialClear,
      },
    });
    Object.defineProperty(window, 'rigoriumZoteroCloud', {
      configurable: true,
      value: {
        status: vi.fn().mockResolvedValue({
          provider: 'zotero-cloud', status: 'ready', configured: true, available: true, writable: true,
          checkedAt: '2026-07-22T00:00:00.000Z', libraryVersion: 10,
          library: { type: 'user', id: '1', path: '/users/1' },
        }),
        sync: vi.fn(),
        preview: vi.fn(),
        confirm: vi.fn(),
      },
    });
    collectionsPayload = {
      provider: 'zotero',
      available: true,
      collections: [
        { key: 'PARENT1', name: 'Research' },
        { key: 'PAPERS1', name: 'Papers', parentKey: 'PARENT1', itemCount: 18 },
      ],
      total: 2,
      truncated: false,
    };
    vi.mocked(authenticatedFetch).mockReset();
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const options = requestOptions(init);
      if (url.startsWith('/api/research/settings') && options.method !== 'PUT') {
        return response({ global: settings, effective: settings, projectOverride: null, paths: { global: 'settings.json' } });
      }
      if (url.startsWith('/api/research/zotero/collections')) {
        return response(collectionsPayload);
      }
      if (url === '/api/research/settings' && options.method === 'PUT') {
        const saved = JSON.parse(String(options.body)).settings as ResearchSettings;
        return response({ global: saved, effective: saved, projectOverride: null, paths: { global: 'settings.json' } });
      }
      return response({ error: `Unexpected request: ${url}` });
    });
  });

  it('browses collections and saves a fixed collection binding', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchSettingsTab projects={[]} />
      </I18nextProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Browse collections|浏览 Collection/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Bind Papers|绑定 Papers/i }));
    expect(screen.getAllByText('Papers').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /Save research settings|保存科研设置/i }));
    await waitFor(() => expect(vi.mocked(authenticatedFetch).mock.calls.some(([, init]) => requestOptions(init).method === 'PUT')).toBe(true));

    const saveCall = vi.mocked(authenticatedFetch).mock.calls.find(([, init]) => requestOptions(init).method === 'PUT');
    const payload = JSON.parse(requestBody(saveCall));
    expect(payload.settings.zotero).toMatchObject({
      useSelectedCollection: false,
      collectionKey: 'PAPERS1',
      collectionName: 'Papers',
    });
  });

  it('normalizes legacy settings, exposes both source controls, and warns before saving with all sources off', async () => {
    const legacySettings: ResearchSettings = {
      ...settings,
      literature: {
        ...settings.literature,
        sources: { openalex: { enabled: true, mailto: '' } },
      },
    };
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const options = requestOptions(init);
      if (url.startsWith('/api/research/settings') && options.method !== 'PUT') {
        return response({ global: legacySettings, effective: legacySettings, projectOverride: null, paths: { global: 'settings.json' } });
      }
      if (url === '/api/research/settings' && options.method === 'PUT') {
        const saved = JSON.parse(String(options.body)).settings as ResearchSettings;
        return response({ global: saved, effective: saved, projectOverride: null, paths: { global: 'settings.json' } });
      }
      return response({ error: `Unexpected request: ${url}` });
    });

    render(
      <I18nextProvider i18n={i18n}>
        <ResearchSettingsTab projects={[]} />
      </I18nextProvider>,
    );

    const openAlexToggle = await screen.findByRole('switch', { name: 'OpenAlex' });
    const crossrefToggle = screen.getByRole('switch', { name: 'Crossref' });
    expect(crossrefToggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.change(screen.getByRole('textbox', { name: 'Crossref contact email' }), {
      target: { value: 'researcher@example.test' },
    });
    fireEvent.click(openAlexToggle);
    fireEvent.click(crossrefToggle);
    expect(screen.getByRole('status').textContent).toContain('No literature source is enabled.');

    fireEvent.click(screen.getByRole('button', { name: /Save research settings|保存科研设置/i }));
    await waitFor(() => expect(vi.mocked(authenticatedFetch).mock.calls.some(([, init]) => requestOptions(init).method === 'PUT')).toBe(true));

    const saveCall = vi.mocked(authenticatedFetch).mock.calls.find(([, init]) => requestOptions(init).method === 'PUT');
    const payload = JSON.parse(requestBody(saveCall));
    expect(payload.settings.literature.sources).toMatchObject({
      openalex: { enabled: false, mailto: '' },
      crossref: { enabled: false, mailto: 'researcher@example.test' },
    });
  });

  it('shows a Zotero availability error returned with HTTP 200', async () => {
    collectionsPayload = {
      provider: 'zotero',
      available: false,
      error: 'Zotero Desktop is not running.',
      collections: [],
      total: 0,
      truncated: false,
    };
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchSettingsTab projects={[]} />
      </I18nextProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Browse collections|浏览 Collection/i }));
    expect(await screen.findByText('Zotero Desktop is not running.')).not.toBeNull();
    expect(screen.queryByText(/No collections found|没有找到 Collection/i)).toBeNull();
  });

  it('stores and removes the global cloud credential through the desktop bridge with explicit removal confirmation', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ResearchSettingsTab projects={[]} />
      </I18nextProvider>,
    );

    const credentialInput = await screen.findByLabelText('Secure API credential');
    fireEvent.change(credentialInput, { target: { value: 'zotero-api-key-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: 'Store key' }));
    await waitFor(() => expect(credentialSave).toHaveBeenCalledWith('zotero-api-key-1234567890'));
    expect(await screen.findByRole('button', { name: 'Remove key' })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    expect(credentialClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    await waitFor(() => expect(credentialClear).toHaveBeenCalledWith({ confirmed: true }));
  });
});
