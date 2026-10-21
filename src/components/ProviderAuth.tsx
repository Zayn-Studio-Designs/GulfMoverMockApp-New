import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import type { DemoProvider } from '../context/AuthContext';

/**
 * FRONTEND-ONLY SIMULATION of "Continue with Google/Apple" for the demo.
 * No real OAuth is performed, no provider page is opened, nothing is requested or verified:
 * clicking a provider button starts a short in-app animation and then signs the user into an
 * existing-style demo session. Every step is labelled as a demo (see overlay copy).
 *
 * Brand marks: the recognisable Google "G" and Apple logo, drawn faithfully as inline SVG —
 * never distorted, never used to fake a provider website. Colours follow each provider's
 * published guidance and adapt to the app's Light/Dark/Surface theme via CSS.
 */

type Mode = 'signin' | 'signup';

export function GoogleMark({ size = 18 }: { size?: number }) {
  // Official four-colour "G" geometry (approximate brand-proportional paths, epsilon-safe).
  return (
    <svg viewBox="0 0 18 18" width={size} height={size} aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.63-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26a5.4 5.4 0 0 1-8.04-2.85H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M4 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3.03-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.96L4 7.29c.78-2.2 2.87-3.71 5-3.71z" />
    </svg>
  );
}

export function AppleMark({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 14 17" width={size} height={size * 17 / 14} aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M11.62 9.03c.02 2.05 1.79 2.73 1.82 2.74-.02.05-.29.98-.95 1.94-.57.84-1.17 1.67-2.11 1.69-.92.02-1.22-.55-2.27-.55-1.05 0-1.38.53-2.25.57-.9.03-1.59-.9-2.17-1.74C2.53 11.98 1.65 8.9 2.87 6.81c.6-1.04 1.68-1.7 2.86-1.72.89-.02 1.73.6 2.27.6.54 0 1.56-.74 2.63-.63.45.02 1.71.18 2.52 1.37-.07.04-1.52.89-1.5 2.6h.01zM9.4 4.83c.48-.58.8-1.39.71-2.19-.69.03-1.53.46-2.02 1.04-.44.51-.83 1.34-.73 2.13.77.06 1.56-.4 2.04-.98z" />
    </svg>
  );
}

/** Provider button native to the ATCO card design: correct marks, theme-aware colours. */
export function ProviderButton({ provider, mode, onClick, disabled }: {
  provider: DemoProvider; mode: Mode; onClick: () => void; disabled?: boolean;
}) {
  const { t } = useLanguage();
  const label = mode === 'signin' ? 'providerSignIn' : 'providerSignUp';
  const apple = provider === 'apple';
  return (
    <button type="button" className={`provider-btn provider-${provider}`} disabled={disabled} onClick={onClick}
      aria-label={t(`${label}${apple ? 'Apple' : 'Google'}`)}>
      {apple ? <AppleMark /> : <GoogleMark />}
      <span>{t(`${label}${apple ? 'Apple' : 'Google'}`)}</span>
    </button>
  );
}

/* ---------------- Animated simulation overlay ---------------- */

interface OverlayProps {
  provider: DemoProvider;
  mode: Mode;
  reducedMotion: boolean;
  /** Parent starts the demo session on the success beat. */
  onComplete: (provider: DemoProvider) => Promise<void>;
  onCancel: () => void;
}

/** Deterministic beats (kept public so tests and timing reviews can replay them). */
export const PROVIDER_TIMELINE = {
  connect: 850,   // brief "connecting" state
  success: 900,   // checkmark + demo note, then hand over
} as const;

export function ProviderSimOverlay({ provider, mode, reducedMotion, onComplete, onCancel }: OverlayProps) {
  const { t } = useLanguage();
  const [phase, setPhase] = useState<'connecting' | 'success'>('connecting');
  const cancelled = useRef(false);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;
  const apple = provider === 'apple';

  useEffect(() => {
    const unit = reducedMotion ? 0.45 : 1; // still animated via CSS, only faster: reduced motion is honoured without demanding it
    const t1 = window.setTimeout(() => !cancelled.current && setPhase('success'), PROVIDER_TIMELINE.connect * unit);
    const t2 = window.setTimeout(() => {
      if (!cancelled.current) void completeRef.current(provider);
    }, (PROVIDER_TIMELINE.connect + PROVIDER_TIMELINE.success) * unit);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
  }, [provider, reducedMotion]);

  const cancel = () => { cancelled.current = true; onCancel(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const connectingLabel = t(apple ? 'providerConnectingApple' : 'providerConnectingGoogle');
  const successLabel = mode === 'signin'
    ? t(apple ? 'providerSuccessApple' : 'providerSuccessGoogle')
    : t(apple ? 'providerCreatedApple' : 'providerCreatedGoogle');

  return (
    <div className="provider-overlay" role="dialog" aria-modal="true" aria-labelledby="provider-overlay-title">
      <div className={`provider-card${phase === 'success' ? ' is-success' : ''}`} data-provider={provider}>
        <div className="provider-logo" aria-hidden="true">
          {apple ? <AppleMark size={22} /> : <GoogleMark size={22} />}
        </div>
        {phase === 'connecting' && (
          <>
            <div className="provider-progress" aria-hidden="true" data-testid="provider-connecting">
              <span className="provider-progress-track"><span className="provider-progress-fill" /></span>
            </div>
            <h2 id="provider-overlay-title" className="provider-title">{connectingLabel}</h2>
            <p className="provider-note">{t('providerDemoNote')}</p>
            <button type="button" className="link-btn" onClick={cancel}>{t('cancel')}</button>
          </>
        )}
        {phase === 'success' && (
          <>
            <svg className="provider-check" viewBox="0 0 40 40" width="44" height="44" aria-hidden="true" focusable="false">
              <circle className="provider-check-ring" cx="20" cy="20" r="17" fill="none" strokeWidth="2.5" />
              <path className="provider-check-mark" d="M12.5 20.5l5 5 10-11" fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <h2 id="provider-overlay-title" className="provider-title">{successLabel}</h2>
            <p className="provider-note" data-testid="provider-demo-note">{t('providerDemoNote')}</p>
            <div className="provider-spin tiny" aria-live="polite" data-testid="provider-continue">{t('providerContinuing')}</div>
          </>
        )}
      </div>
    </div>
  );
}
