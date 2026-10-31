-- =============================================================================
-- Data-integrity backstops (production-readiness audit, area 1: race conditions).
--
-- Every write path already checks these limits under a row lock; these CHECK
-- constraints make the database itself refuse a violation even if a future code
-- path forgets the check. Existing data was verified to satisfy them; NOT VALID
-- + VALIDATE keeps the lock short on a populated production table.
-- =============================================================================

-- Material payload booked on a sailing can never exceed the sailing's payload limit.
alter table public.sailings
  add constraint sailings_payload_not_over_capacity
  check (payload_capacity_kg is null or payload_booked_kg <= payload_capacity_kg) not valid;
alter table public.sailings validate constraint sailings_payload_not_over_capacity;

-- An invoice can never be paid below zero or above its total (no double-recorded bank payments).
alter table public.invoices
  add constraint invoices_amount_paid_within_total
  check (amount_paid_halala >= 0 and amount_paid_halala <= total_halala) not valid;
alter table public.invoices validate constraint invoices_amount_paid_within_total;
