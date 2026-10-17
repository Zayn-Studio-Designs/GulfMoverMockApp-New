# Gulf Mover Marine Taxi Platform — Mock App

A locally runnable, bilingual (English / Arabic) **demo** of the Gulf Mover booking and operations platform for ATCO review. All data is fictional; there is no backend, payment, permit or port integration.

The design and behaviour follow the reference prototype in
`reference/Gulf Mover Marine Taxi Platform/03 - UX UI and Brand/Wireframes and Clickable Prototype/gulf_mover_ui_prototype_bilingual.html`.

## Run it
Requires Node.js 18+.

```bash
npm install --legacy-peer-deps   # first time only (see note below)
npm run dev                      # http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server on port 3000 |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | TypeScript check |
| `npm test` | Run the test suite once (`npm run test:watch` to watch) |

Note: the repository currently contains a macOS `node_modules/` folder. On other systems, delete it and run `npm install --legacy-peer-deps`.

## Using the demo
- **Views:** Book Transfer, My Bookings, Corporate / Agent, Operations, Boarding Desk, Materials (sidebar; bottom bar on mobile).
- **Language:** `EN | العربية` switch in the header translates the interface and switches to right-to-left.
- **Reset:** “Reset demo data” in the sidebar restores the initial sample.
- **Workspaces:** the Corporate / Agent view has an organisation switcher (demo only — not authentication).

## Rules the demo shows
- SAR 500 per passenger per one-way leg; VAT treatment pending ATCO.
- Departures 07:00, 09:30, 13:00 Saudi local time (proposed, editable by ATCO).
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
- `src/pages/` — the six views
- `src/tests/` — unit and UI tests

See `docs/test-results.md` for the latest verified results.
