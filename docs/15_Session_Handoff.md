# Axiom Proof — implementation session handoff

## Revision 32 — W4.2 credential vault and rotation foundation

Reviewed staging `be69c3f` and green CI [35654053318](https://github.com/vikashkaruna/Proof/actions/runs/35654053318). No newer upstream implementation appeared. W4.1 is complete at that checkpoint; W4.2 remains **partial**.

Delivered: tenant/connector/credential/configuration-bound AES-256-GCM envelopes, independent random data keys, Mumbai-only AWS/GCP KMS adapters with tenant-specific key rings, authenticated context and provider response checks (including GCP CRC32C). Rotation retains the old stored envelope until the new envelope and audit event commit. Secret buffers are cleared after use; this is best-effort buffer hygiene, not a claim that JavaScript/SDK heaps can be erased.

Migration **0039** adds explicit format/revision/context metadata and a service-only owner/admin/founder administration RPC. Connector version and credential revision checks serialize stale rotation/revocation. Parent/lifecycle locks and live membership are repeated in SQL. Every credential change revokes prior grants and appends an atomic, redacted ledger event. Historical envelopes remain byte-for-byte intact as format 0 and cannot be opened by the v1 broker. No browser credential reads, token cache, acquisition endpoint or execution authority is added. Existing service-role access remains a trusted backend boundary; this milestone is not workload credential isolation.

Validation: **394 BFF tests**, workspace tests/lint/typecheck; **40 migration files**, 51 public tables; ten concurrency suites, including both credential rotation/revocation orders; populated 0038→0039 upgrade; production dependency audit clean. Exact committed container/merge CI remains a separate gate, recorded in the session checkpoint after execution. Provider tests inject KMS responses; no real cloud KMS request was made. See [review 21](audits/21-credential-vault-review-2026-09-22.md).

**Next:** finish W4.2 OAuth grant handlers, pinned token-endpoint transport, broker authorization seam and isolated reference-authorization-server tests. Then W4.3 workload identity, W4.4 per-invocation grants, full W3 wizard/readiness and graph, W4.5/6/7. No connectivity or readiness claim is implied by encrypted storage.

## Revision 31 — connector registry, contracts and lifecycle

Reviewed staging `c79c303` and successful CI [35647963475](https://github.com/vikashkaruna/Proof/actions/runs/35647963475); no newer other-model commits appeared. The latest user instruction prioritizes **W4.1 → W4.2/3/4 → remaining W3 wizard and graph**, followed by W4.5/6/7. Earlier open W0/W1 findings remain recorded, not silently closed.

W4.1 implements strict versioned YAML capability descriptors, separate TypeScript/Python read and write interfaces, a reviewed BFF catalogue, and tenant-scoped registration APIs/UI. Unknown keys, credential fields and connection URLs as endpoint references, duplicate descriptor identities, unsafe YAML, ambiguous numeric spellings and non-production write capabilities are refused. Catalogue publication occurs only during a human registration transaction; published metadata and content hashes remain immutable. The initial PostgreSQL production/reference descriptors declare future transport operations, **not working adapters**.

Migration **0038** adds optimistic versions and the service-only audited lifecycle RPC. Owner/admin/founder membership is repeated and locked inside the transaction. Estate → system → connector locks serialize activation against parent archival. Draft/disabled registrations may be edited; active registrations must first be disabled; archival is terminal. Disable revokes grants, archive additionally revokes stored credential envelopes, and re-enable cannot restore revoked authority. A legacy descriptor outside the reviewed catalogue may be disabled/archived but cannot be enabled through this API.

The connector page now reads actual tenant records under RLS. It no longer claims hardcoded connections, health, residency or active access. “Enabled registration” is explicitly distinct from connectivity; health is the latest recorded check or “Not checked”; non-production bindings carry an amber marker. No probe, credential exchange or client write is triggered.

Validation includes descriptor/role/tenant/API refusals, SQL audit rollback, both archive/enable race orderings, populated upgrade, real-Auth lifecycle/replay checks and browser lifecycle/retry/isolation coverage. Workspace TS tests/lint/typecheck, Python runtime tests and all **39 migrations** pass locally; exact committed container and merge CI outcomes are recorded in Docs 14/15 and the private session checkpoint once those lanes complete. Tip **0038**, **51 public tables**, W2 named targets unchanged at **19/40**. See [review 20](audits/20-connector-lifecycle-review-2026-09-22.md).

**Next:** W4.2 broker vault/rotation and client-credentials/JWT-bearer handlers; then W4.3 workload identity and W4.4 live, per-invocation grants. Complete the W3 resumable wizard/readiness and graph using those enforced permissions. W4.5 internal MCP registry and W4.6 first real SQL execution remain separate acceptance gates; registration alone closes neither W4 nor W3.

## Delivered earlier

- W0 C-W0-4: durable BFF-owned gap-scan snapshots and mail, hashed report ownership, resend IDOR fix, truthful disabled/failing delivery; 0037. Final staging merge `c79c303`, successful CI 35647963475; 61 browsers and 75 API/restart outcomes in each local container configuration. Earlier failed attempts are historical, not closure evidence.
- W1 recovery replacement policy (0036): recovery-code replacement retires all prior MFA assurance atomically; current-factor replacement preserves it. Do not ask the accepted policy again.
- W3 inventory (0034) and reviewed intake proposals (0035): assigned staff prepare; a different client owner **or tenant admin** approves. Resumable full wizard/sustenance remain open.
- W0 deployed-target API/browser harness, scoped SSR configuration and managed Auth secret bindings. Local Docker evidence is distinct from remote acceptance.
- W2 connector metadata foundation (0033); W2 named targets 19/40. Existing later W5/W7/W8/W9 work is intentional and retained.

## Next implementation order

1. W4.2: finish credential broker authorization and short-lived client-credentials/JWT-bearer handlers. Vault/rotation foundation and grant-family extension are now in 0039. Do not accept arbitrary token URLs or leak credentials through errors/ledger. Use isolated local reference authorization servers for conformance; no real client credentials are needed.
2. W4.3: SPIFFE/SPIRE identities for all ten agents, broker/runtime scope checks, token exchange and actor-chain evidence. Only Drishti reads and Karya writes client systems; remove Nazar control-library write authority.
3. W4.4: live target-scoped grants, expiry/revocation and per-invocation enforcement, portal grant/revoke UI and audit. Disabled connector grants must stay revoked after re-enable. Existing reference-mock metadata is not authority to write.
4. Complete W3 resumable company → estate → systems → connector/grant → readiness wizard and W3.5 real graph. Graph access edges must reflect enforced authority; do not turn stored grant rows into claims of access. Then W4.5 registry and W4.6 first live SQL binding, followed by W4.7 transports/descriptor pack.
5. Retain deferred work: W0 per-service IAM, durable contact/mail and score/benchmark semantics, W1 invitations, W2 remaining targets, remote acceptance, W3 sustenance. No claim these are closed.

## Validation and operational boundaries

Run `scripts/test-deployed-http.sh --browser` from a clean committed tree. It exercises real Docker GoTrue/Postgres, BFF/web/marketing under preprod and production configurations, compares sanitized outcomes and performs the report restart probe. New connector tests cover registration replay, role/tenant refusal, archival, declared provenance, and an ambiguous response retry. Exact merge CI is the final staging gate.

Local Supabase project `axiom-w0-parity`, API 56321, DB 56322. Apply **0039** with the normal checksum migration runner; 40 files, 51 tables. Next migration **0040 after fresh fetch**. No previous migration was changed. Descriptors live in `services/bff/src/connectors/descriptors`; changing published content requires a new descriptor ID/version. Loader/schema contract changes need TS/Python conformance tests. Production descriptors are declarations, not executable bindings.

Implementation, local Docker tests, documentation and staging merge pushes are authorized. No billable cloud apply, real mail, client connector execution or retention changes. Higher environments dynamically deploy self-hosted Supabase. Sudhaar holds no client credentials; ledger writes use append_ledger. Private target/persona/probe data stays under ignored `.axiom-runtime`; never publish raw browser traces, cookies, secrets or private target JSON. Restore generated next-env.d.ts before commits; do not pop the superseded prototype stash.
