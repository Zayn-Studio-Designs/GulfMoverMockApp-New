import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { usePlatformRoles } from '../context/OnboardingContext';
import { DataServiceError } from '../lib/dataService';
import {
  REJECTION_REASON_MAX, getCompanyHistory, listCompanies, reviewCompany,
  type CompanyPage, type CompanyRecord, type CompanyStatusFilter, type ReviewDecision, type ReviewEvent,
} from '../lib/adminService';
import { ProdPageHeader, RequireRoles, dataErrorKey } from '../components/ProductionUi';
import { saudiDateTimeParts } from '../domain/dates';

/**
 * ATCO company review (`/admin/companies`, production only).
 * Visible to super_admin and operations (both may read organisations under RLS); only
 * super_admin sees the decision controls — and review_company() refuses anyone else anyway.
 */

const FILTERS: readonly CompanyStatusFilter[] = ['pending', 'approved', 'rejected', 'suspended', 'all'];
const STATUS_KEY: Record<string, string> = {
  pending: 'onbStatusPending', approved: 'onbStatusApproved', rejected: 'onbStatusRejected', suspended: 'onbStatusSuspended', all: 'admFilterAll',
};
const DECISION_KEY: Record<string, string> = {
  submitted: 'admEvSubmitted', approved: 'admEvApproved', rejected: 'admEvRejected', suspended: 'admEvSuspended', reinstated: 'admEvReinstated',
};
const tone = (status: string) => (status === 'approved' ? 'pill-green' : status === 'pending' ? 'pill-gold' : 'pill-red');
const when = (iso: string | null) => {
  if (!iso || Number.isNaN(Date.parse(iso))) return '—';
  const { date, time } = saudiDateTimeParts(iso);
  return `${date} ${time}`;
};

function CompanyDetail({ company, canDecide, onDecided }: {
  company: CompanyRecord; canDecide: boolean; onDecided: (status?: CompanyRecord['status']) => void;
}) {
  const { t } = useLanguage();
  const [history, setHistory] = useState<ReviewEvent[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const loadHistory = useCallback(async () => {
    setHistoryError('');
    try { setHistory(await getCompanyHistory(company.id)); } catch (e) { setHistory(null); setHistoryError(dataErrorKey(e)); }
  }, [company.id]);
  useEffect(() => { setReason(''); void loadHistory(); }, [loadHistory]);
  useEffect(() => { setMessage(null); }, [company.id]);

  const decide = async (decision: ReviewDecision, e?: FormEvent) => {
    e?.preventDefault();
    if (inFlight.current) return; // double clicks never send a second decision
    if (decision === 'reject' && !reason.trim()) { setMessage({ tone: 'error', text: t('admErrReasonRequired') }); return; }
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await reviewCompany(company.id, decision, reason);
      setMessage({ tone: 'ok', text: t(result.outcome === 'unchanged' ? 'admUnchanged' : decision === 'approve' ? 'admApprovedDone' : 'admRejectedDone') });
      setReason('');
      onDecided(result.status);
      void loadHistory();
    } catch (error) {
      const err = error instanceof DataServiceError ? error : new DataServiceError('unknown');
      setMessage({ tone: 'error', text: t(err.uncertain ? 'admUncertain' : dataErrorKey(err)) });
      if (err.kind === 'invalid-transition') onDecided(); // somebody else decided first: refresh
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const fields: Array<[string, string | null]> = [
    ['onbLegalName', company.legalName], ['onbDisplayName', company.displayName], ['onbRegNumber', company.registrationNumber],
    ['onbContactEmail', company.contactEmail], ['onbContactPhone', company.contactPhone], ['onbBilling', company.billingContact],
  ];

  return (
    <section className="card card-pad" aria-labelledby="adm-detail-title" style={{ minWidth: 0 }}>
      <div className="between">
        <h2 id="adm-detail-title" className="card-title">{company.displayName || company.legalName}</h2>
        <span className={`pill ${tone(company.status)}`}>{t(STATUS_KEY[company.status])}</span>
      </div>
      <p className="card-desc">{t('admNoVerification')}</p>
      <div className="inset small" style={{ marginTop: 12 }}>
        {fields.map(([label, value]) => (
          <div key={label} className="between" style={{ marginTop: 6 }}>
            <span className="muted">{t(label).replace(' *', '').replace(/ \(.*\)$/, '')}</span>
            <strong>{value || '—'}</strong>
          </div>
        ))}
        <div className="between" style={{ marginTop: 6 }}><span className="muted">{t('admSubmittedAt')}</span><strong className="mono">{when(company.createdAt)}</strong></div>
        {company.approvedAt && <div className="between" style={{ marginTop: 6 }}><span className="muted">{t('admApprovedAt')}</span><strong className="mono">{when(company.approvedAt)}</strong></div>}
        {company.rejectionReason && <div className="between" style={{ marginTop: 6 }}><span className="muted">{t('admReason')}</span><strong>{company.rejectionReason}</strong></div>}
      </div>

      <h3 className="card-title" style={{ marginTop: 16 }}>{t('admHistory')}</h3>
      {historyError && <div className="notice danger" role="alert" style={{ marginTop: 8 }}>{t(historyError)}</div>}
      {!historyError && history === null && <div className="card-desc" role="status">{t('onbLoading')}</div>}
      {history && history.length === 0 && <div className="no-data" style={{ marginTop: 8 }}>{t('admNoHistory')}</div>}
      {history && history.length > 0 && (
        <ol className="activity" style={{ marginTop: 10, paddingInlineStart: 0, listStyle: 'none' }}>
          {history.map((ev, i) => (
            <li key={`${ev.occurredAt}-${i}`} className="activity-item">
              <span className="activity-marker" />
              <span>
                <strong>{t(DECISION_KEY[ev.decision] ?? 'admEvOther')}</strong>{ev.reason ? ` — ${ev.reason}` : ''}
                <span className="activity-time mono" style={{ display: 'block' }}>{when(ev.occurredAt)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}

      {message && <div className={`notice ${message.tone === 'ok' ? '' : 'danger'}`} role={message.tone === 'ok' ? 'status' : 'alert'} style={{ marginTop: 14 }}>{message.text}</div>}

      {canDecide && company.status === 'pending' && (
        <form className="grid" style={{ marginTop: 14 }} onSubmit={e => void decide('reject', e)} aria-busy={busy}>
          <div className="field">
            <label htmlFor="adm-reason">{t('admReasonLabel')}</label>
            <textarea id="adm-reason" maxLength={REJECTION_REASON_MAX} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} />
            <small>{t('admReasonHint')}</small>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide('approve')}>{t('admApprove')}</button>
            <button type="submit" className="btn btn-danger" disabled={busy}>{t('admReject')}</button>
          </div>
        </form>
      )}
      {!canDecide && company.status === 'pending' && <div className="notice blue" style={{ marginTop: 14 }}>{t('admViewOnly')}</div>}
    </section>
  );
}

function CompaniesScreen() {
  const { t } = useLanguage();
  const roles = usePlatformRoles() ?? [];
  const canDecide = roles.includes('super_admin');
  const [filter, setFilter] = useState<CompanyStatusFilter>('pending');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<CompanyPage | null>(null);
  const [error, setError] = useState('');
  // Kept separately from the page so a decided company stays open after the list reloads.
  const [selected, setSelected] = useState<CompanyRecord | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setError('');
    try {
      const result = await listCompanies({ status: filter, search: query, page });
      if (seq === requestSeq.current) setData(result);
    } catch (e) {
      if (seq === requestSeq.current) { setData(null); setError(dataErrorKey(e)); }
    }
  }, [filter, query, page]);
  useEffect(() => { void load(); }, [load]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <ProdPageHeader titleKey="admTitle" subKey="admSub" />
      <div className="split">
        {/* min-width:0 lets the panel shrink on phones; the status tab bar scrolls sideways instead. */}
        <section className="card card-pad" aria-label={t('admListLabel')} style={{ minWidth: 0 }}>
          <div className="tabbar" role="tablist" aria-label={t('admFilterLabel')}>
            {FILTERS.map(f => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} className={`tab${filter === f ? ' active' : ''}`}
                onClick={() => { setFilter(f); setPage(0); setSelected(null); }}>{t(STATUS_KEY[f])}</button>
            ))}
          </div>
          <form className="row" onSubmit={e => { e.preventDefault(); setQuery(search); setPage(0); }} role="search">
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="adm-search">{t('admSearch')}</label>
              <input id="adm-search" value={search} maxLength={100} onChange={e => setSearch(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-outline" style={{ alignSelf: 'end' }}>{t('admSearchBtn')}</button>
          </form>
          {error && <div className="notice danger" role="alert" style={{ marginTop: 12 }}>{t(error)} <button type="button" className="link-btn" onClick={() => void load()}>{t('screenErrorRetry')}</button></div>}
          {!error && data === null && <div className="card-desc" role="status" style={{ marginTop: 12 }}>{t('onbLoading')}</div>}
          {data && data.items.length === 0 && <div className="no-data" style={{ marginTop: 12 }}>{t('admEmpty')}</div>}
          {data && data.items.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {data.items.map(c => (
                <div key={c.id} className="request-row">
                  <div>
                    <div className="request-title">{c.displayName || c.legalName}</div>
                    <div className="request-meta">{c.legalName} · <span className="mono">{when(c.createdAt)}</span></div>
                  </div>
                  <div className="row">
                    <span className={`pill ${tone(c.status)}`}>{t(STATUS_KEY[c.status])}</span>
                    <button type="button" className="btn btn-outline btn-small" aria-pressed={selected?.id === c.id} onClick={() => setSelected(c)}>{t('admOpen')}</button>
                  </div>
                </div>
              ))}
              <div className="between" style={{ marginTop: 12 }}>
                <button type="button" className="btn btn-outline btn-small" disabled={page === 0} onClick={() => setPage(p => p - 1)}>{t('admPrev')}</button>
                <span className="small muted">{t('admPageOf').replace('{n}', String(page + 1)).replace('{total}', String(pages))}</span>
                <button type="button" className="btn btn-outline btn-small" disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)}>{t('admNext')}</button>
              </div>
            </div>
          )}
        </section>
        {selected
          ? <CompanyDetail company={selected} canDecide={canDecide}
              onDecided={status => { if (status) setSelected(s => (s ? { ...s, status } : s)); void load(); }} />
          : <section className="card card-pad" style={{ minWidth: 0 }}><div className="no-data">{t('admSelectHint')}</div></section>}
      </div>
    </>
  );
}

export default function AdminCompaniesView() {
  return <RequireRoles roles={['super_admin', 'operations']}><CompaniesScreen /></RequireRoles>;
}
