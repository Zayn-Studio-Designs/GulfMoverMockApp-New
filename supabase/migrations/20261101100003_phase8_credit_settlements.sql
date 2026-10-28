-- ===========================================================================
-- 20261101100003 — Phase 8: corporate credit control and agent settlements.
-- ===========================================================================
-- * Credit limits/terms are set ONLY by ATCO Finance/super_admin, with a reason,
--   and every change is audited (config_audit). Corporate users cannot change
--   their own terms (no grant, definer RPC checks platform role).
-- * A facility must be explicitly activated; holds block on-account bookings.
-- * Agent commission rules exist but pay nothing until ATCO approves a rule.
--   No remuneration percentage is invented: none is seeded.
-- ===========================================================================

create or replace function public.set_organization_credit(p_org uuid, p_credit_limit_halala bigint, p_payment_terms_days integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_org is null then raise exception 'invalid input' using errcode = '22023'; end if;
  perform public._require_staff('{super_admin,finance}');
  if p_credit_limit_halala is not null and (p_credit_limit_halala < 0 or p_credit_limit_halala > 9000000000000) then
    raise exception 'invalid credit limit' using errcode = '22023'; end if;
  if p_payment_terms_days is not null and (p_payment_terms_days < 0 or p_payment_terms_days > 365) then
    raise exception 'invalid payment terms' using errcode = '22023'; end if;
  if nullif(current_setting('gm.change_reason', true), '') is null then
    perform set_config('gm.change_reason', 'credit terms updated', true);
  end if;
  update public.organizations set credit_limit_halala = p_credit_limit_halala, payment_terms_days = p_payment_terms_days,
    credit_status = case when p_credit_limit_halala is null then 'none' else credit_status end
   where id = p_org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
end; $$;

create or replace function public.set_credit_status(p_org uuid, p_status text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_o record; v_reason text;
begin
  perform public._require_staff('{super_admin,finance}');
  v_reason := public._valid_reason(p_reason);
  if p_status is null or p_status not in ('none', 'active', 'on_hold') then raise exception 'invalid status' using errcode = '22023'; end if;
  select status, credit_limit_halala, payment_terms_days, credit_status into v_o from public.organizations where id = p_org for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if p_status = 'active' and (v_o.status <> 'approved' or v_o.credit_limit_halala is null or v_o.payment_terms_days is null) then
    raise exception 'credit_terms_required: approved organization with limit and terms required' using errcode = '55000'; end if;
  if v_o.credit_status = p_status then return 'unchanged'; end if;
  perform set_config('gm.change_reason', v_reason, true);
  update public.organizations set credit_status = p_status,
    credit_hold_reason = case when p_status = 'on_hold' then v_reason else null end where id = p_org;
  return p_status;
end; $$;
revoke all on function public.set_credit_status(uuid, text, text) from public, anon, service_role;
grant execute on function public.set_credit_status(uuid, text, text) to authenticated;

create or replace function public.report_outstanding_balances()
returns table (organization_id uuid, legal_name text, account_type text, credit_status text, credit_limit_halala bigint,
               payment_terms_days integer, outstanding_halala bigint, overdue_halala bigint, available_halala bigint, open_invoices bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_platform_role('{super_admin,finance}') then raise exception 'not authorized' using errcode = '42501'; end if;
  return query select o.id, o.legal_name, o.account_type, c.credit_status, c.credit_limit_halala, c.payment_terms_days,
      c.outstanding_halala, c.overdue_halala, c.available_halala,
      (select count(*) from public.invoices i where i.organization_id = o.id and i.status in ('issued', 'partially_paid'))
    from public.organizations o cross join lateral public._credit_position(o.id) c
   where o.status = 'approved' and (o.credit_status <> 'none' or c.outstanding_halala > 0)
   order by c.overdue_halala desc, c.outstanding_halala desc;
end; $$;
revoke all on function public.report_outstanding_balances() from public, anon, service_role;
grant execute on function public.report_outstanding_balances() to authenticated;

-- ---------------------------------------------------------------------------
-- Agent commission rules (inactive until approved) and settlements
-- ---------------------------------------------------------------------------
create table if not exists public.agent_commission_rules (
  id                    uuid primary key default gen_random_uuid(),
  agent_organization_id uuid references public.organizations (id),
  basis                 text not null constraint agent_commission_rules_basis_check check (basis in ('percent_of_net_bp', 'per_passenger_halala')),
  value                 bigint not null constraint agent_commission_rules_value_range check (value between 0 and 9000000000000),
  status                text not null default 'provisional' constraint agent_commission_rules_status_check check (status in ('provisional', 'approved', 'retired')),
  effective_from        date not null,
  effective_to          date,
  notes                 text constraint agent_commission_rules_notes_length check (notes is null or char_length(notes) <= 500),
  created_by            uuid references auth.users (id),
  approved_by           uuid references auth.users (id),
  approved_at           timestamptz,
  created_at            timestamptz not null default now(),
  constraint agent_commission_rules_percent_cap check (basis <> 'percent_of_net_bp' or value <= 10000),
  constraint agent_commission_rules_dates check (effective_to is null or effective_to >= effective_from)
);
comment on table public.agent_commission_rules is
  'Commission/revenue-share rules. NULL agent = network default. Only approved rules pay out. No rates are seeded.';
alter table public.agent_commission_rules enable row level security;
drop policy if exists agent_commission_rules_select on public.agent_commission_rules;
create policy agent_commission_rules_select on public.agent_commission_rules for select to authenticated
  using (public.has_platform_role('{super_admin,finance}')
         or (agent_organization_id is not null and public.has_org_role(agent_organization_id, '{company_admin}')));
revoke all on public.agent_commission_rules from public, anon, authenticated, service_role;
grant select on public.agent_commission_rules to authenticated;
drop trigger if exists trg_audit_config on public.agent_commission_rules;
create trigger trg_audit_config after insert or update or delete on public.agent_commission_rules
  for each row execute function public.audit_config_change();

create or replace function public.propose_commission_rule(p_agent_org uuid, p_basis text, p_value bigint, p_effective_from date, p_effective_to date, p_notes text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public._require_staff('{super_admin,finance}');
  if p_basis is null or p_basis not in ('percent_of_net_bp', 'per_passenger_halala') or p_value is null or p_value < 0
     or (p_basis = 'percent_of_net_bp' and p_value > 10000) or p_effective_from is null then
    raise exception 'invalid rule' using errcode = '22023'; end if;
  if p_agent_org is not null and not exists (select 1 from public.organizations where id = p_agent_org and account_type = 'agent') then
    raise exception 'not_agent_organization' using errcode = '22023'; end if;
  perform set_config('gm.change_reason', 'commission rule proposed', true);
  insert into public.agent_commission_rules (agent_organization_id, basis, value, effective_from, effective_to, notes, created_by)
  values (p_agent_org, p_basis, p_value, p_effective_from, p_effective_to, nullif(btrim(p_notes), ''), auth.uid()) returning id into v_id;
  return v_id;
end; $$;

create or replace function public.approve_commission_rule(p_rule_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_r public.agent_commission_rules%rowtype;
begin
  perform public._require_staff('{super_admin,finance}');
  perform set_config('gm.change_reason', public._valid_reason(p_reason), true);
  select * into v_r from public.agent_commission_rules where id = p_rule_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_r.status = 'approved' then return 'unchanged'; end if;
  if v_r.status <> 'provisional' then raise exception 'invalid_transition' using errcode = '55000'; end if;
  if v_r.created_by = auth.uid() then raise exception 'four_eyes_required: the proposer cannot approve' using errcode = '42501'; end if;
  update public.agent_commission_rules set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_rule_id;
  return 'approved';
end; $$;

alter table public.agent_settlements
  add column if not exists gross_halala bigint not null default 0,
  add column if not exists vat_halala bigint not null default 0,
  add column if not exists refunds_halala bigint not null default 0,
  add column if not exists payment_charges_halala bigint not null default 0,
  add column if not exists net_revenue_halala bigint not null default 0,
  add column if not exists commission_halala bigint not null default 0,
  add column if not exists net_due_halala bigint not null default 0,
  add column if not exists trips integer not null default 0,
  add column if not exists passengers integer not null default 0,
  add column if not exists commission_rule_id uuid references public.agent_commission_rules (id),
  add column if not exists commission_status text not null default 'no_approved_rule'
    constraint agent_settlements_commission_status_check check (commission_status in ('no_approved_rule', 'calculated')),
  add column if not exists lines jsonb not null default '[]',
  add column if not exists generated_by uuid references auth.users (id),
  add column if not exists approved_at timestamptz,
  add column if not exists paid_at timestamptz,
  add column if not exists payment_reference text,
  add column if not exists notes text;
alter table public.agent_settlements drop constraint if exists agent_settlements_status_check;
alter table public.agent_settlements add constraint agent_settlements_status_check check (status in ('draft', 'approved', 'paid', 'void'));
create unique index if not exists agent_settlements_one_per_period on public.agent_settlements (agent_organization_id, period_start, period_end) where status <> 'void';

create table if not exists public.agent_settlement_adjustments (
  id            uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.agent_settlements (id) on delete cascade,
  amount_halala bigint not null,
  reason        text not null check (char_length(reason) between 1 and 500),
  created_by    uuid references auth.users (id),
  created_at    timestamptz not null default now()
);
alter table public.agent_settlement_adjustments enable row level security;
drop policy if exists agent_settlement_adjustments_select on public.agent_settlement_adjustments;
create policy agent_settlement_adjustments_select on public.agent_settlement_adjustments for select to authenticated
  using (exists (select 1 from public.agent_settlements s where s.id = agent_settlement_adjustments.settlement_id));
revoke all on public.agent_settlement_adjustments from public, anon, authenticated, service_role;
grant select on public.agent_settlement_adjustments to authenticated;

-- Agents may read their own settlements (statements); Finance sees all.
drop policy if exists agent_settlements_select_staff on public.agent_settlements;
create policy agent_settlements_select_staff on public.agent_settlements for select to authenticated
  using (public.has_platform_role('{super_admin,finance}') or public.has_org_role(agent_organization_id, '{company_admin}'));

create or replace function public.generate_agent_settlement(p_agent_org uuid, p_from date, p_to date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_rule public.agent_commission_rules%rowtype; v_id uuid; v_gross bigint; v_vat bigint; v_ref bigint; v_fee bigint;
  v_trips integer; v_pax integer; v_net bigint; v_comm bigint := 0; v_lines jsonb;
begin
  perform public._require_staff('{super_admin,finance}');
  if p_agent_org is null or p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then raise exception 'invalid period' using errcode = '22023'; end if;
  if not exists (select 1 from public.organizations where id = p_agent_org and account_type = 'agent') then raise exception 'not_agent_organization' using errcode = '22023'; end if;
  if exists (select 1 from public.agent_settlements where agent_organization_id = p_agent_org and status <> 'void'
             and daterange(period_start, period_end, '[]') && daterange(p_from, p_to, '[]')) then
    raise exception 'overlapping settlement exists' using errcode = '23505'; end if;
  -- Bookings attributed to the agent whose first departure falls in the period (Asia/Riyadh).
  with b as (
    select bk.* from public.bookings bk
     where bk.agent_organization_id = p_agent_org and bk.payment_status in ('paid', 'on_account', 'partially_refunded', 'refunded')
       and (select (min(s.departs_at) at time zone 'Asia/Riyadh')::date from public.booking_legs l join public.sailings s on s.id = l.sailing_id where l.booking_id = bk.id)
           between p_from and p_to)
  select coalesce(sum(b.total_halala), 0), coalesce(sum(b.vat_halala), 0),
         coalesce((select sum(r.amount_halala) from public.refunds r where r.booking_id in (select id from b) and r.status = 'succeeded'), 0),
         coalesce((select sum(p.fee_halala) from public.payments p where p.booking_id in (select id from b) and p.fee_halala is not null), 0),
         count(*), coalesce((select count(*) from public.tickets t where t.booking_id in (select id from b) and t.status in ('valid', 'boarded', 'no_show')), 0),
         coalesce(jsonb_agg(jsonb_build_object('reference', b.reference, 'client', b.client_name, 'total_halala', b.total_halala,
           'vat_halala', b.vat_halala, 'payment_status', b.payment_status) order by b.created_at), '[]')
    into v_gross, v_vat, v_ref, v_fee, v_trips, v_pax, v_lines from b;
  v_net := v_gross - v_vat - v_ref - v_fee;
  select * into v_rule from public.agent_commission_rules r
   where r.status = 'approved' and (r.agent_organization_id = p_agent_org or r.agent_organization_id is null)
     and r.effective_from <= p_to and (r.effective_to is null or r.effective_to >= p_from)
   order by (r.agent_organization_id is not null) desc, r.effective_from desc limit 1;
  if v_rule.id is not null then
    v_comm := case v_rule.basis when 'percent_of_net_bp' then (greatest(v_net, 0) * v_rule.value + 5000) / 10000
                                when 'per_passenger_halala' then v_rule.value * v_pax end;
  end if;
  insert into public.agent_settlements (agent_organization_id, period_start, period_end, revenue_halala, fees_halala, adjustments_halala,
    status, gross_halala, vat_halala, refunds_halala, payment_charges_halala, net_revenue_halala, commission_halala, net_due_halala,
    trips, passengers, commission_rule_id, commission_status, lines, generated_by)
  values (p_agent_org, p_from, p_to, v_net, v_fee, 0, 'draft', v_gross, v_vat, v_ref, v_fee, v_net, v_comm, v_comm,
    v_trips, v_pax, v_rule.id, case when v_rule.id is null then 'no_approved_rule' else 'calculated' end, v_lines, auth.uid())
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.adjust_agent_settlement(p_settlement_id uuid, p_amount_halala bigint, p_reason text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_s public.agent_settlements%rowtype; v_total bigint;
begin
  perform public._require_staff('{super_admin,finance}');
  if p_amount_halala is null or p_amount_halala = 0 or abs(p_amount_halala) > 9000000000000 then raise exception 'invalid amount' using errcode = '22023'; end if;
  select * into v_s from public.agent_settlements where id = p_settlement_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_s.status <> 'draft' then raise exception 'invalid_transition: only draft settlements can be adjusted' using errcode = '55000'; end if;
  insert into public.agent_settlement_adjustments (settlement_id, amount_halala, reason, created_by)
  values (p_settlement_id, p_amount_halala, public._valid_reason(p_reason), auth.uid());
  select coalesce(sum(amount_halala), 0) into v_total from public.agent_settlement_adjustments where settlement_id = p_settlement_id;
  update public.agent_settlements set adjustments_halala = v_total, net_due_halala = commission_halala + v_total where id = p_settlement_id;
  return v_s.commission_halala + v_total;
end; $$;

create or replace function public.decide_agent_settlement(p_settlement_id uuid, p_action text, p_reference text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_s public.agent_settlements%rowtype; v_reason text;
begin
  perform public._require_staff('{super_admin,finance}');
  v_reason := public._valid_reason(p_reason);
  select * into v_s from public.agent_settlements where id = p_settlement_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if p_action = 'approve' then
    if v_s.status <> 'draft' then raise exception 'invalid_transition' using errcode = '55000'; end if;
    if v_s.generated_by = auth.uid() then raise exception 'four_eyes_required: the preparer cannot approve' using errcode = '42501'; end if;
    update public.agent_settlements set status = 'approved', approved_by = auth.uid(), approved_at = now(), notes = v_reason where id = p_settlement_id;
  elsif p_action = 'mark_paid' then
    if v_s.status <> 'approved' then raise exception 'invalid_transition' using errcode = '55000'; end if;
    if nullif(btrim(p_reference), '') is null then raise exception 'payment reference required' using errcode = '22023'; end if;
    update public.agent_settlements set status = 'paid', paid_at = now(), payment_reference = btrim(p_reference) where id = p_settlement_id;
  elsif p_action = 'void' then
    if v_s.status = 'paid' then raise exception 'invalid_transition: paid settlements cannot be voided' using errcode = '55000'; end if;
    update public.agent_settlements set status = 'void', notes = v_reason where id = p_settlement_id;
  else
    raise exception 'invalid action' using errcode = '22023';
  end if;
  insert into public.config_audit (entity, entity_id, action, before_value, after_value, reason, actor_user_id)
  values ('agent_settlements', p_settlement_id::text, 'update', jsonb_build_object('status', v_s.status), jsonb_build_object('action', p_action), v_reason, auth.uid());
  return p_action;
end; $$;

do $$
declare f text;
begin
  foreach f in array array['propose_commission_rule(uuid, text, bigint, date, date, text)', 'approve_commission_rule(uuid, text)',
    'generate_agent_settlement(uuid, date, date)', 'adjust_agent_settlement(uuid, bigint, text)', 'decide_agent_settlement(uuid, text, text, text)'] loop
    execute format('revoke all on function public.%s from public, anon, service_role', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
