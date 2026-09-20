# W0 operational handoff

These steps accompany migrations 0016–0018. They do not attest that a deployment has been migrated or that W0 is complete. Migration 0015 analyst is now committed; execution corrections extend the series through 0021.

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

## Local real-auth parity commands

Run `./scripts/test-strict-parity.sh` from the repository root. It starts the dedicated `axiom-w0-parity` Docker project on ports 56321–56329, applies migrations with the privileged database administration role, creates synthetic test identities through real GoTrue, and compares actual BFF/PostgREST security outcomes under all four hardened environment labels. It neither reads customer data nor resets the existing local Supabase projects. Requires Docker Desktop, Supabase CLI (CI pins 2.116.0), Python 3, Node and installed pnpm dependencies.

`./scripts/start-parity-supabase.sh` starts/migrates without running the persona requests. Restarting it does not replay already-applied migrations. `.axiom-runtime/parity/status.json` holds the local keys with mode 0600; never commit or paste it into handoffs. Synthetic fixtures persist for inspection. To stop only this project, use `supabase stop --workdir .axiom-runtime/parity`; do not run a blanket Docker cleanup.

The migration runner does not adopt untracked existing schemas or ignore duplicate-table errors. For a fresh Supabase stack it records each source file and SHA-256 in `axiom_migrations.applied`, and it fails if a previously applied file changes. An existing environment must reconcile its prior migration history before switching runners; do not delete its tables to make the runner pass. These checks do not make legacy `migrate-cloudsql.sh` safe until that script is replaced/integrated.

## Execution dispatch reconciliation

Read the service-only `public.pending_execution_dispatches` view for pending, failed and unknown deliveries. `unknown` means the request may have reached the runtime: its action claims remain held. Never clear those claims, reuse the token, reset an idempotency key or start a replacement batch based solely on a lost acknowledgement. `failed` means an explicit refusal (or no request was attempted); the token is still spent and any later execution needs fresh authority. There is no automatic drain/retry worker yet.

`finish_execution_dispatch` atomically records action/outbox outcomes. Repeated/late settlement cannot downgrade a delivered intent. Historical 0019/0020 RPCs remain for migration compatibility, but new callers must use the atomic finalizer. A settlement-storage failure returns 503 with a correlation id and leaves reconciliation necessary. The current runtime stub explicitly refuses execution; no row is evidence that connector effects actually occurred.

## Evidence retention verification

The native S3/MinIO sealing path requires `s3:GetBucketObjectLockConfiguration`, `s3:GetObjectRetention` and, when requested, `s3:GetObjectLegalHold`, in addition to existing write permissions. Apply the reviewed IAM change through the deployment process. A successful seal includes the uploaded version id and confirmed retention date. If upload succeeded but readback failed, an object may remain stored: reconcile it by content hash/key/version; do not automatically upload a replacement or delete evidence.

GCS sealing is blocked until a native adapter establishes locked retention and the requested duration/hold. Do not bypass the failure or claim that a URL/configuration string verifies Bucket Lock. Creating or irreversibly locking a real bucket still needs the concrete deployment decision. The runtime no longer invents local COMPLIANCE proof when storage fails; test/demo callers must inject test storage explicitly and cannot export it as live evidence.
