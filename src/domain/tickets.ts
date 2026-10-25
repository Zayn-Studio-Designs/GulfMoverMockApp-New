// Ticket identity (Phase 1 of the demo upgrade).
//
// Every individual passenger receives one ticket per one-way leg: outbound and
// return are separate tickets with separate identifiers and separate QR codes.
// The identifier is opaque — no passenger names, phone numbers, identity
// numbers or payment data ever go into it (or into the QR payload). It is a
// demo verification reference only, not a production boarding credential.

export type TicketLeg = 'outbound' | 'return';

export type TicketStatus = 'notBoarded' | 'boarded';

export interface Ticket {
  id: string;
  leg: TicketLeg;
  /** Name the demo already collects for this passenger; never embedded in the QR. */
  passengerName: string;
  status: TicketStatus;
}

/** Version tag of the illustrative demo policy wording accepted at booking time. */
export const DEMO_POLICY_VERSION = 'gulf-mover-demo-policy-v1';

/* Small internal hash so seeded sample tickets get stable, reproducible IDs
   (they must not change between reloads) without shipping personal data. */
function stableHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function randomSuffix(): string {
  // Opaque per-ticket suffix: crypto when available, Math.random otherwise.
  try {
    const bytes = new Uint8Array(8);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else throw new Error('unavailable');
    return Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
  } catch {
    return Math.random().toString(36).slice(2, 12);
  }
}

/**
 * Creates a per-passenger, per-leg ticket list. IDs are generated once here and stored on the
 * booking, so they survive reloads and rerenders unchanged. `isTaken` lets the caller reject an ID
 * already used by another ticket, so two tickets can never share an identity.
 */
export function createTickets(
  leg: TicketLeg,
  passengerNames: string[],
  isTaken: (id: string) => boolean = () => false,
): Ticket[] {
  const issued = new Set<string>();
  return passengerNames.map(passengerName => {
    let id = `GMTK-${randomSuffix()}`;
    for (let attempt = 0; (issued.has(id) || isTaken(id)) && attempt < 20; attempt++) id = `GMTK-${randomSuffix()}`;
    issued.add(id);
    return { id, leg, passengerName, status: 'notBoarded' as TicketStatus };
  });
}

/** Deterministic ticket list for the seeded sample bookings (stable across reloads). */
export function createSeededTickets(cls: { ref: string; leg: TicketLeg; count: number; leadName: string }): Ticket[] {
  return Array.from({ length: cls.count }, (_, i) => ({
    id: `GMTK-${stableHash(`${cls.ref}|${cls.leg}|${i}`)}`,
    leg: cls.leg,
    passengerName: i === 0 ? cls.leadName : `Passenger ${i + 1}`,
    status: 'notBoarded',
  }));
}

/** Opaque scan payload encoded into the QR image. Contains the ticket ID only. */
export function ticketScanPayload(ticketId: string): string {
  return `GM-VERIFY-1|${ticketId}`;
}

/** Parses a scanned/typed value back to a ticket ID; accepts raw IDs too. */
export function parseScanPayload(raw: string): string | null {
  const value = raw.trim().toUpperCase();
  if (/^GMTK-[0-9A-Z]+$/.test(value)) return value;
  // Primary QR format emitted by ticketScanPayload(): "GM-VERIFY-1|GMTK…".
  if (value.startsWith('GM-VERIFY-1|')) {
    const id = value.slice('GM-VERIFY-1|'.length);
    return /^GMTK-[0-9A-Z]+$/.test(id) ? id : null;
  }
  // Legacy/verbose alt form: "GM-VERIFY|1|GMTK…".
  const [tag, version, id] = value.split('|');
  return tag === 'GM-VERIFY' && version === '1' && /^GMTK-[0-9A-Z]+$/.test(id ?? '') ? id : null;
}

/** Finds a ticket by its ID inside a booking (checked over booked + return tickets). */
export function findTicketInBooking<T extends { tickets?: Ticket[] }>(booking: T | undefined, ticketId: string): Ticket | undefined {
  if (!booking) return undefined;
  const all = allTickets(booking);
  return all.find(t => t.id === ticketId);
}

export function allTickets<T extends { tickets?: Ticket[] }>(booking: T): Ticket[] {
  return booking.tickets ?? [];
}
