import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useTheme, type ThemePref } from '../context/ThemeContext';
import { useAuth, type NotificationPrefs } from '../context/AuthContext';
import { useUi } from '../context/UiContext';
import { PageHeader } from '../components/PageHeader';
import { Avatar } from '../components/Avatar';
import { CompanyLogo, ImageUpload } from '../components/ImageUpload';
import { ContactCard } from '../components/ContactCard';

export const SETTINGS_TABS = ['profile', 'company', 'security', 'notifications', 'preferences', 'account', 'atco'] as const;
type Tab = typeof SETTINGS_TABS[number];

const TAB_LABEL: Record<Tab, string> = {
  profile: 'profile', company: 'companyTitle', security: 'securityTab', notifications: 'notificationsTitle',
  preferences: 'preferencesTitle', account: 'accountTitle', atco: 'atcoInfoTab',
};

/** ATCO company information and contact details, moved here from the bottom of the pages. */
function AtcoInfoTab() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  const back = from ?? (user ? null : '/signin');
  return (
    <section className="grid" aria-labelledby="atco-info-title" style={{ gap: 14 }}>
      <div className="card card-pad atco-info-head">
        <div>
          <h2 id="atco-info-title" className="card-title">{t('atcoInfoTab')}</h2>
          <p className="card-desc">{t('atcoInfoSub')}</p>
        </div>
        {back && <button type="button" className="btn btn-outline btn-small" onClick={() => navigate(back)}><span className="dir-flip" aria-hidden="true">←</span> {t('back')}</button>}
      </div>
      <ContactCard />
    </section>
  );
}

function PasswordInput({ id, label, value, onChange, autoComplete, hint }: {
  id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string; hint?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="password" autoComplete={autoComplete} value={value} onChange={e => onChange(e.target.value)} />
      {hint && <small>{hint}</small>}
    </div>
  );
}

function ProfileTab() {
  const { t } = useLanguage();
  const { user, updateProfile } = useAuth();
  const { toast } = useUi();
  const [form, setForm] = useState({ fullName: '', username: '', phone: '' });
  const [error, setError] = useState('');
  useEffect(() => { if (user) setForm({ fullName: user.fullName, username: user.username, phone: user.phone }); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!user) return null;

  const save = (e: FormEvent) => {
    e.preventDefault();
    const err = updateProfile(form);
    setError(err ?? '');
    if (!err) toast(t('saved'));
  };
  const setImage = (avatar: string) => { updateProfile({ avatar }); toast(t('saved')); };

  return (
    <section className="card card-pad" aria-labelledby="set-profile">
      <h2 id="set-profile" className="card-title">{t('profile')}</h2>
      <p className="card-desc">{t('profileSub')}</p>
      <ImageUpload label={t('profilePicture')} preview={<Avatar user={user} size={72} />} hasImage={!!user.avatar} size={160} crop onChange={setImage} />
      <form className="grid" onSubmit={save} noValidate style={{ marginTop: 18 }}>
        {error && <div className="notice danger" role="alert">{t(error)}</div>}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="set-fullname">{t('fullName')}</label>
            <input id="set-fullname" autoComplete="name" value={form.fullName} onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))} />
          </div>
          <div className="field">
            <label htmlFor="set-username">{t('username')}</label>
            <input id="set-username" autoComplete="username" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
            <small>{t('usernameHint')}</small>
          </div>
          <div className="field">
            <label htmlFor="set-phone">{t('phoneOptional')}</label>
            <input id="set-phone" type="tel" autoComplete="tel" dir="ltr" placeholder="+966 5X XXX XXXX" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            <small>{t('phoneHint')}</small>
          </div>
        </div>
        <div className="between">
          <span className="small muted">{t('memberSince')}: <span className="mono">{user.createdAt.slice(0, 10)}</span></span>
          <button type="submit" className="btn btn-primary">{t('saveChanges')}</button>
        </div>
      </form>
    </section>
  );
}

function CompanyTab() {
  const { t } = useLanguage();
  const { user, updateProfile } = useAuth();
  const { toast } = useUi();
  const [form, setForm] = useState({ company: '', companyAddress: '', companyWebsite: '' });
  const [error, setError] = useState('');
  useEffect(() => { if (user) setForm({ company: user.company, companyAddress: user.companyAddress, companyWebsite: user.companyWebsite }); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!user) return null;

  const save = (e: FormEvent) => {
    e.preventDefault();
    const err = updateProfile(form);
    setError(err ?? '');
    if (!err) toast(t('saved'));
  };
  const setLogo = (companyLogo: string) => { updateProfile({ companyLogo }); toast(t('saved')); };

  return (
    <section className="card card-pad" aria-labelledby="set-company">
      <h2 id="set-company" className="card-title">{t('companyTitle')}</h2>
      <p className="card-desc">{t('companySub')}</p>
      <ImageUpload label={t('companyLogo')} preview={<CompanyLogo company={user.company} logo={user.companyLogo} size={72} />}
        hasImage={!!user.companyLogo} size={240} crop={false} onChange={setLogo} removeKey="removeLogo" uploadKey="uploadLogo" />
      <form className="grid" onSubmit={save} noValidate style={{ marginTop: 18 }}>
        {error && <div className="notice danger" role="alert">{t(error)}</div>}
        <div className="field">
          <label htmlFor="set-company-name">{t('companyName')}</label>
          <input id="set-company-name" autoComplete="organization" value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} />
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="set-company-address">{t('companyAddress')}</label>
            <input id="set-company-address" autoComplete="street-address" value={form.companyAddress} onChange={e => setForm(f => ({ ...f, companyAddress: e.target.value }))} />
          </div>
          <div className="field">
            <label htmlFor="set-company-website">{t('companyWebsite')}</label>
            <input id="set-company-website" type="url" dir="ltr" placeholder="www.example.com" value={form.companyWebsite} onChange={e => setForm(f => ({ ...f, companyWebsite: e.target.value }))} />
          </div>
        </div>
        <div><button type="submit" className="btn btn-primary">{t('saveChanges')}</button></div>
      </form>
    </section>
  );
}

function SecurityTab() {
  const { t } = useLanguage();
  const { user, changeEmail, changePassword, requestResetCode, resetPassword } = useAuth();
  const { toast } = useUi();
  const [email, setEmail] = useState({ next: '', password: '' });
  const [emailError, setEmailError] = useState('');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwError, setPwError] = useState('');
  const [reset, setReset] = useState({ sent: '', code: '', next: '', confirm: '' });
  const [resetError, setResetError] = useState('');
  if (!user) return null;

  const saveEmail = async (e: FormEvent) => {
    e.preventDefault();
    const err = await changeEmail(email.next, email.password);
    setEmailError(err ?? '');
    if (!err) { setEmail({ next: '', password: '' }); toast(t('emailChanged')); }
  };
  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    const err = await changePassword(pw.current, pw.next, pw.confirm);
    setPwError(err ?? '');
    if (!err) { setPw({ current: '', next: '', confirm: '' }); toast(t('passwordChanged')); }
  };
  const sendCode = () => {
    const res = requestResetCode(user.email);
    if ('error' in res) { setResetError(res.error); return; }
    setResetError('');
    setReset(r => ({ ...r, sent: res.code, code: '' }));
    toast(t('codeSent'));
  };
  const doReset = async (e: FormEvent) => {
    e.preventDefault();
    const err = await resetPassword(user.email, reset.code, reset.next, reset.confirm);
    setResetError(err ?? '');
    if (!err) { setReset({ sent: '', code: '', next: '', confirm: '' }); toast(t('passwordChanged')); }
  };

  return (
    <>
      <section className="card card-pad" aria-labelledby="set-email">
        <h2 id="set-email" className="card-title">{t('emailTitle')}</h2>
        <p className="card-desc">{t('currentEmail')}: <strong dir="ltr">{user.email}</strong></p>
        <form className="grid" onSubmit={saveEmail} noValidate style={{ marginTop: 14 }}>
          {emailError && <div className="notice danger" role="alert">{t(emailError)}</div>}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="set-email-new">{t('newEmail')}</label>
              <input id="set-email-new" type="email" autoComplete="email" dir="ltr" value={email.next} onChange={e => setEmail(v => ({ ...v, next: e.target.value }))} />
            </div>
            <PasswordInput id="set-email-pw" label={t('confirmWithPassword')} value={email.password} onChange={v => setEmail(s => ({ ...s, password: v }))} autoComplete="current-password" />
          </div>
          <div><button type="submit" className="btn btn-primary">{t('changeEmailBtn')}</button></div>
        </form>
      </section>

      <section className="card card-pad" aria-labelledby="set-password">
        <h2 id="set-password" className="card-title">{t('securityTitle')}</h2>
        <p className="card-desc">{t('securitySub')}</p>
        <form className="grid" onSubmit={savePassword} noValidate style={{ marginTop: 14 }}>
          {pwError && <div className="notice danger" role="alert">{t(pwError)}</div>}
          <PasswordInput id="set-pw-current" label={t('currentPassword')} value={pw.current} onChange={v => setPw(p => ({ ...p, current: v }))} autoComplete="current-password" />
          <div className="form-grid">
            <PasswordInput id="set-pw-new" label={t('newPassword')} value={pw.next} onChange={v => setPw(p => ({ ...p, next: v }))} autoComplete="new-password" hint={t('passwordHint')} />
            <PasswordInput id="set-pw-confirm" label={t('confirmPassword')} value={pw.confirm} onChange={v => setPw(p => ({ ...p, confirm: v }))} autoComplete="new-password" />
          </div>
          <div><button type="submit" className="btn btn-primary">{t('changePasswordBtn')}</button></div>
        </form>
      </section>

      <section className="card card-pad" aria-labelledby="set-reset">
        <h2 id="set-reset" className="card-title">{t('resetTitle')}</h2>
        <p className="card-desc">{t('resetSettingsSub')}</p>
        {resetError && <div className="notice danger" role="alert" style={{ marginTop: 14 }}>{t(resetError)}</div>}
        {!reset.sent ? (
          <div style={{ marginTop: 14 }}><button type="button" className="btn btn-outline" onClick={sendCode}>{t('sendCode')}</button></div>
        ) : (
          <form className="grid" onSubmit={doReset} noValidate style={{ marginTop: 14 }}>
            <div className="notice blue" role="status">
              <strong>{t('demoCodeTitle')}</strong>
              {t('demoCodeBody')} <span className="mono code-chip">{reset.sent}</span>
            </div>
            <div className="field">
              <label htmlFor="set-reset-code">{t('resetCode')}</label>
              <input id="set-reset-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={reset.code} onChange={e => setReset(r => ({ ...r, code: e.target.value.replace(/\D/g, '') }))} />
            </div>
            <div className="form-grid">
              <PasswordInput id="set-reset-new" label={t('resetNewPassword')} value={reset.next} onChange={v => setReset(r => ({ ...r, next: v }))} autoComplete="new-password" hint={t('passwordHint')} />
              <PasswordInput id="set-reset-confirm" label={t('resetConfirmPassword')} value={reset.confirm} onChange={v => setReset(r => ({ ...r, confirm: v }))} autoComplete="new-password" />
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button type="submit" className="btn btn-primary">{t('resetBtn')}</button>
              <button type="button" className="btn btn-outline" onClick={sendCode}>{t('resendCode')}</button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}

function NotificationsTab() {
  const { t } = useLanguage();
  const { user, updateProfile } = useAuth();
  if (!user) return null;
  const toggle = (key: keyof NotificationPrefs) => updateProfile({ notifications: { ...user.notifications, [key]: !user.notifications[key] } });
  const rows: Array<[keyof NotificationPrefs, string]> = [
    ['emailBookings', 'nEmailBookings'], ['smsSchedule', 'nSmsSchedule'], ['whatsapp', 'nWhatsapp'], ['productNews', 'nProductNews'],
  ];
  return (
    <section className="card card-pad" aria-labelledby="set-notifications">
      <h2 id="set-notifications" className="card-title">{t('notificationsTitle')}</h2>
      <p className="card-desc">{t('notificationsSub')}</p>
      <div className="toggle-list">
        {rows.map(([key, label]) => (
          <label key={key} className="toggle-row">
            <span>{t(label)}</span>
            <input type="checkbox" role="switch" checked={user.notifications[key]} onChange={() => toggle(key)} />
          </label>
        ))}
      </div>
    </section>
  );
}

function PreferencesTab() {
  const { t, lang, setLang } = useLanguage();
  const { pref: theme, setPref: setTheme } = useTheme();
  return (
    <section className="card card-pad" aria-labelledby="set-language">
      <h2 id="set-language" className="card-title">{t('preferencesTitle')}</h2>
      <p className="card-desc">{t('preferencesSub')}</p>
      <div className="field" style={{ marginTop: 14, maxWidth: 320 }}>
        <label htmlFor="set-lang">{t('languagePref')}</label>
        <select id="set-lang" value={lang} onChange={e => setLang(e.target.value as 'en' | 'ar')}>
          <option value="en">English</option>
          <option value="ar">العربية</option>
        </select>
      </div>
      <div className="field" style={{ marginTop: 14, maxWidth: 320 }}>
        <label htmlFor="set-appearance">{t('appearancePref')}</label>
        <select id="set-appearance" value={theme} onChange={e => setTheme(e.target.value as ThemePref)}>
          <option value="light">{t('themeLight')}</option>
          <option value="dark">{t('themeDark')}</option>
          <option value="system">{t('themeSystem')}</option>
        </select>
        <small>{t('appearanceHint')}</small>
      </div>
      <div className="inset small" style={{ marginTop: 16 }}>
        <div className="between"><span className="muted">{t('timeFormat')}</span><strong>{t('timeFormat12')}</strong></div>
        <div className="between" style={{ marginTop: 8 }}><span className="muted">{t('timeZone')}</span><strong>{t('timeZoneValue')}</strong></div>
      </div>
    </section>
  );
}

function AccountTab() {
  const { t } = useLanguage();
  const { signOut, deleteAccount } = useAuth();
  const { toast, openModal } = useUi();
  const navigate = useNavigate();
  const doSignOut = () => { signOut(); toast(t('signedOut')); navigate('/signin', { replace: true }); };
  const askDelete = () => openModal({
    title: t('deleteAccount'), desc: t('deleteConfirm'), confirmText: t('deleteAccount'), requireReason: true,
    onConfirm: () => { deleteAccount(); toast(t('accountDeleted')); navigate('/signin', { replace: true }); },
  });
  return (
    <>
      <section className="card card-pad" aria-labelledby="set-signout">
        <h2 id="set-signout" className="card-title">{t('signOut')}</h2>
        <p className="card-desc">{t('signOutSub')}</p>
        <div style={{ marginTop: 14 }}><button type="button" className="btn btn-navy" onClick={doSignOut}>{t('signOut')}</button></div>
      </section>
      <section className="card card-pad danger-zone" aria-labelledby="set-delete">
        <h2 id="set-delete" className="card-title">{t('deleteAccount')}</h2>
        <p className="card-desc">{t('deleteSub')}</p>
        <div style={{ marginTop: 14 }}><button type="button" className="btn btn-danger" onClick={askDelete}>{t('deleteAccount')}</button></div>
      </section>
    </>
  );
}

export default function SettingsView() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') as Tab | null;
  const tab: Tab = requested && SETTINGS_TABS.includes(requested) ? requested : 'profile';
  // On phones the tabs scroll sideways: keep the open one (e.g. ATCO information) in view.
  useEffect(() => {
    document.querySelector('.settings-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
  // Before sign-in only the ATCO information is available (Contact ATCO on the sign-in page).
  if (!user) {
    return tab === 'atco' ? <><PageHeader titleKey="settingsTitle" subKey="atcoInfoSub" /><AtcoInfoTab /></> : null;
  }

  return (
    <>
      <PageHeader titleKey="settingsTitle" subKey="settingsSub" />
      <div className="settings-layout">
        <aside className="card settings-nav">
          <div className="settings-who">
            <Avatar user={user} size={44} />
            <div style={{ minWidth: 0 }}>
              <strong>{user.fullName || user.username}</strong>
              <span className="settings-co"><CompanyLogo company={user.company} logo={user.companyLogo} size={18} />{user.company}</span>
            </div>
          </div>
          <nav className="settings-tabs" aria-label={t('settingsTitle')}>
            {SETTINGS_TABS.map(key => (
              <button key={key} type="button" className={`settings-tab${tab === key ? ' active' : ''}`} aria-current={tab === key ? 'page' : undefined}
                onClick={() => setParams(key === 'profile' ? {} : { tab: key }, { replace: true })}>
                {t(TAB_LABEL[key])}
              </button>
            ))}
          </nav>
        </aside>
        <div className="grid settings-body">
          {tab === 'profile' && <ProfileTab />}
          {tab === 'company' && <CompanyTab />}
          {tab === 'security' && <SecurityTab />}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'preferences' && <PreferencesTab />}
          {tab === 'account' && <AccountTab />}
          {tab === 'atco' && <AtcoInfoTab />}
        </div>
      </div>
    </>
  );
}
