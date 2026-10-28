import { useEffect, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { getAppConfig } from '../lib/supabase';
import {
  exportMyData, listNotificationPreferences, listPrivacyRequests, securityPosture, setNotificationPreference, submitPrivacyRequest,
} from '../lib/phase8Service';
import { downloadBytes } from '../domain/pdf';
import { ProdPageHeader } from '../components/ProductionUi';
import { FlashNotice, useAction, useLoad } from '../components/StaffKit';

/**
 * Account, privacy and security (`/account`): notification channels with explicit
 * consent, self-service data export, privacy requests, and TOTP multi-factor
 * enrolment through Supabase Auth (required for staff when ATCO switches on
 * security.staff_mfa_required).
 */
const CONSENT_VERSION = 'msg-consent-v1';

function Mfa() {
  const { t } = useLanguage();
  const posture = useLoad(securityPosture, []);
  const [factors, setFactors] = useState<Array<{ id: string; status: string; friendly_name?: string }>>([]);
  const [enrol, setEnrol] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const { busy, flash, run } = useAction(async () => { await refresh(); await posture.reload(); });
  const auth = () => {
    const config = getAppConfig();
    if (config.mode === 'demo' || 'error' in config) throw new Error('unavailable');
    return config.supabase.auth;
  };
  const refresh = async () => {
    try { const { data } = await auth().mfa.listFactors(); setFactors((data?.totp ?? []) as typeof factors); } catch { setFactors([]); }
  };
  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const verified = factors.filter(f => f.status === 'verified');
  return (
    <section className="card card-pad" aria-labelledby="mfa-title">
      <h2 id="mfa-title" className="card-title">{t('p8MfaTitle')}</h2>
      <p className="card-desc">{t('p8MfaBody')}</p>
      {posture.data && (
        <div className="status-grid" style={{ marginTop: 10 }}>
          <div className="status-item"><div className="status-label">{t('p8MfaSession')}</div><div className="status-text mono">{posture.data.sessionAal}</div></div>
          <div className="status-item"><div className="status-label">{t('p8MfaRequired')}</div><div className="status-text">{t(posture.data.isStaff && posture.data.mfaRequired ? 'p8Yes' : 'p8No')}</div></div>
          <div className="status-item"><div className="status-label">{t('p8MfaFactors')}</div><div className="status-text">{verified.length}</div></div>
        </div>
      )}
      {posture.data?.isStaff && posture.data.mfaRequired && posture.data.sessionAal !== 'aal2' && <div className="notice warn" style={{ marginTop: 10 }}>{t('p8MfaStaffBlocked')}</div>}
      {!enrol && (
        <button type="button" className="btn btn-outline" style={{ marginTop: 10 }} disabled={busy} onClick={() => void run(async () => {
          const { data, error } = await auth().mfa.enroll({ factorType: 'totp', friendlyName: `Gulf Mover ${new Date().toISOString().slice(0, 10)}` });
          if (error || !data) throw new Error('enroll');
          setEnrol({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
        }, 'p8MfaScan')}>{t('p8MfaEnrol')}</button>
      )}
      {(verified.length > 0 || enrol) && posture.data?.sessionAal !== 'aal2' && (
        <div style={{ marginTop: 10 }}>
          {enrol && <div><img src={enrol.qr} alt={t('p8MfaQrAlt')} width={180} height={180} /><p className="small">{t('p8MfaSecret')}: <code dir="ltr">{enrol.secret}</code></p></div>}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="sr-only" htmlFor="mfa-code">{t('p8MfaCode')}</label>
            <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} dir="ltr" placeholder="123456" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
            <button type="button" className="btn btn-primary" disabled={busy || code.length !== 6} onClick={() => void run(async () => {
              const factorId = enrol?.id ?? verified[0]?.id;
              if (!factorId) throw new Error('factor');
              const { error } = await auth().mfa.challengeAndVerify({ factorId, code });
              if (error) throw new Error('verify');
              setEnrol(null); setCode('');
              await auth().refreshSession();
            }, 'p8MfaVerified')}>{t('p8MfaVerify')}</button>
          </div>
        </div>
      )}
      <FlashNotice flash={flash} />
    </section>
  );
}

export default function AccountPrivacyView() {
  const { t } = useLanguage();
  const prefs = useLoad(listNotificationPreferences, []);
  const requests = useLoad(listPrivacyRequests, []);
  const { busy, flash, run } = useAction(async () => { await prefs.reload(); await requests.reload(); });
  const [type, setType] = useState<'access_export' | 'correction' | 'erasure' | 'objection'>('access_export');
  const [details, setDetails] = useState('');
  const pref = (c: 'email' | 'sms' | 'whatsapp') => prefs.data?.find(p => p.channel === c)?.optedIn ?? c === 'email';
  return (
    <>
      <ProdPageHeader titleKey="p8AccountTitle" subKey="p8AccountSub" />
      <section className="card card-pad" aria-labelledby="np-title">
        <h2 id="np-title" className="card-title">{t('p8NotifPrefs')}</h2>
        <p className="card-desc">{t('p8NotifPrefsBody')}</p>
        {(['email', 'sms', 'whatsapp'] as const).map(c => (
          <label key={c} className="checkrow" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={pref(c)} disabled={busy || !prefs.data}
              onChange={e => void run(() => setNotificationPreference(c, e.target.checked, e.target.checked ? CONSENT_VERSION : null))} />
            <span>{t(`p8Channel_${c}`)}</span>
          </label>
        ))}
        <p className="muted small" style={{ marginTop: 8 }}>{t('p8ConsentText')}</p>
        <FlashNotice flash={flash} />
      </section>
      <section className="card card-pad" aria-labelledby="pv-title">
        <h2 id="pv-title" className="card-title">{t('p8PrivacyTitle')}</h2>
        <p className="card-desc">{t('p8PrivacyBody')}</p>
        <button type="button" className="btn btn-outline" style={{ marginTop: 10 }} disabled={busy} onClick={() => void run(async () => {
          const data = await exportMyData();
          downloadBytes(new TextEncoder().encode(JSON.stringify(data, null, 2)), `gulf-mover-my-data-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
        }, 'p8ExportReady')}>{t('p8ExportMyData')}</button>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="field"><label htmlFor="pv-type">{t('p8RequestType')}</label>
            <select id="pv-type" value={type} onChange={e => setType(e.target.value as typeof type)}>
              {(['access_export', 'correction', 'erasure', 'objection'] as const).map(v => <option key={v} value={v}>{t(`p8Priv_${v}`)}</option>)}
            </select></div>
          <div className="field"><label htmlFor="pv-details">{t('p8Details')}</label><textarea id="pv-details" maxLength={1000} value={details} onChange={e => setDetails(e.target.value)} /></div>
        </div>
        <button type="button" className="btn btn-outline" style={{ marginTop: 10 }} disabled={busy} onClick={() => void run(() => submitPrivacyRequest(type, details), 'p8RequestSubmitted')}>{t('p8SubmitRequest')}</button>
        <p className="muted small" style={{ marginTop: 8 }}>{t('p8ErasureNote')}</p>
        {(requests.data ?? []).map(r => (
          <div key={r.id} className="request-row"><div><div className="request-title">{t(`p8Priv_${r.type}`)}</div><div className="request-meta">{t('p8DueDate')} {r.dueAt.slice(0, 10)}</div></div>
            <span className="pill pill-neutral">{t(`p8PrivStatus_${r.status}`)}</span></div>
        ))}
      </section>
      <Mfa />
    </>
  );
}
