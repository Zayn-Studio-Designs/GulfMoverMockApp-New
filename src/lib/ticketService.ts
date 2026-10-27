import type { EnvSource } from './supabase';
import { DataServiceError, requireDataClient, requireSessionUser, run } from './dataService';

export type TicketStatus = 'valid' | 'boarded' | 'cancelled';
export type ReadinessStatus = 'pending' | 'ready' | 'blocked';
export type BoardingOutcome = 'boarded' | 'already_boarded' | 'not_found' | 'wrong_sailing' | 'cancelled' | 'sailing_cancelled' | 'not_ready';
export interface Ticket {
  id: string; reference: string; bookingId: string; sailingId: string;
  passengerIndex: number; passengerName: string | null; status: TicketStatus; boardedAt: string | null;
}
export interface ManifestTicket extends Ticket { bookingReference: string; leg: 'outbound' | 'return' }
export interface ReadinessEvent { id: string; status: ReadinessStatus; reason: string; occurredAt: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /^TK-[0-9A-F]{24}$/;
const QR = /^GMT1:[0-9a-f]{64}$/;
const STATUSES: readonly string[] = ['valid', 'boarded', 'cancelled'];
export function validTicketLookup(value: string): boolean { return REFERENCE.test(value.trim()) || QR.test(value.trim()); }
function uuid(value: string) { if (!UUID.test(value)) throw new DataServiceError('invalid-input'); }
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DataServiceError('unexpected-response');
  return value as Record<string, unknown>;
}
function parseTicket(value: unknown, manifest = false): Ticket {
  const r = row(value); const id = manifest ? r.ticket_id : r.id;
  if (typeof id !== 'string' || typeof r.reference !== 'string' || !REFERENCE.test(r.reference)
    || !STATUSES.includes(String(r.status)) || !Number.isInteger(r.passenger_index)
    || Number(r.passenger_index) < 1 || (r.passenger_name !== null && typeof r.passenger_name !== 'string')
    || (r.boarded_at !== null && typeof r.boarded_at !== 'string')) throw new DataServiceError('unexpected-response');
  return { id, reference: r.reference, bookingId: typeof r.booking_id === 'string' ? r.booking_id : '',
    sailingId: typeof r.sailing_id === 'string' ? r.sailing_id : '', passengerIndex: Number(r.passenger_index),
    passengerName: r.passenger_name as string | null, status: r.status as TicketStatus, boardedAt: r.boarded_at as string | null };
}
function rows(data: unknown): unknown[] {
  if (!Array.isArray(data)) throw new DataServiceError('unexpected-response');
  return data;
}
async function client(env?: EnvSource) { const c = requireDataClient(env); await requireSessionUser(c); return c; }

/** Owner-scoped tickets, restored from the database, never DemoContext. No QR secret in selects. */
export async function listBookingTickets(bookingId: string, env?: EnvSource): Promise<Ticket[]> {
  uuid(bookingId); const c = await client(env);
  const { data } = await run(c.from('tickets').select('id,reference,booking_id,sailing_id,passenger_index,passenger_name,status,boarded_at')
    .eq('booking_id', bookingId).order('passenger_index').limit(2000));
  return rows(data).map(v => parseTicket(v));
}
/** The opaque QR is a bearer-like boarding reference: no PII, logs or browser persistence.
 * Only the booking creator can retrieve it; actual boarding always requires staff authority. */
export async function getTicketQr(ticketId: string, env?: EnvSource): Promise<string> {
  uuid(ticketId); const c = await client(env);
  const { data } = await run(c.rpc('get_ticket_qr', { p_ticket_id: ticketId }));
  if (typeof data !== 'string' || !QR.test(data)) throw new DataServiceError('unexpected-response');
  return data;
}
export async function getTicketManifest(sailingId: string, env?: EnvSource): Promise<ManifestTicket[]> {
  uuid(sailingId); const c = await client(env);
  const { data } = await run(c.rpc('ticket_manifest', { p_sailing_id: sailingId }));
  return rows(data).map(value => {
    const r = row(value);
    if (typeof r.booking_reference !== 'string' || (r.leg !== 'outbound' && r.leg !== 'return')) throw new DataServiceError('unexpected-response');
    return { ...parseTicket(value, true), sailingId, bookingReference: r.booking_reference, leg: r.leg };
  });
}
/** This call records boarding atomically, it is not a client-side validation preview.
 * Retry after uncertainty: database row lock + unique audit constraint prevent duplicates. */
export async function boardTicket(code: string, sailingId: string, env?: EnvSource): Promise<BoardingOutcome> {
  uuid(sailingId); if (!validTicketLookup(code)) throw new DataServiceError('invalid-input');
  const c = await client(env);
  const { data } = await run(c.rpc('board_ticket', { p_code: code.trim(), p_sailing_id: sailingId }));
  const outcomes: readonly unknown[] = ['boarded','already_boarded','not_found','wrong_sailing','cancelled','sailing_cancelled','not_ready'];
  if (!outcomes.includes(data)) throw new DataServiceError('unexpected-response');
  return data as BoardingOutcome;
}
export async function setSailingReadiness(sailingId: string, status: ReadinessStatus, reason: string, env?: EnvSource): Promise<'recorded' | 'unchanged'> {
  uuid(sailingId);
  if (!['pending','ready','blocked'].includes(status) || !reason.trim() || [...reason.trim()].length > 500) throw new DataServiceError('invalid-input');
  const c = await client(env);
  const { data } = await run(c.rpc('set_sailing_readiness', { p_sailing_id: sailingId, p_status: status, p_reason: reason.trim() }));
  if (data !== 'recorded' && data !== 'unchanged') throw new DataServiceError('unexpected-response');
  return data;
}
export async function listReadinessEvents(sailingId: string, env?: EnvSource): Promise<ReadinessEvent[]> {
  uuid(sailingId); const c = await client(env);
  const { data } = await run(c.from('sailing_readiness_events').select('id,status,reason,occurred_at')
    .eq('sailing_id', sailingId).order('occurred_at', { ascending: false }).limit(50));
  return rows(data).map(v => {
    const r = row(v);
    if (typeof r.id !== 'string' || typeof r.reason !== 'string' || typeof r.occurred_at !== 'string'
      || !['pending','ready','blocked'].includes(String(r.status))) throw new DataServiceError('unexpected-response');
    return { id: r.id, status: r.status as ReadinessStatus, reason: r.reason, occurredAt: r.occurred_at };
  });
}
