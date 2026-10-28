# Privacy, data-subject requests and retention

**No legal conclusion is drawn here and no retention period is invented.** The Saudi Personal
Data Protection Law (PDPL) and its Implementing Regulations (SDAIA) apply to personal data of
passengers, crew and company contacts. Research summary (secondary sources; official SDAIA text
was not retrievable from this session — ATCO legal must confirm):
data-subject rights of access, correction, destruction and objection; controllers disclose
retention periods; statutory retention duties prevail over destruction requests; a commonly cited
30-day response window; breach notification to SDAIA (commonly cited 72 hours).
Sources: [Clyde & Co](https://www.clydeco.com/en/insights/2023/09/saudi-arabia-issues-implementing-regulations),
[HSF Kramer](https://www.hsfkramer.com/insights/2023-11/saudi-arabias-personal-data-protection-law-%E2%80%93-what-you-need-to-know),
[Akin Gump](https://www.akingump.com/en/insights/alerts/kingdom-of-saudi-arabias-new-personal-data-protection-law-and-implementing-regulations-key-obligations-responsibilities-and-rights).

## Implemented (database-enforced, tested)

| Capability | Function |
|---|---|
| Self-service export of own data (JSON; no QR secrets or provider internals) | `export_my_data()` |
| Privacy requests (access, correction, erasure, objection) with due date from `privacy.response_days` (30, ATCO to confirm) | `submit_privacy_request`, `decide_privacy_request` |
| Legal holds blocking erasure | `set_legal_hold` |
| Erasure by redaction that keeps legitimate financial/audit records; refused during active trips or legal hold | `anonymize_user_data` |
| Retention rules per record type with **NULL periods, status provisional** — `apply_retention` does nothing until ATCO approves a period; financial records and audit logs are never deleted by it | `data_retention_policies`, `set_retention_policy`, `apply_retention` |
| Data minimisation: IT support sees no passenger data; manifests omit contact details and QR secrets; outbox stores no message content or addresses; reports aggregate individuals | RLS / report functions |

Supabase Auth account deletion (the login itself) is performed by an administrator through the
Supabase Admin API after redaction; it is not exposed to the browser.

## Decisions required from ATCO

1. Retention period per record type (bookings/passenger data, payments, invoices — statutory
   tax retention applies, notifications, logs).
2. Privacy notice text (EN/AR) and the lawful basis for each purpose; consent text for SMS/WhatsApp.
3. Data residency (hosting region) and cross-border transfer assessment.
4. Who handles privacy requests and breach notifications.
