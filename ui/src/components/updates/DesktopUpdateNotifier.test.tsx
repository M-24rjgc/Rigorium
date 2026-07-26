import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DesktopUpdateNotifier from './DesktopUpdateNotifier';

const mocks = vi.hoisted(() => ({
  info: null as null | Record<string, unknown>,
}));

vi.mock('../../hooks/useDesktopVersion', () => ({
  useDesktopVersion: () => ({ info: mocks.info }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { version?: string }) => values?.version ? `${key}:${values.version}` : key,
  }),
}));

describe('DesktopUpdateNotifier', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    sessionStorage.clear();
    mocks.info = null;
    delete window.openSettings;
  });

  it('stays hidden outside the desktop app or without an update', () => {
    mocks.info = { desktop: false, hasUpdate: true, checkUnavailable: false, latestVersion: '0.2.0' };
    const { rerender } = render(<DesktopUpdateNotifier />);
    expect(screen.queryByTestId('desktop-update-notifier')).toBeNull();
    mocks.info = { desktop: true, hasUpdate: false, checkUnavailable: false, latestVersion: '0.2.0' };
    rerender(<DesktopUpdateNotifier />);
    expect(screen.queryByTestId('desktop-update-notifier')).toBeNull();
    mocks.info = { desktop: true, hasUpdate: true, checkUnavailable: true, latestVersion: '0.2.0' };
    rerender(<DesktopUpdateNotifier />);
    expect(screen.queryByTestId('desktop-update-notifier')).toBeNull();
  });

  it('announces an update and opens the desktop update section in settings', () => {
    const openSettings = vi.fn();
    window.openSettings = openSettings;
    mocks.info = { desktop: true, hasUpdate: true, checkUnavailable: false, latestVersion: '0.2.0' };
    render(<DesktopUpdateNotifier />);
    expect(screen.getByRole('status', { name: 'about.backgroundUpdateAvailable:0.2.0' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'about.reviewUpdate' }));
    expect(openSettings).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledWith('appearance:updates');
  });

  it('dismisses only the currently announced version for the session', () => {
    mocks.info = { desktop: true, hasUpdate: true, checkUnavailable: false, latestVersion: '0.2.0' };
    const { rerender } = render(<DesktopUpdateNotifier />);
    fireEvent.click(screen.getByRole('button', { name: 'about.dismissUpdate' }));
    expect(screen.queryByTestId('desktop-update-notifier')).toBeNull();
    expect(sessionStorage.getItem(DISMISSED_KEY_FOR_TEST)).toBe('0.2.0');

    mocks.info = { desktop: true, hasUpdate: true, checkUnavailable: false, latestVersion: '0.3.0' };
    rerender(<DesktopUpdateNotifier />);
    expect(screen.getByTestId('desktop-update-notifier')).toBeTruthy();
  });
});

const DISMISSED_KEY_FOR_TEST = 'rigorium.desktopUpdate.dismissedVersion';
