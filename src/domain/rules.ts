// Business rules from the client brief (see CLAUDE.md). Kept pure so they can be unit tested.

/** Initial brief fare: SAR 500 per passenger per one-way leg. VAT is not calculated (pending ATCO). */
export const FARE_PER_PASSENGER_LEG = 500;

/** Minimum sailing: four eligible tickets across ALL bookings for the same sailing. */
export const MINIMUM_TICKETS_PER_SAILING = 4;

/** Initial departures (Saudi local time), proposed and editable by ATCO. */
export const DEPARTURE_TIMES = ['07:00', '09:30', '13:00'] as const;

export function legCount(addReturn: boolean): number {
  return addReturn ? 2 : 1;
}

export function fareTotal(passengers: number, addReturn: boolean): number {
  return Math.max(1, Number(passengers) || 1) * FARE_PER_PASSENGER_LEG * legCount(addReturn);
}

/** Eligible tickets for a sailing, summed across every booking on it. */
export function eligibleTickets(bookingPassengerCounts: number[]): number {
  return bookingPassengerCounts.reduce((sum, n) => sum + n, 0);
}

export function isMinimumMet(ticketsAcrossBookings: number): boolean {
  return ticketsAcrossBookings >= MINIMUM_TICKETS_PER_SAILING;
}

export function thresholdLabel(ticketsAcrossBookings: number): string {
  return isMinimumMet(ticketsAcrossBookings) ? 'Minimum met (demo)' : 'Collecting bookings';
}

export type PillTone = 'pill-neutral' | 'pill-green' | 'pill-gold' | 'pill-red';

/** Status colour, always paired with the status text (never colour alone). */
export function pillTone(text: string): PillTone {
  let tone: PillTone = 'pill-neutral';
  if (/met|recorded|boarded|approved|booked|available/i.test(text) && !/pending/i.test(text)) tone = 'pill-green';
  if (/pending|collecting|preparation|review|awaiting|not ready/i.test(text)) tone = 'pill-gold';
  if (/suspend|failed|rejected|duplicate|taken|chartered/i.test(text)) tone = 'pill-red';
  return tone;
}
