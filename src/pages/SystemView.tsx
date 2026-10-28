import { useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { usePlatformRoles } from '../context/OnboardingContext';
import { decidePrivacyRequest, deliveryIssues, listPrivacyRequests, systemDiagnostics, updateSetting } from '../lib/phase8Service';
import { ProdPageHeader } from '../components/ProductionUi';
import { FlashNotice, ReasonField, RequireRoles, useAction, useLoad } from '../components/StaffKit';

/**
 * System & support (`/admin/system`) for ATCO administration and IT support.
 * Shows health counters, notification delivery problems (no recipient data) and,
 * for administrators, privacy requests and the staff-MFA switch. IT support has
 * no access to passenger records anywhere in the database.
 */
export default function SystemView() {
  const { t } = useLanguage();
  const roles = usePlatformRoles() ?? [];
  const isAdmin = roles.includes('super_admin');
  const diag = useLoad(systemDiagnostics, []);
  const issues = useLoad(deliveryIssues, []);
  const privacy = useLoad(() => (isAdmin ? listPrivacyRequests() : Promise.resolve([])), [isAdmin]);
  const { busy, flash, run } = useAction(async () => { await diag.reload(); await privacy.reload(); });
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  return (
    <>
      <ProdPageHeader titleKey="p8SystemTitle" subKey="p8SystemSub" />
      <RequireRoles roles={['super_admin', 'it_support']}>
        <section className="card card-pad">
          <div className="between"><h2 className="card-title">{t('p8Diagnostics')}</h2><button type="button" className="btn btn-outline btn-small" onClick={() => void diag.reload()}>{t('pbRefresh')}</button></div>
          {diag.error && <div className="notice danger" role="alert">{t(diag.error)}</div>}
          {diag.data && (
            <div className="status-grid" style={{ marginTop: 10 }}>
              {Object.entries(diag.data).map(([k, v]) => (
                <div key={k} className="status-item"><div className="status-label">{t(`p8Diag_${k}`)}</div><div className="status-text mono" dir="ltr">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</div></div>
              ))}
            </div>
          )}
          {isAdmin && diag.data && (
            <div style={{ marginTop: 12 }}>
              <ReasonField id="sys-reason" value={reason} onChange={setReason} />
              <button type="button" className="btn btn-outline btn-small" style={{ marginTop: 8 }} disabled={busy || !reason.trim()}
                onClick={() => void run(() => updateSetting('security.staff_mfa_required', !diag.data!.staff_mfa_required, reason))}>
                {t(diag.data.staff_mfa_required ? 'p8DisableStaffMfa' : 'p8EnableStaffMfa')}</button>
              <p className="muted small">{t('p8StaffMfaHint')}</p>
            </div>
          )}
          <FlashNotice flash={flash} />
        </section>
        <section className="card card-pad">
          <h2 className="card-title">{t('p8DeliveryIssues')}</h2>
          <p className="card-desc">{t('p8DeliveryIssuesBody')}</p>
          {issues.error && <div className="notice danger" role="alert">{t(issues.error)}</div>}
          {(issues.data ?? []).length === 0 && <div className="no-data">{t('p8NoRows')}</div>}
          {(issues.data ?? []).map(i => (
            <div key={String(i.outbox_id)} className="request-row"><div><div className="request-title">{String(i.channel)} · {String(i.template_key)}</div>
              <div className="request-meta">{String(i.status)} · {t('p8Attempts')} {String(i.attempts)} · {String(i.last_error ?? i.suppressed_reason ?? '')}</div></div></div>
          ))}
        </section>
        {isAdmin && (
          <section className="card card-pad">
            <h2 className="card-title">{t('p8PrivacyRequests')}</h2>
            <div className="field"><label htmlFor="pr-notes">{t('p8DecisionNotes')}</label><input id="pr-notes" maxLength={1000} value={notes} onChange={e => setNotes(e.target.value)} /></div>
            {(privacy.data ?? []).length === 0 && <div className="no-data">{t('p8NoRows')}</div>}
            {(privacy.data ?? []).map(p => (
              <div key={p.id} className="request-row"><div><div className="request-title">{t(`p8Priv_${p.type}`)}</div><div className="request-meta">{t('p8DueDate')} {p.dueAt.slice(0, 10)}</div></div>
                <div className="row"><span className="pill pill-neutral">{t(`p8PrivStatus_${p.status}`)}</span>
                  {['received', 'in_progress'].includes(p.status) && <>
                    <button type="button" className="btn btn-outline btn-small" disabled={busy} onClick={() => void run(() => decidePrivacyRequest(p.id, 'in_progress', notes))}>{t('p8InProgress')}</button>
                    <button type="button" className="btn btn-outline btn-small" disabled={busy} onClick={() => void run(() => decidePrivacyRequest(p.id, 'completed', notes))}>{t('p8Complete')}</button>
                    <button type="button" className="btn btn-outline btn-small" disabled={busy || !notes.trim()} onClick={() => void run(() => decidePrivacyRequest(p.id, 'rejected', notes))}>{t('p8Reject')}</button>
                  </>}</div></div>
            ))}
          </section>
        )}
      </RequireRoles>
    </>
  );
}
