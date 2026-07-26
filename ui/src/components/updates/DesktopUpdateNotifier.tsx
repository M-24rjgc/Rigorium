import { Download, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDesktopVersion } from '../../hooks/useDesktopVersion';

const DISMISSED_KEY = 'rigorium.desktopUpdate.dismissedVersion';

export default function DesktopUpdateNotifier() {
  const { t } = useTranslation('settings');
  const { info } = useDesktopVersion();
  const version = info?.latestVersion || info?.latestTagName || '';
  const [dismissedVersion, setDismissedVersion] = useState(() => sessionStorage.getItem(DISMISSED_KEY) || '');

  useEffect(() => {
    if (!version || dismissedVersion !== version) return;
    sessionStorage.setItem(DISMISSED_KEY, version);
  }, [dismissedVersion, version]);

  const visible = Boolean(info?.desktop && info.hasUpdate && !info.checkUnavailable && version && dismissedVersion !== version);
  const label = useMemo(
    () => t('about.backgroundUpdateAvailable', { version }),
    [t, version],
  );

  if (!visible) return null;

  return (
    <aside
      className="fixed bottom-4 left-4 z-[9998] flex w-[min(420px,calc(100vw-2rem))] items-center gap-3 rounded-lg border border-border bg-background px-4 py-3 shadow-xl"
      aria-label={label}
      role="status"
      data-testid="desktop-update-notifier"
    >
      <Download className="h-4 w-4 shrink-0 text-blue-500" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{t('about.verifiedInstallerHint')}</div>
      </div>
      <button
        type="button"
        onClick={() => window.openSettings?.('appearance:updates')}
        className="shrink-0 text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
      >
        {t('about.reviewUpdate')}
      </button>
      <button
        type="button"
        onClick={() => {
          sessionStorage.setItem(DISMISSED_KEY, version);
          setDismissedVersion(version);
        }}
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={t('about.dismissUpdate')}
      >
        <X className="h-4 w-4" />
      </button>
    </aside>
  );
}
