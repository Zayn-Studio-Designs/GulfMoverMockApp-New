# Gulf Mover — Business rules pending ATCO confirmation

> **Status of this document:** This is a working record of decisions made for the
> Gulf Mover backend (backend/phase1). It is **not an ATCO approval record**.
> Nothing in the "Provisional rules" section below has been confirmed by ATCO.
> Every provisional rule is implemented in
> `supabase/migrations/20261026180000_register_company_rpc.sql` (pending, unapplied)
> and is labelled in the migration file header as "pending ATCO confirmation".
> The migration must not be treated as ATCO-reviewed until this list is closed.
>
> Scope: company registration flow only (`register_company`). Other areas of the
> platform (fares, sailings, boarding, materials) have their own separate rule sets.

---

## 1. Provisional rules we are currently using

These are implemented defaults. They are sensible, conservative server-side
choices, but **they are not ATCO-approved**. ATCO may change any of them; each
change would be a small migration/parameter edit.

| # | Provisional rule | Where it lives |
|---|---|---|
| P1 | A user may register **more than one company**. Uniqueness is keyed per registration *attempt* (the client-generated `registration_key`), not per user. | RPC design; header "PROVISIONAL BUSINESS RULES" |
| P2 | **Length caps on inputs**: legal name ≤ 200 · profile display name ≤ 80 · company display name ≤ 200 · registration number ≤ 64 · billing contact ≤ 200 (free text). Email/phone have no length cap beyond their validation patterns (phone ≤ 20 chars by pattern). | RPC validation block |
| P3 | Profile language accepts **only `en` or `ar`**. Anything else is rejected. | RPC validation block |
| P4 | A **suspended profile may not call `register_company` at all** — neither a first registration nor a replay of an earlier attempt. Semantics: a suspension committed before the RPC's profile read is always enforced; a registration that committed before a later suspension is legitimate history and is not retroactively cancelled. | RPC suspended-profile guard (`SELECT … FOR SHARE`) |
| P5 | Replaying a registration key with a **different payload is a hard error** (`payload_mismatch`), never a silent success. A legitimate payload change means the client starts a fresh attempt with a new key. | RPC replay branch |
| P6 | `p_profile_display_name` is **required on every call** (even replays that will not touch the profile), participates in the payload fingerprint, and an existing profile is **never modified** by the RPC (existing display name, phone, language all preserved). | RPC signature + new-registration branch |
| P7 | The company's contact phone (`p_contact_phone`) and billing contact are **company fields and are deliberately not copied** into `profiles.phone`. A missing profile is created with `phone = null`. | RPC new-registration branch |
| P8 | The RPC response exposes `outcome` = `created` / `replayed` so the frontend can tell a fresh registration from a replay. | RPC `RETURNS TABLE` |
| P9 | Payload normalisation: values are trimmed, blank strings count as absent, and contact emails are lowercased before fingerprinting and storage. `null` and "user typed nothing" are distinct. | RPC normalisation + fingerprint |
| P10 | "Return to pending" is audited as a fresh `submitted` event, and "suspended → approved" is audited as a `reinstated` event. (Carried over from migration 20261026170000 — provisional there too.) | organizations audit trigger comments |

## 2. Questions ATCO needs to confirm

Phrased as one-question-each; the current provisional answer is stated so ATCO
can confirm or correct it:

1. **Multiple companies per user** — may one user (person) register more than one
   company? *(Provisionally: yes, P1.)*
2. **Mandatory registration fields** — which fields are actually required for a
   pending-company registration, and what are the real maximum lengths?
   *(Provisionally: P2 caps; only legal name + display name are hard-required.)*
3. **Length limits** — do the P2 caps match any ATCO form/data guidance, or need
   adjusting?
4. **Duplicate contact details** — may two different companies share the same
   contact email or contact phone? *(Provisionally: allowed — no uniqueness
   constraint.)*
5. **Suspended accounts** — may a suspended account (a) start a new company
   registration, (b) replay/retrieve an earlier pending registration? Should
   company-level suspension also affect the founder's profile? *(Provisionally:
   deny-all for the RPC, P4; profile suspension and company suspension are
   separate concepts.)*
6. **Audit wording for lifecycle transitions** — is "return to pending = new
   `submitted` event" and "suspended → approved = `reinstated` event" the approved
   audit wording? *(Provisionally: yes, P10.)*
7. **Data captured on approval** — when ATCO approves a pending company, is
   anything missing from what registration captures (e.g. official registration
   number format, trade licence, port-appointment contacts)? Related: should
   `registration_number` have a specific format/validation?
8. **Display-name meaning** — is the sign-up "display name" the *person's* name
   (shown on profiles/membership lists) as provisionally assumed (P6)?
9. **Idempotency contract** — does ATCO accept the client-generated UUID
   idempotency design (P1 + P5), including the rule that a genuinely changed
   payload requires a new key?
10. **Billing contact** — is `billing_contact` really a free-text remark
    (provisionally yes), or is it meant to be an email/phone/structured
    billing entity?

## 3. Technical / security requirements (not provisional — part of the approved architecture)

These come from the security design agreed for backend/phase1. They are
enforcement rules, not business choices, and ATCO confirmation is not required
for them (changing them would be a security change):

- Identity always comes from `auth.uid()` (the JWT). No caller-supplied user IDs.
- `SECURITY DEFINER` with `SET search_path = ''` and fully schema-qualified
  references only.
- Organisation status is **server-forced to `pending`** at creation; no caller can
  register a company as approved.
- The initial membership is created server-side with fixed values
  (`company_admin`, `active`); users cannot grant themselves roles or create
  role assignments.
- Idempotency is enforced by a **partial unique index** on `registration_key`
  (where not null) as the INSERT arbiter, so concurrent replays converge on one
  organisation.
- A paired-nullability CHECK ensures `registration_key` and
  `registration_payload_hash` are either both set or both null.
- Only a **SHA-256 hash of the normalized payload** is stored — the payload
  itself is not stored, to avoid redundantly exposing registration data through
  organisation reads.
- EXECUTE on the RPC is granted to `authenticated` only; PUBLIC/anon execution is
  revoked; `service_role` is not granted (no current need).
- Direct (`authenticated`) INSERT on `public.organizations` is revoked and the
  obsolete `organizations_insert_pending_only` policy is dropped — the RPC is the
  only creation path for application users.
- All migration statements apply atomically (single transaction by the Supabase
  CLI runner), so there is never a window where the function exists with PUBLIC
  execute or where the columns exist without the constraint.

## 4. Tests that have not yet been run

The migration is **drafted, reviewed and pending — not yet applied**. No runtime
test of this migration has executed. Outstanding:

- **Apply itself** (`supabase migration up --local`) — the first execution of any
  statement in this file.
- **Phase A — catalog verification** (read-only after apply): function owner /
  SECURITY DEFINER / search_path settings, exact EXECUTE grants, columns +
  comments, CHECK constraint + partial unique index definitions, revoked INSERT +
  dropped policy, and all remaining policies/RLS/privileges unchanged.
- **Phase B — behaviour tests** (scratch data with guarded cleanup):
  successful registration; sequential same-key replay; concurrent same-key
  calls; concurrent different-key calls for a user whose profile already
  exists; payload-mismatch rejection; cross-user key reuse; suspended-profile
  denial; forced membership-insert failure rolling back everything.
- **Case B variant — concurrent registrations with no profile yet:** requires the
  creation (and later deletion) of one local scratch auth user, which still needs
  explicit authorization before those tests run.
- **Baseline preservation after the tests:** all six business tables back to
  baseline counts (profiles 5, organizations 2, memberships 3, role assignments 2,
  approval events 3, platform settings 1, five auth users) and the three
  legitimate audit events byte-identical to the recorded snapshot.

---

*Recorded from the read-only review session of 2026-10-26 (branch `backend/phase1`
@ `52a41e7`). Migration `20261026180000_register_company_rpc.sql` was unapplied
and byte-identical (SHA-256 `886c7f7b2598ae50ae78b29f970e0cefdf69f8b60e76dfe1ae46
da14528af088`) at the time of this record. This document does not represent ATCO
approval.*

---

## Phase 3 additions — approvals, roles and bookings (2026-10-27, branch `feature/phase3-approval-bookings`)

Implemented as the **narrowest defensible defaults** in migrations `20261027120000_company_review.sql` and
`20261027121000_operations_bookings.sql`. None is ATCO-confirmed. Each is a small migration change if ATCO decides otherwise.

| # | Provisional rule now enforced | Decision needed from ATCO |
|---|---|---|
| P11 | Only an active **`super_admin`** may approve or reject a company; `operations` may view registrations only (Phase 1 matrix). | Should operations (or another role) also decide? |
| P12 | Decisions: `pending → approved` and `pending → rejected` (reason required, ≤ 500 chars). Suspension, reinstatement and return-to-pending have **no** application path. | Is a suspension/reinstatement workflow needed, and must a suspension reason be recorded? |
| P13 | A reviewer may not decide on a company they created or belong to. A reviewer needs an active profile. | Confirm conflict-of-interest rule. |
| P14 | The **rejection reason is not shown** to the company (members see only "not approved"). | May companies see the reason? In which language? |
| P15 | Only active admins/bookers of an **approved** company may book. **Individual (non-company) customers cannot book** in production. | Does checkout require an account? Are individuals allowed, and on what terms? |
| P16 | A `company_booker` sees only bookings they created; the `company_admin` sees all of the company's bookings. | Confirm corporate visibility. |
| P17 | ATCO `super_admin` and `operations` see every booking (manifests); `finance` and `boarding_staff` see none yet. | Which staff roles may see passenger names/contact details? |
| P18 | `super_admin` and `operations` may create/edit vessels, routes and sailings; nothing can be deleted. | Who owns schedule changes? Approval for changes after bookings exist? |
| P19 | Booking stores lead passenger name, contact e-mail, contact phone, optional extra names and optional PO reference — no ID numbers. | Which passenger/permit fields are legally required, and their retention period? |
| P20 | A booking only **holds seats** (`reserved`). No price, VAT, payment, ticket, clearance or boarding state is recorded. | Fares, VAT treatment, payment methods and timing, and when a reservation becomes a ticket. |
| P21 | No cancellation or amendment by customers; a cancelled sailing keeps its bookings as reserved. | Cancellation/refund/no-show policy and what happens to bookings on a cancelled sailing. |
| P22 | Seat capacity is entered per sailing by ATCO; a vessel's passenger capacity is optional and caps sailings when recorded. Technical upper bound 1,000. | Confirm vessel capacities and any per-route load limits. |
| P23 | The 4-ticket minimum is shown as information only; bookings are not blocked or cancelled when it is not met. | What happens operationally when the minimum is not reached? |
| P24 | Platform roles are granted only out-of-band by the database owner (`supabase/scripts/provision_platform_role.sql`). | Who authorises staff provisioning and how is it recorded? |

*Recorded 2026-10-27. This section does not represent ATCO approval.*

## Phase 4 checkpoint — internal tickets/boarding, not ATCO approval

| Item | Implemented conservative behavior | ATCO decision outstanding |
|---|---|---|
| Ticket issuance | One reservation ticket per passenger per leg on successful booking, including existing reservations. No payment claim. Unknown names stay NULL. | When must payment or named-passenger identity be required? P20 is extended technically, not commercially approved. |
| Ticket privacy | Only booking creator retrieves tickets/QR; company admins retain existing booking visibility but not a colleague's QR. | Should company admins distribute tickets on behalf of travellers, and under what consent/security rules? |
| Boarding staff | Active, non-suspended super_admin/operations/boarding_staff can see a minimal manifest and record boarding. No contact email/phone or QR secret in manifest. | Confirm staff responsibilities, passenger fields and retention (P17/P19). |
| Internal readiness | pending/ready/blocked; operations/super_admin records reason and audit. Boarding fails closed unless ready. | Confirm operational gate/checklist and readiness invalidation after vessel/schedule edits. This is NOT official marine/port clearance. |
| Minimum four tickets | Shared sailing reservation count warning only; no automatic cancellation or rejection. | Meaning/timing of the threshold remains unresolved (P23). |
| Cancellation | Cancelled ticket/sailing cannot board; no new customer cancellation, refund or exception override path. | Define cancellation/refund/no-show and post-boarding corrections. |
| Manual QR entry | Staff can enter ticket reference or paste opaque QR payload. Camera not connected in production. | Identity/physical ticket handover procedures; camera support to test separately. |
| E–H | Materials, charter requests, company invitations/member management and notifications remain incomplete. | Review statuses/roles, invite expiry/delivery and notification recipients must be agreed during those features. |

Phase 4 local database and browser verification is recorded in
[phase4-operational-platform.md](backend/phase4-operational-platform.md). No hosted
configuration was changed. Safe internal tracking must not be presented as a legal
permit, verified payment, ATCO sign-off or production readiness.

## Phase 8 — decisions implemented as configurable, provisional defaults (2026-10-28)

None of these is ATCO-approved. Each is a setting, policy or tariff version that an authorised
ATCO role changes through the app (audited) — no code change needed.

| # | Provisional default | Where | ATCO decision required |
|---|---|---|---|
| P25 | Fare SAR 500 / passenger / one-way leg, VAT `not_configured` (no VAT charged) | tariff `BASE-2026-ATCO-PENDING` | Approve tariff; VAT treatment and rate; route-specific fares |
| P26 | Return departures 08:00 / 10:30 / 14:00 (outbound + 60 min) | `schedule_templates` | Real return times, vessels, capacities, anchorage destinations |
| P27 | Minimum counts paid + on-account tickets only (reservations shown separately) | `sailing.minimum_counts` | Which tickets qualify |
| P28 | Confirmation deadline 24 h before departure; below minimum → ATCO decides proceed or cancel | `booking.confirmation_deadline_hours` | Deadline and default outcome |
| P29 | Unpaid pay-now hold 30 min | `booking.payment_hold_minutes` | Hold length |
| P30 | Customer online change/cancel cut-off 24 h | `booking.customer_change_cutoff_hours` | Cut-off; fees |
| P31 | Refunds never automatic; need an approved refund policy and two people | `decide_refund` | Refund policy text and amounts (cancellation, weather, minimum not met, no-show) |
| P32 | Boarding requires paid/on-account booking + readiness + Master go + port clearance | `boarding.*` | Checkpoint list; who records the Master's decision |
| P33 | No commission rate seeded; settlements pay 0 until a rule is approved | `agent_commission_rules` | Agent remuneration model |
| P34 | Credit only when Finance sets limit + terms and activates; overdue blocks on-account | organizations credit fields | Credit policy |
| P35 | Every material request needs a staff safety review; dangerous goods need a permit reference; delivery proof = signature or photo | `materials_safety` policy | Carriage rules, insurance, proof standard |
| P36 | Material tariffs per kg SAR 5 and flat SAR 500 (provisional, not binding) | `material_tariffs` | Material pricing |
| P37 | Privacy response target 30 days; retention periods unset | `privacy.response_days`, `data_retention_policies` | Legal retention periods and privacy notice |
| P38 | Transactional e-mail on by default (opt-out); SMS/WhatsApp opt-in with consent version; all channels disabled | `notifications.channels` | Providers and consent wording |
| P39 | Staff MFA enforcement off locally | `security.staff_mfa_required` | Turn on for staging/production |
