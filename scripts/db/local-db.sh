#!/usr/bin/env bash
# Disposable LOCAL Postgres (supabase/postgres image) for SQL-level tests,
# clean-install/upgrade checks and backup/restore drills. Loopback only.
#
#   scripts/db/local-db.sh up [container] [port]       start + apply stub + all migrations
#   scripts/db/local-db.sh up-to <migration-prefix>     start + apply migrations up to and incl. prefix
#   scripts/db/local-db.sh migrate                      apply migrations not yet recorded
#   scripts/db/local-db.sh down                         remove the container (data discarded)
#
# Never point this at a hosted database: the URL is always 127.0.0.1.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="${GM_DB_CONTAINER:-gm-db}"
PORT="${GM_DB_PORT:-54322}"
IMAGE="${GM_DB_IMAGE:-supabase/postgres:17.6.1.054}"
export PGPASSWORD="${GM_DB_PASSWORD:-postgres}"
PSQL=(psql -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

wait_ready() {
  for _ in $(seq 1 60); do pg_isready -h 127.0.0.1 -p "$PORT" -q && "${PSQL[@]}" -c 'select 1' >/dev/null 2>&1 && return 0; sleep 2; done
  echo "database did not become ready" >&2; return 1
}

ensure_ledger() {
  "${PSQL[@]}" -c "create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, applied_at timestamptz not null default now());"
}

apply_file() { # $1 = path
  local f="$1" v; v="$(basename "$f" | cut -d_ -f1)"
  if [[ "$("${PSQL[@]}" -Atc "select 1 from supabase_migrations.schema_migrations where version='$v'")" == "1" ]]; then return 0; fi
  "${PSQL[@]}" -1 -f "$f" >/dev/null
  "${PSQL[@]}" -c "insert into supabase_migrations.schema_migrations (version, name) values ('$v', '$(basename "$f")')"
  echo "applied $(basename "$f")"
}

migrate() { # optional $1 = stop prefix
  ensure_ledger
  for f in "$ROOT"/supabase/migrations/*.sql; do
    apply_file "$f"
    if [[ -n "${1:-}" && "$(basename "$f")" == "$1"* ]]; then break; fi
  done
}

up() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5432" -e POSTGRES_PASSWORD="$PGPASSWORD" "$IMAGE" >/dev/null
  wait_ready; sleep 3; wait_ready
  psql -h 127.0.0.1 -p "$PORT" -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/auth_stub.sql" >/dev/null
}

case "${1:-}" in
  up) up; migrate ;;
  up-to) up; migrate "${2:?migration prefix required}" ;;
  migrate) migrate ;;
  down) docker rm -f "$NAME" >/dev/null 2>&1 || true ;;
  *) echo "usage: $0 up|up-to <prefix>|migrate|down" >&2; exit 2 ;;
esac
