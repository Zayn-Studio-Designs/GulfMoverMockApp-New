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
