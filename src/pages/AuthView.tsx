import { useState, useRef, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useAuth, type DemoProvider } from '../context/AuthContext';
import { useUi } from '../context/UiContext';
import { Brand } from '../components/Brand';
import { ContactAtcoLink } from '../components/ContactCard';
import { ProviderButton, ProviderSimOverlay } from '../components/ProviderAuth';

type Mode = 'signin' | 'signup' | 'reset';

function PasswordField({ id, label, value, onChange, autoComplete, hint }: {
  id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string; hint?: string;
}) {
  const { t } = useLanguage();
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="pw-wrap">
        <input id={id} type={show ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={e => onChange(e.target.value)} />
        <button type="button" className="pw-toggle" onClick={() => setShow(s => !s)} aria-controls={id} aria-pressed={show}>
          {show ? t('hidePw') : t('showPw')}
        </button>
      </div>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export default function AuthView({ initialMode = 'signin' }: { initialMode?: Mode }) {
  const { t, lang, setLang } = useLanguage();
  const { user, signIn, signUp, signInAsGuest, signInWithProvider, requestResetCode, requestResetEmail, resetPassword, authMode, sessionLoading, confirmationPending, authUnavailable } = useAuth();
  const { toast } = useUi();
  const navigate = useNavigate();
  const location = useLocation();
  // The recovery page's "request a new reset link" opens this view directly in reset mode.
  const requestedMode = (location.state as { mode?: Mode } | null)?.mode;
  const [mode, setMode] = useState<Mode>(requestedMode === 'reset' ? 'reset' : initialMode);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ login: '', email: '', username: '', company: '', password: '', confirm: '', code: '' });
  const [remember, setRemember] = useState(true);
  // Reset step 2 starts once a (demo) code has been issued; the code is shown on screen instead of emailed.
  // Production reset is single-step: the emailed link does the reset, so only a "sent" acknowledgement shows.
  const [sentCode, setSentCode] = useState('');
  const [resetEmailSent, setResetEmailSent] = useState(false);
  const isDemo = authMode === 'demo';
  const isProduction = authMode === 'production';
  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }));
  // Production users land on their company-onboarding status; the demo keeps its home page.
  const from = (location.state as { from?: string } | null)?.from ?? (isProduction ? '/onboarding' : '/');

  const switchMode = (m: Mode) => { setMode(m); setError(''); setSentCode(''); setResetEmailSent(false); setForm(f => ({ ...f, password: '', confirm: '', code: '' })); };

  const sendCode = () => {
    const res = requestResetCode(form.email);
    if ('error' in res) { setError(res.error); return; }
    setError('');
    setSentCode(res.code);
    toast(t('codeSent'));
  };

  /** Production: request the emailed reset link (explicit configured redirect; fails clearly if unset). */
  const sendEmail = async () => {
    setBusy(true);
    const err = await requestResetEmail(form.email);
    setBusy(false);
    if (err) { setError(err); return; }
    setError('');
    setResetEmailSent(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'reset' && !sentCode && !(isProduction && resetEmailSent)) {
      // Demo shows the code on screen; production sends the emailed link.
      if (isProduction) { await sendEmail(); return; }
      sendCode();
      return;
    }
    setBusy(true);
    const err = mode === 'signin' ? await signIn(form.login, form.password, remember)
      : mode === 'signup' ? await signUp({ email: form.email, username: form.username, company: form.company, password: form.password, confirm: form.confirm })
        : await resetPassword(form.email, form.code, form.password, form.confirm);
    setBusy(false);
    if (err) { setError(err); return; }
    if (mode === 'reset') { toast(t('pwResetDone')); switchMode('signin'); return; }
    if (isProduction && mode === 'signup') {
      // With e-mail confirmation on there is no session yet: show the sign-in form with the
      // "check your email" notice. If Supabase did return a session, the `if (user)` <Navigate>
      // guard in the render takes over.
      const email = form.email;
      switchMode('signin');
      setForm(f => ({ ...f, login: email }));
      return;
    }
    navigate(from, { replace: true });
  };

  const guest = async () => { await signInAsGuest(); navigate(from, { replace: true }); };

  /* Simulated provider sign-in (frontend-only): a short in-app animation, then the same demo
     session mechanism the guest flow uses. No provider page, popup or credentials involved. */
  const [providerFlow, setProviderFlow] = useState<DemoProvider | null>(null);
  const reducedMotion = useRef(
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ).current;
  const providerBusy = busy || providerFlow !== null;
  const completeProvider = async (provider: DemoProvider) => {
    await signInWithProvider(provider);
    setProviderFlow(null);
    navigate(from, { replace: true });
  };

  if (user) return <Navigate to={from} replace />;

  /* Production configuration problem: fail loudly, never fall back to the demo. */
  if (isProduction && authUnavailable) {
    return (
      <div className="auth-page">
        <div className="auth-top"><Brand /></div>
        <main className="auth-main">
          <div className="card card-pad auth-card">
            <h1 className="page-title" style={{ fontSize: 28 }}>{t('authConfigErrorTitle')}</h1>
            <div className="notice danger" role="alert" style={{ marginBottom: 16 }}>{t('authConfigErrorBody')}</div>
            <div className="inset small" role="list">
              <strong>{t('authConfigIssueLabel')}</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {authUnavailable.issues.map(issue => <li key={issue} role="listitem"><code dir="ltr">{issue}</code></li>)}
              </ul>
            </div>
            <button type="button" className="btn btn-outline" style={{ marginTop: 16 }} onClick={() => window.location.reload()}>{t('screenErrorRetry')}</button>
          </div>
        </main>
      </div>
    );
  }

  /* Production: never redirect while a persisted session is still being restored. */
  if (isProduction && sessionLoading) {
    return (
      <div className="auth-page">
        <div className="auth-top"><Brand /></div>
        <main className="auth-main">
          <div className="card card-pad auth-card" role="status">{t('authLoading')}</div>
        </main>
      </div>
    );
  }

  const title = mode === 'signin' ? t('signInTitle') : mode === 'signup' ? t('signUpTitle') : t('resetTitle');

  return (
    <div className="auth-page">
      <div className="demo-banner"><span className="dot" /><span>{isDemo ? t('demoBanner') : t('prodBanner')}</span></div>
      <div className="auth-top">
        <Brand />
        <div className="lang-toggle">
          <button type="button" className={lang === 'en' ? 'active' : ''} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
          <button type="button" className={lang === 'ar' ? 'active' : ''} aria-pressed={lang === 'ar'} onClick={() => setLang('ar')} lang="ar">العربية</button>
        </div>
      </div>
      <main className="auth-main">
        <div className="card card-pad auth-card">
          <h1 className="page-title" style={{ fontSize: 28 }}>{title}</h1>
          <p className="page-sub" style={{ marginBottom: 18 }}>{mode === 'reset' ? (isProduction ? t('resetProdSub') : t('resetSub')) : t('authSub')}</p>
          <div className="notice warn" style={{ marginBottom: 18 }}>{isDemo ? t('authDemoNote') : t('prodAuthNote')}</div>
          {error && <div className="notice danger" role="alert" style={{ marginBottom: 16 }}>{t(error)}</div>}
          {isProduction && confirmationPending && (
            <div className="notice blue" role="status" style={{ marginBottom: 16 }}>
              <strong>{t('confirmPendingTitle')}</strong>
              {t('confirmPendingBody').replace('{email}', confirmationPending)}
            </div>
          )}
          <form className="grid" onSubmit={submit} noValidate>
            {mode === 'signin' && (
              <div className="field">
                {/* Production (Supabase) accepts an e-mail address only; the demo also accepts a username. */}
                <label htmlFor="auth-login">{isProduction ? t('emailLabel') : t('emailOrUsername')}</label>
                <input id="auth-login" type={isProduction ? 'email' : 'text'} dir={isProduction ? 'ltr' : undefined}
                  autoComplete={isProduction ? 'email' : 'username'} value={form.login} onChange={e => set('login')(e.target.value)} />
              </div>
            )}
            {mode !== 'signin' && (
              <div className="field">
                <label htmlFor="auth-email">{t('emailLabel')}</label>
                <input id="auth-email" type="email" autoComplete="email" value={form.email} readOnly={mode === 'reset' && !!sentCode} onChange={e => set('email')(e.target.value)} />
              </div>
            )}
            {isDemo && mode === 'reset' && sentCode && (
              <>
                <div className="notice blue" role="status">
                  <strong>{t('demoCodeTitle')}</strong>
                  {t('demoCodeBody')} <span className="mono code-chip">{sentCode}</span>
                </div>
                <div className="field">
                  <label htmlFor="auth-code">{t('resetCode')}</label>
                  <input id="auth-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={form.code} onChange={e => set('code')(e.target.value.replace(/\D/g, ''))} />
                  <small><button type="button" className="link-btn" style={{ padding: 0 }} onClick={sendCode}>{t('resendCode')}</button></small>
                </div>
              </>
            )}
            {isProduction && mode === 'reset' && resetEmailSent && (
              <div className="notice blue" role="status">
                <strong>{t('resetEmailSentTitle')}</strong>
                {t('resetEmailSentBody')}
              </div>
            )}
            {mode === 'signup' && isDemo && (
              <>
                <div className="field">
                  <label htmlFor="auth-username">{t('username')}</label>
                  <input id="auth-username" autoComplete="username" value={form.username} onChange={e => set('username')(e.target.value)} />
                  <small>{t('usernameHint')}</small>
                </div>
                <div className="field">
                  <label htmlFor="auth-company">{t('companyName')}</label>
                  <input id="auth-company" autoComplete="organization" value={form.company} onChange={e => set('company')(e.target.value)} />
                </div>
              </>
            )}
            {/* Production sign-up creates the login only; the company is registered (and reviewed by
                ATCO) after sign-in, so no company field is collected and silently dropped here. */}
            {mode === 'signup' && isProduction && (
              <div className="field">
                <label htmlFor="auth-username">{t('displayNameLabel')}</label>
                <input id="auth-username" autoComplete="name" value={form.username} onChange={e => set('username')(e.target.value)} />
                <small>{t('displayNameHint')}</small>
              </div>
            )}
            {(mode !== 'reset' || (isDemo && sentCode)) && (
              <PasswordField id="auth-password" label={mode === 'reset' ? t('newPassword') : t('password')} value={form.password} onChange={set('password')}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} hint={mode === 'signin' ? undefined : t('passwordHint')} />
            )}
            {(mode === 'signup' || (isDemo && mode === 'reset' && !!sentCode)) && (
              <PasswordField id="auth-confirm" label={t('confirmPassword')} value={form.confirm} onChange={set('confirm')} autoComplete="new-password" />
            )}
            {mode === 'signin' && (
              <div className="between auth-row">
                <label className="checkrow"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />{t('keepSignedIn')}</label>
                <button type="button" className="link-btn auth-link" onClick={() => switchMode('reset')}>{t('forgot')}</button>
              </div>
            )}
            {mode === 'signup' && <p className="small muted" style={{ margin: 0 }}>{t('termsNote')}</p>}
            {!(isProduction && mode === 'reset' && resetEmailSent) && (
              <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                {mode === 'signin' ? t('signInBtn') : mode === 'signup' ? t('signUpBtn') : sentCode ? t('resetBtn') : t('sendCode')}
              </button>
            )}
          </form>
          <div className="auth-switch">
            {mode === 'signin' && <>{t('noAccount')} <button type="button" className="link-btn" onClick={() => switchMode('signup')}>{t('signUpTitle')}</button></>}
            {mode === 'signup' && <>{t('haveAccount')} <button type="button" className="link-btn" onClick={() => switchMode('signin')}>{t('signInBtn')}</button></>}
            {mode === 'reset' && <button type="button" className="link-btn" onClick={() => switchMode('signin')}>{t('backToSignIn')}</button>}
          </div>
          {isDemo && mode !== 'reset' && (
            <>
              <div className="auth-or"><span>{t('orDivider')}</span></div>
              {/* Simulated provider options — frontend demo only, labelled as such on the overlay. */}
              <div className="provider-row">
                <ProviderButton provider="google" mode={mode} disabled={providerBusy} onClick={() => setProviderFlow('google')} />
                <ProviderButton provider="apple" mode={mode} disabled={providerBusy} onClick={() => setProviderFlow('apple')} />
              </div>
              <button type="button" className="btn btn-outline btn-block" onClick={guest} disabled={providerBusy}>{t('guest')}</button>
              {providerFlow && (
                <ProviderSimOverlay provider={providerFlow} mode={mode} reducedMotion={reducedMotion}
                  onComplete={completeProvider} onCancel={() => setProviderFlow(null)} />
              )}
            </>
          )}
        </div>
        <div className="auth-contact"><ContactAtcoLink /></div>
      </main>
    </div>
  );
}
