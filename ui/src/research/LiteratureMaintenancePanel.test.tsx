import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiteratureMaintenancePanel from './LiteratureMaintenancePanel';

const api = vi.hoisted(() => ({
  loadProjectLiteratureMapMaintenanceAudits: vi.fn(),
  runProjectLiteratureMapMaintenance: vi.fn(),
}));

vi.mock('./literatureMapApi', () => api);

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
});
