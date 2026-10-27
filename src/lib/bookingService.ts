import type { EnvSource } from './supabase';
import { DataServiceError, requireDataClient, requireSessionUser, run } from './dataService';

/**
 * Production booking + operations service (migration 20261027121000).
 *
 * WRITES
 *   - bookings: ONLY `create_booking(...)`. The database checks the caller's identity,
 *     approved-company membership, sailing status and capacity under row locks, generates the
 *     reference and enforces idempotency per (user, request key). The browser never sends a
 *     status, price, payment state or user id.
 *   - vessels / routes / sailings: plain inserts/updates limited by RLS to ATCO
 *     super_admin/operations and by column grants (seats_booked is not writable).
 * READS go through the caller's session; RLS decides which bookings are visible.
 * Lists are bounded (limit) and use embedded selects — one request per list, no N+1.
 */

/* --------------------------------- types --------------------------------- */

export type SailingStatus = 'open' | 'closed' | 'cancelled';
export type RecordStatus = 'active' | 'inactive';

export interface Route { readonly id: string; readonly origin: string; readonly destination: string; readonly status: RecordStatus }
export interface Vessel { readonly id: string; readonly name: string; readonly passengerCapacity: number | null; readonly status: RecordStatus }

export interface Sailing {
  readonly id: string;
  readonly departsAt: string;
  readonly seatCapacity: number;
  readonly seatsBooked: number;
  readonly readinessStatus: 'pending' | 'ready' | 'blocked';
  readonly status: SailingStatus;
  readonly route: Route;
  readonly vessel: { readonly id: string; readonly name: string };
}

export interface BookingLeg {
  readonly leg: 'outbound' | 'return';
  readonly passengers: number;
  readonly sailing: { readonly id: string; readonly departsAt: string; readonly status: SailingStatus; readonly origin: string; readonly destination: string; readonly vesselName: string } | null;
}

export interface Booking {
  readonly id: string;
  readonly reference: string;
  /** Only 'reserved' exists: seats are held. It is NOT paid, ticketed, cleared or boarded. */
  readonly status: 'reserved';
  readonly passengerCount: number;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly passengerNames: readonly string[];
  readonly poReference: string | null;
  readonly organizationId: string;
  readonly createdAt: string;
  readonly legs: readonly BookingLeg[];
}

export const SAILING_LIST_LIMIT = 200;
export const BOOKING_LIST_LIMIT = 100;

/* -------------------------------- parsing -------------------------------- */

const s = (v: unknown) => (typeof v === 'string' ? v : '');
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const one = (v: unknown): Record<string, unknown> | null => {
  const value = Array.isArray(v) ? v[0] : v;
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
};

function toRoute(row: Record<string, unknown> | null): Route {
  if (!row || typeof row.id !== 'string') throw new DataServiceError('unexpected-response');
  return { id: row.id, origin: s(row.origin), destination: s(row.destination), status: row.status === 'inactive' ? 'inactive' : 'active' };
}

function toVessel(row: Record<string, unknown>): Vessel {
  if (typeof row.id !== 'string') throw new DataServiceError('unexpected-response');
  return {
    id: row.id, name: s(row.name),
    passengerCapacity: typeof row.passenger_capacity === 'number' ? row.passenger_capacity : null,
    status: row.status === 'inactive' ? 'inactive' : 'active',
  };
}

function toSailing(row: Record<string, unknown>): Sailing {
  const vessel = one(row.vessel);
  if (typeof row.id !== 'string' || !vessel) throw new DataServiceError('unexpected-response');
  const status = row.status === 'closed' || row.status === 'cancelled' ? row.status : 'open';
  return {
    id: row.id, departsAt: s(row.departs_at), seatCapacity: n(row.seat_capacity), seatsBooked: n(row.seats_booked),
    readinessStatus: row.readiness_status === 'ready' || row.readiness_status === 'blocked' ? row.readiness_status : 'pending',
    status, route: toRoute(one(row.route)), vessel: { id: s(vessel.id), name: s(vessel.name) },
  };
}

function toBooking(row: Record<string, unknown>): Booking {
  if (typeof row.id !== 'string' || typeof row.reference !== 'string') throw new DataServiceError('unexpected-response');
  const legs = Array.isArray(row.booking_legs) ? row.booking_legs as Record<string, unknown>[] : [];
  return {
    id: row.id, reference: row.reference, status: 'reserved',
    passengerCount: n(row.passenger_count), contactName: s(row.contact_name), contactEmail: s(row.contact_email),
    contactPhone: s(row.contact_phone),
    passengerNames: Array.isArray(row.passenger_names) ? (row.passenger_names as unknown[]).map(s) : [],
    poReference: typeof row.po_reference === 'string' ? row.po_reference : null,
    organizationId: s(row.organization_id), createdAt: s(row.created_at),
    legs: legs.map(leg => {
      const sailing = one(leg.sailing);
      const route = sailing ? one(sailing.route) : null;
      const vessel = sailing ? one(sailing.vessel) : null;
      return {
        leg: leg.leg === 'return' ? 'return' : 'outbound',
        passengers: n(leg.passengers),
        sailing: sailing ? {
          id: s(sailing.id), departsAt: s(sailing.departs_at),
          status: sailing.status === 'closed' || sailing.status === 'cancelled' ? sailing.status : 'open',
          origin: s(route?.origin), destination: s(route?.destination), vesselName: s(vessel?.name),
        } : null,
      } as BookingLeg;
    }).sort((a, b) => (a.leg === b.leg ? 0 : a.leg === 'outbound' ? -1 : 1)),
  };
}

const SAILING_SELECT = 'id, departs_at, seat_capacity, seats_booked, status, readiness_status, route:routes(id, origin, destination, status), vessel:vessels(id, name)';
const BOOKING_SELECT = 'id, reference, status, passenger_count, contact_name, contact_email, contact_phone, passenger_names, po_reference, organization_id, created_at, '
  + 'booking_legs(leg, passengers, sailing:sailings(id, departs_at, status, route:routes(origin, destination), vessel:vessels(name)))';

/* ------------------------------ customer side ----------------------------- */

/** Upcoming sailings open for booking, soonest first. */
export async function listOpenSailings(env?: EnvSource): Promise<Sailing[]> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.from('sailings').select(SAILING_SELECT)
    .eq('status', 'open').gt('departs_at', new Date().toISOString())
    .order('departs_at', { ascending: true }).limit(SAILING_LIST_LIMIT));
  return (Array.isArray(data) ? data as Record<string, unknown>[] : []).map(toSailing);
}

export interface BookingInput {
  readonly organizationId: string;
  readonly outboundSailingId: string;
  readonly returnSailingId: string | null;
  readonly passengerCount: number;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  /** Optional names of the other passengers (the lead is contactName). */
  readonly extraPassengerNames: readonly string[];
  readonly poReference: string;
}

export type BookingField = 'organizationId' | 'outboundSailingId' | 'returnSailingId' | 'passengerCount'
  | 'contactName' | 'contactEmail' | 'contactPhone' | 'extraPassengerNames' | 'poReference';

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_PATTERN = /^\+?[0-9 ()-]{7,20}$/;
const chars = (v: string) => [...v].length;

/** Mirrors create_booking() validation; the database remains the authority. */
export function validateBookingInput(input: BookingInput, seatsLeft?: number): Partial<Record<BookingField, string>> {
  const errors: Partial<Record<BookingField, string>> = {};
  if (!input.organizationId) errors.organizationId = 'required';
  if (!input.outboundSailingId) errors.outboundSailingId = 'required';
  if (input.returnSailingId && input.returnSailingId === input.outboundSailingId) errors.returnSailingId = 'invalid';
  if (!Number.isInteger(input.passengerCount) || input.passengerCount < 1 || input.passengerCount > 1000) errors.passengerCount = 'invalid';
  else if (seatsLeft !== undefined && input.passengerCount > seatsLeft) errors.passengerCount = 'too-many';
  const name = input.contactName.trim();
  if (!name) errors.contactName = 'required'; else if (chars(name) > 120) errors.contactName = 'too-long';
  const email = input.contactEmail.trim().toLowerCase();
  if (!email) errors.contactEmail = 'required'; else if (chars(email) > 254 || !EMAIL_PATTERN.test(email)) errors.contactEmail = 'invalid-email';
  const phone = input.contactPhone.trim();
  if (!phone) errors.contactPhone = 'required'; else if (!PHONE_PATTERN.test(phone)) errors.contactPhone = 'invalid-phone';
  const extras = input.extraPassengerNames.map(v => v.trim()).filter(Boolean);
  if (extras.some(v => chars(v) > 120) || extras.length + 1 > Math.max(1, input.passengerCount)) errors.extraPassengerNames = 'invalid';
  if (chars(input.poReference.trim()) > 64) errors.poReference = 'too-long';
  return errors;
}

export function buildCreateBookingArgs(input: BookingInput, requestKey: string) {
  const extras = input.extraPassengerNames.map(v => v.trim()).filter(Boolean);
  return {
    p_request_key: requestKey,
    p_organization_id: input.organizationId,
    p_outbound_sailing_id: input.outboundSailingId,
    p_passenger_count: input.passengerCount,
    p_contact_name: input.contactName.trim(),
    p_contact_email: input.contactEmail.trim().toLowerCase(),
    p_contact_phone: input.contactPhone.trim(),
    p_passenger_names: extras.length ? extras : null,
    p_return_sailing_id: input.returnSailingId || null,
    p_po_reference: input.poReference.trim() || null,
  };
}

export interface CreateBookingResult {
  readonly bookingId: string;
  readonly reference: string;
  readonly status: 'reserved';
  readonly outcome: 'created' | 'replayed';
}

export async function createBooking(input: BookingInput, requestKey: string, env?: EnvSource): Promise<CreateBookingResult> {
  const client = requireDataClient(env);
  if (Object.keys(validateBookingInput(input)).length > 0) throw new DataServiceError('invalid-input');
  await requireSessionUser(client); // never call the protected RPC anonymously
  const { data } = await run(client.rpc('create_booking', buildCreateBookingArgs(input, requestKey)));
  const row = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
  if (!row || typeof row.booking_id !== 'string' || typeof row.reference !== 'string' || !/^GM-[0-9A-F]{8}$/.test(row.reference)
    || row.status !== 'reserved' || (row.outcome !== 'created' && row.outcome !== 'replayed')) {
    throw new DataServiceError('unexpected-response');
  }
  return { bookingId: row.booking_id, reference: row.reference, status: 'reserved', outcome: row.outcome };
}

/** The caller's bookings. `scope: 'mine'` restricts to bookings the caller created (used for ATCO staff,
 *  whose RLS visibility covers every booking); otherwise everything RLS lets the caller see. */
export async function listBookings(scope: 'mine' | 'visible', env?: EnvSource): Promise<Booking[]> {
  const client = requireDataClient(env);
  const userId = await requireSessionUser(client);
  let query = client.from('bookings').select(BOOKING_SELECT);
  if (scope === 'mine') query = query.eq('created_by', userId);
  const { data } = await run(query.order('created_at', { ascending: false }).limit(BOOKING_LIST_LIMIT));
  return (Array.isArray(data) ? data as unknown as Record<string, unknown>[] : []).map(toBooking);
}

/** One booking by reference, or null when it does not exist OR is not visible to the caller (RLS). */
export async function getBooking(reference: string, env?: EnvSource): Promise<Booking | null> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  if (!/^GM-[0-9A-F]{8}$/.test(reference)) return null;
  const { data } = await run(client.from('bookings').select(BOOKING_SELECT).eq('reference', reference).maybeSingle());
  return data ? toBooking(data as Record<string, unknown>) : null;
}

/* ------------------------------ ATCO operations --------------------------- */

export async function listVessels(env?: EnvSource): Promise<Vessel[]> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.from('vessels').select('id, name, passenger_capacity, status').order('name').limit(200));
  return (Array.isArray(data) ? data as Record<string, unknown>[] : []).map(toVessel);
}

export async function saveVessel(vessel: { id?: string; name: string; passengerCapacity: number | null; status: RecordStatus }, env?: EnvSource): Promise<void> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const name = vessel.name.trim();
  if (!name || chars(name) > 120) throw new DataServiceError('invalid-input');
  if (vessel.passengerCapacity !== null && (!Number.isInteger(vessel.passengerCapacity) || vessel.passengerCapacity < 1 || vessel.passengerCapacity > 1000)) {
    throw new DataServiceError('invalid-input');
  }
  const row = { name, passenger_capacity: vessel.passengerCapacity, status: vessel.status };
  await run(vessel.id
    ? client.from('vessels').update(row).eq('id', vessel.id).select('id').single()
    : client.from('vessels').insert(row).select('id').single());
}

export async function listRoutes(env?: EnvSource): Promise<Route[]> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.from('routes').select('id, origin, destination, status').order('origin').limit(200));
  return (Array.isArray(data) ? data as Record<string, unknown>[] : []).map(r => toRoute(r));
}

export async function saveRoute(route: { id?: string; origin: string; destination: string; status: RecordStatus }, env?: EnvSource): Promise<void> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const origin = route.origin.trim();
  const destination = route.destination.trim();
  if (!origin || !destination || chars(origin) > 120 || chars(destination) > 120 || origin.toLowerCase() === destination.toLowerCase()) {
    throw new DataServiceError('invalid-input');
  }
  const row = { origin, destination, status: route.status };
  await run(route.id
    ? client.from('routes').update(row).eq('id', route.id).select('id').single()
    : client.from('routes').insert(row).select('id').single());
}

/** Upcoming (and the last day's) sailings of every status, for the operations schedule. */
export async function listScheduleSailings(env?: EnvSource): Promise<Sailing[]> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { data } = await run(client.from('sailings').select(SAILING_SELECT)
    .gte('departs_at', since).order('departs_at', { ascending: true }).limit(SAILING_LIST_LIMIT));
  return (Array.isArray(data) ? data as Record<string, unknown>[] : []).map(toSailing);
}

export interface SailingDraft {
  readonly id?: string;
  readonly routeId: string;
  readonly vesselId: string;
  readonly departsAt: string; // ISO instant
  readonly seatCapacity: number;
  readonly status: SailingStatus;
}

export async function saveSailing(draft: SailingDraft, env?: EnvSource): Promise<void> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  if (!draft.routeId || !draft.vesselId || Number.isNaN(Date.parse(draft.departsAt))
    || !Number.isInteger(draft.seatCapacity) || draft.seatCapacity < 1 || draft.seatCapacity > 1000) {
    throw new DataServiceError('invalid-input');
  }
  const row = { route_id: draft.routeId, vessel_id: draft.vesselId, departs_at: draft.departsAt, seat_capacity: draft.seatCapacity, status: draft.status };
  await run(draft.id
    ? client.from('sailings').update(row).eq('id', draft.id).select('id').single()
    : client.from('sailings').insert(row).select('id').single());
}

export interface ManifestEntry {
  readonly leg: 'outbound' | 'return';
  readonly passengers: number;
  readonly reference: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly organizationName: string;
}

/** Reservations on one departure (ATCO staff; RLS returns nothing to others). */
export async function getSailingManifest(sailingId: string, env?: EnvSource): Promise<ManifestEntry[]> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.from('booking_legs')
    .select('leg, passengers, booking:bookings(reference, contact_name, contact_phone, organization:organizations(legal_name))')
    .eq('sailing_id', sailingId).order('created_at', { ascending: true }).limit(1000));
  return (Array.isArray(data) ? data as Record<string, unknown>[] : []).map(row => {
    const booking = one(row.booking);
    const org = booking ? one(booking.organization) : null;
    return {
      leg: row.leg === 'return' ? 'return' : 'outbound',
      passengers: n(row.passengers),
      reference: s(booking?.reference),
      contactName: s(booking?.contact_name),
      contactPhone: s(booking?.contact_phone),
      organizationName: s(org?.legal_name),
    } as ManifestEntry;
  });
}
