# Background jobs

Nothing slow runs inside a user's request:
- Notifications are queued in `notification_outbox` and sent later.
- Uploads go straight to Storage.
- PDFs are built in the browser.
- Invoices are issued inside the payment transaction (fast, and must be atomic).

## Jobs

| Job | Runs | How it is scheduled | Idempotent because… | Retries |
|---|---|---|---|---|
| `expire_stale_holds()`: frees seats held by unpaid "pay now" bookings | every minute | **Automatic:** `pg_cron` job `gm-expire-stale-holds`, created by migration `20261103000002` | row locks + `SKIP LOCKED`; an expired booking is never processed twice (tested with 5 overlapping runs) | next minute |
| `notifications-dispatch` edge function: email / SMS / WhatsApp | every minute, once a channel is enabled | **Manual, on the hosted project** (SQL below) | claims under a 5-minute lease (`SKIP LOCKED`); a successful send is never re-queued; email carries `Idempotency-Key` = outbox id | exponential backoff, at most 5 attempts, then `failed` (alerted) |
| `payments/reconcile` edge function: completes payments whose webhook was lost | every 5 minutes, once a provider is live | **Manual, on the hosted project** (SQL below) | uses the same event id as the customer's status poll (`fetch:<id>:<status>`); duplicates are ignored by `apply_payment_result` | next run; per-payment errors never stop the batch |
| `apply_retention(false)`: deletes data past approved retention periods | daily | **Do not schedule** until ATCO approves retention periods | — | — |

### Scheduling the two edge-function jobs (hosted Supabase; ATCO IT, once)

Run this in the production project's SQL editor. The secrets go into Supabase Vault, never into Git:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select vault.create_secret('https://<PROJECT-REF>.supabase.co', 'gm_project_url');
select vault.create_secret('<SERVICE-ROLE-KEY>', 'gm_service_role_key');

select cron.schedule('gm-notifications-dispatch', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'gm_project_url') || '/functions/v1/notifications-dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'gm_service_role_key')),
    body := '{}'::jsonb, timeout_milliseconds := 100000) $$);

select cron.schedule('gm-payments-reconcile', '*/5 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'gm_project_url') || '/functions/v1/payments/reconcile',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'gm_service_role_key')),
    body := '{}'::jsonb, timeout_milliseconds := 60000) $$);
```

Both jobs have names starting `gm-`, so their last run and status appear in `system_diagnostics().scheduled_jobs`.

## Health and alerts

`system_diagnostics()` returns `alerts` and `healthy`. It can be called by super_admin or IT support in the app, or by the service role from an uptime monitor.

**Recommended monitor:** call the endpoint every 5 minutes and page someone when `healthy` is false.

| Alert | Meaning |
|---|---|
| `hold_expiry_job_not_running` | expired holds are more than 10 minutes old: the scheduler stopped |
| `no_scheduled_jobs_configured` / `scheduled_job_failed` | for example after a restore, or a broken job |
| `notifications_failed` / `notifications_stuck` | provider outage or misconfiguration |
| `messaging_daily_cap_reached` | spend cap hit; queued messages are waiting (see `messaging.daily_cap`) |
| `payment_events_unprocessed` / `payments_pending_too_long` / `payments_requiring_review` | payment pipeline needs attention |
| `privacy_requests_overdue` | legal response deadline passed |
