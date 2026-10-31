#!/usr/bin/env bash
# Load test against a DISPOSABLE local database (never a hosted project).
#
#   scripts/load/run-load-test.sh [label]
#
# Models 100 / 500 / 1,000 ACTIVE users, each making one request every 3 seconds (a busy
# peak; normal browsing is far slower), through a 20-connection pool — the way the hosted
# REST API (PostgREST) reaches Postgres: per request it switches to role `authenticated`,
# applies the user's JWT claims, and row-level security filters every row.
# Then: an unthrottled saturation run (capacity ceiling) and a booking storm (1,000 attempts
# on 5 sailings). Finally integrity invariants (no oversell, exact seat counters, hold limit).
# Not covered: HTTP/JSON/TLS overhead of the REST gateway, Auth (GoTrue) and the browser.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="${1:-run}"
NAME="${GM_LOAD_CONTAINER:-gm-load}"; PORT="${GM_LOAD_PORT:-54325}"; POOL="${GM_LOAD_POOL:-20}"; SECONDS_PER_RUN="${GM_LOAD_SECONDS:-60}"
export PGPASSWORD=postgres
PSQL=(psql -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -X -q -At -v ON_ERROR_STOP=1)
OUT="${GM_LOAD_OUT:-$ROOT/docs/load-test}"; mkdir -p "$OUT"; REPORT="$OUT/load-test-$LABEL.txt"; : > "$REPORT"
log() { echo "$*" | tee -a "$REPORT"; }

if [ "${GM_LOAD_REUSE:-0}" != "1" ]; then
  GM_DB_CONTAINER="$NAME" GM_DB_PORT="$PORT" "$ROOT/scripts/db/local-db.sh" down >/dev/null 2>&1 || true
  GM_DB_CONTAINER="$NAME" GM_DB_PORT="$PORT" "$ROOT/scripts/db/local-db.sh" up 2>&1 | grep -E "ERROR|did not become ready" || true
  "${PSQL[@]}" -c "set client_min_messages = warning" -f "$ROOT/scripts/load/seed.sql"
fi
"${PSQL[@]}" -c "create extension if not exists pg_stat_statements" >/dev/null
docker cp "$ROOT/scripts/load/session.pgbench" "$NAME:/tmp/session.pgbench"
docker cp "$ROOT/scripts/load/storm.pgbench" "$NAME:/tmp/storm.pgbench"
bench() { docker exec -e PGPASSWORD=postgres -w /tmp "$NAME" pgbench -h 127.0.0.1 -U postgres -d postgres -n "$@"; }
pct() { # latency percentiles (ms) from pgbench per-transaction logs (3rd column = microseconds)
  docker exec "$NAME" sh -c 'cat /tmp/pgbench_log.* 2>/dev/null' | awk '{print $3}' | sort -n | awk '
    {a[NR]=$1} END {if (NR==0) {print "n/a"; exit}; printf "p50 %.1f ms, p95 %.1f ms, p99 %.1f ms, max %.1f ms", a[int(NR*0.5)]/1000, a[int(NR*0.95)]/1000, a[int(NR*0.99)]/1000, a[NR]/1000}'
  docker exec "$NAME" sh -c 'rm -f /tmp/pgbench_log.*'; }

log "Gulf Mover load test ($LABEL) — $(date -u +%FT%TZ)"
log "host: $(nproc) CPU, $(free -g | awk '/Mem:/{print $2}') GB RAM (shared laptop/container — NOT production hardware); pool $POOL connections"
log "schema: $("${PSQL[@]}" -c "select max(version) from supabase_migrations.schema_migrations")"
for USERS in 100 500 1000; do
  RATE=$(( USERS / 3 ))
  "${PSQL[@]}" -c "select pg_stat_statements_reset()" >/dev/null
  RES=$(bench -f /tmp/session.pgbench -c "$POOL" -j 4 -T "$SECONDS_PER_RUN" -R "$RATE" -l 2>&1)
  TPS=$(echo "$RES" | awk -F'= ' '/^tps/{print $2}' | awk '{print $1}')
  FAIL=$(echo "$RES" | awk '/number of failed transactions/{print $5}')
  TX=$(echo "$RES" | awk '/number of transactions actually processed/{print $6}')
  log "$USERS active users (target $RATE req/s): $TX requests, ${TPS} req/s achieved, failed $FAIL, latency $(pct)"
  if [ "$USERS" = "1000" ]; then
    log "  slowest statements at 1,000 users (mean ms | calls | statement):"
    "${PSQL[@]}" -c "select round(mean_exec_time::numeric, 2) || ' | ' || calls || ' | ' || left(regexp_replace(query, '\s+', ' ', 'g'), 110)
      from pg_stat_statements where query !~* '^(begin|end|set|select set_config|select pg_stat)' order by mean_exec_time desc limit 6" | sed 's/^/    /' | tee -a "$REPORT"
  fi
done
RES=$(bench -f /tmp/session.pgbench -c "$POOL" -j 4 -T 30 -l 2>&1)
log "saturation (unthrottled, $POOL connections): $(echo "$RES" | awk -F'= ' '/^tps/{print $2}' | awk '{print $1}') req/s, latency $(pct)"
RES=$(bench -f /tmp/storm.pgbench -c 50 -j 4 -t 20 -l 2>&1)
log "booking storm (1,000 attempts on 5 sailings, 50 at once): latency $(pct), failed $(echo "$RES" | awk '/number of failed transactions/{print $5}')"
log "invariants:"
log "  oversold sailings: $("${PSQL[@]}" -c "select count(*) from public.sailings where seats_booked > seat_capacity")"
log "  seat counter drift: $("${PSQL[@]}" -c "select count(*) from public.sailings s where s.seats_booked <> coalesce((select sum(l.passengers) from public.booking_legs l join public.bookings b on b.id = l.booking_id where l.sailing_id = s.id and b.status not in ('cancelled','expired','refunded')), 0)")"
log "  storm sailings booked: $("${PSQL[@]}" -c "select string_agg(seats_booked || '/' || seat_capacity, ' ') from public.sailings s join loadtest.sailings l on l.id = s.id where l.n <= 5")"
log "  users above the unpaid-hold limit: $("${PSQL[@]}" -c "select count(*) from (select created_by from public.bookings where payment_status = 'unpaid' and status = 'reserved' group by created_by having count(*) > (select (value->>'value')::int from public.platform_settings where key = 'limits.unpaid_holds_per_user')) x")"
log "  bookings created: $("${PSQL[@]}" -c "select count(*) from public.bookings b join loadtest.users u on u.id = b.created_by")"
log "report: $REPORT"
