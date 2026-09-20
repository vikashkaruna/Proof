# Saved implementation session — 21 September 2026

This is the logical checkpoint after integrating staging `ea27df9` and closing the managed-service/MFA/reconciliation gaps. The commit containing this file is the resume baseline; fetch staging before changing anything. See Doc 14 for progress and Doc 11 Revision 11 for current status.

## Workspace and authorization

- Worktree: `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`, branch `codex/w0-w3-closure`.
- User authorizes implementation in W0 → W1 → W2 order, then W3 where possible, with incremental commits/merges/pushes to staging and handoff updates.
- Preserve the root checkout and Claude worktree. Claude still has an uncommitted `docs/08_DEPLOYMENT_GUIDE.md` change; it was not copied or edited here.
- No subagents requested. No cloud apply, billable resource, irreversible lock or live estate execution was performed.

## Completed at this checkpoint

Integrated upstream action-content MFA binding, session/address budgets, 0022 retired RPCs, 0023 operator reconciliation, deployment/environment generation and self-hosted Auth/PostgREST artifacts. Added 0024 service-role RLS policies for managed PostgreSQL and 0025 atomic audited reconciliation with old-token revocation. Added execution capability enforcement and correct MFA rate-limit responses. Expanded real Auth acceptance beyond quarantine to enrollment/login/recovery/approval/content/session/budget flows. Disabled unverified public signup in self-hosted deployment defaults and required TLS for runtime Cloud SQL connections.

Validation: 254 BFF tests plus typecheck/lint; full database/migration/DSN suites and concurrency tests; real self-hosted topology with service role lacking BYPASSRLS; four-label real MFA parity; format/Terraform checks. CI must also pass for the final staging head. All evidence is local/CI unless explicitly stated otherwise.

## Next implementation sequence

1. **W0 acceptance / deployment:** review actual Cloud SQL role ownership and runtime role separation, bootstrap upgrade behavior, SMTP/invitation configuration, public ingress and secrets. Prepare concrete dry-run/deploy artifacts; honor the accepted no-billable/irreversible constraint. Self-hosted Storage is a schema contract only. GCS sealing needs a native readback verifier and an approved locked bucket before live evidence can be claimed.
2. **W1 safety:** make approval issuance transactional (locked action/plan snapshot + challenge consumption + token/action writes + ledger), with fault and concurrent-edit tests. Current hash comparison catches changes before the read, but does not close the read-to-write race. Carry content/snapshot authority into execution. Then key rotation/deployment and strict browser persona journeys.
3. **W2:** implement the Doc 11 table/model slices with tenant-consistent foreign keys, RLS and upgrade tests; highest next vertical slice is estate/system/engagement linkage. Do not recreate existing regulatory/MFA/operational tables.
4. **W3:** normalize stored onboarding proposals into estates/systems, resumable wizard and authorized live graph. Real connectors/executor/rollback/halt remain W4/W5 prerequisites for Phase 3 acceptance.

The eight PRD B.10 live execution scenarios belong to Phase 3 acceptance; API MFA success is not their completion. R06 still needs populated provenance and a named human citation sign-off. W0, W1 and W2 are **partial**, not complete.

## Operational state

- Docker Desktop project `axiom-w0-parity`: API 56321, DB 56322; migrations through 0025. Existing other Supabase projects preserved.
- Credentials remain in ignored `.axiom-runtime/parity/status.json` and protected logs; never print or commit them. Parity reports contain only outcomes.
- `scripts/test-database.sh` creates/removes its own container and removes BYPASSRLS only in that disposable database.
- `tests/deployment/selfhosted-supabase.sh` creates/removes a separate network and GoTrue/PostgREST/Postgres/gateway stack. It tests disabled public signup plus authenticated admin provisioning.
- No worker retries an outbox intent. Human release revokes old outstanding approvals; every redelivery needs fresh approval. Reconciliation and ledger proof now commit together.
- MFA policy/runbook: [operator guidance](audits/08-mfa-operator-policy.md).

Suggested resume commands: `git status --short`, `git fetch origin staging`, inspect new commits and Doc 14, then merge without force. Applied SQL history through 0025 must remain unchanged; allocate the next migration only after checking staging.
