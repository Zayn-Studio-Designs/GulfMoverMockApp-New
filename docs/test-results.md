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
