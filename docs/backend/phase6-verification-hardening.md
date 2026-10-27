# Phase 6 — Independent verification, security audit and hardening

Branch `feature/phase6-verification-hardening`, based on the Phase 5 checkpoint
`de08e5d68faf0c91a9c2bfbbd4b3266c76e41345` (`feature/phase5-remaining-operations`).

This phase added **no product features**. It exists to answer one question honestly: which parts of
Gulf Mover are actually working, secure and verified, and which are still assumptions. Everything
below was produced by inspecting the implementation and **running it against a real local
PostgreSQL/PostgREST stack**. Nothing here is a restatement of an earlier report.

Environment: macOS, Node v26.7.0, local native Supabase CLI stack on loopback only
(`supabase db query` instead of `psql`, `GM_IT_SQL_DRIVER=supabase`). **No hosted project was
contacted and no hosted data was changed.** All accounts, sailings, bookings, requests and tickets
used are fictional (`*@example.test`).

---

## 1. Reproducing this verification

```bash
# 1. Local stack + variables printed by the CLI (never committed)
supabase start && supabase status -o env

# 2. Unit / component suite (integration files skip without stack variables)
npm run typecheck && npm test && npm run build && git diff --check

# 3. Database suites against the local stack
GM_IT_SUPABASE_URL=... GM_IT_ANON_KEY=... GM_IT_SERVICE_KEY=... \
GM_IT_DB_URL=... GM_IT_MAILPIT_URL=... GM_IT_SQL_DRIVER=supabase \
  npm run test:integration

# 4. Browser journeys (app in production mode against that stack)
VITE_APP_MODE=production VITE_SUPABASE_URL=... VITE_SUPABASE_ANON_KEY=... \
VITE_AUTH_RESET_REDIRECT_URL=http://127.0.0.1:5173/auth/reset-callback \
  npx vite --host 127.0.0.1 --port 5173 --strictPort
GM_IT_SQL_DRIVER=supabase GM_E2E_APP_URL=http://127.0.0.1:5173 npm run test:e2e:local
```

The QR image suite additionally takes a decoder from the machine running it (see §6):

```bash
GM_QR_DECODER='swift scripts/qr/decode.swift' npm run test:integration
```

---

## 2. Baseline results (all commands actually run)

| Command | Exit | Result |
|---|---:|---|
| `npm run typecheck` | 0 | no errors |
| `npm test` | 0 | **375 passed**, 70 integration tests skipped without stack variables (21 files passed, 6 skipped) |
| `npm run build` | 0 | `main` JS 648.03 kB / 181.11 kB gzip; the pre-existing >500 kB chunk warning only |
| `git diff --check` | 0 | no whitespace errors |
| `npm run test:integration` with local variables | 0 | **70/70**, 6 files (24 auth/approval/booking + 9 Phase 4 + 9 Phase 5 + 20 Phase 6 security + 3 QR image + 5 upgrade) |
| `npm run test:e2e:local` with local variables | 0 | **52/52** real Chromium + local Supabase checks |
| Migration chain from zero | 0 | `supabase db reset --db-url … --version 20261027121000` then `supabase migration up --db-url …` applied all 17 migrations cleanly (§5) |
| `npm run test:e2e:local` again, on the upgraded database | 0 | **52/52** |

One real defect was found in this phase's *own* first draft (an unused test fixture variable, a
`tsc` error) and fixed before the baseline above.

---

## 3. Feature verification (A–J from the brief)

Legend: **DB** = exercised against real local PostgreSQL/PostgREST · **Unit** = mocked/component
test · **Browser** = real Chromium journey · **—** = not verified.

| Area | What was actually checked | Evidence | Result |
|---|---|---|---|
| **A. Auth & account security** | Sign-up requires e-mail confirmation before a session exists; wrong password refused; sign-out ends the session; recovery link opens `/auth/reset-callback` with a recovery session and sets a new password; a used/expired link shows no password form; suspended/revoked staff lose privileges with a still-valid JWT | DB (`localSupabase`, `phase4`) + Browser | Pass |
| **B. Company registration & ATCO approval** | Registration via the real `register_company` RPC, idempotent retries, `payload_mismatch` on a changed payload, pending→approved/rejected with reason, exactly one audit event per decision, **concurrent approvals produce exactly one event**, ordinary users and company admins cannot approve (not even their own), conflict-of-interest blocked, suspended/missing-profile reviewers refused | DB + Browser | Pass |
| **C. Members & invitations** | Only own-company admins invite; role is never caller-supplied; recipient identity bound to the confirmed e-mail; direct membership writes refused for insert/update/delete; **4 concurrent acceptances collapse to one membership and one `accepted` event**; revoked members lose access immediately; cancellation/expiry refused; an invitation cannot be accepted after the inviter loses authority; nobody can promote themselves or another user to staff | DB (Phase 5 + Phase 6 suites) + Browser | Pass |
| **D. Booking** | Real routes/vessels/sailings from the database; server reference `GM-########` returned and persisted; reload + re-sign-in keep the record; cross-company and cross-user reads refused; invalid input and closed sailings refused; retries idempotent; **capacity 5 with 10 parallel one-seat requests → exactly 5 succeed**; a suspended org cannot book | DB + Browser | Pass |
| **E. Tickets & QR validation** | One ticket per passenger per one-way leg (2 passengers × 2 legs = 4); issuance idempotent; tickets persist across reload; only the booking creator reads tickets or the QR; `qr_token` is not selectable; forged/tampered/unknown payloads refused **by the server**; the demo payload format is not a boarding credential; boarded status visible after reload | DB + Browser | Pass |
| **E. Legacy backfill** | Genuine Phase 4 database (10 migrations) + a reservation created through the real `create_booking` RPC, then the remaining 7 migrations applied: 4 tickets issued (2 per leg), all well-formed, pre-existing legs and seat counts unchanged, owner QR and ticket reads working afterwards. Also a repeatable in-suite test that runs the migration's own backfill statement twice (idempotent) and checks a NULL name is never invented | DB (2 independent ways) | Pass |
| **F. Boarding & sailing readiness** | Staff-only manifests and boarding; wrong sailing refused; booking refused until an internal `ready` decision is recorded; blocked/cancelled sailings and cancelled tickets refused; **8 simultaneous scans of one single-use ticket → exactly 1 `boarded`, 7 `already_boarded`, 1 audit row**; failed attempts write no `boarding_events` row | DB + Browser | Pass |
| **G. Materials-transfer requests** | Persist with a server reference and status; company-scoped reads; unrelated companies cannot read or review; only ATCO staff review; retry-safe and boundary-validated; the customer sees "Reviewed for planning — not confirmed", never an approval; decision survives reload | DB + Browser | Pass |
| **H. Charter requests** | Same lifecycle, same scoping; statuses and review events persist; nothing renders as a confirmed charter, allocated vessel or agreed price | DB + Browser | Pass |
| **I. In-app notifications** | Created by real successful events only (reservation created, tickets issued); owner-only reads; mark-read cannot touch another user's row; read state persists after reload; deduplicated per event key | DB + Browser | Pass |
| **J. Camera QR scanning** | Camera-permission denial and `BarcodeDetector` absence both surface the manual-entry fallback while manual validation stays usable; camera tracks released on unmount. **A rendered QR image was decoded by an independent decoder (§6)** | Unit + Browser + image decode | Pass, with limits (§8) |
| **Demo/offline mode** | Demo data, reset action and demo QR scheme remain separate from production records; production mode never silently falls back to demo data | Unit + Browser | Pass |

---

## 4. Security review (directly exercised, not inferred from React)

Actors exercised through the API: anon · ordinary authenticated · Company A member · Company A
booker · Company B member · ATCO operations · ATCO super_admin · suspended staff/member.

Catalog facts re-measured on the migrated database:

| Check | Measured |
|---|---|
| Public tables in the exposed schema | 19 — **0 without RLS** |
| Public functions executable by `anon` | **0** |
| Public functions executable by `PUBLIC` | **0** |
| `SECURITY DEFINER` functions / without a pinned `search_path` | 32 / **0** |
| Views in the exposed schema | **0** (nothing can leak PII through a view) |
| Trigger functions still carrying the default `PUBLIC` grant | **0** |
| Direct write grants for `authenticated` on business tables | **none** (RPCs own every write) |

Two genuine least-privilege defects were found and fixed in **one additive migration**
(`supabase/migrations/20261030100000_revoke_trigger_function_execute.sql`), with regression tests in
`src/tests/integration/phase6.security.integration.test.ts`:

1. **Five trigger functions kept PostgreSQL's default `EXECUTE` grant to `PUBLIC`**
   (`guard_organizations_insert_by_user`, `guard_role_hierarchy`,
   `log_organization_status_changes`, `set_updated_at`, `stamp_organization_approval_metadata`).
   They return `trigger`, so PostgreSQL refuses to run them outside a trigger context and PostgREST
   does not expose them (`PGRST202`) — **this was not exploitable**, but it was inconsistent with
   every later trigger function and is now revoked for all roles.
2. **Four organisation-membership write policies were left behind with no grant.** Phase 5 revoked
   `INSERT/UPDATE/DELETE` on `organization_memberships` from `authenticated` (invitations must go
   through the audited, consent-based RPCs), so the policies were inert — but re-adding a grant
   later would have silently reopened a path that bypasses invitation consent and the membership
   audit trail. They are dropped; membership writes happen only inside `SECURITY DEFINER` RPCs.

No defect was found in the areas the brief called out as highest risk: no user-supplied actor or
organisation ID is trusted (every write RPC derives the actor from `auth.uid()` and re-checks
membership/role under a lock), no cross-company read succeeded anywhere, and no credential or
personal data is logged (the only three `console` calls in `src/` print a storage key and a React
error stack, never user data or tokens).

**Migrations were added, never edited.** `supabase/migrations/` history is append-only; no previously
applied migration was modified to conceal schema history.

---

## 5. The upgrade path, verified for real

`supabase db reset` proves the chain applies to an empty database; it does not prove that a database
**already holding reservations** upgrades cleanly. Both were done:

1. `supabase db reset --db-url … --version 20261027121000` → a genuine Phase 4 database
   (10 migrations, `bookings` present, no `tickets` table).
2. A real reservation created against it through the **shipped RPCs** (`register_company` →
   `review_company` by a *different* administrator, correctly refused for the owner with
   `conflict_of_interest` → `create_booking` with an outbound and a return sailing).
3. `supabase migration up --db-url …` applied the remaining 7 migrations.
4. Result: 4 backfilled tickets (2 outbound + 2 return), all with `TK-…` references, 64-hex QR
   secrets and `valid` status; the pre-existing booking kept its 2 legs and 2 held seats; the owner
   could read the tickets and retrieve a QR afterwards; the full 70-test integration suite and all
   52 browser checks then passed against that upgraded database.

The repeatable in-suite version of this (`phase6.upgrade.integration.test.ts`) runs the migration's
**own** backfill statement (read from the file, not copied) three times in a row and asserts it is
idempotent and never invents a passenger name.

---

## 6. The QR image gap, closed

Earlier phases proved the boarding *rules* but never that a rendered QR image can be read back —
they only asserted that `BarcodeDetector` existed or returned a mocked value. That gap is closed:

`src/tests/integration/phase6.qr-decode.integration.test.ts` takes the **real** server-only secret
from `get_ticket_qr`, renders it with the **same encoder the ticket screen uses** (`qrcode.react`
4.2.0 `QRCodeSVG`, in a real Chromium page), screenshots the SVG element to a real PNG, and decodes
that PNG with an **independent, third-party decoder** — Apple's Vision framework via
`scripts/qr/decode.swift` (`VNDetectBarcodesRequest`), the same detector iOS uses. It then:

- asserts the decoded payload equals the server secret **exactly**, and that the image encodes
  nothing else (no passenger name, booking reference, e-mail or database id);
- boards using **the value that came out of the image**, and confirms it boards exactly once;
- confirms a one-character tamper of a real secret — well-formed enough to reach the server — is
  refused with `not_found`, and that malformed values never leave the client.

Verified output: `encoder=qrcode.react@4.2.0`, decode returns `GMT1:<64 hex>`, boarding `boarded`
then `already_boarded`.

**Chromium's own `BarcodeDetector` is absent in every configuration available here** — the bundled
Playwright Chromium and the installed Google Chrome, headless and headed, including with
`--enable-experimental-web-platform-features`. That is why the decoder is supplied from the machine
(`GM_QR_DECODER`) and why the image assertions **skip with an explicit reason** rather than passing
silently when no decoder is present. `scripts/qr/decode.swift` is optional and macOS-only; any
`cmd <png>` decoder such as `zbarimg -q --raw` works.

Also worth stating plainly: the **demo-mode QR** (`GM-VERIFY-1|GMTK-…`, rendered by
`QRCodeTicket` in the offline demo views) is *not* a boarding credential. Feeding it to
`board_ticket` returns `not_found` — verified — because a client-side format is never treated as
authority. The production ticket screen uses the server secret only.

---

## 7. Defects fixed in this phase

| # | Defect | Severity | Fix |
|---|---|---|---|
| 1 | Five trigger functions carried the default `PUBLIC` `EXECUTE` grant (least-privilege gap; not exploitable) | Low | Additive migration `20261030100000` + catalog regression test |
| 2 | Four membership write policies left inert with no grant behind them (future re-grant risk) | Low | Same migration drops the dead policies |
| 3 | First draft of the Phase 6 security suite had an unused fixture variable (`tsc` error) | n/a (own draft) | Fixed before the baseline; `typecheck` clean |

No defect was found in authentication, approvals, invitations, bookings, tickets, boarding,
requests or notifications: every behaviour those claims rest on was reproduced against the real
database, and the earlier phases' claims held up under independent re-testing.

---

## 8. What is **not** verified — stated plainly

- **Hosted Supabase: never contacted.** Everything here describes the local stack. Production
  hosting, its RLS state, its keys and its upgrade behaviour are unverified.
- **No payment, invoice, refund or VAT behaviour exists** to test, and none was added: those need
  confirmed ATCO rules and a separately reviewed payment design.
- **Physical devices and Safari: untested.** No real phone, no camera, no iOS/Android browser was
  used. Camera *permission* paths were driven with a browser-level stub; a real camera stream on a
  device is **not** verified. Device-level scanning may behave differently from the desktop image
  decode in §6.
- **Screen readers and a native Arabic-speaker review: not performed.** Arabic is verified
  structurally (all visible keys translated, `dir=rtl`, no horizontal overflow at 390 px on the
  materials, charters, members, notifications, bookings, ticket and boarding screens), not by a
  human.
- **Real e-mail delivery is untested** — Mailpit only. Invitations deliberately send no e-mail and
  say so in the UI.
- **Scale and performance are untested.** Concurrency was driven at 4–10 parallel requests in one
  suite; that is a correctness check, not a load test. No rate limiting or abuse protection was
  verified.
- **Higher-fan-out concurrency** (well beyond 8–10 simultaneous writers) and long-running soak
  behaviour remain unmeasured.
- The local stack used here has **no Docker and no `psql`**, so migration files were applied through
  the Supabase CLI (`db reset --db-url`, `migration up --db-url`). A `psql`-based pipeline may
  behave identically but was not the path exercised.

---

## 9. Local artifact hygiene

- `phase4-dev.log`, `phase5-*.log`, `phase5-local.json` and `phase6-stack-start.log` were confirmed
  to be disposable generated runtime artifacts, removed from the working tree, and are **not** in the
  working tree now. `.gitignore` now ignores `*.log` and `*-local.json` so they cannot be committed
  by accident.
- `git log --all --diff-filter=A --name-only` was searched for any added `.log`, `-local.json`,
  `.env` or secret-bearing file: **the only match is the migration named
  `20261026190000_revoke_register_company_service_role.sql`.** No credential, local key or runtime
  log has ever been committed on any branch, so **no key rotation is indicated**.
- Only `.env.example` is tracked, and it contains placeholders and rules, no values.

---

## 10. Honest completion estimate

Counted at the level the evidence supports, **feature by feature**. "Verified" means reproduced
against the real local database and/or a real browser in this phase.

| Area | Implemented | Independently verified | Notes |
|---|---|---|---|
| Auth, sessions, recovery | Yes | **Yes** | Local stack only |
| Company registration + ATCO approval | Yes | **Yes** | Concurrent approvals covered |
| Members, invitations, revocation | Yes | **Yes** | Concurrent acceptance covered |
| Roles & database-enforced permissions | Yes | **Yes** | RLS + definer RPCs, exercised as 8 actors |
| Sailings / schedule | Yes | **Yes** | |
| Bookings (outbound + return) | Yes | **Yes** | Capacity race covered |
| Tickets + QR | Yes | **Yes** | Real image decode included |
| Boarding + readiness | Yes | **Yes** | Single-use under 8-way concurrency |
| Materials-transfer requests | Yes | **Yes** | |
| Charter requests | Yes | **Yes** | |
| In-app notifications | Yes | **Yes** | |
| English/Arabic + RTL | Yes | **Yes** (structurally) | No native-speaker review |
| Offline demo mode | Yes | **Yes** | Kept separate from production records |
| Payments / invoices / refunds / VAT | **No** | — | Awaiting ATCO rules; deliberately not built |
| Hosted staging / production deployment | **No** | — | Out of scope here |
| Real-device camera scanning, Safari | Partly | **No** | Desktop image decode only |
| Load, soak, abuse/rate limiting | No | **No** | |
| Support/runbook, monitoring, backup/DR | Partly (docs) | Not exercised | |

**Estimate for the mock/ATCO-demo scope: ~76%.** This is a small increase over the Phase 5 figure of
~74%, and deliberately so: this phase added **verification and two low-severity hardening fixes, not
features**. What changed is confidence — the great majority of previously *claimed* behaviour is now
independently reproduced — not scope.

**Estimate for a production launch: still low (~35–40%).** The remaining distance is not more
screens: it is payments and tariffs, hosted infrastructure with its own security review, real
e-mail/SMS, device testing, ATCO's unresolved business rules, and operations/support readiness. A
passing test suite is not a production readiness claim, and this document should not be read as one.

---

## 11. What ATCO still has to confirm

Unchanged from `docs/atco-pending-business-rules.md`; nothing here implies ATCO approval. The items
that most directly block the next milestone:

- Tariff, VAT treatment and the minimum-sailing rule as binding policy (it is implemented as a
  **warning only**; no automatic cancellation exists).
- Cancellation, refund, rebooking and no-show rules — none are implemented, and the UI promises
  nothing.
- Permits, port/berth access and who may record operational readiness; whether readiness should ever
  be machine-readable as a legal clearance (today it is explicitly internal tracking only).
- Which partner types (agents/resellers, external boat operators, materials suppliers) get
  workspaces, and their permitted fields.
- Confirmed vessel names, capacities, load limits and destinations — the app uses placeholders.
- The invitation expiry window (currently a provisional 7-day technical safety default) and
  whether invitations should send e-mail.

## 12. Next major work before launch

1. Confirm the ATCO business rules above; encode the tariff and payment design behind a separate
   reviewed plan (no payment code exists today).
2. Stand up **hosted staging** with its own independent security review, secret handling and
   migration rehearsal on a copy of real-shaped data.
3. Device and browser matrix: real iOS/Android camera scanning, Safari, and a native Arabic review.
4. Load and abuse testing, rate limiting, monitoring and alerting, backup/restore rehearsal.
5. Operational runbook and support handover, then a staged pilot with fictional accounts.
