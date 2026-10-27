-- ===========================================================================
-- 20261031100001 - Phase 7: booking lifecycle, sandbox payments, invoices,
-- materials control, settlement foundations, staff reports (additive only)
-- Sandbox only: no real money moves. Webhook secrets are never stored here.
-- ===========================================================================

-- 1. Amend + cancel ----------------------------------------------------------
create or replace function public.amend_booking(
  p_booking_id uuid, p_contact_name text default null, p_contact_email text default null,
  p_contact_phone text default null, p_passenger_names text[] default null,
  p_po_reference text default null, p_destination_vessel text default null,
  p_destination_imo text default null, p_permit_status text default null
) returns text language plpgsql security definer set search_path = '' as $$
declare v_b public.bookings%rowtype; v_names text[]; v_extra text;
begin
  if p_booking_id is null then raise exception 'invalid booking' using errcode = '22023'; end if;
  select * into v_b from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_b.status not in ('reserved', 'pending_payment') then
    raise exception 'invalid_transition: only unpaid bookings can be amended' using errcode = '55000'; end if;
  if not (v_b.created_by = auth.uid()
      or (v_b.organization_id is not null and public.has_org_role(v_b.organization_id, '{company_admin}'))
      or public.has_platform_role('{super_admin,operations}')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_contact_name is not null then
    if nullif(btrim(p_contact_name), '') is null or char_length(btrim(p_contact_name)) > 120 then
      raise exception 'invalid contact name' using errcode = '22023'; end if;
    v_b.contact_name := btrim(p_contact_name);
  end if;
  if p_contact_email is not null then
    if nullif(lower(btrim(p_contact_email)), '') is null
       or char_length(lower(btrim(p_contact_email))) > 254
       or lower(btrim(p_contact_email)) !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
      raise exception 'invalid contact email' using errcode = '22023'; end if;
    v_b.contact_email := lower(btrim(p_contact_email));
  end if;
  if p_contact_phone is not null then
    if nullif(btrim(p_contact_phone), '') is null or btrim(p_contact_phone) !~ '^[+]?[0-9 ()-]{7,20}$' then
      raise exception 'invalid contact phone' using errcode = '22023'; end if;
    v_b.contact_phone := btrim(p_contact_phone);
  end if;
  if p_passenger_names is not null then
    v_names := array[v_b.contact_name];
    foreach v_extra in array p_passenger_names loop
      v_extra := nullif(btrim(v_extra), '');
      if v_extra is not null then
        if char_length(v_extra) > 120 then raise exception 'invalid passenger name' using errcode = '22023'; end if;
        v_names := v_names || v_extra;
      end if;
    end loop;
    if cardinality(v_names) > v_b.passenger_count then raise exception 'invalid passenger names' using errcode = '22023'; end if;
    v_b.passenger_names := v_names;
  end if;
  if p_po_reference is not null then
    if char_length(btrim(p_po_reference)) > 64 then raise exception 'invalid po reference' using errcode = '22023'; end if;
    v_b.po_reference := nullif(btrim(p_po_reference), '');
  end if;
  if p_destination_vessel is not null then
    if char_length(btrim(p_destination_vessel)) > 120 then raise exception 'invalid destination vessel' using errcode = '22023'; end if;
    v_b.destination_vessel := nullif(btrim(p_destination_vessel), '');
  end if;
  if p_destination_imo is not null then
    if p_destination_imo <> '' and p_destination_imo !~ '^IMO[0-9]{7}$' then raise exception 'invalid IMO number' using errcode = '22023'; end if;
    v_b.destination_imo := nullif(btrim(p_destination_imo), '');
  end if;
  if p_permit_status is not null then
    if p_permit_status not in ('not_required', 'pending', 'verified') then raise exception 'invalid permit status' using errcode = '22023'; end if;
    v_b.permit_status := p_permit_status;
  end if;
  update public.bookings set contact_name = v_b.contact_name, contact_email = v_b.contact_email,
    contact_phone = v_b.contact_phone, passenger_names = v_b.passenger_names, po_reference = v_b.po_reference,
    destination_vessel = v_b.destination_vessel, destination_imo = v_b.destination_imo, permit_status = v_b.permit_status
    where id = p_booking_id;
  insert into public.booking_events (booking_id, action, actor_user_id, details)
  values (p_booking_id, 'amended', auth.uid(), jsonb_build_object('at', now()));
  return 'amended';
end; $$;
revoke all on function public.amend_booking(uuid, text, text, text, text[], text, text, text, text) from public, anon, service_role;
grant execute on function public.amend_booking(uuid, text, text, text, text[], text, text, text, text) to authenticated;

-- Cancel: customer/admin/staff. Releases seats. No refund is implied.
create or replace function public.cancel_booking(p_booking_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_b public.bookings%rowtype;
begin
  if p_booking_id is null or nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 500 then
    raise exception 'invalid input: a reason (<= 500 chars) is required' using errcode = '22023'; end if;
  select * into v_b from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_b.status = 'cancelled' then return 'unchanged'; end if;
  if v_b.status not in ('reserved', 'pending_payment', 'paid') then
    raise exception 'invalid_transition' using errcode = '55000'; end if;
  if not (v_b.created_by = auth.uid()
      or (v_b.organization_id is not null and public.has_org_role(v_b.organization_id, '{company_admin}'))
      or public.has_platform_role('{super_admin,operations}')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  update public.sailings s set seats_booked = greatest(0, s.seats_booked - l.passengers)
    from public.booking_legs l where l.booking_id = p_booking_id and l.sailing_id = s.id;
  update public.bookings set status = 'cancelled', operational_status = 'cancelled',
    cancelled_at = now(), cancel_reason = btrim(p_reason) where id = p_booking_id;
  update public.tickets set status = 'cancelled' where booking_id = p_booking_id and status = 'valid';
  insert into public.booking_events (booking_id, action, actor_user_id, details)
  values (p_booking_id, 'cancelled', auth.uid(), jsonb_build_object('reason', btrim(p_reason)));
  return 'cancelled';
end; $$;
revoke all on function public.cancel_booking(uuid, text) from public, anon, service_role;
grant execute on function public.cancel_booking(uuid, text) to authenticated;

-- 2. Sandbox payments, refunds, invoices --------------------------------------
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  amount_halala bigint not null constraint payments_amount_range check (amount_halala between 1 and 9000000000000),
  currency text not null default 'SAR' constraint payments_currency_check check (currency = 'SAR'),
  method text not null constraint payments_method_check check (method in ('mada', 'visa', 'mastercard', 'apple_pay', 'bank_transfer', 'sandbox')),
  provider text not null default 'sandbox-provider',
  provider_ref text unique,
  status text not null default 'initiated'
    constraint payments_status_check check (status in ('initiated', 'pending', 'succeeded', 'failed', 'refunded', 'partially_refunded')),
  sandbox boolean not null default true,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payments_booking_idx on public.payments (booking_id);
alter table public.payments enable row level security;
drop policy if exists payments_select_via_booking on public.payments;
create policy payments_select_via_booking on public.payments for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = payments.booking_id));
revoke all on public.payments from public, anon, authenticated;
grant select on public.payments to authenticated;

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete cascade,
  status text not null, detail text not null default '',
  actor_user_id uuid references auth.users (id),
  created_at timestamptz not null default now()
);
alter table public.payment_events enable row level security;
drop policy if exists payment_events_select_via_booking on public.payment_events;
create policy payment_events_select_via_booking on public.payment_events for select to authenticated
  using (exists (select 1 from public.payments p join public.bookings b on b.id = p.booking_id
                 where p.id = payment_events.payment_id));
revoke all on public.payment_events from public, anon, authenticated;
grant select on public.payment_events to authenticated;

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings (id) on delete cascade,
  invoice_number text not null unique,
  amount_halala bigint not null check (amount_halala >= 0),
  vat_halala bigint not null default 0 check (vat_halala >= 0),
  currency text not null default 'SAR' check (currency = 'SAR'),
  status text not null default 'issued' check (status in ('issued', 'paid', 'credited', 'void')),
  zatca_status text not null default 'not_submitted' check (zatca_status in ('not_submitted', 'submitted', 'accepted', 'rejected')),
  lines jsonb not null default '[]',
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
alter table public.invoices enable row level security;
drop policy if exists invoices_select_via_booking on public.invoices;
create policy invoices_select_via_booking on public.invoices for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = invoices.booking_id));
revoke all on public.invoices from public, anon, authenticated;
grant select on public.invoices to authenticated;

-- Initiate a sandbox payment. Never moves real money; provider_ref is simulated.
create or replace function public.initiate_payment(p_booking_id uuid, p_method text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_b public.bookings%rowtype; v_pay uuid; v_ref text;
begin
  if p_booking_id is null or p_method is null
     or p_method not in ('mada', 'visa', 'mastercard', 'apple_pay', 'bank_transfer', 'sandbox') then
    raise exception 'invalid input' using errcode = '22023'; end if;
  select * into v_b from public.bookings where id = p_booking_id for share;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_b.status = 'cancelled' then raise exception 'invalid_transition: booking is cancelled' using errcode = '55000'; end if;
  if not (v_b.created_by = auth.uid()
      or (v_b.organization_id is not null and public.has_org_role(v_b.organization_id, '{company_admin}'))
      or public.has_platform_role('{super_admin,operations,finance}')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_b.fare_halala is null or v_b.fare_halala <= 0 then raise exception 'no fare recorded' using errcode = 'P0001'; end if;
  v_ref := 'SANDBOX-' || upper(encode(extensions.gen_random_bytes(8), 'hex'));
  insert into public.payments (booking_id, amount_halala, currency, method, provider, provider_ref, status, sandbox, created_by)
  values (p_booking_id, v_b.fare_halala, 'SAR', p_method, 'sandbox-provider', v_ref, 'initiated', true, auth.uid())
  returning id into v_pay;
  insert into public.payment_events (payment_id, status, detail, actor_user_id)
  values (v_pay, 'initiated', 'Sandbox payment initiated. No real money moves.', auth.uid());
  update public.bookings set status = 'pending_payment', payment_status = 'pending' where id = p_booking_id;
  insert into public.booking_events (booking_id, action, actor_user_id, details)
  values (p_booking_id, 'paid', auth.uid(), jsonb_build_object('payment_id', v_pay, 'sandbox', true, 'note', 'initiation only, not proof of payment'));
  return v_pay;
end; $$;
revoke all on function public.initiate_payment(uuid, text) from public, anon, service_role;
grant execute on function public.initiate_payment(uuid, text) to authenticated;

-- Verify a sandbox payment result. The ONLY proof of payment is this
-- server-side transition, never a client callback.
create or replace function public.verify_payment(p_payment_id uuid, p_succeed boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare v_p public.payments%rowtype; v_n integer;
begin
  if p_payment_id is null or p_succeed is null then raise exception 'invalid input' using errcode = '22023'; end if;
  if not public.has_platform_role('{super_admin,operations,finance}') then
    raise exception 'not authorized: sandbox verification is staff-only' using errcode = '42501'; end if;
  select * into v_p from public.payments where id = p_payment_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_p.status not in ('initiated', 'pending') then return 'unchanged'; end if;
  if p_succeed then
    update public.payments set status = 'succeeded' where id = p_payment_id;
    update public.bookings set status = 'paid', payment_status = 'paid' where id = v_p.booking_id;
    insert into public.payment_events (payment_id, status, detail, actor_user_id)
    values (p_payment_id, 'succeeded', 'Sandbox verification succeeded.', auth.uid());
    -- Issue an invoice on success (numbers only; ZATCA submission is out of scope).
    insert into public.invoices (booking_id, invoice_number, amount_halala, vat_halala, currency, status, zatca_status, lines, created_by)
    values (v_p.booking_id, 'INV-' || to_char(now(), 'YYYYMMDD') || '-' || upper(encode(extensions.gen_random_bytes(3), 'hex')),
      v_p.amount_halala, 0, 'SAR', 'issued', 'not_submitted',
      jsonb_build_array(jsonb_build_object('description', 'Marine transfer fare (provisional tariff)', 'amount_halala', v_p.amount_halala)),
      auth.uid())
    on conflict (booking_id) do nothing;
    return 'succeeded';
  else
    update public.payments set status = 'failed' where id = p_payment_id;
    update public.bookings set status = 'reserved', payment_status = 'unpaid' where id = v_p.booking_id;
    insert into public.payment_events (payment_id, status, detail, actor_user_id)
    values (p_payment_id, 'failed', 'Sandbox verification failed. Retry is safe: idempotent by payment id.', auth.uid());
    return 'failed';
  end if;
end; $$;
revoke all on function public.verify_payment(uuid, boolean) from public, anon, service_role;
grant execute on function public.verify_payment(uuid, boolean) to authenticated;

-- Refund a succeeded sandbox payment. Requires an approved refund policy.
create or replace function public.refund_payment(p_payment_id uuid, p_amount_halala bigint, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_p public.payments%rowtype; v_prev bigint; v_pol text;
begin
  if p_payment_id is null or p_amount_halala is null or p_amount_halala <= 0
     or nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 500 then
    raise exception 'invalid input' using errcode = '22023'; end if;
  if not public.has_platform_role('{super_admin,finance}') then raise exception 'not authorized' using errcode = '42501'; end if;
  select status into v_pol from public.service_policies where policy_type = 'refund' and status = 'approved'
   order by effective_from desc limit 1;
  if v_pol is null then raise exception 'refund_policy_not_approved: refunds are inactive until ATCO approves a refund policy' using errcode = '55000'; end if;
  select * into v_p from public.payments where id = p_payment_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_p.status not in ('succeeded', 'partially_refunded') then
    raise exception 'invalid_transition: only succeeded payments can be refunded' using errcode = '55000'; end if;
  select coalesce(sum(amount_halala), 0) into v_prev from public.payment_events
   where payment_id = p_payment_id and status = 'refunded';
  if v_prev + p_amount_halala > v_p.amount_halala then
    raise exception 'invalid amount: refund exceeds captured amount' using errcode = '22023'; end if;
  insert into public.payment_events (payment_id, status, detail, actor_user_id)
  values (p_payment_id, 'refunded', 'Sandbox refund ' || p_amount_halala || ' halala: ' || btrim(p_reason), auth.uid());
  if v_prev + p_amount_halala >= v_p.amount_halala then
    update public.payments set status = 'refunded' where id = p_payment_id;
    update public.bookings set payment_status = 'refunded', status = 'refunded' where id = v_p.booking_id;
  else
    update public.payments set status = 'partially_refunded' where id = p_payment_id;
    update public.bookings set payment_status = 'partially_refunded' where id = v_p.booking_id;
  end if;
  return 'refunded';
end; $$;
revoke all on function public.refund_payment(uuid, bigint, text) from public, anon, service_role;
grant execute on function public.refund_payment(uuid, bigint, text) to authenticated;

-- 3. Material tariffs, delivery records --------------------------------------------
create table if not exists public.material_tariffs (
  id uuid primary key default gen_random_uuid(),
  code text not null unique constraint material_tariffs_code_length check (char_length(btrim(code)) between 1 and 64),
  basis text not null constraint material_tariffs_basis_check check (basis in ('per_kg', 'per_cbm', 'per_item', 'flat')),
  rate_halala bigint not null constraint material_tariffs_rate_range check (rate_halala between 0 and 9000000000000),
  currency text not null default 'SAR' constraint material_tariffs_currency_check check (currency = 'SAR'),
  active boolean not null default true,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
alter table public.material_tariffs enable row level security;
drop policy if exists material_tariffs_select_all on public.material_tariffs;
create policy material_tariffs_select_all on public.material_tariffs for select to authenticated using (true);
drop policy if exists material_tariffs_write_staff on public.material_tariffs;
create policy material_tariffs_write_staff on public.material_tariffs for all to authenticated
  using (public.has_platform_role('{super_admin,finance,operations}'))
  with check (public.has_platform_role('{super_admin,finance,operations}'));
revoke all on public.material_tariffs from public, anon, authenticated, service_role;
grant select on public.material_tariffs to authenticated;
grant insert (code, basis, rate_halala, currency, active) on public.material_tariffs to authenticated;
grant update (code, basis, rate_halala, currency, active) on public.material_tariffs to authenticated;
insert into public.material_tariffs (code, basis, rate_halala, currency, active) values
  ('MAT-PERKG-2026-PENDING', 'per_kg', 500, 'SAR', true),
  ('MAT-FLAT-2026-PENDING', 'flat', 50000, 'SAR', true)
on conflict (code) do nothing;

create table if not exists public.delivery_records (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.transfer_requests (id) on delete cascade,
  delivered_at timestamptz not null default now(),
  receiver_name text constraint delivery_receiver_length check (receiver_name is null or char_length(btrim(receiver_name)) between 1 and 120),
  signature_ref text constraint delivery_signature_length check (signature_ref is null or char_length(signature_ref) <= 256),
  photo_urls text[] not null default '{}',
  notes text constraint delivery_notes_length check (notes is null or char_length(notes) <= 1000),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
alter table public.delivery_records enable row level security;
drop policy if exists delivery_records_select_staff on public.delivery_records;
create policy delivery_records_select_staff on public.delivery_records for select to authenticated
  using (public.has_platform_role('{super_admin,operations}')
    or exists (select 1 from public.transfer_requests r where r.id = delivery_records.request_id));
revoke all on public.delivery_records from public, anon, authenticated;
grant select on public.delivery_records to authenticated;

create or replace function public.record_delivery(p_request_id uuid, p_receiver_name text, p_signature_ref text, p_photo_urls text[], p_notes text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; u text;
begin
  if p_request_id is null then raise exception 'invalid request' using errcode = '22023'; end if;
  if not public.has_platform_role('{super_admin,operations}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_receiver_name is not null and (char_length(btrim(p_receiver_name)) < 1 or char_length(btrim(p_receiver_name)) > 120) then
    raise exception 'invalid receiver name' using errcode = '22023'; end if;
  if p_signature_ref is not null and char_length(p_signature_ref) > 256 then raise exception 'invalid signature reference' using errcode = '22023'; end if;
  if p_notes is not null and char_length(p_notes) > 1000 then raise exception 'invalid notes' using errcode = '22023'; end if;
  if p_photo_urls is not null then
    foreach u in array p_photo_urls loop
      if u is null or char_length(u) > 2048 or u !~ '^https?://' then raise exception 'invalid photo url' using errcode = '22023'; end if;
    end loop;
  end if;
  insert into public.delivery_records (request_id, receiver_name, signature_ref, photo_urls, notes, created_by)
  values (p_request_id, nullif(btrim(p_receiver_name), ''), nullif(btrim(p_signature_ref), ''),
          coalesce(p_photo_urls, '{}'), nullif(btrim(p_notes), ''), auth.uid())
  returning id into v_id;
  return v_id;
end; $$;
revoke all on function public.record_delivery(uuid, text, text, text[], text) from public, anon, service_role;
grant execute on function public.record_delivery(uuid, text, text, text[], text) to authenticated;

-- 4. Agent settlement foundations (rates inactive) -----------------------------------
create table if not exists public.agent_settlements (
  id uuid primary key default gen_random_uuid(),
  agent_organization_id uuid not null references public.organizations (id),
  period_start date not null, period_end date not null,
  revenue_halala bigint not null default 0 check (revenue_halala >= 0),
  fees_halala bigint not null default 0 check (fees_halala >= 0),
  adjustments_halala bigint not null default 0,
  status text not null default 'draft' check (status in ('draft', 'approved', 'paid')),
  approved_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  constraint agent_settlements_period_order check (period_end >= period_start)
);
alter table public.agent_settlements enable row level security;
drop policy if exists agent_settlements_select_staff on public.agent_settlements;
create policy agent_settlements_select_staff on public.agent_settlements for select to authenticated
  using (public.has_platform_role('{super_admin,finance,operations}'));
revoke all on public.agent_settlements from public, anon, authenticated;
grant select on public.agent_settlements to authenticated;

-- 5. Staff reports (definer functions; RLS bypass is intentional and role-gated) -----
create or replace function public.report_sailing_occupancy(p_from date, p_to date)
returns table (sailing_id uuid, departs_at timestamptz, origin text, destination text,
  seat_capacity integer, seats_booked integer, ticket_count bigint, threshold_met boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,operations,finance}') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'invalid date range' using errcode = '22023'; end if;
  return query
    select s.id, s.departs_at, r.origin, r.destination, s.seat_capacity, s.seats_booked,
      (select count(*) from public.tickets t join public.bookings b on b.id = t.booking_id
        where t.sailing_id = s.id and t.status <> 'cancelled' and b.status <> 'cancelled'),
      (select m.threshold_met from public.sailing_minimum_status(s.id) m)
    from public.sailings s join public.routes r on r.id = s.route_id
    where s.departs_at::date between p_from and p_to order by s.departs_at;
end; $$;
revoke all on function public.report_sailing_occupancy(date, date) from public, anon, service_role;
grant execute on function public.report_sailing_occupancy(date, date) to authenticated;

create or replace function public.report_revenue_by_sailing(p_from date, p_to date)
returns table (sailing_id uuid, departs_at timestamptz, bookings bigint, passengers bigint,
  collected_halala bigint, refunded_halala bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,finance,operations}') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'invalid date range' using errcode = '22023'; end if;
  return query
    select s.id, s.departs_at,
      count(distinct b.id) filter (where b.status <> 'cancelled'),
      coalesce(sum(l.passengers) filter (where b.status <> 'cancelled'), 0),
      coalesce(sum(p.amount_halala) filter (where p.status = 'succeeded'), 0),
      coalesce((select sum(e.amount_halala) from public.payment_events e join public.payments p2 on p2.id = e.payment_id
        join public.booking_legs l2 on l2.booking_id = p2.booking_id
        where l2.sailing_id = s.id and e.status = 'refunded'), 0)
    from public.sailings s
    left join public.booking_legs l on l.sailing_id = s.id
    left join public.bookings b on b.id = l.booking_id
    left join public.payments p on p.booking_id = b.id
    where s.departs_at::date between p_from and p_to
    group by s.id, s.departs_at order by s.departs_at;
end; $$;
revoke all on function public.report_revenue_by_sailing(date, date) from public, anon, service_role;
grant execute on function public.report_revenue_by_sailing(date, date) to authenticated;

-- 6. Payment notifications (sandbox events only) --------------------------------------
create or replace function public.notify_payment_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  select b.created_by into v_user from public.payments p join public.bookings b on b.id = p.booking_id
   where p.id = new.payment_id;
  if v_user is not null then
    perform public.emit_notification(v_user, 'payment:' || new.payment_id::text || ':' || new.status, 'payment', '/bookings');
  end if;
  return new;
end; $$;
revoke all on function public.notify_payment_event() from public, anon, authenticated, service_role;
drop trigger if exists trg_notify_payment on public.payment_events;
create trigger trg_notify_payment after insert on public.payment_events
  for each row execute function public.notify_payment_event();