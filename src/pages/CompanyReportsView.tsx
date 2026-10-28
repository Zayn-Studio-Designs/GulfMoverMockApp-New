import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useOnboarding } from '../context/OnboardingContext';
import { bookableOrganizations } from '../lib/companyService';
import { listRecentInvoices, listSettlements, runReport } from '../lib/phase8Service';
import { formatSar } from '../domain/money';
import { ProdPageHeader } from '../components/ProductionUi';
import { todayRiyadh, useLoad } from '../components/StaffKit';

/**
 * Company account (`/company/account`) for corporate admins and ship agents:
 * organization-scoped activity, credit position, invoices and (agents) settlement
 * statements. The database limits every figure to the caller's own organization.
 */
export default function CompanyReportsView() {
  const { t, lang } = useLanguage();
  const { status } = useOnboarding();
  const admins = useMemo(() => (status.phase === 'ready' ? bookableOrganizations(status.snapshot).filter(o => o.membershipRole === 'company_admin') : []), [status]);
  const [org, setOrg] = useState('');
  const orgId = org || admins[0]?.id || '';
  const [from, setFrom] = useState(todayRiyadh(-90));
  const [to, setTo] = useState(todayRiyadh(0));
  const summary = useLoad(() => (orgId ? runReport('report_my_organization', { p_org: orgId, p_from: from, p_to: to }) : Promise.resolve([])), [orgId, from, to]);
  const invoices = useLoad(() => (orgId ? listRecentInvoices({}) : Promise.resolve([])), [orgId]);
  const settlements = useLoad(() => (orgId ? listSettlements() : Promise.resolve([])), [orgId]);
  const s = summary.data?.[0];
  const money = (v: unknown) => formatSar(Number(v ?? 0), lang);
  return (
    <>
      <ProdPageHeader titleKey="p8CompanyAccountTitle" subKey="p8CompanyAccountSub" />
      {admins.length === 0 ? <div className="card card-pad"><div className="notice warn">{t('p8CompanyAdminOnly')}</div></div> : (
        <>
          <section className="card card-pad">
            <div className="form-grid">
              {admins.length > 1 && <div className="field"><label htmlFor="ca-org">{t('pbOrganization')}</label>
                <select id="ca-org" value={orgId} onChange={e => setOrg(e.target.value)}>{admins.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>}
              <div className="field"><label htmlFor="ca-from">{t('p8From')}</label><input id="ca-from" type="date" value={from} onChange={e => setFrom(e.target.value)} /></div>
              <div className="field"><label htmlFor="ca-to">{t('p8To')}</label><input id="ca-to" type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
            </div>
            {summary.error && <div className="notice danger" role="alert">{t(summary.error)}</div>}
            {s && (
              <div className="status-grid" style={{ marginTop: 12 }}>
                <div className="status-item"><div className="status-label">{t('p8ColBookings')}</div><div className="status-text">{String(s.bookings)}</div></div>
                <div className="status-item"><div className="status-label">{t('p8ColPassengers')}</div><div className="status-text">{String(s.passengers)}</div></div>
                <div className="status-item"><div className="status-label">{t('p8Total')}</div><div className="status-text">{money(s.gross_halala)}</div></div>
                <div className="status-item"><div className="status-label">{t('p8Paid')}</div><div className="status-text">{money(s.paid_halala)}</div></div>
                <div className="status-item"><div className="status-label">{t('p8OnAccount')}</div><div className="status-text">{money(s.on_account_halala)}</div></div>
                <div className="status-item"><div className="status-label">{t('p8ColOutstanding')}</div><div className="status-text">{money(s.outstanding_halala)}</div></div>
              </div>
            )}
          </section>
          <section className="card card-pad">
            <h2 className="card-title">{t('p8InvoicesTitle')}</h2>
            {(invoices.data ?? []).length === 0 && <div className="no-data">{t('p8NoRows')}</div>}
            {(invoices.data ?? []).map(i => (
              <div key={i.id} className="request-row"><div><div className="request-title"><Link to={`/invoices/${i.id}`} className="mono">{i.invoiceNumber}</Link></div>
                <div className="request-meta">{formatSar(i.totalHalala, lang)}{i.dueDate ? ` · ${t('p8DueDate')} ${i.dueDate}` : ''}{i.sandbox ? ` · ${t('p8Sandbox')}` : ''}</div></div><span className="pill pill-neutral">{t(`p8Inv_${i.status}`)}</span></div>
            ))}
          </section>
          {(settlements.data ?? []).length > 0 && (
            <section className="card card-pad">
              <h2 className="card-title">{t('p8SettlementsTitle')}</h2>
              {(settlements.data ?? []).map(st => (
                <div key={st.id} className="request-row"><div><div className="request-title">{st.periodStart} → {st.periodEnd}</div>
                  <div className="request-meta">{t('p8Gross')} {formatSar(st.grossHalala, lang)} · {t('p8Commission')} {formatSar(st.commissionHalala, lang)} · {t('p8NetDue')} {formatSar(st.netDueHalala, lang)}</div></div>
                  <span className="pill pill-neutral">{t(`p8St_${st.status}`)}</span></div>
              ))}
            </section>
          )}
        </>
      )}
    </>
  );
}
