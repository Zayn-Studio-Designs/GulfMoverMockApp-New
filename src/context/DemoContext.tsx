import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  initialAudit, initialBoatSlots, initialBookings, initialMaterials, initialSailings, nowTime, today,
  type AuditEvent, type Booking, type MaterialRequest, type Sailing,
} from '../data/demoData';
import { boatAvailability, canBookPassengers, canCharter, findSlot, type BoatSlot } from '../domain/fleet';

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
  vessel: string;
  imo: string;
  formError: string;
  policyAck: boolean;
  accessAck: boolean;
  paymentChoice: PaymentChoice;
  currentBooking: Booking | null;
}

export interface BoardingState {
  selectedSailingId: string;
  scanCount: number;
  lastScanUsed: boolean;
  boardingMessage: null | 'valid' | 'duplicate';
  manualRef: string;
  manualFound: null | Pick<Booking, 'ref' | 'payment' | 'boarding'>;
}

export const initialWizard = (): WizardState => ({
  bookStep: 1, service: 'passenger', addReturn: false, selectedOut: '07:00', selectedRet: '09:30', selectedBoat: 'B-01', selectedRetBoat: 'B-01',
  journeyDate: today(), returnDate: today(), city: 'dammam', chosenDestination: 'Approved Anchorage A (Demo)', paxCount: 1,
  passengerName: '', passengerEmail: '', passengerPhone: '', passengerCompany: '', vessel: '', imo: '',
  formError: '', policyAck: false, accessAck: false, paymentChoice: '', currentBooking: null,
});

const initialBoarding = (): BoardingState => ({
  selectedSailingId: 'S-0700', scanCount: 0, lastScanUsed: false, boardingMessage: null, manualRef: '', manualFound: null,
});

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
}

function loadPersisted(): PersistedState | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed?.savedAt !== today() || !Array.isArray(parsed.bookings) || !Array.isArray(parsed.boatSlots)) return null;
    return parsed;
  } catch {
    return null;
  }
}

interface DemoContextValue {
  sailings: Sailing[];
  bookings: Booking[];
  materials: MaterialRequest[];
  audit: AuditEvent[];
  wizard: WizardState;
  updateWizard: (patch: Partial<WizardState>) => void;
  resetWizard: () => void;
  boarding: BoardingState;
  updateBoarding: (patch: Partial<BoardingState>) => void;
  addAudit: (actor: string, action: string) => void;
  addBooking: (booking: Booking) => void;
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
  decideMaterial: (id: string, decision: MaterialDecision, reason: string) => void;
  overrideBoarding: (ref: string, reason: string) => void;
  resetDemoData: () => void;
}

const DemoContext = createContext<DemoContextValue | undefined>(undefined);

export function DemoProvider({ children }: { children: ReactNode }) {
  const persisted = useRef<PersistedState | null>(loadPersisted());
  const [sailings, setSailings] = useState(() => persisted.current?.sailings ?? initialSailings());
  const [bookings, setBookings] = useState(() => persisted.current?.bookings ?? initialBookings());
  const [materials, setMaterials] = useState(() => persisted.current?.materials ?? initialMaterials());
  const [audit, setAudit] = useState(() => persisted.current?.audit ?? initialAudit());
  const [wizard, setWizard] = useState(initialWizard);
  const [boarding, setBoarding] = useState(initialBoarding);
  const [boatSlots, setBoatSlotsState] = useState(() => persisted.current?.boatSlots ?? initialBoatSlots());
  // Mirror of boatSlots so a booking check always sees the latest reservations (prevents double booking).
  const slotsRef = useRef<BoatSlot[]>(boatSlots);
  const setBoatSlots = useCallback((next: BoatSlot[]) => { slotsRef.current = next; setBoatSlotsState(next); }, []);

  // Keep the saved demo data in sync after every change (same-day persistence).
  useEffect(() => {
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ savedAt: today(), sailings, bookings, materials, audit, boatSlots }));
    } catch {
      // Storage unavailable (private mode): data lasts for the session only.
    }
  }, [sailings, bookings, materials, audit, boatSlots]);

  const addAudit = useCallback((actor: string, action: string) => {
    setAudit(prev => [...prev, { time: nowTime(), actor, action }]);
  }, []);

  const updateWizard = useCallback((patch: Partial<WizardState>) => setWizard(prev => ({ ...prev, ...patch })), []);
  const resetWizard = useCallback(() => setWizard(initialWizard()), []);
  const updateBoarding = useCallback((patch: Partial<BoardingState>) => setBoarding(prev => ({ ...prev, ...patch })), []);

  const addBooking = useCallback((booking: Booking) => setBookings(prev => [booking, ...prev]), []);
  const addMaterial = useCallback((material: MaterialRequest) => setMaterials(prev => [material, ...prev]), []);

  const addTicketsToSailing = useCallback((time: string, boatId: string, tickets: number) => {
    setSailings(prev => prev.map(s => (s.time === time && s.boatId === boatId && s.dir === 'Outbound' ? { ...s, count: s.count + tickets } : s)));
  }, []);

  const reservePassengers = useCallback((boatId: string, date: string, time: string, passengers: number, ref: string) => {
    const current = slotsRef.current;
    if (!canBookPassengers(boatAvailability(current, boatId, date, time))) return false;
    const existing = findSlot(current, boatId, date, time);
    setBoatSlots(existing
      ? current.map(s => (s === existing ? { ...s, passengers: s.passengers + passengers, refs: [...s.refs, ref] } : s))
      : [...current, { id: `BS-${String(current.length + 101)}`, boatId, date, time, kind: 'scheduled', passengers, refs: [ref], holder: 'Shared scheduled sailing', status: 'Seats booked (demo)' }]);
    return true;
  }, [setBoatSlots]);

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

  const decideMaterial = useCallback((id: string, decision: MaterialDecision, reason: string) => {
    const status = decision === 'approved' ? 'Approved with conditions (demo)'
      : decision === 'clarification' ? 'Clarification required' : 'Rejected (demo)';
    setMaterials(prev => prev.map(m => (m.id === id ? { ...m, status, detail: `${m.detail} Decision note (demo): ${reason}` } : m)));
    addAudit('Demo operations reviewer', `${id}: ${status}`);
  }, [addAudit]);

  const overrideBoarding = useCallback((ref: string, reason: string) => {
    setBookings(prev => prev.map(b => (b.ref === ref ? { ...b, boarding: 'Manual override recorded (demo)' } : b)));
    addAudit('Demo boarding user', `Manual boarding override for ${ref}: ${reason}`);
  }, [addAudit]);

  const resetDemoData = useCallback(() => {
    try { localStorage.removeItem(PERSIST_KEY); } catch { /* ignore */ }
    setSailings(initialSailings());
    setBookings(initialBookings());
    setMaterials(initialMaterials());
    setAudit(initialAudit());
    setWizard(initialWizard());
    setBoarding(initialBoarding());
    setBoatSlots(initialBoatSlots());
  }, [setBoatSlots]);

  const value = useMemo<DemoContextValue>(() => ({
    sailings, bookings, materials, audit, wizard, updateWizard, resetWizard, boarding, updateBoarding,
    addAudit, addBooking, addMaterial, addTicketsToSailing, boatSlots, reservePassengers, requestCharter, releaseSlot,
    suspendSailing, decideMaterial, overrideBoarding, resetDemoData,
  }), [sailings, bookings, materials, audit, wizard, updateWizard, resetWizard, boarding, updateBoarding,
    addAudit, addBooking, addMaterial, addTicketsToSailing, boatSlots, reservePassengers, requestCharter, releaseSlot,
    suspendSailing, decideMaterial, overrideBoarding, resetDemoData]);

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo(): DemoContextValue {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error('useDemo must be used within a DemoProvider');
  return ctx;
}
