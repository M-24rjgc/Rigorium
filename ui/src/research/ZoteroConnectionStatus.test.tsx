import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ZoteroConnectionStatus from './ZoteroConnectionStatus';
import { getZoteroConnectionStatus } from './zoteroConnectionApi';
import { getZoteroCloudStatus, probeZoteroCloudSync } from './zoteroCloudApi';

vi.mock('./zoteroConnectionApi', () => ({ getZoteroConnectionStatus: vi.fn() }));
vi.mock('./zoteroCloudApi', () => ({
  getZoteroCloudStatus: vi.fn(),
  probeZoteroCloudSync: vi.fn(),
}));

const localConnected = {
  provider: 'zotero' as const,
  available: true,
  apiReady: true,
  connectorReady: true,
  checkedAt: '2026-07-23T00:00:00.000Z',
  selectedCollection: { name: 'Current literature', libraryName: 'My Library' },
};

const cloudConnected = {
  provider: 'zotero-cloud' as const,
  status: 'ready' as const,
  configured: true,
  available: true,
  writable: true,
  checkedAt: '2026-07-23T00:00:00.000Z',
  libraryVersion: 12,
  library: { type: 'user' as const, id: '1', path: '/users/1' },
};

describe('ZoteroConnectionStatus', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.mocked(getZoteroConnectionStatus).mockReset();
    vi.mocked(getZoteroCloudStatus).mockReset();
    vi.mocked(probeZoteroCloudSync).mockReset();
    vi.mocked(getZoteroConnectionStatus).mockResolvedValue(localConnected);
    vi.mocked(getZoteroCloudStatus).mockResolvedValue(cloudConnected);
  });

  it('shows local and cloud connection state, then probes changes only after an explicit action', async () => {
    vi.mocked(probeZoteroCloudSync).mockResolvedValue({
      status: 'updated',
      checkedAt: '2026-07-23T00:01:00.000Z',
      provider: cloudConnected,
      sinceVersion: 12,
      libraryVersion: 13,
      itemVersions: { A1: 13, B2: 13 },
      collectionVersions: { C1: 13 },
      deleted: { items: [], collections: [], searches: [] },
    });

    render(<ZoteroConnectionStatus projectPath="D:/project" />);

    await waitFor(() => expect(getZoteroConnectionStatus).toHaveBeenCalledWith({ projectPath: 'D:/project' }));
    expect(getZoteroCloudStatus).toHaveBeenCalledWith({ projectPath: 'D:/project' });
    expect(screen.getByTestId('zotero-local-status').textContent).toContain('Connected');
    expect(screen.getByTestId('zotero-cloud-status').textContent).toContain('Connected');
    expect(probeZoteroCloudSync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Check Zotero changes' }));
    await waitFor(() => expect(probeZoteroCloudSync).toHaveBeenCalledWith({ projectPath: 'D:/project', sinceVersion: 12 }));
    expect(screen.getByTestId('zotero-sync-result').textContent).toContain('3 Zotero changes found');
  });

  it('keeps sync disabled when either connection check cannot establish cloud availability', async () => {
    vi.mocked(getZoteroConnectionStatus).mockRejectedValue(new Error('Zotero Desktop is not running.'));
    vi.mocked(getZoteroCloudStatus).mockRejectedValue(new Error('Zotero cloud access requires the Rigorium desktop app.'));

    render(<ZoteroConnectionStatus />);

    expect((await screen.findByTestId('zotero-local-status')).textContent).toContain('Zotero Desktop is not running.');
    expect(screen.getByTestId('zotero-cloud-status').textContent).toContain('Zotero cloud access requires the Rigorium desktop app.');
    expect((screen.getByRole('button', { name: 'Check Zotero changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(probeZoteroCloudSync).not.toHaveBeenCalled();
  });
});
