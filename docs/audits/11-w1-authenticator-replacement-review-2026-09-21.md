# Review — W1 authenticator replacement, and what the refusal was hiding

Reviewed staging `ad2d046` and accepted the estate foundation (0029), the
browser harness privilege separation and the approval-page hydration fix. Their
suites were rerun here rather than inherited: the estate SQL suite, the
populated 0028→0029 upgrade, `engagement-estate.test.ts`, all four strict
parity labels and the full browser suite are green on this branch.

## Accepted without change

0029's composite foreign keys hold tenant consistency for administrative writes
as claimed, its service policies work with `service_role nobypassrls`, and the
scan-state check constraint refuses a completion earlier than its own start.
The engagement API's `estateId` is gated by the existing capability and a
foreign estate is refused by the database rather than by a trusted parameter.
The harness's administrative Supabase key is confined to the BFF, and reverting
the `AgentIcon` markup does fail the new browser-runtime-error assertion.

Nothing in this review asked that work to change.

## The finding

Review 10 recorded the next item accurately and, as it turns out, incompletely:

> the current Replace authenticator button never obtains the required
> enrollment-purpose challenge; the BFF correctly rejects it

Both halves are true. The conclusion drawn from them — that the UI was the
whole of the gap — was not, and the reason is worth recording because it is a
general shape rather than a one-off.

**A control that refuses everything is indistinguishable from a control that
works.** Because the button never sent `mfaChallengeId`, no request in the
product's history had ever cleared the enrolment gate. Nothing had therefore
ever reached the code path behind it. That path was broken too:

`user_mfa_factors_one_active_totp` (migration 0012) is UNIQUE on `user_id`
WHERE `factor_type = 'totp' AND status = 'active'`. `activateTotpEnrolment`
promoted the pending factor with a bare UPDATE and never retired the factor
being replaced, so activation raised `23505` the moment a user already held
one. Replacement could not complete at any layer. Worse, the service mapped
that unique violation onto `no_pending_factor` — rendered to the user as "No
enrolment is in progress" — which names the wrong layer and would have sent an
operator looking at enrolment state for a constraint violation.

Fixing only the UI, as the handoff's next-chunk list implied, would have
converted a clean refusal into a confusing one and moved the failure later in
the flow, after the user had already been shown a new secret.

**Where the coverage was.** `POST /v1/mfa/enrol` had no route-level test at
all. The service suite proved the challenge machinery and the approval suite
proved the approval gate; nothing asked the enrolment endpoint what it does
when a factor already exists. The in-memory PostgREST double was also more
permissive than the database — it had no notion of the unique index — so the
bare UPDATE passed every unit test that existed and would have passed any new
one written against the double as it stood.

## Second-order finding: the journeys the fix needed

The browser journeys written for this were first drafted against two new seeded
personas, in the style of the existing ones. They passed, then failed on the
immediately following run.

Enrolment, replacement and recovery-code consumption are all state transitions
on the account itself. A journey that borrows a seeded persona passes once, on
a freshly seeded database, and fails every time after. Under `retries: 2` in
CI that surfaces as a first attempt passing and both retries failing, or as a
green first run and a red rerun on an unchanged commit — which reads as a
product flake rather than a fixture defect.

`createApprovablePlan` already encodes the rule for plans, for exactly this
reason. The journeys now provision their own accounts, and were confirmed
re-runnable by running them twice in succession against an already-mutated
database.

## What was changed

Migration **0030** adds `activate_totp_factor`, which retires the replaced
factor and activates the new one under one set of row locks. Neither order
works from outside a transaction, and the reason revoke-then-activate is unsafe
is not only lockout: a first enrolment is deliberately not step-up gated, so an
account left with no active factor by a fault between two statements is an
account a stolen session can enrol its own device on. That is the
revoke-then-re-enrol chain the enrolment gate exists to break.

The security page opens the `enrolment` challenge, satisfies it with the
current authenticator or a recovery code, and spends it on the new enrolment.
It carries a per-attempt `Idempotency-Key`; it is the third caller of
`/v1/mfa/challenge`, and the bridge's derived key is fixed for its body.
`BeginMfaEnrolmentRequestSchema` now declares `mfaChallengeId` rather than the
route reading it off the raw body.

Coverage added: seven route tests, a SQL suite for 0030 that also asserts the
unique index still bites, and five browser journeys. The PostgREST double now
models the index and raises on a violation the way Postgres does.

## Not proven here

This is the replacement path only. Login-MFA enrolment under quarantine, factor
revocation through the UI, and any notion of invalidating live session
attestations when a factor is replaced are untouched.

The last of those is an open decision rather than an oversight. Replacing an
authenticator with a recovery code means the user did not have their device;
whether that should end sessions attested by the retired factor is a posture
question with a real cost either way, and it is recorded in Doc 11 for a
decision rather than answered here.

No cloud apply, no connector execution, and no change to any deployed instance.
