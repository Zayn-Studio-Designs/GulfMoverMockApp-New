import { buildCreateBookingArgs, type BookingInput } from './bookingService';
import type { EnvSource } from './supabase';
import { DataServiceError, requireDataClient, requireSessionUser, run } from './dataService';

/** Versioned terms acceptance: the exact version string must match the current terms. */

export interface IndividualBookingInput {
  readonly outboundSailingId: string;
  readonly returnSailingId: string | null;
  readonly passengerCount: number;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly extraPassengerNames: readonly string[];
  readonly destinationVessel: string;
  readonly destinationImo: string;
  readonly termsVersion: string;
}

export interface AgentBookingInput extends IndividualBookingInput {
  readonly agentOrganizationId: string;
  readonly clientName: string;
  readonly clientReference: string;
  readonly poReference: string;
}

export interface LifecycleResult {
  readonly bookingId: string;
  readonly reference: string;
  readonly status: string;
  readonly outcome: 'created' | 'replayed';
}

function row0(data: unknown): Record<string, unknown> {
  const row = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
  if (!row || typeof row.booking_id !== 'string' || typeof row.reference !== 'string') {
    throw new DataServiceError('unexpected-response');
  }
  return row;
}

function baseArgs(input: IndividualBookingInput, requestKey: string) {
  const extras = input.extraPassengerNames.map(v => v.trim()).filter(Boolean);
  return {
    p_request_key: requestKey,
    p_outbound_sailing_id: input.outboundSailingId,
    p_passenger_count: input.passengerCount,
    p_contact_name: input.contactName.trim(),
    p_contact_email: input.contactEmail.trim().toLowerCase(),
    p_contact_phone: input.contactPhone.trim(),
    p_passenger_names: extras.length ? extras : null,
    p_return_sailing_id: input.returnSailingId || null,
    p_destination_vessel: input.destinationVessel.trim() || null,
    p_destination_imo: input.destinationImo.trim() || null,
    p_terms_version: input.termsVersion,
  };
}

/** Individual booking: any signed-in user with an active profile; no company needed. */
export async function createIndividualBooking(input: IndividualBookingInput, requestKey: string, env?: EnvSource): Promise<LifecycleResult> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  if (!input.termsVersion) throw new DataServiceError('invalid-input');
  const { data } = await run(client.rpc('create_individual_booking', baseArgs(input, requestKey)));
  const row = row0(data);
  if (row.outcome !== 'created' && row.outcome !== 'replayed') throw new DataServiceError('unexpected-response');
  return { bookingId: row.booking_id as string, reference: row.reference as string, status: String(row.status), outcome: row.outcome as 'created' | 'replayed' };
}

/** Agent booking: the caller must be an active booker of an approved agent organization. */
export async function createAgentBooking(input: AgentBookingInput, requestKey: string, env?: EnvSource): Promise<LifecycleResult> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  if (!input.agentOrganizationId || !input.clientName.trim() || !input.termsVersion) {
    throw new DataServiceError('invalid-input');
  }
  const { data } = await run(client.rpc('create_agent_booking', {
    ...baseArgs(input, requestKey),
    p_agent_organization_id: input.agentOrganizationId,
    p_client_name: input.clientName.trim(),
    p_client_reference: input.clientReference.trim() || null,
    p_po_reference: input.poReference.trim() || null,
    p_permit_status: null,
  }));
  const row = row0(data);
  if (row.outcome !== 'created' && row.outcome !== 'replayed') throw new DataServiceError('unexpected-response');
  return { bookingId: row.booking_id as string, reference: row.reference as string, status: String(row.status), outcome: row.outcome as 'created' | 'replayed' };
}

export interface AmendBookingInput {
  readonly contactName?: string;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
  readonly extraPassengerNames?: readonly string[] | null;
  readonly poReference?: string;
  readonly destinationVessel?: string;
  readonly destinationImo?: string;
  readonly permitStatus?: string;
}

/** Amend an unpaid booking. Only contact/passenger/metadata fields change; seats never move. */
export async function amendBooking(bookingId: string, input: AmendBookingInput, env?: EnvSource): Promise<void> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const { data } = await run(client.rpc('amend_booking', {
    p_booking_id: bookingId,
    p_contact_name: input.contactName ?? null,
    p_contact_email: input.contactEmail ? input.contactEmail.toLowerCase() : null,
    p_contact_phone: input.contactPhone ?? null,
    p_passenger_names: input.extraPassengerNames === undefined ? null
      : input.extraPassengerNames === null ? null : input.extraPassengerNames.map(v => v.trim()).filter(Boolean),
    p_po_reference: input.poReference ?? null,
    p_destination_vessel: input.destinationVessel ?? null,
    p_destination_imo: input.destinationImo ?? null,
    p_permit_status: input.permitStatus ?? null,
  }));
  if (data !== 'amended') throw new DataServiceError('unexpected-response');
}

/** Cancel a booking with a required reason. Seats are released; no refund is implied. */
export async function cancelBooking(bookingId: string, reason: string, env?: EnvSource): Promise<'cancelled' | 'unchanged'> {
  const client = requireDataClient(env);
  await requireSessionUser(client);
  const trimmed = reason.trim();
  if (!trimmed) throw new DataServiceError('invalid-input');
  const { data } = await run(client.rpc('cancel_booking', { p_booking_id: bookingId, p_reason: trimmed }));
  if (data !== 'cancelled' && data !== 'unchanged') throw new DataServiceError('unexpected-response');
  return data;
}

/** Corporate path helper: reuse the shared validation from the corporate booking form. */
export function corporateArgs(input: BookingInput, requestKey: string) {
  return buildCreateBookingArgs(input, requestKey);
}
