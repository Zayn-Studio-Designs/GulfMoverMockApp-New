# Backup and recovery

## Tested here (disposable local containers only)

`scripts/db/backup-restore-drill.sh` (also run in CI) performs a real drill:

1. `pg_dump` of `auth.users` (data) and the full `public` + `supabase_migrations` schemas from
   the source database (server-matched tools run inside the container).
2. A **fresh** database container from the same `supabase/postgres` image.
3. `pg_restore` with triggers disabled during load (audit/notification triggers must not fire twice).
4. Verification: every public table compared by row count **and** an order-independent content
   hash; functional smoke checks (`health_ping`, minimum-sailing evaluation), grants intact
   (`authenticated` still cannot update tariffs), and the invoice/credit-note hash chain unbroken.

Result on 28 Oct 2026: **PASS — 47 public tables identical**, smoke checks passed, 0 hash-chain
breaks. Dump size ≈ 676 KB for the test dataset; restore < 1 s locally.

Re-run on 31 Oct 2026 (production-readiness audit), with all 35 migrations applied:
- **PASS:** 47 tables identical, smoke checks clean, 0 hash-chain breaks.
- **New step:** scheduled jobs re-created and verified after the restore.
- **Timing:** about 1 s to dump and 1 s to restore for this dataset.

**Important:** `pg_cron` jobs live in the `cron` schema, which is not in the application dump. After any restore, re-create them:
- re-run the `DO` block of migration `20261103000002`
- re-run the two `cron.schedule` calls in `docs/operations/background-jobs.md`

Until then, `system_diagnostics()` reports `no_scheduled_jobs_configured`.

## Not yet verified (requires ATCO's hosted project)

- Supabase managed backups / point-in-time recovery (plan-dependent) — enable and **test a
  restore into a separate project** before go-live; record RPO/RTO achieved.
- Storage bucket (`material-attachments`) backup: Supabase does not include Storage objects in
  database backups. Schedule a daily object copy outside the project and test a restore.
  - **Tool:** the CLI (`supabase storage cp -r ss:///material-attachments ./backup/<date> --experimental`) or rclone/S3 against the S3-compatible endpoint.
  - **Credentials:** the copy needs the service role or S3 access keys; keep them in the backup system's secret store.
  - **Status:** not run here (there's no hosted project).
- Auth configuration (providers, redirect URLs, SMTP, MFA settings) — export and document.

## How much data could be lost, and how long recovery takes (hosted Supabase)

| Setup | Data loss (RPO) | Recovery time (RTO) |
|---|---|---|
| Free plan | No managed backups: **everything since your last own dump** | Hours (manual) |
| Pro plan, daily backups (7 days kept) | **Up to 24 hours** of bookings and payments | Roughly 15–60 minutes plus verification; grows with database size |
| Pro + Point-in-Time Recovery add-on | **About 2 minutes** | Similar; restore to any second within the retention window |
| Storage objects (attachments) | Since the last object copy (daily → up to 24 hours) | Depends on volume |

Payments in the gap must be reconciled against the provider dashboard (`report_payment_reconciliation`).

**Recommendation:** for a booking and payment system, use PITR.

## Recommended targets (for ATCO approval)

| Item | Proposal |
|---|---|
| RPO | ≤ 15 minutes (PITR) |
| RTO | ≤ 4 hours |
| Logical dump | Daily, retained per ATCO retention policy, encrypted, stored outside the primary region/account |
| Restore test | Quarterly into a scratch project using this drill's verification queries |

## Restore runbook (hosted)

1. Freeze writes (maintenance banner; disable scheduled jobs).
2. Restore PITR to the chosen instant **into a new project** (never overwrite the only copy).
3. Run the verification queries from the drill script against the restored project.
4. Re-point the app (`VITE_SUPABASE_URL`/keys) or promote the restored project; re-set
   edge-function secrets; re-register provider webhooks.
5. Reconcile payments with the provider's dashboard for the gap period (`report_payment_reconciliation`).
