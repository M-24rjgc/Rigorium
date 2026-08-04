import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../i18n/config';
import FeatureTour, {
  FEATURE_TOUR_SEEN_KEY,
  FEATURE_TOUR_STEPS,
  hasSeenFeatureTour,
  markFeatureTourSeen,
  startFeatureTour,
} from './FeatureTour';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderTour(onFinish = vi.fn()) {
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <FeatureTour onFinish={onFinish} />
    </I18nextProvider>,
  );
  return { ...utils, onFinish };
}

describe('feature tour gating', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reports unseen by default and seen after marking', () => {
    expect(hasSeenFeatureTour()).toBe(false);
    markFeatureTourSeen();
    expect(hasSeenFeatureTour()).toBe(true);
    expect(localStorage.getItem(FEATURE_TOUR_SEEN_KEY)).toBe('1');
  });

  it('startFeatureTour clears the seen marker and dispatches the request event', () => {
    markFeatureTourSeen();
    const listener = vi.fn();
    window.addEventListener('rigorium:feature-tour-request', listener);
    startFeatureTour();
    expect(hasSeenFeatureTour()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('rigorium:feature-tour-request', listener);
  });
});

describe('feature tour walkthrough', () => {
  beforeEach(() => {
    localStorage.clear();
    window.openSettings = vi.fn();
  });

  it('starts on the welcome step and walks through every step', () => {
    renderTour();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('🧭')).toBeTruthy();

    for (let index = 1; index < FEATURE_TOUR_STEPS.length; index += 1) {
      act(() => {
        fireEvent.click(screen.getByText('Next'));
      });
      const step = FEATURE_TOUR_STEPS[index]!;
      expect(screen.getByText(step.emoji)).toBeTruthy();
    }
    // Last step button reads "Start using" and finishes the tour.
    act(() => {
      fireEvent.click(screen.getByText('Start using'));
    });
  });

  it('back returns to the previous step and skip on the first step finishes', () => {
    const { onFinish } = renderTour();
    act(() => {
      fireEvent.click(screen.getByText('Next'));
    });
    expect(screen.getByText('💬')).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByText('Back'));
    });
    expect(screen.getByText('🧭')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByText('Skip'));
    });
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(hasSeenFeatureTour()).toBe(true);
  });

  it('finishing marks the tour as seen and calls onFinish', () => {
    const { onFinish } = renderTour();
    act(() => {
      fireEvent.click(screen.getByText('Skip'));
    });
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(hasSeenFeatureTour()).toBe(true);
  });

  it('moves focus into the dialog card on open (aria-modal semantics)', () => {
    renderTour();
    const card = document.querySelector('[tabindex="-1"]');
    expect(card).not.toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it('Escape finishes the tour', () => {
    const { onFinish } = renderTour();
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(hasSeenFeatureTour()).toBe(true);
  });

  it('settings steps open the settings panel via the global bridge', () => {
    renderTour();
    const settingsStepIndex = FEATURE_TOUR_STEPS.findIndex((step) => step.action === 'openSettings:config');
    for (let index = 1; index <= settingsStepIndex; index += 1) {
      act(() => {
        fireEvent.click(screen.getByText('Next'));
      });
    }
    expect(window.openSettings).toHaveBeenCalledWith('config');
  });
});
