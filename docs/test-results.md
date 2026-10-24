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

## Branch 0-3: demo polish (24 October 2026, based on 0-2 @ 6839fa1)

**Why 0-3 starts from 0-2, not 0-1:** the demo needs the 0-2 fixes (the downloaded presentation no longer shows local folders; dark mode). 0-2 has not been approved yet, so approving 0-3 also brings in 0-2.

**Changes.**
- **Continue goes to the top.** Every booking step change jumps to the top of the page: Continue, Back, payment → result, and "Create another booking". The steps share one page, so before this the scroll position stayed where the button was. Changing page from the menu also jumps to the top straight away instead of gliding slowly from the bottom. A blocked Continue on the details step now shows its message on screen and puts the cursor in the first missing field. "View details" in My Bookings and Operations, and picking a materials request on a phone, bring the details panel into view.
- **No white edges on the phones.** The device screen and the app frame used white backgrounds. Scaled to fit the window, the app can end a sub-pixel short of the screen edge, so thin white lines showed around the screen and its rounded corners. Both are now the bezel colour. The app and the Wallet and sheet layers also start 1px under the status bar, which closes a hairline seam that showed the app beneath the Wallet screens.
- **Apple Wallet boxes fully inside the screen.** The swipe row was always as tall as the tallest item (a boarding pass). A payment card therefore left a gap that pushed its details box off the bottom of the iPhone screen. The row now takes the height of the card being shown.
- **Polish.**
  - The sidebar menu links are no longer underlined.
  - On narrow phones the header subtitle is hidden instead of being cut to "M…".
  - On phones, content no longer shows in the strip under the floating bottom menu; a fade in the page colour sits beneath it.

| Check | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm test` | Pass: 11 files, **107 tests**; new: `navigationScroll.test.tsx` (4) |
| `npm run build` | Pass |
| Booking steps in the browser, from the bottom of each step, at 1280 px and 390 px | Every Continue, Back, "Show booking result" and "Create another booking" ends at scrollY 0. A menu page change ends at 0. View details shows the panel under the header. |
| Same in the downloaded presentation (iPhone, Android, Mac frames) | Step changes end at scrollY 0 on all three. |
| Phone edges, light and dark, at 2× zoom | No white lines at the sides, rounded corners or status bar. |
| Apple and Google Wallet walkthrough with fit checks | No box or text outside the screen or poking out of its container. The only flag is the intended slide-up animation of Wallet opening. Add, HUD, coach, swipe, pass QR, close and reopen all pass. No errors. |
| Tour cards and highlights, every step, Mac / iPhone / Android, English and Arabic, customer and staff | All inside the screen. |
| Text and box sweep: 440 checks, 5 widths, English and Arabic | 0 problems (previously 168 flags for the phone subtitle), 0 JavaScript errors. |
| Dark contrast scan, 176 screens | 0 low-contrast items, 0 JavaScript errors. |
| Batch-1 browser checks (tour, "?" button, CSV, damaged data, camera) | 13/13 pass. |
| Downloaded presentation from disk, light and dark | 20/20 pass (boot, Home × 3, safety net, embedded sound, no errors). |

**Not verified:** Safari, Firefox, Windows Edge and real phones. Testing was in Chromium on Linux.
