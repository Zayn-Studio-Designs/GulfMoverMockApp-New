import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  initialAudit, initialBoatSlots, initialBookings, initialMaterials, initialSailings, nowTime, today,
  type AuditEvent, type Booking, type MaterialRequest, type PolicyAcceptance, type Sailing,
} from '../data/demoData';
import {
  boatAvailability, canBookPassengers, canCharter, findSlot, planReservation,
  type BoatSlot, type LegRequest, type ReservationFailure,
} from '../domain/fleet';
import { createTickets, type Ticket, type TicketLeg } from '../domain/tickets';

export type ServiceType = 'passenger' | 'material' | 'combined' | 'charter';
export type PaymentChoice = '' | 'recorded' | 'pending' | 'failed';
export type MaterialDecision = 'approved' | 'clarification' | 'rejected';

export interface WizardState {
  bookStep: number;
  service: ServiceType;
  addReturn: boolean;
  selectedOut: string;
  selectedRet: string;
  selectedBoat: string;
  selectedRetBoat: string;
  journeyDate: string;
  returnDate: string;
  city: string;
  chosenDestination: string;
  paxCount: number;
  passengerName: string;
  passengerEmail: string;
  passengerPhone: string;
  passengerCompany: string;
  extraPassengerNames: string[];
  vessel: string;
  imo: string;
  formError: string;
  /** Optional corporate purchase-order reference captured in the details step. */
  po: string;
  policyAck: boolean;
  accessAck: boolean;
  paymentChoice: PaymentChoice;
  currentBooking: Booking | null;
}

export interface BoardingState {
  selectedSailingId: string;
  query: string;
  lastResult: null | { kind: 'valid' | 'duplicate' | 'notEligible' | 'unknown'; ref: string; ticketId: string };
}

export interface DemoConfig {
  /** Illustrative fare. The brief proposes SAR 500; ATCO approval is still pending. */
  farePerPassenger: number;
  /** Configured demo departure times (the brief's initial schedule first). */
  schedule: string[];
  /** Demo seats per boat; null means capacity is not configured (not a real limit). */
  seatsPerBoat: Record<string, number | null>;
}

export const DEFAULT_CONFIG: DemoConfig = {
  farePerPassenger: 500,
  schedule: ['07:00', '09:30', '13:00'],
  seatsPerBoat: { 'B-01': null, 'B-02': null, 'B-03': null },
};

/** A pass saved to the simulated Apple Wallet collection (Phase 3). */
export interface WalletPass {
  id: string;
  ticketId: string;
  ref: string;
  addedAt: string;
}

export const initialWizard = (): WizardState => ({
  bookStep: 1, service: 'passenger', addReturn: false, selectedOut: '07:00', selectedRet: '13:00', selectedBoat: 'B-01', selectedRetBoat: 'B-01',
  journeyDate: today(), returnDate: today(), city: 'dammam', chosenDestination: 'Approved Anchorage A (Demo)', paxCount: 1,
  passengerName: '', passengerEmail: '', passengerPhone: '', passengerCompany: '', extraPassengerNames: [], vessel: '', imo: '',
  formError: '', po: '', policyAck: false, accessAck: false, paymentChoice: '', currentBooking: null,
});

const initialBoarding = (): BoardingState => ({ selectedSailingId: 'S-0700', query: '', lastResult: null });

/**
 * Demo bookings etc. previously lived only in memory and vanished on refresh.
 * They now persist per browser (same day) through localStorage, like accounts.
 * A saved state from an earlier day is discarded so the sample dates stay current.
 */
const PERSIST_KEY = 'gm-demo-state-v1';

interface PersistedState {
  savedAt: string;
  sailings: Sailing[];
  bookings: Booking[];
  materials: MaterialRequest[];
  audit: AuditEvent[];
  boatSlots: BoatSlot[];
  config?: DemoConfig;
  passes?: WalletPass[];
}

const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
const isConfig = (v: unknown): v is DemoConfig =>
  typeof v === 'object' && v !== null && typeof (v as DemoConfig).farePerPassenger === 'number' && isArray((v as DemoConfig).schedule);

/** Defensive parsing: malformed or partially missing localStorage never crashes the demo. */
function loadPersisted(): PersistedState | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as PersistedState;
    if (p.savedAt !== today() || !isArray(p.bookings) || !isArray(p.boatSlots) || !isArray(p.sailings)) return null;
    return {
      savedAt: p.savedAt,
      sailings: p.sailings as Sailing[],
      bookings: p.bookings as Booking[],
      materials: isArray(p.materials) ? (p.materials as MaterialRequest[]) : initialMaterials(),
      audit: isArray(p.audit) ? (p.audit as AuditEvent[]) : initialAudit(),
      boatSlots: p.boatSlots as BoatSlot[],
      config: isConfig(p.config) ? p.config : DEFAULT_CONFIG,
      passes: isArray(p.passes) ? (p.passes as WalletPass[]) : [],
    };
  } catch {
    return null;
  }
}

export interface NewBookingDraft {
  /** One entry per one-way leg, outbound first then (optional) return. */
  legs: Array<{ boatId: string; date: string; time: string }>;
  dest: string;
  passengers: number;
  passengerNames: string[];
  payment: PaymentChoice;
  addReturn: boolean;
  policyAccepted: PolicyAcceptance | null;
  po?: string;
  bookingContact?: string;
}

export type BookingResult = { ok: true; booking: Booking } | { ok: false; failedLeg: number | null; reason: ReservationFailure | null };

export type BoardTicketResult = 'ok' | 'unknown' | 'duplicate' | 'notEligible';

interface DemoContextValue {
  sailings: Sailing[];
  bookings: Booking[];
  materials: MaterialRequest[];
  audit: AuditEvent[];
  config: DemoConfig;
  setConfig: (patch: Partial<DemoConfig>) => void;
  wizard: WizardState;
  updateWizard: (patch: Partial<WizardState>) => void;
  resetWizard: () => void;
  boarding: BoardingState;
  updateBoarding: (patch: Partial<BoardingState>) => void;
  passes: WalletPass[];
  addAudit: (actor: string, action: string) => void;
  addBooking: (booking: Booking) => void;
  createBooking: (draft: NewBookingDraft) => BookingResult;
  addMaterial: (material: MaterialRequest) => void;
  /** Adds tickets to an outbound sailing's shared count (the minimum is aggregated across bookings). */
  addTicketsToSailing: (time: string, boatId: string, tickets: number) => void;
  boatSlots: BoatSlot[];
  /** Books seats on a boat's shared sailing. Fails if the boat is chartered for that slot. */
  reservePassengers: (boatId: string, date: string, time: string, passengers: number, ref: string) => boolean;
  /** Reserves the whole boat. Fails unless the boat is completely free for that slot. */
  requestCharter: (boatId: string, date: string, time: string, passengers: number, ref: string, holder: string) => boolean;
  releaseSlot: (id: string, reason: string) => void;
  suspendSailing: (id: string, reason: string) => void;
  /** Demo-only operational status change, applied by an authorised demo staff action. */
  setSailingOps: (id: string, ops: string) => void;
  decideMaterial: (id: string, decision: MaterialDecision, reason: string) => void;
  /** Marks a ticket boarded in the shared demo state; refuses duplicates and ineligible tickets. */
  boardTicket: (ticketId: string, reason: string) => { result: BoardTicketResult; booking?: Booking; ticket?: Ticket };
  overrideBoarding: (ref: string, reason: string) => void;
  /** Finds the booking holding a ticket (opaque ID lookup for scanning/manual entry). */
  findBookingByTicket: (ticketId: string) => { booking: Booking; ticket: Ticket } | null;
  addWalletPass: (ticketId: string) => WalletPass | null;
  /** Records the corporate PO reference on an existing demo booking (demo only). */
  setBookingPo: (ref: string, po: string) => void;
  resetDemoData: () => void;
}

const DemoContext = createContext<DemoContextValue | undefined>(undefined);

export function DemoProvider({ children }: { children: ReactNode }) {
  const persisted = useRef<PersistedState | null>(loadPersisted());
  const [sailings, setSailings] = useState(() => persisted.current?.sailings ?? initialSailings());
  const [bookings, setBookings] = useState(() => persisted.current?.bookings ?? initialBookings());
  const [materials, setMaterials] = useState(() => persisted.current?.materials ?? initialMaterials());
  const [audit, setAudit] = useState(() => persisted.current?.audit ?? initialAudit());
  const [config, setConfigState] = useState(() => persisted.current?.config ?? DEFAULT_CONFIG);
  const [passes, setPasses] = useState(() => persisted.current?.passes ?? []);
  const [wizard, setWizard] = useState(initialWizard);
  const [boarding, setBoarding] = useState(initialBoarding);
  const [boatSlots, setBoatSlotsState] = useState(() => persisted.current?.boatSlots ?? initialBoatSlots());
  // Mirror of boatSlots so a booking check always sees the latest reservations (prevents double booking).
  const slotsRef = useRef<BoatSlot[]>(boatSlots);
  const bookingsRef = useRef<Booking[]>(bookings);
  bookingsRef.current = bookings;
  const setBoatSlots = useCallback((next: BoatSlot[]) => { slotsRef.current = next; setBoatSlotsState(next); }, []);

  // Keep the saved demo data in sync after every change (same-day persistence).
  useEffect(() => {
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ savedAt: today(), sailings, bookings, materials, audit, boatSlots, config, passes }));
    } catch {
      // Storage unavailable (private mode): data lasts for the session only.
    }
  }, [sailings, bookings, materials, audit, boatSlots, config, passes]);

  const addAudit = useCallback((actor: string, action: string) => {
    setAudit(prev => [...prev, { time: nowTime(), actor, action }]);
  }, []);

  const updateWizard = useCallback((patch: Partial<WizardState>) => setWizard(prev => ({ ...prev, ...patch })), []);
  const resetWizard = useCallback(() => setWizard(initialWizard()), []);
  const updateBoarding = useCallback((patch: Partial<BoardingState>) => setBoarding(prev => ({ ...prev, ...patch })), []);

  const addBooking = useCallback((booking: Booking) => setBookings(prev => [booking, ...prev]), []);
  const addMaterial = useCallback((material: MaterialRequest) => setMaterials(prev => [material, ...prev]), []);

  const setConfig = useCallback((patch: Partial<DemoConfig>) => setConfigState(prev => ({ ...prev, ...patch })), []);

  const addTicketsToSailing = useCallback((time: string, boatId: string, tickets: number) => {
    setSailings(prev => prev.map(s => (s.time === time && s.boatId === boatId && s.dir === 'Outbound' ? { ...s, count: s.count + tickets } : s)));
  }, []);

  /** Atomic multi-leg reservation: every leg commits together, or nothing changes. */
  const reserveLegsAtomic = useCallback((requests: LegRequest[]): { ok: boolean; failedLeg: number | null; reason: ReservationFailure | null } | null => {
    const plan = planReservation(slotsRef.current, requests, { seatsPerBoat: config.seatsPerBoat });
    if (!plan.ok) return { ok: false, failedLeg: plan.failedLeg, reason: plan.reason };
    setBoatSlots(plan.updatedSlots);
    return { ok: true, failedLeg: null, reason: null };
  }, [config.seatsPerBoat, setBoatSlots]);

  const createBooking = useCallback((draft: NewBookingDraft): BookingResult => {
    const pax = Math.max(1, draft.passengers);
    const ref = `GM-DEMO-${String(3200 + bookingsRef.current.length + 1).padStart(4, '0')}`;
    const legRequests: LegRequest[] = draft.legs.map((leg, i) => ({ ...leg, passengers: pax, ref: i === 0 ? ref : `${ref}-R` }));
    const reserve = reserveLegsAtomic(legRequests);
    if (!reserve || !reserve.ok) {
      return { ok: false, failedLeg: reserve ? reserve.failedLeg : null, reason: reserve?.reason ?? 'capacity' };
    }
    const tickets: Ticket[] = [];
    const legTags: TicketLeg[] = draft.addReturn ? ['outbound', 'return'] : ['outbound'];
    legTags.forEach(tag => {
      tickets.push(...createTickets(tag, draft.passengerNames.slice(0, pax)));
    });
    const payment = draft.payment === 'recorded' ? 'Payment recorded (demo)'
      : draft.payment === 'pending' ? 'Payment pending (demo)' : 'Payment failed / uncertain (demo)';
    // Threshold aggregates across all bookings on the same outbound sailing, not per customer.
    const existing = findSlot(slotsRef.current, draft.legs[0].boatId, draft.legs[0].date, draft.legs[0].time)?.passengers ?? pax;
    const thresholdMet = existing >= 4;
    const fare = pax * config.farePerPassenger * (draft.addReturn ? 2 : 1);
    const booking: Booking = {
      ref,
      date: draft.legs[0].date,
      leg: draft.addReturn ? 'Outbound + return' : 'Outbound',
      time: draft.legs[0].time,
      dest: draft.dest,
      passengers: pax,
      passengerNames: draft.passengerNames.slice(0, pax),
      tickets,
      amount: fare,
      payment,
      threshold: thresholdMet ? 'Minimum met (demo)' : 'Collecting bookings',
      ops: 'Awaiting ATCO decision',
      boarding: 'Not started',
      service: 'Passenger transfer',
      boatId: draft.legs[0].boatId,
      return: draft.addReturn ? { date: draft.legs[1].date, time: draft.legs[1].time, dest: draft.dest, boatId: draft.legs[1].boatId } : null,
      policyAccepted: draft.policyAccepted,
      po: draft.po,
      bookingContact: draft.bookingContact,
    };
    setBookings(prev => [booking, ...prev]);
    if (booking.date === today()) addTicketsToSailing(draft.legs[0].time, draft.legs[0].boatId, pax);
    addAudit('Prototype', `${ref} reserved ${draft.legs.map(l => `${l.boatId} ${l.date} ${l.time}`).join(' + ')} (demo, atomic)`);
    return { ok: true, booking };
  }, [reserveLegsAtomic, addAudit, addTicketsToSailing, config.farePerPassenger]);

  const reservePassengers = useCallback((boatId: string, date: string, time: string, passengers: number, ref: string) => {
    const current = slotsRef.current;
    if (!canBookPassengers(boatAvailability(current, boatId, date, time))) return false;
    const existing = findSlot(current, boatId, date, time);
    if (existing && config.seatsPerBoat[boatId] !== null && config.seatsPerBoat[boatId] !== undefined
      && existing.passengers + passengers > (config.seatsPerBoat[boatId] as number)) return false;
    setBoatSlots(existing
      ? current.map(s => (s === existing ? { ...s, passengers: s.passengers + passengers, refs: [...s.refs, ref] } : s))
      : [...current, { id: `BS-${String(current.length + 101)}`, boatId, date, time, kind: 'scheduled', passengers, refs: [ref], holder: 'Shared scheduled sailing', status: 'Seats booked (demo)' }]);
    return true;
  }, [setBoatSlots, config.seatsPerBoat]);

  const requestCharter = useCallback((boatId: string, date: string, time: string, passengers: number, ref: string, holder: string) => {
    const current = slotsRef.current;
    if (!canCharter(boatAvailability(current, boatId, date, time))) return false;
    setBoatSlots([...current, { id: `BS-${String(current.length + 101)}`, boatId, date, time, kind: 'charter', passengers, refs: [ref], holder, status: 'Reserved — pending ATCO approval' }]);
    addAudit('Prototype', `Charter ${ref} reserved ${boatId} ${date} ${time} (demo)`);
    return true;
  }, [setBoatSlots, addAudit]);

  const releaseSlot = useCallback((id: string, reason: string) => {
    const slot = slotsRef.current.find(s => s.id === id);
    setBoatSlots(slotsRef.current.filter(s => s.id !== id));
    if (slot) addAudit('Demo operations user', `Released ${slot.boatId} ${slot.date} ${slot.time} (demo): ${reason}`);
  }, [setBoatSlots, addAudit]);

  const suspendSailing = useCallback((id: string, reason: string) => {
    setSailings(prev => prev.map(s => (s.id === id ? { ...s, ops: 'Suspended (demo)' } : s)));
    addAudit('Demo operations user', `Suspended ${id} (demo): ${reason}`);
  }, [addAudit]);

  const setSailingOps = useCallback((id: string, ops: string) => {
    setSailings(prev => prev.map(s => (s.id === id ? { ...s, ops } : s)));
    addAudit('Demo operations user', `${id} operational status set to “${ops}” (demo)`);
  }, [addAudit]);

  const decideMaterial = useCallback((id: string, decision: MaterialDecision, reason: string) => {
    const status = decision === 'approved' ? 'Approved with conditions (demo)'
      : decision === 'clarification' ? 'Clarification required' : 'Rejected (demo)';
    setMaterials(prev => prev.map(m => (m.id === id ? { ...m, status, detail: `${m.detail} Decision note (demo): ${reason}` } : m)));
    addAudit('Demo operations reviewer', `${id}: ${status}`);
  }, [addAudit]);

  const findBookingByTicket = useCallback((ticketId: string) => {
    for (const booking of bookingsRef.current) {
      const ticket = booking.tickets?.find(t => t.id === ticketId);
      if (ticket) return { booking, ticket };
    }
    return null;
  }, []);

  const persistBoarding = useCallback((ticketId: string, status: Ticket['status'], boardingText: string) => {
    setBookings(prev => prev.map(b => {
      if (!b.tickets?.some(t => t.id === ticketId)) return b;
      return {
        ...b,
        boarding: boardingText,
        tickets: b.tickets.map(t => (t.id === ticketId ? { ...t, status } : t)),
      };
    }));
  }, []);

  /** Demo verification: shared state only — production would validate server-side. */
  const boardTicket = useCallback((ticketId: string, reason: string): { result: BoardTicketResult; booking?: Booking; ticket?: Ticket } => {
    const found = findBookingByTicket(ticketId);
    if (!found) return { result: 'unknown' };
    const { booking, ticket } = found;
    if (ticket.status === 'boarded') return { result: 'duplicate', booking, ticket };
    if (/failed/i.test(booking.payment)) return { result: 'notEligible', booking, ticket };
    persistBoarding(ticketId, 'boarded', 'Boarded (demo)');
    addAudit('Demo boarding user', `${ticket.leg} ticket of ${booking.ref} marked boarded (demo) — reason: ${reason || 'scan verification'}`);
    return { result: 'ok', booking, ticket };
  }, [findBookingByTicket, persistBoarding, addAudit]);

  const overrideBoarding = useCallback((ref: string, reason: string) => {
    setBookings(prev => prev.map(b => (b.ref === ref ? { ...b, boarding: 'Manual override recorded (demo)' } : b)));
    addAudit('Demo boarding user', `Manual boarding override for ${ref}: ${reason}`);
  }, [addAudit]);

  const setBookingPo = useCallback((ref: string, po: string) => {
    setBookings(prev => prev.map(b => (b.ref === ref ? { ...b, po: po.trim() || undefined } : b)));
  }, []);

  const addWalletPass = useCallback((ticketId: string) => {
    if (passes.some(p => p.ticketId === ticketId)) return null; // duplicate passes refused
    const found = findBookingByTicket(ticketId);
    if (!found) return null;
    const pass: WalletPass = { id: `GMPW-${ticketId.slice(-6)}`, ticketId, ref: found.booking.ref, addedAt: nowTime() };
    setPasses(prev => [...prev, pass]);
    return pass;
  }, [passes, findBookingByTicket]);

  const resetDemoData = useCallback(() => {
    try { localStorage.removeItem(PERSIST_KEY); } catch { /* ignore */ }
    setSailings(initialSailings());
    setBookings(initialBookings());
    setMaterials(initialMaterials());
    setAudit(initialAudit());
    setWizard(initialWizard());
    setBoarding(initialBoarding());
    setConfigState(DEFAULT_CONFIG);
    setPasses([]);
    setBoatSlots(initialBoatSlots());
  }, [setBoatSlots]);

  const value = useMemo<DemoContextValue>(() => ({
    sailings, bookings, materials, audit, config, setConfig, wizard, updateWizard, resetWizard, boarding, updateBoarding,
    passes, addAudit, addBooking, createBooking, addMaterial, addTicketsToSailing, boatSlots, reservePassengers, requestCharter,
    releaseSlot, suspendSailing, setSailingOps, decideMaterial, boardTicket, overrideBoarding, findBookingByTicket, addWalletPass, setBookingPo, resetDemoData,
  }), [sailings, bookings, materials, audit, config, setConfig, wizard, updateWizard, resetWizard, boarding, updateBoarding,
    passes, addAudit, addBooking, createBooking, addMaterial, addTicketsToSailing, boatSlots, reservePassengers, requestCharter,
    releaseSlot, suspendSailing, setSailingOps, decideMaterial, boardTicket, overrideBoarding, findBookingByTicket, addWalletPass, setBookingPo, resetDemoData]);

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo(): DemoContextValue {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error('useDemo must be used within a DemoProvider');
  return ctx;
}
