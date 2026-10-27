# Gulf Mover Marine Taxi Platform — Mock App (ATCO Marine)

A locally runnable, bilingual (English / Arabic) **demo** of the marine-transfer booking and operations platform the Gulf Mover team is preparing for ATCO (branded ATCO Marine). All data is fictional; there is no backend, payment, permit or port integration.

The design and behaviour follow the reference prototype in
`reference/Gulf Mover Marine Taxi Platform/03 - UX UI and Brand/Wireframes and Clickable Prototype/gulf_mover_ui_prototype_bilingual.html`.

## Run it locally

**Prerequisites:** [Git](https://git-scm.com/) and [Node.js](https://nodejs.org/) **22 LTS (22.22.2 or newer) or 24 LTS**, which includes npm. Node 18+ is enough to run the app; the test tools ask for the newer version.

```bash
git clone --branch feature/match-bilingual-prototype https://github.com/TOPZEDE/GulfMoverMockApp.git
cd GulfMoverMockApp
npm ci            # clean install of the exact dependency versions (first time, or after pulling changes)
npm run dev       # then open http://localhost:3000/
```

The terminal prints `Local: http://localhost:3000/`. The server only listens on your own computer; stop it with `Ctrl+C`.

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server at http://localhost:3000/ |
| `npm run presentation` | Start the dev server and open the **client presentation** page (`/presentation.html`) |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build (Vite prints the URL, normally http://localhost:4173/) |
| `npm run typecheck` | TypeScript check |
| `npm test` | Run the test suite once (`npm run test:watch` to watch) |
| `npm run test:integration` | Real **local** Supabase suite (auth + Mailpit, RLS, RPCs). Skipped unless the `GM_IT_*` variables point at a loopback stack — see `docs/backend/phase3-approval-bookings.md` §4 |
| `npm run test:e2e:local` | Chromium journeys against the app in production mode on the local stack (same doc, §4) |

**Note on `node_modules/`:** the repository still contains a committed macOS `node_modules/` folder. `npm ci` replaces it with the right files for your computer, so Git may then show many changed files under `node_modules/` — do not commit those.

## Quick look without installing

`previews/atco-marine-app.html` (full app) and `previews/atco-marine-phone-preview.html` (same app in an iPhone / Android frame) are self-contained builds. Download one and double-click it; no internet or install needed. They are snapshots for viewing only — after changing `src/`, test with `npm run dev`, not the previews.

## Client presentation mode

During a client meeting, run `npm run presentation` and present from the page that opens (the terminal prints the `Local:` URL; open `<that URL>/presentation.html` manually if the browser does not pop up).

- **Toolbar:** Gulf Mover branding · **Mac / iPhone / Android** selector · "Showing" indicator · **Home** (restart the demo) · **Full screen** (browser native full screen; if unavailable, a note appears and the window view keeps working).
- The **same running app** is shown in each preview — switching devices only resizes the preview window, so the booking you made or the language you selected carries across, and mobile/RTL layout inside the frame is real.
- Sign in once (“Explore as demo guest”) inside the preview; the session then carries across device switches. Use **Reset demo data** inside the app to clear demo changes.
- Presentation chrome never ships to customers: it is a local page (`presentation.html`) shown only through your dev server.

### Wallet demo inside the phones (simulated)

The phone previews have their own simulated Wallet, drawn inside the device screen by the presentation page (`src/presentation/wallet/`). The app supplies the real demo tickets and QR codes; nothing is added to a real Apple or Google Wallet.

- **iPhone:** in the app open a ticket (booking result, or My Bookings → View details) and tap **Add to Apple Wallet** → the iOS-style sheet → **Add**: the pass drops into Wallet and a green **Added to Apple Wallet** appears. A guide then points at the glowing side button. **Double-click the side button** on the right edge of the mock iPhone: Wallet slides up with three fictional example cards and the saved Gulf Mover passes stacked together. Tap any card, then swipe (drag) left/right — or use the dots or arrow keys — to reach the boarding pass with its QR code. **Done** returns to the stack; the home bar, Esc or one side-button press returns to the app. A single press never opens Wallet. Keyboard: focus the side button and press Enter twice.
- **Android:** tap **Add to Google Wallet** → **Save** → *Saving…* → **Added to Google Wallet** → **Done**. A guide points at the status bar: tap it (Quick Settings) → **Google Wallet**. The card carousel opens on the newest pass; swipe through the example cards, tap **View pass** for the QR code. **View in Google Wallet** on a saved ticket also opens it.
- Example cards (Meridian Express Gold, Gulf Coast Bank, Dhahran Digital) are fictional, masked and marked DEMO; they cannot pay.
- One pass per ticket (outbound and return are separate passes with their own QR codes); saved passes persist with the rest of the demo data and are cleared by **Reset demo data**.
- **Mac:** no phone Wallet; the app keeps its regular in-page Wallet sheet.

## Using the demo
- **Sign in:** create a demo account or press **Explore as demo guest**. Accounts are stored only in this browser (no server); never use a real password.
- **Views:** Book Transfer, My Bookings, Corporate / Agent, Operations, Boarding Desk, Materials, Fleet (sidebar; bottom bar on phones). **Settings** and **Sign out** are under the round profile button, top right.
- **Language:** `EN | العربية` switch in the header translates the interface and switches to right-to-left.
- **Reset:** “Reset demo data” in the sidebar restores the initial sample.
- **Bookings live in memory:** bookings and boat reservations reset when the browser page is refreshed; accounts and the sign-in stay.

## Rules the demo shows
- SAR 500 per passenger per one-way leg; VAT treatment pending ATCO.
- Departures 07:00, 09:30, 13:00 Saudi local time (proposed, editable by ATCO); the demo also offers hourly slots across 24 hours, shown in AM/PM.
- A chartered boat cannot be booked by anyone else for that time; a boat that already has passengers cannot be chartered.
- City: Dammam only for now.
- Minimum of four tickets counted across all bookings on a sailing.
- Return trips are a separate sailing and ticket.
- Payment, minimum, operational readiness and boarding are separate statuses; payment never authorises port entry or sailing.
- Material requests and suspensions require an explicit reviewer action with a reason.

## Code map
- `src/App.tsx` — routes and providers
- `src/components/` — layout (header, sidebar), icons, status pills, page header
- `src/context/` — language (EN/AR, RTL), demo data store, toast and confirmation dialog
- `src/i18n/` — translation tables and translation helpers
- `src/domain/rules.ts` — fare and minimum-sailing rules
- `src/data/demoData.ts` — fictional sample data (placeholder destinations only)
- `src/pages/` — the views, plus sign-in (`AuthView`), `FleetView` and `SettingsView`
- `src/domain/fleet.ts` — boats, time slots and booking-availability rules
- `previews/` — ready-to-open HTML snapshots
- `src/tests/` — unit and UI tests

See `docs/test-results.md` for the latest verified results.
