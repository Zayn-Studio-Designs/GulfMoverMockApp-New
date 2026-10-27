# Gulf Mover — Phase 1 SQL Review Guide (Corrected draft — nothing applied)

> **Status of these drafts: theoretical only.** No Supabase project exists yet, no database has received these files, and no security claim is verified. Everything in this document describes proposed behaviour. Only after Stage C approval, when these files are applied to a real development database and the test plan has actually run, may any behaviour be described as working — and then only with the test results attached.
>
> **Applied corrections (2026-10-26, approved decisions):** `jsonb_typeof` fix; seed `created_by` values plus a consistent Company A approval history; the dead manual event insert removed; helper `p_user` parameters removed and `has_any_role` dropped; an explicit `UPDATE` grant added on organizations for the approval workflow; `role_assignments`, `approval_events` and `platform_settings` are read-only through the app (their unused write policies removed; deferred workflows documented as A10–A14). Nothing has been executed; static checks only — see §6.

Files under review (`backend/phase1` branch, uncommitted by design):

| File | What it is |
|---|---|
| `supabase/migrations/20261026144000_identity.sql` | Table structures, immutability guards, audit hooks (renamed 2026-10-26 from `0001_identity.sql` for Supabase CLI timestamp-filename compatibility; SQL unchanged) |
| `supabase/migrations/20261026144001_rls_policies.sql` | Row Level Security: default-deny, per-role rules, helper functions (renamed 2026-10-26 from `0002_rls_policies.sql` for Supabase CLI timestamp-filename compatibility; SQL unchanged) |
| `supabase/seed_demo.sql` | **Fictional** demo companies/users for development tests |
| `supabase/migrations/20261026150240_privilege_hardening.sql` | **DRAFT, not applied.** Replaces the default-privilege blanket table grants with the exact minimal grants the approved matrix intends (see §4.2). Carries no explicit BEGIN/COMMIT — Supabase's migration workflow manages the (default) transaction wrapper itself |

---

## 1. Plain-English: what each table does

| Table | In plain English | Rows are visible to |
|---|---|---|
| `profiles` | The name, phone and language choice attached to each signed-in account. Its id equals the Supabase Auth user id, one-to-one. | The person themselves; `super_admin`. Nobody sees someone else's profile. |
| `organizations` | A company that wants to book. Starts `pending` ("awaiting ATCO"), can be approved/rejected/suspended. Return to `pending` is provisionally supported and audited as a fresh `submitted` event; `suspended → approved` is provisionally audited as `reinstated` (§4.1 — development assumptions, not ATCO-confirmed). | ATCO `super_admin` & `operations`; and people who are members of that company. **Deliberately not** finance, per the blueprint's warning that finance should not automatically see identity data. |
| `organization_memberships` | Which person acts for which company, as company_admin or company_booker. Deliberately can only contain those two roles — there is no field that could ever make someone an ATCO insider. | Own memberships; members of the same company; ATCO `super_admin`/`operations`. |
| `role_assignments` | **The only** place platform (ATCO) roles exist. A browser can *never* gain one: the table is read-only for the application, and only provisioning (seed/migrations/console) adds rows (A11). | Own rows; `super_admin`. |
| `approval_events` | The decision log: who decided what about which entity, when, with the reason. Append-only by design — no update/delete grants or policies, and no app insert path either: the audit trigger in 0001 is the only producer (A14). | ATCO `super_admin`, `operations`, `finance` (audit-read); the company whose items were decided. |
| `platform_settings` | Config data such as "corporate approval mode". In Phase 1 this is **stored configuration only** — nothing reads or enforces it; ATCO changes values in the console (A1/A13). | Any signed-in user (it contains no secrets — read-only to them); console-only writes in Phase 1 (A13). |

## 2. Plain-English: how the security rules are met

**2.1 Nobody can grant themselves ATCO staff or super_admin privileges.**
Three independent walls, on purpose:
- *Structure:* the membership table's check constraint only accepts `company_admin`/`company_booker`. There is no legitimate place to write "operations" for a company user.
- *Policy:* `role_assignments` has **no** write path for application roles in Phase 1 — no insert/update/delete policy and no such grant. Platform roles are provisioned by migrations/seed or the console as the owner role. When a real staff-management workflow is built, its write policies will be gated on `has_platform_role('{super_admin}')` (server-side — the browser's opinion of itself is never consulted) and will still exclude `super_admin` rows.
- *Hierarchy guard (0001 trigger):* even a real super_admin session cannot create, edit or delete a `super_admin` row from the application. Those rows are provisioned by migration only, which is the break-glass answer.

**2.2 No cross-company data access.** Every org-scoped policy asks "is the calling user an active member of *that* row's organization?" via a server-side helper. A user could type Company B's ID into their own browser all day; the database answers the question from `organization_memberships`, not from the request.

**2.3 No self-organization approval.** Insert policy forces `status = 'pending'` at creation; only the `super_admin` update policy can move lifecycle state; and each transition is auto-logged by the audit event trigger — including a change back to `pending`, which is provisionally audited as a `submitted` resubmission event (§4.1, provisional mapping). Draft `20261026170000_split_org_audit_triggers.sql` splits that single trigger into an AFTER insert/update event-logging trigger (so a row skipped by `ON CONFLICT DO NOTHING` can never log an event) plus a separate BEFORE UPDATE metadata-stamping trigger (§4.3). A company user could try every field value — the row is rejected unless it arrives pending.

**2.4 Append-only approval events.** The table gets no `INSERT`/`UPDATE`/`DELETE` grant and has no such policies: no application role can write — or forge — history. The only producer is the audit event trigger (defined in 0001; retargeted to AFTER insert/update by draft `20261026170000_split_org_audit_triggers.sql`), running as the table's owner with a server-derived actor (`auth.uid()` of the acting approver).

**2.5 The browser is never trusted.** Roles, approval state and membership all come from database tables through helpers. The server-verified identity `auth.uid()` is the only input used.

**2.6 Function, ownership and recursion review (required checklist):**
- Helpers are `SECURITY DEFINER set search_path = ''`: they compile against a fixed schema; unqualified names inside them *fail* rather than opportunistically resolve to something unexpected.
- `EXECUTE` on every helper is revoked from `public`/`anon` and granted to `authenticated`.
- Policies never query the table they protect directly — cross-table checks flow through the definer helpers, which is the standard cure for the membership-table self-referencing RLS recursion loop.
- Tables are owned by the Supabase admin role; the app always connects as `authenticated`, which is not the owner — so RLS cannot be "accidentally skipped" like it can for a table's owner (that is also why no `FORCE ROW LEVEL SECURITY` rush is needed, though adding it later is harmless).
- Triggers that write audit rows run as definer so a plain approver still produces an event without needing direct insert rights on the audit table.

**2.7 No service-role or secret key in browser code.** Nothing in this draft involves keys at all. When the app is wired up (Stage D, not this stage), only the *publishable* key gets shipped to the browser, and the secret/service key stays server-side. RLS is what limits the publishable key's power — that is the design point.

## 3. Role-permission matrix (proposed for Module 1 only)

Legend: ✅ allowed · ➖ nothing · R read rows filtered to relevant · (n/a = never applicable)

| Table | Action | company booker | company admin | boarding staff | operations | finance | super_admin |
|---|---|---|---|---|---|---|---|
| profiles | select | own | own | ➖ | ➖ | ➖ | all |
| profiles | insert | own | own | ➖ | ➖ | ➖ | (via signup, self) |
| profiles | update | own (status locked) | own (status locked) | ➖ | ➖ | ➖ | incl. suspend |
| organizations | select | own company only | own company only | ➖ | all | ➖ **deliberately** | all |
| organizations | insert | own self, `pending` only | own self, `pending` only | ➖ | ➖ | ➖ | n/a (seeded) |
| organizations | update | ➖ | ➖ | ➖ | ➖ (review payments only) | ➖ | lifecycle + contacts |
| organization_memberships | select | own + same company | own + same company | ➖ | all | ➖ | all |
| organization_memberships | insert | ➖ | add booker to own company (cannot add self, must record self as inviter) | ➖ | ➖ | ➖ | any |
| organization_memberships | update | ➖ | ➖ | ➖ | ➖ | ➖ | all |
| organization_memberships | delete | ➖ | remove booker of own company only | ➖ | ➖ | ➖ | all |
| role_assignments | select | own | own | own | own | own | all |
| role_assignments | insert/update/delete | ➖ (read-only via app — A11) | ➖ (read-only via app — A11) | ➖ (read-only via app — A11) | ➖ (read-only via app — A11) | ➖ (read-only via app — A11) | ➖ (read-only via app — A11; provisioned by seed/console) |
| approval_events | select | own company's | own company's | ➖ | all | all | all |
| approval_events | insert | ➖ (trigger-produced — A14) | ➖ (trigger-produced — A14) | ➖ | ➖ (trigger-produced — A14) | ➖ (trigger-produced — A14) | ➖ (trigger-produced — A14) |
| approval_events | update/delete | **impossible for everyone** | — | — | — | — | — |
| platform_settings | select | yes (read-only) | yes | yes | yes | yes | yes |
| platform_settings | update | ➖ (console-only — A13) | ➖ (console-only — A13) | ➖ (console-only — A13) | ➖ (console-only — A13) | ➖ (console-only — A13) | ➖ (console-only — A13) |

Design note on finance: the blueprint says finance reviews *evidence and payment records*, not unrestricted identity data; the matrix reflects that, and it is listed as assumption A5 for confirmation.

## 4. Assumptions and unresolved business decisions (configurable, not blocking)

| # | Assumption / decision | Where it lives | Needs decision from |
|---|---|---|---|
| A1 | Corporate approval = manual review by ATCO; `auto_approve=false`. | `platform_settings` row (data); production values **not decided** | ATCO |
| A2 | Company admin cannot create other admins in Module 1 (only super_admin promotes). | insert policy design | ATCO |
| A3 | Companies cannot edit their own organization contacts yet (Module 1 keeps write surface minimal). Editing comes with the onboarding module. | functions/policy design (note 0001 comment) | ATCO, then Stage C2 |
| A4 | Company bookers can be deleted by their own admin; admins cannot delete themselves or their colleagues' admin rows. | delete policy | ATCO |
| A5 | Finance does **not** see organization profiles (payments only). | select policy | ATCO |
| A6 | Approval-event corrections (e.g. a mistaken audit row) are an out-of-band service role operation with its own procedure; no application role ever edits history. | design decision (documented) | YZ at dev-time, then ATCO |
| A7 | `platform_settings` readable to signed-in users but not to signed-out visitors. If the sign-up screen later needs to show what the approval path is, we would revisit exposing a specific key publicly. | select policy | YZ then ATCO |
| A8 | Language preference (en/ar) is stored but no localized app content changes live in tables (Phase 1 scope). | n/a | ATCO? no — informational |
| A9 | Agents (`shipping agent`) role label exists but no workflow is granted beyond company-scope lookups; agent behaviour is a later module. | role vocabulary | ATCO §14 |
| A10 | A `submitted` audit event is recorded only when a genuinely *pending* organization is inserted (0001 trigger guard). A pre-approved/imported organization — like seeded Company A — invents no submission; its history is whatever the inserting data records. No production "imported / pre-approved organization" workflow is defined. | 0001 audit function (AFTER event trigger per draft 20261026170000) + seed history | ATCO |
| A11 | Platform/ATCO roles are read-only through the app in Phase 1: no write policies or write grants, provisioning by seed/migrations/console only. An app-path staff-management workflow is deferred and arrives with its own policies. | 0002 grant + policy design | YZ, then ATCO |
| A12 | The sign-up → profile-creation flow is unresolved: no auto-provision trigger exists; the app must create the profile after first sign-up (Stage D), and the seed writes fictional profiles for testing. | profiles policies + seed profiles | YZ/ATCO |
| A13 | Corporate approval remains **stored configuration** with no enforcement; ATCO flips values in the console. A settings screen and any enforcement logic are Stage D. Also: console org-lifecycle work must run as a signed-in ATCO session — the audit trigger requires an actor. | platform_settings design | ATCO |
| A14 | Direct app inserts into `approval_events` are deferred; at application runtime the audit trigger is the only producer of event rows. Privileged development seeding may also insert historical events (the demo seed does exactly that — see T19); such inserts are a seeding capability, not an app-facing write path. | 0002 grant/policy design | YZ then ATCO |
| A16 | **Provisional (implemented in the drafts; NOT confirmed by ATCO).** Returning an organization to `pending` — `approved → pending`, `rejected → pending` or `suspended → pending` — is audited as the existing `submitted` decision with reason `Returned to pending from <old status>`; the event vocabulary is unchanged and `pending` was not added to the decision check. The pre-fix behaviour (audit-check abort on every return-to-pending UPDATE) was a static-only finding. | 0001 audit function (AFTER event trigger per draft 20261026170000) | ATCO |
| A17 | **Provisional.** `suspended → approved` is treated as reinstatement and audited as a `reinstated` event; this is currently the only producer of that vocabulary word. | 0001 audit function (AFTER event trigger per draft 20261026170000) | ATCO |
| A18 | **Provisional.** Blueprint column names `approved_by`/`approved_at` are retained; their meaning is "the most recent *successful* approval": stamped only when status transitions into `approved` (including reinstatement), never overwritten by a rejection, suspension or return to pending. Documented in column comments. | 0001 trigger split (stamp BEFORE / events AFTER) per draft 20261026170000 + column comments | ATCO |
| A19 | **Provisional.** Contact-information-only edits produce no approval event (matches the blueprint's status-transition audit requirement). | 0001 audit function (AFTER event trigger per draft 20261026170000) | ATCO |
| A20 | **Provisional — APPROVED FOR DEVELOPMENT ONLY, NOT confirmed by ATCO (2026-10-26).** Organisation visibility from company members follows the `active_org_ids()` rule: members see APPROVED organisations they belong to (active membership), members see THEIR OWN pending organisation, and REJECTED/SUSPENDED organisations are hidden from company members. ATCO staff visibility is unchanged (their own platform-role policy arms). Implemented by `20261026162000_active_org_ids_visibility.sql` (draft — not yet applied), which `create or replace`s the helper with the same signature/EXECUTE attributes. This fixes the static finding that the pre-fix helper passed any organisation with *any* active company_admin member regardless of status — effectively leaking rejected/suspended organisations to staff — while also making the helper too narrow the other way (a `pending` company with no admin member was invisible even to its submitter). The final production rule still needs ATCO confirmation (the earlier §1 wording "people who are members of that company" is deliberately narrower than this row). | 0002 helper + new migration | ATCO (pending) |

Nothing above blocks implementation; A1–A3 just remember to be revisited before any production data exists.

### 4.1 Provisional lifecycle implementation (recorded 2026-10-26 — decisions taken for development, NOT confirmed by ATCO, nothing executed)

This section records what was **implemented in the drafts** after the open review. Everything describes written SQL only; none of it has run against PostgreSQL.

**1. Returning to `pending` — implemented as option (a), provisionally (A16).**
The pre-fix behaviour was a confirmed static defect: `log_organization_status_changes()` wrote the event's `decision` straight from the new status, so `approved → pending`, `rejected → pending` and `suspended → pending` all attempted `decision = 'pending'` against the `approval_events.decision` check (which allows only `submitted / approved / rejected / suspended / reinstated`), aborting the whole UPDATE. The fix keeps the vocabulary unchanged and maps a transition into `pending` to the existing `submitted` decision with reason `Returned to pending from <old status>`, preserving before/after status snapshots and `auth.uid()` actor attribution. The INSERT-trigger behaviour for newly created pending organizations is untouched.

**2. Reinstatement — implemented provisionally (A17).**
`old.status = 'suspended' and new.status = 'approved'` now audits a `reinstated` event instead of `approved`. This is currently the only producer of that word; whether reinstatement is really a distinct workflow remains an ATCO question.

**3. Approval metadata — implemented provisionally (A18).**
Column names kept as the blueprint writes them (`approved_by`, `approved_at`); their meaning is now explicit — **the most recent successful approval**: stamped only when the organization transitions into `approved` (including reinstatement), never overwritten by a rejection, suspension or return to pending. Rejection timestamps/actors exist only in the event log. Documented in the live SQL through `comment on column` statements.

**4. Contact-only edits — behaviour unchanged, explicitly documented (A19).**
The trigger only reacts to status changes; a `super_admin` contact-information edit produces no approval event. Recorded as a development assumption for ATCO to confirm.

**5. Status of all four items:** development assumptions coded into the drafts, marked A16–A19 in the §4 table. None is an approved production rule; ATCO has confirmed none of them. The pre-fix defect never ran on a server, and the fix has not either — §5's T20–T25 define the acceptance tests for exactly these behaviours.

---

### 4.2 Organisation-visibility rule — provisionally implemented (A20, 2026-10-26; not applied, not executed)

`20261026162000_active_org_ids_visibility.sql` replaces the deployed `active_org_ids()` with the A19-approved provisional rule (dev-only):

- **Approved org you belong to** (active membership) → visible.
- **Your own pending org** → visible; "your own" = caller-scoped, via the caller's own active-membership arm — no admin-exists escape hatch.
- **Rejected / suspended** → hidden from company members on the helper's three call sites (organizations select, memberships select, approval_events select).
- **ATCO staff** → unchanged; their visibility comes from platform-role policy arms, not this helper.
- **Return-to-pending** → org becomes visible to its active members again (status check is unconditional on history).

Everything in this section is written SQL only; no behaviour has been executed. Regression tests: T2b–T2e in §5.

T0 was run **for real** against the local native-runtime database (read-only catalog queries only; nothing modified). The full executed results are in the Stage C T0 report; the material finding is here because it changes the drafts' grant story:

**Executed finding — grant source analysis.** The six Module-1 tables each carry a direct ACL of `{postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}` — the codes mean INSERT/SELECT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, i.e. *everything*, including for `anon`. Verified with `aclexplode`:

- The excessive privileges are **direct ACL entries on each table**, held by `anon`, `authenticated` and `service_role`.
- **PUBLIC holds nothing** on these tables (checked explicitly — zero rows), so no PUBLIC grant was or needs to be touched.
- The source is **default privileges**: `pg_default_acl` shows both owning roles (`postgres`, `supabase_admin`) with namespace-scope defaults in `public` that grant the same full set to `anon`/`authenticated`/`service_role` at table-creation time. This is the Supabase local runtime mirroring cloud default exposure — every future public table inherits this unless migrations say otherwise.

**Why that breaks the intended matrix (§3):**

1. *TRUNCATE is live for `anon`/`authenticated` on every table* — and **RLS never applies to TRUNCATE**, so the "update/delete impossible for everyone" invariant (approval_events, role_assignments) was not physically true at the grant layer. PostgREST does not expose TRUNCATE and the anon/authenticated credentials cannot log into Postgres directly, which limits practical reach, but the draft's text claimed a stronger guarantee than grants delivered.
2. *Write grants on the three read-only tables* mean T8–T12 currently fail at the **RLS policy layer** (no policies exist there), not at the **SQL privilege layer** as the test rows claimed — same outcome, wrong documented mechanism, and privilege-check-only T0 passes would have looked correct by accident.
3. *REFERENCES / TRIGGER / MAINTAIN* on the audit log and role table exceed anything the design granted (attach-trigger / FK / maintenance surface).

**The response — hardening migration draft (not applied).** `20261026150240_privilege_hardening.sql` revokes *all* table privileges `anon`/`authenticated` hold on the six tables, then re-grants exactly the approved minimum to `authenticated` only (profiles/orgs/org-memberships: SELECT+INSERT+UPDATE, memberships +DELETE; role_assignments/approval_events/platform_settings: SELECT only), leaves `service_role`/`postgres`/functions/USAGE/RLS untouched, and documents that **future migrations creating public tables must carry their own REVOKE/GRANT block** because default privileges are deliberately out of scope here (open decision for YZ — hardening the defaults is a later, bigger lever).

Two final pre-apply corrections, 2026-10-26, in response to review:

- The `approval_events` `comment on table` was rewritten to distinguish **who writes event rows and from where**: the SECURITY DEFINER audit trigger `log_organization_status_changes()` is the **normal application-runtime producer** of approval events, while **privileged development seeding may insert historical events** (the demo seed does exactly that — matching A14's clarified wording above). The app-role restrictions themselves are unchanged in the comment: anon holds no privileges at all, authenticated holds SELECT only, and no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN for app roles (RLS never applies to TRUNCATE, so grants are the only wall there). The owner (postgres) and service_role keep console-level access, and the trigger's write capability is untouched.
- The explicit `begin;` / `commit;` statements were **removed from the migration**. Supabase's normal migration workflow wraps each migration's execution in a transaction by default; an in-file `commit;` could close that wrapper transaction early (and might error outright if the CLI already holds a transaction open — this is one of the things T-apply is expected to confirm against the real CLI/runtime). The statements themselves are untouched — all grant/revoke logic is identical apart from the COMMit-wall removal and the comment wording.

**Untouched verdicts confirmed during T0:** helper EXECUTE revoked from anon / granted to authenticated ✅; all three helpers plus the audit and guard trigger functions are SECURITY DEFINER with `set search_path = ''` ✅ (the draft `20261026170000` trigger split adds `stamp_organization_approval_metadata()` as a fourth SECURITY DEFINER trigger function with the same properties — drafted, not yet deployed) (one hygiene asymmetry: `guard_organizations_insert_by_user()` is invoker with no pinned search path — harmless by body inspection, flagged, unchanged); RLS enabled on all six tables, FORCE RLS off, matching §2.6's non-owner rationale ✅; audit trigger function owner == approval_events owner (postgres) ✅.

### 4.3 Audit-trigger split for seed idempotency (2026-10-26; approved for local development, NOT applied, nothing executed)

**Executed Stage-C finding.** The first `seed_demo.sql` run against the local database produced exactly the expected state. The second run reported `INSERT 0 0` on every statement yet added a duplicate Company B `submitted` approval event (id `b758ee4c-769b-4f23-b440-0f8b58f96a8f`). Root cause (PostgreSQL-defined behaviour, verified against the deployed definitions): row-level BEFORE INSERT triggers fire even for rows that `ON CONFLICT DO NOTHING` later skips, while row-level AFTER triggers fire only for rows actually inserted — the old combined `trg_organizations_audit` was a BEFORE INSERT OR UPDATE trigger, so every no-op re-seed of the existing pending organisation logged a phantom `submitted` event through its SECURITY DEFINER path.

**Approved fix — draft `20261026170000_split_org_audit_triggers.sql`:**
- The old trigger is dropped FIRST, then the responsibilities are split: `trg_organizations_audit_events` = **AFTER INSERT or UPDATE** (all event logging with the unchanged A10/A16/A17 mapping, reasons, `{status:…}` snapshots and `auth.uid()` attribution), and `trg_organizations_audit_stamp` = **BEFORE UPDATE** (`approved_by`/`approved_at` stamping, A18 — must stay BEFORE so it can write NEW into the stored row; fresh INSERTs never stamped and still do not).
- SECURITY DEFINER + empty `search_path` + function permissions are preserved (`create or replace` keeps ACLs); the logging function keeps its name, so the `approval_events`/column comments stay accurate.
- **App-table trigger inventory: 8 → 9.** Verified 2026-10-26 by catalog query: the six Module-1 tables currently carry exactly 8 deployed external triggers (profiles ×2, organizations ×3, memberships ×1, role_assignments ×2; storage-bucket/object tables carry their own unrelated triggers). The split makes 9.
- **Timestamp note:** `20261026170000` is deliberately future-dated relative to the 15:58 UTC authoring clock so it strictly follows the last applied `20261026162000` — the lexicographic == chronological convention that migration itself already set.
- **The duplicate event `b758ee4c…` REMAINS in the local database** pending a separately approved single-row cleanup (`delete from approval_events where id = 'b758ee4c-…'`) after this migration is applied. The migration itself does not delete it.

## 5. Test plan (to actually run, not to describe)

All of these will be **executed and evidenced** once a dev database exists (tests, not claims):

| # | Test name | Given | When | Then |
|---|---|---|---|---|
| T0 | Effective privilege matrix | applied schema **including `20261026150240_privilege_hardening.sql`** | for each table × verb run `has_table_privilege(...)` for anon/authenticated — verbs: **SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN** (MAINTAIN probing confirmed supported on the local PG 17.11, 2026-10-26); check schema usage and helper EXECUTE | **exactly** the §4.2 minimums — authenticated: profiles/orgs SEL+INS+UPD, memberships SEL+INS+UPD+DEL, roles/events/settings SEL only; anon: no table privileges at all; and **MAINTAIN = false for anon and authenticated on all six tables** (as must TRUNCATE/REFERENCES/TRIGGER). `revoke all privileges` is expected to clear MAINTAIN in PG 17 (`grant/revoke all privileges` includes MAINTAIN), but that shorthand set is verified by this executed matrix, not assumed — if any MAINTAIN cell survives, append an explicit `revoke maintain` line in a follow-up migration. A T0 run against a database *without* the hardening migration tests Supabase defaults, not this design — both grantees' versions must be recorded separately |
| T0b | Helper signatures | applied schema | query `pg_proc` / `\df` for the three helpers | exactly `active_org_ids()`, `has_org_role(uuid, text[])`, `has_platform_role(text[])`; no wider variants exist |
| T0c | Search-path resolution | authenticated test session | call each helper | boolean/set returned without error — confirms resolution under `set search_path = ''` |
| T1 | Self profile read | Company A admin signed in | select profiles | exactly 1 row — own |
| T2 | **Cross-company org read** | Company A booker signed in | select organizations | only Company A; Company B invisible |
| T2b | Approved-org member read | Company A member (admin or booker) | select `organizations` (Company A `approved` + their active membership) | exactly 1 row — Company A |
| T2c | Own pending-org read | Company B booker (no admin member exists) | select `organizations` | exactly 1 row — their own `pending` organisation (the pre-fix helper returned 0 rows here) |
| T2d | Non-approved org hidden | any company member | organisation in `rejected` or `suspended` state | invisible via `select organizations`, member-scoped `organization_memberships`, AND member-scoped `approval_events` (the helper's three call sites) |
| T2e | Cross-company + ATCO unchanged | Company A member vs Company B; ATCO ops user | both select `organizations` / `approval_events` | Company A member sees neither Company B rows nor B's events (isolation holds); ATCO ops keeps its authorised rows — unchanged by the A19 migration |
| T3 | **Cross-company membership read** | Company A booker | select memberships | no Company B rows |
| T4 | Self-approve attempt | Company B booker | insert organizations with status='approved' | row rejected |
| T5 | Cross-company edit | Company A admin | update Company B organization | 0 rows affected |
| T6 | Admin adds booker | Company A admin | insert membership | succeeds; memberships count +1 and **approval_events delta = 0** (no trigger or grant lets app roles write events; the org audit trigger is the only producer) |
| T7 | **Self-elevation via membership** | Company A admin | *any* way to add "operations" | system rejects (constraint before policy) |
| T8 | Role insert as ordinary user | Company B booker | insert into role_assignments everything | privilege-layer failure first: role_assignments is SELECT-only for authenticated (hardening migration) — `permission denied`; even where a grant existed, no policy would match → RLS denial |
| T9 | Roles are unwritable for app roles | super_admin session | insert any role_assignments row | permission denied (no INSERT grant after hardening) — A11; the 0001 hierarchy guard remains a second wall for any future write path |
| T10 | Super admin cannot modify roles via the app | super_admin session | update/delete role rows | permission denied (no UPDATE/DELETE grant after hardening) — Phase 1 roles are read-only via the app (A11) |
| T11 | **Event tampering** | super_admin session | update an approval event | permission denied — no UPDATE grant after hardening, and no UPDATE policy exists; *both* layers reject independently |
| T12 | Event forging | Company A admin | insert event, actor = anyone | permission denied — no INSERT grant after hardening and no INSERT policy; the audit trigger is the only producer (A14) |
| T13 | **Non-admin delete denied** (clarified) | Company A booker | delete any membership row — their own, the admin's, Company B's (via guessed IDs) | **0 rows affected each time, no error** (policy `using` filters rows out) |
| T14 | Anon access — privilege layer | anon / visitor | select any of the six tables, direct SQL | **`permission denied for table` on all six** — no SELECT grant post-hardening; NOT "0 rows". Separately record T14-API: the real PostgREST status/body for an anon-token read (executed in Phase E, no assumed error code) |
| T15 | Configurable approval (console only) | super_admin in the SQL editor | flip `corporate_approval.mode` | value changes (console runs as the owner); the app path has no UPDATE grant — settings workflow deferred (A13) |

Escape-hatch tests (negative controls, prove *nothing accidentally grants access*):

**Layering rule for every test that writes (applies after the hardening migration):** a write on a table the session *has no grant for* must fail at the **SQL privilege layer** (`permission denied for table`); a write the session *has a grant for* but whose rows are disallowed must fail at the **RLS layer** (policy/row rejection). Both are denials, but the layer matters — a privilege check alone **never** proves RLS behaviour, only T-table-verdict rows executed inside real signed-in sessions do.
| T16 | Empty policy state | fresh db | select orgs signed in | 0 rows |
| T17 | Tricked search path | a helper emulating an injected schema resolution | select | nothing resolves through injected schemas — all references are schema-qualified or `pg_catalog` |
| T18 | Trigger audit behaviour | company user inserts a pending org via the app; super_admin then moves it through the lifecycle | inspect approval_events | exactly one `submitted` event per *inserted* pending row (post-split: the event logger is an AFTER INSERT/UPDATE trigger, so conflict-skipped rows log nothing); each transition writes exactly one decision event with a server-derived actor; `approved_by`/`approved_at` stamped on approval; other transitions log their state's own decision word; return-to-`pending` and reinstatement behaviour is staged separately in T20–T25 (§4.1) |
| T19 | Seed idempotency (zero drift) | seed run twice or more | capture row counts AND the full `approval_events` set (id, subject, decision, reason, actor, occurred_at) before reruns; rerun; diff | **zero drift after every rerun** — all six table counts and the whole event set byte-identical to the baseline: a rerun adds zero events. Repeated `submitted` events are NOT globally forbidden (return-to-pending is a legitimate fresh `submitted`, T20–T22); the invariant is zero drift. At the current seeded state the expected history is otherwise: orgs=2, profiles=5, memberships=3, role_assignments=2, platform_settings=1, approval_events=3 — Company A `submitted` + `approved`, Company B `submitted` once. The Stage-C duplicate `b758ee4c…` (§4.3) must be cleaned by the separately approved step before this row can pass |

Lifecycle-correction tests (§4.1 provisional behaviour — each asserts both the `approval_events` row written *and* what happens to `organizations.approved_by`/`approved_at`):
| T20 | Return to pending (from approved) | org in `approved` with approval metadata recorded | super_admin sets status `pending` | one new event: `decision = 'submitted'`, reason `Returned to pending from approved`, actor = acting super_admin, before/after status snapshots; `approved_by`/`approved_at` unchanged |
| T21 | Return to pending (from rejected) | org in `rejected` | super_admin sets status `pending` | event `submitted`, reason `Returned to pending from rejected`; approval metadata unchanged |
| T22 | Return to pending (from suspended) | org in `suspended` | super_admin sets status `pending` | event `submitted`, reason `Returned to pending from suspended`; approval metadata unchanged |
| T23 | Reinstatement | org in `suspended` (earlier approval metadata present) | super_admin sets status `approved` | event `decision = 'reinstated'` (not `approved`); `approved_by`/`approved_at` re-stamped by the acting actor |
| T24 | Rejection preserves approval metadata | org in `approved` with metadata | super_admin sets status `rejected` | event `decision = 'rejected'` with `rejection_reason`; `approved_by`/`approved_at` still show the earlier approval — unchanged by this transition |
| T25 | Contact-only edit is not audited | any org | super_admin updates `contact_phone` only (no status change) | update succeeds; `approval_events` row count unchanged |

Additional automated checks after Stage D: the full existing app test suite must still pass with demo fallback, and a browser-level security sweep (cross-company login switch) must be re-run manually and screenshotted into `docs/test-results.md`.

## 6. What is theoretical versus actually executed

- Theoretical (this stage): every security property described above.
- Executed (2026-10-26, Stage C, read-only): **T0 ground-truth catalog audit** — migration history, per-table ACLs (`relacl`/`aclexplode`), `pg_default_acl` sources, helper signatures/security/owners, RLS state, audit-trigger definition — see §4.2. **No behaviour test (T1–T25 or T0c) has run; nothing about what a signed-in session can actually read or write is proven.**
- Drafted, NOT applied: `20261026150240_privilege_hardening.sql` (table-grant hardening; §4.2; final corrections committed: approval_events comment wording, no in-file BEGIN/COMMIT — the CLI runs the migration inside its own default transaction wrapper). Until it is applied and T0 is re-run, the live grant state remains the Supabase default-everything state.
- Executed (2026-10-26, Stage C, local database): seed run #1 produced the full expected state; seed run #2 exposed a real idempotency bug — the BEFORE audit trigger logged a duplicate Jannah `submitted` event (`b758ee4c…`) for the `ON CONFLICT DO NOTHING`-skipped insert (§4.3). The duplicate row is STILL in the local database, pending separate cleanup approval; nothing has been deleted or reset.
- Drafted, approved for local dev, NOT applied: `20261026170000_split_org_audit_triggers.sql` (§4.3) — splits the organisation audit trigger into a BEFORE UPDATE stamping trigger + AFTER insert/update event-logging trigger; app-table trigger inventory 8 → 9.
- Executed (past sessions, unrelated to backend): the mock app's own test suite and build runs.
- Static text checks actually run locally (2026-10-26, no database involved): no remaining references to `pg_jsonb_typeof`, `p_user` or `has_any_role`; helper REVOKE/GRANT lines match the exact new signatures; every policy call site matches a helper signature; every seed user lookup resolves to a declared fictional `.invalid` email; `created_by`, `approved_by` and `approved_at` cover both organization inserts; the org audit trigger logs `submitted` only for pending inserts; no application INSERT/UPDATE/DELETE remains for `role_assignments`, `approval_events` or `platform_settings` (A11/A13/A14), while `organizations` gained exactly the one UPDATE grant its approval workflow needs.
- Static lifecycle finding corrected in the drafts (2026-10-26, text-only): the earlier finding that return-to-`pending` transitions aborted against the `approval_events.decision` check is now provisionally fixed (A16–A18): a decision `case` mapping (`pending` → `submitted` with reason, `suspended → approved` → `reinstated`, else the state's own word), metadata stamped only on transition into `approved`, and the check vocabulary left untouched (`'pending'` was **not** added). Static checks confirm the `case` can only emit values inside the check. Nothing executed against PostgreSQL; behaviour remains theoretical until T20–T25 run.
- **Not** performed (requires PostgreSQL — Stage C): SQL statement parsing/execution on a server, any RLS or trigger behaviour, the T0 privilege ground-truth check, real signature resolution, or idempotency execution.
- **Nothing about RLS, policies or permissions has been validated anywhere yet.** There is no database, so no code in this package executes. No promise of verified security is being made; the SQL is a review artifact.
- The moment a Stage C database exists, the test matrix in §5 is executed for real, and greens/reds recorded in `docs/test-results.md` before anyone claims anything is secure.

## 7. Known design trade-offs to be aware of (for informed approval)

1. `security definer` helpers are a trusted surface: only three exist, each locked to fixed `set search_path = ''`. This is the community-standard way to avoid recursive policy checking (the "typical way" to search memberships within their own policy).
2. The hierarchy guard trigger is application-level; a *super* privileged operator can still bypass it from the console — intentionally, for break-glass changes, but that process is manual and audited by Git (docs), not the DB runtime.
3. Only the six Phase 1 tables exist yet. Booking, tickets, payments, cargo and the rest arrive in later modules, each with its own policies under the same RLS pattern.
