import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useAuth, isValidPassword, type AuthError } from '../context/AuthContext';
import { Brand } from '../components/Brand';
import { ContactAtcoLink } from '../components/ContactCard';

/**
 * Production password-recovery callback (`/auth/reset-callback`).
 *
 * Supabase verifies the emailed link and the SDK establishes a recovery session
 * (PASSWORD_RECOVERY). Only then is the new-password form shown; the password is
 * set with the existing `updatePassword` service call inside that session. An
 * expired/invalid/missing link never shows the form and never claims success.
 */
function PasswordInput({ id, label, value, onChange, hint, invalid }: {
  id: string; label: string; value: string; onChange: (v: string) => void; hint?: string; invalid?: boolean;
}) {
  const { t } = useLanguage();
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="pw-wrap">
        <input id={id} type={show ? 'text' : 'password'} autoComplete="new-password" value={value} aria-invalid={invalid || undefined}
          onChange={e => onChange(e.target.value)} />
        <button type="button" className="pw-toggle" onClick={() => setShow(s => !s)} aria-controls={id} aria-pressed={show}>
          {show ? t('hidePw') : t('showPw')}
        </button>
      </div>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export default function PasswordRecoveryView() {
  const { t, lang, setLang } = useLanguage();
  const { authMode, authUnavailable, sessionLoading, user, recovery, recoveryLinkError, completePasswordRecovery } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ next: '', confirm: '' });
  const [error, setError] = useState<AuthError | ''>('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const requestNewLink = () => navigate('/signin', { replace: true, state: { mode: 'reset' } });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return; // a second click while saving is ignored
    if (!isValidPassword(form.next)) { setError('errPasswordRules'); return; }
    if (form.next !== form.confirm) { setError('errPasswordMatch'); return; }
    inFlight.current = true;
    setBusy(true);
    const err = await completePasswordRecovery(form.next, form.confirm);
    inFlight.current = false;
    setBusy(false);
    setError(err ?? '');
    if (!err) setForm({ next: '', confirm: '' });
  };

  let body: ReactNode;
  if (authMode === 'demo') {
    body = (
      <>
        <div className="notice warn" role="status">{t('recoveryDemoBody')}</div>
        <Link className="btn btn-outline" style={{ marginTop: 16 }} to="/signin">{t('backToSignIn')}</Link>
      </>
    );
  } else if (authUnavailable) {
    body = <div className="notice danger" role="alert">{t('authConfigErrorBody')}</div>;
  } else if (recovery === 'completed') {
    body = (
      <>
        <div className="notice" role="status"><strong>{t('recoveryDoneTitle')}</strong>{t('recoveryDoneBody')}</div>
        <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 16 }} onClick={() => navigate('/onboarding', { replace: true })}>
          {t('recoveryContinue')}
        </button>
      </>
    );
  } else if (recovery === 'ready') {
    body = (
      <form className="grid" onSubmit={submit} noValidate>
        {error && <div className="notice danger" role="alert">{t(error)}</div>}
        <PasswordInput id="recovery-new" label={t('newPassword')} value={form.next} hint={t('passwordHint')}
          invalid={error === 'errPasswordRules'} onChange={v => setForm(f => ({ ...f, next: v }))} />
        <PasswordInput id="recovery-confirm" label={t('confirmPassword')} value={form.confirm}
          invalid={error === 'errPasswordMatch'} onChange={v => setForm(f => ({ ...f, confirm: v }))} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy} aria-busy={busy}>{t('recoverySubmit')}</button>
      </form>
    );
  } else if (sessionLoading || recovery === 'verifying') {
    body = <div className="notice blue" role="status">{t('recoveryVerifying')}</div>;
  } else if (recovery === 'invalid') {
    body = (
      <>
        <div className="notice danger" role="alert">
          <strong>{recoveryLinkError === 'otp_expired' ? t('recoveryExpiredTitle') : t('recoveryInvalidTitle')}</strong>
          {t('recoveryInvalidBody')}
        </div>
        <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 16 }} onClick={requestNewLink}>{t('recoveryRequestNew')}</button>
      </>
    );
  } else if (user) {
    body = (
      <>
        <div className="notice blue" role="status">{t('recoverySignedInBody')}</div>
        <Link className="btn btn-outline" style={{ marginTop: 16 }} to="/settings?tab=security">{t('openSecuritySettings')}</Link>
      </>
    );
  } else {
    body = (
      <>
        <div className="notice warn" role="alert">{t('recoveryMissingBody')}</div>
        <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 16 }} onClick={requestNewLink}>{t('recoveryRequestNew')}</button>
      </>
    );
  }

  return (
    <div className="auth-page">
      <div className="demo-banner"><span className="dot" /><span>{authMode === 'demo' ? t('demoBanner') : t('prodBanner')}</span></div>
      <div className="auth-top">
        <Brand />
        <div className="lang-toggle">
          <button type="button" className={lang === 'en' ? 'active' : ''} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
          <button type="button" className={lang === 'ar' ? 'active' : ''} aria-pressed={lang === 'ar'} onClick={() => setLang('ar')} lang="ar">العربية</button>
        </div>
      </div>
      <main className="auth-main">
        <div className="card card-pad auth-card">
          <h1 className="page-title" style={{ fontSize: 28 }}>{t('recoveryTitle')}</h1>
          <p className="page-sub" style={{ marginBottom: 18 }}>{t('recoverySub')}</p>
          {body}
        </div>
        <div className="auth-contact"><ContactAtcoLink /></div>
      </main>
    </div>
  );
}
