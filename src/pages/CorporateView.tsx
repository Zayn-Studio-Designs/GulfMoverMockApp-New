import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';
import { useUi } from '../context/UiContext';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { formatTime } from '../domain/fleet';

const TABS = ['overview', 'bookings', 'passengerList', 'invoices', 'po', 'settlements'] as const;
type Tab = typeof TABS[number];

export default function CorporateView() {
  const { t, tx, lang } = useLanguage();
  const { bookings, updateWizard } = useDemo();
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
                    <td data-label={t('bookingRef')} className="mono">{b.ref}</td>
                    <td data-label={tx('Client scope')}>{isAgent ? tx('Assigned demo client') : t('corpOrg')}</td>
                    <td data-label={t('leg')}>{tx(b.leg)} · {formatTime(b.time, lang)}</td>
                    <td data-label={t('amount')}>SAR {b.amount} <span className="tiny muted">{tx('demo')}</span></td>
                    <td data-label={t('status')}><StatusPill text={b.payment} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tab === 'passengerList' && <div className="no-data">{tx('Fictional passenger list placeholder. Production fields and permissions must be confirmed by ATCO.')}</div>}
        {tab === 'invoices' && <div className="no-data">{tx('Invoice previews are fictional. VAT treatment, numbering and ZATCA requirements require ATCO Finance confirmation.')}</div>}
        {tab === 'po' && <PoTab />}
        {tab === 'settlements' && (
          <div className="no-data">{tx(isAgent ? 'Agent statement placeholders are limited to the assigned demo scope.' : 'No approved commission rule or settlement schedule has been configured.')}</div>
        )}
      </div>
    </>
  );
}

/** PO tab: saves the demo PO reference onto a real demo booking so later screens show it. */
function PoTab() {
  const { t, tx } = useLanguage();
  const { bookings, setBookingPo } = useDemo();
  const { toast } = useUi();
  const [ref, setRef] = useState(bookings[0]?.ref ?? '');
  const [po, setPo] = useState('');
  const save = () => {
    if (!ref || !po.trim()) return;
    setBookingPo(ref, po);
    setPo('');
    toast(t('corpPoSaved'));
  };
  const selected = bookings.find(b => b.ref === ref);
  return (
    <div className="field" style={{ maxWidth: 440 }}>
      <label htmlFor="po-booking">{t('bookingRef')}</label>
      <select id="po-booking" value={ref} onChange={e => setRef(e.target.value)}>
        {bookings.map(b => <option key={b.ref} value={b.ref}>{b.ref}{b.po ? ` · ${b.po}` : ''}</option>)}
      </select>
      {selected && selected.po && <small>{tx('Saved PO (demo)')}: <span className="mono">{selected.po}</span></small>}
      <label htmlFor="po-ref" style={{ marginTop: 10 }}>{t('po')}</label>
      <input id="po-ref" placeholder="PO-DEMO-0001" value={po} onChange={e => setPo(e.target.value)} />
      <small>{tx('Demonstration field only; no purchase order is created.')}</small>
      <button type="button" className="btn btn-outline" style={{ marginTop: 8 }} onClick={save}>{t('saveChanges')}</button>
    </div>
  );
}
