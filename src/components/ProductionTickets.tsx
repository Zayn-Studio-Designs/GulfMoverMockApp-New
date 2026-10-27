import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useLanguage } from '../context/LanguageContext';
import { getTicketQr, listBookingTickets, type Ticket } from '../lib/ticketService';
import { dataErrorKey } from './ProductionUi';
import type { Booking } from '../lib/bookingService';

function TicketCard({ ticket, booking }: { ticket: Ticket; booking: Booking }) {
  const { t } = useLanguage();
  const [qr, setQr] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const leg = booking.legs.find(l => l.sailing?.id === ticket.sailingId);
  async function showQr() {
    if (busy) return;
    setBusy(true); setError('');
    try { setQr(await getTicketQr(ticket.id)); } catch (e) { setError(dataErrorKey(e)); } finally { setBusy(false); }
  }
  return <article className="inset" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <h3 className="card-title mono">{ticket.reference}</h3>
    <p>{t(leg?.leg === 'return' ? 'pbReturn' : 'pbOutbound')} · {leg?.sailing?.origin} → {leg?.sailing?.destination}</p>
    <p>{t('ticketPassenger')} {ticket.passengerIndex}: {ticket.passengerName || t('p4NameNotCollected')}</p>
    <p role="status">{t(`p4Ticket_${ticket.status}`)}</p>
    {error && <p role="alert">{t(error)}</p>}
    {!qr && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void showQr()}>{t(busy ? 'p4Loading' : 'p4ShowQr')}</button>}
    {qr && <div><QRCodeSVG value={qr} size={160} marginSize={4} title={t('p4QrLabel')} /><p className="small">{t('p4QrPrivacy')}</p></div>}
  </article>;
}
export function ProductionTickets({ booking }: { booking: Booking }) {
  const { t } = useLanguage();
  const [tickets, setTickets] = useState<Ticket[] | null>(null); const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true; setTickets(null); setError('');
    void listBookingTickets(booking.id).then(data => { if (active) setTickets(data); })
      .catch(e => { if (active) setError(dataErrorKey(e)); });
    return () => { active = false; };
  }, [booking.id, revision]);
  return <section className="card card-pad" style={{ marginTop: 16 }} aria-labelledby="p4-tickets">
    <div className="between"><h2 id="p4-tickets" className="card-title">{t('p4Tickets')}</h2>
      <button type="button" className="btn btn-outline" onClick={() => setRevision(v => v + 1)}>{t('pbRefresh')}</button></div>
    <p className="notice warn">{t('p4TicketNotice')}</p>
    {error && <p role="alert">{t(error)}</p>}
    {!error && tickets === null && <p role="status">{t('p4Loading')}</p>}
    {tickets?.length === 0 && <p>{t('p4NoTickets')}</p>}
    <div className="grid" style={{ gap: 12 }}>{tickets?.map(ticket => <TicketCard key={ticket.id} ticket={ticket} booking={booking} />)}</div>
  </section>;
}
