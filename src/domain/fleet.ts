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
