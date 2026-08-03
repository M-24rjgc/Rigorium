import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronLeft, ChevronRight, SkipForward, Sparkles } from 'lucide-react';

/**
 * FeatureTour — the full-product guided walkthrough shown right after the
 * onboarding model-configuration step. It steps through every major surface:
 * chat input, sidebar navigation, research panel, workspace (files/git/shell),
 * settings (model pool, research-aware routing, vision, figure generation),
 * global tool tabs (memory / always-on / tasks / dashboard), and the
 * self-bootstrapping research loop.
 *
 * Each step may target a DOM anchor (`[data-tour-id="…"]`) for a spotlight
 * highlight. Anchors are optional: when an anchor is missing (e.g. a surface
 * that requires a project) the step renders the explanation card only — the
 * tour never breaks. Steps may open the settings panel via the global
 * `window.openSettings(tab)` bridge that AppShellV2 installs.
 */

export const FEATURE_TOUR_SEEN_KEY = 'rigorium.feature-tour-seen';

export type FeatureTourStep = {
  id: string;
  emoji: string;
  titleKey: string;
  bodyKey: string;
  /** `[data-tour-id="…"]` anchor for the spotlight. Optional. */
  target?: string;
  /** Side effect to run when the step becomes active. */
  action?: 'openSettings:config' | 'openSettings:router' | 'openSettings:vision';
};

export const FEATURE_TOUR_STEPS: readonly FeatureTourStep[] = [
  { id: 'welcome', emoji: '🧭', titleKey: 'steps.welcome.title', bodyKey: 'steps.welcome.body' },
  {
    id: 'chat',
    emoji: '💬',
    titleKey: 'steps.chat.title',
    bodyKey: 'steps.chat.body',
    target: 'tour-chat-input',
  },
  {
    id: 'sidebar',
    emoji: '🧱',
    titleKey: 'steps.sidebar.title',
    bodyKey: 'steps.sidebar.body',
    target: 'tour-sidebar',
  },
  {
    id: 'research',
    emoji: '🔬',
    titleKey: 'steps.research.title',
    bodyKey: 'steps.research.body',
    target: 'tour-research',
  },
  {
    id: 'workspace',
    emoji: '📁',
    titleKey: 'steps.workspace.title',
    bodyKey: 'steps.workspace.body',
    target: 'tour-workspace',
  },
  {
    id: 'settings',
    emoji: '⚙️',
    titleKey: 'steps.settings.title',
    bodyKey: 'steps.settings.body',
    target: 'tour-settings',
    action: 'openSettings:config',
  },
  {
    id: 'router',
    emoji: '🚦',
    titleKey: 'steps.router.title',
    bodyKey: 'steps.router.body',
    target: 'tour-settings-router',
    action: 'openSettings:router',
  },
  {
    id: 'vision',
    emoji: '👁️',
    titleKey: 'steps.vision.title',
    bodyKey: 'steps.vision.body',
    target: 'tour-settings-vision',
    action: 'openSettings:vision',
  },
  {
    id: 'global-tools',
    emoji: '🧠',
    titleKey: 'steps.globalTools.title',
    bodyKey: 'steps.globalTools.body',
    target: 'tour-sidebar',
  },
  {
    id: 'bootstrap',
    emoji: '🚀',
    titleKey: 'steps.bootstrap.title',
    bodyKey: 'steps.bootstrap.body',
  },
];

type SpotlightRect = { top: number; left: number; width: number; height: number } | null;

export function hasSeenFeatureTour(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(FEATURE_TOUR_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markFeatureTourSeen(): void {
  try {
    localStorage.setItem(FEATURE_TOUR_SEEN_KEY, '1');
  } catch {
    // localStorage unavailable — the tour simply re-shows next launch.
  }
}

export function startFeatureTour(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(FEATURE_TOUR_SEEN_KEY);
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent('rigorium:feature-tour-request'));
}

type FeatureTourProps = {
  onFinish: () => void;
};

export default function FeatureTour({ onFinish }: FeatureTourProps) {
  const { t } = useTranslation('featureTour');
  const [stepIndex, setStepIndex] = useState(0);
  const [spotlight, setSpotlight] = useState<SpotlightRect>(null);
  const [anchorFound, setAnchorFound] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const step = FEATURE_TOUR_STEPS[stepIndex]!;
  const isLast = stepIndex === FEATURE_TOUR_STEPS.length - 1;

  // Run the step side effect (e.g. open settings) and (re)measure the anchor
  // after the DOM settles.
  useEffect(() => {
    if (step.action) {
      const open = (window as Window & { openSettings?: (tab?: string) => void }).openSettings;
      if (step.action === 'openSettings:config') open?.('config');
      if (step.action === 'openSettings:router') open?.('config:router');
      if (step.action === 'openSettings:vision') open?.('config:vision');
    }
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      if (!step.target) {
        setSpotlight(null);
        setAnchorFound(false);
        return;
      }
      const el = document.querySelector<HTMLElement>(`[data-tour-id="${step.target}"]`);
      if (el) {
        const rect = el.getBoundingClientRect();
        setSpotlight({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
        setAnchorFound(true);
      } else {
        setSpotlight(null);
        setAnchorFound(false);
      }
    };
    measure();
    const timer = window.setTimeout(measure, 350); // wait for settings panel mount
    window.addEventListener('resize', measure);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener('resize', measure);
    };
  }, [stepIndex, step.action, step.target]);

  const finish = () => {
    markFeatureTourSeen();
    onFinish();
  };

  const goNext = () => {
    if (isLast) {
      finish();
      return;
    }
    setStepIndex((index) => Math.min(index + 1, FEATURE_TOUR_STEPS.length - 1));
  };

  const progress = ((stepIndex + 1) / FEATURE_TOUR_STEPS.length) * 100;

  const cardStyle: React.CSSProperties = useMemo(() => {
    if (!spotlight) {
      return { bottom: 24, left: '50%', transform: 'translateX(-50%)', width: 'min(560px, calc(100vw - 32px))' };
    }
    // Place the card below the spotlight when there is room, otherwise above.
    const below = spotlight.top + spotlight.height + 16;
    const cardHeight = 190;
    if (below + cardHeight < window.innerHeight - 16) {
      return { top: below, left: spotlight.left, width: Math.max(320, Math.min(560, spotlight.width)) };
    }
    return { top: Math.max(16, spotlight.top - cardHeight - 16), left: spotlight.left, width: Math.max(320, Math.min(560, spotlight.width)) };
  }, [spotlight]);

  return (
    <div
      className="fixed inset-0 z-[10000]"
      role="dialog"
      aria-modal="true"
      aria-label={t('ariaLabel')}
    >
      {/* Dimmed backdrop with a hole punched around the highlighted element. */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] transition-opacity duration-300"
        style={{
          clipPath: spotlight
            ? `polygon(
                0 0, 100% 0, 100% 100%, 0 100%,
                0 ${spotlight.top}px, ${spotlight.left}px ${spotlight.top}px,
                ${spotlight.left}px ${spotlight.top + spotlight.height}px,
                ${spotlight.left + spotlight.width}px ${spotlight.top + spotlight.height}px,
                ${spotlight.left + spotlight.width}px ${spotlight.top}px,
                0 ${spotlight.top}px
              )`
            : undefined,
        }}
      />

      {/* Pulsing ring around the anchor. */}
      {spotlight && (
        <div
          className="pointer-events-none absolute rounded-md border-2 border-indigo-400"
          style={{
            top: spotlight.top - 4,
            left: spotlight.left - 4,
            width: spotlight.width + 8,
            height: spotlight.height + 8,
            animation: 'rigorium-tour-pulse 1.6s ease-in-out infinite',
          }}
        />
      )}

      {/* Explanation card. */}
      <div
        ref={cardRef}
        className="absolute z-10 rounded-2xl border border-white/15 bg-neutral-900 p-5 text-neutral-50 shadow-2xl dark:bg-neutral-950 dark:text-neutral-100"
        style={{ ...cardStyle, animation: 'rigorium-tour-card-in 0.35s ease-out' }}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-500/20 text-xl">
            {step.emoji}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold leading-6">{t(step.titleKey)}</h2>
            <p className="mt-1 text-[13px] leading-5 text-neutral-300 dark:text-neutral-400">
              {t(step.bodyKey)}
            </p>
          </div>
        </div>

        {!anchorFound && step.target && (
          <p className="mt-2 text-[11px] italic text-neutral-500">
            {t('anchorMissingHint')}
          </p>
        )}

        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {FEATURE_TOUR_STEPS.map((item, index) => (
              <button
                key={item.id}
                type="button"
                aria-label={t('stepIndicator', { index: index + 1 })}
                onClick={() => setStepIndex(index)}
                className="h-1.5 rounded-full transition-all"
                style={{
                  width: index === stepIndex ? 20 : 8,
                  backgroundColor: index === stepIndex ? '#818cf8' : 'rgba(255,255,255,0.25)',
                }}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => (stepIndex === 0 ? finish() : setStepIndex((i) => i - 1))}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-white/10"
            >
              {stepIndex === 0 ? (
                <>
                  <SkipForward className="h-3.5 w-3.5" />
                  {t('skip')}
                </>
              ) : (
                <>
                  <ChevronLeft className="h-3.5 w-3.5" />
                  {t('back')}
                </>
              )}
            </button>
            <button
              type="button"
              onClick={goNext}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg shadow-indigo-500/30 transition-colors hover:bg-indigo-400"
            >
              {isLast ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  {t('done')}
                </>
              ) : (
                <>
                  {t('next')}
                  <ChevronRight className="h-3.5 w-3.5" />
                </>
              )}
            </button>
          </div>
        </div>

        <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-indigo-400 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="mt-2 flex items-center justify-center gap-1 text-[10px] text-neutral-500">
          <Sparkles className="h-3 w-3" />
          {t('poweredBy')}
        </div>
      </div>
    </div>
  );
}
