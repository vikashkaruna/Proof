# W0 → W1 → W2 → W3 implementation progress

Started 20 September 2026 with authorisation to implement in order and commit/merge/push each verified milestone to staging. Goal remains active until the complete acceptance criteria are proved. Revision 9 review/handoff documents are the starting requirements, not a claim of current completion.

Implementation worktree: `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`, branch `codex/w0-w3-closure`, based on staging `2c54fcd`. Claude's original worktree and three unfinished analyst files remain unchanged. Migration number 0015 is reserved for that analyst patch; W0 security uses 0016.

## Delivered milestones

| Milestone                           | Staging commit | Evidence                                                            |
| ----------------------------------- | -------------- | ------------------------------------------------------------------- |
| Review baseline and ordered handoff | `87e8c5b`      | Fast-forwarded and pushed to remote staging; no application changes |

## W0 milestone: direct-client and invocation authority

Committed as `207957b` and pushed to staging. Its CI run `35506935027` failed fetching the database image from public ECR (rate limit), before database tests ran:

- Append-only migration 0016 removes client write authority from domain/safety tables, protects internal identity columns, removes blanket internal cross-tenant RLS bypass and preserves safe profile bootstrap.
- Ledger mutations remain through `append_ledger`; service-role direct writes are denied and ledger_writer retains INSERT-only privilege.
- Generic agent invocation validates tenant/engagement, enforces capability/internal-agent boundaries, refuses direct Karya calls and fails closed if its run cannot be persisted. Raw request inputs are no longer stored in run metadata.
- Disposable PostgreSQL runner applies the complete migration series and tests direct client privileges/RLS. Auth/Storage are contract fixtures in this suite; it does not replace real-auth E2E.
- CI now triggers on staging as well as main and gates later jobs on database security tests. Web ESLint rejects service-role imports.

Local evidence: BFF 127 tests pass; BFF typecheck passes; real PostgreSQL fresh migrations and denial assertions pass. The positive ledger-RPC regression also passes; web lint, security/control gates and diff whitespace checks pass. Historical review documents were formatted to satisfy the repository CI gate.

## W0 milestone: durable idempotency

Committed as `2834f9d` and pushed to staging. CI [35507335231](https://github.com/vikashkaruna/Proof/actions/runs/35507335231) is green for the full configured lane (including database security, lint/typecheck, TS/Python tests and security scan). The eight-session database race admits exactly one claim.

Migration 0017 adds the previously missing request-claim store and service-only RPCs. The BFF now claims a key before running a mutation, binds it to user/tenant/route/body/query/role/scopes/session, rejects competing or conflicting uses, and replays only completed results. Database failure cannot silently disable this gate. Expired or interrupted claims are retained and refused, not automatically re-executed; operational reconciliation of interrupted requests remains necessary. Response bodies may contain sensitive results and require the planned retention/cleanup policy.

Verification: 132 BFF tests and typecheck pass. Fresh PostgreSQL migrations, client-authority and claim/replay assertions pass. The database runner now uses the pinned Docker Hub image with the same-version ECR mirror as a download fallback, addressing the first milestone's infrastructure-only CI failure. This suite uses real PostgreSQL roles/RLS with Auth schema fixtures; real JWT/E2E parity remains open.

## W0 milestone: atomic, entitled onboarding

Committed as `f532aae` and pushed to staging. Full configured CI [35507651395](https://github.com/vikashkaruna/Proof/actions/runs/35507651395) is green. Multi-session tests create exactly one organization at quota 1 and allow exactly three attempts at rate limit 3.

Migration 0018 adds service-only, time-bound onboarding entitlements, a shared fixed-window rate limiter and saved DPO/proposed-system intake. The BFF calls an atomic transaction for tier/quota checks, tenant + owner + initial assessment + intake + genesis ledger. The published library must match the BFF version and contain the declared control count. No live entitlements were granted. [Operator setup and interrupted-request handling](audits/05-w0-operations.md) are documented for deployment.

Verification: 141 BFF tests and typecheck pass; real PostgreSQL tests prove entitlement/tier/expiry/revocation refusal, completeness checks, saved intake, quota/rate limits and full rollback when the ledger fails. W3 estate normalization remains pending; submitted systems are retained as proposals and no longer echoed as connected inventory.

## W0 milestone: credential wiring and expiry gates

Committed as `6aff4bd` and pushed to staging. Full configured CI [35508723074](https://github.com/vikashkaruna/Proof/actions/runs/35508723074) is green.

The BFF MFA encryption key is wired through Compose, Helm, Secret Manager/Terraform and environment sync. Hardened configuration refuses Supabase placeholders and MFA/signing-key reuse; preprod internal secret defaults are generated and persistent. The production Compose topology/dependency issue found during validation is corrected. Missing, malformed and expired dry-run timestamps now block approval and execution before token consumption.

Verification: 44 configuration tests and 147 BFF tests pass, with BFF typecheck green. Preprod Terraform initialized with backend disabled and validates; no plan/apply or secret rotation occurred. Staging, preprod and production Compose configuration checks pass after correcting the production overlay’s pre-existing dependency on a disabled Temporal service. Helm template wiring is reviewed but Helm is not installed locally.

User direction: local Docker Desktop hosts the isolated real Supabase parity stack; higher-environment scripts must dynamically provision Supabase. Implementation of that deployment/parity path is next.

## W0 milestone: real local Auth/PostgREST parity and migration runner

Committed as `2a75c15` and pushed to staging. Its real Auth/PostgREST parity CI job passed. The separate migration-runner regression job exposed a missing `rg` executable on the Ubuntu runner; assertions were switched to portable `grep`, with a follow-up CI run required for the complete lane.

An isolated Docker Desktop Supabase project `axiom-w0-parity` is running on API port 56321 (database 56322). Existing `axiom-proof` and other local projects were preserved. `scripts/start-parity-supabase.sh` starts this project without demo seeds; credentials/logs remain in ignored, protected `.axiom-runtime/parity` state.

The real startup found an incompatibility hidden by SQL fixtures: historical migration 0000 touches Auth-owned tables and cannot run under the CLI's restricted migration role. `scripts/migrate-database.py` applies unchanged files after Supabase initializes, using its administration role. It serializes runners, records source checksums, makes each migration/tracker write atomic and refuses changed history. Database regressions prove second-run no-ops, checksum refusal and rollback of injected failing DDL. No applied migration was rewritten.

`scripts/test-strict-parity.sh` passes locally across staging, preprod, production and onprem labels, using the real complete BFF middleware chain against real password sessions and PostgREST/RLS. Every label produces identical outcomes for absent/synthetic authentication, takeover cookie, own-tenant reads with real engagement rows, foreign-tenant/resource denial, direct self-promotion refusal, viewer invocation refusal, owner MFA quarantine, mandatory idempotency, durable replay/conflict and missing-entitlement refusal. This covers an API security matrix; browser persona journeys and full real MFA enrolment/step-up remain W1 acceptance work. The CLI stack is local test infrastructure, not a claim of cloud deployment.

A new required CI lane runs this matrix on an isolated Supabase stack. Higher-environment dynamic provisioning and replacement of legacy fail-open deployment scripts remain next; the new local runner alone does not fulfill that part of the user's instruction.

## Remaining acceptance work — do not mark whole workstreams complete yet

**W0:** finish strict environment/real-auth parity, deployed verification of the new operational tables/idempotency/onboarding controls, live secret verification, shared in-flight halt/guard tests, verified evidence retention and all required security regressions. Preserve the complete W0 exit criteria; local policy tests alone do not prove deployed parity.

**W1 (after W0):** incorporate analyst WIP coherently with tests/seeds, complete role enforcement and RLS/session-MFA boundaries, TOTP + email OTP/recovery delivery, deployment/key rotation and persona E2E. Default analyst access remains assigned tenants; email OTP remains planned until explicitly deferred.

**W2 (after W1):** complete every table/model slice listed in Doc 11, migration upgrades, scoped relationships and RLS, action/batch identity, data retention and schema/runtime contracts. Do not recreate regulatory/MFA tables already present.

**W3:** estate/onboarding and live ER graph as capacity allows after W0–W2. No claim of completion yet.

Push without force; re-fetch staging and preserve any concurrent changes before each integration. No deployment or irreversible bucket lock has been performed so far.
