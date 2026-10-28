# Deployment, environments and release procedure

**Nothing in this repository has been deployed.** No hosted Supabase project, DNS record, cloud
resource or production secret was created or changed during Phase 8. This runbook is what ATCO IT
(or an authorised contractor) follows once hosting and data-region decisions are approved.

## 1. Decisions ATCO must make first

| Decision | Options / notes |
|---|---|
| Data region / residency | Supabase region (e.g. a Middle-East region if available to ATCO's plan) vs. self-hosted Supabase in a Saudi data centre. Confirm against ATCO policy and any NCA/SDAIA requirements. |
| Static hosting | Any HTTPS static host (Cloudflare Pages / Netlify read `public/_headers`; nginx: `deploy/nginx.conf`). |
| Domain | e.g. `gulfmover.atco…` — needed for Apple Pay domain verification and auth redirects. |
| Projects | Three separate Supabase projects: **development**, **staging**, **production**. Never share keys or data between them. |
| Payment / messaging providers | See `docs/payments-and-einvoicing.md` and `docs/operations/messaging.md`. |

## 2. Environments

Templates: `deploy/env/{development,staging,production}.env.example` (placeholders only).

- Browser variables (`VITE_*`) are **public**. `npm run check:env -- <env>` refuses server keys,
  secret-looking names, plain HTTP outside development, and local URLs in staging/production.
- Edge-function secrets are set with `supabase secrets set …` per project and validated with
  `npm run check:env -- <env> --functions` (live payments refused outside production).

## 3. Release procedure

1. CI green on the release commit (`.github/workflows/ci.yml`): typecheck, unit tests, build,
   clean-install of every migration, SQL security/business tests, Phase 7→8 upgrade test,
   backup/restore drill.
2. **Backup production** (provider point-in-time recovery + a logical dump as in
   `docs/operations/backup-and-recovery.md`) and record the restore point.
3. Apply migrations to **staging** first: `supabase link --project-ref <staging>` then
   `supabase db push` (applies only new files in `supabase/migrations`, in filename order, each
   in a transaction). Run the staging smoke test (health, booking, sandbox payment, boarding).
4. Build: `npm ci && npm run check:env -- production && npm run build:release` (writes
   `dist/build-info.json` with the commit id for monitoring).
5. Deploy edge functions (`supabase functions deploy payments notifications-dispatch`) — only
   after provider credentials are approved; until then, leave them undeployed (sandbox simulator).
6. Apply migrations to production, then publish `dist/`.
7. Post-deploy checks: `GET /build-info.json`, `POST /rest/v1/rpc/health_ping` (anon),
   staff `system_diagnostics()` in **System & support**, one sandbox booking end-to-end.
8. Schedule jobs (Supabase cron or external scheduler, service role):
   `expire_stale_holds()` every 5 minutes; `notifications-dispatch` every minute once a channel
   is enabled; `apply_retention(false)` daily once ATCO approves retention periods.

## 4. Migration sequencing and rollback

- Migrations are **additive and forward-only**; Phase 8 never edits an earlier migration file.
  The upgrade path is tested from a populated Phase 7 database (`npm run test:db:upgrade`).
- Rollback of application code = redeploy the previous `dist/` (static, instant).
- Rollback of a migration = a **new** corrective migration (never `DROP` data in production).
  If a migration fails mid-way it rolls back as a single transaction.
- Disaster rollback = restore the pre-release backup (see backup runbook) — data written after
  the backup is lost, so prefer corrective migrations.

## 5. Health and monitoring

- `public.health_ping()` (anon-callable; no data) and `dist/build-info.json` for uptime checks.
- `public.system_diagnostics()` (super_admin / it_support): payments mode, stuck/failed messages,
  unprocessed payment events, refunds awaiting review, overdue privacy requests.
- Browser errors: set `VITE_ERROR_REPORTING_URL` to ATCO's collector (Sentry/Datadog intake via
  a proxy). Events are scrubbed of e-mails, phone numbers, JWTs, ticket QR secrets and keys
  (`src/lib/monitoring.ts`, tested).
- Database/auth logs: Supabase project logs; alert on 5xx rate, auth failures, and
  `payments_requiring_review > 0`.

## 6. PWA and native apps

The web app is installable as a PWA (`public/manifest.webmanifest`, `public/sw.js` caching the
static shell only — never API or personal data). Native iOS/Android apps are **separately scoped
work** per the ATCO proposal and are not part of this release.
