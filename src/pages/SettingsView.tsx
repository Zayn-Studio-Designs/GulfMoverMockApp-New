import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useAuth, type NotificationPrefs } from '../context/AuthContext';
import { useUi } from '../context/UiContext';
import { PageHeader } from '../components/PageHeader';
import { Avatar } from '../components/Avatar';

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** Shrinks an uploaded image to a 160px square data URL so it fits comfortably in browser storage. */
function toAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('image'));
      img.onload = () => {
        const size = 160;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(String(reader.result)); return; }
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export default function SettingsView() {
  const { t, lang, setLang } = useLanguage();
  const { user, updateProfile, changePassword, signOut, deleteAccount } = useAuth();
  const { toast, openModal } = useUi();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState({ username: user?.username ?? '', email: user?.email ?? '', company: user?.company ?? '' });
  const [profileError, setProfileError] = useState('');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwError, setPwError] = useState('');
  const [photoError, setPhotoError] = useState('');

  useEffect(() => {
    if (user) setProfile({ username: user.username, email: user.email, company: user.company });
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return null;

  const saveProfile = (e: FormEvent) => {
    e.preventDefault();
    const err = updateProfile(profile);
    setProfileError(err ?? '');
    if (!err) toast(t('saved'));
  };

  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    const err = await changePassword(pw.current, pw.next, pw.confirm);
    setPwError(err ?? '');
    if (!err) { setPw({ current: '', next: '', confirm: '' }); toast(t('passwordChanged')); }
  };

  const onPhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setPhotoError('photoType'); return; }
    if (file.size > MAX_PHOTO_BYTES) { setPhotoError('photoTooBig'); return; }
    setPhotoError('');
    try {
      updateProfile({ avatar: await toAvatarDataUrl(file) });
      toast(t('saved'));
    } catch {
      setPhotoError('photoType');
    }
  };

  const toggle = (key: keyof NotificationPrefs) => {
    updateProfile({ notifications: { ...user.notifications, [key]: !user.notifications[key] } });
  };

  const doSignOut = () => { signOut(); toast(t('signedOut')); navigate('/signin', { replace: true }); };

  const askDelete = () => openModal({
    title: t('deleteAccount'), desc: t('deleteConfirm'), confirmText: t('deleteAccount'), requireReason: true,
    onConfirm: () => { deleteAccount(); toast(t('accountDeleted')); navigate('/signin', { replace: true }); },
  });

  const notificationRows: Array<[keyof NotificationPrefs, string]> = [
    ['emailBookings', 'nEmailBookings'], ['smsSchedule', 'nSmsSchedule'], ['whatsapp', 'nWhatsapp'], ['productNews', 'nProductNews'],
  ];

  return (
    <>
      <PageHeader titleKey="settingsTitle" subKey="settingsSub" />
      <div className="settings-grid">
        <section className="card card-pad" aria-labelledby="set-profile">
          <h2 id="set-profile" className="card-title">{t('profile')}</h2>
          <p className="card-desc">{t('profileSub')}</p>
          <div className="avatar-row">
            <Avatar user={user} size={72} />
            <div className="grid" style={{ gap: 8 }}>
              <span className="label">{t('profilePicture')}</span>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-outline btn-small" onClick={() => fileRef.current?.click()}>{t('uploadPhoto')}</button>
                {user.avatar && <button type="button" className="btn btn-outline btn-small" onClick={() => updateProfile({ avatar: '' })}>{t('removePhoto')}</button>}
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onPhoto} aria-label={t('uploadPhoto')} />
              <small className="muted small">{t('photoHint')}</small>
              {photoError && <small className="error-text" role="alert">{t(photoError)}</small>}
            </div>
          </div>
          <form className="grid" onSubmit={saveProfile} noValidate style={{ marginTop: 16 }}>
            {profileError && <div className="notice danger" role="alert">{t(profileError)}</div>}
            <div className="field">
              <label htmlFor="set-username">{t('username')}</label>
              <input id="set-username" autoComplete="username" value={profile.username} onChange={e => setProfile(p => ({ ...p, username: e.target.value }))} />
              <small>{t('usernameHint')}</small>
            </div>
            <div className="field">
              <label htmlFor="set-email">{t('emailLabel')}</label>
              <input id="set-email" type="email" autoComplete="email" value={profile.email} onChange={e => setProfile(p => ({ ...p, email: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="set-company">{t('companyName')}</label>
              <input id="set-company" autoComplete="organization" value={profile.company} onChange={e => setProfile(p => ({ ...p, company: e.target.value }))} />
            </div>
            <div className="between">
              <span className="small muted">{t('memberSince')}: {user.createdAt.slice(0, 10)}</span>
              <button type="submit" className="btn btn-primary">{t('saveChanges')}</button>
            </div>
          </form>
        </section>

        <section className="card card-pad" aria-labelledby="set-password">
          <h2 id="set-password" className="card-title">{t('securityTitle')}</h2>
          <p className="card-desc">{t('securitySub')}</p>
          <form className="grid" onSubmit={savePassword} noValidate style={{ marginTop: 14 }}>
            {pwError && <div className="notice danger" role="alert">{t(pwError)}</div>}
            <div className="field">
              <label htmlFor="set-pw-current">{t('currentPassword')}</label>
              <input id="set-pw-current" type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw(p => ({ ...p, current: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="set-pw-new">{t('newPassword')}</label>
              <input id="set-pw-new" type="password" autoComplete="new-password" value={pw.next} onChange={e => setPw(p => ({ ...p, next: e.target.value }))} />
              <small>{t('passwordHint')}</small>
            </div>
            <div className="field">
              <label htmlFor="set-pw-confirm">{t('confirmPassword')}</label>
              <input id="set-pw-confirm" type="password" autoComplete="new-password" value={pw.confirm} onChange={e => setPw(p => ({ ...p, confirm: e.target.value }))} />
            </div>
            <div><button type="submit" className="btn btn-primary">{t('changePasswordBtn')}</button></div>
          </form>
        </section>

        <section className="card card-pad" aria-labelledby="set-notifications">
          <h2 id="set-notifications" className="card-title">{t('notificationsTitle')}</h2>
          <p className="card-desc">{t('notificationsSub')}</p>
          <div className="toggle-list">
            {notificationRows.map(([key, label]) => (
              <label key={key} className="toggle-row">
                <span>{t(label)}</span>
                <input type="checkbox" role="switch" checked={user.notifications[key]} onChange={() => toggle(key)} />
              </label>
            ))}
          </div>
        </section>

        <section className="card card-pad" aria-labelledby="set-language">
          <h2 id="set-language" className="card-title">{t('languageTitle')}</h2>
          <div className="field" style={{ marginTop: 12, maxWidth: 320 }}>
            <label htmlFor="set-lang">{t('languagePref')}</label>
            <select id="set-lang" value={lang} onChange={e => setLang(e.target.value as 'en' | 'ar')}>
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </div>
        </section>

        <section className="card card-pad" aria-labelledby="set-account">
          <h2 id="set-account" className="card-title">{t('accountTitle')}</h2>
          <p className="card-desc">{t('accountSub')}</p>
          <div className="row" style={{ flexWrap: 'wrap', marginTop: 14 }}>
            <button type="button" className="btn btn-navy" onClick={doSignOut}>{t('signOut')}</button>
            <button type="button" className="btn btn-danger" onClick={askDelete}>{t('deleteAccount')}</button>
          </div>
        </section>
      </div>
    </>
  );
}
