import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  initialAudit, initialBookings, initialMaterials, initialSailings, nowTime, today,
  type AuditEvent, type Booking, type MaterialRequest, type Sailing,
} from '../data/demoData';

export type ServiceType = 'passenger' | 'material' | 'combined' | 'charter';
export type PaymentChoice = '' | 'recorded' | 'pending' | 'failed';
export type MaterialDecision = 'approved' | 'clarification' | 'rejected';

export interface WizardState {
  bookStep: number;
  service: ServiceType;
  addReturn: boolean;
  selectedOut: string;
  selectedRet: string;
  journeyDate: string;
  returnDate: string;
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
  bookStep: 1, service: 'passenger', addReturn: false, selectedOut: '07:00', selectedRet: '09:30',
  journeyDate: today(), returnDate: today(), chosenDestination: 'Approved Anchorage A (Demo)', paxCount: 1,
  passengerName: '', passengerEmail: '', passengerPhone: '', passengerCompany: '', vessel: '', imo: '',
  formError: '', policyAck: false, accessAck: false, paymentChoice: '', currentBooking: null,
});

const initialBoarding = (): BoardingState => ({
  selectedSailingId: 'S-0700', scanCount: 0, lastScanUsed: false, boardingMessage: null, manualRef: '', manualFound: null,
});

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
  addTicketsToSailing: (time: string, tickets: number) => void;
  suspendSailing: (id: string, reason: string) => void;
  decideMaterial: (id: string, decision: MaterialDecision, reason: string) => void;
  overrideBoarding: (ref: string, reason: string) => void;
  resetDemoData: () => void;
}

const DemoContext = createContext<DemoContextValue | undefined>(undefined);

export function DemoProvider({ children }: { children: ReactNode }) {
  const [sailings, setSailings] = useState(initialSailings);
  const [bookings, setBookings] = useState(initialBookings);
  const [materials, setMaterials] = useState(initialMaterials);
  const [audit, setAudit] = useState(initialAudit);
  const [wizard, setWizard] = useState(initialWizard);
  const [boarding, setBoarding] = useState(initialBoarding);

  const addAudit = useCallback((actor: string, action: string) => {
    setAudit(prev => [...prev, { time: nowTime(), actor, action }]);
  }, []);

  const updateWizard = useCallback((patch: Partial<WizardState>) => setWizard(prev => ({ ...prev, ...patch })), []);
  const resetWizard = useCallback(() => setWizard(initialWizard()), []);
  const updateBoarding = useCallback((patch: Partial<BoardingState>) => setBoarding(prev => ({ ...prev, ...patch })), []);

  const addBooking = useCallback((booking: Booking) => setBookings(prev => [booking, ...prev]), []);
  const addMaterial = useCallback((material: MaterialRequest) => setMaterials(prev => [material, ...prev]), []);

  const addTicketsToSailing = useCallback((time: string, tickets: number) => {
    setSailings(prev => prev.map(s => (s.time === time && s.dir === 'Outbound' ? { ...s, count: s.count + tickets } : s)));
  }, []);

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
    setSailings(initialSailings());
    setBookings(initialBookings());
    setMaterials(initialMaterials());
    setAudit(initialAudit());
    setWizard(initialWizard());
    setBoarding(initialBoarding());
  }, []);

  const value = useMemo<DemoContextValue>(() => ({
    sailings, bookings, materials, audit, wizard, updateWizard, resetWizard, boarding, updateBoarding,
    addAudit, addBooking, addMaterial, addTicketsToSailing, suspendSailing, decideMaterial, overrideBoarding, resetDemoData,
  }), [sailings, bookings, materials, audit, wizard, updateWizard, resetWizard, boarding, updateBoarding,
    addAudit, addBooking, addMaterial, addTicketsToSailing, suspendSailing, decideMaterial, overrideBoarding, resetDemoData]);

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo(): DemoContextValue {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error('useDemo must be used within a DemoProvider');
  return ctx;
}
