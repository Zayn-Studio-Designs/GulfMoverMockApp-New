// Saudi-local calendar helpers (Phase 5).
// The demo's operating dates follow the client's Saudi local calendar (Asia/Riyadh),
// not the computer's UTC date. Saudi Arabia has no daylight saving and is at UTC+3.

const SAUDI_TZ = 'Asia/Riyadh';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: SAUDI_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: SAUDI_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function saudiParts(now: Date): { year: number; month: number; day: number } {
  const parts = dateFmt.formatToParts(now);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Today's Saudi-local calendar date as YYYY-MM-DD (never the computer's UTC date). */
export function saudiLocalDate(now: Date = new Date()): string {
  const { year, month, day } = saudiParts(now);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The next Saudi-local calendar date. Noon Saudi time is used as a pivot so the
 * result stays inside the following Riyadh day (the zone has no DST).
 */
export function saudiLocalTomorrow(now: Date = new Date()): string {
  const { year, month, day } = saudiParts(now);
  const noonSaudiAsUtc = Date.UTC(year, month - 1, day, 9, 0, 0); // 12:00 Saudi == 09:00 UTC
  const next = new Date(noonSaudiAsUtc + 24 * 60 * 60 * 1000);
  return saudiLocalDate(next);
}

/** HH:MM in Saudi local time, for audit stamps. */
export function saudiLocalTime(now: Date = new Date()): string {
  const t = timeFmt.format(now);
  return t.startsWith('24') ? `00${t.slice(2)}` : t;
}

/** Verifies a YYYY-MM-DD string; used by admin schedule validation. */
export function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Validates an HH:MM 24-hour departure time. */
export function isValidTime(value: string): boolean {
  // Two capture groups: hours AND minutes (the minutes group was missing, so every time failed).
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return false;
  return Number(m[1]) < 24 && Number(m[2]) < 60;
}

/**
 * Phase 3: Saudi-local date + HH:MM (as entered by ATCO staff) → an absolute ISO instant.
 * Saudi Arabia is UTC+3 with no daylight saving, so the offset is fixed.
 */
export function saudiDateTimeToIso(date: string, time: string): string | null {
  if (!isValidDateString(date) || !isValidTime(time)) return null;
  return new Date(`${date}T${time}:00+03:00`).toISOString();
}

/** An ISO instant → its Saudi-local calendar date and HH:MM time (for display and edit forms). */
export function saudiDateTimeParts(iso: string): { date: string; time: string } {
  const at = new Date(iso);
  return { date: saudiLocalDate(at), time: saudiLocalTime(at) };
}
