# Phase 11 — signed-in role-isolation browser journeys (stubbed backend)

Branch: `feature/phase11-signed-in-route-journeys` (based on Phase 10.5 tip `503505a`).
Script: `scripts/e2e/phase11-signed-in-routes.mjs` (`npm run test:e2e:signed-in`).
Hosted `GulfMover-Demo` untouched. No live payments, no notifications sent.

## What this proves (and what it does not)

Real Chromium against the production build with per-persona stubbed backends
(Playwright route interception; fictional data only). Each persona gets its own
browser context, session, and RLS-simulating fixtures: the stub returns only
the rows that persona would be allowed to see. This proves **isolated UI
behaviour**: correct routing, guards, role-specific content, translation/RTL,
and that consequential actions travel through the server API.

It does NOT prove real database authorization — the stub *simulates* RLS by
construction. That evidence stands on `src/tests/db/**` against real
PostgreSQL (including the Phase 10.3 catalog proof and the green Phase 10.5 CI
database job) plus the MemoryRouter + fake-Supabase component tests.

## Result: 60/60 checks passed

Personas: Company-A booker, Company-A admin (+Company-B booker), Company-B
booker, customer with no company, pending-company member, operations staff.

- Booker sees own booking ref, never the other company's; admin-only notice shown, admin report hidden.
- Admin sees "Company account" report, both companies, own booking; never the other booker's ref.
- Cross-company mirror check passes both directions.
- No-company customer gets registration guidance + registration link (never blank).
- Pending member gets under-review guidance; the workspace card itself invites no new registration.
- Staff account on /corporate is directed to ATCO tooling, never company booking.
- Customer refused at /operations and /fleet (canonical aliases, no control actions).
- Ops staff gets "Vessels and sailings" + "Sailing control"; manifest read path renders the empty-manifest truth.
- Write path proven server-side: add-vessel POSTs `/rest/v1/vessels` with the entered name and reports "Saved." (no local-only state).
- EN + AR (RTL, translated admin notice/staff screens), desktop + phone, no raw translation keys, no demo fallback, clean console on every page.

## Incidents during development (fixed, kept as regression notes)

1. POST RPCs were swallowed by the generic table-write branch and answered
   `'ok'`, so `my_company_memberships` parsed as "no companies" for every
   persona. Fixed by routing RPCs to fixtures before the write branch (calls
   still recorded). Lesson: any future stub must treat `/rpc/*` as POST reads.
2. `toRoute()` throws without an embedded route `id` (real PostgREST embeds
   carry one). Fixture embeds now include `id`/`status`.
3. Presence checks settled on empty states before async loads finished; the
   script now waits for content-or-empty markers per scenario.
4. The staff nav also links "Company account", so the admin-report absence
   check keys on the report subtitle instead of the shared title.

## Remaining for the routes row

Signed-in journeys against a real backend (isolated test project or local
stack) — still blocked: no Docker here, hosted project off-limits for
mutation. The component tests + DB suites + these UI journeys are the
current evidence stack.
