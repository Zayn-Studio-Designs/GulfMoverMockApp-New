# Launch-readiness matrix (Phase 10, 2026-10-28)

Scope: engineering readiness for a *controlled* launch (staging + supervised
pilot). This is not production approval. Commercial, legal, and hosting
decisions in `atco-decisions-required.md` are excluded from the percentage —
they are gates, not code.

Method: each area is scored 0–100 on implemented × verified (unit / source /
browser / local-DB evidence). Weights reflect launch criticality. The headline
number is the weighted mean, rounded. Verification evidence:
`phase10-verification-results.md`; baseline: `phase10-baseline.md`; RPC
analysis: `security-rpc-matrix.md`.

| Area | Status | Score | Wt | Evidence / remaining work |
|---|---|---|---|---|
| Auth & sessions (signup, confirmation, recovery, suspend/revoke) | Implemented, verified | 85 | 3 | Phase 6 local-DB + browser journeys; remaining: hosted leaked-pw toggle, MFA enforcement, real-infra session timing |
| Company registration, approvals, invitations | Implemented, verified | 85 | 2 | RPC + idempotency + isolation tests (local stack, Phase 6/7); remaining: ATCO policy D10 |
| Booking lifecycle (create/amend/cancel/reschedule/holds/idempotency) | Implemented, verified | 80 | 3 | Server-priced, state-guarded RPCs; browser journeys; remaining: re-run on stack, customer refund-entry UX is staff-only by design |
| Tickets, readiness, boarding | Implemented, verified | 80 | 3 | Ticket-per-passenger-per-leg, QR secrecy, gate fails closed, 8-way concurrency (Phase 6); remaining: real-device camera |
| Materials & charters | Implemented, partially verified | 70 | 1 | Safety-review enforcement + browser flows; remaining: tariffs/permits D9 |
| Payments (sandbox architecture) | Implemented, partially verified | 60 | 2 | Adapter/handler unit tests, kill-switch, source invariants (`paymentSafety.test.ts`); live disabled; remaining: provider staging D13 |
| Credit, settlements, invoices | Implemented, partially verified | 65 | 1 | Zero-by-default rules, four-eyes, audit trails; remaining: commercial approvals D3–D5 |
| Reports & exports | Implemented, partially verified | 70 | 1 | DB-backed reports, CSV; remaining: stack re-run, PDF where required |
| Notifications | Partially connected | 50 | 1 | In-app verified; outbox + adapters unit-tested; external delivery unconfigured D14 |
| Corporate / operations / fleet routes | Implemented, newly connected | 65 | 2 | Reuse existing guarded components; unit + source tests new; signed-out production-mode browser pass 82/82 (Phase 10.2, auth gate verified); remaining: signed-in staff/customer browser pass against isolated test backend |
| Security hardening (RPC/RLS/grants/secrets) | Implemented, verified at source + disposable-DB catalog | 80 | 3 | Matrix + `_`-revoke migration + grant tests + Phase 10.3 real-PG proof (3 helpers f/f/f for anon/authenticated/public; server paths pass); remaining: CI clean-install, upgrade/drill, hosted advisor re-check |
| i18n / RTL / UX / responsive | Implemented, verified | 80 | 1 | Full EN/AR, RTL browser-checked (Phase 9.3); remaining: devices, a11y audit |
| Release & operability (env checks, docs, backup, CI) | Partially implemented | 65 | 1 | `check-env.mjs` + drill scripts; remaining: CI run, hosted backup/PITR proof D12/D16 |

Weighted mean: (85·3 + 85·2 + 80·3 + 80·3 + 70 + 60·2 + 65 + 70 + 50 + 65·2 + 80·3 + 80 + 65) = 1795 / 24 ≈ **74.8%**.

Headline: **~75% engineering readiness for controlled launch** (Phase 10.2;
was ~75% on the same corrected denominator — the earlier “76% / 25” was an
arithmetic error: weights sum to 24, not 25, and 1795/25 = 71.8%, not 74%).
No category score was changed to hit a target; only the denominator and the
rounded headline were corrected.
Implemented-vs-verified split: everything above counts implementation +
source/browser-fake verification; only the auth/booking/ticket/boarding rows
rest on prior local-stack evidence, and the two skipped catalog tests plus
the unapplied migration keep the security row from scoring higher.
What the number excludes: every D-item (tariff/VAT/refunds/commissions/
credit/schedule/permits/staff-provisioning/hosting/payments-live/notifications-live)
and any claim of production approval, compliance, or device verification.
The cheapest path upward is not more code but decisions D1, D6, D10, D12–D14
plus a stack-backed test re-run.
