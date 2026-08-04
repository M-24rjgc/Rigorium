// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Settings from './Settings';

const mocks = vi.hoisted(() => ({
  desktopVersion: {
    info: {
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      latestTagName: 'v0.2.0',
      hasUpdate: true,
      checkUnavailable: false,
      desktop: true,
    },
    checking: false,
    download: {
      state: 'downloaded',
      progress: 1,
      receivedBytes: 1024,
      totalBytes: 1024,
      filePath: 'C:/Temp/Rigorium-Setup.exe',
      error: null,
      verified: true,
      sha256: 'a'.repeat(64),
    } as {
      state: string;
      progress: number;
      receivedBytes: number;
      totalBytes: number;
      filePath: string;
      error: string | null;
      verified: boolean;
      sha256: string | null;
    },
    fetchStatus: vi.fn(),
    triggerDownload: vi.fn(),
    triggerInstall: vi.fn(),
    cancelDownload: vi.fn(),
  },
  scrollIntoView: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { version?: string; percent?: number }) => {
      if (values?.version) return `${key}:${values.version}`;
      if (values?.percent !== undefined) return `${key}:${values.percent}`;
      return key;
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ themeMode: 'system', setThemeMode: vi.fn() }),
}));

vi.mock('../../../hooks/useUiPreferences', () => ({
  useUiPreferences: () => ({ preferences: {}, setPreference: vi.fn() }),
}));

vi.mock('../../../hooks/useRigoriumConfig', () => ({
  useRigoriumConfig: () => ({ raw: '{}', setRaw: vi.fn(), save: vi.fn(), loading: false }),
}));

vi.mock('../hooks/useSettingsController', () => ({
  useSettingsController: () => ({
    saveStatus: null,
    projectSortOrder: 'name',
    setProjectSortOrder: vi.fn(),
    codeEditorSettings: { theme: 'light', wordWrap: false, showMinimap: true, lineNumbers: true, fontSize: '14' },
    updateCodeEditorSetting: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useDesktopVersion', () => ({
  useDesktopVersion: () => mocks.desktopVersion,
}));

vi.mock('./tabs/RigoriumConfigTab', () => ({ default: () => null }));
vi.mock('./tabs/McpServersTab', () => ({ default: () => null }));
vi.mock('./tabs/PermissionsSettingsTab', () => ({ default: () => null }));
vi.mock('./tabs/GatewaySettingsTab', () => ({ default: () => null }));
vi.mock('./tabs/ResearchSettingsTab', () => ({ default: () => null }));

const renderSettings = (initialTab = 'appearance') => render(
  <Settings isOpen onClose={vi.fn()} projects={[]} initialTab={initialTab} />,
);

describe('desktop update settings entry point', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'rigoriumDesktop', { configurable: true, value: {} });
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: mocks.scrollIntoView,
    });
    mocks.scrollIntoView.mockReset();
    mocks.desktopVersion.download = {
      state: 'downloaded',
      progress: 1,
      receivedBytes: 1024,
      totalBytes: 1024,
      filePath: 'C:/Temp/Rigorium-Setup.exe',
      error: null,
      verified: true,
      sha256: 'a'.repeat(64),
    };
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'rigoriumDesktop');
  });

  it('scrolls directly to the desktop update section and shows a verified installer', async () => {
    renderSettings('appearance:updates');

    expect(screen.getByTestId('desktop-version-update-section')).toBeTruthy();
    await waitFor(() => expect(mocks.scrollIntoView).toHaveBeenCalledWith({ block: 'start' }));
    expect(screen.getByTestId('desktop-update-verification').textContent).toContain('about.installerVerified');
    expect((screen.getByRole('button', { name: 'about.installUpdate' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('holds installation until the downloaded installer is verified', () => {
    mocks.desktopVersion.download = {
      state: 'downloaded',
      progress: 1,
      receivedBytes: 1024,
      totalBytes: 1024,
      filePath: 'C:/Temp/Rigorium-Setup.exe',
      error: null,
      verified: false,
      sha256: null,
    };
    renderSettings();

    expect(screen.getByTestId('desktop-update-verification').textContent).toContain('about.installerVerificationPending');
    expect((screen.getByRole('button', { name: 'about.installUpdate' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.scrollIntoView).not.toHaveBeenCalled();
  });
});
