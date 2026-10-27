# Gulf Mover Mock App — Test Results

Only commands that were actually run are listed.

## Run of 17 October 2026 (branch `feature/match-bilingual-prototype`)
Environment: Linux, Node v22.22.0, dependencies installed with `npm install --legacy-peer-deps` in a clean copy of the repo (the committed `node_modules/` is macOS-only).

| Command | Result |
|---|---|
| `npx tsc --noEmit` | Pass — 0 errors |
| `npx vitest run` | Pass — 3 files, 26 tests |
| `npx vite build` | Pass — JS 267 kB (84 kB gzip), CSS 20 kB |

Test coverage (`src/tests/`):
- `rules.test.ts` — SAR 500 × passengers × legs; return leg = second one-way leg; four-ticket minimum aggregated across bookings; status tone.
- `i18n.test.ts` — every English key has an Arabic value in Arabic script; placeholders/statuses translate; booking references stay intact.
- `app.test.tsx` — sidebar navigation to all six views; unknown route fallback; Arabic toggle translates and sets `dir="rtl"`, English restores LTR; state survives a language switch; full booking flow with return leg (SAR 2,000 for 2 passengers), separate payment / minimum / operations / boarding statuses; duplicate QR scan rejected; material decision requires a reason; reset demo data.

## Browser check (headless Chromium against `npm run dev`)
- All six views render at 1366 px, 770 px and 390 px with no horizontal page overflow and no console errors.
- Arabic: heading, navigation and data placeholders translated; `dir="rtl"`; layout mirrored.
- Visual comparison against the reference prototype `gulf_mover_ui_prototype_bilingual.html` and the collaborator's screenshots: layout, colours, components and copy match.

## Not tested
- Real devices, screen readers, and a native Arabic-speaker review of the translations.

## Verification — 2026-10-18 (branch `feature/match-bilingual-prototype`, commit 90a4626)

Fresh clone of the branch on Linux, Node 22.22.0 / npm 10.9.4.

| Check | Command / method | Result |
|---|---|---|
| Clean install | `npm ci` | OK (164 packages). Engine warnings: jsdom wants Node ≥ 22.22.2. `npm audit`: 6 issues in dev/test tooling (esbuild dev server, vitest/tinypool); fixes need breaking upgrades — not applied. |
| Type check | `npm run typecheck` | 0 errors |
| Tests | `npm test` | 4 files, 41/41 passed |
| Production build | `npm run build` | OK — JS 325.6 kB (100.6 kB gzip), CSS 33.4 kB |
| Dev server | `npm run dev` | `http://localhost:3000/` — 200, deep link `/fleet` 200 |
| Production preview | `npm run preview` | `http://localhost:4173/` — 200, deep link `/fleet` 200 |

Browser checks (Chromium via Playwright against the dev server; desktop 1366×900 and iPhone 14):
- Signed-out visitor redirected to sign-in; sign-up works and returns to the requested page; password not stored in plain text; session survives refresh.
- EN ↔ AR: `dir`/`lang` switch to `rtl`/`ar` and back; heading and menu translated; sidebar moves to the right.
- Booking: City offers Dammam only; 25 departure slots, 12:00 AM–11:00 PM, AM/PM; 2 passengers + return = SAR 2,000; VAT shown as pending; separate statuses on the result; four-ticket minimum met across bookings.
- Boats: chartered boat disabled for passengers; boat with passengers cannot be chartered; new booking listed on Fleet page (in-app navigation).
- Phone: no horizontal scroll on any page, bottom navigation bar, Arabic RTL.
- No page or console errors.
- `previews/*.html` opened from disk with all network requests blocked: no external requests, no errors; sign-in → app and phone frame both work.

Not verified automatically (manual check recommended): Safari / Firefox / real phones, Windows/macOS install, profile-photo and logo upload with real images on a phone, Boarding Desk duplicate-scan and Materials review flows in the browser (covered by unit/UI tests only), every Arabic screen visually.

Known limitations: bookings and boat reservations are kept in memory and reset on page refresh; payment-step copy says "No gateway or card details are used" rather than the exact phrase "No real payment made".

## Verification — 2026-10-19 (branch `zayn/gulf-mover-working`) — ATCO Marine visual redesign

Reference research: rendered `https://www.atcogroup.com/atco-marine` in Chromium and read its computed styles. Verified facts used for the palette: CTA buttons solid green `#03643C`, accent bands `#13500A`, neutral text `#333`/`#595959`, Arial/Helvetica fonts, and the page's logo asset (`6.png`, 290×198) is the same file as `public/assets/logos/atco-marine-logo.png` — i.e. the local logo is the genuine official asset in ATCO green. Frame sizes/races of the marketing site's decorative parts were not copied; light mint `#DDEFE4` and ATCO navy `#12345A` are kept from the client-supplied palette for surfaces the marketing site does not show (active states, dark bars).

Changes made (working tree, uncommitted):
- `src/styles/index.css` — restored the committed green baseline (a prior uncommitted edit had reverted the palette to the old prototype's navy/teal/amber), then set the primary green tokens to the verified `#03643C`/`#13500A`, updated focus rings, hover shades, input focus ring, card hover shadows, and the hero gradient to the verified greens; body font stack now leads with Arial/Helvetica (verified on the reference); logo rules rewritten: `.brand-mark` is now transparent flex, `.brand-logo` is height-sized (44px desktop / 34px phone / 32px narrow phone) with `width:auto; object-fit:contain; max-width:160px`, so the 290×198 PNG can no longer overflow the 42 px tile it previously sat in with no sizing at all.
- `src/components/Brand.tsx` — cleaned the wrapper's stray `aria-label` (the `img` carries the accessible alt already); no structural change.

| Check | Command / method | Result |
|---|---|---|
| Type check | `npm run typecheck` | 0 errors |
| Tests | `npm test` | 4 files, 41/41 passed |
| Production build | `npm run build` | OK — JS 325.65 kB, CSS 33.25 kB |

DOM verification in Chromium against `npm run dev` (computing bounding boxes; PNG screenshots could not be captured this session — the preview compositor reported it produced no frames):
- Desktop 1440×900, EN: sign-in and app headers — logo 64×44 px inside the header flow, no intersection with the product tag, language toggle or avatar; no horizontal overflow; primary buttons `rgb(3,100,60)` with white text; active nav mint `#DDEFE4` with green text; hero gradient `#13500A → #03643C`; body font Arial.
- Booking flow intact in the browser: service card selected, Continue → step 2 "Journey", `SAR 500` fare shown; duplicate-scan, four-ticket and boat rules still green in the unit suite.
- Arabic RTL at 1440×900: `dir=rtl`/`lang=ar`; brand block sits right (x 1174–1412), header tag and actions on the left with disjoint boxes; nav/tab/field alignment mirrored.
- Mobile 390×844 (Arabic RTL): logo 47×32 px, no overlaps, no horizontal scroll, bottom nav 72 px tall.
- No console errors after reload.

Not verified this session: pixel screenshots (capture unavailable — see above), full page-by-page visual pass of Operations/Boarding/Materials/Fleet in both languages, real-device rendering.

## Verification — 2026-10-19 (branch `zayn/atco-green-branding-latest`, uncommitted) — customer-first UX redesign

Behaviour changes: demo work-mode switcher (Customer ↔ ATCO staff) filtering navigation only; customer home at `/` with booking wizard at `/book`; customer-card My Bookings (staff keeps the table); demo bookings/boat slots/materials/audit persisted to `localStorage` (`gm-demo-state-v1`, same-day); iPhone decluttering (hero meta chips, booking-page contacts and workspace switcher hidden, bigger targets); ~30 new EN+AR keys.

| Check | Command / method | Result |
|---|---|---|
| Type check | `npm run typecheck` | 0 errors |
| Tests | `npm test` | 4 files, 46/46 passed (5 new: customer/staff navigation, workspace persistence, customer home CTA + next trip, booking persistence across remount) |
| Production build | `npm run build` | OK — JS 192.73 kB main + 142.55 kB shared, CSS unchanged size class |

Browser verification (Chromium via the preview panel against `npm run dev`):
- Desktop 1440×900 EN: customer home (`Home` + `Book a marine transfer` CTA + next-trip card showing `GM-DEMO-0248` with payment/ops pills); customer nav = Home / Book Transfer / My Bookings / Account; workspace switch shows 7 staff destinations (`Operations`, `Boarding Desk`, …) and persists to `localStorage['gm-demo-workspace']='staff'`; account menu offers the same switch. My Bookings: customer cards with status pills + "What happens next" detail lines; staff mode restores the dense table.
- Mobile 390×844 and narrow 360×740 (EN + AR RTL): no horizontal overflow on home or booking wizard (fixed a cascade bug where the workspace switch still showed and grid `1fr` allowed content overflow — media block moved after component rules, `minmax(0,1fr)` added); 60px bottom-nav targets; 58px primary CTA; 48px selects/buttons; hero meta chips and booking-page contact block hidden; RTL mirrored with no overflow.
- Presentation previewer (`/presentation.html`): Mac 1366×800, iPhone 390×844 (island), Android 393×851 (punch-hole) all render the redesigned customer home inside the frame with no overflow; device switching keeps the live app (no reload).
- No console errors in app or presentation tabs.

Not verified: real-device rendering; Operations/Boarding/Materials/Fleet pages pixel-inspected in the new mobile layout (they retain their previous CSS); native fullscreen (harness limitation, unchanged code).

## Verification — 2026-10-19 — presentation phone-frame clipping + scrollbar fix (uncommitted)

Cause: the scrolling iframe itself carried the rounded clip while its scaled ancestor (`.pres-device`) had `filter: drop-shadow(...)` — the filter forces the iframe's composited layer, which can repaint over the bezel when the inner document scrolls. The visible scrollbar belonged to the iframe's own `html` scroller.

Changes (`src/presentation/PresentationApp.tsx`, `src/presentation/presentation.css`):
- New `.pres-viewport` wrapper owns the clipping (`overflow:hidden` + `contain:paint` + per-device radius); the iframe is `position:absolute; inset:0` inside it and carries no radius.
- Removed `filter: drop-shadow` from `.pres-device`; the shadow is now an ordinary `box-shadow` on `.pres-frame` (merged with each device's inset highlight). Mac radii/padding/viewport sizes untouched.
- On every iframe load the presentation page injects a `<style>` into the same-origin iframe document (`html{scrollbar-width:none;-ms-overflow-style:none}` + `::-webkit-scrollbar{width:0;height:0;display:none}`) — hidden scrollbar only inside the previewer; wheel/trackpad scrolling and the standalone site are unaffected.

| Check | Method | Result |
|---|---|---|
| Type check | `npm run typecheck` | 0 errors |
| Tests | `npm test` | 4 files, 46/46 passed |
| Build | `npm run build` | OK |
| iPhone 390×844 | DOM: iframe == viewport rect, contained after scroll to 0 / 600 / max 1020 / back; island in frame, z=2; `scrollbar-width:none` + webkit rule injected; scrollTop changed 0→600 | Pass |
| Android 393×851 | same containment after scroll; cam in frame, island absent; scrollTop changed 0→400 (max 985); radius 21px, even 9.3px bezel inset | Pass |
| Window sizes 1440×900, 1100×700, 900×700 | frame scales (0.93/0.70/0.71), containment holds, bezel inset scales proportionally (7.04px at 0.70), frame fits stage, no doc overflow | Pass |
| Mac mode | 1366×800 viewport, frame radius 14px/padding 12px/viewport radius 4px, no island/cam, selectors + Home + Full screen present — unchanged | Pass |
| EN / AR in frame | Arabic sets dir=rtl with translated home and no overflow; back to EN | Pass |
| Console | no errors/warnings in the presentation tab | Pass |

Not verified: pixel screenshots (preview compositor still unavailable — checks are DOM/computed-style based); actual scrollbar pixels (verified via injected rules + `scrollbar-width` computed style rather than a screenshot).

## Verification — 2026-10-20 (branch `customer-first-redesign`, uncommitted working tree) — per-ticket QR tickets, Wallet pass sheet, corporate PO, staff CSV exports, demo admin config

### What changed this session (all uncommitted)

Per-passenger, per-one-way-leg booking tickets with genuine scannable QR codes, plus the thresholds and workflows around them.

| Area | Files |
|---|---|
| Opaque ticket identity (no names or personal data in IDs or QR payloads) | `src/domain/tickets.ts` |
| Scan payload parsing + ticket index for the boarding desk | `src/domain/tickets.ts`, `src/hooks/useTicketIndex.ts` |
| Real QR rendering (SVG, `qrcode.react`) · Apple Wallet *simulation* sheet/pass visual | `src/components/QRCodeTicket.tsx`, `src/components/wallet/`, `src/styles/wallet.css` |
| Booking wizard: per-passenger names, PO reference, policy acceptance, atomic multi-leg booking, per-ticket QR result | `src/pages/BookingView.tsx`, `src/context/DemoContext.tsx` |
| My Bookings: per-leg ticket detail, wallet actions, staff bookings CSV export | `src/pages/MyBookingsView.tsx`, `src/domain/csv.ts` |
| Boarding desk: QR/manual lookup, per-ticket board/unboard, duplicate-scan prevention | `src/pages/BoardingView.tsx` |
| Operations: CSV exports (bookings/sailings), demo sailing-approval actions | `src/pages/OperationsView.tsx` |
| Fleet: demo admin config (fare / departures / capacity inputs, demo-only) | `src/pages/FleetView.tsx`, `src/domain/fleet.ts` |
| Corporate: PO reference saved onto a real demo booking record | `src/pages/CorporateView.tsx`, `src/context/DemoContext.tsx` |
| Materials & customer home placeholder polish | `src/pages/MaterialsView.tsx`, `src/pages/CustomerHome.tsx` |

### Commands actually run — 2026-10-20

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` (`npm run typecheck`) | 0 errors |
| Tests | `npm test` (vitest) | 5 files, **55/55 passed** — includes new `src/tests/features.test.tsx`: payload round-trip, one ticket per passenger per leg with name-free QR payloads, atomic multi-leg reservation (all legs or none), CSV helpers, Wallet add-pass once-flow, corporate PO saved to demo state, result step showing a scannable QR per ticket; plus updated `src/tests/app.test.tsx` boarding tests for per-ticket flows |
| Production build | `npm run build` | OK — JS 246.06 kB main + 142.55 kB shared, CSS 41.46 kB |

Bugs the new tests caught and fixed: `planReservation` previously dropped newly created boat slots from the returned state (booking success looked reserved but the slot was lost); the scan parser did not accept the QR format (`GM-VERIFY-1|GMTK-…`) the app itself generates. Both covered by `features.test.tsx`.

Not verified this session: real-device rendering; Arabic side-by-side pass of every new screen; Apple Wallet pass on a real device (technically impossible — it is a labelled simulation); server-side QR validation (out of scope for a front-end demo).

## Device Wallet presentation — 2026-10-20 (branch `feature/presentation-device-wallet`)

| Check | Command | Result |
|---|---|---|
| Type check | `npm run typecheck` | 0 errors |
| Tests | `npm test` | 6 files, **69/69 passed** (55 existing + 14 in `src/tests/presentationWallet.test.tsx`: side-button double-click vs single click, open/dismiss/reopen, add sheet confirms once and offers View when already saved, Android Google Wallet flow with no Apple wording, per-ticket QR and separate outbound/return passes from real demo data, persistence and duplicate refusal through DemoContext, device switching, untrusted messages ignored, keyboard + focus return, reduced motion, Arabic/RTL) |
| Production build | `npm run build` | OK |

Browser walkthrough (Chromium via Playwright against `npm run presentation`, `/presentation.html`, 1500×1000 and 1024×640): iPhone booking with a return leg → both tickets added through the iOS sheet; single side-button click shows only the hint; double-click slides Wallet up inside the screen (status bar turns dark); pass details show each ticket's own QR payload; Done, home bar, side-button press and Esc all close; reopen shows no duplicates; "View in Wallet" opens that pass; Arabic Wallet is RTL. Android: Quick Settings → Google Wallet, pass details, Save sheet → View; no Apple wording. Device switching closes open Wallet layers; Mac preview 1366×800 with no phone controls; passes survive a reload; reduced motion removes the animations; no console errors.

Also fixed: on the handover commit the device frame was positioned with both flex centring and a `translate(-50%, -50%)` transform, so the Mac window sat half off-screen and phones were shifted up and left (verified on the untouched commit). The device is now centred and scaled in its own area above the hint band.

Not verified: real iPhone/Android hardware; Safari and Firefox (Chromium only).

## Wallet polish, typography and Contact ATCO — 2026-10-20 (same branch)

| Check | Command | Result |
|---|---|---|
| Type check | `npm run typecheck` | 0 errors |
| Tests | `npm test` | 6 files, **70/70 passed** (Wallet tests rewritten for the new stack/carousel, add confirmation and guidance; Contact ATCO → Settings → ATCO information, also before sign-in) |
| Production build | `npm run build` | OK (bundled fonts: Inter latin variable 48 kB, IBM Plex Sans Arabic 4 × ~45 kB, Roboto 3 × ~22 kB) |

Browser walkthrough (Chromium/Playwright, `npm run presentation` and the single-file download opened from disk with network blocked): iPhone booking with a return leg; payment page at 390 × 794 in English and Arabic (summary, three choices, one disclaimer, actions pinned above the tab bar, step bar reads "Review & pay"); Add → drop animation → green "Added to Apple Wallet" → side-button guide with highlighted button; single press does not open Wallet; double-click opens the stack (3 demo cards + 2 passes); mouse-drag swipes 1→5 and back; pass shows its own QR payload; Done/close/reopen keeps 5 items. Android: Save → Saving… → Added → status-bar guide → Quick Settings → Google Wallet carousel (opens on newest pass), swipes both ways, View pass with QR, close/reopen. Contact ATCO on sign-in page (signed out), Home and Booking → Settings → ATCO information → Back; Arabic RTL. Inter / IBM Plex Sans Arabic / Roboto confirmed loaded via `document.fonts`; body/title text rgb(11,22,32), secondary rgb(59,73,85). No console errors.

Not verified: Safari/Firefox and real phones (Chromium only); real touch hardware (pointer events tested with mouse drags and synthetic pointer events in jsdom).


## Branch 0-2: stability batch 1 (22 October 2026, based on 0-1 @ cffb33b)

Baseline before changes: typecheck pass, 89/89 tests, build pass.

| Check | Result |
|---|---|
| `npm run typecheck` | Pass (exit 0) |
| `npm test` | Pass: 10 files, **101 tests**, of which 12 are new in `src/tests/stability.test.tsx` |
| `npm run build` | Pass |
| `npm audit --omit=dev` | 0 vulnerabilities |

**Regression tests reproduced each bug first.** Run against the unchanged 0-1 code, 8 of the new tests failed. The two crash-recovery tests need the new component, so they could not run against the old code. After the fixes all 12 pass.

**Browser checks** (Chromium/Playwright against `npm run dev`, all passed):
- Help/tour button: hidden on the signed-out ATCO page, shown after sign-in.
- Tour, at 1280 px and 393 px: tapping the highlighted "Book a marine transfer" button stays on the Book page, and the tour can still be finished.
- CSV export: a PO typed as `=HYPERLINK(...)` is exported as `'=HYPERLINK(...)`, and normal rows are unchanged.
- Damaged browser data (accounts `{}`, tour list `"oops"`, bookings `[null]`): the app starts, the guest can sign in, My Bookings shows the sample data, and copies of the damaged originals are kept.
- Boarding Desk camera, using Chromium's fake camera with a deliberately slow permission prompt: after Start → Stop → Start only one stream is live, and after Stop none are.
- No uncaught page errors.
- Simulated Google and Apple sign-in still reach Home.
- Apple and Google Wallet flows end to end in the presentation, waiting for the boot animation: passed.
- Tour inside the iPhone frame: passed.

**Page sweep:** 440 checks covering every page, booking step, settings tab and tour step, at 5 widths, in English and Arabic.
- No JavaScript errors and no sideways page scroll.
- One existing 0-1 issue was flagged, unrelated to this batch: on phones up to 393 px wide the header subtitle "Marine transfers · Ras Tanura" is cut off with "…". This is left for batch 2.

**Not verified:**
- The whole-app crash screen could not be triggered in a real browser without adding test-only code. It is covered by the unit test.
- Safari, Firefox and real phones were not tested.

## Branch 0-2: presentation and dark-mode fixes (22 October 2026)

**Downloaded presentation showed the computer's folders.**
- *Cause:* **Home** (which replays the boot) tried to move the app frame to `/`. In a presentation opened from a file, `/` is the root of the disk, so after the boot screen the device showed local folders. The download wrapper's own Home interception relied on an older button label, so it no longer applied.
- *Fix:* Home now sends a `gm-host:home` message, and the app returns to its start screen through its own router. The frame is never pointed at `/` when running from a file. The download wrapper also puts the app back if the frame ever leaves it.
- *Boot sound:* now embedded in the downloaded presentation; previously it was silent.

**Dark-mode issues.**
- *Boot logo:* the light plate behind it was wider than the progress ring and stuck out. It is now a disc inside the ring. The header logo gets a small light plate so it can be read on the dark header.
- *Backgrounds:* hard-coded white and pale-green backgrounds now use theme tokens. Their light-mode values are identical.
- *Overrides added:* tour title, active navigation and settings tab, the Customer/staff switch, links, step ticks, the selected materials row (previously an inline style), the booking-reference label, notification toggles and the toolbar size badge.

**Light-mode boot:** measured at about 5.2 s from start to hand-over in every combination of OS light/dark and app Light/Dark/System preference. No light-only failure was reproduced. The confirmed failure was the Home path above, which happened in both themes.

| Check | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm test` | Pass: 10 files, **103 tests** (adds Home → `gm-host:home` and the app-side router check) |
| `npm run build` | Pass |
| Dark contrast scan: every page, booking step, settings tab and tour step; 1280 px and 393 px; English and Arabic (176 screens) | **0 low-contrast text items**, 0 JavaScript errors. Remaining light surfaces are intentional: the logo plate and Apple's white sign-in button. Before the fix, about 400 items were flagged. |
| Light-mode regression: computed colours of every element, previous commit compared with this one, 40 screens and states | Identical. The single difference is a hover shadow caused by the mouse position. |
| Downloaded presentation opened from disk, light and dark | 20/20 checks pass. First boot and every device boot land in the app. Home pressed 3 times returns to the app's Home screen. A frame forced to `/` is put back on the app. The embedded boot sound plays. No errors. |
| Presentation on localhost | Home returns the app to its Home screen. Apple and Google Wallet flows were re-run earlier on this branch. |

**Not verified:**
- Windows Chrome and Edge, Safari and Firefox. Tests ran in Chromium on Linux.
- Whether your machine shows a separate light-mode boot problem. If it does, a screenshot would let us pin it down.

## Registration RPC behaviour tests (T1–T7) — 26 October 2026 (branch `backend/phase1`)

### Scope and method

- **Database:** the *local* Supabase stack only. No remote project was linked, connected or written at any point. The database was never reset.
- **Migrations applied before testing:** `20261026180000_register_company_rpc.sql`, `20261026190000_revoke_register_company_service_role.sql`, and (after T1's first failure — see below) the append-only fix `20261026191000_fix_register_company_profile_conflict.sql`.
- **Identity for tests:** test JWTs were signed **locally** with the stack's local JWT secret (the documented dev secret for the local Supabase stack) via a session helper script (`/tmp/gm-tokens.sh`), then passed to PostgREST as the Bearer token; the mocked identity therefore comes from a locally-minted JWT, not from a real GoTrue login. A separate runner (`/tmp/gm_reg_runner.mjs`) used the `secure-session` endpoint for some later calls. No secret key material is reproduced here.
- **Persistence:** baseline snapshots and guarded cleanup SQL were captured per dataset (profiles, organizations, memberships, role_assignments, approval_events, platform_settings, auth users). The original three audit events were compared row-for-row after every test. No cleanup statement was run without matching on scratch IDs.
- **Status:** *preliminary local results*. They are **not** production security approval. See limitations at the end.

### Results

| Test | Purpose | Expected | Actual outcome (RPC `outcome` field) | Result |
|------|---------|----------|--------------------------------------|--------|
| T1 | New registration, missing profile → end-to-end | `created`, `pending`, 1 membership, 1 `submitted` event | `created` | PASS (see history note) |
| T2 | Same key, same payload, sequential retry | `replayed`, zero new rows/events | `replayed` | PASS |
| T3 | Same key, **changed** payload | rejection, zero changes | `payload_mismatch`, SQLSTATE `22023` | PASS |
| T4 | Cross-user reuse of T3's key | rejection, zero changes | SQLSTATE `42501` — key belongs to another user | PASS |
| T5 | Invalid payloads (see count note) | rejection `22023`, zero writes | `22023` per case | PASS |
| T6 | Same user, same key, **two concurrent** calls | exactly one org / membership / event, both calls converge | one call effectively created it; both returned `replayed` onto the *same* org id | PASS |
| T7 | Same user, **two different keys**, concurrent calls | two distinct orgs, 2 memberships, 2 `submitted` events | `created` for both calls, distinct org ids | PASS |

**T1 history (recorded exactly):** the *first* T1 attempt **failed** — every new registration rolled back because `20261026180000`'s `RETURNS TABLE` output variable `id` collided with the bare `"id"` arbiter in the profiles insert (`column reference "id" is ambiguous`), as documented verbatim in the header of `20261026191000_fix_register_company_profile_conflict.sql`. After applying that append-only fix, T1 was re-run and **passed** with one org, one `company_admin` membership, one `submitted` event, and the profile created as `active`. The initial failed attempt is not counted as a pass, and its failed calls wrote nothing to the database.

**T3:** after a normal first registration committed as `created`, replaying the same key with a changed legal name returned `payload_mismatch` (`22023`) with zero rows affected; the stored organisation row was unchanged.

**T4:** a second user reusing the T3 key with an otherwise-identical payload was rejected with `42501` ("registration key belongs to another user"); zero rows written for that caller.

**T5 — case count (recorded with limitation):** the session record reports **six** invalid-payload cases (null key; missing profile name; over-long legal name; over-long registration number; over-long billing contact; invalid e-mail). Surviving evidence (`gateway` + `rest` logs) shows **six** `register_company` 400-responses in the pre-test window, but the two identical 108-byte responses at 18:33:22 are attributed by session notes to the earlier smoke-test pair, leaving four size-distinct responses (77/77/83/99 bytes) at 18:33:30 for individual cases. The T5 payload script and per-case outputs were not persisted, so the response-to-case mapping — and a definitive executed count — cannot be reconstructed from disk alone. **Six is carried forward as the session record, not as independently re-verified evidence; the eight-case figure proposed in a later review round is NOT supported by any surviving evidence and is not adopted.** In every logged rejection window the side-effect counts before and after matched exactly (orgs 2, events 3, memberships 3, profiles 5, keyed orgs 0): zero writes.

**T6 (runner outputs persisted verbatim):** one setup registration created org `fe8cafe3-fe6f-4288-a5eb-0d971aa8ae22` (`outcome='created'`, `status='pending'`). Two truly concurrent same-key re-calls both returned onto that same id with no duplicate rows: runner output for both calls was `status: "accepted:replayed:fe8cafe3-fe6f-4288-a5eb-0d971aa8ae22:pending"`. Post-run side effects: exactly **1 new organization, 1 new membership, 1 new `submitted` event, 0 new profiles**.

**T7 (runner outputs persisted verbatim):** two truly concurrent calls from the same user (whose profile already existed) with different keys and different payloads (one `en`, one `ar`) returned, verbatim:

```
status: "accepted:created:c0291f7c-718a-42f7-bc6f-48a7567898d1:pending"   (key …444444444444, "T7 Key-A Co (Scratch)", language en)
status: "accepted:created:b6d26fb6-e4e0-4123-8c17-6e9719c54b0b:pending"   (key …444444444445, "T7 Key-B Co (Scratch)", language ar)
```

Result: two distinct organisations, one membership and one `submitted` event each, and the pre-existing profile untouched (display name, `preferred_language`, `status` all unchanged). This matches the documented provisional rule that one user may register more than one company — still flagged for ATCO in `docs/atco-pending-business-rules.md`.

**Actual RPC response fields vs. runner labels:** the RPC's real return shape is `returns table (id uuid, legal_name text, status text, outcome text)`, and the outcome values actually observed are exactly **`created`** and **`replayed`**. The `accepted:` prefix in the runner outputs above is a **runner-side label** composed by `/tmp/gm_reg_runner.mjs` (`'accepted:' + outcome + ':' + id + ':' + status`); intermediate session notes that wrote `"accepted"` alone refer to that label, not to an RPC value. T6/T7's calls are labelled in one earlier summary as `accepted`/`accepted:created`; the canonical RPC outcomes are `replayed` (T6) and `created` (T7) as tabulated above.

### Cleanup and post-test state

- After each test, guarded deletes removed only rows matching the test's scratch organisation id, key, user id and role, then the seven datasets were re-diffed row-for-row against the pre-test snapshots.
- **Six of seven datasets were restored to byte-identical state** (row-for-row). The database is therefore **not** claimed to be byte-identical overall — see the deviation below.
- The original three seed audit events remained intact throughout.

### Known data deviation: `auth.users.updated_at`

All five seed users' `auth.users.updated_at` diverged from the original baseline (all other user fields identical). Captured values (original → final):

| User | Email | updated_at before | updated_at after | Correlation evidence |
|---|---|---|---|---|
| ATCO administrator | atco-admin@dev.invalid | 15:45:38.340611+00 | 16:24:12.027947+00 | Auth log: `grant_type=password` login, 16:24:12Z, referer `http://127.0.0.1:3000` |
| ATCO operations | atco-ops@dev.invalid | 15:45:59.508319+00 | 16:24:12.149056+00 | Auth log: password login, 16:24:12Z, referer `http://127.0.0.1:3000` |
| Company A demo admin | company-a-admin@dev.invalid | 15:45:59.596325+00 | 16:24:12.266659+00 | Auth log: password login, 16:24:12Z, referer `http://127.0.0.1:3000` |
| Company A demo booker | company-a-booker@dev.invalid | 15:45:59.682591+00 | 18:34:27.361687+00 | Auth log: `token_refreshed` + `token_revoked` at 18:34:27Z (UA `curl/8.7.1`) |
| Company B demo booker | company-b-booker@dev.invalid | 15:45:59.767044+00 | 18:34:14.316164+00 | Auth log: `token_refreshed` + `token_revoked` at 18:34:14Z (UA `curl/8.7.1`) |

- The two 18:34 timestamps correlate within milliseconds with logged **refresh-token grants** for those exact user ids during the T6 window — this is an evidenced correlation.
- The three 16:24 updates do **not** correspond to anything the test runner did; the auth log shows password-grant logins for those users at 16:24:12Z with a dev-app referer (`http://127.0.0.1:3000`) that is outside the test-session chronology. The timestamps are now correlated to those logged sign-ins, but *why* the dev app signed those users in at that time is outside the test evidence — previously these three were listed with only an uncertain explanation.
- Column-order correction (verified 2026-10-26 against the live database with a labeled re-query): the original baseline snapshot was extracted as `(id, email, updated_at, created_at)` while the post-test check extracted `(id, email, created_at, updated_at)`. The first correction attempt of this table therefore used the unchanged **created_at** values (.331251/.504314/.593848/.679694/.764775) as "before" `updated_at`; those are the correct **created_at** values, and they are all unchanged from baseline. The table above now lists the true pre-test `updated_at` values. `created_at` is unchanged for all five users; only `updated_at` moved.

### Limitations and security scope

- **Local only.** Every test ran against the local Supabase stack; scratch records were used and removed; the tests say **nothing** about production deployment, hosting or data.
- **Locally signed JWTs.** Identities were established by minting JWTs with the stack's local dev secret; **no real GoTrue password login or full production authentication/authorization flow was exercised** (the token-refresh and password-login events in the auth logs came from the dev app, not from this test suite). Results are therefore about the RPC, RLS and privilege layer, not about production auth hardening.
- **Concurrency coverage is shallow:** the concurrency tests each drove exactly two simultaneous calls. Larger fan-out, load and true race-window fuzzing were not attempted.
- **Failure-injection tests (Group 2/3: forced membership failure, temporary triggers) were not run** and remain outstanding in the approved plan.
- The T5 case count carries the uncertainty described above; the executed count is session-recorded, not independently reconstruction-grade evidenced.
- These results are **preliminary**; they do **not** constitute production security approval.

### Business-rule status

All business behaviours exercised here (multi-company registration, suspended-profile denial, field caps, language options, idempotency conflicts, profile display-name handling on every call) remain **provisional defaults pending ATCO confirmation**. Nothing here implies ATCO approval; see `docs/atco-pending-business-rules.md`.

## Verification — 2026-10-27 (branch `backend/phase1`, HEAD `52a41e7d8d52648761ae0d9b7a0c2d0a7209b267`)

Full verification of the current frontend code — the first recorded run since the 22 October stability batches. The checkpoint commits `2b51220`/`a6260d5`/`52a41e7` (boot sound, mobile navigation, booking flow/ticket QR/boarding scanner) are now covered by a passing run. All commands ran in the project folder only; no migrations, SQL, database or remote operations, no dependency installs, no Git state changes.

| Check | Command | Result | Detail |
|---|---|---|---|
| Type check | `npm run typecheck` | **Pass (exit 0)** | `tsc --noEmit`, 0 errors |
| Tests | `npm test` (vitest) | **Pass (exit 0)** | **11 files, 141/141 tests**, 8.58 s, no failures or flaky retries |
| Production build | `npm run build` | **Pass (exit 0)** | 98 modules; `main-…js` 261.09 kB (79.13 kB gzip), CSS 65.88 kB; built in 679 ms |
| Git state | `git status` before and after | Unchanged | Same 5 working-tree entries throughout: `M .freebuff/project-id`, `M docs/test-results.md`, untracked `docs/atco-pending-business-rules.md`, `docs/backend/`, `supabase/`. Nothing staged, committed or pushed |

### Ad-hoc Chromium browser smoke test

**No stored browser/E2E suite exists** in the project — there is no `playwright.config.*` and no `*.spec.*` files. All browser coverage to date has been ad hoc. Playwright 1.64.1 and Chromium (cached) were already installed, so an ad-hoc inline Playwright script (no files created) was run against the **already-running dev server from this same project** (`vite`, PID 14164, port 3000), which was reused and left running exactly as found.

| Check (Chromium, 1366×900, throwaway profile) | Result |
|---|---|
| Signed-out visit shows the sign-in page with the demo-guest option | Pass |
| "Explore as demo guest" reaches the app | Pass |
| Customer home → Book CTA visible; **0 console/page errors** | Pass |
| Arabic switch: `dir=rtl`, `lang=ar`, navigation translated (الرئيسية), no horizontal overflow | Pass |
| Back-to-EN switch | Pass — first probe read `rtl`, re-verified with error-surfacing clicks: `rtl/ar → ltr/en`, heading back to "Home"; the first reading was a selector artifact of the probe script, not an app bug |
| `/bookings` and `/book` render sweep | Pass — 1,172 / 1,786 chars, **0 page errors total** |

Not covered by this smoke test: staff pages (`/operations`, `/boarding`, `/materials`, `/fleet`), `/corporate`, booking wizard steps, mobile widths, dark mode, presentation frames, Safari/WebKit — these last had coverage in earlier recorded sessions and the full unit suite.

**Limitations:** the unit suite runs in jsdom against Chromium-independent logic; the browser smoke test is ad hoc and not repeatable as a stored regression suite (no Playwright suite has ever been committed). Backend registration-RPC results (T1–T7 above, plus the authorized G2 subset from the 26–27 October sessions) are local-only and remain preliminary, awaiting the outstanding Groups 2/3 items.
