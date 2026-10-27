import { requireDataClient, requireSessionUser, run, DataServiceError } from './dataService';

export async function operation<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const client = requireDataClient(); await requireSessionUser(client);
  const { data } = await run(client.rpc(name, args));
  if (data === null || data === undefined) throw new DataServiceError('unexpected-response');
  return data as T;
}
export async function records<T>(table: string, columns: string, column?: string, value?: string): Promise<T[]> {
  const client = requireDataClient(); await requireSessionUser(client);
  let query = client.from(table).select(columns).order('created_at', { ascending: false }).limit(200);
  if (column && value) query = query.eq(column, value);
  const { data } = await run(query);
  if (!Array.isArray(data)) throw new DataServiceError('unexpected-response');
  return data as T[];
}
export type TransferKind = 'materials' | 'charter';
export interface TransferRequest { id: string; reference: string; organization_id: string; kind: TransferKind; details: Record<string,string>; status: string; revision: number; created_at: string }
export interface TransferEvent { id: string; status: string; reason: string; created_at: string }
export const listTransfers = (kind: TransferKind) => records<TransferRequest>('transfer_requests','id,reference,organization_id,kind,details,status,revision,created_at','kind',kind);
export const transferHistory = (id: string) => records<TransferEvent>('transfer_request_events','id,status,reason,created_at','request_id',id);
export const submitTransfer = (org: string,kind: TransferKind,key: string,details: Record<string,string>) => operation<string>('submit_transfer_request',{p_org:org,p_kind:kind,p_key:key,p_details:details});
export const reviewTransfer = (request: TransferRequest,status: string,reason: string) => operation<string>('review_transfer_request',{p_id:request.id,p_revision:request.revision,p_status:status,p_reason:reason.trim()});

export interface Member { id: string; display_name: string | null; email: string; membership_role: string; status: string }
export interface Invitation { id: string; organization_id: string; email: string; status: string; expires_at: string }
export interface MemberEvent { id: string; action: string; occurred_at: string }
export const listMembers = (org: string) => operation<Member[]>('list_company_members', { p_org: org });
export const inviteMember = (org: string, email: string) => operation<string>('invite_company_member', { p_org: org, p_email: email.trim().toLowerCase() });
export const acceptInvitation = (id: string) => operation<string>('accept_company_invitation', { p_id: id });
export const cancelInvitation = (id: string) => operation<string>('cancel_company_invitation', { p_id: id });
export const revokeMember = (id: string) => operation<string>('revoke_company_member', { p_id: id });
export const listInvitations = () => records<Invitation>('company_invitations','id,organization_id,email,status,expires_at');
export async function memberHistory(org: string) {
  const c = requireDataClient(); await requireSessionUser(c);
  const { data } = await run(c.from('membership_events').select('id,action,occurred_at').eq('organization_id',org).order('occurred_at',{ascending:false}).limit(100));
  if (!Array.isArray(data)) throw new DataServiceError('unexpected-response');
  return data as MemberEvent[];
}
