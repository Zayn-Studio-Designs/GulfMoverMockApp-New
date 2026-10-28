-- ===========================================================================
-- 20261101100002 — Phase 8: provider-independent payments, verified results,
-- webhook de-duplication, invoices with sequential numbers + line items,
-- receipts, refund workflow (four-eyes, policy-gated), credit notes and
-- ZATCA-preparation fields (ICV, previous-hash chain, Phase-1 QR TLV).
-- ===========================================================================
-- Proof of payment is ONLY a server-side result applied by
--   * apply_payment_result()  — service role (edge function) after a verified
--     webhook or a server-to-server status fetch from the provider, or
--   * the sandbox simulator   — refused whenever payments.mode <> 'sandbox'.
-- A browser redirect/callback never changes payment state.
-- No card data is stored. Provider secrets live only in edge-function env.
-- Nothing here is a ZATCA-compliant integration; see docs/payments-and-einvoicing.md.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Per-leg pricing (so invoice lines and booking totals agree exactly)
-- ---------------------------------------------------------------------------
create or replace function public.quote_passenger_fare(p_outbound_sailing_id uuid, p_return_sailing_id uuid, p_passenger_count integer)
returns table (tariff_id uuid, tariff_code text, tariff_status text, unit_halala bigint, quantity integer,
               net_halala bigint, vat_halala bigint, total_halala bigint, vat_mode text, vat_rate_bp integer, currency text)
language plpgsql stable security definer set search_path = '' as $$
declare v_route uuid; v_at timestamptz; v_t public.tariffs; v_legs integer; v_b record;
begin
  if p_outbound_sailing_id is null or p_passenger_count is null or p_passenger_count < 1 or p_passenger_count > 1000 then
    raise exception 'invalid quote request' using errcode = '22023'; end if;
  select s.route_id, s.departs_at into v_route, v_at from public.sailings s where s.id = p_outbound_sailing_id;
  if not found then raise exception 'sailing not found' using errcode = 'P0002'; end if;
  v_t := public.applicable_tariff(v_route, v_at);
  if v_t.id is null then raise exception 'no active tariff' using errcode = 'P0001'; end if;
  v_legs := case when p_return_sailing_id is null then 1 else 2 end;
  select * into v_b from public.vat_breakdown(v_t.per_person_halala * p_passenger_count, v_t.vat_mode, coalesce(v_t.vat_rate_bp, 0));
  return query select v_t.id, v_t.code, v_t.approval_status, v_t.per_person_halala, p_passenger_count * v_legs,
    v_b.net_halala * v_legs, v_b.vat_halala * v_legs, v_b.gross_halala * v_legs, v_t.vat_mode, coalesce(v_t.vat_rate_bp, 0), v_t.currency;
end; $$;

create or replace function public._price_booking(p_booking_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_b public.bookings%rowtype; v_route uuid; v_at timestamptz; v_t public.tariffs; v_legs integer; v_x record;
begin
  select * into v_b from public.bookings where id = p_booking_id for update;
  if not found or v_b.payment_status <> 'unpaid' then return; end if;
  if exists (select 1 from public.payments p where p.booking_id = p_booking_id) then return; end if;
  select s.route_id, s.departs_at into v_route, v_at
    from public.booking_legs l join public.sailings s on s.id = l.sailing_id
   where l.booking_id = p_booking_id and l.leg = 'outbound';
  if not found then return; end if;
  select count(*) into v_legs from public.booking_legs where booking_id = p_booking_id;
  v_t := public.applicable_tariff(v_route, v_at);
  if v_t.id is null then raise exception 'no active tariff' using errcode = 'P0001'; end if;
  select * into v_x from public.vat_breakdown(v_t.per_person_halala * v_b.passenger_count, v_t.vat_mode, coalesce(v_t.vat_rate_bp, 0));
  update public.bookings set tariff_id = v_t.id, tariff_status = v_t.approval_status,
    net_halala = v_x.net_halala * v_legs, vat_halala = v_x.vat_halala * v_legs, total_halala = v_x.gross_halala * v_legs,
    fare_halala = v_x.gross_halala * v_legs, vat_mode = v_t.vat_mode, vat_rate_bp = coalesce(v_t.vat_rate_bp, 0)
   where id = p_booking_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 1. Payments: provider-independent shape
-- ---------------------------------------------------------------------------
alter table public.payments
  add column if not exists idempotency_key uuid,
  add column if not exists provider_payment_id text constraint payments_provider_payment_id_length check (provider_payment_id is null or char_length(provider_payment_id) <= 200),
  add column if not exists checkout_url text constraint payments_checkout_url_https check (checkout_url is null or ((checkout_url ~ '^https://' or checkout_url ~ '^http://(127[.]0[.]0[.]1|localhost)(:[0-9]+)?/') and char_length(checkout_url) <= 2048)),
  add column if not exists fee_halala bigint constraint payments_fee_range check (fee_halala is null or fee_halala >= 0),
  add column if not exists refunded_halala bigint not null default 0 constraint payments_refunded_range check (refunded_halala >= 0),
  add column if not exists failure_reason text constraint payments_failure_reason_length check (failure_reason is null or char_length(failure_reason) <= 500),
  add column if not exists verified_at timestamptz,
  add column if not exists verified_via text constraint payments_verified_via_check check (verified_via is null or verified_via in ('webhook', 'server_fetch', 'sandbox_simulation')),
  add column if not exists mode text not null default 'sandbox' constraint payments_mode_check check (mode in ('sandbox', 'live'));

alter table public.payments drop constraint if exists payments_status_check;
alter table public.payments add constraint payments_status_check check (status in (
  'initiated', 'pending', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'expired', 'cancelled', 'requires_review'));
alter table public.payments drop constraint if exists payments_refund_not_above_amount;
alter table public.payments add constraint payments_refund_not_above_amount check (refunded_halala <= amount_halala);

-- Upgrade safety: at most one in-flight payment per booking (older duplicates are cancelled).
update public.payments p set status = 'cancelled', updated_at = now()
 where p.status in ('initiated', 'pending')
   and exists (select 1 from public.payments q where q.booking_id = p.booking_id and q.status in ('initiated', 'pending')
               and (q.created_at > p.created_at or (q.created_at = p.created_at and q.id > p.id)));
create unique index if not exists payments_one_in_flight_per_booking on public.payments (booking_id) where status in ('initiated', 'pending');
create unique index if not exists payments_booking_idempotency on public.payments (booking_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists payments_provider_payment on public.payments (provider, provider_payment_id) where provider_payment_id is not null;
update public.payments set refunded_halala = coalesce((select sum(e.amount_halala) from public.payment_events e
  where e.payment_id = payments.id and e.status = 'refunded'), 0) where refunded_halala = 0;

create table if not exists public.payment_provider_events (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null,
  event_id            text not null constraint payment_provider_events_event_id_length check (char_length(event_id) between 1 and 200),
  event_type          text not null default '',
  payment_id          uuid references public.payments (id),
  provider_payment_id text,
  verified_via        text not null,
  payload_sha256      text constraint payment_provider_events_hash_format check (payload_sha256 is null or payload_sha256 ~ '^[0-9a-f]{64}$'),
  outcome             text,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  constraint payment_provider_events_unique unique (provider, event_id)
);
comment on table public.payment_provider_events is
  'One row per provider event (webhook or status fetch). The unique key makes duplicate deliveries harmless. Payload bodies are not stored, only their SHA-256.';
alter table public.payment_provider_events enable row level security;
drop policy if exists payment_provider_events_finance on public.payment_provider_events;
create policy payment_provider_events_finance on public.payment_provider_events for select to authenticated
  using (public.has_platform_role('{super_admin,finance}'));
revoke all on public.payment_provider_events from public, anon, authenticated, service_role;
grant select on public.payment_provider_events to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Document numbering, invoices, lines, credit notes, refunds
-- ---------------------------------------------------------------------------
create table if not exists public.document_counters (
  series     text not null,
  period     integer not null,
  last_value bigint not null default 0,
  primary key (series, period)
);
alter table public.document_counters enable row level security;
revoke all on public.document_counters from public, anon, authenticated, service_role;

-- Gap-free within a committed transaction (row lock, no sequence caching).
create or replace function public._next_document_value(p_series text, p_period integer)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  insert into public.document_counters (series, period, last_value) values (p_series, p_period, 1)
  on conflict (series, period) do update set last_value = public.document_counters.last_value + 1
  returning last_value into v;
  return v;
end; $$;
revoke all on function public._next_document_value(text, integer) from public, anon, authenticated, service_role;

alter table public.invoices
  add column if not exists document_type text not null default 'commercial_invoice'
    constraint invoices_document_type_check check (document_type in ('tax_invoice', 'simplified_tax_invoice', 'commercial_invoice')),
  add column if not exists organization_id uuid references public.organizations (id),
  add column if not exists settlement_mode text not null default 'pay_now' constraint invoices_settlement_mode_check check (settlement_mode in ('pay_now', 'on_account')),
  add column if not exists issue_date date,
  add column if not exists due_date date,
  add column if not exists net_halala bigint,
  add column if not exists total_halala bigint,
  add column if not exists amount_paid_halala bigint not null default 0,
  add column if not exists payment_id uuid references public.payments (id),
  add column if not exists tariff_id uuid references public.tariffs (id),
  add column if not exists buyer jsonb not null default '{}',
  add column if not exists seller jsonb not null default '{}',
  add column if not exists icv bigint,
  add column if not exists previous_hash text,
  add column if not exists invoice_hash text,
  add column if not exists document_uuid uuid not null default gen_random_uuid(),
  add column if not exists qr_tlv text,
  add column if not exists sandbox boolean not null default false,
  add column if not exists paid_at timestamptz;
alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check check (status in ('issued', 'partially_paid', 'paid', 'credited', 'void'));
create unique index if not exists invoices_icv_unique on public.invoices (icv) where icv is not null;

-- Backfill Phase 7 invoices (they were only ever issued on a succeeded sandbox payment).
update public.invoices i set net_halala = coalesce(i.net_halala, i.amount_halala),
  total_halala = coalesce(i.total_halala, i.amount_halala + i.vat_halala),
  amount_paid_halala = case when i.status = 'issued' then i.amount_halala + i.vat_halala else i.amount_paid_halala end,
  status = case when i.status = 'issued' then 'paid' else i.status end,
  issue_date = coalesce(i.issue_date, (i.created_at at time zone 'Asia/Riyadh')::date),
  sandbox = true, paid_at = coalesce(i.paid_at, i.created_at),
  organization_id = (select b.organization_id from public.bookings b where b.id = i.booking_id)
 where i.total_halala is null;

-- Visibility: Finance sees everything; organizations see their own; creators see their booking's.
drop policy if exists invoices_select_via_booking on public.invoices;
create policy invoices_select_via_booking on public.invoices for select to authenticated
  using (public.has_platform_role('{super_admin,finance}')
         or exists (select 1 from public.bookings b where b.id = invoices.booking_id));
drop policy if exists payments_select_via_booking on public.payments;
create policy payments_select_via_booking on public.payments for select to authenticated
  using (public.has_platform_role('{super_admin,finance}')
         or exists (select 1 from public.bookings b where b.id = payments.booking_id));

create table if not exists public.invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references public.invoices (id) on delete cascade,
  line_no       integer not null,
  description   text not null,
  description_ar text,
  quantity      integer not null check (quantity > 0),
  unit_halala   bigint not null check (unit_halala >= 0),
  net_halala    bigint not null check (net_halala >= 0),
  vat_rate_bp   integer not null default 0,
  vat_halala    bigint not null default 0 check (vat_halala >= 0),
  total_halala  bigint not null check (total_halala >= 0),
  sailing_id    uuid references public.sailings (id),
  unique (invoice_id, line_no)
);
alter table public.invoice_lines enable row level security;
drop policy if exists invoice_lines_via_invoice on public.invoice_lines;
create policy invoice_lines_via_invoice on public.invoice_lines for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_lines.invoice_id));
revoke all on public.invoice_lines from public, anon, authenticated, service_role;
grant select on public.invoice_lines to authenticated;

create table if not exists public.refunds (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references public.payments (id),
  booking_id         uuid not null references public.bookings (id),
  amount_halala      bigint not null check (amount_halala > 0),
  reason             text not null check (char_length(reason) between 1 and 500),
  status             text not null default 'pending_review'
    constraint refunds_status_check check (status in ('pending_review', 'approved', 'rejected', 'processing', 'succeeded', 'failed')),
  idempotency_key    uuid not null default gen_random_uuid() unique,
  requested_by       uuid references auth.users (id),
  requested_at       timestamptz not null default now(),
  decided_by         uuid references auth.users (id),
  decided_at         timestamptz,
  decision_reason    text,
  policy_version     text,
  provider_refund_id text,
  credit_note_id     uuid,
  sandbox            boolean not null default true,
  updated_at         timestamptz not null default now()
);
create unique index if not exists refunds_one_open_per_payment on public.refunds (payment_id) where status in ('pending_review', 'approved', 'processing');
alter table public.refunds enable row level security;
drop policy if exists refunds_select on public.refunds;
create policy refunds_select on public.refunds for select to authenticated
  using (public.has_platform_role('{super_admin,finance}') or exists (select 1 from public.bookings b where b.id = refunds.booking_id));
revoke all on public.refunds from public, anon, authenticated, service_role;
grant select on public.refunds to authenticated;

create table if not exists public.credit_notes (
  id            uuid primary key default gen_random_uuid(),
  credit_number text not null unique,
  invoice_id    uuid not null references public.invoices (id),
  booking_id    uuid not null references public.bookings (id),
  refund_id     uuid references public.refunds (id),
  net_halala    bigint not null check (net_halala >= 0),
  vat_halala    bigint not null check (vat_halala >= 0),
  total_halala  bigint not null check (total_halala > 0),
  reason        text not null,
  icv           bigint unique,
  previous_hash text,
  document_hash text,
  document_uuid uuid not null default gen_random_uuid(),
  sandbox       boolean not null default false,
  created_by    uuid references auth.users (id),
  created_at    timestamptz not null default now()
);
alter table public.credit_notes enable row level security;
drop policy if exists credit_notes_select on public.credit_notes;
create policy credit_notes_select on public.credit_notes for select to authenticated
  using (public.has_platform_role('{super_admin,finance}') or exists (select 1 from public.bookings b where b.id = credit_notes.booking_id));
revoke all on public.credit_notes from public, anon, authenticated, service_role;
grant select on public.credit_notes to authenticated;

-- ---------------------------------------------------------------------------
-- 3. ZATCA-preparation helpers (QR TLV Phase 1 fields, hash chain)
-- ---------------------------------------------------------------------------
create or replace function public.zatca_tlv(p_tag integer, p_value text)
returns bytea language plpgsql immutable set search_path = '' as $$
declare v bytea := convert_to(coalesce(p_value, ''), 'UTF8');
begin
  if p_tag < 1 or p_tag > 255 or octet_length(v) > 255 then raise exception 'invalid tlv' using errcode = '22023'; end if;
  return decode(lpad(to_hex(p_tag), 2, '0') || lpad(to_hex(octet_length(v)), 2, '0'), 'hex') || v;
end; $$;

-- Seller name, VAT number, timestamp, invoice total (with VAT), VAT total — base64.
create or replace function public.zatca_qr_tlv(p_seller text, p_vat_number text, p_timestamp timestamptz, p_total_halala bigint, p_vat_halala bigint)
returns text language sql immutable set search_path = '' as $$
  -- PostgreSQL wraps base64 at 76 characters; QR payloads must be one line.
  select replace(encode(public.zatca_tlv(1, p_seller) || public.zatca_tlv(2, p_vat_number)
    || public.zatca_tlv(3, to_char(p_timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    || public.zatca_tlv(4, to_char(p_total_halala / 100, 'FM9999999999990') || '.' || lpad((p_total_halala % 100)::text, 2, '0'))
    || public.zatca_tlv(5, to_char(p_vat_halala / 100, 'FM9999999999990') || '.' || lpad((p_vat_halala % 100)::text, 2, '0')), 'base64'), E'\n', '')
$$;
grant execute on function public.zatca_tlv(integer, text), public.zatca_qr_tlv(text, text, timestamptz, bigint, bigint) to authenticated, service_role;

-- Initial previous-invoice hash as used in ZATCA SDK samples: base64 of the hex
-- SHA-256 of "0". To be confirmed against ZATCA's current specification.
create or replace function public._zatca_initial_pih() returns text language sql immutable set search_path = '' as $$
  select 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ=='::text
$$;

-- Previous document hash across invoices AND credit notes (one ICV sequence).
create or replace function public._last_document_hash()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select h from (
    select icv, invoice_hash as h from public.invoices where icv is not null
    union all select icv, document_hash from public.credit_notes where icv is not null) d
    order by icv desc limit 1), public._zatca_initial_pih())
$$;
revoke all on function public._last_document_hash() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Invoice issuance from persisted booking + tariff (+ payment when paid)
-- ---------------------------------------------------------------------------
create or replace function public._issue_booking_invoice(p_booking_id uuid, p_payment_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_b public.bookings%rowtype; v_inv public.invoices%rowtype; v_id uuid; v_year integer; v_num text;
  v_seller text; v_vatno text; v_doc text; v_buyer jsonb; v_terms integer; v_leg record; v_line integer := 0;
  v_x record; v_unit bigint; v_icv bigint; v_prev text; v_hash text; v_pay public.payments%rowtype; v_org record;
begin
  select * into v_b from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'booking not found' using errcode = 'P0002'; end if;
  if p_payment_id is not null then
    select * into v_pay from public.payments where id = p_payment_id;
    if v_pay.status <> 'succeeded' then raise exception 'payment not succeeded' using errcode = '55000'; end if;
  end if;
  select * into v_inv from public.invoices where booking_id = p_booking_id for update;
  if found then
    if p_payment_id is not null and v_inv.status in ('issued', 'partially_paid') then
      update public.invoices set amount_paid_halala = least(total_halala, amount_paid_halala + v_pay.amount_halala),
        status = case when amount_paid_halala + v_pay.amount_halala >= total_halala then 'paid' else 'partially_paid' end,
        payment_id = p_payment_id, paid_at = case when amount_paid_halala + v_pay.amount_halala >= total_halala then now() end
       where id = v_inv.id;
    end if;
    return v_inv.id;
  end if;
  if v_b.total_halala is null then raise exception 'booking not priced' using errcode = 'P0001'; end if;
  if p_payment_id is null and v_b.settlement_mode <> 'on_account' then
    raise exception 'invoice_requires_payment: pay-now bookings are invoiced only after a verified payment' using errcode = '55000'; end if;

  v_seller := public.setting_text('seller.legal_name', null);
  v_vatno := public.setting_text('seller.vat_number', null);
  if v_b.organization_id is not null then
    select o.legal_name, o.registration_number, o.payment_terms_days into v_org from public.organizations o where o.id = v_b.organization_id;
    v_buyer := jsonb_build_object('type', v_b.account_type, 'name', v_org.legal_name, 'registration_number', v_org.registration_number,
                                  'client_name', v_b.client_name, 'po_reference', v_b.po_reference);
    v_terms := v_org.payment_terms_days;
  else
    v_buyer := jsonb_build_object('type', 'individual', 'name', v_b.contact_name);
  end if;
  v_doc := case when v_seller is null or v_vatno is null or coalesce(v_b.vat_mode, 'not_configured') not in ('exclusive', 'inclusive') then 'commercial_invoice'
                when v_b.organization_id is not null then 'tax_invoice' else 'simplified_tax_invoice' end;
  v_year := extract(year from (now() at time zone 'Asia/Riyadh'))::int;
  v_num := 'GM-INV-' || v_year || '-' || lpad(public._next_document_value('invoice', v_year)::text, 6, '0');
  v_icv := public._next_document_value('icv', 0);
  v_prev := public._last_document_hash();

  insert into public.invoices (booking_id, invoice_number, amount_halala, vat_halala, currency, status, zatca_status, lines,
    created_by, document_type, organization_id, settlement_mode, issue_date, due_date, net_halala, total_halala,
    amount_paid_halala, payment_id, tariff_id, buyer, seller, icv, previous_hash, sandbox, paid_at)
  values (p_booking_id, v_num, v_b.net_halala, v_b.vat_halala, 'SAR',
    case when p_payment_id is not null then 'paid' else 'issued' end, 'not_submitted', '[]', auth.uid(), v_doc,
    v_b.organization_id, v_b.settlement_mode, (now() at time zone 'Asia/Riyadh')::date,
    case when v_b.settlement_mode = 'on_account' then (now() at time zone 'Asia/Riyadh')::date + coalesce(v_terms, 0) end,
    v_b.net_halala, v_b.total_halala, case when p_payment_id is not null then v_b.total_halala else 0 end,
    p_payment_id, v_b.tariff_id, v_buyer,
    jsonb_build_object('legal_name', v_seller, 'vat_number', v_vatno), v_icv, v_prev,
    coalesce(v_pay.mode, 'sandbox') = 'sandbox' and p_payment_id is not null,
    case when p_payment_id is not null then now() end)
  returning id into v_id;

  select per_person_halala into v_unit from public.tariffs where id = v_b.tariff_id;
  for v_leg in select l.leg, l.passengers, l.sailing_id, s.departs_at, r.origin, r.destination
                 from public.booking_legs l join public.sailings s on s.id = l.sailing_id join public.routes r on r.id = s.route_id
                where l.booking_id = p_booking_id order by l.leg desc loop
    v_line := v_line + 1;
    select * into v_x from public.vat_breakdown(coalesce(v_unit, 0) * v_leg.passengers, coalesce(v_b.vat_mode, 'not_configured'), coalesce(v_b.vat_rate_bp, 0));
    insert into public.invoice_lines (invoice_id, line_no, description, description_ar, quantity, unit_halala, net_halala,
      vat_rate_bp, vat_halala, total_halala, sailing_id)
    values (v_id, v_line,
      'Passenger fare (' || v_leg.leg || ') ' || v_leg.origin || ' -> ' || v_leg.destination || ' '
        || to_char(v_leg.departs_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI') || ' Asia/Riyadh',
      'أجرة راكب (' || case when v_leg.leg = 'outbound' then 'ذهاب' else 'عودة' end || ')',
      v_leg.passengers, coalesce(v_unit, 0), v_x.net_halala, coalesce(v_b.vat_rate_bp, 0), v_x.vat_halala, v_x.gross_halala, v_leg.sailing_id);
  end loop;
  -- Lines must reconcile to the booking (and therefore to the payment).
  if (select coalesce(sum(total_halala), -1) from public.invoice_lines where invoice_id = v_id) <> v_b.total_halala then
    raise exception 'invoice_mismatch: lines do not reconcile to the booking total' using errcode = 'P0001'; end if;
  update public.invoices set lines = (select jsonb_agg(jsonb_build_object('description', description, 'quantity', quantity,
      'unit_halala', unit_halala, 'net_halala', net_halala, 'vat_halala', vat_halala, 'amount_halala', total_halala) order by line_no)
      from public.invoice_lines where invoice_id = v_id)
   where id = v_id;
  v_hash := encode(extensions.digest(convert_to(v_num || '|' || v_icv || '|' || v_prev || '|' || v_b.total_halala || '|' || v_b.vat_halala
           || '|' || (select string_agg(line_no || ':' || total_halala, ',' order by line_no) from public.invoice_lines where invoice_id = v_id), 'UTF8'), 'sha256'), 'base64');
  v_hash := replace(v_hash, E'\n', '');
  update public.invoices set invoice_hash = v_hash,
    qr_tlv = case when v_doc <> 'commercial_invoice' then public.zatca_qr_tlv(v_seller, v_vatno, now(), v_b.total_halala, v_b.vat_halala) end
   where id = v_id;
  insert into public.booking_events (booking_id, action, actor_user_id, details)
  values (p_booking_id, 'invoiced', auth.uid(), jsonb_build_object('invoice_number', v_num, 'document_type', v_doc));
  return v_id;
end; $$;
revoke all on function public._issue_booking_invoice(uuid, uuid) from public, anon, authenticated, service_role;

-- Credit note against a booking's invoice (refunds and on-account cancellations).
create or replace function public._issue_credit_note(p_booking_id uuid, p_refund_id uuid, p_total_halala bigint, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_inv public.invoices%rowtype; v_x record; v_year integer; v_num text; v_icv bigint; v_prev text; v_id uuid; v_rate integer; v_credited bigint;
begin
  select * into v_inv from public.invoices where booking_id = p_booking_id for update;
  if not found then return null; end if;
  select coalesce(sum(total_halala), 0) into v_credited from public.credit_notes where invoice_id = v_inv.id;
  if v_credited + p_total_halala > v_inv.total_halala then raise exception 'credit exceeds invoice' using errcode = '22023'; end if;
  select vat_rate_bp into v_rate from public.invoice_lines where invoice_id = v_inv.id order by line_no limit 1;
  select * into v_x from public.vat_breakdown(p_total_halala, case when coalesce(v_rate, 0) > 0 then 'inclusive' else 'not_configured' end, coalesce(v_rate, 0));
  v_year := extract(year from (now() at time zone 'Asia/Riyadh'))::int;
  v_num := 'GM-CN-' || v_year || '-' || lpad(public._next_document_value('credit_note', v_year)::text, 6, '0');
  v_icv := public._next_document_value('icv', 0);
  v_prev := public._last_document_hash();
  insert into public.credit_notes (credit_number, invoice_id, booking_id, refund_id, net_halala, vat_halala, total_halala, reason,
    icv, previous_hash, document_hash, sandbox, created_by)
  values (v_num, v_inv.id, p_booking_id, p_refund_id, v_x.net_halala, v_x.vat_halala, p_total_halala, left(p_reason, 500),
    v_icv, v_prev, encode(extensions.digest(convert_to(v_num || '|' || v_icv || '|' || v_prev || '|' || p_total_halala, 'UTF8'), 'sha256'), 'base64'),
    v_inv.sandbox, auth.uid())
  returning id into v_id;
  if v_credited + p_total_halala >= v_inv.total_halala then update public.invoices set status = 'credited' where id = v_inv.id; end if;
  return v_id;
end; $$;
revoke all on function public._issue_credit_note(uuid, uuid, bigint, text) from public, anon, authenticated, service_role;

create or replace function public._credit_on_account_invoice(p_booking_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_inv public.invoices%rowtype;
begin
  select * into v_inv from public.invoices where booking_id = p_booking_id and settlement_mode = 'on_account';
  if not found or v_inv.status not in ('issued', 'partially_paid') then return; end if;
  perform public._issue_credit_note(p_booking_id, null, v_inv.total_halala - v_inv.amount_paid_halala, p_reason);
end; $$;
revoke all on function public._credit_on_account_invoice(uuid, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Checkout initiation (server amount, idempotent, one in flight)
-- ---------------------------------------------------------------------------
create or replace function public.begin_checkout(p_booking_id uuid, p_method text, p_idempotency_key uuid)
returns table (payment_id uuid, merchant_reference text, amount_halala bigint, currency text, provider text, mode text, outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_b public.bookings%rowtype; v_p public.payments%rowtype; v_mode text; v_provider text; v_ref text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_booking_id is null or p_idempotency_key is null or p_method is null
     or p_method not in ('mada', 'visa', 'mastercard', 'apple_pay') then
    raise exception 'invalid input' using errcode = '22023'; end if;
  select * into v_b from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if not (v_b.created_by = auth.uid() or (v_b.organization_id is not null and public.has_org_role(v_b.organization_id, '{company_admin}'))) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into v_p from public.payments p where p.booking_id = p_booking_id and p.idempotency_key = p_idempotency_key;
  if found then
    if v_p.method <> p_method then raise exception 'payload_mismatch' using errcode = '22023'; end if;
    return query select v_p.id, v_p.provider_ref, v_p.amount_halala, v_p.currency, v_p.provider, v_p.mode, 'replayed'::text;
    return;
  end if;
  if v_b.settlement_mode <> 'pay_now' then raise exception 'invalid_transition: on-account booking' using errcode = '55000'; end if;
  if v_b.status not in ('reserved', 'pending_payment') or v_b.payment_status not in ('unpaid', 'pending') then
    raise exception 'invalid_transition: booking is not awaiting payment' using errcode = '55000'; end if;
  if v_b.hold_expires_at is not null and v_b.hold_expires_at <= now() then
    raise exception 'hold_expired: the reservation hold has expired' using errcode = '55000'; end if;
  if v_b.total_halala is null or v_b.total_halala <= 0 then raise exception 'no fare recorded' using errcode = 'P0001'; end if;
  v_mode := public.setting_text('payments.mode', 'sandbox');
  v_provider := public.setting_text('payments.provider', 'sandbox-provider');
  if v_mode = 'live' and not public.setting_bool('payments.live_enabled', false) then
    raise exception 'payments_not_enabled: live payments are not activated' using errcode = '55000'; end if;
  if v_mode = 'sandbox' and v_provider <> 'sandbox-provider' and v_provider not in ('moyasar', 'tap', 'hyperpay') then
    raise exception 'invalid provider' using errcode = '22023'; end if;
  -- One payment in flight: an abandoned attempt without a provider id is superseded after 15 minutes.
  update public.payments p set status = 'cancelled', updated_at = now()
   where p.booking_id = p_booking_id and p.status in ('initiated', 'pending') and p.provider_payment_id is null
     and p.created_at < now() - interval '15 minutes';
  if exists (select 1 from public.payments p where p.booking_id = p_booking_id and p.status in ('initiated', 'pending')) then
    raise exception 'payment_in_progress: complete or wait for the current payment attempt' using errcode = '55000'; end if;
  v_ref := 'GMP-' || upper(encode(extensions.gen_random_bytes(10), 'hex'));
  insert into public.payments (booking_id, amount_halala, currency, method, provider, provider_ref, status, sandbox, created_by,
                               idempotency_key, mode)
  values (p_booking_id, v_b.total_halala, 'SAR', p_method, v_provider, v_ref, 'initiated', v_mode = 'sandbox', auth.uid(),
          p_idempotency_key, v_mode)
  returning id into v_id;
  insert into public.payment_events (payment_id, status, detail, actor_user_id)
  values (v_id, 'initiated', 'Checkout initiated (' || v_mode || '). Not proof of payment.', auth.uid());
  update public.bookings set status = 'pending_payment', payment_status = 'pending' where id = p_booking_id;
  return query select v_id, v_ref, v_b.total_halala, 'SAR'::text, v_provider, v_mode, 'created'::text;
end; $$;
revoke all on function public.begin_checkout(uuid, text, uuid) from public, anon, service_role;
grant execute on function public.begin_checkout(uuid, text, uuid) to authenticated;

-- Phase 7 compatibility wrapper.
create or replace function public.initiate_payment(p_booking_id uuid, p_method text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_method is null or p_method not in ('mada', 'visa', 'mastercard', 'apple_pay') then raise exception 'invalid input' using errcode = '22023'; end if;
  select c.payment_id into v_id from public.begin_checkout(p_booking_id, p_method, gen_random_uuid()) c;
  return v_id;
end; $$;

-- The edge function records the provider's checkout id and hosted-page URL.
create or replace function public.attach_provider_checkout(p_payment_id uuid, p_provider_payment_id text, p_checkout_url text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  update public.payments set provider_payment_id = p_provider_payment_id, checkout_url = p_checkout_url, status = 'pending', updated_at = now()
   where id = p_payment_id and status in ('initiated', 'pending') and (provider_payment_id is null or provider_payment_id = p_provider_payment_id);
  if not found then raise exception 'invalid_transition' using errcode = '55000'; end if;
  return 'attached';
end; $$;
revoke all on function public.attach_provider_checkout(uuid, text, text) from public, anon, authenticated;
grant execute on function public.attach_provider_checkout(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Applying a VERIFIED provider result (idempotent, amount-checked)
-- ---------------------------------------------------------------------------
create or replace function public._apply_payment_result(
  p_provider text, p_event_id text, p_event_type text, p_merchant_reference text, p_provider_payment_id text,
  p_status text, p_amount_halala bigint, p_currency text, p_fee_halala bigint, p_verified_via text, p_payload_sha256 text,
  p_failure_reason text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_event uuid; v_p public.payments%rowtype; v_b public.bookings%rowtype; v_outcome text;
begin
  if p_provider is null or p_event_id is null or p_status is null or p_status not in ('paid', 'failed', 'pending', 'cancelled') then
    raise exception 'invalid result' using errcode = '22023'; end if;
  insert into public.payment_provider_events (provider, event_id, event_type, provider_payment_id, verified_via, payload_sha256)
  values (p_provider, p_event_id, coalesce(p_event_type, ''), p_provider_payment_id, p_verified_via, p_payload_sha256)
  on conflict (provider, event_id) do nothing returning id into v_event;
  if v_event is null then return 'duplicate_event'; end if;

  select * into v_p from public.payments p
   where (p_merchant_reference is not null and p.provider_ref = p_merchant_reference)
      or (p_provider_payment_id is not null and p.provider = p_provider and p.provider_payment_id = p_provider_payment_id)
   order by p.created_at desc limit 1 for update;
  if not found then v_outcome := 'unknown_payment';
  elsif v_p.provider <> p_provider then v_outcome := 'provider_mismatch';
  elsif p_provider_payment_id is not null and exists (select 1 from public.payments o where o.provider = p_provider
          and o.provider_payment_id = p_provider_payment_id and o.id <> v_p.id) then
    -- The provider id already identifies another payment: never re-point it.
    v_outcome := 'reference_conflict';
  elsif v_p.provider_payment_id is not null and p_provider_payment_id is not null and v_p.provider_payment_id <> p_provider_payment_id then
    v_outcome := 'reference_conflict';
  elsif v_p.status in ('succeeded', 'refunded', 'partially_refunded', 'requires_review')
        or (v_p.status = 'failed' and p_status <> 'paid') then v_outcome := 'already_final';
  else
    select * into v_b from public.bookings where id = v_p.booking_id for update;
    if p_provider_payment_id is not null and v_p.provider_payment_id is null then
      update public.payments set provider_payment_id = p_provider_payment_id where id = v_p.id;
    end if;
    if p_status = 'paid' then
      if p_amount_halala is distinct from v_p.amount_halala or upper(coalesce(p_currency, '')) <> v_p.currency then
        update public.payments set status = 'requires_review', failure_reason = 'amount or currency mismatch', updated_at = now() where id = v_p.id;
        insert into public.payment_events (payment_id, status, detail, amount_halala)
        values (v_p.id, 'requires_review', 'Provider reported ' || coalesce(p_amount_halala::text, '?') || ' ' || coalesce(p_currency, '?') || '; expected ' || v_p.amount_halala || ' ' || v_p.currency, p_amount_halala);
        insert into public.booking_events (booking_id, action, actor_user_id, details) values (v_b.id, 'payment_review', null, jsonb_build_object('payment_id', v_p.id, 'reason', 'amount_mismatch'));
        v_outcome := 'amount_mismatch';
      elsif v_b.status in ('cancelled', 'expired') then
        -- Money arrived for a closed booking: never silently keep it.
        update public.payments set status = 'requires_review', verified_at = now(), verified_via = p_verified_via,
          fee_halala = p_fee_halala, failure_reason = 'captured after booking closed', updated_at = now() where id = v_p.id;
        insert into public.payment_events (payment_id, status, detail, amount_halala) values (v_p.id, 'requires_review', 'Captured after booking closed; refund review opened.', p_amount_halala);
        insert into public.refunds (payment_id, booking_id, amount_halala, reason, status, sandbox)
        values (v_p.id, v_b.id, v_p.amount_halala, 'Payment captured after the booking was ' || v_b.status, 'pending_review', v_p.mode = 'sandbox')
        on conflict do nothing;
        insert into public.booking_events (booking_id, action, actor_user_id, details) values (v_b.id, 'payment_review', null, jsonb_build_object('payment_id', v_p.id, 'reason', 'captured_after_close'));
        v_outcome := 'captured_after_close';
      else
        update public.payments set status = 'succeeded', verified_at = now(), verified_via = p_verified_via,
          fee_halala = p_fee_halala, updated_at = now() where id = v_p.id;
        insert into public.payment_events (payment_id, status, detail, amount_halala)
        values (v_p.id, 'succeeded', 'Verified by ' || p_verified_via || case when v_p.mode = 'sandbox' then ' (SANDBOX — no real money)' else '' end, v_p.amount_halala);
        update public.bookings set status = 'paid', payment_status = 'paid', hold_expires_at = null where id = v_b.id;
        insert into public.booking_events (booking_id, action, actor_user_id, details)
        values (v_b.id, 'paid', null, jsonb_build_object('payment_id', v_p.id, 'verified_via', p_verified_via, 'sandbox', v_p.mode = 'sandbox'));
        perform public._issue_booking_invoice(v_b.id, v_p.id);
        v_outcome := 'succeeded';
      end if;
    elsif p_status in ('failed', 'cancelled') then
      update public.payments set status = case when p_status = 'failed' then 'failed' else 'cancelled' end,
        failure_reason = left(coalesce(p_failure_reason, p_status), 500), updated_at = now() where id = v_p.id;
      insert into public.payment_events (payment_id, status, detail) values (v_p.id, 'failed', 'Provider result: ' || left(coalesce(p_failure_reason, p_status), 300));
      if v_b.status = 'pending_payment' then
        update public.bookings set status = 'reserved', payment_status = 'unpaid' where id = v_b.id;
      end if;
      insert into public.booking_events (booking_id, action, actor_user_id, details) values (v_b.id, 'payment_failed', null, jsonb_build_object('payment_id', v_p.id));
      v_outcome := 'failed';
    else
      update public.payments set status = 'pending', updated_at = now() where id = v_p.id and status = 'initiated';
      v_outcome := 'pending';
    end if;
  end if;
  update public.payment_provider_events set payment_id = v_p.id, outcome = v_outcome, processed_at = now() where id = v_event;
  return v_outcome;
end; $$;
revoke all on function public._apply_payment_result(text, text, text, text, text, text, bigint, text, bigint, text, text, text) from public, anon, authenticated, service_role;

create or replace function public.apply_payment_result(
  p_provider text, p_event_id text, p_event_type text, p_merchant_reference text, p_provider_payment_id text,
  p_status text, p_amount_halala bigint, p_currency text, p_fee_halala bigint, p_verified_via text, p_payload_sha256 text,
  p_failure_reason text default null)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_verified_via not in ('webhook', 'server_fetch') then raise exception 'invalid verification channel' using errcode = '22023'; end if;
  if p_provider = 'sandbox-provider' and public.setting_text('payments.mode', 'sandbox') <> 'sandbox' then
    raise exception 'sandbox_disabled' using errcode = '55000'; end if;
  return public._apply_payment_result(p_provider, p_event_id, p_event_type, p_merchant_reference, p_provider_payment_id,
    p_status, p_amount_halala, p_currency, p_fee_halala, p_verified_via, p_payload_sha256, p_failure_reason);
end; $$;
revoke all on function public.apply_payment_result(text, text, text, text, text, text, bigint, text, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_payment_result(text, text, text, text, text, text, bigint, text, bigint, text, text, text) to service_role;

-- Sandbox simulator (no real money). Refused unless payments.mode = 'sandbox' AND the
-- payment itself is a sandbox payment. Staff may simulate any outcome; the payer
-- may simulate their own sandbox checkout (stands in for the hosted page locally).
create or replace function public.sandbox_simulate_payment(p_payment_id uuid, p_outcome text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_p public.payments%rowtype; v_owner uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if public.setting_text('payments.mode', 'sandbox') <> 'sandbox' then raise exception 'sandbox_disabled' using errcode = '55000'; end if;
  if p_outcome is null or p_outcome not in ('paid', 'failed') then raise exception 'invalid outcome' using errcode = '22023'; end if;
  select * into v_p from public.payments where id = p_payment_id;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_p.mode <> 'sandbox' then raise exception 'sandbox_disabled' using errcode = '55000'; end if;
  select b.created_by into v_owner from public.bookings b where b.id = v_p.booking_id;
  if not (public.has_platform_role('{super_admin,operations,finance}') or v_owner = auth.uid()) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._apply_payment_result(v_p.provider, 'sandbox-' || p_payment_id || '-' || p_outcome, 'sandbox.' || p_outcome,
    v_p.provider_ref, coalesce(v_p.provider_payment_id, 'sbx_' || replace(p_payment_id::text, '-', '')), p_outcome,
    v_p.amount_halala, v_p.currency, 0, 'sandbox_simulation', null, case when p_outcome = 'failed' then 'Sandbox simulated decline' end);
end; $$;
revoke all on function public.sandbox_simulate_payment(uuid, text) from public, anon, service_role;
grant execute on function public.sandbox_simulate_payment(uuid, text) to authenticated;

-- Phase 7 API kept: staff-only sandbox verification, now through the same path.
create or replace function public.verify_payment(p_payment_id uuid, p_succeed boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  if p_payment_id is null or p_succeed is null then raise exception 'invalid input' using errcode = '22023'; end if;
  if not public.has_platform_role('{super_admin,operations,finance}') then
    raise exception 'not authorized: sandbox verification is staff-only' using errcode = '42501'; end if;
  v := public.sandbox_simulate_payment(p_payment_id, case when p_succeed then 'paid' else 'failed' end);
  return case v when 'already_final' then 'unchanged' when 'duplicate_event' then 'unchanged' else v end;
end; $$;

-- ---------------------------------------------------------------------------
-- 7. Refund workflow: request → (policy + four-eyes) decision → provider result
-- ---------------------------------------------------------------------------
create or replace function public._open_refund_review(p_booking_id uuid, p_reason text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_p record; v_n integer := 0; v_user uuid;
begin
  for v_p in select p.id, p.amount_halala - p.refunded_halala as remaining, p.mode from public.payments p
              where p.booking_id = p_booking_id and p.status in ('succeeded', 'partially_refunded')
                and p.amount_halala > p.refunded_halala loop
    insert into public.refunds (payment_id, booking_id, amount_halala, reason, status, requested_by, sandbox)
    values (v_p.id, p_booking_id, v_p.remaining, left(p_reason, 500), 'pending_review', auth.uid(), v_p.mode = 'sandbox')
    on conflict do nothing;
    if found then v_n := v_n + 1; end if;
  end loop;
  if v_n > 0 then
    insert into public.booking_events (booking_id, action, actor_user_id, details)
    values (p_booking_id, 'refund_requested', auth.uid(), jsonb_build_object('reason', left(p_reason, 500)));
    for v_user in select distinct a.user_id from public.role_assignments a where a.organization_id is null and a.status = 'active' and a.role in ('finance', 'super_admin') loop
      perform public.emit_notification(v_user, 'refund_review:' || p_booking_id || ':' || extract(epoch from now())::bigint, 'refund_review_required', '/admin/finance');
    end loop;
  end if;
  return v_n;
end; $$;
revoke all on function public._open_refund_review(uuid, text) from public, anon, authenticated, service_role;

create or replace function public.request_refund(p_payment_id uuid, p_amount_halala bigint, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_p public.payments%rowtype; v_id uuid; v_open bigint;
begin
  perform public._require_staff('{super_admin,finance}');
  if p_payment_id is null or p_amount_halala is null or p_amount_halala <= 0 then raise exception 'invalid input' using errcode = '22023'; end if;
  select * into v_p from public.payments where id = p_payment_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_p.status not in ('succeeded', 'partially_refunded', 'requires_review') then raise exception 'invalid_transition: only captured payments can be refunded' using errcode = '55000'; end if;
  if v_p.refunded_halala + p_amount_halala > v_p.amount_halala then raise exception 'invalid amount: refund exceeds captured amount' using errcode = '22023'; end if;
  insert into public.refunds (payment_id, booking_id, amount_halala, reason, status, requested_by, sandbox)
  values (p_payment_id, v_p.booking_id, p_amount_halala, public._valid_reason(p_reason), 'pending_review', auth.uid(), v_p.mode = 'sandbox')
  returning id into v_id;
  insert into public.booking_events (booking_id, action, actor_user_id, details)
  values (v_p.booking_id, 'refund_requested', auth.uid(), jsonb_build_object('refund_id', v_id, 'amount_halala', p_amount_halala));
  return v_id;
exception when unique_violation then
  raise exception 'refund_in_progress: an open refund exists for this payment' using errcode = '55000';
end; $$;
revoke all on function public.request_refund(uuid, bigint, text) from public, anon, service_role;
grant execute on function public.request_refund(uuid, bigint, text) to authenticated;

create or replace function public._complete_refund(p_refund_id uuid, p_provider_refund_id text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_r public.refunds%rowtype; v_p public.payments%rowtype; v_cn uuid; v_full boolean; v_ref text; v_user uuid;
begin
  select * into v_r from public.refunds where id = p_refund_id for update;
  if v_r.status = 'succeeded' then return 'unchanged'; end if;
  if v_r.status not in ('approved', 'processing') then raise exception 'invalid_transition' using errcode = '55000'; end if;
  select * into v_p from public.payments where id = v_r.payment_id for update;
  if v_p.refunded_halala + v_r.amount_halala > v_p.amount_halala then raise exception 'invalid amount' using errcode = '22023'; end if;
  v_full := v_p.refunded_halala + v_r.amount_halala >= v_p.amount_halala;
  update public.payments set refunded_halala = refunded_halala + v_r.amount_halala,
    status = case when v_full then 'refunded' else 'partially_refunded' end, updated_at = now() where id = v_p.id;
  insert into public.payment_events (payment_id, status, amount_halala, detail, actor_user_id)
  values (v_p.id, 'refunded', v_r.amount_halala, 'Refund ' || v_r.id || case when v_r.sandbox then ' (SANDBOX)' else '' end, auth.uid());
  update public.bookings set payment_status = case when v_full then 'refunded' else 'partially_refunded' end,
    status = case when v_full and status in ('paid', 'cancelled') then case when status = 'cancelled' then 'cancelled' else 'refunded' end else status end
   where id = v_r.booking_id returning created_by, reference into v_user, v_ref;
  v_cn := public._issue_credit_note(v_r.booking_id, v_r.id, v_r.amount_halala, v_r.reason);
  update public.refunds set status = 'succeeded', provider_refund_id = coalesce(p_provider_refund_id, provider_refund_id),
    credit_note_id = v_cn, updated_at = now() where id = p_refund_id;
  insert into public.booking_events (booking_id, action, actor_user_id, details)
  values (v_r.booking_id, 'refunded', auth.uid(), jsonb_build_object('refund_id', v_r.id, 'amount_halala', v_r.amount_halala, 'credit_note_id', v_cn));
  perform public.emit_notification(v_user, 'refund:' || v_r.id, 'refund_completed', '/bookings/' || v_ref);
  return 'succeeded';
end; $$;
revoke all on function public._complete_refund(uuid, text) from public, anon, authenticated, service_role;

create or replace function public.decide_refund(p_refund_id uuid, p_decision text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_r public.refunds%rowtype; v_reason text; v_pol text; v_mode text;
begin
  perform public._require_staff('{super_admin,finance}');
  v_reason := public._valid_reason(p_reason);
  if p_decision is null or p_decision not in ('approve', 'reject') then raise exception 'invalid decision' using errcode = '22023'; end if;
  select * into v_r from public.refunds where id = p_refund_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'pending_review' then
    if (p_decision = 'approve' and v_r.status in ('approved', 'processing', 'succeeded')) or (p_decision = 'reject' and v_r.status = 'rejected') then return 'unchanged'; end if;
    raise exception 'invalid_transition' using errcode = '55000'; end if;
  if p_decision = 'reject' then
    update public.refunds set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_reason = v_reason, updated_at = now() where id = p_refund_id;
    return 'rejected';
  end if;
  select sp.version into v_pol from public.service_policies sp where sp.policy_type = 'refund' and sp.status = 'approved' order by sp.effective_from desc limit 1;
  if v_pol is null then raise exception 'refund_policy_not_approved: refunds are inactive until ATCO approves a refund policy' using errcode = '55000'; end if;
  if v_r.requested_by is not null and v_r.requested_by = auth.uid() then
    raise exception 'four_eyes_required: the requester cannot approve their own refund' using errcode = '42501'; end if;
  update public.refunds set status = 'approved', decided_by = auth.uid(), decided_at = now(), decision_reason = v_reason,
    policy_version = v_pol, updated_at = now() where id = p_refund_id;
  -- Sandbox refunds complete immediately; live refunds are executed by the payments
  -- edge function (provider API) which reports back via apply_refund_result().
  select mode into v_mode from public.payments where id = v_r.payment_id;
  if v_mode = 'sandbox' then
    return public._complete_refund(p_refund_id, 'sandbox-refund-' || p_refund_id);
  end if;
  return 'approved';
end; $$;
revoke all on function public.decide_refund(uuid, text, text) from public, anon, service_role;
grant execute on function public.decide_refund(uuid, text, text) to authenticated;

create or replace function public.apply_refund_result(p_refund_id uuid, p_provider_refund_id text, p_status text, p_detail text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_status = 'processing' then
    update public.refunds set status = 'processing', provider_refund_id = p_provider_refund_id, updated_at = now() where id = p_refund_id and status = 'approved';
    return 'processing';
  elsif p_status = 'succeeded' then
    return public._complete_refund(p_refund_id, p_provider_refund_id);
  elsif p_status = 'failed' then
    update public.refunds set status = 'failed', decision_reason = left(coalesce(p_detail, 'provider failure'), 500), updated_at = now()
     where id = p_refund_id and status in ('approved', 'processing');
    return 'failed';
  end if;
  raise exception 'invalid status' using errcode = '22023';
end; $$;
revoke all on function public.apply_refund_result(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_refund_result(uuid, text, text, text) to service_role;

-- Phase 7 API kept: policy-gated; now only opens a refund request for review.
create or replace function public.refund_payment(p_payment_id uuid, p_amount_halala bigint, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_pol text;
begin
  if p_payment_id is null or p_amount_halala is null or p_amount_halala <= 0
     or nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 500 then
    raise exception 'invalid input' using errcode = '22023'; end if;
  if not public.has_platform_role('{super_admin,finance}') then raise exception 'not authorized' using errcode = '42501'; end if;
  select sp.version into v_pol from public.service_policies sp where sp.policy_type = 'refund' and sp.status = 'approved' limit 1;
  if v_pol is null then raise exception 'refund_policy_not_approved: refunds are inactive until ATCO approves a refund policy' using errcode = '55000'; end if;
  perform public.request_refund(p_payment_id, p_amount_halala, p_reason);
  return 'pending_review';
end; $$;

-- Approving a policy version is a super_admin decision with a recorded reason.
create or replace function public.set_policy_status(p_policy_type text, p_version text, p_status text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_staff('{super_admin}');
  if p_status is null or p_status not in ('provisional', 'approved', 'retired') then raise exception 'invalid status' using errcode = '22023'; end if;
  perform set_config('gm.change_reason', public._valid_reason(p_reason), true);
  update public.service_policies set status = p_status where policy_type = p_policy_type and version = p_version;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  return 'updated';
end; $$;
revoke all on function public.set_policy_status(text, text, text, text) from public, anon, service_role;
grant execute on function public.set_policy_status(text, text, text, text) to authenticated;

create or replace function public.publish_policy(p_policy_type text, p_version text, p_content jsonb, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public._require_staff('{super_admin,operations}');
  if p_content is null or jsonb_typeof(p_content) <> 'object' or octet_length(p_content::text) > 20000 then raise exception 'invalid content' using errcode = '22023'; end if;
  perform set_config('gm.change_reason', public._valid_reason(p_reason), true);
  insert into public.service_policies (policy_type, version, content, status, created_by)
  values (p_policy_type, btrim(p_version), p_content, 'provisional', auth.uid()) returning id into v_id;
  return v_id;
end; $$;
revoke all on function public.publish_policy(text, text, jsonb, text) from public, anon, service_role;
grant execute on function public.publish_policy(text, text, jsonb, text) to authenticated;
revoke insert, update, delete on public.service_policies from authenticated;

-- On-account settlement recorded by Finance (bank transfer reconciliation).
create or replace function public.record_account_payment(p_invoice_id uuid, p_amount_halala bigint, p_bank_reference text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_i public.invoices%rowtype; v_paid bigint;
begin
  perform public._require_staff('{super_admin,finance}');
  if p_amount_halala is null or p_amount_halala <= 0 or nullif(btrim(p_bank_reference), '') is null or char_length(p_bank_reference) > 120 then
    raise exception 'invalid input' using errcode = '22023'; end if;
  select * into v_i from public.invoices where id = p_invoice_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_i.settlement_mode <> 'on_account' or v_i.status not in ('issued', 'partially_paid') then raise exception 'invalid_transition' using errcode = '55000'; end if;
  v_paid := v_i.amount_paid_halala + p_amount_halala;
  if v_paid > v_i.total_halala then raise exception 'invalid amount: exceeds balance' using errcode = '22023'; end if;
  update public.invoices set amount_paid_halala = v_paid, status = case when v_paid >= total_halala then 'paid' else 'partially_paid' end,
    paid_at = case when v_paid >= total_halala then now() end where id = p_invoice_id;
  perform set_config('gm.change_reason', 'account payment ' || btrim(p_bank_reference), true);
  insert into public.config_audit (entity, entity_id, action, before_value, after_value, reason, actor_user_id)
  values ('invoices', p_invoice_id::text, 'update', jsonb_build_object('amount_paid_halala', v_i.amount_paid_halala),
          jsonb_build_object('amount_paid_halala', v_paid), 'account payment ' || btrim(p_bank_reference), auth.uid());
  if v_paid >= v_i.total_halala then update public.bookings set payment_status = 'paid' where id = v_i.booking_id and payment_status = 'on_account'; end if;
  return case when v_paid >= v_i.total_halala then 'paid' else 'partially_paid' end;
end; $$;
revoke all on function public.record_account_payment(uuid, bigint, text) from public, anon, service_role;
grant execute on function public.record_account_payment(uuid, bigint, text) to authenticated;

-- Reconciliation: bookings vs payments vs invoices, for Finance.
create or replace function public.report_payment_reconciliation(p_from date, p_to date)
returns table (booking_reference text, booking_status text, payment_status text, booking_total_halala bigint,
               captured_halala bigint, refunded_halala bigint, invoice_number text, invoice_total_halala bigint,
               invoice_paid_halala bigint, mode text, issue text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,finance}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'invalid date range' using errcode = '22023'; end if;
  return query
  select b.reference, b.status, b.payment_status, b.total_halala,
    coalesce((select sum(p.amount_halala) from public.payments p where p.booking_id = b.id and p.status in ('succeeded', 'partially_refunded', 'refunded')), 0)::bigint,
    coalesce((select sum(p.refunded_halala) from public.payments p where p.booking_id = b.id), 0)::bigint,
    i.invoice_number, i.total_halala, i.amount_paid_halala,
    coalesce((select p.mode from public.payments p where p.booking_id = b.id order by p.created_at desc limit 1), b.settlement_mode),
    case
      when exists (select 1 from public.payments p where p.booking_id = b.id and p.status = 'requires_review') then 'payment_requires_review'
      when b.payment_status = 'paid' and i.id is null then 'paid_without_invoice'
      when i.id is not null and i.settlement_mode = 'pay_now' and i.amount_paid_halala <> coalesce((select sum(p.amount_halala) from public.payments p where p.booking_id = b.id and p.status in ('succeeded', 'partially_refunded', 'refunded')), 0) then 'invoice_payment_mismatch'
      when b.payment_status = 'paid' and b.total_halala <> coalesce((select sum(p.amount_halala) from public.payments p where p.booking_id = b.id and p.status in ('succeeded', 'partially_refunded', 'refunded')), 0) then 'amount_mismatch'
      else null end
  from public.bookings b left join public.invoices i on i.booking_id = b.id
  where (b.created_at at time zone 'Asia/Riyadh')::date between p_from and p_to
  order by b.created_at;
end; $$;
revoke all on function public.report_payment_reconciliation(date, date) from public, anon, service_role;
grant execute on function public.report_payment_reconciliation(date, date) to authenticated;

-- Notification on every payment event kind (already wired by trg_notify_payment).
