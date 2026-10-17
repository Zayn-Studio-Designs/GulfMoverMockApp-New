// Fictional sample data, matching the reference prototype. Destinations and vessels are
// placeholders pending ATCO confirmation — do not replace them with real names.

export const DESTINATIONS = ['Approved Anchorage A (Demo)', 'Offshore Vessel Demo-01'] as const;
export const ORIGIN = 'Ras Tanura Service Pier';

export interface Sailing {
  id: string;
  time: string;
  dest: string;
  count: number;
  minimum: number;
  dir: 'Outbound' | 'Return';
  ops: string;
  manifest: string;
}

export interface ReturnLeg {
  date: string;
  time: string;
  dest: string;
}

export interface Booking {
  ref: string;
  date: string;
  leg: string;
  time: string;
  dest: string;
  passengers: number;
  amount: number;
  payment: string;
  threshold: string;
  ops: string;
  boarding: string;
  service: string;
  return?: ReturnLeg | null;
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
}

export interface AuditEvent {
  time: string;
  actor: string;
  action: string;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function initialSailings(): Sailing[] {
  return [
    { id: 'S-0700', time: '07:00', dest: 'Approved Anchorage A (Demo)', count: 2, minimum: 4, dir: 'Outbound', ops: 'Awaiting approval', manifest: 'Not ready' },
    { id: 'S-0930', time: '09:30', dest: 'Offshore Vessel Demo-01', count: 4, minimum: 4, dir: 'Outbound', ops: 'Awaiting approval', manifest: 'In preparation' },
    { id: 'S-1300', time: '13:00', dest: 'Approved Anchorage A (Demo)', count: 4, minimum: 4, dir: 'Outbound', ops: 'Awaiting approval', manifest: 'In preparation' },
  ];
}

export function initialBookings(): Booking[] {
  return [
    { ref: 'GM-DEMO-0248', date: today(), leg: 'Outbound', time: '07:00', dest: 'Approved Anchorage A (Demo)', passengers: 1, amount: 500, payment: 'Payment recorded (demo)', threshold: 'Collecting bookings', ops: 'Awaiting ATCO decision', boarding: 'Not started', service: 'Passenger transfer' },
    { ref: 'GM-DEMO-0312', date: today(), leg: 'Return', time: '09:30', dest: 'Offshore Vessel Demo-01', passengers: 2, amount: 1000, payment: 'Payment pending (demo)', threshold: 'Minimum met (demo)', ops: 'Awaiting ATCO decision', boarding: 'Not started', service: 'Passenger transfer' },
  ];
}

export function initialMaterials(): MaterialRequest[] {
  return [
    { id: 'MR-DEMO-01', name: 'Packaged supplies (demo)', qty: '2 containers', weight: '12 kg (fictional)', size: '40 × 30 × 25 cm (fictional)', status: 'Pending review', sender: 'Demo Logistics Co.', receiver: 'Offshore Vessel Demo-01', detail: 'Fictional sample request for UI review. Item suitability has not been evaluated.' },
    { id: 'MR-DEMO-02', name: 'Equipment case (demo)', qty: '1 case', weight: '8 kg (fictional)', size: '50 × 35 × 20 cm (fictional)', status: 'Clarification required', sender: 'Ship Agent Demo', receiver: 'Approved Anchorage A (Demo)', detail: 'Sample request with missing documentation; no transport is accepted.' },
  ];
}

export function initialAudit(): AuditEvent[] {
  return [
    { time: '09:12', actor: 'Demo operations user', action: 'Opened prototype dashboard' },
    { time: '09:16', actor: 'Prototype', action: 'Illustrative sample record loaded' },
  ];
}
