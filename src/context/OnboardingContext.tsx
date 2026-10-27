import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import {
  CompanyServiceError, deriveOnboardingState, fetchOnboardingSnapshot,
  type CompanyServiceErrorKind, type OnboardingState,
} from '../lib/companyService';

/**
 * Company-onboarding status for the signed-in production user, read through RLS by
 * `fetchOnboardingSnapshot`. Demo mode never contacts Supabase: its status is 'demo'.
 * Signed-out users (including sign-ups still awaiting e-mail confirmation) get 'signed-out'
 * and nothing protected is requested.
 */
export type OnboardingStatus =
  | { readonly phase: 'demo' }
  | { readonly phase: 'signed-out' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly error: CompanyServiceErrorKind }
  | { readonly phase: 'ready'; readonly state: OnboardingState };

interface OnboardingContextValue {
  status: OnboardingStatus;
  /** Re-reads the status (after a registration, or to check on a pending review). */
  refresh: () => Promise<OnboardingStatus>;
}

const OnboardingContext = createContext<OnboardingContextValue | undefined>(undefined);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { authMode, user } = useAuth();
  const userId = user?.id ?? null;
  const [status, setStatus] = useState<OnboardingStatus>(() =>
    authMode === 'demo' ? { phase: 'demo' } : userId ? { phase: 'loading' } : { phase: 'signed-out' });
  // Only the newest request may publish its result (a slow response for a previous user or an
  // earlier refresh must never overwrite a newer one).
  const requestSeq = useRef(0);
  // Whose status is on screen: a refresh keeps it visible, a different user starts from 'loading'.
  const shownFor = useRef<string | null>(null);

  const load = useCallback(async (): Promise<OnboardingStatus> => {
    const seq = ++requestSeq.current;
    if (authMode === 'demo') { const next: OnboardingStatus = { phase: 'demo' }; setStatus(next); return next; }
    if (!userId) { const next: OnboardingStatus = { phase: 'signed-out' }; setStatus(next); return next; }
    const sameUser = shownFor.current === userId;
    setStatus(s => (sameUser && s.phase === 'ready' ? s : { phase: 'loading' }));
    let next: OnboardingStatus;
    try {
      next = { phase: 'ready', state: deriveOnboardingState(await fetchOnboardingSnapshot()) };
    } catch (error) {
      next = { phase: 'error', error: error instanceof CompanyServiceError ? error.kind : 'unknown' };
    }
    if (seq === requestSeq.current) { shownFor.current = userId; setStatus(next); }
    return next;
  }, [authMode, userId]);

  useEffect(() => {
    void load();
    return () => { requestSeq.current += 1; }; // user changed or unmounted: drop in-flight results
  }, [load]);

  const value = useMemo(() => ({ status, refresh: load }), [status, load]);
  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error('useOnboarding must be used within an OnboardingProvider');
  return ctx;
}
