# Gulf Mover Mock App — Demo Limitations

This is a front-end presentation prototype, not a production system. Everything below is simulated; nothing here is evidence of ATCO approval, permitted services or working operational integrations.

## Simulated / demo-only (clearly labelled in the UI)

| Feature | What the demo shows | Why it cannot be real yet |
|---|---|---|
| Sign-in & accounts | Local browser-only accounts; "Explore as demo guest" work-mode switcher | No backend or identity provider |
| Apple Wallet pass (iPhone preview) | Inside the mock iPhone: an iOS-style "Add pass" sheet, then a simulated Wallet opened by double-clicking the on-screen side button, showing the saved demo passes and their QR codes. On the regular website the existing in-page "Add pass to Wallet" sheet remains | A real pass needs a signed Apple `.pkpass`, pass type ID, certificate and Apple-side validation, delivered by the production app. Nothing is installed in a real Wallet |
| Example payment cards in the simulated Wallets | Three fictional cards (invented issuers and holder, masked numbers, "DEMO" on each) shown beside the Gulf Mover pass so the Wallets look lived-in | Visual props only: no card data, no payment capability; each card says it cannot make payments |
| Google Wallet pass (Android preview) | Inside the mock Android: a Google-style "Save" sheet and a simulated Google Wallet (opened from Quick Settings or "View in Google Wallet") with the same demo passes | A real pass needs a Google Wallet issuer account, a signed JWT/pass object and the Google Wallet API. Nothing is saved to a real Google Wallet |
| QR tickets | Scannable QR encoding only an opaque ticket reference (`GM-VERIFY-1|GMTK-…`) | Real boarding needs server-side validation, rotation and revocation; a screen-rendered QR copied/screenshot cannot be trusted |
| Payments | "Simulate payment recorded / pending / failed" buttons change local state only | No gateway, no card handling, no server reconciliation; nothing is charged |
| Corporate PO reference | Saved onto the local demo booking record and echoed back | Real PO workflows need corporate-account onboarding and finance systems |
| CSV exports (bookings, sailings/ops) | `downloadCsv` writes a client-side file from demo state | No persistence, audit trail or finance integration |
| Fleet demo admin config | Fare / departure / capacity inputs mutate demo state | No authority to change tariffs; real config needs ATCO sign-off, versioning and an audit log |
| Boarding desk | Manual/QR lookup, per-ticket board/unboard, duplicate-scan rejection (repeated verification is refused) | Real boarding needs port-controlled hardware/access; a browser cannot guarantee scan exclusivity |
| Minimum-sailing rule | Four-ticket threshold aggregated across bookings for the same sailing | Real scheduling/manifests need an operations backend |
| Materials flow | Review states advance only after an explicit reviewer action with a reason | No supplier integration or pricing/tariff (never invented in the demo) |

## Hard boundaries kept

- QR payloads and ticket identifiers contain **no names, phone numbers, identity numbers or payment data**. Passenger names collected in the booking wizard live only in the local demo record.
- VAT is shown as **pending ATCO confirmation**; no tax amount is ever invented.
- Destinations ("Approved Anchorage A (Demo)"-style placeholders), boat names and departure times (07:00 / 09:30 / 13:00 + hourly demo slots) are marked as **editable / pending ATCO confirmation**.
- Payment status, four-ticket minimum, port-readiness, operational/sailing approval and boarding state are **separate statuses**; paid never implies port access, sailing approval or boarded.
- No dependency on Google Drive/MCP: the app is built from the local `reference/` snapshot only.

## Out of demo scope (would be needed in production, none implemented)

1. Backend persistence, auth, audit logging; auto-generated Apple `.pkpass` signing and delivery.
2. Server-side QR validation with one-use tokens, expiry and revocation.
3. Payment processing, refunds and invoicing (incl. confirmed VAT treatment).
4. Port/permit, vessel-schedule and channel (SMS/WhatsApp/email) integrations.
5. Corporate credit terms, agent settlement rules, supplier pricing.
6. Any real operations authority — the demo never claims ATCO approval.

## Data handling

- All data is fictional sample data in memory + `localStorage` (`gm-demo-state-v1`). No real passenger IDs, card details, credentials or personal data are used or stored.
- **Reset demo data** (sidebar) clears the local state back to the seeded sample.
