import type { ReactElement } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { Icon } from '../Icon';
import { QRCodeTicket } from '../QRCodeTicket';
import type { Booking } from '../../data/demoData';
import { formatTime } from '../../domain/fleet';
import type { Ticket } from '../../domain/tickets';
import { legDetails, passStatusKind } from './passView';

/**
 * Visual pass content shared by the add-preview, the saved-pass view and the
 * side-button simulation. Status text is resolved from the *live* ticket state
 * each render, so a saved pass can never show a stale copied status.
 */
export function WalletPassVisual({ booking, leg, ticket, legDate }: {
  booking: Booking;
  leg: 'outbound' | 'return';
  ticket: Ticket;
  legDate?: string;
}) {
  const { t, tx, lang } = useLanguage();
  const { from, to, time, date, boat } = legDetails(booking, leg, lang, tx, legDate);
  const status = passStatus(t, passStatusKind(ticket, booking.payment));
  return (
    <div className="pass-card" dir="ltr">
      <div className="pass-top">
        <div className="pass-brand">
          <span className="pass-brand-dot" aria-hidden="true">GM</span>
          <span className="pass-brand-name">GULF MOVER</span>
        </div>
        <span className="pass-kind">MARINE TAXI · {t('demoOnly')}</span>
      </div>
      <div className="pass-strip" aria-hidden="true" />
      <div className="pass-body">
        <div className="pass-route">
          <span className="pt">{from}</span>
          <span className="pa"><Icon name="arrow" /></span>
          <span className="pt">{to}</span>
        </div>
        <div className="pass-when">
          <span className="pass-date">{date}</span>
          <span className="pass-time mono">{formatTime(time, lang)}</span>
          <span className="pass-legtag">{leg === 'outbound' ? t('ticketOut') : t('ticketRet')}</span>
        </div>
        <div className="pass-rows">
          <div>{t('passengerName')}: <b>{ticket.passengerName || t('notProvided')}</b></div>
          <div>{t('bookingRef')}: <b className="mono">{booking.ref}</b></div>
          {boat && <div>{t('boat')}: <b>{boat}</b></div>}
          <div style={{ marginTop: 5 }}>{status}</div>
        </div>
      </div>
      <div className="pass-qr">
        <QRCodeTicket ticketId={ticket.id} size={148} />
      </div>
      <p className="pass-note">ATCO MARINE demo pass — simulated only; not installed in the real Apple Wallet.</p>
    </div>
  );
}

type StatusChip = { className: string; label: string };

/** Status chip shown on the pass, resolved from the live ticket/payment state. */
function passStatus(t: (k: string) => string, kind: ReturnType<typeof passStatusKind>): ReactElement {
  const chip: StatusChip = kind === 'blocked'
    ? { className: 'blocked', label: t('passNotEligible') }
    : kind === 'boarded'
      ? { className: 'boarded', label: t('passBoardedShort') }
      : { className: 'wait', label: t('passValid') };
  return <span className={`pass-status ${chip.className}`}>{chip.label}</span>;
}
