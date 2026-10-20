// Boat availability and departure time slots.
// A boat on a given date and time slot is either free, carrying a shared scheduled sailing
// (other passengers may still join), or chartered (taken — nobody else can book it).

import type { Lang } from '../i18n/translations';

/** Departure slots every hour around the clock, plus the brief's 09:30 departure. */
export const TIME_SLOTS: readonly string[] = (() => {
  const slots: string[] = [];
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0');
    slots.push(`${hh}:00`);
    if (h === 9) slots.push('09:30');
  }
  return slots;
})();

/** Initial departure times named in the client brief (editable by ATCO). */
export const BRIEF_TIMES: readonly string[] = ['07:00', '09:30', '13:00'];

/** '13:00' → '1:00 PM' (English) or '1:00 م' (Arabic). Times are Saudi local time. */
export function formatTime(time: string, lang: Lang = 'en'): string {
  const [hStr, m = '00'] = time.split(':');
  const h = Number(hStr);
  if (Number.isNaN(h)) return time;
  const am = h < 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = lang === 'ar' ? (am ? 'ص' : 'م') : (am ? 'AM' : 'PM');
  return `${h12}:${m} ${suffix}`;
}

export type SlotKind = 'scheduled' | 'charter';

export interface BoatSlot {
  id: string;
  boatId: string;
  date: string;
  time: string;
  kind: SlotKind;
  passengers: number;
  refs: string[];
  holder: string;
  status: string;
}

export type Availability = 'free' | 'shared' | 'chartered';

export function findSlot(slots: BoatSlot[], boatId: string, date: string, time: string): BoatSlot | undefined {
  return slots.find(s => s.boatId === boatId && s.date === date && s.time === time);
}

export function boatAvailability(slots: BoatSlot[], boatId: string, date: string, time: string): Availability {
  const slot = findSlot(slots, boatId, date, time);
  if (!slot) return 'free';
  return slot.kind === 'charter' ? 'chartered' : 'shared';
}

/** Passengers can join a free boat or a shared scheduled sailing, never a chartered boat. */
export function canBookPassengers(av: Availability): boolean {
  return av !== 'chartered';
}

/** A charter takes the whole boat, so it needs the boat completely free for that slot. */
export function canCharter(av: Availability): boolean {
  return av === 'free';
}

/* Atomic multi-leg reservation (Phase 4).
   Outbound + return must either reserve wholly or not at all: no partially
   reserved outbound leg may be left behind when the return leg fails. */

export interface LegRequest {
  boatId: string;
  date: string;
  time: string;
  passengers: number;
  /** Booking reference recorded on the slot once this leg commits. */
  ref?: string;
}

export type ReservationFailure = 'chartered' | 'capacity';

export interface ReservationPlan {
  ok: boolean;
  /** Index of the first leg that could not be reserved (when not ok). */
  failedLeg: number | null;
  reason: ReservationFailure | null;
  /** Final slot list to commit when ok — identical to the input when not. */
  updatedSlots: BoatSlot[];
}

/**
 * Plans an atomic reservation across one or more legs against a consistent
 * candidate state. Legs are applied one at a time over a working copy, so two
 * requested legs that interact with the same boat/date/time slot see each
 * other. Capacity is checked when demo seats per boat are configured.
 */
export function planReservation(slots: BoatSlot[], legs: LegRequest[], opts: { seatsPerBoat?: Record<string, number | null> } = {}): ReservationPlan {
  const failure = (failedLeg: number, reason: ReservationFailure): ReservationPlan => ({ ok: false, failedLeg, reason, updatedSlots: slots });
  if (legs.length === 0) return { ok: true, failedLeg: null, reason: null, updatedSlots: slots };

  // Work on a deep copy of only the slots we might touch.
  const candidate: BoatSlot[] = slots.map(s => ({ ...s, refs: [...s.refs] }));
  const created: BoatSlot[] = [];
  const seatsFor = (boatId: string): number | null =>
    opts.seatsPerBoat && Object.prototype.hasOwnProperty.call(opts.seatsPerBoat, boatId) ? opts.seatsPerBoat[boatId] ?? null : null;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const pax = Math.max(1, Math.floor(Number(leg.passengers) || 0));
    if (pax <= 0) return failure(i, 'capacity');
    const existing = candidate.find(s => s.boatId === leg.boatId && s.date === leg.date && s.time === leg.time)
      ?? created.find(s => s.boatId === leg.boatId && s.date === leg.date && s.time === leg.time);
    if (existing) {
      if (existing.kind === 'charter') return failure(i, 'chartered');
      const cap = seatsFor(leg.boatId);
      if (cap !== null && existing.passengers + pax > cap) return failure(i, 'capacity');
      existing.passengers += pax;
      if (leg.ref) existing.refs.push(leg.ref);
    } else {
      const cap = seatsFor(leg.boatId);
      if (cap !== null && pax > cap) return failure(i, 'capacity');
      const fresh: BoatSlot = {
        id: `BS-${String(candidate.length + 101)}`,
        boatId: leg.boatId, date: leg.date, time: leg.time, kind: 'scheduled',
        passengers: pax, refs: leg.ref ? [leg.ref] : [], holder: 'Shared scheduled sailing', status: 'Seats booked (demo)',
      };
      created.push(fresh);
    }
  }
  // Created slots must join the committed result — otherwise a fresh leg's
  // reservation is silently dropped and the boat appears free again.
  return { ok: true, failedLeg: null, reason: null, updatedSlots: [...candidate, ...created] };
}
