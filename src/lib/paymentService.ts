import type { EnvSource } from './supabase';
import { DataServiceError, requireDataClient, requireSessionUser, run } from './dataService';

/** Sandbox-only payments. No card data is ever collected; the server is the only proof. */

export type PaymentMethod = 'mada' | 'visa' | 'mastercard' | 'apple_pay' | 'bank_transfer' | 'sandbox';
export type PaymentStatus = 'initiated' | 'pending' | 'succeeded' | 'failed' | 'refunded' | 'partially_refunded';

export interface Payment {
  readonly id: string;
  readonly bookingId: string;
  readonly amountHalala: number;
  readonly currency: string;
  readonly method: PaymentMethod;
  readonly providerRef: string | null;
  readonly status: PaymentStatus;
  readonly sandbox: boolean;
}

export interface Invoice {
  readonly id: string;
  readonly bookingId: string;
  readonly invoiceNumber: string;
  readonly amountHalala: number;
  readonly vatHalala: number;
  readonly currency: string;
  readonly status: string;
  readonly zatcaStatus: string;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown) => (typeof v === 'string' ? v : '');

function toPayment(row: Record<string, unknown>): Payment {
  if (typeof row.id !== 'string' || typeof row.booking_id !== 'string') throw new DataServiceError('unexpected-response');
  const method = s(row.method);
  const status = s(row.status);
  const methods: PaymentMethod[] = ['mada', 'visa', 'mastercard', 'apple_pay', 'bank_transfer', 'sandbox'];
  const statuses: PaymentStatus[] = ['initiated', 'pending', 'succeeded', 'failed', 'refunded', 'partially_refunded'];
  if (!methods.includes(method as PaymentMethod) || !statuses.includes(status as PaymentStatus)) {
    throw new DataServiceError('unexpected-response');
  }
  return {
    id: row.id, bookingId: row.booking_id as string, amountHalala: n(row.amount_halala),
    currency: s(row.currency) || 'SAR', method: method as PaymentMethod,
    providerRef: typeof row.provider_ref === 'string' ? row.provider_ref : null,
    status: status as PaymentStatus, sandbox: row.sandbox !== false,
  };
}

/** Start a sandbox payment for a booking. Returns the payment id; never a proof of payment. */
export async function initiatePayment(bookingId: string, method: PaymentMethod, env?: EnvSource): Promise<string> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.rpc('initiate_payment', { p_booking_id: bookingId, p_method: method }));
  if (typeof data !== 'string' || !data) throw new DataServiceError('unexpected-response');
  return data;
}

/** List sandbox payments visible to the caller for one booking. */
export async function listBookingPayments(bookingId: string, env?: EnvSource): Promise<Payment[]> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.from('payments')
    .select('id, booking_id, amount_halala, currency, method, provider_ref, status, sandbox')
    .eq('booking_id', bookingId).order('created_at', { ascending: false }).limit(50));
  return (Array.isArray(data) ? data as Record<string, unknown>[] : []).map(toPayment);
}

/** List invoices visible to the caller for one booking. */
export async function listBookingInvoices(bookingId: string, env?: EnvSource): Promise<Invoice[]> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.from('invoices')
    .select('id, booking_id, invoice_number, amount_halala, vat_halala, currency, status, zatca_status')
    .eq('booking_id', bookingId).order('created_at', { ascending: false }).limit(50));
  return (Array.isArray(data) ? data as Record<string, unknown>[] : []).map(row => ({
    id: s(row.id), bookingId: s(row.booking_id), invoiceNumber: s(row.invoice_number),
    amountHalala: n(row.amount_halala), vatHalala: n(row.vat_halala), currency: s(row.currency) || 'SAR',
    status: s(row.status), zatcaStatus: s(row.zatca_status),
  }));
}

export interface OccupancyRow {
  readonly sailingId: string;
  readonly departsAt: string;
  readonly origin: string;
  readonly destination: string;
  readonly seatCapacity: number;
  readonly seatsBooked: number;
  readonly ticketCount: number;
  readonly thresholdMet: boolean;
}

/** Staff-only occupancy report (server-enforced roles). */
export async function reportSailingOccupancy(from: string, to: string, env?: EnvSource): Promise<OccupancyRow[]> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.rpc('report_sailing_occupancy', { p_from: from, p_to: to }));
  return (Array.isArray(data) ? data as Record<string, unknown>[] : []).map(row => ({
    sailingId: s(row.sailing_id), departsAt: s(row.departs_at), origin: s(row.origin), destination: s(row.destination),
    seatCapacity: n(row.seat_capacity), seatsBooked: n(row.seats_booked),
    ticketCount: n(row.ticket_count), thresholdMet: row.threshold_met === true,
  }));
}

export interface RevenueRow {
  readonly sailingId: string;
  readonly departsAt: string;
  readonly bookings: number;
  readonly passengers: number;
  readonly collectedHalala: number;
  readonly refundedHalala: number;
}

/** Staff-only revenue report (sandbox payments only). */
export async function reportRevenueBySailing(from: string, to: string, env?: EnvSource): Promise<RevenueRow[]> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.rpc('report_revenue_by_sailing', { p_from: from, p_to: to }));
  return (Array.isArray(data) ? data as Record<string, unknown>[] : []).map(row => ({
    sailingId: s(row.sailing_id), departsAt: s(row.departs_at), bookings: n(row.bookings),
    passengers: n(row.passengers), collectedHalala: n(row.collected_halala), refundedHalala: n(row.refunded_halala),
  }));
}
