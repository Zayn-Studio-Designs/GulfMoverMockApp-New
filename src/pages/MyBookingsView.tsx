import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';
import { useWorkMode } from '../context/WorkModeContext';
import { useUi } from '../context/UiContext';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { ArrowIcon, Icon } from '../components/Icon';
import { formatTime } from '../domain/fleet';
import { BOATS } from '../data/demoData';

export default function MyBookingsView() {
  const { t, tx, lang } = useLanguage();
  const { bookings } = useDemo();
  const { isCustomer } = useWorkMode();
  const { toast, openModal } = useUi();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [detailRef, setDetailRef] = useState<string | null>(null);

  const boatName = (id?: string) => BOATS.find(b => b.id === id)?.name[lang];

  const filtered = bookings.filter(b =>
    (!search || b.ref.toLowerCase().includes(search.toLowerCase())) &&
    (statusFilter === 'all' || b.payment.toLowerCase().includes(statusFilter)));
  const detail = bookings.find(b => b.ref === detailRef);

  const requestAction = (type: 'amend' | 'refund') => openModal({
    title: type === 'refund' ? t('requestRefund') : t('requestAmend'), desc: t('requestReceived'), confirmText: t('confirm'),
    requireReason: true, onConfirm: () => toast(t('requestReceived')),
  });

  return (
    <>
      <PageHeader titleKey="bookingsTitle" subKey="bookingsSub" />
      <div className="card card-pad">
        <div className="between" style={{ flexWrap: 'wrap' }}>
          <div><h2 className="card-title">{t('bookingsTitle')}</h2><p className="card-desc">{isCustomer ? t('bookingsCustSub') : tx('Fictional data only · status dimensions shown separately.')}</p></div>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/book')}>{t('start')} <ArrowIcon /></button>
        </div>
        <div className="form-grid" style={{ marginTop: 16 }}>
          <div className="field">
            <label htmlFor="booking-search">{t('searchRef')}</label>
            <input id="booking-search" value={search} placeholder="GM-DEMO-…" onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="booking-status-filter">{t('status')}</label>
            <select id="booking-status-filter" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="all">{t('allStatuses')}</option>
              <option value="payment recorded">{tx('Payment recorded')}</option>
              <option value="pending">{t('pending')}</option>
              <option value="failed">{tx('Failed / uncertain')}</option>
            </select>
          </div>
        </div>
        {isCustomer ? (
          <div className="booking-cards" role="list">
            {filtered.map((b, i) => (
              <div key={b.ref} className="booking-card" role="listitem" data-tour={i === 0 ? 'booking-card' : undefined}>
                <div className="between">
                  <strong className="mono">{b.ref}</strong>
                  <StatusPill text={b.payment} />
                </div>
                <div className="booking-card-route">
                  <span>{b.date} · <b className="mono">{formatTime(b.time, lang)}</b> · {tx(b.leg)}</span>
                  <span className="small muted">{tx(b.dest)}{b.boatId && <> · {boatName(b.boatId)}</>}</span>
                  <span className="small muted">{b.passengers} × {t('perPassenger')} · SAR {Number(b.amount).toLocaleString('en-US')}</span>
                </div>
                <div className="between">
                  <StatusPill text={b.ops} />
                  <button type="button" className="link-btn" onClick={() => setDetailRef(b.ref)}>{t('view')}</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
        <div className="table-wrap" style={{ marginTop: 17 }}>
          <table>
            <thead><tr>
              <th>{t('bookingRef')}</th><th>{t('date')}</th><th>{t('leg')}</th><th>{t('amount')}</th>
              <th>{t('paymentStatus')}</th><th>{t('opsStatus')}</th><th>{t('actions')}</th>
            </tr></thead>
            <tbody>
              {filtered.map(b => (
                <tr key={b.ref}>
                  <td data-label={t('bookingRef')}><strong className="mono">{b.ref}</strong><div className="tiny muted">{tx(b.service)}</div></td>
                  <td data-label={t('date')}>{b.date}</td>
                  <td data-label={t('leg')}>{tx(b.leg)} · <span className="mono">{formatTime(b.time, lang)}</span></td>
                  <td data-label={t('amount')}><strong>SAR {Number(b.amount).toLocaleString('en-US')}</strong><div className="tiny muted">{tx('VAT treatment pending')}</div></td>
                  <td data-label={t('paymentStatus')}><StatusPill text={b.payment} /></td>
                  <td data-label={t('opsStatus')}><StatusPill text={b.ops} /></td>
                  <td data-label={t('actions')}><button type="button" className="link-btn" onClick={() => setDetailRef(b.ref)}>{t('view')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
        {filtered.length === 0 && <div className="empty"><div className="icon"><Icon name="search" /></div><strong>{t('noBookings')}</strong></div>}
      </div>
      <div style={{ marginTop: 16 }}>
        {detail && (
          <div className="card card-pad">
            <div className="between">
              <div><div className="eyebrow">{tx('BOOKING DETAIL / DEMO')}</div><h2 className="card-title mono">{detail.ref}</h2></div>
              <button type="button" className="btn btn-outline btn-small" onClick={() => setDetailRef(null)}>{tx('Close')}</button>
            </div>
            {isCustomer && (
              <div className="notice" style={{ marginTop: 14 }} role="status">
                <strong>{t('detailNextTitle')}</strong>
                <ul className="detail-next">
                  <li>{t('detailNextPayment')}</li>
                  <li>{t('detailNextOps')}</li>
                  <li>{t('detailNextBoarding')}</li>
                </ul>
              </div>
            )}
            <div className="status-grid" style={{ marginTop: 14 }}>
              {([['paymentStatus', detail.payment], ['thresholdStatus', detail.threshold], ['opsStatus', detail.ops], ['boardingStatus', detail.boarding]] as const).map(([label, val]) => (
                <div key={label} className="status-item"><div className="status-label">{t(label)}</div><div className="status-text">{tx(val)}</div></div>
              ))}
            </div>
            <div className="divider" />
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-outline btn-small" onClick={() => toast('Ticket is a decorative placeholder in this prototype.')}>{t('ticket')}</button>
              <button type="button" className="btn btn-outline btn-small" onClick={() => requestAction('amend')}>{t('requestAmend')}</button>
              <button type="button" className="btn btn-outline btn-small" onClick={() => requestAction('refund')}>{t('requestRefund')}</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
