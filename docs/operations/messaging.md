# Notifications and external messaging

In-app notifications are live (database-generated). External channels are **implemented but
disabled**: `platform_settings('notifications.channels')` = all false, so every external message
is recorded as `suppressed: channel_not_configured` and never reported as sent.

## Architecture

1. A database event emits an in-app notification (`emit_notification`).
2. `trg_enqueue_notification` creates one outbox row per channel the user has opted into
   (transactional e-mail on by default with opt-out; SMS/WhatsApp require explicit consent with a
   consent-text version). Unique `(notification_id, channel)` prevents duplicates.
3. `notifications-dispatch` edge function (service role, scheduled) leases a batch
   (`claim_outbox_batch`, `FOR UPDATE SKIP LOCKED`), resolves the recipient at send time, sends
   with the provider using the outbox id as idempotency key, and records the result
   (`complete_outbox_delivery`: sent only with a provider message id; failures retried with
   exponential backoff up to 5 attempts, then `failed`).
4. Delivery receipts → `record_message_status`. Problems are listed (without recipient data) in
   **System & support** (`notification_delivery_issues`).

Messages contain only an event headline and a same-site link (no passenger names, amounts or
references beyond the link path) in the user's language.

## Providers (adapters in `supabase/functions/_shared/messaging/providers.ts`)

| Channel | Adapter | Requirements before activation |
|---|---|---|
| E-mail | Resend HTTP API (`Idempotency-Key`) | Verified sending domain (SPF/DKIM), DPA; alternatively configure any SMTP via Supabase Auth for auth mails only |
| SMS | Unifonic REST | Registered alphanumeric **Sender ID** for KSA (company documents, CST anti-spam NOC) — [Unifonic sender ID guide](https://docs.unifonic.com/docs/getting-a-sender-id-1) |
| WhatsApp | Meta WhatsApp Business Cloud API | Business verification, approved message templates named `gm_<event>`, user opt-in |

Pricing and template rules change; obtain current terms from each provider. Endpoint shapes are
from public docs and must be confirmed against the contracted account.
