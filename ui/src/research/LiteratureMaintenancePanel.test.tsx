import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiteratureMaintenancePanel from './LiteratureMaintenancePanel';

const api = vi.hoisted(() => ({
  loadProjectLiteratureMapMaintenanceAudits: vi.fn(),
  runProjectLiteratureMapMaintenance: vi.fn(),
}));
const authenticatedFetch = vi.hoisted(() => vi.fn());

vi.mock('./literatureMapApi', () => api);
vi.mock('../utils/api', () => ({ authenticatedFetch }));

describe('LiteratureMaintenancePanel', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    api.loadProjectLiteratureMapMaintenanceAudits.mockReset().mockResolvedValue({ path: 'audit.json', audits: [] });
    api.runProjectLiteratureMapMaintenance.mockReset().mockResolvedValue({
      maintenanceId: 'm1',
      trigger: 'natural_language',
      candidateReview: { reviewRequired: true, newCandidatePaperIds: ['W1'], pendingCandidatePaperIds: ['W1'], updatedExistingPaperIds: [], zoteroWritePerformed: false, snapshotCreated: false, destructiveMapChangePerformed: false },
      safety: { zoteroWritePerformed: false, snapshotCreated: false, destructiveMapChangePerformed: false, pendingReviewRequired: true },
      sources: [{ sourceId: 'search:m1', state: 'succeeded', coverage: 'ok', paperCount: 1, edgeCount: 0 }],
      map: null,
      diff: null,
      audit: { path: 'audit.json', persisted: true },
    });
    authenticatedFetch.mockReset();
  });

  it('runs an explicit natural-language maintenance pass and keeps Zotero writes disabled', async () => {
    render(<LiteratureMaintenancePanel projectPath="D:/project" mapId="map-1" />);
    fireEvent.change(screen.getByLabelText(/Natural-language maintenance query/i), { target: { value: 'new agent papers' } });
    fireEvent.click(screen.getByRole('button', { name: /Run natural-language maintenance/i }));
    await waitFor(() => expect(api.runProjectLiteratureMapMaintenance).toHaveBeenCalledWith(
      'D:/project',
      'map-1',
      'natural_language',
      expect.objectContaining({ query: 'new agent papers', intent: 'new agent papers' }),
    ));
    expect(await screen.findByText(/1 pending/i)).toBeTruthy();
    expect(screen.getByText(/Candidates only/i)).toBeTruthy();
  });

  it('offers an explicit Zotero-read action without rendering a write action', async () => {
    render(<LiteratureMaintenancePanel projectPath="D:/project" mapId="map-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Read Zotero changes/i }));
    await waitFor(() => expect(api.runProjectLiteratureMapMaintenance).toHaveBeenCalledWith(
      'D:/project',
      'map-1',
      'zotero_changed',
      {},
    ));
    expect(screen.queryByText(/Write to Zotero/i)).toBeNull();
  });

  it('exposes existing bridge and diff routes from the map operations strip', async () => {
    authenticatedFetch.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => String(url).includes('/bridges?')
        ? { bridges: [{ paperId: 'W1' }], graph: { activePaperCount: 4, activeRelationCount: 3 } }
        : {
            lastDiff: {
              fromRevision: 2,
              toRevision: 3,
              nodes: { added: ['W1'], updated: [], tombstoned: [], restored: [] },
              edges: { added: [], updated: [], tombstoned: [], restored: [] },
              warnings: [],
            },
          },
    }));
    render(<LiteratureMaintenancePanel projectPath="D:/project" mapId="map-1" />);

    fireEvent.click(screen.getByRole('button', { name: /Analyze bridge papers \/ 分析桥接文献/i }));
    fireEvent.click(screen.getByRole('button', { name: /Analyze \/ 分析/i }));
    expect(await screen.findByText(/1 bridge papers \/ 桥接文献/i)).toBeTruthy();
    expect(authenticatedFetch.mock.calls[0]?.[0]).toContain('/api/research/literature-map/bridges?');

    fireEvent.click(screen.getByRole('button', { name: /Analyze bridge papers \/ 分析桥接文献/i }));
    fireEvent.click(screen.getByRole('button', { name: /Inspect last map diff \/ 查看上次图谱差异/i }));
    fireEvent.click(screen.getByRole('button', { name: /Load diff \/ 加载差异/i }));
    expect(await screen.findByText(/r2.*r3.*1 changes \/ 项变化/i)).toBeTruthy();
  });

  it('requires an explicit snapshot confirmation and sends candidate lifecycle changes to the existing map route', async () => {
    authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => String(url).endsWith('/snapshots')
        ? { snapshot: { snapshotId: JSON.parse(String(init?.body)).snapshotId } }
        : {
            diff: {
              fromRevision: 3,
              toRevision: 4,
              nodes: { added: [], updated: [], tombstoned: ['W1'], restored: [] },
              edges: { added: [], updated: [], tombstoned: [], restored: [] },
              warnings: [],
            },
          },
    }));
    render(<LiteratureMaintenancePanel projectPath="D:/project" mapId="map-1" />);

    fireEvent.click(screen.getByRole('button', { name: /Create reviewed map snapshot \/ 创建已审阅图谱快照/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /Reviewed snapshot ID \/ 已审阅快照 ID/i }), { target: { value: 'reviewed-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm snapshot \/ 确认快照/i }));
    expect(await screen.findByText(/Created reviewed-1 \/ 已创建 reviewed-1/i)).toBeTruthy();
    const snapshotRequest = JSON.parse(String(authenticatedFetch.mock.calls[0]?.[1]?.body));
    expect(snapshotRequest).toMatchObject({ projectPath: 'D:/project', snapshotId: 'reviewed-1', confirmed: true });

    fireEvent.click(screen.getByRole('button', { name: /Create reviewed map snapshot \/ 创建已审阅图谱快照/i }));
    fireEvent.click(screen.getByRole('button', { name: /Tombstone or restore a paper \/ 标记移除或恢复文献/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /Literature map paper ID \/ 文献图谱文献 ID/i }), { target: { value: 'W1' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply \/ 应用/i }));
    expect(await screen.findByText(/Tombstoned W1 \/ 已标记移除 W1/i)).toBeTruthy();
    const tombstoneRequest = JSON.parse(String(authenticatedFetch.mock.calls[1]?.[1]?.body));
    expect(tombstoneRequest).toMatchObject({
      projectPath: 'D:/project',
      mapId: 'map-1',
      update: { origin: 'monitor', tombstonePaperIds: ['W1'] },
    });
  });
});
