import type { EnvSource } from './supabase';
import { DataServiceError, likePattern, requireDataClient, requireSessionUser, run } from './dataService';

/**
 * ATCO company review (production mode).
 *
 * READS: `organizations` and `approval_events` through the reviewer's own session. RLS
 * (organizations_select_staff_or_members / approval_events_select_relevant) returns every row
 * only to super_admin/operations; anyone else sees just their own organisation.
 * WRITE: only `review_company(...)` (migration 20261027120000), which re-checks the
 * super_admin role, the transition and conflict of interest inside the database and lets the
 * existing audit trigger write the event. Nothing here decides who is an administrator.
 */

export type CompanyStatus = 'pending' | 'approved' | 'rejected' | 'suspended';
export type CompanyStatusFilter = CompanyStatus | 'all';

/** Exactly the fields the registration schema stores (no invented verification data). */
export interface CompanyRecord {
  readonly id: string;
  readonly legalName: string;
  readonly displayName: string | null;
  readonly registrationNumber: string | null;
  readonly billingContact: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly status: CompanyStatus;
  readonly rejectionReason: string | null;
  readonly createdAt: string;
  readonly approvedAt: string | null;
}

export interface CompanyPage {
  readonly items: readonly CompanyRecord[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface ReviewEvent {
  readonly decision: string;
  readonly reason: string | null;
  readonly occurredAt: string;
  readonly actorUserId: string;
}

export const COMPANY_PAGE_SIZE = 20;
const STATUSES: ReadonlySet<string> = new Set(['pending', 'approved', 'rejected', 'suspended']);
const COLUMNS = 'id, legal_name, display_name, registration_number, billing_contact, contact_email, contact_phone, status, rejection_reason, created_at, approved_at';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function toCompany(row: Record<string, unknown>): CompanyRecord {
  if (typeof row.id !== 'string' || typeof row.legal_name !== 'string' || typeof row.status !== 'string' || !STATUSES.has(row.status)) {
    throw new DataServiceError('unexpected-response');
  }
  return {
    id: row.id,
    legalName: row.legal_name,
    displayName: str(row.display_name),
    registrationNumber: str(row.registration_number),
    billingContact: str(row.billing_contact),
    contactEmail: str(row.contact_email),
    contactPhone: str(row.contact_phone),
    status: row.status as CompanyStatus,
    rejectionReason: str(row.rejection_reason),
    createdAt: String(row.created_at ?? ''),
    approvedAt: str(row.approved_at),
  };
}

/** One page of organisations, newest first, optionally filtered by status and name. */
export async function listCompanies(
  options: { status: CompanyStatusFilter; search?: string; page?: number },
  env?: EnvSource,
): Promise<CompanyPage> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const page = Math.max(0, Math.floor(options.page ?? 0));
  const from = page * COMPANY_PAGE_SIZE;
  let query = client.from('organizations').select(COLUMNS, { count: 'exact' });
  if (options.status !== 'all') query = query.eq('status', options.status);
  const search = options.search?.trim();
  if (search) query = query.ilike('legal_name', likePattern(search.slice(0, 100)));
  const { data, count } = await run(query.order('created_at', { ascending: false }).range(from, from + COMPANY_PAGE_SIZE - 1));
  const rows = Array.isArray(data) ? data as Record<string, unknown>[] : [];
  return { items: rows.map(toCompany), total: count ?? rows.length, page, pageSize: COMPANY_PAGE_SIZE };
}

/** The audit history of one organisation (oldest first). */
export async function getCompanyHistory(organizationId: string, env?: EnvSource): Promise<ReviewEvent[]> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.from('approval_events')
    .select('decision, reason, occurred_at, actor_user_id')
    .eq('subject_type', 'organization').eq('subject_id', organizationId)
    .order('occurred_at', { ascending: true }).limit(100));
  const rows = Array.isArray(data) ? data as Record<string, unknown>[] : [];
  return rows.map(r => ({
    decision: String(r.decision ?? ''),
    reason: str(r.reason),
    occurredAt: String(r.occurred_at ?? ''),
    actorUserId: String(r.actor_user_id ?? ''),
  }));
}

export type ReviewDecision = 'approve' | 'reject';

export interface ReviewResult {
  readonly organizationId: string;
  readonly status: CompanyStatus;
  /** 'decided' = status changed now; 'unchanged' = this decision was already in effect (retry). */
  readonly outcome: 'decided' | 'unchanged';
}

export const REJECTION_REASON_MAX = 500;

export async function reviewCompany(organizationId: string, decision: ReviewDecision, reason: string, env?: EnvSource): Promise<ReviewResult> {
  const client = requireDataClient(env);
  const trimmed = reason.trim();
  if (decision === 'reject' && (!trimmed || [...trimmed].length > REJECTION_REASON_MAX)) throw new DataServiceError('invalid-input');
  await requireSessionUser(client);
  const { data } = await run(client.rpc('review_company', {
    p_organization_id: organizationId,
    p_decision: decision,
    p_reason: decision === 'reject' ? trimmed : null,
  }));
  const row = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
  if (!row || typeof row.id !== 'string' || typeof row.status !== 'string' || !STATUSES.has(row.status)
    || (row.outcome !== 'decided' && row.outcome !== 'unchanged')) {
    throw new DataServiceError('unexpected-response');
  }
  return { organizationId: row.id, status: row.status as CompanyStatus, outcome: row.outcome };
}
