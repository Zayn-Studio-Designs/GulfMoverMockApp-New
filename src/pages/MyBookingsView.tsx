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
import { QRCodeTicket } from '../components/QRCodeTicket';
import type { Lang } from '../i18n/translations';
import { WalletAddSheet, WalletPassSheet } from '../components/wallet/WalletSheets';
import { DeviceWalletButton, useHostDevice } from '../components/wallet/WalletHostBridge';
import { useTicketIndex, type TicketEntry } from '../hooks/useTicketIndex';
import { toCsv, downloadCsv } from '../domain/csv';

export default function MyBookingsView() {
  const { t, tx, lang } = useLanguage();
  const { bookings } = useDemo();
  const { isCustomer } = useWorkMode();
  const { toast, openModal } = useUi();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [detailRef, setDetailRef] = useState<string | null>(null);
  const [addPassTicket, setAddPassTicket] = useState<TicketEntry | null>(null);
  const [openPassTicket, setOpenPassTicket] = useState<TicketEntry | null>(null);

  const boatName = (id?: string) => BOATS.find(b => b.id === id)?.name[lang];

  const filtered = bookings.filter(b =>
    (!search || b.ref.toLowerCase().includes(search.toLowerCase())) &&
    (statusFilter === 'all' || b.payment.toLowerCase().includes(statusFilter)));
  const detail = bookings.find(b => b.ref === detailRef);
  const { entries } = useTicketIndex(bookings);
  const detailEntries = entries.filter(e => detail && e.booking.ref === detail.ref);
  const savedTicketIds = new Set(useDemo().passes.map(p => p.ticketId));

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
        <>
        <div className="between" style={{ marginTop: 14, flexWrap: 'wrap' }}>
          <span className="small muted">{tx('Fictional data only · status dimensions shown separately.')}</span>
          <button type="button" className="btn btn-outline btn-small"
            onClick={() => { if (downloadCsv('gulf-mover-demo-bookings.csv', toCsv(
              ['Booking ref', 'Date', 'Time', 'Leg', 'Boat', 'Passengers', 'Amount', 'Payment', 'Threshold', 'Ops', 'Boarding', 'PO'],
              filtered.map(b => [b.ref, b.date, b.time, b.leg, b.boatId ?? '', b.passengers, b.amount, b.payment, b.threshold, b.ops, b.boarding, b.po ?? ''])))) toast(tx('Export downloads the current demo data only.')); }}>
            {t('exportBookings')}
          </button>
        </div>
        <div className="table-wrap" style={{ marginTop: 10 }}>
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
        </>
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
            <div className="inset" style={{ marginTop: 14 }}>
              <strong>{t('corpContact')}</strong>
              <p className="small muted">{detail.bookingContact || '—'}{detail.po && <> · {t('poLabel')}: <span className="mono">{detail.po}</span></>}</p>
            </div>
            {detailEntries.length > 0 && (
              <div className="inset" style={{ marginTop: 14 }}>
                <strong>{t('ticketsQrTitle')}</strong>
                <div className="ticket-qr-grid">
                  {detailEntries.map(e => <TicketDetailRow key={e.ticket.id} entry={e} saved={savedTicketIds.has(e.ticket.id)}
                    t={t} lang={lang}
                    onAdd={() => setAddPassTicket(e)} onOpen={() => setOpenPassTicket(e)} />)}
                </div>
                <p className="small muted">{t('ticketsQrNote')}</p>
              </div>
            )}
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-outline btn-small" onClick={() => requestAction('amend')}>{t('requestAmend')}</button>
              <button type="button" className="btn btn-outline btn-small" onClick={() => requestAction('refund')}>{t('requestRefund')}</button>
            </div>
          </div>
        )}
      </div>
      {addPassTicket && <WalletAddSheet entry={addPassTicket} onClose={() => setAddPassTicket(null)} />}
      {openPassTicket && <WalletPassSheet entry={openPassTicket} onClose={() => setOpenPassTicket(null)} />}
    </>
  );
}

/** One ticket row in the booking detail: real QR, live boarding state, Wallet actions. */
function TicketDetailRow({ entry, saved, t, lang, onAdd, onOpen }: {
  entry: TicketEntry; saved: boolean; t: (k: string) => string; lang: Lang; onAdd: () => void; onOpen: () => void;
}) {
  const legTicket = entry.booking.tickets?.find(tk => tk.id === entry.ticket.id);
  // Inside the mock iPhone / Android the device's own Wallet takes over; elsewhere the site's sheet.
  const device = useHostDevice();
  const onPhone = device === 'iphone' || device === 'android';
  return (
    <div className="ticket-qr-card">
      <QRCodeTicket ticketId={entry.ticket.id} size={110} />
      <div className="ticket-qr-body">
        <strong>{entry.leg === 'return' ? t('returnLeg') : t('outboundLeg')}
          <span className="tiny muted"> · {entry.legDate} · <span className="mono">{formatTime(entry.legTime, lang)}</span></span>
        </strong>
        <div className="tiny muted">{legTicket?.passengerName || entry.ticket.passengerName} · <span className="mono">{entry.ticket.id}</span></div>
        <span className={`pill tiny ${entry.ticket.status === 'boarded' ? 'pill-green' : 'pill-gold'}`}>
          {entry.ticket.status === 'boarded' ? t('ticketBoarded') : t('ticketNotBoarded')}
        </span>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {onPhone
          ? <DeviceWalletButton entry={entry} saved={saved} />
          : saved
            ? <button type="button" className="btn btn-outline btn-small" onClick={onOpen}>{t('walletOpenSaved')}</button>
            : <button type="button" className="btn btn-primary btn-small" onClick={onAdd}>{t('walletAdd')}</button>}
      </div>
    </div>
  );
}
