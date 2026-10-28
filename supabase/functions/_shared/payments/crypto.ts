/** Web Crypto helpers that run unchanged in Deno (edge functions) and Node 22 (tests). */
const encoder = new TextEncoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

export async function sha256Hex(message: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(message)));
}

/** Constant-time comparison for equal-length strings (length leak is acceptable). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Integer halala → "123.45" without floating point. */
export function halalaToDecimal(halala: number): string {
  if (!Number.isSafeInteger(halala) || halala < 0) throw new RangeError('invalid halala amount');
  return `${Math.floor(halala / 100)}.${String(halala % 100).padStart(2, '0')}`;
}

/** "123.45" / 123.45 → 12345 halala; rejects more than two decimals. */
export function decimalToHalala(value: string | number): number {
  const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new RangeError('invalid decimal amount');
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
