# W0 operational handoff

These steps accompany migrations 0016–0018. They do not attest that a deployment has been migrated or that W0 is complete. Preserve migration 0015 for the analyst enum patch carried in Claude's worktree.

## Organization creation entitlements

Onboarding now denies accounts without an explicit, active entitlement. This replaces the global `AXIOM_MAX_TENANTS_PER_USER` environment setting and unrestricted paid-tier selection. The BFF allows five valid onboarding attempts per user per hour, shared across replicas. Invalid payloads are rejected before provisioning. Idempotent replays do not spend another quota slot or rate-limit attempt.

An authorized operator grants the contractual tier(s), owned-tenant limit and expiry using a privileged database connection. Record the approving human and approval/ticket reference. Do not give client roles write access to the entitlement table or service-role credentials. There is no public self-entitlement endpoint. Example using **psql variables supplied by the operator**, not literal production identities:

```sql
insert into public.onboarding_entitlements
  (user_id, max_owned_tenants, allowed_tiers, granted_by, grant_reason, valid_until)
values
  (:'recipient_id'::uuid, :'tenant_limit'::integer,
   array[:'contracted_tier'::public.tenant_tier], :'approving_human_id'::uuid,
   :'approval_reference', :'expiry'::timestamptz);
```

Both identities must already exist in `public.users`. An expired or revoked entitlement refuses new onboarding; it does not remove existing memberships. Any change to a grant must retain the operator's external approval record until the W1 administration/audit workflow is implemented. Revoke by setting `revoked_at`; do not delete customer or ledger rows to reclaim quota. No entitlements were granted to live users during implementation.

Creation also requires the BFF's `LIBRARY_VERSION` to be published as current with its complete control catalogue in the target database. Missing/stale/incomplete publication returns `library_not_published` without creating anything; follow the control-library publication procedure instead of silently downgrading the assessment version. W7's full baseline-hash/publication parity remains pending.

Successful creation atomically writes the tenant, owner membership, engagement, DPO/proposed-system intake and `tenant.created` ledger entry. Proposed systems are not connected systems: the response exposes `intake.status=pending_estate_setup` and an empty `systems` array. W3 must normalize this saved intake into estate inventory and perform connection verification. The sensitive intake is service-only pending role-scoped BFF access in W1/W3.

## Request claims and interrupted operations

The BFF requires an Idempotency-Key for mutations. Migration 0017 gives every user/tenant/path/method/key a durable claim bound to request content and session authority. A completed response can be replayed for 24 hours. A conflicting body/role/session, concurrent claim, or expired replay window never starts another mutation under the key.

An interrupted handler or lost response may leave a claim `in_progress`. Do not delete the claim or ask the client to use a new key until the operation's durable outcome has been reconciled. Do not issue direct SQL updates to execution or approval records as a retry shortcut. Automated reconciliation/outbox handling is still pending for execution workflows; this milestone guarantees refusal of duplicate dispatch, not automatic crash recovery.

Response bodies are stored in the service-only table and may include sensitive material. Apply the planned retention policy to response content separately from deduplication tombstones; deleting an old key without a separate tombstone would permit the same operation to run again. A cleanup/reconciliation job is not yet shipped.

## Verification and deployment scope

`scripts/test-database.sh` creates and removes its own Docker PostgreSQL container, applies every migration and runs direct-client authority, idempotency, onboarding, ledger-failure and multi-session race tests. It never resets an existing local or hosted database. Auth/Storage schema fixtures in this suite are not evidence of real GoTrue/PostgREST or deployed parity.

CI runs on staging pushes. A green staging code build is not a cloud deployment: migrations, actual secrets, real-auth E2E, storage retention verification and deployment smoke checks remain required before W0 acceptance. No cloud deployment or irreversible bucket lock has been performed in these milestones.

## MFA secret deployment

`AXIOM_MFA_ENCRYPTION_KEY` is now wired to the BFF through local/staging/preprod/production Compose, Helm's `<release>-internal` Secret key `mfa-encryption-key`, and preprod Cloud Run Secret Manager. Environment examples, `sync-env.sh` verification/Terraform/secret mappings and deployment secret discovery include it. Keep it distinct from approval and service tokens; hardened boot rejects reuse and known placeholder values. `AXIOM_MFA_SESSION_TTL_HOURS` remains 12 by default.

Preprod Terraform generates persistent random internal/MFA secrets when no supplied value exists, replacing committed fallback signing/runtime keys. Supplied values are preserved. Plan and review key changes before rollout: replacing an MFA key without re-encrypting existing TOTP factors makes them unreadable. No key rotation or cloud apply was performed here; the re-encryption/key-version workflow remains W1 work. Keep Terraform state and environment files in their protected stores.

The production Compose overlay now explicitly declares production topology and removes the worker's dependency on the disabled local Temporal service. Supply the real Temporal Cloud endpoint/credentials for that deployment.

## Confirmed deployment direction

The user confirmed on 20 September 2026: use an isolated Supabase Auth/PostgreSQL stack in local Docker Desktop for verification; higher environments must provision their Supabase deployment dynamically through deployment scripts. Do not depend on manually supplied existing Supabase projects. The current legacy Compose and Cloud SQL migration scripts still need replacement/integration: placeholder cloud endpoints and success-on-migration-failure behavior are not accepted deployment evidence.
