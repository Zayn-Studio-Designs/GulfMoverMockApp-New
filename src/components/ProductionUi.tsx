import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useOnboarding, usePlatformRoles } from '../context/OnboardingContext';
import { DataServiceError, type DataErrorKind } from '../lib/dataService';
import { saudiDateTimeParts } from '../domain/dates';
import { formatTime } from '../domain/fleet';

/** Page header for production pages: no "demo data" badge, an honest "live data" one instead. */
export function ProdPageHeader({ titleKey, subKey }: { titleKey: string; subKey?: string }) {
  const { t } = useLanguage();
  return (
    <div className="page-header">
      <div>
        <div className="eyebrow">{t('onbEyebrow')}</div>
        <h1 className="page-title">{t(titleKey)}</h1>
        {subKey && <p className="page-sub">{t(subKey)}</p>}
      </div>
      <div className="header-actions"><span className="pill pill-neutral">{t('onbLiveBadge')}</span></div>
    </div>
  );
}

/** A departure instant shown as Saudi-local date and time (the operating timezone). */
export function SailingTime({ iso }: { iso: string }) {
  const { lang } = useLanguage();
  if (!iso || Number.isNaN(Date.parse(iso))) return <span>—</span>;
  const { date, time } = saudiDateTimeParts(iso);
  return <span><strong className="mono">{date}</strong> · <span className="mono">{formatTime(time, lang)}</span></span>;
}

const ERROR_KEYS: Record<DataErrorKind, string> = {
  unavailable: 'dsErrUnavailable',
  'not-authenticated': 'errSessionRequired',
  forbidden: 'dsErrForbidden',
  'account-suspended': 'onbSuspendedBody',
  'conflict-of-interest': 'admErrConflict',
  'reviewer-profile-missing': 'admErrProfileMissing',
  'organization-not-approved': 'pbErrNotApproved',
  'not-a-member': 'pbErrNotMember',
  'invalid-input': 'dsErrInvalid',
  'invalid-transition': 'dsErrTransition',
  'not-found': 'dsErrNotFound',
  'payload-mismatch': 'pbErrMismatch',
  'sailing-full': 'pbErrFull',
  'sailing-unavailable': 'pbErrUnavailable',
  duplicate: 'dsErrDuplicate',
  'not-deployed': 'dsErrNotDeployed',
  network: 'dsErrNetwork',
  server: 'dsErrNetwork',
  'unexpected-response': 'dsErrNetwork',
  unknown: 'dsErrNetwork',
  'payment-in-progress': 'p8ErrPaymentInProgress',
  'hold-expired': 'p8ErrHoldExpired',
  'change-window-closed': 'p8ErrChangeWindow',
  'credit-unavailable': 'p8ErrCreditUnavailable',
  'credit-limit': 'p8ErrCreditLimit',
  'four-eyes': 'p8ErrFourEyes',
  'policy-not-approved': 'p8ErrPolicyNotApproved',
  'terms-not-accepted': 'p8ErrTerms',
  'payments-disabled': 'p8ErrPaymentsDisabled',
  'safety-review-required': 'p8ErrSafetyReview',
  'vessel-conflict': 'p8ErrVesselConflict',
  'payload-exceeded': 'p8ErrPayload',
  'no-tariff': 'p8ErrNoTariff',
};

/** Translation key for any thrown service error (never the raw database text). */
export function dataErrorKey(error: unknown): string {
  return ERROR_KEYS[error instanceof DataServiceError ? error.kind : 'unknown'];
}

/**
 * UI guard for ATCO-only screens. It shows a screen only when the server-read platform roles
 * (role_assignments under RLS) include one of `roles`. It is a convenience, not the security
 * boundary: every query and RPC behind these screens is re-checked by the database.
 */
export function RequireRoles({ roles, children }: { roles: readonly string[]; children: ReactNode }) {
  const { t } = useLanguage();
  const { authMode } = useAuth();
  const { status } = useOnboarding();
  const held = usePlatformRoles();
  if (authMode === 'demo') return <NotConnectedView />;
  if (status.phase === 'loading' || status.phase === 'signed-out') return <div className="card card-pad" role="status">{t('onbLoading')}</div>;
  if (status.phase === 'error') return <div className="notice danger" role="alert">{t('onbLoadError')}</div>;
  if (!held || !held.some(r => roles.includes(r))) {
    return (
      <section className="card card-pad" aria-labelledby="no-access">
        <h1 id="no-access" className="page-title">{t('dsNoAccessTitle')}</h1>
        <div className="notice danger" role="alert" style={{ marginTop: 12 }}>{t('dsNoAccessBody')}</div>
      </section>
    );
  }
  return <>{children}</>;
}

/** Production stand-in for modules that still run only on demo data. */
export function NotConnectedView() {
  const { t } = useLanguage();
  return (
    <>
      <ProdPageHeader titleKey="ncTitle" />
      <section className="card card-pad">
        <div className="notice warn" role="status">{t('ncBody')}</div>
        <div className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
          <Link className="btn btn-outline" to="/book">{t('navBook')}</Link>
          <Link className="btn btn-outline" to="/bookings">{t('navBookings')}</Link>
          <Link className="btn btn-outline" to="/onboarding">{t('navCompany')}</Link>
        </div>
      </section>
    </>
  );
}
