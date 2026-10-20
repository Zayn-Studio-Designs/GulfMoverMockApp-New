# Handover to fcc-claude: Gulf Mover presentation with device Wallet

This guide is for someone who is **not a programmer**. It explains how to get this version of the Gulf Mover mock app onto a Mac, start it, and present the Apple Wallet and Google Wallet demo. Copy each command exactly as written.

> **This is a demo only.** Nothing is connected to a real payment system, a real Apple Wallet or Google Wallet, ATCO, a port or a vessel. All data is fictional, and it is stored only in the browser.

---

## 1. Where the code is

| Item | Value |
|---|---|
| Repository | https://github.com/TOPZEDE/GulfMoverMockApp |
| Branch | `handoff/fcc-claude-final` |
| Branch on GitHub | https://github.com/TOPZEDE/GulfMoverMockApp/tree/handoff/fcc-claude-final |
| Based on | `handoff/presentation-wallet` @ `1202e09` |
| Code commit | `6cd25e2356f300c766afa524c2e13385d1db548a` |

This document was added in a separate commit, after the code commit. To find the newest commit, run `git log -1` on the branch.

---

## 2. One-time setup on the Mac

You need **Git** and **Node.js 18 or newer** (version 20 LTS is recommended).

1. Check whether they are installed:
   ```bash
   git --version
   node --version
   ```
2. If either is missing, install Node.js from https://nodejs.org (choose the LTS version). Git is offered automatically the first time you run `git` on a Mac.

---

## 3. Get the code

**Option A: you do not have the project yet.**
```bash
cd ~/Desktop
git clone --branch handoff/fcc-claude-final https://github.com/TOPZEDE/GulfMoverMockApp.git GulfMover-final
cd GulfMover-final
```

**Option B: you already have the project folder.** First go into that folder with `cd`, then run:
```bash
git status
git fetch origin
git switch handoff/fcc-claude-final
git pull origin handoff/fcc-claude-final
```
If `git status` lists changed files, stop at that point. Ask fcc-claude to save or commit them first, so nothing is lost.

---

## 4. Install and start

Run these inside the project folder:
```bash
npm ci
npm run presentation
```

- `npm ci` installs the exact dependency versions. Run it once, and again after each pull.
- `npm run presentation` starts the local server and normally opens the browser automatically.
- **Presentation URL:** http://localhost:3000/presentation.html
- **Plain website (no device frames):** http://localhost:3000/
- If port 3000 is busy, Vite prints a different `Local:` address in the terminal. Use that address and add `/presentation.html` to the end.
- To stop the server, press **Control + C** in the terminal.

---

## 5. How to present

The presentation page has three device buttons at the top: **Mac**, **iPhone** and **Android**. The Gulf Mover app runs inside the selected device. There is also a language toggle (EN / العربية) that switches all text, including the Wallet screens, to Arabic right-to-left.

**Tip:** to start a demo from a clean state, use the app's **Reset demo data** action.

### Apple Wallet demo (iPhone)
1. Choose **iPhone**.
2. Sign in as a demo guest, then book a trip.
   - At the **Review & pay** step, choose a payment option and confirm. This is simulated: no real payment is made.
3. On the result screen, or under **My Bookings → ticket**, tap **Add to Apple Wallet**.
4. The Apple add sheet appears. Tap **Add**. A confirmation reading **"Added to Apple Wallet"** appears.
   - A coach bubble then explains that you double-click the side button, and the side button on the right of the phone pulses.
5. **Double-click the side button.** A single click deliberately does nothing.
6. Apple Wallet opens. It shows three fictional example payment cards (marked DEMO) and the Gulf Mover boarding pass or passes.
7. Swipe or drag left and right (the arrow keys also work) to move between cards.
8. Tap the Gulf Mover pass to see its details: route, date, departure, passenger, booking, status and the **QR code**.
9. Tap **Done** to close. Double-click again to reopen. The pass appears only once, with no duplicates.

### Google Wallet demo (Android)
1. Choose **Android**, then book a ticket or open an existing one.
2. Tap **Add to Google Wallet**, then **Save**. A confirmation reading **"Added to Google Wallet"** appears.
   - A coach bubble then explains how to swipe down from the top of the screen.
3. **Tap the status bar** at the top of the phone screen. This stands in for swiping down. Quick Settings opens.
4. Tap the **Google Wallet** tile. Wallet opens on the newest pass.
5. Swipe between cards, then tap **View pass** to see the details and the QR code.
6. Close and reopen. The pass is still listed once.

### Mac and the regular website
Choose **Mac** to show the desktop website inside a laptop frame, or open http://localhost:3000/ directly.

---

## 6. What was built (main files)

| Area | Files |
|---|---|
| Device shell, side button, status bar, coach | `src/presentation/PresentationApp.tsx`, `src/presentation/presentation.css` |
| Apple Wallet (simulated) | `src/presentation/wallet/AppleWallet.tsx` |
| Google Wallet and Quick Settings (simulated) | `src/presentation/wallet/GoogleWallet.tsx` |
| Wallet styling | `src/presentation/wallet/deviceWallet.css` |
| Example DEMO cards (fictional) | `src/presentation/wallet/demoCards.ts` |
| Double-press, swipe and animation helpers | `src/presentation/wallet/hooks.ts` |
| Wallet wording in English and Arabic | `src/presentation/wallet/osText.ts` |
| App ↔ device messaging | `src/presentation/walletProtocol.ts`, `src/components/wallet/WalletHostBridge.tsx` |
| Ticket → pass data | `src/components/wallet/passView.ts` (built from the app's demo bookings and tickets in browser storage) |
| Payment page redesign | `src/pages/BookingView.tsx`, `src/styles/index.css` |
| Contact ATCO → Settings › ATCO tab | `src/components/ContactCard.tsx`, `src/pages/SettingsView.tsx`, `src/components/Layout.tsx` |
| Fonts and typography | `src/styles/fonts.css`, `src/styles/index.css`. Fonts are bundled (Inter, IBM Plex Sans Arabic, Roboto, all under the OFL licence). |
| Tests | `src/tests/presentationWallet.test.tsx` (new), `src/tests/app.test.tsx` (updated) |

**Summary:**
- The Wallet experience lives entirely inside the mock phones. The app sends the ticket's details to the device frame, and the frame draws an Apple-style or Google-style Wallet.
- The QR code encodes the demo ticket reference (`GM-VERIFY-1|<ticket id>`).
- Adding a pass twice is blocked.
- The only new dependencies are the three font packages.

---

## 7. Checks (results on 20 Oct 2026)

| Check | Command | Result |
|---|---|---|
| Install | `npm ci` | OK, 168 packages |
| Typecheck | `npm run typecheck` | Pass (exit 0) |
| Tests | `npm test` | **70 / 70 passed** (6 test files) |
| Build | `npm run build` | OK |
| Lint | — | Not configured in this project |

**Browser test** (Chromium via Playwright on localhost):
- **iPhone (Apple):** passed.
  - Add, then the "Added to Apple Wallet" message and the coach.
  - A single click does nothing; a double-click opens Wallet.
  - The stack holds 3 demo cards plus the passes, and swipes through all of them.
  - The pass detail shows the QR code.
  - Close and reopen leaves no duplicates.
- **Android (Google):** passed.
  - Save, then "Added to Google Wallet".
  - Status bar, Quick Settings, then Wallet.
  - Swipe and detail with QR.
  - Close and reopen leaves no duplicates.
- **iPhone payment layout:** passed. The stepper shows "Review & pay", the floating pay bar shows, and there is no sideways overflow, in English and Arabic.
- **Mac and regular website:** passed. Fonts and colours load, Contact ATCO and Back work signed in and signed out, and Arabic RTL is correct.

**Not tested:** Safari, Firefox, and real phones or touch hardware.

---

## 8. Known issues and limitations

- These are **simulations**. There is no real Apple Wallet or Google Wallet pass, no real payment, and the example cards are fictional.
- On Android, "swipe down from the top" is represented by **tapping the status bar**.
- The onboarding tour from branch `feature/onboarding-tour-integration` (`9cfe157`) is **not** included in this branch.
- The HTML files in the `previews/` folder are older snapshots and do not reflect this version.
- An unused component, `SideButtonDemoSheet`, is still in the code. It is harmless.
- A minor layout overflow on the booking review step was carried over from an earlier branch.
- `npm audit` reports warnings from development dependencies that predate this work.
- Fares, routes, timings and statuses are demo or proposed values pending ATCO confirmation (see `docs/demo-limitations.md`).

---

## 9. Environment variables

**None are required.** The app runs entirely locally, with no API keys, accounts or `.env` file.

---

## 10. Suggested prompt for fcc-claude

> Open the Gulf Mover project, check out branch `handoff/fcc-claude-final`, run `npm ci` and `npm run presentation`, and open `/presentation.html`. Read `HANDOVER_TO_FCC_CLAUDE.md` first. Do not push, merge or deploy without my permission.
