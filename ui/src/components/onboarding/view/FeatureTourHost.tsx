import { useEffect, useState } from 'react';
import FeatureTour, { hasSeenFeatureTour } from './FeatureTour';

/**
 * FeatureTourHost — renders the full-product guided tour on top of the main
 * shell. Mounts with the shell (i.e. after onboarding completed) and shows
 * the tour unless it was already seen; a `rigorium:feature-tour-request`
 * event (e.g. from a settings "watch the tour again" entry) re-opens it.
 */
export default function FeatureTourHost() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!hasSeenFeatureTour()) {
      setShow(true);
    }
    const onRequest = () => {
      if (!hasSeenFeatureTour()) {
        setShow(true);
      }
    };
    window.addEventListener('rigorium:feature-tour-request', onRequest);
    return () => window.removeEventListener('rigorium:feature-tour-request', onRequest);
  }, []);

  if (!show) return null;
  return <FeatureTour onFinish={() => setShow(false)} />;
}
