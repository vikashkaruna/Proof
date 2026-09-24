# Reviewed controller credential administration

This is a manual operator CLI for the self-hosted HS256 Auth/PostgREST backend. It creates at most one hour of tenant-bound controller authority and a protected JSON delivery file. It is not a daemon, public API, SPIRE issuer, host installer or application action approver. The controller and workers never receive the signing secret or issuer database login.

The operator must independently review the request bytes, configuration digest, tenant, change-record reference and lifetime. `approvalReference` records that external change review; a UUID or SHA does **not** authenticate a human or replace the application's signed approval/dry-run/rollback rules. Root, the signing operator and database administrators remain trusted. A holder of the backend HS256 signing key has broad signing power; isolate that authority outside all runner hosts.

## Inputs and trust

Apply migrations through **0051** with the migration runner. Migration 0050 creates a private non-login, non-inheriting `axiom_controller_issuer` role and three callable private functions; 0051 makes review hashing portable across existing Supabase and clean PostgreSQL installations. No login or usable runtime membership is provisioned. PostgreSQL may record an ADMIN-only role-creator membership with neither SET nor INHERIT; database administrators remain trusted. Separately reviewed database administration must provision a dedicated operator login able to `SET ROLE axiom_controller_issuer`, with no application/admin role memberships. Never grant it to `authenticator`, `service_role`, the controller or SPIRE services. The CLI always sets the private role inside its transaction.

All configuration/source/review files are canonical absolute paths, current-operator-owned regular files, mode `0600`, with one hard link. Ancestors must be root/operator-owned and not group/world writable. The executable must also have protected canonical ancestry and be root/operator-owned, executable and non-writable by group/world. Run isolated Python on Linux or macOS:

```text
python3 -I issuer.py --issue REVIEW_PATH REVIEW_SHA256 CONFIG_PATH NEW_PRIVATE_OUTPUT_DIRECTORY
python3 -I issuer.py --resume-issue REVIEW_PATH REVIEW_SHA256 CONFIG_PATH EXISTING_PRIVATE_OUTPUT_DIRECTORY
python3 -I issuer.py --revoke REVIEW_PATH REVIEW_SHA256 CONFIG_PATH NEW_PRIVATE_OUTPUT_DIRECTORY
python3 -I issuer.py --resume-revoke REVIEW_PATH REVIEW_SHA256 CONFIG_PATH EXISTING_PRIVATE_OUTPUT_DIRECTORY
```

Use a reviewed SHA from the external change record. Do not derive and automatically trust one on a potentially changed target. No secrets belong in arguments, environment variables, logs, repository files, Terraform state or VM metadata.

Configuration JSON has exactly `schemaVersion: 1`, `psql` (protected executable path), `backendOrigin` (HTTPS origin), and five source descriptors named `service`, `apiKey`, `signingKey`, `backendCa`, `databaseCa`. Each descriptor contains exactly `path` and `sha256`, binding the exact protected bytes. A request's `configurationSha256` binds the raw configuration bytes. No sample carries working credentials.

The service file has one `[axiom-controller-issuer]` section with exactly `host`, `port`, `dbname`, `user`, `password`, `sslmode=verify-full`, `sslrootcert` (the reviewed `databaseCa.path`) and `connect_timeout=5`. Only TCP hosts are allowed. GSS encryption is disabled to force the reviewed TLS path; Unix sockets, weaker TLS, extra service options and ambient libpq settings are refused. Database and HTTPS trust roots are separately reviewed. The backend origin must expose the existing PostgREST tenant-scope RPC; redirects and ambient proxies are refused. Socket, whole-operation and output limits apply.

`apiKey` is the backend's current anonymous HS256 gateway JWT, at most 4096 bytes. `signingKey` is its protected matching HS256 secret; the CLI checks the anonymous role, expiry and signature before minting the exact controller claims. This tool does not provision or rotate the global backend signer. Revocation does not need to read either token/signing source.

## Issue, renew, deliver and retire

An issue review JSON contains exactly `schemaVersion: 1`, `purpose: "controller-backend-issue"`, nonzero canonical UUIDs `credentialId`, `tenantId`, `approvalReference`, `configurationSha256`, `predecessorId` (null for initial issue, prior reviewed credential UUID for renewal), and integer epoch seconds `issuedAt`, `expiresAt`. The lifetime is 300–3600 seconds. A fresh registry entry requires issuance within the previous 300 seconds and more than 60 seconds remaining. Local publication also requires more than 60 seconds remaining.

The CLI creates and fsyncs a fresh `0700` directory with a private lock, exact `request.json`, `intent.json` and `candidate.key` before touching the registry. It registers the reviewed lease, verifies the real backend tenant response, rechecks the registry and protected inputs, then renames the candidate to `backend.key` and writes `ready.json` last. All files are `0600`. The ready receipt is point-in-time evidence, never an ongoing readiness lease. The backend continues to check registration, tenant, expiry and revocation per statement.

`backend.key` contains the existing Revision 72 JSON contract: `schemaVersion`, anonymous `apiKey`, signed controller `accessToken`. Only this file goes into the separate reviewed controller-file delivery procedure. The directory also contains sensitive candidate/issued tokens: protect, retain and eventually dispose of it under the operator policy; do not publish it as a CI artifact. No signer, database password, host mutation or cloud-secret publication occurs during delivery-file generation.

For renewal, use a fresh UUID and separately reviewed lifetime, referencing the active same-tenant reviewed predecessor. Exactly one successor may reference a predecessor; competing branches fail atomically. The old credential stays active until explicit retirement. **This revision does not switch a running host generation.** The current host installer refuses replacing differing per-tenant unit content. Finish the reviewed generation-transition milestone before live cutover; do not overwrite a generation, change a current symlink or enable automatic restart to force renewal.

A revoke review contains exactly `schemaVersion: 1`, `purpose: "controller-backend-revoke"`, the three UUIDs above, `configurationSha256`, and `issuanceSha256` identifying the immutable issue review. It atomically records retirement and revokes the registry entry, preserving both reviews. Do this after a separately verified cutover, or as a separately reviewed emergency retirement. A revoked/expired lease cannot be extended or reminted under its old identity; the successor is unaffected by predecessor retirement. A running SQL statement may still settle after revocation; preserve existing uncertain-work recovery and never reset a client claim.

## Failure and recovery

Any failure can mean registration or revocation committed but the reply/publication was lost. Preserve the output and exact request. No automatic retry occurs. Only explicit `--resume-issue` or `--resume-revoke` with identical reviewed bytes/configuration and complete preparation may reconcile the existing operation. Changed/partial files, conflicting reviews, extra output files, unsafe modes and simultaneous mutation are refused. A crash between final rename and ready receipt is resumable; an incomplete preparation requires separate investigation and retirement if authority might exist. Never delete the directory to manufacture a fresh retry.

If a host switch fails, a predecessor can remain available only until its original expiry and only if it has not been retired. Revocation is terminal; no tool restores it. No future successor reservation, unlimited retry window or availability guarantee is asserted. Keep cloud activation closed until effective IAM, actual secret replication/publication, private TLS/DNS, scheduler and GCP/KMS/recovery evidence pass.

See [audit 63](../../docs/audits/63-controller-credential-issuance-review-2026-09-23.md) for test evidence and remaining gates.
