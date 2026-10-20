import { useMemo } from 'react';
import type { Booking } from '../data/demoData';
import type { Ticket, TicketLeg } from '../domain/tickets';
import { parseScanPayload } from '../domain/tickets';

export interface TicketEntry {
  ticket: Ticket;
  booking: Booking;
  /** Which leg this ticket is for, resolved from the booking. */
  leg: TicketLeg;
  legDate: string;
  legTime: string;
}

/**
 * Flattens demo bookings into per-ticket entries and keeps a scan-value index,
 * so the boarding desk can look a ticket up by QR payload, ticket ID or
 * booking reference without duplicating parsing logic in the view.
 */
export function useTicketIndex(bookings: Booking[]) {
  return useMemo(() => {
    const entries: TicketEntry[] = [];
    const byPayload = new Map<string, TicketEntry>();
    const byRef = new Map<string, Booking>();
    for (const booking of bookings) {
      byRef.set(booking.ref.toUpperCase(), booking);
      for (const ticket of booking.tickets ?? []) {
        const isReturn = ticket.leg === 'return';
        const legDate = isReturn ? booking.return?.date ?? booking.date : booking.date;
        const legTime = isReturn ? booking.return?.time ?? booking.time : booking.time;
        const entry: TicketEntry = { ticket, booking, leg: ticket.leg, legDate, legTime };
        entries.push(entry);
        byPayload.set(ticket.id.toUpperCase(), entry);
      }
    }
    /** Resolves a scanned value, a raw ticket ID or a booking reference. */
    const resolve = (query: string): { entry: TicketEntry | null; bookingOnly: Booking | null; payloadId: string | null } => {
      const raw = query.trim().toUpperCase();
      if (!raw) return { entry: null, bookingOnly: null, payloadId: null };
      const payloadId = parseScanPayload(raw)?.toUpperCase() ?? null;
      if (payloadId && byPayload.has(payloadId)) return { entry: byPayload.get(payloadId)!, bookingOnly: null, payloadId };
      if (byPayload.has(raw)) return { entry: byPayload.get(raw)!, bookingOnly: null, payloadId: raw };
      const booking = byRef.get(raw) ?? null;
      return { entry: null, bookingOnly: booking, payloadId };
    };
    return { entries, resolve };
  }, [bookings]);
}
