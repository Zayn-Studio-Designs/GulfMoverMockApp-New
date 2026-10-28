/**
 * Exact SAR money handling for the UI. Amounts are integer halala (1 SAR = 100
 * halala) end to end; the browser only formats values the server computed and
 * never sends amounts back.
 */
export const HALALA_PER_SAR = 100;

export function assertHalala(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new RangeError('amount must be integer halala');
  return value;
}

/** 123456 → "1,234.56" (Latin digits, fixed two decimals). */
export function formatHalala(halala: number): string {
  assertHalala(halala);
  const negative = halala < 0;
  const abs = Math.abs(halala);
  const whole = Math.floor(abs / HALALA_PER_SAR).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${whole}.${String(abs % HALALA_PER_SAR).padStart(2, '0')}`;
}

export function formatSar(halala: number, lang: 'en' | 'ar' = 'en'): string {
  return lang === 'ar' ? `${formatHalala(halala)} ر.س` : `SAR ${formatHalala(halala)}`;
}

/** For CSV: plain decimal without grouping, e.g. "1234.56". */
export function halalaToCsvDecimal(halala: number): string {
  return formatHalala(halala).replace(/,/g, '');
}
