-- =============================================================================
-- Query efficiency: remove the N+1 request pattern on sailing lists.
--
-- The Sailing Control page made two network round trips PER sailing card
-- (sailing_commercial_status + sailing_boarding_gate): ~400 requests for a
-- week of sailings. The booking page did the same per leg. This migration adds
-- ONE set-based call that returns both values for a whole list of sailings.
--
-- Scope decision (measured, see docs/test-results.md): the existing
-- per-sailing functions and the reports are deliberately left unchanged.
-- Inside PostgreSQL their per-row calls never leave the server and were as
-- fast or faster than set-based rewrites (single-sailing calls routed through
-- this helper were ~45x slower per call, which would have slowed boarding
-- scans). The batch function must stay result-identical to the per-sailing
-- functions; src/tests/db/query-efficiency.db.test.ts enforces that.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Set-based minimum-sailing status + boarding gate (internal helper)
-- ---------------------------------------------------------------------------
create or replace function public._sailing_status_rows(p_sailing_ids uuid[])
returns table (sailing_id uuid, reserved_tickets bigint, qualifying_tickets bigint, qualifying_revenue_halala bigint,
               threshold_tickets integer, threshold_revenue_halala bigint, threshold_met boolean,
               confirmation_deadline timestamptz, commercial_state text, counting_basis text, boarding_gate text)
language plpgsql stable security definer set search_path = '' as $$
declare v_basis text; v_need_t integer; v_need_r bigint; v_deadline_h integer; v_req jsonb;
begin
  -- Settings are read once for the whole set, not once per sailing.
  v_basis := public.setting_text('sailing.minimum_counts', 'paid_and_on_account');
  v_need_t := public.setting_int('sailing.minimum_tickets', 4);
  v_need_r := coalesce((select (value ->> 'value')::bigint from public.platform_settings where key = 'sailing.minimum_revenue_halala'), 200000);
  v_deadline_h := public.setting_int('booking.confirmation_deadline_hours', 24);
  v_req := coalesce((select value -> 'value' from public.platform_settings where key = 'boarding.required_checkpoints'),
                    '["operations_readiness","master_decision","port_clearance"]'::jsonb);
  return query
  with ids as (select distinct x.id from unnest(p_sailing_ids) as x(id) where x.id is not null),
  live as (   -- tickets that count for the minimum, with their booking
    select t.sailing_id, b.id as booking_id, b.passenger_count, b.net_halala, b.payment_status
      from public.tickets t join public.bookings b on b.id = t.booking_id
     where t.sailing_id in (select id from ids) and t.status in ('valid', 'boarded')
       and b.status not in ('cancelled', 'expired', 'refunded')),
  leg_counts as (   -- legs per booking, counted once per booking (not once per ticket)
    select l.booking_id, count(*) as legs from public.booking_legs l
     where l.booking_id in (select booking_id from live) group by l.booking_id),
  agg as (
    select lv.sailing_id, count(*) as reserved,
      count(*) filter (where v_basis = 'all_reserved' or lv.payment_status in ('paid', 'on_account', 'partially_refunded')) as qualifying,
      coalesce(sum((coalesce(lv.net_halala, 0) / greatest(coalesce(lc.legs, 0), 1)) / greatest(lv.passenger_count, 1))
        filter (where v_basis = 'all_reserved' or lv.payment_status in ('paid', 'on_account', 'partially_refunded')), 0) as revenue
      from live lv left join leg_counts lc on lc.booking_id = lv.booking_id
     group by lv.sailing_id)
  select s.id, coalesce(a.reserved, 0), coalesce(a.qualifying, 0), coalesce(a.revenue, 0)::bigint,
         v_need_t, v_need_r, m.met, m.deadline,
         case when m.met then 'threshold_met'
              when s.commercial_decision = 'proceed_below_minimum' then 'proceed_below_minimum'
              when now() >= m.deadline then 'below_minimum_after_deadline'
              else 'awaiting_minimum' end,
         v_basis,
         case when s.status = 'cancelled' then 'sailing_cancelled'
              when s.status = 'suspended' then 'sailing_suspended'
              when s.readiness_status <> 'ready' then 'not_ready'
              when v_req ? 'master_decision' and s.master_decision <> 'go' then 'master_not_go'
              when v_req ? 'port_clearance' and s.port_clearance_status not in ('cleared', 'not_required') then 'clearance_pending'
              else 'open' end
    from public.sailings s
    join ids on ids.id = s.id
    left join agg a on a.sailing_id = s.id
    cross join lateral (select (coalesce(a.qualifying, 0) >= v_need_t or coalesce(a.revenue, 0) >= v_need_r) as met,
                               s.departs_at - make_interval(hours => v_deadline_h) as deadline) m;
end; $$;
revoke all on function public._sailing_status_rows(uuid[]) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Batch API: status for many sailings in ONE call (Sailing Control, booking page)
-- ---------------------------------------------------------------------------
create or replace function public.sailing_control_status(p_sailing_ids uuid[])
returns table (sailing_id uuid, reserved_tickets bigint, qualifying_tickets bigint, qualifying_revenue_halala bigint,
               threshold_tickets integer, threshold_revenue_halala bigint, threshold_met boolean,
               confirmation_deadline timestamptz, commercial_state text, counting_basis text, boarding_gate text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_sailing_ids is null or cardinality(p_sailing_ids) > 500 then
    raise exception 'invalid sailing list' using errcode = '22023';
  end if;
  return query select * from public._sailing_status_rows(p_sailing_ids);
end; $$;
revoke all on function public.sailing_control_status(uuid[]) from public, anon, service_role;
grant execute on function public.sailing_control_status(uuid[]) to authenticated;
