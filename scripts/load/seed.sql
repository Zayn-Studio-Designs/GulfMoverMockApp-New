-- Load-test seed for a DISPOSABLE local database only (scripts/load/run-load-test.sh).
-- 1,000 fictional users, 180 future sailings (30 days x 6) and a helper that books as the
-- signed-in user exactly like the app does, recording refusals instead of aborting the client.
create schema if not exists loadtest;
drop table if exists loadtest.users, loadtest.sailings;
create table loadtest.users (n integer primary key, id uuid not null, claims text not null);
create table loadtest.sailings (n integer primary key, id uuid not null);

insert into loadtest.users (n, id, claims)
select g, gen_random_uuid(), '' from generate_series(1, 1000) g;
update loadtest.users set claims = json_build_object('sub', id, 'role', 'authenticated', 'aal', 'aal1')::text;
insert into auth.users (id, email, email_confirmed_at, aud, role, created_at, updated_at)
select id, 'loadtest-' || n || '@example.test', now(), 'authenticated', 'authenticated', now(), now() from loadtest.users;
insert into public.profiles (id, display_name, preferred_language, status)
select id, 'Load test user ' || n, 'en', 'active' from loadtest.users;

insert into public.vessels (id, name, passenger_capacity, status) values ('00000000-0000-4000-8000-00000000f00d', 'Load test vessel (fictional)', 12, 'active')
on conflict (id) do nothing;
insert into public.sailings (route_id, vessel_id, departs_at, seat_capacity, status)
select (select id from public.routes where origin = 'Ras Tanura Service Pier' limit 1), '00000000-0000-4000-8000-00000000f00d',
       date_trunc('day', now()) + interval '3 days' + d * interval '1 day' + h * interval '2 hours', 12, 'open'
  from generate_series(0, 29) d, generate_series(0, 5) h
on conflict do nothing;
insert into loadtest.sailings (n, id)
select row_number() over (order by departs_at), id from public.sailings where vessel_id = '00000000-0000-4000-8000-00000000f00d';

create or replace function loadtest.try_book(p_sailing uuid) returns text language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.create_individual_booking(gen_random_uuid(), p_sailing, 1, 'Load Test', 'load@example.test', '+966500000000',
    null::text[], null::uuid, null::text, null::text,
    (select version from public.service_policies where policy_type = 'booking_terms' order by (status = 'approved') desc, effective_from desc limit 1));
  return 'ok';
exception when others then
  return left(sqlerrm, 40); -- sold out / rate limited etc. are expected outcomes, not crashes
end; $$;
grant usage on schema loadtest to authenticated;
grant select on loadtest.sailings to authenticated;
grant execute on function loadtest.try_book(uuid) to authenticated;
analyze;
