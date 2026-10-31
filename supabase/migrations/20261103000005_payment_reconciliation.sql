-- =============================================================================
-- Payment reconciliation (production-readiness audit, area 8: payment webhooks).
--
-- Payments are confirmed by verified webhooks (and by a server-side status fetch
-- when the customer returns). If a webhook is lost AND the customer closes the
-- tab, a captured payment stayed `pending` until the provider happened to retry.
-- The payments edge function's /reconcile route (scheduled, service role) now asks
-- the provider about every payment still pending after 10 minutes, through the
-- same idempotent apply_payment_result path (event id `fetch:<id>:<status>`, the
-- id the status poll uses), so a reconcile racing a webhook or a poll is harmless.
-- =============================================================================

create index if not exists payments_open_created_idx on public.payments (created_at) where status in ('initiated', 'pending');

create or replace function public.list_payments_to_reconcile(p_older_than_minutes integer default 10, p_limit integer default 50)
returns table (id uuid, provider text, provider_payment_id text, mode text, status text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select p.id, p.provider, p.provider_payment_id, p.mode, p.status, p.created_at
      from public.payments p
     where p.status in ('initiated', 'pending') and p.provider_payment_id is not null
       and p.created_at < now() - make_interval(mins => greatest(coalesce(p_older_than_minutes, 10), 1))
       and p.created_at > now() - interval '7 days'
     order by p.created_at
     limit greatest(1, least(coalesce(p_limit, 50), 200));
end; $$;
revoke all on function public.list_payments_to_reconcile(integer, integer) from public, anon, authenticated;
grant execute on function public.list_payments_to_reconcile(integer, integer) to service_role;
