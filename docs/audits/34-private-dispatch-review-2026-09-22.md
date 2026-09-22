# Private assessment dispatch review — 22 September 2026

Reviewed staging `d1becf0`, green CI [35691631278](https://github.com/vikashkaruna/Proof/actions/runs/35691631278): all 17 applicable jobs and eight exact-revision artifacts. No intervening upstream changes were present. The overall goal remains active.

## Failure and resulting behavior

Task issuance previously generated a new proof/run every call. If the response was lost, the controller could not recover the proof from its stored hash; blindly repeating issuance created another run. There was no durable private payload or dispatch record bridging issuance and launch.

Migration **0044** adds service-only `assessment_dispatch_jobs`. `enqueue_assessment_dispatch` serializes a stable job UUID and atomically delegates the Parikshan task, run and audit with the encrypted outbox. A matching retry returns the original run and expiry, preserving its ciphertext/proof. Different actor, tenant, workload, estate, engagement, correlation or input hash conflicts. Constraint or mandatory audit failure rolls back the whole transaction. Existing tasks/assessments are preserved and never silently queued by upgrade.

`claim_assessment_dispatch` repeats current authority under existing locks: membership, user, estate, engagement, workload, task, run, then job. It uses the task deadline for controller authority, **not as evidence of an SVID**. Actual BFF tools still verify the worker's fresh SVID and proof. A claim is recorded once before ciphertext is returned. Concurrent/repeated claims refuse. A claim response lost after commit, failed decryption or uncertain worker launch must reconcile the original run; no automatic lease takeover, reset, reissuance or renewed expiry is allowed. This is one controller delivery, not a claim of exactly-once external execution.

The BFF seals the exact UTF-8 input and task proof with AES-256-GCM using a fresh data key, wrapped by an injected provider. Versioned authenticated context is separated from connector credentials, MFA and approvals; it binds job, tenant, initiator, workload, estate, engagement, correlation and input digest. The run binding follows the immutable SQL job-to-task assignment and is checked again at claim along with the stored proof hash. Data-key byte buffers are cleared; private input/proof fields use JavaScript private slots and redact normal inspection/JSON. This is not a guarantee of erasing all managed-runtime string copies. SQL receives ciphertext and the existing proof hash, never plaintext. Provider/SQL errors are sanitized.

The real acceptance harness now queues, discards the issuance response, reconstructs the controller, recovers the same receipt, claims/decrypts once and feeds the existing credential-less UID-attested worker through private pipes. The wrapping provider uses a synthetic controller-memory key, separate from the isolated worker; it is explicitly not a production KMS adapter. Existing authority/refusal and lost-result confirmation tests remain active.

## Validation

- **645 BFF tests**, including 21 new payload/adapter cases: tampered ciphertext/wrapped key/nonce/key reference, cross-context substitution, exact input and proof hash binding, canonical UUID normalization before SQL/encryption, key buffer clearing, serialization redaction and safe failure handling.
- Real Auth/PostgREST strict parity across staging/preprod/production/onprem labels; **61 SPIRE outcomes** and **17 isolated worker outcomes** (three new durable dispatch outcomes).
- **45 migrations, 14 concurrency suites and 10 populated upgrades** pass. Database tests exercise one run/audit across retry, context conflicts, invalid-envelope and audit rollback, direct-client/write denial, halt/demotion/archival/revocation/expiry, two competing enqueues/claims and revocation winning before delivery. The initial negative-envelope fixture reused a globally unique proof hash; it now derives a distinct synthetic hash per job so the intended envelope rollback is actually tested.
- Populated 0043→0044 upgrade preserves prior tasks and assessment results, keeps their independent confirmation working, and creates no inferred outbox entries. Schema tip **0044**, **54 public tables**, W2 named targets **19/40**. Exact-merge CI and sanitized artifacts are recorded after execution in the saved session.

## Remaining delivery gates

No new route activates this controller and the UI still uses the legacy runtime. Bounded launch/termination, private transport integration, scheduler and automated result reconciliation remain. Killing a `docker exec` client is not proof of terminating its in-container process; production dispatch must enforce worker lifetime independently. Private frames must never be a log-collected container's foreground stdout. Production wrapping-key provider, rotation/retention and effective workload attestation need implementation/acceptance. Do not call local UID evidence Cloud Run proof or put SVIDs/task proofs in Temporal history.

Continue W4.3 orchestration/remaining scoped workers/actor chains, W4.4 live grants and approval, full W3 resumable wizard/readiness and live graph, then W4.5/6/7. Retain W0 deployed/contact/provenance, W1 invitations and remaining W2 work. No cloud resource, production credential, client estate or WORM policy was changed.
