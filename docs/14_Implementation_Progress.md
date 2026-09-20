# W0 → W1 → W2 → W3 implementation progress

Started 20 September 2026 with authorisation to implement in order and commit/merge/push each verified milestone to staging. Goal remains active until the complete acceptance criteria are proved. Revision 9 review/handoff documents are the starting requirements, not a claim of current completion.

Implementation worktree: `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`, branch `codex/w0-w3-closure`, based on staging `2c54fcd`. Claude's original worktree and three unfinished analyst files remain unchanged. Migration number 0015 is reserved for that analyst patch; W0 security uses 0016.

## Delivered milestones

| Milestone                           | Staging commit | Evidence                                                            |
| ----------------------------------- | -------------- | ------------------------------------------------------------------- |
| Review baseline and ordered handoff | `87e8c5b`      | Fast-forwarded and pushed to remote staging; no application changes |

## W0 milestone: direct-client and invocation authority

Implemented and locally verified; staged for incremental integration:

- Append-only migration 0016 removes client write authority from domain/safety tables, protects internal identity columns, removes blanket internal cross-tenant RLS bypass and preserves safe profile bootstrap.
- Ledger mutations remain through `append_ledger`; service-role direct writes are denied and ledger_writer retains INSERT-only privilege.
- Generic agent invocation validates tenant/engagement, enforces capability/internal-agent boundaries, refuses direct Karya calls and fails closed if its run cannot be persisted. Raw request inputs are no longer stored in run metadata.
- Disposable PostgreSQL runner applies the complete migration series and tests direct client privileges/RLS. Auth/Storage are contract fixtures in this suite; it does not replace real-auth E2E.
- CI now triggers on staging as well as main and gates later jobs on database security tests. Web ESLint rejects service-role imports.

Local evidence: BFF 127 tests pass; BFF typecheck passes; real PostgreSQL fresh migrations and denial assertions pass. The positive ledger-RPC regression also passes; web lint, security/control gates and diff whitespace checks pass. Historical review documents were formatted to satisfy the repository CI gate.

## Remaining acceptance work — do not mark whole workstreams complete yet

**W0:** finish strict environment/real-auth parity, missing operational tables/atomic idempotency, onboarding entitlement/quota/rate limits, deployed secret wiring, expiry edge cases, shared in-flight halt/guard tests, verified evidence retention and all required security regressions. Preserve the complete W0 exit criteria; local policy tests alone do not prove deployed parity.

**W1 (after W0):** incorporate analyst WIP coherently with tests/seeds, complete role enforcement and RLS/session-MFA boundaries, TOTP + email OTP/recovery delivery, deployment/key rotation and persona E2E. Default analyst access remains assigned tenants; email OTP remains planned until explicitly deferred.

**W2 (after W1):** complete every table/model slice listed in Doc 11, migration upgrades, scoped relationships and RLS, action/batch identity, data retention and schema/runtime contracts. Do not recreate regulatory/MFA tables already present.

**W3:** estate/onboarding and live ER graph as capacity allows after W0–W2. No claim of completion yet.

Push without force; re-fetch staging and preserve any concurrent changes before each integration. No deployment or irreversible bucket lock has been performed so far.
