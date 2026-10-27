# Gulf Mover — Phase 2: authentication hardening and company onboarding

> **Status:** frontend implementation on branch `feature/phase2-company-onboarding`
> (based on `backend/phase1` @ `6f87014`). Verified with mocked Supabase only — **no
> live Supabase project, real account or database was used**, and no migration was
> created or applied. This is not production approval; see "What remains" below.

## 1. What is complete

### 1.1 Authentication audit fixes (production mode)

| Audit item | Fix | Where |
|---|---|---|
| Reset link could land on the home page | New `/auth/reset-callback` route with a dedicated new-password screen. The provider snapshots the redirect URL before the SDK consumes it, tracks the Supabase `PASSWORD_RECOVERY` event, and `RecoveryRedirect` sends any recovery session to the new-password screen, wherever the link landed. The password is set with the existing `updatePassword` service call. | `src/lib/recoveryLink.ts`, `src/pages/PasswordRecoveryView.tsx`, `src/App.tsx`, `src/context/AuthContext.tsx` |
| Expired / invalid / missing recovery links | `error_code` redirects (e.g. `otp_expired`), links that yield no session and direct visits never show the form and never claim success; a session lost during the update withdraws the form (`errRecoveryExpired`). | same |
| `getSession()` race with the auth subscription | A generation counter: every auth event and every context sign-in/up/out advances it; the initial restore result is applied only if nothing newer happened while it was in flight. Results after unmount are ignored. | `SupabaseAuthProvider` |
| Unavailable auth returned `null` (success) | Production sign-in, sign-up, reset request and sign-out return `errAuthUnavailable`; `AuthNotAvailableError` thrown at call time maps to the same; network failures map to `errAuthNetwork`; password change without a session returns `errSessionRequired`. | `AuthContext.tsx` |
| Sign-in label promised username login | Production label is "Email" (`type=email`); a non-email is rejected before any request; wrong credentials use the new email-only `errSignInEmail`. The demo keeps "Email or username". | `AuthView.tsx` |
| Confirmation-pending notice not cleared | Cleared by every real session (auth event, restore, sign-in/up) and by sign-out. After a production sign-up without a session the view switches to sign-in with the address filled in and the notice shown. | `AuthContext.tsx`, `AuthView.tsx` |
| Sign-out claimed success on failure | `signOut()` now returns `Promise<AuthError \| null>`; the session is cleared only after Supabase confirms. The account menu and Settings show `errSignOutFailed` and stay on the page. Demo sign-out is unchanged (resolves `null`). | `AuthContext.tsx`, `Layout.tsx`, `SettingsView.tsx` |
| Production sign-up collected a company and dropped it | Production sign-up no longer shows the company field; companies are registered after sign-in through the RPC. The optional name becomes Supabase user metadata, as before. | `AuthView.tsx` |
| Credentials/tokens in logs | No new logging. Error texts are fixed translation keys; database/Auth messages are classified, never displayed. A test asserts passwords and session tokens never reach `console.*`. | tests |

### 1.2 Company registration (production mode)

* **Service** `src/lib/companyService.ts` — the *only* write is `rpc('register_company', …)` with exactly the nine
  declared parameters (`p_registration_key`, `p_legal_name`, `p_profile_display_name`, `p_display_name`,
  `p_registration_number`, `p_billing_contact`, `p_contact_email`, `p_contact_phone`, `p_language`). No user id,
  role, status or approval value is ever sent; no protected table is written directly; RLS is not bypassed.
* **Validation** mirrors the RPC exactly (required legal name and person name; provisional caps 200/80/200/64/200
  counted in characters like PostgreSQL `length()`; the RPC's e-mail and phone patterns; `en`/`ar`). The server
  remains authoritative and its `22023` messages are mapped to the matching field without showing database text.
* **Idempotency** — one random v4 UUID per registration attempt, kept in `sessionStorage`
  (`gm-registration-attempt:<userId>`, a UUID only — no company data, no credentials) until the server confirms
  success. Every retry, including after a reload, reuses it, so an uncertain network failure followed by a retry
  gets `outcome='replayed'` instead of a second company. A `payload_mismatch` (an earlier attempt with this key
  already succeeded with different details) re-reads the real status instead of creating anything.
* **No anonymous calls** — the service requires an SDK session before calling the RPC or reading status; users
  awaiting e-mail confirmation have no session and are routed to sign-in.
* **Duplicate clicks** — a synchronous in-flight guard plus a disabled button and fieldset.
* **Error mapping** — `28000` (suspended / not authenticated), `22023` (field / payload mismatch), `42501` (key of
  another user → new key), `40001` (retry), `PGRST202` (RPC not deployed), JWT errors, HTTP 0 and 5xx (uncertain).

### 1.3 Onboarding states

Read through the caller's own session (RLS decides visibility): `profiles.status`, own
`organization_memberships` with embedded `organizations`, and own platform `role_assignments`.

| State | How it is detected | What the user sees |
|---|---|---|
| Signed out | no session | redirected to sign-in |
| Awaiting e-mail confirmation | sign-up returned no session | "Check your email" on sign-in; nothing protected is called |
| Authenticated, no company | no memberships, no platform role | registration form |
| Submitting | in-flight request | disabled form, "Submitting registration…" |
| Pending approval | active membership + visible `pending` organisation | "Awaiting ATCO approval", no booking promise, "Check status again" |
| Approved | active membership + visible `approved` organisation | "Company approved by ATCO" + note that live bookings are not connected |
| Restricted | membership exists but the organisation is hidden by RLS, or membership suspended | contact ATCO |
| Invited | membership `invited` | invitation acceptance not available yet |
| Account suspended | `profiles.status = 'suspended'` | contact ATCO, no form |
| ATCO staff | active platform role, no membership | registration not needed; staff tools still demo |

Existing members are never shown the form. Production sign-in lands on `/onboarding`; a production-only
"Company" navigation entry and a scope notice on every other page ("Live in this build: sign-in and company
registration only…") keep demo-data screens from looking like connected production features.

## 2. What is genuinely connected vs. demo-only

| Connected to Supabase (production mode) | Still demo data only |
|---|---|
| Sign-up, sign-in, sign-out, session restore, password reset e-mail, recovery callback, in-session password change | Booking, My Bookings/tickets, fares, sailings, fleet |
| Company registration via `register_company` | Corporate/agent workspace, operations, boarding, materials |
| Onboarding status (profile, memberships, organisation status, platform roles) | Profile/company/notification settings cards (hidden in production) |

Demo mode (no `VITE_APP_MODE=production`) is unchanged: no Supabase client is created, demo login/sign-up/guest
and provider simulations work as before, and `/onboarding` only explains that registration is a production feature.

## 3. Unresolved decisions and blockers (not invented here)

1. **Rejected vs suspended cannot be distinguished by a company member.** The provisional visibility rule (A20,
   `20261026162000_active_org_ids_visibility.sql`) hides rejected and suspended organisations from members, so
   the client only knows "membership exists, organisation hidden". The UI says so honestly ("Restricted").
   *Smallest change, if ATCO wants members to see the reason:* a new, narrowly scoped `SECURITY DEFINER`
   read-only RPC (e.g. `my_company_memberships()`) returning, for `auth.uid()`'s own memberships only, the
   organisation id, name, status and `rejection_reason` — with `EXECUTE` for `authenticated` only and no change
   to existing policies. **Not created and not applied**; needs ATCO to decide what rejected/suspended companies
   may see.
2. **Profile provisioning (A12)** — no sign-up trigger exists; the RPC creates the profile on the first
   registration. Users without a company therefore have no `profiles` row; the app treats a missing profile as
   "active, no company", which matches the RPC's behaviour. Whether a profile should exist from sign-up is still
   an ATCO/YZ decision.
3. **Provisional RPC rules P1–P10** (`docs/atco-pending-business-rules.md`) are enforced as-is, including P1
   (several companies per user). The UI deliberately does *not* offer "register another company" to existing
   members.
4. **Supabase dashboard prerequisites (not changed here):** the reset redirect
   (`VITE_AUTH_RESET_REDIRECT_URL`, e.g. `https://<origin>/auth/reset-callback`) must be on the Auth redirect
   allow-list. The local `supabase/config.toml` lists `site_url = http://127.0.0.1:3000` and
   `additional_redirect_urls = ["https://127.0.0.1:3000"]`; whether the local callback path is accepted must be
   verified against the local stack. Local `enable_confirmations = false` means local sign-ups get a session
   immediately; production confirmation behaviour depends on the hosted project's settings.
5. **Invitations, company-detail edits, approval workflow and staff tools** have no application path yet
   (A2/A3/A11/A13) and are not presented as working.

## 4. What remains before ATCO use

* Run the new flows against the **local** Supabase stack (real GoTrue sign-up/confirmation/recovery e-mails via
  Inbucket, real RLS reads, RPC replay) and record results — not possible in this environment.
* ATCO decisions: section 3 items, P1–P10, A1–A20.
* An ATCO staff approval workflow (super_admin lifecycle changes are console-only today).
* Production booking backend; every customer/staff screen beyond onboarding is still demo data.
* Hosting, e-mail provider/SMTP, domain and redirect configuration; security review and penetration test.
