import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';
import { useUi } from '../context/UiContext';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';

const TABS = ['overview', 'bookings', 'passengerList', 'invoices', 'po', 'settlements'] as const;
type Tab = typeof TABS[number];

export default function CorporateView() {
  const { t, tx } = useLanguage();
  const { bookings, updateWizard } = useDemo();
  const { toast } = useUi();
  const navigate = useNavigate();
  const [org, setOrg] = useState<'corp' | 'agent'>('corp');
  const [tab, setTab] = useState<Tab>('overview');
  const isAgent = org === 'agent';

  return (
    <>
      <PageHeader titleKey="corporateTitle" subKey="corporateSub" />
      <div className="card card-pad">
        <div className="between" style={{ flexWrap: 'wrap' }}>
          <div><h2 className="card-title">{t('organization')}</h2><p className="card-desc">{t('assignedOnly')}</p></div>
          <div className="field" style={{ minWidth: 250 }}>
            <label htmlFor="org-switch">{t('organization')}</label>
            <select id="org-switch" value={org} onChange={e => setOrg(e.target.value as 'corp' | 'agent')}>
              <option value="corp">{t('corpOrg')}</option>
              <option value="agent">{t('agentOrg')}</option>
            </select>
          </div>
        </div>
        <div className="tabbar" role="tablist" style={{ marginTop: 18 }}>
          {TABS.map(name => (
            <button key={name} type="button" role="tab" aria-selected={tab === name} className={`tab${tab === name ? ' active' : ''}`} onClick={() => setTab(name)}>{t(name)}</button>
          ))}
        </div>
        {tab === 'overview' && (
          <>
            <div className="grid grid-3">
              <div className="metric"><div className="metric-label">{t('openBookings')}</div><div className="metric-value">{isAgent ? '4' : '6'}</div><div className="metric-foot">{tx('Demo count only')}</div></div>
              <div className="metric"><div className="metric-label">{t('creditStatus')}</div><div className="metric-value" style={{ fontSize: 20 }}>{t('notConfigured')}</div><div className="metric-foot">{tx('ATCO terms not supplied')}</div></div>
              <div className="metric"><div className="metric-label">{t('invoicesDue')}</div><div className="metric-value">2</div><div className="metric-foot">{tx('Fictional sample records')}</div></div>
            </div>
            <div className="notice" style={{ marginTop: 16 }}>{isAgent ? t('assignedOnly') : tx('Demo company scope only. Corporate credit, terms, invoices and user permissions require ATCO approval.')}</div>
            <div style={{ marginTop: 16 }}>
              <button type="button" className="btn btn-primary" onClick={() => { updateWizard({ service: 'passenger' }); navigate('/'); }}>{t('newCorpBooking')}</button>
            </div>
          </>
        )}
        {tab === 'bookings' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('bookingRef')}</th><th>{tx('Client scope')}</th><th>{t('leg')}</th><th>{t('amount')}</th><th>{t('status')}</th></tr></thead>
              <tbody>
                {bookings.slice(0, 2).map(b => (
                  <tr key={b.ref}>
                    <td className="mono">{b.ref}</td>
                    <td>{isAgent ? tx('Assigned demo client') : t('corpOrg')}</td>
                    <td>{tx(b.leg)} · {b.time}</td>
                    <td>SAR {b.amount} <span className="tiny muted">{tx('demo')}</span></td>
                    <td><StatusPill text={b.payment} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tab === 'passengerList' && <div className="no-data">{tx('Fictional passenger list placeholder. Production fields and permissions must be confirmed by ATCO.')}</div>}
        {tab === 'invoices' && <div className="no-data">{tx('Invoice previews are fictional. VAT treatment, numbering and ZATCA requirements require ATCO Finance confirmation.')}</div>}
        {tab === 'po' && (
          <div className="field" style={{ maxWidth: 440 }}>
            <label htmlFor="po-ref">{t('po')}</label>
            <input id="po-ref" placeholder="PO-DEMO-0001" />
            <small>{tx('Demonstration field only; no purchase order is created.')}</small>
            <button type="button" className="btn btn-outline" style={{ marginTop: 8 }} onClick={() => toast('PO reference stored in UI only.')}>{tx('Save demo reference')}</button>
          </div>
        )}
        {tab === 'settlements' && (
          <div className="no-data">{tx(isAgent ? 'Agent statement placeholders are limited to the assigned demo scope.' : 'No approved commission rule or settlement schedule has been configured.')}</div>
        )}
      </div>
    </>
  );
}
