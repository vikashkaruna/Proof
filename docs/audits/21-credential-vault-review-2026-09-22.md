# W4.2 credential vault foundation review — 22 September 2026

Reviewed staging `be69c3f` with successful CI 35654053318. No new other-model work arrived during this checkpoint. W4.1 is delivered; this milestone completes the vault foundation within W4.2, not the whole broker or W3 readiness.

## Changes and review findings

- New envelopes bind tenant, connector, credential identity, grant family, descriptor content digest, endpoint reference and target binding through AES-GCM and KMS authenticated context. Reconfiguring an inactive registration cannot silently reuse the old secret.
- AWS/GCP wrappers pin explicit tenant-owned Mumbai key resources. Shared/cross-region/unknown references are refused before provider calls. GCP verifies request/response CRC32C and key-version identity. DEKs are fresh per seal; no provider credentials or shared application signing keys become fallback wrapping keys.
- 0039 adds a versioned storage format and audited administration RPC. Membership and estate→system→connector locks repeat the W4.1 boundary. Concurrent writers use both connector version and credential revision. Rotation and grant revocation roll back when ledger append fails. Audit/result data excludes ciphertext, wrapped keys, key resource references and secrets.
- Existing unknown-format rows are preserved, including duplicate legacy rows. They remain unavailable to the new reader rather than being guessed into a supported format. One unrevoked v1 credential is allowed per connector. Legacy service-role access remains trusted; no claim of physical workload credential isolation is made.
- Rotation is conservative: every administrative credential change revokes existing grants, including a KEK-only change. The current wrapper/key remains configured until the replacement envelope is durably stored; automatic retirement is not implemented.
- The TypeScript vault adapter authorizes before reading private rows or calling KMS, consumes/clears supplied secret buffers, rechecks mutations in SQL and emits generic errors. There is no browser or agent acquisition route. JavaScript/SDK memory erasure is not guaranteed.
- Protocol review corrected the roadmap's conflation of workload SVIDs, OAuth client assertions and JWT-bearer authorization grants. The accepted single connector identity remains; external client assertions need the correct registered-client subject and target audience. Internal SPIFFE identity cannot be forwarded unchanged as `private_key_jwt`.

Further source review found that Nazar's declaration downgrade was already delivered in `cc3fcee` in both TS and Python. The handoff now preserves that completed work. Prativedan's read scopes, the planned mutation metadata distinction and actual workload/tool enforcement remain pending. Removed contradictory current-plan claims that all roster discrepancies were fixed or that the shared external OAuth identity could distinguish internal agents. Historical revision notes remain historical.

## Validation

394 BFF tests (30 new envelope/provider/vault tests); workspace tests/lint/typecheck; all 40 migrations under service_role without BYPASSRLS; SQL rollback/tenant/lifecycle/format checks; ten concurrency suites with both rotation/revocation orders; populated 0038→0039 upgrade. Production dependency audit passes. BFF KMS SDK requires Node 22+; Docker/CI already use Node 24. Clearing ignored incremental TS build caches resolved stale Supabase optional-peer type identities; no unsafe casts were added to application code.

The first SQL run caught PostgreSQL's bounded-regex repetition limit; validation now separates character validation and length bounds. That failed run is not acceptance evidence. Provider tests use injected SDK responses, not cloud calls. Committed source `4a6b13c` also passed 63 browser journeys and 89 API/restart outcomes in each of the local preprod/production configurations, with zero retries and matching sanitized results. Exact merge CI is recorded separately in the private session checkpoint.

## Remaining gates

W4.2 OAuth client-credentials/JWT-bearer handlers, pinned egress, workload authorization seam, isolated reference AS conformance and deployable key-ring configuration remain. W4.3 must provide real SVID authentication and runtime scope enforcement; W4.4 must provide per-invocation target grants/expiry/revocation and write approval. Then finish W3 wizard/readiness/graph using those enforced permissions. A stored credential or enabled registration is not evidence of connectivity or authority.

Provider references: [AWS Encrypt](https://docs.aws.amazon.com/kms/latest/APIReference/API_Encrypt.html), [AWS Decrypt](https://docs.aws.amazon.com/kms/latest/APIReference/API_Decrypt.html), [GCP KMS integrity checks](https://docs.cloud.google.com/kms/docs/encrypt-decrypt). No cloud resource, real client credential, external email or connector action was used.
