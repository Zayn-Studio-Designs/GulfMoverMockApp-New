#!/usr/bin/env bash
# Backup + restore DRILL against DISPOSABLE local containers (never a hosted project).
#
#   scripts/db/backup-restore-drill.sh            # uses the running gm-db (54322) as the source
#
# 1. pg_dump the application data from the source: auth.users (data only, needed for
#    foreign keys), and the full `public` + `supabase_migrations` schemas.
# 2. Start a fresh restore container from the same image, apply the auth harness stub.
# 3. Restore and compare per-table row counts and content checksums for every public
#    table, then run functional smoke checks (health ping, minimum-sailing evaluation,
#    invoice hash chain continuity).
# Exit code 0 only if every comparison matches. Output: a timestamped report file.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_PORT="${GM_DB_PORT:-54322}"
SRC_NAME="${GM_DB_CONTAINER:-gm-db}"
DST_NAME="${GM_RESTORE_CONTAINER:-gm-db-restore}"
DST_PORT="${GM_RESTORE_PORT:-54324}"
IMAGE="${GM_DB_IMAGE:-supabase/postgres:17.6.1.054}"
export PGPASSWORD="${GM_DB_PASSWORD:-postgres}"
WORK="$(mktemp -d)"
REPORT="${GM_DRILL_REPORT:-$WORK/drill-report.txt}"
src() { psql -h 127.0.0.1 -p "$SRC_PORT" -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 "$@"; }
dst() { psql -h 127.0.0.1 -p "$DST_PORT" -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 "$@"; }
log() { echo "$*" | tee -a "$REPORT"; }

log "Gulf Mover backup/restore drill — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "source 127.0.0.1:$SRC_PORT -> restore container $DST_NAME (127.0.0.1:$DST_PORT), image $IMAGE"

# --- 1. backup -------------------------------------------------------------------------
T0=$(date +%s)
# Server-matched client tools run inside the containers (host psql may be an older major version).
dexec() { docker exec -i -e PGPASSWORD="$PGPASSWORD" "$@"; }
dexec "$SRC_NAME" pg_dump -h 127.0.0.1 -U postgres -d postgres --data-only --table=auth.users --column-inserts > "$WORK/auth_users.sql"
dexec "$SRC_NAME" pg_dump -h 127.0.0.1 -U postgres -d postgres -Fc --no-owner --schema=public --schema=supabase_migrations > "$WORK/app.dump"
log "backup: $(du -h "$WORK/app.dump" | cut -f1) app dump + $(wc -l < "$WORK/auth_users.sql") lines auth users ($(( $(date +%s) - T0 ))s)"
sha256sum "$WORK/app.dump" | tee -a "$REPORT"

# Fingerprint every public table on the source (row count + order-independent content hash).
fingerprint() { # $1 = runner function name
  "$1" -c "select string_agg(t, E'\n' order by t) from (
    select format('%s|%s', c.relname, (xpath('/row/c/text()', query_to_xml(format(
      'select count(*)::text || '':'' || coalesce(md5(string_agg(md5(t::text), '''' order by md5(t::text))), ''-'') as c from public.%I t', c.relname), false, true, '')))[1]::text) as t
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r') x"
}
fingerprint src > "$WORK/source.fp"

# --- 2. fresh target -------------------------------------------------------------------------
docker rm -f "$DST_NAME" >/dev/null 2>&1 || true
docker run -d --name "$DST_NAME" -p "127.0.0.1:$DST_PORT:5432" -e POSTGRES_PASSWORD="$PGPASSWORD" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do pg_isready -h 127.0.0.1 -p "$DST_PORT" -q && dst -c 'select 1' >/dev/null 2>&1 && break; sleep 2; done
sleep 3
psql -h 127.0.0.1 -p "$DST_PORT" -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/auth_stub.sql" >/dev/null

# --- 3. restore ------------------------------------------------------------------------------
T1=$(date +%s)
psql -h 127.0.0.1 -p "$DST_PORT" -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -f "$WORK/auth_users.sql" >/dev/null
# The dump recreates the public schema (with its grants) exactly as backed up.
psql -h 127.0.0.1 -p "$DST_PORT" -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -c 'drop schema if exists public cascade' >/dev/null
# Disable triggers during the data load (audit/notification triggers must not fire twice).
dexec "$DST_NAME" pg_restore -h 127.0.0.1 -U supabase_admin -d postgres --no-owner --exit-on-error --disable-triggers < "$WORK/app.dump"
log "restore: completed in $(( $(date +%s) - T1 ))s"

fingerprint dst > "$WORK/restored.fp"
if diff -u "$WORK/source.fp" "$WORK/restored.fp" > "$WORK/fp.diff"; then
  log "verify: $(wc -l < "$WORK/source.fp") public tables identical (row counts + content hashes)"
else
  log "verify: MISMATCH"; cat "$WORK/fp.diff" | tee -a "$REPORT"; exit 1
fi

# --- 4. functional smoke checks on the restored copy -------------------------------------------
log "smoke: health_ping -> $(dst -c "select public.health_ping() ->> 'status'")"
S=$(dst -c "select id from public.sailings order by departs_at limit 1")
log "smoke: sailing_commercial_status -> $(dst -c "select commercial_state from public.sailing_commercial_status('$S')")"
log "smoke: grants intact (authenticated cannot update tariffs) -> $(dst -c "select not has_table_privilege('authenticated', 'public.tariffs', 'update')")"
BROKEN=$(dst -c "select count(*) from (select icv, previous_hash, lag(h) over (order by icv) as prev from (
  select icv, previous_hash, invoice_hash as h from public.invoices where icv is not null
  union all select icv, previous_hash, document_hash from public.credit_notes where icv is not null) d) x where prev is not null and previous_hash <> prev")
log "smoke: document hash-chain breaks -> $BROKEN"
[ "$BROKEN" = "0" ] || { log "verify: hash chain broken"; exit 1; }
# Scheduled jobs live in the `cron` schema, which is NOT part of the application dump: a restored
# database must have them re-created (same SQL as migration 20261103000002), or holds never expire.
if [ "$(dst -c "select count(*) from pg_available_extensions where name = 'pg_cron'")" = "1" ]; then
  dst -c "create extension if not exists pg_cron" >/dev/null
  dst -c "select cron.schedule('gm-expire-stale-holds', '* * * * *', 'select public.expire_stale_holds()')" >/dev/null
  JOBS=$(dst -c "select count(*) from cron.job where jobname = 'gm-expire-stale-holds' and active")
  log "smoke: scheduled jobs re-created after restore -> $JOBS"
  [ "$JOBS" = "1" ] || { log "verify: scheduled job missing after restore"; exit 1; }
fi
log "RESULT: PASS (report: $REPORT)"
[ "${GM_DRILL_KEEP:-0}" = "1" ] || docker rm -f "$DST_NAME" >/dev/null 2>&1 || true
