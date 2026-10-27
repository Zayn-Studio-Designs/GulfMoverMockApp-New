import type { EnvSource } from './supabase';
import { DataServiceError, requireDataClient, requireSessionUser, run } from './dataService';

/** Minor-unit money: 1 SAR = 100 halala. No floats cross this boundary. */
export const HALALA_PER_SAR = 100;
export const formatSar = (halala: number): string =>
  `${(halala / HALALA_PER_SAR).toFixed(2)} SAR`;

export interface Tariff {
  readonly id: string;
  readonly code: string;
  readonly perPersonHalala: number;
  readonly currency: string;
  readonly vatPercent: number | null;
  readonly vatActive: boolean;
  readonly active: boolean;
}

export interface MinimumStatus {
  readonly ticketCount: number;
  readonly revenueHalala: number;
  readonly thresholdTickets: number;
  readonly thresholdRevenueHalala: number;
  readonly thresholdMet: boolean;
}

export interface ServicePolicy {
  readonly policyType: string;
  readonly version: string;
  readonly content: Record<string, unknown>;
  readonly status: 'provisional' | 'approved' | 'retired';
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown) => (typeof v === 'string' ? v : '');

function toTariff(row: Record<string, unknown>): Tariff {
  if (typeof row.id !== 'string' || typeof row.code !== 'string') throw new DataServiceError('unexpected-response');
  return {
    id: row.id, code: row.code, perPersonHalala: n(row.per_person_halala), currency: s(row.currency) || 'SAR',
    vatPercent: typeof row.vat_percent === 'number' ? row.vat_percent : null,
    vatActive: row.vat_active === true, active: row.active !== false,
  };
}

/** The currently active fare. Throws when none is active (booking is impossible without a tariff). */
export async function getActiveTariff(env?: EnvSource): Promise<Tariff> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.from('tariffs').select('id, code, per_person_halala, currency, vat_percent, vat_active, active')
    .eq('active', true).order('effective_from', { ascending: false }).limit(1));
  const row = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
  if (!row) throw new DataServiceError('not-deployed');
  return toTariff(row);
}

export async function getSailingMinimumStatus(sailingId: string, env?: EnvSource): Promise<MinimumStatus> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.rpc('sailing_minimum_status', { p_sailing_id: sailingId }));
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row || typeof row.threshold_met !== 'boolean') throw new DataServiceError('unexpected-response');
  return {
    ticketCount: n(row.ticket_count), revenueHalala: n(row.revenue_halala),
    thresholdTickets: n(row.threshold_tickets), thresholdRevenueHalala: n(row.threshold_revenue_halala),
    thresholdMet: row.threshold_met,
  };
}

export async function getCurrentBookingTerms(env?: EnvSource): Promise<ServicePolicy> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.from('service_policies')
    .select('policy_type, version, content, status').eq('policy_type', 'booking_terms')
    .order('effective_from', { ascending: false }).limit(1));
  const row = (Array.isArray(data) ? data[0] : undefined) as Record<string, unknown> | undefined;
  if (!row || typeof row.version !== 'string') throw new DataServiceError('not-deployed');
  return {
    policyType: 'booking_terms', version: row.version,
    content: (row.content ?? {}) as Record<string, unknown>,
    status: row.status === 'approved' ? 'approved' : row.status === 'retired' ? 'retired' : 'provisional',
  };
}

export async function listServicePolicies(env?: EnvSource): Promise<ServicePolicy[]> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.from('service_policies')
    .select('policy_type, version, content, status').order('policy_type').order('version'));
  return (Array.isArray(data) ? data as Record<string, unknown>[] : []).map(row => ({
    policyType: s(row.policy_type), version: s(row.version),
    content: (row.content ?? {}) as Record<string, unknown>,
    status: row.status === 'approved' ? 'approved' : row.status === 'retired' ? 'retired' : 'provisional',
  }));
}
