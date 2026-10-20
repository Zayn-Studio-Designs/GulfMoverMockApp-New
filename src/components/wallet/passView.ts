import { BOATS, ORIGIN, type Booking } from '../../data/demoData';
import type { Lang } from '../../i18n/translations';
import { formatTime } from '../../domain/fleet';
import type { Ticket } from '../../domain/tickets';
import type { TicketEntry } from '../../hooks/useTicketIndex';
import type { PassView } from '../../presentation/walletProtocol';

/** Status on a pass, from the *live* ticket and payment state (never a stored copy). */
export function passStatusKind(ticket: Ticket, payment: string): PassView['statusKind'] {
  if (/failed/i.test(payment)) return 'blocked';
  return ticket.status === 'boarded' ? 'boarded' : 'valid';
}

const STATUS_KEY: Record<PassView['statusKind'], string> = { blocked: 'passNotEligible', boarded: 'passBoardedShort', valid: 'passValid' };

/** Route, date, time and boat for one leg: the return leg runs the other way on its own sailing. */
export function legDetails(booking: Booking, leg: 'outbound' | 'return', lang: Lang, tx: (s: string) => string, legDate?: string) {
  const isReturn = leg === 'return';
  return {
    from: isReturn ? tx(booking.dest) : tx(ORIGIN),
    to: isReturn ? tx(ORIGIN) : tx(booking.dest),
    time: isReturn ? booking.return?.time ?? booking.time : booking.time,
    date: legDate ?? (isReturn ? booking.return?.date ?? booking.date : booking.date),
    boat: BOATS.find(b => b.id === (isReturn ? booking.return?.boatId ?? booking.boatId : booking.boatId))?.name[lang],
  };
}

/** Display-ready pass for one ticket, built from the same demo data as the app's ticket screens. */
export function buildPassView(entry: TicketEntry, t: (k: string) => string, tx: (s: string) => string, lang: Lang, saved: boolean): PassView {
  const d = legDetails(entry.booking, entry.leg, lang, tx, entry.legDate);
  const statusKind = passStatusKind(entry.ticket, entry.booking.payment);
  return {
    ticketId: entry.ticket.id,
    ref: entry.booking.ref,
    leg: entry.leg,
    legLabel: entry.leg === 'return' ? t('ticketRet') : t('ticketOut'),
    from: d.from,
    to: d.to,
    date: d.date,
    time: formatTime(d.time, lang),
    boat: d.boat,
    passenger: entry.ticket.passengerName || t('notProvided'),
    statusKind,
    statusLabel: t(STATUS_KEY[statusKind]),
    saved,
  };
}
