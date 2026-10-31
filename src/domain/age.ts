/**
 * Age of consent for using Gulf Mover: a person must be at least
 * {@link MINIMUM_AGE} years old to create an account or sign in.
 *
 * Ages are counted in Saudi local time (Asia/Riyadh), so a birthday starts at
 * local midnight regardless of the device's time zone. The date of birth is
 * only used for this check; it is never stored or sent anywhere.
 */
export const MINIMUM_AGE = 18;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's calendar date in Saudi local time, as YYYY-MM-DD. */
export function todayInRiyadh(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function parseIsoDate(value: string): { y: number; m: number; d: number } | null {
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  // Rejects impossible dates such as 2001-02-30 (Date would silently roll them over).
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Whole years from `dateOfBirth` to `today` (both YYYY-MM-DD), or null when either is not a real date. */
export function ageOn(dateOfBirth: string, today: string): number | null {
  const dob = parseIsoDate(dateOfBirth);
  const now = parseIsoDate(today);
  if (!dob || !now) return null;
  const hadBirthday = now.m > dob.m || (now.m === dob.m && now.d >= dob.d);
  return now.y - dob.y - (hadBirthday ? 0 : 1);
}

export type DateOfBirthCheck = 'ok' | 'invalid' | 'under-age';

/**
 * Validates a date of birth for account creation: it must be a real date, not
 * in the future and not implausibly old, and the person must be at least
 * {@link MINIMUM_AGE} today (Saudi local time).
 */
export function checkDateOfBirth(dateOfBirth: string, now: Date = new Date()): DateOfBirthCheck {
  const age = ageOn(dateOfBirth, todayInRiyadh(now));
  if (age === null || age < 0 || age > 120) return 'invalid';
  return age >= MINIMUM_AGE ? 'ok' : 'under-age';
}

/** Latest date of birth that is old enough today — used as the date picker's `max`. */
export function latestEligibleDateOfBirth(now: Date = new Date()): string {
  const today = parseIsoDate(todayInRiyadh(now))!;
  const y = today.y - MINIMUM_AGE;
  // 29 Feb in a non-leap target year: the 28th is the last date that is already 18.
  const lastDay = new Date(Date.UTC(y, today.m, 0)).getUTCDate();
  return `${y}-${String(today.m).padStart(2, '0')}-${String(Math.min(today.d, lastDay)).padStart(2, '0')}`;
}
