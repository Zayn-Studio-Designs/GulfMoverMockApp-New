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
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build (Vite prints the URL, normally http://localhost:4173/) |
| `npm run typecheck` | TypeScript check |
| `npm test` | Run the test suite once (`npm run test:watch` to watch) |

**Note on `node_modules/`:** the repository still contains a committed macOS `node_modules/` folder. `npm ci` replaces it with the right files for your computer, so Git may then show many changed files under `node_modules/` — do not commit those.

## Quick look without installing

`previews/atco-marine-app.html` (full app) and `previews/atco-marine-phone-preview.html` (same app in an iPhone / Android frame) are self-contained builds. Download one and double-click it; no internet or install needed. They are snapshots for viewing only — after changing `src/`, test with `npm run dev`, not the previews.

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
