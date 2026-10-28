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

## Not yet verified (requires ATCO's hosted project)

- Supabase managed backups / point-in-time recovery (plan-dependent) — enable and **test a
  restore into a separate project** before go-live; record RPO/RTO achieved.
- Storage bucket (`material-attachments`) backup: Supabase does not include Storage objects in
  database backups. Schedule an object copy (e.g. rclone/S3-compatible export) and test restore.
- Auth configuration (providers, redirect URLs, SMTP, MFA settings) — export and document.

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
