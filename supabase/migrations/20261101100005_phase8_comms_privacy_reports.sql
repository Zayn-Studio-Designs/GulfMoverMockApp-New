-- ===========================================================================
-- 20261101100005 — Phase 8: communications outbox, notification preferences,
-- IT-support role, optional MFA enforcement for staff, privacy requests and
-- retention tooling, health/diagnostics and management reports.
-- ===========================================================================
-- External messaging stays OFF until a provider is configured and approved:
-- every channel defaults to disabled, so messages are recorded as
-- "suppressed: channel_not_configured" — never reported as sent.
-- No legal retention period is invented: retention rules are seeded with NULL
-- periods and status provisional, so apply_retention() does nothing until ATCO
-- approves concrete periods.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. IT support role (diagnostics only; no passenger data) + MFA enforcement
-- ---------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname, pg_get_constraintdef(oid) as def from pg_constraint
            where conrelid = 'public.role_assignments'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%super_admin%' loop
    execute format('alter table public.role_assignments drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.role_assignments add constraint role_assignments_role_check check (role in (
  'super_admin', 'operations', 'finance', 'boarding_staff', 'it_support', 'company_admin', 'company_booker', 'agent', 'individual_customer', 'crew_viewer'));
alter table public.role_assignments add constraint role_assignments_scope_check check (
  (organization_id is null and role in ('super_admin', 'operations', 'finance', 'boarding_staff', 'it_support', 'individual_customer', 'crew_viewer'))
  or (organization_id is not null and role in ('company_admin', 'company_booker', 'agent')));

-- When security.staff_mfa_required is true, platform roles only apply to sessions
-- whose JWT carries aal2 (Supabase Auth MFA). Every RLS policy and staff RPC uses
-- this function, so enforcement is at the database boundary.
create or replace function public.has_platform_role(p_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'suspended')
    and exists (select 1 from public.role_assignments r where r.user_id = auth.uid()
      and r.organization_id is null and r.status = 'active' and r.role = any(p_roles))
    and (not coalesce((select (value ->> 'value')::boolean from public.platform_settings
                        where key = 'security.staff_mfa_required' and jsonb_typeof(value -> 'value') = 'boolean'), false)
         or coalesce(auth.jwt() ->> 'aal', '') = 'aal2');
$$;

create or replace function public.my_security_posture()
returns table (is_staff boolean, staff_roles text[], mfa_required boolean, session_aal text)
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.role_assignments r where r.user_id = auth.uid() and r.organization_id is null and r.status = 'active'
                   and r.role in ('super_admin', 'operations', 'finance', 'boarding_staff', 'it_support')),
    coalesce((select array_agg(r.role order by r.role) from public.role_assignments r where r.user_id = auth.uid() and r.organization_id is null and r.status = 'active'), '{}'),
    public.setting_bool('security.staff_mfa_required', false),
    coalesce(auth.jwt() ->> 'aal', 'aal1')
$$;
revoke all on function public.my_security_posture() from public, anon, service_role;
grant execute on function public.my_security_posture() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Notification preferences, channels and the delivery outbox
-- ---------------------------------------------------------------------------
create table if not exists public.notification_preferences (
  user_id         uuid not null references auth.users (id) on delete cascade,
  channel         text not null constraint notification_preferences_channel_check check (channel in ('email', 'sms', 'whatsapp')),
  opted_in        boolean not null,
  consent_version text constraint notification_preferences_consent_length check (consent_version is null or char_length(consent_version) <= 32),
  consent_at      timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (user_id, channel)
);
alter table public.notification_preferences enable row level security;
drop policy if exists notification_preferences_own on public.notification_preferences;
create policy notification_preferences_own on public.notification_preferences for select to authenticated using (user_id = auth.uid());
revoke all on public.notification_preferences from public, anon, authenticated, service_role;
grant select on public.notification_preferences to authenticated;

create or replace function public.set_notification_preference(p_channel text, p_opted_in boolean, p_consent_version text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_channel is null or p_channel not in ('email', 'sms', 'whatsapp') or p_opted_in is null then raise exception 'invalid input' using errcode = '22023'; end if;
  if p_opted_in and p_channel in ('sms', 'whatsapp') and nullif(btrim(p_consent_version), '') is null then
    raise exception 'consent_required: explicit consent text version required for SMS/WhatsApp' using errcode = '22023'; end if;
  insert into public.notification_preferences (user_id, channel, opted_in, consent_version, consent_at, updated_at)
  values (auth.uid(), p_channel, p_opted_in, nullif(btrim(p_consent_version), ''), case when p_opted_in then now() end, now())
  on conflict (user_id, channel) do update set opted_in = excluded.opted_in, consent_version = excluded.consent_version,
    consent_at = excluded.consent_at, updated_at = now();
  return 'saved';
end; $$;
revoke all on function public.set_notification_preference(text, boolean, text) from public, anon, service_role;
grant execute on function public.set_notification_preference(text, boolean, text) to authenticated;

insert into public.platform_settings (key, value, description) values
  ('notifications.channels', '{"value": {"email": false, "sms": false, "whatsapp": false}}',
   'External channels enabled for delivery. All false until a provider account is configured and approved. In-app notifications are always on.')
on conflict (key) do nothing;

create or replace function public.set_notification_channel(p_channel text, p_enabled boolean, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform public._require_staff('{super_admin}');
  if p_channel not in ('email', 'sms', 'whatsapp') or p_enabled is null then raise exception 'invalid input' using errcode = '22023'; end if;
  perform set_config('gm.change_reason', public._valid_reason(p_reason), true);
  select value -> 'value' into v from public.platform_settings where key = 'notifications.channels' for update;
  update public.platform_settings set value = jsonb_build_object('value', coalesce(v, '{}') || jsonb_build_object(p_channel, p_enabled)),
    updated_at = now(), updated_by = auth.uid() where key = 'notifications.channels';
  return 'updated';
end; $$;
revoke all on function public.set_notification_channel(text, boolean, text) from public, anon, service_role;
grant execute on function public.set_notification_channel(text, boolean, text) to authenticated;

create table if not exists public.notification_outbox (
  id                  uuid primary key default gen_random_uuid(),
  notification_id     uuid not null references public.notifications (id) on delete cascade,
  user_id             uuid not null references auth.users (id) on delete cascade,
  channel             text not null constraint notification_outbox_channel_check check (channel in ('email', 'sms', 'whatsapp')),
  template_key        text not null,
  target              text,
  status              text not null default 'queued'
    constraint notification_outbox_status_check check (status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'suppressed')),
  suppressed_reason   text,
  attempts            integer not null default 0,
  next_attempt_at     timestamptz not null default now(),
  provider            text,
  provider_message_id text,
  last_error          text constraint notification_outbox_error_length check (last_error is null or char_length(last_error) <= 500),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  sent_at             timestamptz,
  constraint notification_outbox_dedupe unique (notification_id, channel)
);
comment on table public.notification_outbox is
  'One row per notification per external channel. Holds no message body or contact details; the dispatcher resolves them at send time. status=sent only after the provider accepted the message.';
create index if not exists notification_outbox_due on public.notification_outbox (next_attempt_at) where status in ('queued', 'sending');
alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from public, anon, authenticated, service_role;

create or replace function public.trg_enqueue_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_channels jsonb; c text; v_opt boolean;
begin
  v_channels := coalesce((select value -> 'value' from public.platform_settings where key = 'notifications.channels'), '{}');
  foreach c in array array['email', 'sms', 'whatsapp'] loop
    select opted_in into v_opt from public.notification_preferences where user_id = new.user_id and channel = c;
    -- Transactional e-mail defaults to on (user may opt out); SMS/WhatsApp require explicit opt-in.
    if coalesce(v_opt, c = 'email') then
      insert into public.notification_outbox (notification_id, user_id, channel, template_key, target, status, suppressed_reason)
      values (new.id, new.user_id, c, new.kind, new.target,
              case when coalesce((v_channels ->> c)::boolean, false) then 'queued' else 'suppressed' end,
              case when coalesce((v_channels ->> c)::boolean, false) then null else 'channel_not_configured' end)
      on conflict (notification_id, channel) do nothing;
    end if;
  end loop;
  return new;
end; $$;
revoke all on function public.trg_enqueue_notification() from public, anon, authenticated, service_role;
drop trigger if exists trg_enqueue_notification on public.notifications;
create trigger trg_enqueue_notification after insert on public.notifications for each row execute function public.trg_enqueue_notification();

-- Dispatcher (service role): lease a batch, resolve recipient at send time.
create or replace function public.claim_outbox_batch(p_limit integer)
returns table (outbox_id uuid, channel text, template_key text, target text, locale text, recipient text, attempts integer)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
  with due as (
    select o.id from public.notification_outbox o
     where o.status in ('queued', 'sending') and o.next_attempt_at <= now()
     order by o.next_attempt_at limit greatest(1, least(coalesce(p_limit, 50), 200)) for update skip locked)
  update public.notification_outbox o set status = 'sending', attempts = o.attempts + 1,
    next_attempt_at = now() + interval '5 minutes', updated_at = now()
   from due where o.id = due.id
  returning o.id, o.channel, o.template_key, o.target,
    coalesce((select p.preferred_language from public.profiles p where p.id = o.user_id), 'en'),
    case when o.channel = 'email' then (select u.email from auth.users u where u.id = o.user_id)::text
         else (select p.phone from public.profiles p where p.id = o.user_id) end,
    o.attempts;
end; $$;
revoke all on function public.claim_outbox_batch(integer) from public, anon, authenticated;
grant execute on function public.claim_outbox_batch(integer) to service_role;

create or replace function public.complete_outbox_delivery(p_outbox_id uuid, p_outcome text, p_provider text, p_provider_message_id text, p_error text)
returns text language plpgsql security definer set search_path = '' as $$
declare v public.notification_outbox%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into v from public.notification_outbox where id = p_outbox_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v.status in ('sent', 'delivered') then return 'unchanged'; end if;
  if p_outcome = 'sent' then
    update public.notification_outbox set status = 'sent', provider = p_provider, provider_message_id = p_provider_message_id,
      sent_at = now(), last_error = null, updated_at = now() where id = p_outbox_id;
    return 'sent';
  elsif p_outcome = 'no_recipient' then
    update public.notification_outbox set status = 'suppressed', suppressed_reason = 'no_recipient', updated_at = now() where id = p_outbox_id;
    return 'suppressed';
  elsif p_outcome = 'failed' then
    update public.notification_outbox set last_error = left(coalesce(p_error, 'unknown error'), 500), provider = p_provider,
      status = case when v.attempts >= 5 then 'failed' else 'queued' end,
      next_attempt_at = now() + make_interval(mins => power(2, least(v.attempts, 8))::int), updated_at = now()
     where id = p_outbox_id;
    return case when v.attempts >= 5 then 'failed' else 'retry_scheduled' end;
  end if;
  raise exception 'invalid outcome' using errcode = '22023';
end; $$;
revoke all on function public.complete_outbox_delivery(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_outbox_delivery(uuid, text, text, text, text) to service_role;

create or replace function public.record_message_status(p_provider text, p_provider_message_id text, p_status text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_status not in ('delivered', 'failed') then raise exception 'invalid status' using errcode = '22023'; end if;
  update public.notification_outbox set status = p_status, updated_at = now(),
    last_error = case when p_status = 'failed' then 'provider reported delivery failure' else last_error end
   where provider = p_provider and provider_message_id = p_provider_message_id and status in ('sent', 'delivered');
  return case when found then 'recorded' else 'unknown_message' end;
end; $$;
revoke all on function public.record_message_status(text, text, text) from public, anon, authenticated;
grant execute on function public.record_message_status(text, text, text) to service_role;

-- Staff view of delivery problems: no recipient addresses or message content.
create or replace function public.notification_delivery_issues(p_limit integer)
returns table (outbox_id uuid, channel text, template_key text, status text, suppressed_reason text, attempts integer,
               last_error text, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,operations,it_support}') then raise exception 'not authorized' using errcode = '42501'; end if;
  return query select o.id, o.channel, o.template_key, o.status, o.suppressed_reason, o.attempts, o.last_error, o.created_at, o.updated_at
    from public.notification_outbox o
   where o.status = 'failed' or (o.status in ('queued', 'sending') and o.created_at < now() - interval '15 minutes')
      or (o.status = 'suppressed' and o.suppressed_reason <> 'channel_not_configured')
   order by o.updated_at desc limit greatest(1, least(coalesce(p_limit, 100), 500));
end; $$;
revoke all on function public.notification_delivery_issues(integer) from public, anon, service_role;
grant execute on function public.notification_delivery_issues(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Privacy: requests, self-service export, legal holds, anonymisation, retention
-- ---------------------------------------------------------------------------
create table if not exists public.privacy_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id),
  request_type text not null constraint privacy_requests_type_check check (request_type in ('access_export', 'correction', 'erasure', 'objection')),
  details      text constraint privacy_requests_details_length check (details is null or char_length(details) <= 1000),
  status       text not null default 'received' constraint privacy_requests_status_check check (status in ('received', 'in_progress', 'completed', 'rejected')),
  due_at       timestamptz not null,
  decided_by   uuid references auth.users (id),
  decision_notes text constraint privacy_requests_notes_length check (decision_notes is null or char_length(decision_notes) <= 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.privacy_requests enable row level security;
drop policy if exists privacy_requests_select on public.privacy_requests;
create policy privacy_requests_select on public.privacy_requests for select to authenticated
  using (user_id = auth.uid() or public.has_platform_role('{super_admin}'));
revoke all on public.privacy_requests from public, anon, authenticated, service_role;
grant select on public.privacy_requests to authenticated;

insert into public.platform_settings (key, value, description) values
  ('privacy.response_days', '{"value": 30}', 'Target days to answer a privacy request. Commonly cited for the Saudi PDPL; ATCO legal to confirm.')
on conflict (key) do nothing;

create or replace function public.submit_privacy_request(p_type text, p_details text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_type is null or p_type not in ('access_export', 'correction', 'erasure', 'objection') then raise exception 'invalid type' using errcode = '22023'; end if;
  if p_details is not null and char_length(p_details) > 1000 then raise exception 'invalid details' using errcode = '22023'; end if;
  if (select count(*) from public.privacy_requests where user_id = auth.uid() and created_at > now() - interval '1 day') >= 5 then
    raise exception 'rate_limited' using errcode = '54000'; end if;
  insert into public.privacy_requests (user_id, request_type, details, due_at)
  values (auth.uid(), p_type, nullif(btrim(p_details), ''), now() + make_interval(days => public.setting_int('privacy.response_days', 30)))
  returning id into v_id;
  return v_id;
end; $$;
revoke all on function public.submit_privacy_request(text, text) from public, anon, service_role;
grant execute on function public.submit_privacy_request(text, text) to authenticated;

create or replace function public.decide_privacy_request(p_id uuid, p_status text, p_notes text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_staff('{super_admin}');
  if p_status not in ('in_progress', 'completed', 'rejected') then raise exception 'invalid status' using errcode = '22023'; end if;
  if p_status = 'rejected' and nullif(btrim(p_notes), '') is null then raise exception 'reason required' using errcode = '22023'; end if;
  update public.privacy_requests set status = p_status, decided_by = auth.uid(), decision_notes = nullif(btrim(p_notes), ''), updated_at = now()
   where id = p_id and status in ('received', 'in_progress');
  if not found then raise exception 'invalid_transition' using errcode = '55000'; end if;
  return p_status;
end; $$;
revoke all on function public.decide_privacy_request(uuid, text, text) from public, anon, service_role;
grant execute on function public.decide_privacy_request(uuid, text, text) to authenticated;

-- Self-service export of the caller's own data (no QR secrets, no provider internals).
create or replace function public.export_my_data()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  return jsonb_build_object(
    'generated_at', now(),
    'profile', (select to_jsonb(p) - 'id' from public.profiles p where p.id = v_uid),
    'account', (select jsonb_build_object('email', u.email, 'created_at', u.created_at) from auth.users u where u.id = v_uid),
    'memberships', coalesce((select jsonb_agg(jsonb_build_object('organization', o.display_name, 'role', m.membership_role, 'status', m.status))
       from public.organization_memberships m join public.organizations o on o.id = m.organization_id where m.user_id = v_uid), '[]'),
    'bookings', coalesce((select jsonb_agg(jsonb_build_object('reference', b.reference, 'status', b.status, 'payment_status', b.payment_status,
       'passengers', b.passenger_count, 'contact_name', b.contact_name, 'contact_email', b.contact_email, 'contact_phone', b.contact_phone,
       'passenger_names', b.passenger_names, 'total_halala', b.total_halala, 'created_at', b.created_at,
       'terms_version', b.terms_version, 'terms_accepted_at', b.terms_accepted_at,
       'tickets', (select jsonb_agg(jsonb_build_object('reference', t.reference, 'status', t.status, 'passenger', t.passenger_name, 'boarded_at', t.boarded_at))
                    from public.tickets t where t.booking_id = b.id)) order by b.created_at)
       from public.bookings b where b.created_by = v_uid), '[]'),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('booking', b.reference, 'amount_halala', p.amount_halala, 'method', p.method,
       'status', p.status, 'mode', p.mode, 'created_at', p.created_at))
       from public.payments p join public.bookings b on b.id = p.booking_id where b.created_by = v_uid), '[]'),
    'invoices', coalesce((select jsonb_agg(jsonb_build_object('number', i.invoice_number, 'total_halala', i.total_halala, 'status', i.status))
       from public.invoices i join public.bookings b on b.id = i.booking_id where b.created_by = v_uid), '[]'),
    'notification_preferences', coalesce((select jsonb_agg(to_jsonb(n) - 'user_id') from public.notification_preferences n where n.user_id = v_uid), '[]'),
    'notifications', coalesce((select jsonb_agg(jsonb_build_object('kind', n.kind, 'created_at', n.created_at, 'read_at', n.read_at))
       from public.notifications n where n.user_id = v_uid), '[]'),
    'privacy_requests', coalesce((select jsonb_agg(jsonb_build_object('type', r.request_type, 'status', r.status, 'created_at', r.created_at))
       from public.privacy_requests r where r.user_id = v_uid), '[]'));
end; $$;
revoke all on function public.export_my_data() from public, anon, service_role;
grant execute on function public.export_my_data() to authenticated;

create table if not exists public.legal_holds (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id),
  reason      text not null check (char_length(reason) between 1 and 500),
  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  released_at timestamptz
);
alter table public.legal_holds enable row level security;
drop policy if exists legal_holds_admin on public.legal_holds;
create policy legal_holds_admin on public.legal_holds for select to authenticated using (public.has_platform_role('{super_admin}'));
revoke all on public.legal_holds from public, anon, authenticated, service_role;
grant select on public.legal_holds to authenticated;

create or replace function public.set_legal_hold(p_user_id uuid, p_hold boolean, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_staff('{super_admin}');
  if p_hold then
    insert into public.legal_holds (user_id, reason, created_by) values (p_user_id, public._valid_reason(p_reason), auth.uid());
    return 'held';
  end if;
  update public.legal_holds set released_at = now() where user_id = p_user_id and released_at is null;
  return 'released';
end; $$;
revoke all on function public.set_legal_hold(uuid, boolean, text) from public, anon, service_role;
grant execute on function public.set_legal_hold(uuid, boolean, text) to authenticated;

-- Erasure that keeps legitimate financial/audit records: personal fields are
-- replaced, amounts/references/invoices remain. Refused under a legal hold or
-- while the person has an upcoming active trip.
create or replace function public.anonymize_user_data(p_user_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_reason text; v_b integer; v_t integer;
begin
  perform public._require_staff('{super_admin}');
  v_reason := public._valid_reason(p_reason);
  if exists (select 1 from public.legal_holds where user_id = p_user_id and released_at is null) then
    raise exception 'legal_hold_active' using errcode = '55000'; end if;
  if exists (select 1 from public.bookings b join public.booking_legs l on l.booking_id = b.id join public.sailings s on s.id = l.sailing_id
             where b.created_by = p_user_id and b.status in ('reserved', 'pending_payment', 'paid') and s.departs_at > now() - interval '1 day') then
    raise exception 'active_trips: cancel or complete upcoming trips first' using errcode = '55000'; end if;
  update public.bookings set contact_name = 'Redacted', contact_email = 'redacted+' || substr(id::text, 1, 8) || '@invalid.example',
    contact_phone = '+0000000', passenger_names = array_fill('Redacted'::text, array[greatest(cardinality(passenger_names), 1)]),
    destination_vessel = null, client_name = case when client_name is not null then 'Redacted' end
   where created_by = p_user_id;
  get diagnostics v_b = row_count;
  update public.tickets t set passenger_name = null from public.bookings b where b.id = t.booking_id and b.created_by = p_user_id;
  get diagnostics v_t = row_count;
  update public.invoices i set buyer = jsonb_set(i.buyer, '{name}', '"Redacted"') from public.bookings b
   where b.id = i.booking_id and b.created_by = p_user_id and i.organization_id is null;
  update public.profiles set display_name = 'Deleted user', phone = null where id = p_user_id;
  delete from public.notification_preferences where user_id = p_user_id;
  delete from public.notifications where user_id = p_user_id;
  insert into public.config_audit (entity, entity_id, action, before_value, after_value, reason, actor_user_id)
  values ('privacy', p_user_id::text, 'update', null, jsonb_build_object('bookings', v_b, 'tickets', v_t), v_reason, auth.uid());
  return jsonb_build_object('bookings_redacted', v_b, 'tickets_redacted', v_t,
    'note', 'Auth account removal is performed through the Supabase Admin API by an administrator.');
end; $$;
revoke all on function public.anonymize_user_data(uuid, text) from public, anon, service_role;
grant execute on function public.anonymize_user_data(uuid, text) to authenticated;

create table if not exists public.data_retention_policies (
  record_type    text primary key constraint data_retention_policies_type_check check (record_type in (
                   'booking_personal_data', 'notifications', 'payment_provider_events', 'notification_outbox', 'financial_records', 'audit_logs')),
  retention_days integer constraint data_retention_policies_days_range check (retention_days is null or retention_days between 30 and 7300),
  status         text not null default 'provisional' constraint data_retention_policies_status_check check (status in ('provisional', 'approved')),
  legal_basis    text,
  updated_by     uuid references auth.users (id),
  updated_at     timestamptz not null default now()
);
alter table public.data_retention_policies enable row level security;
drop policy if exists data_retention_policies_select on public.data_retention_policies;
create policy data_retention_policies_select on public.data_retention_policies for select to authenticated using (public.has_platform_role('{super_admin,it_support}'));
revoke all on public.data_retention_policies from public, anon, authenticated, service_role;
grant select on public.data_retention_policies to authenticated;
drop trigger if exists trg_audit_config on public.data_retention_policies;
create trigger trg_audit_config after insert or update or delete on public.data_retention_policies for each row execute function public.audit_config_change();
insert into public.data_retention_policies (record_type, retention_days, status, legal_basis) values
  ('booking_personal_data', null, 'provisional', 'Pending ATCO legal decision'),
  ('notifications', null, 'provisional', 'Pending ATCO decision'),
  ('payment_provider_events', null, 'provisional', 'Pending ATCO Finance decision'),
  ('notification_outbox', null, 'provisional', 'Pending ATCO decision'),
  ('financial_records', null, 'provisional', 'Statutory retention applies; never deleted by this tool'),
  ('audit_logs', null, 'provisional', 'Never deleted by this tool')
on conflict (record_type) do nothing;

create or replace function public.set_retention_policy(p_record_type text, p_days integer, p_status text, p_legal_basis text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_staff('{super_admin}');
  if p_status not in ('provisional', 'approved') or (p_status = 'approved' and p_days is null) then raise exception 'invalid policy' using errcode = '22023'; end if;
  perform set_config('gm.change_reason', public._valid_reason(p_legal_basis), true);
  update public.data_retention_policies set retention_days = p_days, status = p_status, legal_basis = btrim(p_legal_basis),
    updated_by = auth.uid(), updated_at = now() where record_type = p_record_type;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  return 'updated';
end; $$;
revoke all on function public.set_retention_policy(text, integer, text, text) from public, anon, service_role;
grant execute on function public.set_retention_policy(text, integer, text, text) to authenticated;

-- Applies ONLY approved periods; financial records and audit logs are never removed.
create or replace function public.apply_retention(p_dry_run boolean)
returns table (record_type text, retention_days integer, candidates bigint, affected bigint)
language plpgsql security definer set search_path = '' as $$
declare v record; v_c bigint; v_a bigint;
begin
  if not (coalesce(auth.role(), '') = 'service_role' or public.has_platform_role('{super_admin}')) then raise exception 'not authorized' using errcode = '42501'; end if;
  for v in select * from public.data_retention_policies p where p.status = 'approved' and p.retention_days is not null
             and p.record_type not in ('financial_records', 'audit_logs') loop
    v_a := 0;
    if v.record_type = 'notifications' then
      select count(*) into v_c from public.notifications where created_at < now() - make_interval(days => v.retention_days);
      if not p_dry_run then delete from public.notifications where created_at < now() - make_interval(days => v.retention_days); get diagnostics v_a = row_count; end if;
    elsif v.record_type = 'notification_outbox' then
      select count(*) into v_c from public.notification_outbox where created_at < now() - make_interval(days => v.retention_days);
      if not p_dry_run then delete from public.notification_outbox where created_at < now() - make_interval(days => v.retention_days); get diagnostics v_a = row_count; end if;
    elsif v.record_type = 'payment_provider_events' then
      select count(*) into v_c from public.payment_provider_events where received_at < now() - make_interval(days => v.retention_days) and processed_at is not null;
      if not p_dry_run then delete from public.payment_provider_events where received_at < now() - make_interval(days => v.retention_days) and processed_at is not null; get diagnostics v_a = row_count; end if;
    elsif v.record_type = 'booking_personal_data' then
      select count(*) into v_c from public.bookings b where b.contact_name <> 'Redacted'
        and not exists (select 1 from public.legal_holds h where h.user_id = b.created_by and h.released_at is null)
        and (select max(s.departs_at) from public.booking_legs l join public.sailings s on s.id = l.sailing_id where l.booking_id = b.id) < now() - make_interval(days => v.retention_days);
      if not p_dry_run then
        update public.bookings b set contact_name = 'Redacted', contact_email = 'redacted+' || substr(b.id::text, 1, 8) || '@invalid.example',
          contact_phone = '+0000000', passenger_names = array_fill('Redacted'::text, array[greatest(cardinality(b.passenger_names), 1)])
         where b.contact_name <> 'Redacted'
           and not exists (select 1 from public.legal_holds h where h.user_id = b.created_by and h.released_at is null)
           and (select max(s.departs_at) from public.booking_legs l join public.sailings s on s.id = l.sailing_id where l.booking_id = b.id) < now() - make_interval(days => v.retention_days);
        get diagnostics v_a = row_count;
      end if;
    end if;
    record_type := v.record_type; retention_days := v.retention_days; candidates := v_c; affected := v_a;
    return next;
  end loop;
end; $$;
revoke all on function public.apply_retention(boolean) from public, anon;
grant execute on function public.apply_retention(boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Health and diagnostics
-- ---------------------------------------------------------------------------
create or replace function public.health_ping()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', 'ok', 'db_time', now(),
    'schema_version', (select max(version) from supabase_migrations.schema_migrations))
$$;
revoke all on function public.health_ping() from public;
grant execute on function public.health_ping() to anon, authenticated, service_role;

create or replace function public.system_diagnostics()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,it_support}') then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
    'checked_at', now(),
    'schema_version', (select max(version) from supabase_migrations.schema_migrations),
    'payments_mode', public.setting_text('payments.mode', 'sandbox'),
    'payments_live_enabled', public.setting_bool('payments.live_enabled', false),
    'staff_mfa_required', public.setting_bool('security.staff_mfa_required', false),
    'notification_channels', (select value -> 'value' from public.platform_settings where key = 'notifications.channels'),
    'outbox_failed', (select count(*) from public.notification_outbox where status = 'failed'),
    'outbox_stuck', (select count(*) from public.notification_outbox where status in ('queued', 'sending') and created_at < now() - interval '15 minutes'),
    'provider_events_unprocessed', (select count(*) from public.payment_provider_events where processed_at is null),
    'payments_requiring_review', (select count(*) from public.payments where status = 'requires_review'),
    'refunds_pending_review', (select count(*) from public.refunds where status = 'pending_review'),
    'holds_awaiting_expiry', (select count(*) from public.bookings where settlement_mode = 'pay_now' and status in ('reserved', 'pending_payment')
                                and payment_status in ('unpaid', 'pending') and hold_expires_at < now()),
    'privacy_requests_open', (select count(*) from public.privacy_requests where status in ('received', 'in_progress')),
    'privacy_requests_overdue', (select count(*) from public.privacy_requests where status in ('received', 'in_progress') and due_at < now()));
end; $$;
revoke all on function public.system_diagnostics() from public, anon, service_role;
grant execute on function public.system_diagnostics() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Management reports (Asia/Riyadh dates; derived from persisted rows)
-- ---------------------------------------------------------------------------
create or replace function public._riyadh_date(p timestamptz) returns date language sql immutable set search_path = '' as $$
  select (p at time zone 'Asia/Riyadh')::date
$$;

create or replace function public.report_sailing_occupancy(p_from date, p_to date)
returns table (sailing_id uuid, departs_at timestamptz, origin text, destination text,
  seat_capacity integer, seats_booked integer, ticket_count bigint, threshold_met boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,operations,finance}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'invalid date range' using errcode = '22023'; end if;
  return query
    select s.id, s.departs_at, r.origin, r.destination, s.seat_capacity, s.seats_booked,
      (select count(*) from public.tickets t join public.bookings b on b.id = t.booking_id
        where t.sailing_id = s.id and t.status in ('valid', 'boarded', 'no_show') and b.status not in ('cancelled', 'expired')),
      (select c.threshold_met from public.sailing_commercial_status(s.id) c)
    from public.sailings s join public.routes r on r.id = s.route_id
    where public._riyadh_date(s.departs_at) between p_from and p_to order by s.departs_at;
end; $$;

-- Revenue per sailing: each booking's net is split across its legs (no double counting).
create or replace function public.report_revenue_by_sailing(p_from date, p_to date)
returns table (sailing_id uuid, departs_at timestamptz, bookings bigint, passengers bigint,
  collected_halala bigint, refunded_halala bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,finance,operations}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'invalid date range' using errcode = '22023'; end if;
  return query
    with leg as (
      select l.sailing_id, b.id as booking_id, l.passengers,
        (select count(*) from public.booking_legs l2 where l2.booking_id = b.id) as legs,
        coalesce((select sum(p.amount_halala) from public.payments p where p.booking_id = b.id and p.status in ('succeeded', 'partially_refunded', 'refunded')), 0) as captured,
        coalesce((select sum(p.refunded_halala) from public.payments p where p.booking_id = b.id), 0) as refunded
        from public.booking_legs l join public.bookings b on b.id = l.booking_id
       where b.status not in ('expired'))
    select s.id, s.departs_at, count(distinct leg.booking_id), coalesce(sum(leg.passengers), 0)::bigint,
      coalesce(sum(leg.captured / greatest(leg.legs, 1)), 0)::bigint, coalesce(sum(leg.refunded / greatest(leg.legs, 1)), 0)::bigint
    from public.sailings s left join leg on leg.sailing_id = s.id
    where public._riyadh_date(s.departs_at) between p_from and p_to
    group by s.id, s.departs_at order by s.departs_at;
end; $$;

create or replace function public.report_period_summary(p_from date, p_to date, p_grain text)
returns table (period date, sailings bigint, seat_capacity bigint, tickets_issued bigint, passengers_boarded bigint, no_shows bigint,
  bookings_created bigint, bookings_cancelled bigint, gross_collected_halala bigint, refunded_halala bigint,
  on_account_invoiced_halala bigint, materials_delivered_kg bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,finance,operations}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 731 or p_grain not in ('day', 'month') then
    raise exception 'invalid range or grain' using errcode = '22023'; end if;
  return query
  with periods as (
    select distinct date_trunc(p_grain, d)::date as period from generate_series(p_from, p_to, interval '1 day') d)
  select pr.period,
    (select count(*) from public.sailings s where date_trunc(p_grain, public._riyadh_date(s.departs_at))::date = pr.period and public._riyadh_date(s.departs_at) between p_from and p_to and s.status <> 'cancelled'),
    (select coalesce(sum(s.seat_capacity), 0) from public.sailings s where date_trunc(p_grain, public._riyadh_date(s.departs_at))::date = pr.period and public._riyadh_date(s.departs_at) between p_from and p_to and s.status <> 'cancelled')::bigint,
    (select count(*) from public.tickets t join public.sailings s on s.id = t.sailing_id where date_trunc(p_grain, public._riyadh_date(s.departs_at))::date = pr.period and public._riyadh_date(s.departs_at) between p_from and p_to and t.status in ('valid', 'boarded', 'no_show')),
    (select count(*) from public.tickets t join public.sailings s on s.id = t.sailing_id where date_trunc(p_grain, public._riyadh_date(s.departs_at))::date = pr.period and public._riyadh_date(s.departs_at) between p_from and p_to and t.status = 'boarded'),
    (select count(*) from public.tickets t join public.sailings s on s.id = t.sailing_id where date_trunc(p_grain, public._riyadh_date(s.departs_at))::date = pr.period and public._riyadh_date(s.departs_at) between p_from and p_to and t.status = 'no_show'),
    (select count(*) from public.bookings b where date_trunc(p_grain, public._riyadh_date(b.created_at))::date = pr.period and public._riyadh_date(b.created_at) between p_from and p_to),
    (select count(*) from public.bookings b where b.cancelled_at is not null and date_trunc(p_grain, public._riyadh_date(b.cancelled_at))::date = pr.period and public._riyadh_date(b.cancelled_at) between p_from and p_to),
    (select coalesce(sum(p.amount_halala), 0) from public.payments p where p.verified_at is not null and p.status in ('succeeded', 'partially_refunded', 'refunded') and date_trunc(p_grain, public._riyadh_date(p.verified_at))::date = pr.period and public._riyadh_date(p.verified_at) between p_from and p_to)::bigint,
    (select coalesce(sum(r.amount_halala), 0) from public.refunds r where r.status = 'succeeded' and date_trunc(p_grain, public._riyadh_date(r.updated_at))::date = pr.period and public._riyadh_date(r.updated_at) between p_from and p_to)::bigint,
    (select coalesce(sum(i.total_halala), 0) from public.invoices i where i.settlement_mode = 'on_account' and date_trunc(p_grain, i.issue_date)::date = pr.period and i.issue_date between p_from and p_to)::bigint,
    (select coalesce(sum(r.weight_kg), 0) from public.transfer_requests r join public.delivery_records d on d.request_id = r.id where r.kind = 'materials' and date_trunc(p_grain, public._riyadh_date(d.delivered_at))::date = pr.period and public._riyadh_date(d.delivered_at) between p_from and p_to)::bigint
  from periods pr order by pr.period;
end; $$;

create or replace function public.report_revenue_by_destination(p_from date, p_to date)
returns table (origin text, destination text, bookings bigint, passengers bigint, net_halala bigint, vat_halala bigint,
  gross_halala bigint, refunded_halala bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,finance}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'invalid date range' using errcode = '22023'; end if;
  return query
    select r.origin, r.destination, count(distinct b.id), coalesce(sum(l.passengers), 0)::bigint,
      coalesce(sum(b.net_halala / greatest((select count(*) from public.booking_legs l2 where l2.booking_id = b.id), 1)), 0)::bigint,
      coalesce(sum(b.vat_halala / greatest((select count(*) from public.booking_legs l2 where l2.booking_id = b.id), 1)), 0)::bigint,
      coalesce(sum(b.total_halala / greatest((select count(*) from public.booking_legs l2 where l2.booking_id = b.id), 1)), 0)::bigint,
      coalesce(sum((select coalesce(sum(p.refunded_halala), 0) from public.payments p where p.booking_id = b.id)
                   / greatest((select count(*) from public.booking_legs l2 where l2.booking_id = b.id), 1)), 0)::bigint
    from public.booking_legs l join public.bookings b on b.id = l.booking_id
    join public.sailings s on s.id = l.sailing_id join public.routes r on r.id = s.route_id
    where b.payment_status in ('paid', 'on_account', 'partially_refunded', 'refunded')
      and public._riyadh_date(s.departs_at) between p_from and p_to
    group by r.origin, r.destination order by 7 desc;
end; $$;

create or replace function public.report_payments_summary(p_from date, p_to date)
returns table (method text, mode text, status text, payments bigint, amount_halala bigint, refunded_halala bigint, fees_halala bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,finance}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'invalid date range' using errcode = '22023'; end if;
  return query select p.method, p.mode, p.status, count(*), coalesce(sum(p.amount_halala), 0)::bigint,
      coalesce(sum(p.refunded_halala), 0)::bigint, coalesce(sum(p.fee_halala), 0)::bigint
    from public.payments p where public._riyadh_date(p.created_at) between p_from and p_to
    group by p.method, p.mode, p.status order by 1, 2, 3;
end; $$;

-- Cancellations without contact details.
create or replace function public.report_cancellations(p_from date, p_to date)
returns table (booking_reference text, account_type text, cancelled_at timestamptz, reason text, payment_status text,
  refund_status text, total_halala bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,finance,operations}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'invalid date range' using errcode = '22023'; end if;
  return query select b.reference, b.account_type, coalesce(b.cancelled_at, b.updated_at), b.cancel_reason, b.payment_status,
      (select r.status from public.refunds r where r.booking_id = b.id order by r.requested_at desc limit 1), b.total_halala
    from public.bookings b
   where b.status in ('cancelled', 'expired') and public._riyadh_date(coalesce(b.cancelled_at, b.updated_at)) between p_from and p_to
   order by 3 desc;
end; $$;

-- Activity by customer segment; individuals are aggregated (no names).
create or replace function public.report_customer_activity(p_from date, p_to date)
returns table (segment text, organization_id uuid, organization text, bookings bigint, passengers bigint, gross_halala bigint, cancellations bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,finance,operations}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'invalid date range' using errcode = '22023'; end if;
  return query
    select b.account_type, b.organization_id, coalesce(o.display_name, 'Individual customers (aggregated)'),
      count(*), coalesce(sum(b.passenger_count), 0)::bigint,
      coalesce(sum(b.total_halala) filter (where b.payment_status in ('paid', 'on_account', 'partially_refunded')), 0)::bigint,
      count(*) filter (where b.status in ('cancelled', 'expired'))
    from public.bookings b left join public.organizations o on o.id = b.organization_id
    where public._riyadh_date(b.created_at) between p_from and p_to
    group by b.account_type, b.organization_id, o.display_name order by 6 desc;
end; $$;

-- Organization-scoped report for corporate admins and agents (own records only).
create or replace function public.report_my_organization(p_org uuid, p_from date, p_to date)
returns table (bookings bigint, passengers bigint, gross_halala bigint, paid_halala bigint, on_account_halala bigint,
  outstanding_halala bigint, cancellations bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_org_role(p_org, '{company_admin}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'invalid date range' using errcode = '22023'; end if;
  return query select count(*), coalesce(sum(b.passenger_count), 0)::bigint,
      coalesce(sum(b.total_halala) filter (where b.status not in ('cancelled', 'expired')), 0)::bigint,
      coalesce(sum(b.total_halala) filter (where b.payment_status = 'paid'), 0)::bigint,
      coalesce(sum(b.total_halala) filter (where b.payment_status = 'on_account'), 0)::bigint,
      (select c.outstanding_halala from public._credit_position(p_org) c),
      count(*) filter (where b.status in ('cancelled', 'expired'))
    from public.bookings b where b.organization_id = p_org and public._riyadh_date(b.created_at) between p_from and p_to;
end; $$;

create or replace function public.report_agent_activity(p_from date, p_to date)
returns table (agent_organization_id uuid, agent text, bookings bigint, passengers bigint, gross_halala bigint, settlements_open bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,finance}') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'invalid date range' using errcode = '22023'; end if;
  return query select o.id, o.display_name, count(b.id), coalesce(sum(b.passenger_count), 0)::bigint,
      coalesce(sum(b.total_halala) filter (where b.payment_status in ('paid', 'on_account', 'partially_refunded')), 0)::bigint,
      (select count(*) from public.agent_settlements s where s.agent_organization_id = o.id and s.status in ('draft', 'approved'))
    from public.organizations o left join public.bookings b on b.agent_organization_id = o.id and public._riyadh_date(b.created_at) between p_from and p_to
   where o.account_type = 'agent' and o.status = 'approved'
   group by o.id, o.display_name order by 5 desc;
end; $$;

do $$
declare f text;
begin
  foreach f in array array['report_period_summary(date, date, text)', 'report_revenue_by_destination(date, date)',
    'report_payments_summary(date, date)', 'report_cancellations(date, date)', 'report_customer_activity(date, date)',
    'report_my_organization(uuid, date, date)', 'report_agent_activity(date, date)'] loop
    execute format('revoke all on function public.%s from public, anon, service_role', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
