-- ─────────────────────────────────────────────────────────────────────
-- 0013_mfa_ledger_and_challenge_consumption.sql
-- Ledger vocabulary for MFA, and single-use consumption of a satisfied
-- challenge (W1 · SEC-8).
--
-- Two gaps left by 0012:
--
-- 1. `ledger_action_type` had no MFA values, so enrolment and step-up
--    outcomes could only be written to application logs. FR-7.3 requires
--    the approver's identity to be *recorded*, and the step-up is what
--    makes that identity claim mean anything stronger than "a session
--    cookie was present". It belongs in the tamper-evident chain, beside
--    the approval it authorises — not in a log file that the same
--    operator can edit.
--
-- 2. `mfa_challenges` distinguished only unsatisfied from satisfied. A
--    satisfied challenge with no consumption marker can be presented
--    twice, which would let ONE step-up authorise TWO approval tokens —
--    exactly the replay the binding columns exist to prevent, arriving
--    through the other door. Consumption is now a separate, atomic,
--    once-only transition.
-- ─────────────────────────────────────────────────────────────────────

alter type ledger_action_type add value if not exists 'mfa.factor.enrolled';
alter type ledger_action_type add value if not exists 'mfa.factor.activated';
alter type ledger_action_type add value if not exists 'mfa.factor.revoked';
alter type ledger_action_type add value if not exists 'mfa.challenge.issued';
alter type ledger_action_type add value if not exists 'mfa.challenge.satisfied';
alter type ledger_action_type add value if not exists 'mfa.challenge.failed';
alter type ledger_action_type add value if not exists 'mfa.recovery_code.consumed';

-- ─── Single-use consumption ──────────────────────────────────────────
-- `satisfied_at` records that the human proved the factor. `consumed_at`
-- records that the proof was spent on a specific act. They are different
-- events and collapsing them loses the property that matters: a step-up
-- authorises one approval, not a session's worth of them.
alter table public.mfa_challenges
  add column if not exists consumed_at timestamptz,
  add column if not exists consumed_for text;

comment on column public.mfa_challenges.consumed_at is
  'Set once, atomically, when the satisfied challenge is spent. A second attempt to spend it finds a non-null value and is refused.';

comment on column public.mfa_challenges.consumed_for is
  'The resource the proof was spent on — the approval token id for an approval_issuance step-up. Lets a reviewer walk from an approval back to the authentication that authorised it.';

alter table public.mfa_challenges
  add constraint mfa_challenge_consumed_implies_satisfied
    check (consumed_at is null or satisfied_at is not null);

-- The lookup the approve path performs: this user's satisfied, unconsumed,
-- unexpired challenge for this purpose.
create index if not exists mfa_challenges_spendable_idx
  on public.mfa_challenges (user_id, purpose, expires_at)
  where satisfied_at is not null and consumed_at is null;
