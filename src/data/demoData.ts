// Fictional sample data, matching the reference prototype. Destinations and vessels are
// placeholders pending ATCO confirmation — do not replace them with real names.

import type { BoatSlot } from '../domain/fleet';
import { createSeededTickets, type Ticket } from '../domain/tickets';
import { saudiLocalDate, saudiLocalTime, saudiLocalTomorrow } from '../domain/dates';

export const DESTINATIONS = ['Approved Anchorage A (Demo)', 'Offshore Vessel Demo-01'] as const;
export const ORIGIN = 'Ras Tanura Service Pier';

/** Service cities. Only Dammam is enabled for now; add Riyadh/Jeddah here when ATCO confirms them. */
export const CITIES: ReadonlyArray<{ id: string; name: { en: string; ar: string } }> = [
  { id: 'dammam', name: { en: 'Dammam', ar: 'الدمام' } },
];

/**
 * ATCO contact details as listed on the ATCO Group contact page (atcogroup.com/contact-atco),
 * found via web search on 2026-10-18 — the site itself could not be opened from the build environment.
 * Confirm with ATCO before go-live.
 */
export const ATCO_CONTACT = {
  company: { en: 'ATCO Group (A. A. Turki Group)', ar: 'مجموعة أتكو (مجموعة عبدالعزيز التركي)' },
  address: { en: '8069, 4th Street, Prince Muhammad Ibn Saud District, Dammam, Saudi Arabia', ar: '8069، الشارع الرابع، حي الأمير محمد بن سعود، الدمام، المملكة العربية السعودية' },
  phone: '+966 13 833 5588',
  marineEmail: 'marine.info@atco.com.sa',
  website: 'www.atcogroup.com',
} as const;

export interface Boat {
  id: string;
  name: { en: string; ar: string };
}

// Placeholder boats. Replace the names once the client supplies the real boat names.
export const BOATS: readonly Boat[] = [
  { id: 'B-01', name: { en: 'Boat 1 (name pending)', ar: 'القارب 1 (الاسم قيد التأكيد)' } },
  { id: 'B-02', name: { en: 'Boat 2 (name pending)', ar: 'القارب 2 (الاسم قيد التأكيد)' } },
  { id: 'B-03', name: { en: 'Boat 3 (name pending)', ar: 'القارب 3 (الاسم قيد التأكيد)' } },
];

export interface Sailing {
  id: string;
  time: string;
  dest: string;
  count: number;
  minimum: number;
  dir: 'Outbound' | 'Return';
  ops: string;
  manifest: string;
  boatId: string;
}

export interface ReturnLeg {
  date: string;
  time: string;
  dest: string;
  boatId?: string;
}

/** Policy acceptance recorded on each demo booking (Phase 10). */
export interface PolicyAcceptance {
  version: string;
  acceptedAt: string;
}

export interface Booking {
  ref: string;
  date: string;
  leg: string;
  time: string;
  dest: string;
  passengers: number;
  /** Demo-collected passenger names (lead first). Never embedded in QR payloads. */
  passengerNames?: string[];
  /** One ticket per passenger per one-way leg; outbound and return are separate. */
  tickets?: Ticket[];
  amount: number;
  payment: string;
  threshold: string;
  ops: string;
  boarding: string;
  service: string;
  boatId?: string;
  return?: ReturnLeg | null;
  policyAccepted?: PolicyAcceptance | null;
  /** Optional corporate purchase-order reference (demo only). */
  po?: string;
  bookingContact?: string;
}

export interface MaterialRequest {
  id: string;
  name: string;
  qty: string;
  weight: string;
  size: string;
  status: string;
  sender: string;
  receiver: string;
  detail: string;
  /** Demo booking reference this material travels with, when one exists. */
  bookingRef?: string;
  /** Destination vessel, when the request targets one. */
  vessel?: string;
}

export interface AuditEvent {
  time: string;
  actor: string;
  action: string;
}

/** Saudi-local date the demo operates on (never the computer's UTC date). */
export const today = () => saudiLocalDate();
export const nowTime = () => saudiLocalTime();

export function initialSailings(): Sailing[] {
  return [
    { id: 'S-0700', time: '07:00', dest: 'Approved Anchorage A (Demo)', count: 2, minimum: 4, dir: 'Outbound', ops: 'Awaiting approval', manifest: 'Not ready', boatId: 'B-01' },
    { id: 'S-0930', time: '09:30', dest: 'Offshore Vessel Demo-01', count: 4, minimum: 4, dir: 'Outbound', ops: 'Awaiting approval', manifest: 'In preparation', boatId: 'B-02' },
    { id: 'S-1300', time: '13:00', dest: 'Approved Anchorage A (Demo)', count: 4, minimum: 4, dir: 'Outbound', ops: 'Awaiting approval', manifest: 'In preparation', boatId: 'B-01' },
  ];
}

export function initialBookings(): Booking[] {
  const outboundLead = 'Demo Passenger';
  return [
    {
      ref: 'GM-DEMO-0248', date: today(), leg: 'Outbound', time: '07:00', dest: 'Approved Anchorage A (Demo)',
      passengers: 1, passengerNames: [outboundLead], tickets: createSeededTickets({ ref: 'GM-DEMO-0248', leg: 'outbound', count: 1, leadName: outboundLead }),
      amount: 500, payment: 'Payment recorded (demo)', threshold: 'Collecting bookings', ops: 'Awaiting ATCO decision', boarding: 'Not started', service: 'Passenger transfer', boatId: 'B-01',
      policyAccepted: { version: 'gulf-mover-demo-policy-v1', acceptedAt: `${today()} 09:10` },
    },
    {
      ref: 'GM-DEMO-0312', date: today(), leg: 'Return', time: '09:30', dest: 'Offshore Vessel Demo-01',
      passengers: 2, passengerNames: ['Return Demo Passenger', 'Passenger 2'], tickets: createSeededTickets({ ref: 'GM-DEMO-0312', leg: 'return', count: 2, leadName: 'Return Demo Passenger' }),
      amount: 1000, payment: 'Payment pending (demo)', threshold: 'Minimum met (demo)', ops: 'Awaiting ATCO decision', boarding: 'Not started', service: 'Passenger transfer', boatId: 'B-02',
      policyAccepted: { version: 'gulf-mover-demo-policy-v1', acceptedAt: `${today()} 09:15` },
    },
  ];
}

export function initialMaterials(): MaterialRequest[] {
  return [
    { id: 'MR-DEMO-01', name: 'Packaged supplies (demo)', qty: '2 containers', weight: '12 kg (fictional)', size: '40 × 30 × 25 cm (fictional)', status: 'Pending review', sender: 'Demo Logistics Co.', receiver: 'Offshore Vessel Demo-01', detail: 'Fictional sample request for UI review. Item suitability has not been evaluated.', bookingRef: 'GM-DEMO-0312', vessel: 'Offshore Vessel Demo-01' },
    { id: 'MR-DEMO-02', name: 'Equipment case (demo)', qty: '1 case', weight: '8 kg (fictional)', size: '50 × 35 × 20 cm (fictional)', status: 'Clarification required', sender: 'Ship Agent Demo', receiver: 'Approved Anchorage A (Demo)', detail: 'Sample request with missing documentation; no transport is accepted.', vessel: 'Approved Anchorage A (Demo)' },
  ];
}

export function initialAudit(): AuditEvent[] {
  return [
    { time: '09:12', actor: 'Demo operations user', action: 'Opened prototype dashboard' },
    { time: '09:16', actor: 'Prototype', action: 'Illustrative sample record loaded' },
  ];
}

const tomorrow = () => saudiLocalTomorrow();

/** Fictional boat bookings: shared scheduled sailings and whole-boat charters. */
export function initialBoatSlots(): BoatSlot[] {
  return [
    { id: 'BS-001', boatId: 'B-01', date: today(), time: '07:00', kind: 'scheduled', passengers: 2, refs: ['GM-DEMO-0248', 'GM-DEMO-0175'], holder: 'Shared scheduled sailing', status: 'Seats booked (demo)' },
    { id: 'BS-002', boatId: 'B-02', date: today(), time: '09:30', kind: 'scheduled', passengers: 4, refs: ['GM-DEMO-0312', 'GM-DEMO-0290'], holder: 'Shared scheduled sailing', status: 'Seats booked (demo)' },
    { id: 'BS-003', boatId: 'B-01', date: today(), time: '13:00', kind: 'scheduled', passengers: 4, refs: ['GM-DEMO-0330'], holder: 'Shared scheduled sailing', status: 'Seats booked (demo)' },
    { id: 'BS-004', boatId: 'B-03', date: today(), time: '13:00', kind: 'charter', passengers: 6, refs: ['CH-DEMO-0007'], holder: 'Demo Charter Client (fictional)', status: 'Reserved — pending ATCO approval' },
    { id: 'BS-005', boatId: 'B-02', date: tomorrow(), time: '16:00', kind: 'charter', passengers: 3, refs: ['CH-DEMO-0008'], holder: 'Ship Agent Demo', status: 'Charter approved (demo)' },
  ];
}
