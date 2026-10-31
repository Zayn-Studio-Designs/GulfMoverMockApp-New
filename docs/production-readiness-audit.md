# Production-readiness audit: preparing for 1,000+ users

- **Date:** 31 Oct 2026
- **Branch:** `feature/age-gate-and-query-efficiency`, based on `origin/feature/phase10.4-actions-diagnosis` (`6ce5500`)
- **Scope:** the whole application. That covers the front end, the database and its server-side functions, Auth, payments, edge functions, deployment, backups and performance.
- **Not touched:** no production system, hosted project or real data. Every test ran against disposable local databases.

## 1. What the application actually is (detected, not assumed)

| Layer | Technology found |
|---|---|
| Front end | Vite + React 18 + TypeScript single-page app; static hosting (`public/_headers` for Cloudflare Pages / Netlify, or `deploy/nginx.conf`) |
| Back end | Supabase: Postgres 17 with row-level security on every table, ~150 `SECURITY DEFINER` functions, PostgREST, Auth (GoTrue), Storage (private `material-attachments` bucket) |
| Server code | Two Deno edge functions: `payments` (Moyasar / Tap / sandbox adapters) and `notifications-dispatch` (Resend email, Unifonic SMS, WhatsApp Cloud) |
| Payments | **Not Stripe.** Moyasar and Tap adapters behind one interface, sandbox only. **No subscriptions** (one-off bookings). |
| AI features | **None.** There are no AI or LLM API calls anywhere in the codebase. |
| CI | GitHub Actions `ci.yml`: typecheck, tests, build, clean database install, upgrade test, backup drill |

**Hosted state:** nothing in this repository is deployed. A hosted demo project exists, but this environment's network policy blocks it, so every hosted setting below is listed as an action for you.

## 2. Problems found, and what was done

Status key: ✅ fixed and tested · 🟡 fixed in code; needs a hosted step from you · 🔴 open

| # | Area | Problem found | Status | Fix / evidence |
|---|---|---|---|---|
| 1 | Race conditions | Payload booked on a sailing had no database-level ceiling | ✅ | Constraint `sailings_payload_not_over_capacity` (migration `…0001`) |
| 2 | Race conditions | An invoice's paid amount wasn't constrained to its total at database level (the code guarded it; a future path might not) | ✅ | Constraint `invoices_amount_paid_within_total` |
| 3 | Race conditions / background jobs | **Seats held by unpaid bookings were only freed if someone called `expire_stale_holds()`. No scheduler existed, so a stopped scheduler blocked seats forever.** | ✅ | `pg_cron` job every minute (`…0002`); a real cron run released a hold in about 9 s; overlapping runs are idempotent |
| 4 | Rate limiting | Write functions had no per-user limits (except privacy requests). **One account could hoard every seat with unpaid holds**, or flood requests and registrations. | ✅ | `BEFORE INSERT` guards (`…0003`): 5 unpaid holds, 10 bookings per 10 min, 20 checkouts/h, 10 requests/h, 3 registrations/day, 30 invitations/h. Configurable; staff exempt; tested under parallel requests |
| 5 | Security | The server accepted 6-character passwords while the app demanded 8 with letters and digits; email resend interval was **1 s**, allowing reset-email floods | 🟡 | `supabase/config.toml`: minimum 8, `letters_digits`, 60 s. **The hosted dashboard must match.** |
| 6 | Error tracking | Failed API requests (5xx, broken responses) were never reported | ✅ | `dataService.run()` reports them; status and error code only, never request or response bodies |
| 7 | Error tracking | No grouping or flood control; a render loop could flood (and bill) the collector | ✅ | Fingerprint per error; max 25 events per page; same error at most once a minute |
| 8 | Error tracking | Scrubbing missed bearer tokens, Supabase keys, ticket references and IBANs | ✅ | Added to the browser and server scrubbers; tested against 12 secret and PII shapes |
| 9 | Error tracking | **The CSP's `connect-src` would have silently blocked any error collector** (and the template still held a placeholder project, which would block Supabase too) | ✅ | `scripts/release/write-csp.mjs` in `build:release` writes the real origins and fails the build if one is blocked |
| 10 | Error tracking | Edge functions logged unscrubbed text; the dispatcher had no error handling | ✅ | `_shared/observability.ts`: scrubbed, fingerprinted JSON logs, optional forwarding; rejected webhooks logged as warnings |
| 11 | Security | Dispatcher secret compared with `!==` (timing leak) | ✅ | Constant-time comparison |
| 12 | Background jobs | **Duplicate messages:** if recording "sent" failed after the provider accepted it, the message was marked failed and sent again (paid SMS twice) | ✅ | Sending and recording are separate, recording is retried, a sent message is never re-queued; tested |
| 13 | Background jobs | No provider timeout and up-front claiming of 50 messages: a hung provider stalled the run until it was killed mid-send | ✅ | 10 s timeout (race plus abort), claims in chunks of 10, 90 s budget |
| 14 | Spending | Once SMS or WhatsApp is enabled, no daily volume ceiling | ✅ | `messaging.daily_cap` (`…0004`): exact even across parallel runs; over-cap messages wait in the queue; alert raised |
| 15 | Payments | **A lost webhook with a customer who never returned left a captured payment "pending"** | ✅ | `/reconcile` route and `list_payments_to_reconcile` (`…0005`), using the same idempotent event id as the status poll; tested at unit and database level |
| 16 | Monitoring | No single place to alert from | ✅ | `system_diagnostics()` now returns `alerts` and `healthy` (job health, stuck holds, failed messages, spend caps, payment states); callable by the service role from a monitor |
| 17 | Environments | **A developer's `.env.local` (pointing at a hosted project) leaked into the unit tests**, as recorded in Phase 9 | ✅ | `vitest.config.ts` forces demo mode; proven with a hostile temporary `.env.local` |
| 18 | Environments | Nothing stopped `npm run dev` from using the production database | ✅ | Dev server refuses hosted projects without an opt-in, and refuses the production project ref outright; `check:env` refuses cross-environment builds |
| 19 | Rollbacks | No tested way to withdraw a database change | ✅ | `supabase/rollback/20261103_production_readiness_down.sql`; drill: down → old suites pass → roll forward → all pass |
| 20 | Backups | Restored databases come back without scheduled jobs (`cron` isn't in the dump) | ✅ | The drill re-creates and verifies them; runbook updated; diagnostics alert if missing |
| 21 | Performance | **75 foreign keys without indexes.** At 1,000 users the booking page's history query averaged 186 ms; p95 latency was 526 ms and the database saturated at 326 req/s. | ✅ | Migration `…0006` added the indexes. Afterwards: p95 9.2 ms, saturation 1,926 req/s (≈5.9×) |
| 22 | Performance | Four row-level-security policies evaluated `auth.uid()` once per row | ✅ | Rewritten to `(select auth.uid())`; same results |
| 23 | Performance (earlier on this branch) | Sailing Control made 2 requests per sailing card (~400 per page), and the booking page 4 | ✅ | One batch call (`sailing_control_status`); tests count round trips |
| 24 | Security (nginx) | **Every nginx location set its own header, so the CSP, HSTS and frame protection were dropped from every response** | ✅ | Header snippet included in every location; a test fails on the old config |
| 25 | Requested feature (earlier on this branch) | 18+ age of consent | ✅ | Sign-in confirmation and sign-up date-of-birth check, enforced in the auth layer; the date of birth is not stored |
| 26 | Performance | 799 kB JavaScript bundle (223 kB gzipped), no code splitting | 🔴 | Low priority: served from a CDN and cached. Recommend lazy-loading staff pages later. |
| 27 | Security | No CAPTCHA on sign-up, sign-in or password reset | 🔴 | Needs a Cloudflare Turnstile or hCaptcha account; Supabase supports it natively |
| 28 | Security | Leaked-password protection and staff MFA enforcement are hosted settings | 🔴 | Dashboard: enable leaked-password protection; set `security.staff_mfa_required` once staff enrol |

Things that were already sound, and stay as they are:
- **Bookings:** row locks, idempotency keys, no overselling.
- **Payments:** signature verification, server re-fetch, duplicate-event protection.
- **Database:** row-level security on every table, pinned `search_path`, least-privilege grants.
- **Storage:** private bucket with size and type limits.
- **Releases:** additive migrations, an upgrade test and a backup drill.

## 3. Tests performed, and their results (all actually run)

| Check | Command | Result |
|---|---|---|
| Type check | `npm run typecheck` | ✅ 0 errors |
| Unit / component suite | `npm test` | ✅ **937 passed**, 152 skipped (need a database or full Supabase stack) |
| Production build | `npm run build` | ✅ |
| Clean install of all 35 migrations | `scripts/db/local-db.sh up` | ✅ |
| Real-database suite | `npm run test:db` | ✅ **70 passed**, 3 skipped (upgrade tests, run separately). Includes the new race, rate-limit, job, spend-cap, reconciliation and batch-status tests |
| Upgrade path with live data | `npm run test:db:upgrade` | ✅ 3 passed |
| Backup → restore into a separate database | `scripts/db/backup-restore-drill.sh` | ✅ PASS: 47 tables identical, smoke checks clean, scheduled jobs re-created |
| Rollback drill | down-script → pre-audit suites → roll forward → full suite | ✅ 39 passed, then 69 passed |
| Load test, 100 / 500 / 1,000 users | `npm run test:load` (disposable database) | ✅ see §4 |
| Hostile `.env.local` isolation | temporary file, then deleted | ✅ tests stayed in demo mode |

Race scenarios proven on real Postgres:
- 40 users racing for 12 seats
- the same booking request sent 10 times at once
- 8 parallel checkouts for one booking
- 8 duplicate payment confirmations
- 6 double-clicked "pay" buttons
- 12 on-account bookings against a credit limit
- 6 concurrent bank payments against one invoice
- 6 parallel refund requests
- 8 identical company registrations

In every case: no overselling, no duplicates, no limits exceeded and no negative values.

## 4. Load test: 100, 500 and 1,000 users

**Setup:**
- **Traffic:** each active user makes one request every 3 seconds, a busy peak.
- **Mix:** 55% browse sailings, 20% "My bookings", 15% the full booking-detail page, 10% new bookings.
- **Requests:** run exactly like the hosted API runs them (role `authenticated`, the user's claims, row-level security).
- **Connections:** a pool of 20 database connections.
- **Hardware:** 4 CPUs (shared container).

| Active users | Before indexes: p95 / p99 | After: p95 / p99 | Failed requests |
|---|---|---|---|
| 100 (33 req/s) | 10.4 / 20.6 ms | 10.7 / 18.4 ms | 0 |
| 500 (166 req/s) | 28.9 / 52.9 ms | 8.9 / 12.4 ms | 0 |
| 1,000 (333 req/s) | **526 / 1,104 ms** | **9.2 / 13.0 ms** | 0 |
| Unthrottled ceiling | 326 req/s | **1,926 req/s** | 0 |
| Booking storm: 1,000 attempts on 5 sailings, 50 at once | p99 155 ms | p99 172 ms | 0 crashes; every sailing exactly 12/12; 0 oversold; 0 counter drift; nobody over the hold limit |

Full reports are in `docs/load-test/load-test-before-indexes.txt` and `docs/load-test/load-test-after-indexes.txt`.

**What this does not measure:**
- the REST gateway's HTTP, JSON and TLS overhead (typically adds a few to 20 ms per request)
- Auth (sign-in) throughput
- the browser
- the hosted machine size

**Next step:** run a staging load test, for example k6 against the REST API, before launch.

## 5. Limits that could affect availability at 1,000 concurrent users (estimates)

1. **Supabase Auth rate limits are per IP address.** The default is about 30 sign-ins or sign-ups per 5 minutes per IP. **Staff or agents behind one office NAT can lock each other out at shift start.** Raise the limit in the dashboard, or exempt office IPs.
2. **Auth email.** Supabase's built-in email service sends only a handful of messages per hour. **Sign-up confirmations and password resets will fail at scale without your own SMTP server** (for example Resend). Required before launch.
3. **Database size and connections.**
   - The smallest compute tier is far smaller than the 4-CPU test box.
   - At peak, 333 req/s sits above what the smallest tier sustains comfortably.
   - **Plan for at least the Small/Medium compute add-on**, then confirm with the staging load test.
   - Connection limits grow with compute size, and the REST API pools connections, so 1,000 users don't need 1,000 connections.
4. **Spend cap (Pro plan).** With the cap on, exceeding a quota restricts the project, which means downtime; with it off, you're billed for overage. Choose deliberately and set billing alerts.
5. **Messaging caps** (`messaging.daily_cap`). Over-cap messages wait rather than fail, but customers get them late. Size the caps to the expected volume.
6. **The app's own rate limits** (§2 #4). They are deliberately generous for real users and can be tuned in `platform_settings` without a release.

## 6. Paid services and spending controls

**Supabase:** plan, compute, database size, egress, Storage, Edge Function calls, Auth users, PITR add-on.
- **Risks:** compute and egress growth; Storage. Attachments are capped at 10 per request (requests themselves at 10/h) and 10 MB each.
- **Controls:**
  - in code: per-user limits; a 1,000-row cap per API response
  - **you:** billing alerts, the spend-cap decision, a usage dashboard
- **Availability impact:** with the spend cap on, hitting a quota restricts the project.

**Static host** (Cloudflare Pages / Netlify / nginx): bandwidth.
- **Risks:** low; assets are hashed and cached for a year.
- **Controls:** **you:** usage alerts on the host account.

**Moyasar / Tap:** a fee per transaction.
- **Risks:** duplicate charges.
- **Controls:** in code: one in-flight payment per booking, idempotency, reconciliation (all tested). **You:** contract fees.
- **Availability impact:** none.

**Resend** (email), **Unifonic** (SMS), **WhatsApp Cloud**: charged per message.
- **Risks:** an event storm or bug sending thousands of messages; duplicate sends.
- **Controls:**
  - in code: channels off by default; daily caps per channel; duplicate-send fix
  - **you:** provider-side spend limits or prepaid credit
- **Availability impact:** over-cap messages are delayed.

**Error collector** (Sentry / Datadog): billed by event volume.
- **Risks:** error floods.
- **Controls:** in code: at most 25 events per page and one per error per minute. **You:** spike protection or quota in the collector.
- **Availability impact:** none.

**AI APIs:** none are used, so there's no AI spend or abuse risk.

## 7. What you need to do (needs your permission, credentials or manual action)

1. **Supabase dashboard:**
   - Set the Auth password minimum to 8 with letters and digits.
   - Set the email resend interval to 60 s.
   - Configure your own SMTP server.
   - Review the per-IP sign-in limits (§5.1).
   - Enable leaked-password protection.
   - Enable PITR.
   - Set billing alerts and decide the spend-cap setting.
2. **Background jobs:** run the SQL in `docs/operations/background-jobs.md` on the hosted project. It schedules the dispatcher and payment reconciliation.
3. **Error collector:** create a Sentry or Datadog project and set `VITE_ERROR_REPORTING_URL` (browser) and the `ERROR_REPORTING_URL` secret (edge functions). Turn on its new-issue and spike alerts.
4. **Uptime monitor:** poll `system_diagnostics()` with the service role every 5 minutes and alert when `healthy` is false. Also poll `/build-info.json`.
5. **Release configuration:** set `GM_PRODUCTION_PROJECT_REF` in CI and on the build host. Set `VITE_PRODUCTION_PROJECT_REF` in developers' `.env.local`. Use `npm run build:release`.
6. **Storage backup:** schedule a daily copy of `material-attachments` and test a restore.
7. **CAPTCHA:** create a Turnstile or hCaptcha account if you want bot protection on sign-up and password reset.
8. **Before launch:** run the hosted restore test into a scratch project, plus a staging load test.

## 8. Final production-readiness assessment

**Ready in code:** the application code and database for this branch are ready to support 1,000+ users with good integrity, in these areas:
- data integrity under concurrency
- duplicate-payment protection
- abuse limits
- background-job reliability
- spending guards
- rollback and restore procedures
- query performance

The evidence is in §3 and §4: every check above was run and passed.

**Not ready to launch yet.** It isn't proven on the hosted platform. The remaining blockers aren't code, and all are listed in §7:
- hosted configuration (Auth limits, SMTP, PITR, job scheduling)
- an error collector and an uptime monitor
- a compute size chosen and confirmed by a staging load test
- the hosted restore test
- live payment-provider onboarding (still sandbox only, pending ATCO)

**Conclusion:** I am not claiming the live application is ready for 1,000 users. That claim needs the staging load test and the hosted checks in §7.
