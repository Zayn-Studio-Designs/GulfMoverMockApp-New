import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useOnboarding } from '../context/OnboardingContext';
import { ContactAtcoLink } from '../components/ContactCard';
import { Pill } from '../components/StatusPill';
import {
  CompanyServiceError, REGISTRATION_LIMITS, clearRegistrationKey, loadRegistrationKey, newRegistrationKey,
  registerCompany, saveRegistrationKey, validateRegistrationInput,
  type CompanyRegistrationInput, type CompanyRegistrationResult, type OrganizationSummary,
  type RegistrationField, type RegistrationFieldError, type RegistrationLanguage,
} from '../lib/companyService';

/**
 * Company onboarding (`/onboarding`).
 *
 * Production: shows the signed-in user's real onboarding state (read through RLS) and,
 * only when they have no company yet, the registration form backed by the existing
 * `register_company` RPC. Nothing here approves a company or writes protected tables.
 * Demo: explains that registration is a production feature; no network calls are made.
 */

type FieldErrors = Partial<Record<RegistrationField, RegistrationFieldError | 'server'>>;

const ERROR_TEXT: Record<CompanyServiceError['kind'], string> = {
  unavailable: 'onbErrUnavailable',
  'not-authenticated': 'onbErrNotAuth',
  'account-suspended': 'onbErrSuspended',
  'invalid-input': 'onbErrInvalidGeneric',
  'payload-mismatch': 'onbErrMismatch',
  'key-conflict': 'onbErrKeyConflict',
  'retryable-conflict': 'onbErrRetryable',
  'not-deployed': 'onbErrNotDeployed',
  network: 'onbErrUncertain',
  server: 'onbErrUncertain',
  'unexpected-response': 'onbErrUncertain',
  unknown: 'onbErrUncertain',
};

function TextField({ id, field, label, hint, value, onChange, error, maxLength, type = 'text', dir, inputMode, autoComplete }: {
  id: string; field: RegistrationField; label: string; hint?: string; value: string; onChange: (field: RegistrationField, v: string) => void;
  error?: string; maxLength?: number; type?: string; dir?: 'ltr'; inputMode?: 'email' | 'tel'; autoComplete?: string;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={field} type={type} value={value} dir={dir} inputMode={inputMode} autoComplete={autoComplete}
        maxLength={maxLength} aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        onChange={e => onChange(field, e.target.value)} />
      {hint && <small id={hintId}>{hint}</small>}
      {error && <span className="error" id={errorId} role="alert">{error}</span>}
    </div>
  );
}

const ORG_STATUS_KEY: Record<OrganizationSummary['status'], string> = {
  pending: 'onbStatusPending', approved: 'onbStatusApproved', rejected: 'onbStatusRejected', suspended: 'onbStatusSuspended',
};

function OrganizationList({ organizations }: { organizations: readonly OrganizationSummary[] }) {
  const { t } = useLanguage();
  return (
    <div style={{ marginTop: 14 }}>
      {organizations.map(org => (
        <div key={org.id} className="request-row">
          <div>
            <div className="request-title">{org.name}</div>
            <div className="request-meta">{t(org.membershipRole === 'company_admin' ? 'onbRoleAdmin' : 'onbRoleBooker')}</div>
          </div>
          <Pill tone={org.status === 'approved' ? 'pill-green' : org.status === 'pending' ? 'pill-gold' : 'pill-red'}>
            {t(ORG_STATUS_KEY[org.status])}
          </Pill>
        </div>
      ))}
    </div>
  );
}

function StateCard({ title, children, tone = '' }: { title: string; children: ReactNode; tone?: string }) {
  return (
    <section className="card card-pad" aria-labelledby="onb-state-title">
      <h2 id="onb-state-title" className="card-title">{title}</h2>
      <div className={`notice ${tone}`} style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}

function RegistrationForm({ userId, defaultName, onRegistered }: {
  userId: string; defaultName: string; onRegistered: (result: CompanyRegistrationResult) => Promise<void>;
}) {
  const { t, lang } = useLanguage();
  const { refresh } = useOnboarding();
  const [form, setForm] = useState<CompanyRegistrationInput>(() => ({
    legalName: '', displayName: '', registrationNumber: '', billingContact: '', contactEmail: '', contactPhone: '',
    profileDisplayName: defaultName, language: lang,
  }));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [failure, setFailure] = useState<CompanyServiceError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // One idempotency key per registration attempt, kept until the server confirms success.
  const attemptKey = useRef<string | null>(loadRegistrationKey(userId));
  // Synchronous guard: a double click fires two submit events before React re-renders.
  const inFlight = useRef(false);

  const update = (field: RegistrationField, value: string) => {
    setForm(f => ({ ...f, [field]: value }));
    setFieldErrors(({ [field]: _cleared, ...rest }) => rest);
  };

  const fieldError = (field: RegistrationField): string | undefined => {
    const err = fieldErrors[field];
    if (!err) return undefined;
    if (err === 'required') return t('errFieldRequired');
    if (err === 'too-long') return t('errFieldTooLong').replace('{n}', String(REGISTRATION_LIMITS[field as keyof typeof REGISTRATION_LIMITS]));
    if (err === 'invalid-email') return t('errEmail');
    if (err === 'invalid-phone') return t('errPhone');
    if (err === 'invalid-language') return t('errFieldLanguage');
    return t('errFieldServer');
  };

  const startNewAttempt = () => {
    clearRegistrationKey(userId);
    attemptKey.current = null;
    setFailure(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    const errors = validateRegistrationInput(form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setFormError('onbFixErrors');
      return;
    }
    setFormError('');
    inFlight.current = true;
    setSubmitting(true);
    const key = attemptKey.current ?? newRegistrationKey();
    attemptKey.current = key;
    saveRegistrationKey(userId, key);
    try {
      const result = await registerCompany(form, key);
      clearRegistrationKey(userId);
      attemptKey.current = null;
      setFailure(null);
      await onRegistered(result);
    } catch (error) {
      const err = error instanceof CompanyServiceError ? error : new CompanyServiceError('unknown');
      if (err.kind === 'key-conflict') startNewAttempt();
      if (err.kind === 'invalid-input' && err.field) setFieldErrors({ [err.field]: 'server' });
      setFailure(err);
      // These outcomes mean the server state may differ from what this form assumes: re-read it.
      if (err.kind === 'payload-mismatch' || err.kind === 'account-suspended') await refresh();
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const failureText = failure
    ? (failure.kind === 'invalid-input' && failure.field ? t('onbErrInvalid') : t(ERROR_TEXT[failure.kind]))
    : '';

  return (
    <section className="card card-pad" aria-labelledby="onb-form-title">
      <h2 id="onb-form-title" className="card-title">{t('onbFormTitle')}</h2>
      <p className="card-desc">{t('onbFormSub')}</p>
      <form className="grid" onSubmit={submit} noValidate style={{ marginTop: 16 }} aria-busy={submitting}>
        {formError && <div className="notice danger" role="alert">{t(formError)}</div>}
        {failure && (
          <div className={`notice ${failure.uncertain ? 'warn' : 'danger'}`} role="alert">
            {failure.uncertain && <strong>{t('onbErrUncertainTitle')}</strong>}
            {failureText}
            {failure.kind === 'payload-mismatch' && (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-outline btn-small" onClick={startNewAttempt}>{t('onbStartNew')}</button>
              </div>
            )}
          </div>
        )}
        <fieldset disabled={submitting} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} className="grid">
          <div className="form-grid">
            <TextField id="onb-legal-name" field="legalName" label={t('onbLegalName')} value={form.legalName} onChange={update}
              error={fieldError('legalName')} maxLength={REGISTRATION_LIMITS.legalName} autoComplete="organization" />
            <TextField id="onb-display-name" field="displayName" label={t('onbDisplayName')} value={form.displayName} onChange={update}
              error={fieldError('displayName')} maxLength={REGISTRATION_LIMITS.displayName} />
            <TextField id="onb-reg-number" field="registrationNumber" label={t('onbRegNumber')} value={form.registrationNumber} onChange={update}
              error={fieldError('registrationNumber')} maxLength={REGISTRATION_LIMITS.registrationNumber} dir="ltr" />
            <TextField id="onb-billing" field="billingContact" label={t('onbBilling')} hint={t('onbBillingHint')} value={form.billingContact}
              onChange={update} error={fieldError('billingContact')} maxLength={REGISTRATION_LIMITS.billingContact} />
            <TextField id="onb-contact-email" field="contactEmail" label={t('onbContactEmail')} value={form.contactEmail} onChange={update}
              error={fieldError('contactEmail')} type="email" dir="ltr" inputMode="email" autoComplete="email" />
            <TextField id="onb-contact-phone" field="contactPhone" label={t('onbContactPhone')} value={form.contactPhone} onChange={update}
              error={fieldError('contactPhone')} type="tel" dir="ltr" inputMode="tel" autoComplete="tel" maxLength={20} />
            <TextField id="onb-your-name" field="profileDisplayName" label={t('onbYourName')} hint={t('onbYourNameHint')}
              value={form.profileDisplayName} onChange={update} error={fieldError('profileDisplayName')}
              maxLength={REGISTRATION_LIMITS.profileDisplayName} autoComplete="name" />
            <div className="field">
              <label htmlFor="onb-language">{t('onbLanguage')}</label>
              <select id="onb-language" value={form.language} onChange={e => update('language', e.target.value as RegistrationLanguage)}>
                <option value="en">English</option>
                <option value="ar">العربية</option>
              </select>
            </div>
          </div>
        </fieldset>
        <div>
          <button type="submit" className="btn btn-primary" disabled={submitting} aria-busy={submitting}>
            {submitting ? t('onbSubmitting') : failure?.uncertain ? t('onbRetrySubmit') : t('onbSubmit')}
          </button>
        </div>
      </form>
    </section>
  );
}

export default function OnboardingView() {
  const { t } = useLanguage();
  const { authMode, user } = useAuth();
  const { status, refresh } = useOnboarding();
  const [result, setResult] = useState<CompanyRegistrationResult | null>(null);
  const [checking, setChecking] = useState(false);
  const isDemo = authMode === 'demo';

  const check = async () => { setChecking(true); await refresh(); setChecking(false); };
  const onRegistered = async (registered: CompanyRegistrationResult) => {
    setResult(registered);
    await refresh();
  };

  const header = (
    <div className="page-header">
      <div>
        <div className="eyebrow">{t('onbEyebrow')}</div>
        <h1 className="page-title">{t('onbTitle')}</h1>
        <p className="page-sub">{t('onbSub')}</p>
      </div>
      <div className="header-actions"><span className="pill pill-neutral">{isDemo ? t('demoOnly') : t('onbLiveBadge')}</span></div>
    </div>
  );

  if (isDemo) {
    return (
      <>
        {header}
        <StateCard title={t('onbDemoTitle')} tone="warn">
          {t('onbDemoBody')}
          <div style={{ marginTop: 10 }}><Link className="btn btn-outline btn-small" to="/settings?tab=company">{t('onbDemoLink')}</Link></div>
        </StateCard>
      </>
    );
  }
  if (!user) return null; // the layout redirects signed-out visitors to sign in

  const checkAgain = (
    <div style={{ marginTop: 14 }}>
      <button type="button" className="btn btn-outline btn-small" onClick={check} disabled={checking}>{t('onbCheckStatus')}</button>
    </div>
  );

  let content: ReactNode;
  if (status.phase === 'loading' || status.phase === 'signed-out' || status.phase === 'demo') {
    content = <div className="card card-pad" role="status">{t('onbLoading')}</div>;
  } else if (status.phase === 'error') {
    content = (
      <section className="card card-pad">
        <div className="notice danger" role="alert">
          {status.error === 'not-authenticated' ? t('errSessionRequired')
            : status.error === 'not-deployed' ? t('onbErrNotDeployed') : t('onbLoadError')}
        </div>
        <div style={{ marginTop: 14 }}><button type="button" className="btn btn-outline" onClick={check} disabled={checking}>{t('screenErrorRetry')}</button></div>
      </section>
    );
  } else {
    const state = status.state;
    switch (state.kind) {
      case 'no-company':
        content = result ? null : (
          <RegistrationForm key={user.id} userId={user.id} defaultName={user.fullName} onRegistered={onRegistered} />
        );
        break;
      case 'pending':
        content = (
          <StateCard title={t('onbPendingTitle')} tone="warn">
            {t('onbPendingBody')}
            <OrganizationList organizations={state.organizations} />
            {checkAgain}
          </StateCard>
        );
        break;
      case 'approved':
        content = (
          <StateCard title={t('onbApprovedTitle')}>
            {t('onbApprovedBody')}
            <OrganizationList organizations={state.organizations} />
            <div style={{ marginTop: 14 }}><Link className="btn btn-primary btn-small" to="/book">{t('pbBookCta')}</Link></div>
          </StateCard>
        );
        break;
      case 'invited':
        content = <StateCard title={t('onbInvitedTitle')} tone="blue">{t('onbInvitedBody')}<div style={{ marginTop: 10 }}><ContactAtcoLink /></div></StateCard>;
        break;
      case 'rejected':
        content = (
          <StateCard title={t('onbRejectedTitle')} tone="danger">
            {t('onbRejectedBody')}
            <OrganizationList organizations={state.organizations} />
            <div style={{ marginTop: 10 }}><ContactAtcoLink /></div>
          </StateCard>
        );
        break;
      case 'suspended':
        content = (
          <StateCard title={t('onbSuspendedCoTitle')} tone="danger">
            {t('onbSuspendedCoBody')}
            <OrganizationList organizations={state.organizations} />
            <div style={{ marginTop: 10 }}><ContactAtcoLink /></div>
          </StateCard>
        );
        break;
      case 'restricted':
        content = <StateCard title={t('onbRestrictedTitle')} tone="danger">{t('onbRestrictedBody')}<div style={{ marginTop: 10 }}><ContactAtcoLink /></div></StateCard>;
        break;
      case 'account-suspended':
        content = <StateCard title={t('onbSuspendedTitle')} tone="danger">{t('onbSuspendedBody')}<div style={{ marginTop: 10 }}><ContactAtcoLink /></div></StateCard>;
        break;
      case 'platform-staff':
        content = <StateCard title={t('onbStaffTitle')} tone="blue">{t('onbStaffBody')}</StateCard>;
        break;
    }
  }

  return (
    <>
      {header}
      <div className="grid">
        {result && (
          <div className="notice" role="status">
            <strong>{t('onbSuccessTitle')}</strong>
            {t(result.outcome === 'created' ? 'onbSuccessCreated' : 'onbSuccessReplayed').replace('{name}', result.legalName)}
          </div>
        )}
        {content}
      </div>
    </>
  );
}
