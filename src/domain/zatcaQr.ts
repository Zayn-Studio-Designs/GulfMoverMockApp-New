/**
 * ZATCA Phase-1 style QR payload: TLV (tag, length, UTF-8 value) of
 *   1 seller name, 2 VAT registration number, 3 timestamp, 4 invoice total (incl. VAT), 5 VAT total
 * then Base64. Phase 2 adds cryptographic tags (hash, signature, public key, stamp)
 * which require a ZATCA-issued CSID — not available here. This module mirrors the
 * database function public.zatca_qr_tlv so the two can be cross-checked in tests.
 * Producing this payload is NOT a claim of ZATCA compliance.
 */
export interface ZatcaQrFields {
  readonly sellerName: string;
  readonly vatNumber: string;
  readonly timestamp: string; // ISO 8601, e.g. 2026-11-01T09:30:00Z
  readonly totalWithVat: string; // "1150.00"
  readonly vatTotal: string; // "150.00"
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function tlv(tag: number, value: string): Uint8Array {
  const bytes = encoder.encode(value);
  if (bytes.length > 255) throw new RangeError('TLV value too long');
  const out = new Uint8Array(2 + bytes.length);
  out[0] = tag; out[1] = bytes.length; out.set(bytes, 2);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

export function encodeZatcaQr(fields: ZatcaQrFields): string {
  const parts = [tlv(1, fields.sellerName), tlv(2, fields.vatNumber), tlv(3, fields.timestamp), tlv(4, fields.totalWithVat), tlv(5, fields.vatTotal)];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { all.set(p, offset); offset += p.length; }
  return toBase64(all);
}

export function decodeZatcaQr(base64: string): Record<number, string> {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const out: Record<number, string> = {};
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i]; const len = bytes[i + 1];
    if (len === undefined || i + 2 + len > bytes.length) throw new RangeError('malformed TLV');
    out[tag] = decoder.decode(bytes.slice(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return out;
}
