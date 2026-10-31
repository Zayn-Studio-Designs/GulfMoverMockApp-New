import type { EnvSource } from './supabase';
import { getAppConfig } from './supabase';
import { DataServiceError, requireDataClient, requireSessionUser, run } from './dataService';

/**
 * Phase 8 client services: checkout + payments, invoices/credit notes/refunds,
 * booking lifecycle, operations control, finance administration, reports,
 * notification preferences, privacy and MFA posture.
 *
 * Every write is a database RPC that re-checks identity, role, state and money
 * server-side. The browser never sends a price, VAT amount, payment status or
 * user id; a payment is "paid" only after a verified server-side result.
 */

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : 0);
const nn = (v: unknown) => (v === null || v === undefined ? null : n(v));
const b = (v: unknown) => v === true;

async function rpcRows(name: string, args: Row = {}, env?: EnvSource): Promise<Row[]> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.rpc(name, args));
  if (Array.isArray(data)) return data as Row[];
  return data && typeof data === 'object' ? [data as Row] : [];
}

async function rpcValue(name: string, args: Row = {}, env?: EnvSource): Promise<unknown> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.rpc(name, args));
  return data;
}

async function select(table: string, columns: string, apply: (q: any) => any, env?: EnvSource): Promise<Row[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(apply(client.from(table).select(columns)));
  return Array.isArray(data) ? data as Row[] : data && typeof data === 'object' ? [data as Row] : [];
}

/* ------------------------------- pricing -------------------------------- */

export interface FareQuote {
  readonly tariffCode: string;
  readonly tariffStatus: 'provisional' | 'approved';
  readonly unitHalala: number;
  readonly quantity: number;
  readonly netHalala: number;
  readonly vatHalala: number;
  readonly totalHalala: number;
  readonly vatMode: string;
  readonly vatRateBp: number;
}

export async function quoteFare(outboundSailingId: string, returnSailingId: string | null, passengers: number, env?: EnvSource): Promise<FareQuote> {
  const [r] = await rpcRows('quote_passenger_fare', { p_outbound_sailing_id: outboundSailingId, p_return_sailing_id: returnSailingId, p_passenger_count: passengers }, env);
  if (!r) throw new DataServiceError('unexpected-response');
  return {
    tariffCode: s(r.tariff_code), tariffStatus: r.tariff_status === 'approved' ? 'approved' : 'provisional',
    unitHalala: n(r.unit_halala), quantity: n(r.quantity), netHalala: n(r.net_halala), vatHalala: n(r.vat_halala),
    totalHalala: n(r.total_halala), vatMode: s(r.vat_mode), vatRateBp: n(r.vat_rate_bp),
  };
}

export interface BookingTerms { readonly version: string; readonly title: { en: string; ar: string }; readonly body: { en: string; ar: string }; readonly status: string }

export async function currentBookingTerms(env?: EnvSource): Promise<BookingTerms> {
  const rows = await select('service_policies', 'version, content, status', q => q.eq('policy_type', 'booking_terms').in('status', ['approved', 'provisional'])
    .order('effective_from', { ascending: false }).limit(5), env);
  const row = rows.find(r => r.status === 'approved') ?? rows[0];
  if (!row) throw new DataServiceError('not-deployed');
  const c = (row.content ?? {}) as { title?: { en?: string; ar?: string }; body?: { en?: string; ar?: string } };
  return { version: s(row.version), status: s(row.status),
    title: { en: c.title?.en ?? '', ar: c.title?.ar ?? c.title?.en ?? '' }, body: { en: c.body?.en ?? '', ar: c.body?.ar ?? c.body?.en ?? '' } };
}

export interface OrgCommercial { readonly id: string; readonly accountType: 'corporate' | 'agent'; readonly creditStatus: 'none' | 'active' | 'on_hold' }

export async function organizationCommercial(ids: readonly string[], env?: EnvSource): Promise<OrgCommercial[]> {
  if (ids.length === 0) return [];
  const rows = await select('organizations', 'id, account_type, credit_status', q => q.in('id', ids as string[]), env);
  return rows.map(r => ({ id: s(r.id), accountType: r.account_type === 'agent' ? 'agent' : 'corporate',
    creditStatus: r.credit_status === 'active' ? 'active' : r.credit_status === 'on_hold' ? 'on_hold' : 'none' }));
}

/* ------------------------------- booking -------------------------------- */

export interface NewBooking {
  readonly mode: 'individual' | 'organization';
  readonly organizationId: string;
  readonly settlementMode: 'pay_now' | 'on_account';
  readonly outboundSailingId: string;
  readonly returnSailingId: string | null;
  readonly passengerCount: number;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly extraPassengerNames: readonly string[];
  readonly poReference: string;
  readonly clientName: string;
  readonly clientReference: string;
  readonly destinationVessel: string;
  readonly destinationImo: string;
  readonly termsVersion: string;
}

export interface BookingCreated { readonly bookingId: string; readonly reference: string; readonly outcome: 'created' | 'replayed' }

export async function createBookingV2(input: NewBooking, requestKey: string, env?: EnvSource): Promise<BookingCreated> {
  const extras = input.extraPassengerNames.map(v => v.trim()).filter(Boolean);
  const common = {
    p_request_key: requestKey, p_outbound_sailing_id: input.outboundSailingId, p_passenger_count: input.passengerCount,
    p_contact_name: input.contactName.trim(), p_contact_email: input.contactEmail.trim().toLowerCase(), p_contact_phone: input.contactPhone.trim(),
    p_passenger_names: extras.length ? extras : null, p_return_sailing_id: input.returnSailingId,
    p_destination_vessel: input.destinationVessel.trim() || null, p_destination_imo: input.destinationImo.trim().toUpperCase() || null,
    p_terms_version: input.termsVersion,
  };
  const rows = input.mode === 'individual'
    ? await rpcRows('create_individual_booking', common, env)
    : await rpcRows('create_organization_booking', {
      ...common, p_organization_id: input.organizationId, p_settlement_mode: input.settlementMode,
      p_po_reference: input.poReference.trim() || null, p_client_name: input.clientName.trim() || null,
      p_client_reference: input.clientReference.trim() || null, p_permit_status: null,
    }, env);
  const r = rows[0];
  if (!r || typeof r.booking_id !== 'string' || typeof r.reference !== 'string') throw new DataServiceError('unexpected-response');
  return { bookingId: r.booking_id, reference: r.reference, outcome: r.outcome === 'replayed' ? 'replayed' : 'created' };
}

export type BookingStatusV2 = 'reserved' | 'pending_payment' | 'paid' | 'cancelled' | 'refunded' | 'rescheduled' | 'expired';
export type PaymentStatusV2 = 'unpaid' | 'pending' | 'paid' | 'on_account' | 'refunded' | 'partially_refunded';

export interface BookingCommercial {
  readonly id: string;
  readonly status: BookingStatusV2;
  readonly paymentStatus: PaymentStatusV2;
  readonly settlementMode: 'pay_now' | 'on_account';
  readonly accountType: 'individual' | 'corporate' | 'agent';
  readonly netHalala: number;
  readonly vatHalala: number;
  readonly totalHalala: number;
  readonly vatMode: string;
  readonly tariffStatus: string;
  readonly holdExpiresAt: string | null;
  readonly clientName: string | null;
  readonly termsVersion: string | null;
  readonly cancelReason: string | null;
}

export async function bookingCommercial(bookingId: string, env?: EnvSource): Promise<BookingCommercial | null> {
  const [r] = await select('bookings', 'id, status, payment_status, settlement_mode, account_type, net_halala, vat_halala, total_halala, vat_mode, tariff_status, hold_expires_at, client_name, terms_version, cancel_reason',
    q => q.eq('id', bookingId).limit(1), env);
  if (!r) return null;
  return {
    id: s(r.id), status: s(r.status) as BookingStatusV2, paymentStatus: s(r.payment_status) as PaymentStatusV2,
    settlementMode: r.settlement_mode === 'on_account' ? 'on_account' : 'pay_now',
    accountType: (['individual', 'corporate', 'agent'].includes(s(r.account_type)) ? s(r.account_type) : 'corporate') as BookingCommercial['accountType'],
    netHalala: n(r.net_halala), vatHalala: n(r.vat_halala), totalHalala: n(r.total_halala), vatMode: s(r.vat_mode) || 'not_configured',
    tariffStatus: s(r.tariff_status), holdExpiresAt: typeof r.hold_expires_at === 'string' ? r.hold_expires_at : null,
    clientName: typeof r.client_name === 'string' ? r.client_name : null, termsVersion: typeof r.terms_version === 'string' ? r.terms_version : null,
    cancelReason: typeof r.cancel_reason === 'string' ? r.cancel_reason : null,
  };
}

export interface BookingEvent { readonly action: string; readonly createdAt: string; readonly details: Row }

export async function bookingEvents(bookingId: string, env?: EnvSource): Promise<BookingEvent[]> {
  const rows = await select('booking_events', 'action, created_at, details', q => q.eq('booking_id', bookingId).order('created_at', { ascending: true }).limit(100), env);
  return rows.map(r => ({ action: s(r.action), createdAt: s(r.created_at), details: (r.details ?? {}) as Row }));
}

export async function cancelBookingV2(bookingId: string, reason: string, env?: EnvSource): Promise<string> {
  return s(await rpcValue('cancel_booking', { p_booking_id: bookingId, p_reason: reason.trim() }, env));
}

export async function rescheduleLeg(bookingId: string, leg: 'outbound' | 'return', newSailingId: string, reason: string, env?: EnvSource): Promise<string> {
  return s(await rpcValue('reschedule_booking_leg', { p_booking_id: bookingId, p_leg: leg, p_new_sailing_id: newSailingId, p_reason: reason.trim() }, env));
}

export interface CommercialStatus {
  readonly reservedTickets: number;
  readonly qualifyingTickets: number;
  readonly qualifyingRevenueHalala: number;
  readonly thresholdTickets: number;
  readonly thresholdRevenueHalala: number;
  readonly thresholdMet: boolean;
  readonly confirmationDeadline: string;
  readonly state: 'awaiting_minimum' | 'threshold_met' | 'below_minimum_after_deadline' | 'proceed_below_minimum';
}

const toCommercial = (r: Row): CommercialStatus => ({
  reservedTickets: n(r.reserved_tickets), qualifyingTickets: n(r.qualifying_tickets), qualifyingRevenueHalala: n(r.qualifying_revenue_halala),
  thresholdTickets: n(r.threshold_tickets), thresholdRevenueHalala: n(r.threshold_revenue_halala), thresholdMet: b(r.threshold_met),
  confirmationDeadline: s(r.confirmation_deadline), state: s(r.commercial_state) as CommercialStatus['state'],
});

export async function sailingCommercialStatus(sailingId: string, env?: EnvSource): Promise<CommercialStatus> {
  const [r] = await rpcRows('sailing_commercial_status', { p_sailing_id: sailingId }, env);
  if (!r) throw new DataServiceError('unexpected-response');
  return toCommercial(r);
}

export async function sailingGate(sailingId: string, env?: EnvSource): Promise<string> {
  return s(await rpcValue('sailing_boarding_gate', { p_sailing_id: sailingId }, env));
}

export interface SailingStatus { readonly commercial: CommercialStatus; readonly gate: string }

/** Largest id list the database accepts per `sailing_control_status` call. */
export const SAILING_STATUS_BATCH = 500;

/**
 * Minimum-sailing status AND boarding gate for many sailings in one round trip
 * per 500 sailings — never one request per sailing (the N+1 pattern). Sailings
 * the caller cannot see or that do not exist are simply absent from the map.
 */
export async function sailingControlStatus(sailingIds: readonly string[], env?: EnvSource): Promise<Map<string, SailingStatus>> {
  const ids = [...new Set(sailingIds.filter(Boolean))];
  const out = new Map<string, SailingStatus>();
  for (let i = 0; i < ids.length; i += SAILING_STATUS_BATCH) {
    const rows = await rpcRows('sailing_control_status', { p_sailing_ids: ids.slice(i, i + SAILING_STATUS_BATCH) }, env);
    for (const r of rows) out.set(s(r.sailing_id), { commercial: toCommercial(r), gate: s(r.boarding_gate) });
  }
  return out;
}

/* ------------------------------- payments ------------------------------- */

export type PaymentMethodV2 = 'mada' | 'visa' | 'mastercard' | 'apple_pay';

export interface CheckoutStart { readonly paymentId: string; readonly amountHalala: number; readonly mode: 'sandbox' | 'live'; readonly checkoutUrl: string | null }

/**
 * Starts a checkout. With a deployed payments edge function (VITE_PAYMENTS_FUNCTION_URL)
 * the browser is sent to the provider's hosted page; otherwise only the sandbox path
 * exists locally and the database refuses anything but sandbox mode.
 */
export async function startCheckout(bookingId: string, method: PaymentMethodV2, idempotencyKey: string, env?: EnvSource): Promise<CheckoutStart> {
  const fnUrl = (import.meta.env?.VITE_PAYMENTS_FUNCTION_URL as string | undefined) ?? '';
  if (fnUrl) {
    const config = getAppConfig(env);
    if (config.mode === 'demo' || 'error' in config) throw new DataServiceError('unavailable');
    const { data } = await config.supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new DataServiceError('not-authenticated');
    let res: Response;
    try {
      res = await fetch(`${fnUrl.replace(/\/$/, '')}/checkout`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId, method, idempotencyKey }) });
    } catch { throw new DataServiceError('network'); }
    const body = await res.json().catch(() => ({})) as Row;
    if (!res.ok || typeof body.payment_id !== 'string') throw new DataServiceError(res.status >= 500 ? 'server' : 'invalid-transition');
    const url = typeof body.checkout_url === 'string' && /^https:\/\//.test(body.checkout_url) ? body.checkout_url : null;
    return { paymentId: body.payment_id, amountHalala: 0, mode: body.mode === 'live' ? 'live' : 'sandbox', checkoutUrl: url };
  }
  const [r] = await rpcRows('begin_checkout', { p_booking_id: bookingId, p_method: method, p_idempotency_key: idempotencyKey }, env);
  if (!r || typeof r.payment_id !== 'string') throw new DataServiceError('unexpected-response');
  return { paymentId: r.payment_id, amountHalala: n(r.amount_halala), mode: r.mode === 'live' ? 'live' : 'sandbox', checkoutUrl: null };
}

/** SANDBOX ONLY: stands in for the provider's hosted page. Refused by the database in live mode. */
export async function simulateSandboxPayment(paymentId: string, outcome: 'paid' | 'failed', env?: EnvSource): Promise<string> {
  return s(await rpcValue('sandbox_simulate_payment', { p_payment_id: paymentId, p_outcome: outcome }, env));
}

export interface PaymentV2 {
  readonly id: string; readonly amountHalala: number; readonly refundedHalala: number; readonly method: string; readonly status: string;
  readonly mode: 'sandbox' | 'live'; readonly providerRef: string | null; readonly createdAt: string; readonly verifiedVia: string | null;
}

export async function listPaymentsV2(bookingId: string, env?: EnvSource): Promise<PaymentV2[]> {
  const rows = await select('payments', 'id, amount_halala, refunded_halala, method, status, mode, provider_ref, created_at, verified_via',
    q => q.eq('booking_id', bookingId).order('created_at', { ascending: false }).limit(20), env);
  return rows.map(r => ({ id: s(r.id), amountHalala: n(r.amount_halala), refundedHalala: n(r.refunded_halala), method: s(r.method), status: s(r.status),
    mode: r.mode === 'live' ? 'live' : 'sandbox', providerRef: typeof r.provider_ref === 'string' ? r.provider_ref : null, createdAt: s(r.created_at),
    verifiedVia: typeof r.verified_via === 'string' ? r.verified_via : null }));
}

export interface InvoiceLine { readonly lineNo: number; readonly description: string; readonly quantity: number; readonly unitHalala: number; readonly netHalala: number; readonly vatRateBp: number; readonly vatHalala: number; readonly totalHalala: number }
export interface InvoiceV2 {
  readonly id: string; readonly invoiceNumber: string; readonly documentType: string; readonly status: string; readonly settlementMode: string;
  readonly issueDate: string; readonly dueDate: string | null; readonly netHalala: number; readonly vatHalala: number; readonly totalHalala: number;
  readonly amountPaidHalala: number; readonly sandbox: boolean; readonly buyer: Row; readonly seller: Row; readonly qrTlv: string | null;
  readonly icv: number | null; readonly invoiceHash: string | null; readonly lines: readonly InvoiceLine[]; readonly bookingReference: string;
}

const INVOICE_SELECT = 'id, invoice_number, document_type, status, settlement_mode, issue_date, due_date, net_halala, vat_halala, total_halala, amount_paid_halala, sandbox, buyer, seller, qr_tlv, icv, invoice_hash, booking:bookings(reference), invoice_lines(line_no, description, quantity, unit_halala, net_halala, vat_rate_bp, vat_halala, total_halala)';

function toInvoice(r: Row): InvoiceV2 {
  const lines = Array.isArray(r.invoice_lines) ? r.invoice_lines as Row[] : [];
  const booking = (Array.isArray(r.booking) ? r.booking[0] : r.booking) as Row | null;
  return {
    id: s(r.id), invoiceNumber: s(r.invoice_number), documentType: s(r.document_type), status: s(r.status), settlementMode: s(r.settlement_mode),
    issueDate: s(r.issue_date), dueDate: typeof r.due_date === 'string' ? r.due_date : null, netHalala: n(r.net_halala), vatHalala: n(r.vat_halala),
    totalHalala: n(r.total_halala), amountPaidHalala: n(r.amount_paid_halala), sandbox: b(r.sandbox), buyer: (r.buyer ?? {}) as Row, seller: (r.seller ?? {}) as Row,
    qrTlv: typeof r.qr_tlv === 'string' ? r.qr_tlv : null, icv: nn(r.icv), invoiceHash: typeof r.invoice_hash === 'string' ? r.invoice_hash : null,
    bookingReference: s(booking?.reference),
    lines: lines.map(l => ({ lineNo: n(l.line_no), description: s(l.description), quantity: n(l.quantity), unitHalala: n(l.unit_halala), netHalala: n(l.net_halala),
      vatRateBp: n(l.vat_rate_bp), vatHalala: n(l.vat_halala), totalHalala: n(l.total_halala) })).sort((a, c) => a.lineNo - c.lineNo),
  };
}

export async function listInvoicesForBooking(bookingId: string, env?: EnvSource): Promise<InvoiceV2[]> {
  return (await select('invoices', INVOICE_SELECT, q => q.eq('booking_id', bookingId).limit(5), env)).map(toInvoice);
}

export async function listRecentInvoices(filter: { status?: string; settlementMode?: string }, env?: EnvSource): Promise<InvoiceV2[]> {
  return (await select('invoices', INVOICE_SELECT, q => {
    let query = q.order('created_at', { ascending: false }).limit(100);
    if (filter.status) query = query.eq('status', filter.status);
    if (filter.settlementMode) query = query.eq('settlement_mode', filter.settlementMode);
    return query;
  }, env)).map(toInvoice);
}

export interface CreditNote { readonly id: string; readonly creditNumber: string; readonly totalHalala: number; readonly vatHalala: number; readonly reason: string; readonly createdAt: string; readonly sandbox: boolean }

export async function listCreditNotes(bookingId: string, env?: EnvSource): Promise<CreditNote[]> {
  const rows = await select('credit_notes', 'id, credit_number, total_halala, vat_halala, reason, created_at, sandbox', q => q.eq('booking_id', bookingId).order('created_at').limit(20), env);
  return rows.map(r => ({ id: s(r.id), creditNumber: s(r.credit_number), totalHalala: n(r.total_halala), vatHalala: n(r.vat_halala), reason: s(r.reason), createdAt: s(r.created_at), sandbox: b(r.sandbox) }));
}

export interface Refund { readonly id: string; readonly bookingId: string; readonly paymentId: string; readonly amountHalala: number; readonly reason: string; readonly status: string; readonly requestedAt: string; readonly sandbox: boolean; readonly bookingReference: string }

export async function listRefunds(filter: { bookingId?: string; status?: string }, env?: EnvSource): Promise<Refund[]> {
  const rows = await select('refunds', 'id, booking_id, payment_id, amount_halala, reason, status, requested_at, sandbox, booking:bookings(reference)', q => {
    let query = q.order('requested_at', { ascending: false }).limit(100);
    if (filter.bookingId) query = query.eq('booking_id', filter.bookingId);
    if (filter.status) query = query.eq('status', filter.status);
    return query;
  }, env);
  return rows.map(r => {
    const booking = (Array.isArray(r.booking) ? r.booking[0] : r.booking) as Row | null;
    return { id: s(r.id), bookingId: s(r.booking_id), paymentId: s(r.payment_id), amountHalala: n(r.amount_halala), reason: s(r.reason), status: s(r.status),
      requestedAt: s(r.requested_at), sandbox: b(r.sandbox), bookingReference: s(booking?.reference) };
  });
}

export const decideRefund = async (refundId: string, decision: 'approve' | 'reject', reason: string, env?: EnvSource) =>
  s(await rpcValue('decide_refund', { p_refund_id: refundId, p_decision: decision, p_reason: reason.trim() }, env));
export const requestRefund = async (paymentId: string, amountHalala: number, reason: string, env?: EnvSource) =>
  s(await rpcValue('request_refund', { p_payment_id: paymentId, p_amount_halala: amountHalala, p_reason: reason.trim() }, env));
export const recordAccountPayment = async (invoiceId: string, amountHalala: number, bankReference: string, env?: EnvSource) =>
  s(await rpcValue('record_account_payment', { p_invoice_id: invoiceId, p_amount_halala: amountHalala, p_bank_reference: bankReference.trim() }, env));

/* ------------------------------ finance admin ---------------------------- */

export interface TariffRow { readonly id: string; readonly code: string; readonly perPersonHalala: number; readonly vatMode: string; readonly vatRateBp: number; readonly approvalStatus: string; readonly active: boolean; readonly effectiveFrom: string }

export async function listTariffs(env?: EnvSource): Promise<TariffRow[]> {
  const rows = await select('tariffs', 'id, code, per_person_halala, vat_mode, vat_rate_bp, approval_status, active, effective_from', q => q.order('effective_from', { ascending: false }).limit(50), env);
  return rows.map(r => ({ id: s(r.id), code: s(r.code), perPersonHalala: n(r.per_person_halala), vatMode: s(r.vat_mode), vatRateBp: n(r.vat_rate_bp),
    approvalStatus: s(r.approval_status), active: b(r.active), effectiveFrom: s(r.effective_from) }));
}
export const publishTariff = async (input: { code: string; perPersonHalala: number; vatMode: string; vatRateBp: number | null; effectiveFrom: string; reason: string }, env?: EnvSource) =>
  s(await rpcValue('publish_tariff', { p_code: input.code, p_per_person_halala: input.perPersonHalala, p_vat_mode: input.vatMode, p_vat_rate_bp: input.vatRateBp,
    p_effective_from: input.effectiveFrom, p_route_id: null, p_notes: null, p_reason: input.reason }, env));
export const approveTariff = async (id: string, reason: string, env?: EnvSource) => s(await rpcValue('approve_tariff', { p_tariff_id: id, p_reason: reason }, env));
export const retireTariff = async (id: string, reason: string, env?: EnvSource) => s(await rpcValue('retire_tariff', { p_tariff_id: id, p_reason: reason }, env));

export interface SettingRow { readonly key: string; readonly value: unknown; readonly description: string; readonly updatedAt: string }
export async function listSettings(env?: EnvSource): Promise<SettingRow[]> {
  const rows = await select('platform_settings', 'key, value, description, updated_at', q => q.order('key').limit(100), env);
  return rows.map(r => ({ key: s(r.key), value: (r.value as Row | null)?.value, description: s(r.description), updatedAt: s(r.updated_at) }));
}
export const updateSetting = async (key: string, value: unknown, reason: string, env?: EnvSource) =>
  s(await rpcValue('update_platform_setting', { p_key: key, p_value: { value }, p_reason: reason }, env));

export interface PolicyRow { readonly policyType: string; readonly version: string; readonly status: string; readonly content: Row }
export async function listPolicies(env?: EnvSource): Promise<PolicyRow[]> {
  const rows = await select('service_policies', 'policy_type, version, status, content', q => q.order('policy_type').order('effective_from', { ascending: false }).limit(100), env);
  return rows.map(r => ({ policyType: s(r.policy_type), version: s(r.version), status: s(r.status), content: (r.content ?? {}) as Row }));
}
export const setPolicyStatus = async (policyType: string, version: string, status: string, reason: string, env?: EnvSource) =>
  s(await rpcValue('set_policy_status', { p_policy_type: policyType, p_version: version, p_status: status, p_reason: reason }, env));

export interface CreditRow { readonly organizationId: string; readonly legalName: string; readonly accountType: string; readonly creditStatus: string; readonly creditLimitHalala: number | null; readonly paymentTermsDays: number | null; readonly outstandingHalala: number; readonly overdueHalala: number; readonly availableHalala: number; readonly openInvoices: number }
export async function reportOutstandingBalances(env?: EnvSource): Promise<CreditRow[]> {
  return (await rpcRows('report_outstanding_balances', {}, env)).map(r => ({ organizationId: s(r.organization_id), legalName: s(r.legal_name), accountType: s(r.account_type),
    creditStatus: s(r.credit_status), creditLimitHalala: nn(r.credit_limit_halala), paymentTermsDays: nn(r.payment_terms_days), outstandingHalala: n(r.outstanding_halala),
    overdueHalala: n(r.overdue_halala), availableHalala: n(r.available_halala), openInvoices: n(r.open_invoices) }));
}
export async function listApprovedOrganizations(env?: EnvSource): Promise<Array<{ id: string; name: string; accountType: string; creditStatus: string; creditLimitHalala: number | null; paymentTermsDays: number | null }>> {
  const rows = await select('organizations', 'id, legal_name, display_name, account_type, credit_status, credit_limit_halala, payment_terms_days', q => q.eq('status', 'approved').order('legal_name').limit(200), env);
  return rows.map(r => ({ id: s(r.id), name: s(r.display_name) || s(r.legal_name), accountType: s(r.account_type), creditStatus: s(r.credit_status),
    creditLimitHalala: nn(r.credit_limit_halala), paymentTermsDays: nn(r.payment_terms_days) }));
}
export async function setCreditTerms(orgId: string, limitHalala: number | null, termsDays: number | null, env?: EnvSource): Promise<void> {
  await rpcValue('set_organization_credit', { p_org: orgId, p_credit_limit_halala: limitHalala, p_payment_terms_days: termsDays }, env);
}
export const setCreditStatus = async (orgId: string, status: 'none' | 'active' | 'on_hold', reason: string, env?: EnvSource) =>
  s(await rpcValue('set_credit_status', { p_org: orgId, p_status: status, p_reason: reason }, env));
export const setAccountType = async (orgId: string, accountType: 'corporate' | 'agent', env?: EnvSource) =>
  rpcValue('set_organization_account_type', { p_org: orgId, p_account_type: accountType }, env);

export interface SettlementRow { readonly id: string; readonly agentOrganizationId: string; readonly periodStart: string; readonly periodEnd: string; readonly status: string; readonly grossHalala: number; readonly vatHalala: number; readonly refundsHalala: number; readonly paymentChargesHalala: number; readonly netRevenueHalala: number; readonly commissionHalala: number; readonly adjustmentsHalala: number; readonly netDueHalala: number; readonly commissionStatus: string; readonly trips: number; readonly passengers: number; readonly paymentReference: string | null }
export async function listSettlements(env?: EnvSource): Promise<SettlementRow[]> {
  const rows = await select('agent_settlements', 'id, agent_organization_id, period_start, period_end, status, gross_halala, vat_halala, refunds_halala, payment_charges_halala, net_revenue_halala, commission_halala, adjustments_halala, net_due_halala, commission_status, trips, passengers, payment_reference',
    q => q.order('period_end', { ascending: false }).limit(100), env);
  return rows.map(r => ({ id: s(r.id), agentOrganizationId: s(r.agent_organization_id), periodStart: s(r.period_start), periodEnd: s(r.period_end), status: s(r.status),
    grossHalala: n(r.gross_halala), vatHalala: n(r.vat_halala), refundsHalala: n(r.refunds_halala), paymentChargesHalala: n(r.payment_charges_halala),
    netRevenueHalala: n(r.net_revenue_halala), commissionHalala: n(r.commission_halala), adjustmentsHalala: n(r.adjustments_halala), netDueHalala: n(r.net_due_halala),
    commissionStatus: s(r.commission_status), trips: n(r.trips), passengers: n(r.passengers), paymentReference: typeof r.payment_reference === 'string' ? r.payment_reference : null }));
}
export const generateSettlement = async (orgId: string, from: string, to: string, env?: EnvSource) =>
  s(await rpcValue('generate_agent_settlement', { p_agent_org: orgId, p_from: from, p_to: to }, env));
export const decideSettlement = async (id: string, action: 'approve' | 'mark_paid' | 'void', reference: string | null, reason: string, env?: EnvSource) =>
  s(await rpcValue('decide_agent_settlement', { p_settlement_id: id, p_action: action, p_reference: reference, p_reason: reason }, env));
export const adjustSettlement = async (id: string, amountHalala: number, reason: string, env?: EnvSource) =>
  n(await rpcValue('adjust_agent_settlement', { p_settlement_id: id, p_amount_halala: amountHalala, p_reason: reason }, env));

export interface CommissionRule { readonly id: string; readonly agentOrganizationId: string | null; readonly basis: string; readonly value: number; readonly status: string; readonly effectiveFrom: string }
export async function listCommissionRules(env?: EnvSource): Promise<CommissionRule[]> {
  const rows = await select('agent_commission_rules', 'id, agent_organization_id, basis, value, status, effective_from', q => q.order('created_at', { ascending: false }).limit(100), env);
  return rows.map(r => ({ id: s(r.id), agentOrganizationId: typeof r.agent_organization_id === 'string' ? r.agent_organization_id : null, basis: s(r.basis), value: n(r.value), status: s(r.status), effectiveFrom: s(r.effective_from) }));
}
export const proposeCommissionRule = async (orgId: string | null, basis: string, value: number, from: string, notes: string, env?: EnvSource) =>
  s(await rpcValue('propose_commission_rule', { p_agent_org: orgId, p_basis: basis, p_value: value, p_effective_from: from, p_effective_to: null, p_notes: notes }, env));
export const approveCommissionRule = async (id: string, reason: string, env?: EnvSource) => s(await rpcValue('approve_commission_rule', { p_rule_id: id, p_reason: reason }, env));

/* --------------------------- operations control -------------------------- */

export interface SailingControl {
  readonly id: string; readonly departsAt: string; readonly origin: string; readonly destination: string; readonly vesselName: string;
  readonly status: string; readonly seatCapacity: number; readonly seatsBooked: number; readonly readinessStatus: string;
  readonly masterDecision: string; readonly portClearanceStatus: string; readonly commercialDecision: string;
  readonly payloadCapacityKg: number | null; readonly payloadBookedKg: number;
}

export async function listSailingControl(fromIso: string, toIso: string, env?: EnvSource): Promise<SailingControl[]> {
  const rows = await select('sailings', 'id, departs_at, status, seat_capacity, seats_booked, readiness_status, master_decision, port_clearance_status, commercial_decision, payload_capacity_kg, payload_booked_kg, route:routes(origin, destination), vessel:vessels(name)',
    q => q.gte('departs_at', fromIso).lte('departs_at', toIso).order('departs_at').limit(200), env);
  return rows.map(r => {
    const route = (Array.isArray(r.route) ? r.route[0] : r.route) as Row | null;
    const vessel = (Array.isArray(r.vessel) ? r.vessel[0] : r.vessel) as Row | null;
    return { id: s(r.id), departsAt: s(r.departs_at), origin: s(route?.origin), destination: s(route?.destination), vesselName: s(vessel?.name),
      status: s(r.status), seatCapacity: n(r.seat_capacity), seatsBooked: n(r.seats_booked), readinessStatus: s(r.readiness_status),
      masterDecision: s(r.master_decision), portClearanceStatus: s(r.port_clearance_status), commercialDecision: s(r.commercial_decision),
      payloadCapacityKg: nn(r.payload_capacity_kg), payloadBookedKg: n(r.payload_booked_kg) };
  });
}

export const recordMasterDecision = async (sailingId: string, decision: 'pending' | 'go' | 'no_go', masterName: string, reason: string, env?: EnvSource) =>
  s(await rpcValue('record_master_decision', { p_sailing_id: sailingId, p_decision: decision, p_master_name: masterName, p_reason: reason }, env));
export const recordPortClearance = async (sailingId: string, status: 'pending' | 'cleared' | 'refused' | 'not_required', reference: string, reason: string, env?: EnvSource) =>
  s(await rpcValue('record_port_clearance', { p_sailing_id: sailingId, p_status: status, p_reference: reference || null, p_reason: reason }, env));
export const suspendSailing = async (id: string, reason: string, env?: EnvSource) => s(await rpcValue('suspend_sailing', { p_sailing_id: id, p_reason: reason }, env));
export const resumeSailing = async (id: string, reason: string, env?: EnvSource) => s(await rpcValue('resume_sailing', { p_sailing_id: id, p_reason: reason }, env));
export const cancelSailing = async (id: string, reason: string, env?: EnvSource) => n(await rpcValue('cancel_sailing', { p_sailing_id: id, p_reason: reason }, env));
export const decideSailingMinimum = async (id: string, decision: 'proceed_below_minimum' | 'cancel', reason: string, env?: EnvSource) =>
  s(await rpcValue('decide_sailing_minimum', { p_sailing_id: id, p_decision: decision, p_reason: reason }, env));
export const recordNoShows = async (id: string, reason: string, env?: EnvSource) => n(await rpcValue('record_no_shows', { p_sailing_id: id, p_reason: reason }, env));
export const generateSailings = async (from: string, to: string, env?: EnvSource) => n(await rpcValue('generate_sailings', { p_from: from, p_to: to }, env));
export const expireStaleHolds = async (env?: EnvSource) => n(await rpcValue('expire_stale_holds', {}, env));
export const setSailingReadiness = async (id: string, status: 'pending' | 'ready' | 'blocked', reason: string, env?: EnvSource) =>
  s(await rpcValue('set_sailing_readiness', { p_sailing_id: id, p_status: status, p_reason: reason }, env));

export interface ScheduleTemplate { readonly id: string; readonly routeLabel: string; readonly vesselName: string; readonly departureLocal: string; readonly daysOfWeek: number[]; readonly seatCapacity: number; readonly active: boolean; readonly notes: string }
export async function listScheduleTemplates(env?: EnvSource): Promise<ScheduleTemplate[]> {
  const rows = await select('schedule_templates', 'id, departure_local, days_of_week, seat_capacity, active, notes, route:routes(origin, destination), vessel:vessels(name)', q => q.order('departure_local').limit(100), env);
  return rows.map(r => {
    const route = (Array.isArray(r.route) ? r.route[0] : r.route) as Row | null;
    const vessel = (Array.isArray(r.vessel) ? r.vessel[0] : r.vessel) as Row | null;
    return { id: s(r.id), routeLabel: `${s(route?.origin)} → ${s(route?.destination)}`, vesselName: s(vessel?.name), departureLocal: s(r.departure_local).slice(0, 5),
      daysOfWeek: Array.isArray(r.days_of_week) ? (r.days_of_week as unknown[]).map(n) : [], seatCapacity: n(r.seat_capacity), active: b(r.active), notes: s(r.notes) };
  });
}

/* --------------------------------- reports -------------------------------- */

export async function runReport(name: string, args: Row, env?: EnvSource): Promise<Row[]> {
  const allowed = ['report_period_summary', 'report_sailing_occupancy', 'report_revenue_by_sailing', 'report_revenue_by_destination', 'report_payments_summary',
    'report_cancellations', 'report_customer_activity', 'report_agent_activity', 'report_outstanding_balances', 'report_payment_reconciliation', 'report_my_organization'];
  if (!allowed.includes(name)) throw new DataServiceError('invalid-input');
  return rpcRows(name, args, env);
}

/* ---------------------------- account & privacy --------------------------- */

export interface NotificationPreference { readonly channel: 'email' | 'sms' | 'whatsapp'; readonly optedIn: boolean; readonly consentVersion: string | null }
export async function listNotificationPreferences(env?: EnvSource): Promise<NotificationPreference[]> {
  const rows = await select('notification_preferences', 'channel, opted_in, consent_version', q => q.limit(3), env);
  return rows.map(r => ({ channel: s(r.channel) as NotificationPreference['channel'], optedIn: b(r.opted_in), consentVersion: typeof r.consent_version === 'string' ? r.consent_version : null }));
}
export const setNotificationPreference = async (channel: 'email' | 'sms' | 'whatsapp', optedIn: boolean, consentVersion: string | null, env?: EnvSource) =>
  s(await rpcValue('set_notification_preference', { p_channel: channel, p_opted_in: optedIn, p_consent_version: consentVersion }, env));

export async function exportMyData(env?: EnvSource): Promise<Row> {
  const data = await rpcValue('export_my_data', {}, env);
  if (!data || typeof data !== 'object') throw new DataServiceError('unexpected-response');
  return data as Row;
}
export const submitPrivacyRequest = async (type: 'access_export' | 'correction' | 'erasure' | 'objection', details: string, env?: EnvSource) =>
  s(await rpcValue('submit_privacy_request', { p_type: type, p_details: details.trim() || null }, env));
export async function listPrivacyRequests(env?: EnvSource): Promise<Array<{ id: string; type: string; status: string; dueAt: string; createdAt: string }>> {
  const rows = await select('privacy_requests', 'id, request_type, status, due_at, created_at', q => q.order('created_at', { ascending: false }).limit(50), env);
  return rows.map(r => ({ id: s(r.id), type: s(r.request_type), status: s(r.status), dueAt: s(r.due_at), createdAt: s(r.created_at) }));
}
export const decidePrivacyRequest = async (id: string, status: 'in_progress' | 'completed' | 'rejected', notes: string, env?: EnvSource) =>
  s(await rpcValue('decide_privacy_request', { p_id: id, p_status: status, p_notes: notes }, env));

export interface SecurityPosture { readonly isStaff: boolean; readonly roles: readonly string[]; readonly mfaRequired: boolean; readonly sessionAal: string }
export async function securityPosture(env?: EnvSource): Promise<SecurityPosture> {
  const [r] = await rpcRows('my_security_posture', {}, env);
  return { isStaff: b(r?.is_staff), roles: Array.isArray(r?.staff_roles) ? (r!.staff_roles as unknown[]).map(s) : [], mfaRequired: b(r?.mfa_required), sessionAal: s(r?.session_aal) || 'aal1' };
}

export const systemDiagnostics = async (env?: EnvSource) => (await rpcValue('system_diagnostics', {}, env)) as Row;
export const deliveryIssues = async (env?: EnvSource) => rpcRows('notification_delivery_issues', { p_limit: 100 }, env);

export async function getInvoice(invoiceId: string, env?: EnvSource): Promise<InvoiceV2 | null> {
  const rows = await select('invoices', INVOICE_SELECT, q => q.eq('id', invoiceId).limit(1), env);
  return rows[0] ? toInvoice(rows[0]) : null;
}

/* ------------------------------ materials & charters ------------------------------ */

export interface TransferExtras {
  readonly weightKg: number | null; readonly safetyDecision: string; readonly safetyReference: string | null; readonly declaredHazardous: boolean;
  readonly quote: { id: string; totalHalala: number; vatHalala: number; basis: string; status: string } | null;
  readonly allocation: { vesselId: string; startsAt: string; endsAt: string; quotedTotalHalala: number | null } | null;
  readonly assignment: { sailingId: string; weightKg: number } | null;
  readonly attachments: ReadonlyArray<{ id: string; objectPath: string; mimeType: string; sizeBytes: number }>;
}

export async function transferExtras(requestId: string, env?: EnvSource): Promise<TransferExtras> {
  const [[r], quotes, allocations, assignments, attachments] = await Promise.all([
    select('transfer_requests', 'weight_kg, safety_decision, safety_reference, declared_hazardous', q => q.eq('id', requestId).limit(1), env),
    select('material_quotes', 'id, total_halala, vat_halala, basis, status', q => q.eq('request_id', requestId).limit(5), env),
    select('charter_allocations', 'vessel_id, starts_at, ends_at, quoted_total_halala', q => q.eq('request_id', requestId).limit(1), env),
    select('material_assignments', 'sailing_id, weight_kg', q => q.eq('request_id', requestId).limit(1), env),
    select('transfer_request_attachments', 'id, object_path, mime_type, size_bytes', q => q.eq('request_id', requestId).limit(10), env),
  ]);
  const quote = quotes.find(x => x.status !== 'superseded');
  return {
    weightKg: nn(r?.weight_kg), safetyDecision: s(r?.safety_decision) || 'pending', safetyReference: typeof r?.safety_reference === 'string' ? r.safety_reference : null,
    declaredHazardous: b(r?.declared_hazardous),
    quote: quote ? { id: s(quote.id), totalHalala: n(quote.total_halala), vatHalala: n(quote.vat_halala), basis: s(quote.basis), status: s(quote.status) } : null,
    allocation: allocations[0] ? { vesselId: s(allocations[0].vessel_id), startsAt: s(allocations[0].starts_at), endsAt: s(allocations[0].ends_at), quotedTotalHalala: nn(allocations[0].quoted_total_halala) } : null,
    assignment: assignments[0] ? { sailingId: s(assignments[0].sailing_id), weightKg: n(assignments[0].weight_kg) } : null,
    attachments: attachments.map(a => ({ id: s(a.id), objectPath: s(a.object_path), mimeType: s(a.mime_type), sizeBytes: n(a.size_bytes) })),
  };
}

export const recordSafetyReview = async (id: string, decision: 'accepted' | 'refused', reference: string, reason: string, env?: EnvSource) =>
  s(await rpcValue('record_material_safety_review', { p_request_id: id, p_decision: decision, p_reference: reference || null, p_reason: reason }, env));
export const quoteMaterial = async (id: string, env?: EnvSource) => s(await rpcValue('quote_material_request', { p_request_id: id }, env));
export const approveMaterialQuote = async (quoteId: string, reason: string, env?: EnvSource) => s(await rpcValue('approve_material_quote', { p_quote_id: quoteId, p_reason: reason }, env));
export const assignMaterial = async (id: string, sailingId: string, reason: string, env?: EnvSource) =>
  s(await rpcValue('assign_material_to_sailing', { p_request_id: id, p_sailing_id: sailingId, p_reason: reason }, env));
export const recordMaterialDelivery = async (id: string, receiver: string, signatureRef: string, notes: string, env?: EnvSource) =>
  s(await rpcValue('record_delivery', { p_request_id: id, p_receiver_name: receiver, p_signature_ref: signatureRef || null, p_photo_urls: null, p_notes: notes || null }, env));
export const allocateCharter = async (id: string, vesselId: string, startsAt: string, endsAt: string, quotedHalala: number | null, reason: string, env?: EnvSource) =>
  s(await rpcValue('allocate_charter', { p_request_id: id, p_vessel_id: vesselId, p_starts_at: startsAt, p_ends_at: endsAt, p_quoted_total_halala: quotedHalala, p_reason: reason }, env));
export const cancelTransfer = async (id: string, reason: string, env?: EnvSource) => s(await rpcValue('cancel_transfer_request', { p_id: id, p_reason: reason }, env));

const ATTACHMENT_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Uploads to the PRIVATE material-attachments bucket under <org>/<request>/<uuid>.<ext>, then registers it. */
export async function uploadRequestAttachment(orgId: string, requestId: string, file: File, env?: EnvSource): Promise<void> {
  const ext = ATTACHMENT_TYPES[file.type];
  if (!ext) throw new DataServiceError('invalid-input');
  if (file.size < 1 || file.size > ATTACHMENT_MAX_BYTES) throw new DataServiceError('invalid-input');
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
  const path = `${orgId}/${requestId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await client.storage.from('material-attachments').upload(path, bytes, { contentType: file.type, upsert: false });
  if (error) throw new DataServiceError('forbidden');
  await rpcValue('register_request_attachment', { p_request_id: requestId, p_object_path: path, p_mime_type: file.type, p_size_bytes: file.size, p_sha256: digest }, env);
}

/** Short-lived signed URL for a private attachment (storage RLS decides who may read). */
export async function attachmentUrl(objectPath: string, env?: EnvSource): Promise<string> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data, error } = await client.storage.from('material-attachments').createSignedUrl(objectPath, 300);
  if (error || !data?.signedUrl) throw new DataServiceError('forbidden');
  return data.signedUrl;
}

export async function listVesselsLite(env?: EnvSource): Promise<Array<{ id: string; name: string }>> {
  const rows = await select('vessels', 'id, name', q => q.eq('status', 'active').order('name').limit(100), env);
  return rows.map(r => ({ id: s(r.id), name: s(r.name) }));
}

export async function listOpenSailingsLite(env?: EnvSource): Promise<Array<{ id: string; label: string }>> {
  const rows = await select('sailings', 'id, departs_at, payload_capacity_kg, payload_booked_kg, route:routes(origin, destination)',
    q => q.eq('status', 'open').gt('departs_at', new Date().toISOString()).order('departs_at').limit(100), env);
  return rows.map(r => {
    const route = (Array.isArray(r.route) ? r.route[0] : r.route) as Row | null;
    const when = new Date(s(r.departs_at)).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' });
    const payload = r.payload_capacity_kg == null ? '' : ` · ${n(r.payload_booked_kg)}/${n(r.payload_capacity_kg)} kg`;
    return { id: s(r.id), label: `${when} · ${s(route?.origin)} → ${s(route?.destination)}${payload}` };
  });
}
