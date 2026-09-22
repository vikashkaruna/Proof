# Axiom Proof — Operator completion runbook: W0 → W4

Verified staging checkpoint: `b40685f`, CI [35711878303](https://github.com/vikashkaruna/Proof/actions/runs/35711878303) green. Revision 49 remote transport is verified. Revision 50 adds dispatch KMS adapters; key-policy rollout/retirement, full production activation and W3/W4 remain open.

### Axiom Minds Private Limited · https://axiomminds.ai

**Document:** 16 · Companion to the [workstream status register](11_Phase0-5_Gap_Closure_Plan.md#workstream-status-register--as-at-revision-22-21-sep-2026) · **As at** Revision 50, 22 Sep 2026

The register says what is delivered. This says **who does what next**, for W0
through W4, and — the part that is usually missing — **exactly what
evidence flips a status**, so that "done" is something you can hand over rather
than something either of us asserts.

## Revision 50 — dispatch KMS configuration and rotation gates

**ENGINEERING delivered:** construct a `DispatchKeyPolicy` from a trusted `Map<TenantId, { primary, retiring }>` and supply either `AwsDispatchKeyWrapper` or `GcpDispatchKeyWrapper` to `AssessmentDispatch`. Use dedicated dispatch keys, separate from connector credential-vault, MFA and approval keys. Each tenant has distinct resources; no resource may be reused across tenants in the policy. AWS accepts canonical symmetric key ARNs only in `ap-south-1`, with the regional endpoint fixed in code. GCP accepts canonical CryptoKey resources only in `asia-south1`, with `asia-south1-cloudkms.googleapis.com` fixed in code. Aliases, key-version references and caller-selected endpoints are refused. The policy and provider are backend configuration, never browser/worker/scheduler input. No default listener or application route enables them.

**IAM and data boundary:** grant the controller only encrypt/decrypt permission on its approved dispatch resources. Do not grant key administration, disable/destruction, or KMS access to the opaque scheduler or isolated worker. Provision symmetric `ENCRYPT_DECRYPT` GCP keys / AWS symmetric encryption keys. Provider context contains a purpose label and SHA-256 digest of the canonical assignment, not raw answers, task proofs or full job metadata. Do not log SDK requests/responses, DEKs, decrypted envelopes or raw exceptions. Buffers are cleared best-effort; JavaScript strings and SDK-internal copies cannot be guaranteed erased.

**Deadline and uncertainty:** each provider call has a five-second caller budget; AWS receives an abort signal and disables SDK retries, while GCP receives a matching deadline and no retry policy. One call per adapter may remain outstanding until actual settlement; additional calls fail closed during that time. A late decrypted key is discarded and cleared. A timeout during `claim` leaves the claim uncertain and single-use. Independently reconcile the original job; never reset the claim or issue replacement authority automatically. <!-- axiom-count-ok: provider timeout safety bound, not statutory control count -->

**Rotation preparation:** `policy.withReadable(tenant, newReference)` stages the new key for reading while preserving the old primary. After that reader policy is deployed everywhere, `withPrimary(tenant, newReference)` can promote it; promoting an unstaged reference is refused. Both return new immutable policies retaining all old references. It never changes the existing policy or calls a cloud administration API. Policies allow up to ten distinct readable references per tenant and refuse overflow; do not trim old keys to get past the limit. Persist the reviewed full policy through protected deployment configuration and stage a reader-first rollout: all readers must accept the new and old keys before any producer starts using the new primary. Until an implemented rollout fence and persisted policy revision exist, quiesce every old producer and outstanding enqueue before cutover. A stale writer can otherwise enqueue under an old primary after an empty inventory was observed. This helper alone is not distributed rotation orchestration. <!-- axiom-count-ok: key-ring safety limit, not statutory control count -->

**Retirement remains ENGINEERING:** there is no key-removal/disable/destroy endpoint. Keep all required keys and versions readable while any job, uncertain claim, retained ciphertext, database backup or recovery obligation can need them. Provider version rotation does not rewrite earlier ciphertext; GCP stores the CryptoKey root in the envelope and the provider selects its ciphertext's version. A completed run or an empty live-job query alone does not authorize key deletion. Add persisted/fenced rollout, retained-artifact inventory and a reviewed retirement procedure before implementing that capability. Existing synthetic local envelopes must be reconciled in their original fixture; these production adapters do not import synthetic keys or make lost keys recoverable.

**Acceptance evidence:** 803 BFF tests, including 53 new policy/provider cases. Run `python3 scripts/test-workload-identity.py --assessment` against isolated local parity for 61 identity and 35 worker outcomes. The real outbox/worker path uses the production AWS adapter with a simulated cryptographic KMS service to verify rotation, controller reconstruction and immutable idempotent envelopes. GCP checks use injected provider responses and authenticated local encryption fixtures. These are engineering acceptance, not effective cloud IAM/KMS evidence. Before activation, verify actual regional keys, controller workload credentials, denied worker/scheduler identities, retained-version decrypt, deadlines and private audit handling in the deployed target. No cloud apply or client mutation occurred. See [review 39](audits/39-dispatch-kms-review-2026-09-22.md).

**Next ENGINEERING:** complete rollout fencing/retention, per-job isolation/trust and deployment composition, remaining workers/actor chains, W4.4 live grants, full W3 wizard/graph and W4.5/6/7. Preserve W0/W1/W2 open items. The overall goal remains active.

## Revision 49 — remote transport acceptance and deployment composition

**ENGINEERING delivered:** `GoogleSchedulerIdentity` verifies the scheduler against a configured canonical HTTPS audience, immutable numeric service-account subject and verified service-account email. Signing keys come only from Google's fixed JWKS endpoint with bounded fetching/cache age; token-selected key URLs, stale-key outages, wrong audiences/accounts and malformed claims are refused. `createRemoteAssessmentServer` creates an explicit backend listener using this identity adapter, the existing controller and optional scheduling adapter. It is not installed in `createApp()` or default BFF startup. Choose direct TLS with a key/certificate chain, or `tls: 'platform'` only behind a trusted TLS terminator. Never expose platform mode over plaintext public networking.

**Scheduler command:** use `python -m temporal_workers.worker --assessment-controller-origin https://CONTROLLER_SERVICE.run.app --assessment-outbox-pump`. The origin must be canonical, with no path, trailing slash, credentials, query or fragment, and must exactly match the verifier audience. It cannot be combined with socket/UID options. Google workload metadata supplies an in-memory ID token; no environment endpoint override, downloaded service key or CLI credential fallback exists. The client sends both `X-Serverless-Authorization` for platform authentication and signed `Authorization` for independent application verification. No token enters workflow history, logs or saved diagnostics. HTTP body schemas allow only opaque job/lease/receipt metadata before network transmission.

**Identity and isolation gates:** provision a dedicated opaque scheduler identity with only its Temporal credential and narrowly scoped controller invocation permission. The existing legacy Temporal service's `agent_runtime_internal_token` grant supports the old queue and must not be inherited by the new scheduler. The existing public BFF invoker policy cannot serve as the scheduler authentication boundary. Controller keys and backend permissions stay with backend services. Do not run untrusted workers in a controller container that exposes the controller's metadata identity, filesystem, network or backend environment. Dropping a child process UID is not proof of separate cloud workload identity. Production composition, per-job isolation and attestation remain engineering work before activation.

**Bounds and lifecycle:** Google service-account ID tokens are bearer credentials and remain valid until expiry; disabling an account is not application-level instantaneous revocation. Remove a compromised principal from the controller's configured allowlist through a controlled rollout, alongside platform IAM containment. The verifier caps token lifetime at one hour and signing-key cache age at one minute; metadata retrieval is bounded to three seconds, within the overall request budget. The controller aborts on identity expiry/disconnect and holds the operation slot until the backend call settles. A failed request can still commit SQL; use the existing stable-ID/lease and confirmation paths. No retry resets a claim or authorizes connector access. <!-- axiom-count-ok: transport safety bounds, not statutory control counts -->

**Evidence:** 750 BFF and 146 Temporal tests; 61 SPIRE and 33 isolated-worker outcomes, including actual verified TLS, rejected foreign identity/certificate, durable pickup and lost-response recovery. The local test uses a synthetic signing authority and fixture Google key response; metadata transport is separately mocked. Neither proves a deployed Google identity or effective IAM. Verify actual scheduler subject/email, audience, ingress/header behavior, denied principals, namespace ACLs, timeouts and private logging in deployment acceptance. No cloud apply or live grant occurred. Schema remains 0045 / 54 public tables. See [review 38](audits/38-remote-assessment-transport-review-2026-09-22.md).

**Remaining ENGINEERING:** production wrapping provider and key lifecycle, process/network/metadata isolation, trust/registration, remaining scoped workers and verified actor chains, deployment composition, W4.4 live grants/approval, full W3 wizard/graph and W4.5/6/7. W0/W1/W2 remainder remains in the register. The transport component is implemented; production orchestration and the overall goal are still partial.

## Revision 48 — durable pickup and scheduling recovery

**ENGINEERING delivered:** migration 0045 adds scheduling metadata to the existing encrypted outbox, with no new table. The BFF `AssessmentScheduling` adapter polls one job through a service-only reservation function, configured with the exact Temporal namespace and optionally a trusted tenant shard. Attach it as `scheduling` when constructing `startAssessmentControllerSocket`. The scheduler receives only opaque job/workflow/lease metadata. Extend the explicit private worker command with `--assessment-outbox-pump` to enable polling; socket/owner options are mandatory. The default legacy worker is unchanged. Provision namespace producer ACLs and the restricted controller/scheduler group before enabling this mode. Workers must not join that group or obtain backend keys.

**Bounds and receipts:** the pump polls every five seconds; a reservation lasts three minutes and can be acquired at most eight times. Each lease has a new UUID. An expired or replaced lease cannot acknowledge a submission. All restarts use `assessment-<tenant UUID>-<job UUID>` in the original namespace; a matching already-submitted acknowledgement returns the same ledger receipt. The recorded `workflow_run_id` is the observed Temporal execution, while `run_id` remains the application assessment run. `submitted` proves the trusted producer's scheduling acknowledgement only. Assessment persistence and process cleanup retain their separate confirmation paths. <!-- axiom-count-ok: polling/retry safety bounds, not statutory control counts -->

**Uncertainty and recovery:** inspect `scheduling_status`, attempts, lease deadline, namespace, workflow IDs and receipt using a trusted backend/operator connection. A pending row with a live lease is still reserved. After expiry, the next poll may retry the stable ID. Claimed, expired, revoked or terminal task assignments can only look up an existing workflow; missing workflow history remains unconfirmed. After the final lease expires, another poll records `workload.dispatch_schedule_review` and changes the row to `needs_review`. Inspect the original namespace/execution and independently confirm the assessment before considering an explicitly authorized new job. Never reset `claimed_at`, edit attempt counters, renew task proofs or switch namespaces to force a retry. There is no operator reset endpoint. Workflow retention must cover the reconciliation window; an absent/expired history is not proof that work never ran. A namespace migration needs a separate reviewed reconciliation procedure.

**Evidence:** 705 BFF tests, 112 Temporal tests, 46 migrations, 15 concurrency suites, 11 populated upgrades, real Auth/PostgREST parity, 61 SPIRE and 30 isolated-worker outcomes. The real combined probe deliberately loses submission and acknowledgement replies, reconstructs the producer, reacquires a lease, verifies the same execution and observes one worker launch per job. Only its synthetic fixture advances the lease clock; production has no clock override. It also retains lost-activity-response reconciliation and history/replay privacy checks. Final merge CI and exact-revision artifacts are saved in the session. See [review 37](audits/37-durable-assessment-pickup-review-2026-09-22.md).

**Remaining ENGINEERING:** authenticated remote transport between distinct cloud service identities, production key provider/rotation/retention, per-job PID/tenant isolation, trust/registration and remaining agent scopes/actor chains; W4.4 live grants/approval, full W3 wizard/graph, W4.5/6/7 and W0/W1/W2 remainder. The local socket is not a cloud IAM workaround. Keep backend RPC timeouts bounded; a disconnected request can still commit SQL, requiring later receipt recovery. No public route, cloud deployment, real email or client mutation was activated.

## Revision 47 — opaque scheduling acceptance

**ENGINEERING delivered:** new workflow `axiom.assessment.job.v1`, queue `axiom-assessment-v1`, and trusted `start_assessment_job(client, tenant_id, job_id)` producer. It validates IDs before history submission, fixes the workflow ID to tenant/job, rejects execution reuse and recovers an existing execution after a lost scheduling response. The workflow invokes `run` once, then at most three `reconcile` activities. All activities have one attempt, bounded schedule/execution time and sanitized errors. Overall producer execution timeout is ten minutes. Reconciliation cannot claim an unclaimed job. Cancellation, timeout or missing cleanup is not rollback.

**Local/on-prem transport:** construct the trusted BFF controller with a dedicated, empty, controller-owned directory initially mode 0700. `startAssessmentControllerSocket` binds only a Unix socket, changes it to 0660 and the containing directory to 0710 for a dedicated scheduler group, and checks protected ancestors. The activity independently verifies owner UID, socket type and permissions. Provision group membership to trusted controller/scheduler principals only. The fixed worker must never join that group. A single operation remains reserved until controller work actually settles, even after an HTTP deadline/disconnect. No task input, proof, SVID or database credential crosses this socket.

**Explicit worker mode:** `python -m temporal_workers.worker --assessment-controller-socket /protected/controller.sock --assessment-controller-uid <controller-uid>` polls only the opaque assessment queue. Both arguments are required together and contain no secret. Without them the existing legacy queue remains unchanged. Use the trusted producer; do not submit private inputs directly with a generic Temporal client. Namespace ACLs must enforce who can start workflows: validation inside a workflow cannot erase payloads already submitted to history. Legacy histories are not migrated automatically.

**Evidence:** 689 BFF and 94 Temporal tests, workspace/acceptance checks, 61 SPIRE and 27 real worker outcomes. Actual Temporal-to-Docker/Postgres runs prove normal confirmation and recovery after a lost activity reply with no duplicate launch. Real server tests additionally exercise timeout, cancellation, stable scheduling, pending-worker restart and sandboxed replay. Local transport tests verify file ownership/permissions and refusal, using the host UID; deployed distinct-UID denial and lifecycle remain unverified. Exact final merge CI and sanitized artifacts are saved in the session. See [review 36](audits/36-opaque-assessment-scheduling-review-2026-09-22.md).

**Before activation:** implement durable pickup between the encrypted outbox commit and producer submission, with stable-ID recovery after a crash. The Unix transport is local/on-prem; separate Cloud Run services still need authenticated remote transport while preserving their distinct IAM identities. Do not colocate them under a shared privileged identity to bypass that gate. Complete production key wrapping/rotation/retention, per-job PID/tenant isolation, trust/registration and remaining agent scopes. Configure bounded database transport, namespace ACLs and private diagnostic handling. The socket refuses an occupied directory; after a crash, confirm the old process has stopped before removing its stale socket. Public entry points remain disabled. W4.4 grants, full wizard/graph, W4.5/6/7 and W0/W1/W2 remainder stay open.

## Revision 46 — bounded controller acceptance

**ENGINEERING delivered:** the private controller connects opaque job lookup, single claim, fixed worker launch, authenticated BFF tools and independent database confirmation. The Linux root supervisor holds no backend credentials, drops worker privileges to UID/GID 20003, applies resource/environment limits and enforces its own deadline. Detached descendants are killed and reaped; a kernel parent-death binding protects the fixed worker and identity CLI. The bounded private channel refuses malformed, oversized, reordered or contradictory frames. Ordinary image startup and unprivileged supervisor activation fail closed.

**Evidence:** 673 BFF tests, 187 Python tests and workspace/acceptance type checks; 61 SPIRE and 24 real isolated-worker outcomes. Actual controller completion, lost response recovery without another launch, detached child cleanup, timeout and abrupt supervisor death are exercised. Final exact-merge CI remains a separate saved gate. No schema change: 0044 / 54 public tables. See [review 35](audits/35-bounded-assessment-controller-review-2026-09-22.md).

**Recovery:** schedule reconciliation using only the owned tenant/job reference. A claimed job must never be automatically relaunched or reset. An `unconfirmed` result can still finish an in-flight database operation; confirm again later. A `confirmed` result proves persistence, while `cleanupConfirmed` independently reports process cleanup (`null` when this call did not launch). Neither timeout nor missing cleanup proves rollback. Never put raw private frames, proofs, SVIDs or ciphertext into workflow histories or log sinks.

**Before activation:** supply an authenticated opaque scheduler, bounded reconciliation, a production wrapping provider and retained-key policy, private controller transport, per-job PID/tenant isolation and workload attestation. The supervisor CLI requires explicit private FIFO stdio and root; those guards cannot detect external log collectors. Its worker remains unprivileged. Do not use a shared UID/PID namespace for concurrent tenant jobs or mount controller credentials into the worker. The local harness processes one job at a time and is not a production launcher. Keep public entry points disabled until these gates are met. No cloud deployment, real email or client mutation occurred. Remaining wizard/graph and W4 work are engineering tasks, not completed operator checks.

## Revision 45 — private dispatch acceptance

**ENGINEERING delivered:** migration 0044 makes delegation and the encrypted outbox atomic. Stable job IDs recover the original run without new audit/delegation or renewed expiry. A live controller claim delivers ciphertext once; fresh worker SVID checks still guard every actual tool. The domain-separated envelope binds the immutable job-to-run assignment and exact private input/proof. No browser/worker route exposes this controller.

**Evidence:** 645 BFF tests, real Auth/PostgREST parity, 61 real SPIRE and 17 real isolated-worker outcomes; database rollback, concurrency and upgrade tests. The local wrapping provider holds a synthetic key only in controller memory. Exact-merge CI is the final gate and is saved in the session. Revision 44 is already green at `d1becf0` / CI 35691631278.

**Recovery:** retry an uncertain enqueue with the same job/context/input to recover its receipt. Never choose a new request ID automatically. A claimed job cannot be claimed again, even if the claim response or decryption failed. Independently confirm the run using 0043; an absent result remains unconfirmed. Determine whether launch occurred before any explicitly authorized replacement request. Do not reset `claimed_at`, renew expired proofs, reinterpret timeout as rollback or restore direct table writes. Only opaque job references may enter workflow history; input, proofs and private IPC stay outside it.

**Before activation:** implement bounded process cleanup, queue/reconciliation scheduling, production wrapping-key adapter and rotation/retention policy, private transport and production workload attestation. Preserve required old wrapping keys until pending jobs are reconciled. Encrypted payload storage is not WORM sealing. No cloud provision, key creation, real email or client mutation occurred. Full wizard/graph and W4 execution are still engineering work. See [review 34](audits/34-private-dispatch-review-2026-09-22.md).

## Revision 44 — Temporal computation acceptance

**ENGINEERING delivered:** versioned `axiom.compliance.engagement.v2` on `axiom-compliance-v2`, deterministic correlation, valid activity arguments, strict result/context gates and truthful computation/review handoffs. HTTP calls require configured internal authentication, have bounded time/response size, refuse redirects and sanitize failures. No blind retry or fictitious persisted plan/approval is allowed.

**Evidence:** 67 passing Temporal tests: real local test server, default sandboxed workers, history replay and pending-activity worker restart with synthetic agents; HTTP MockTransport regressions. These prove orchestration behavior, not a deployed cluster or live client execution. Exact-merge CI and the sanitized Temporal artifact are recorded in the saved session. Revision 43 is green at `e0781c6` / CI 35688921423.

**Before deployment:** inspect old `ComplianceEngagementWorkflow` histories on `axiom-compliance`; explicitly reconcile and drain/migrate them with controlled compatible code. The v2 worker does not service the old queue. There is no in-repository producer to switch and no rollout occurred. Legacy raw computation payloads still enter history; private payload storage/history residency and access controls remain engineering gates. Never send SVIDs, task proofs or private worker frames through Temporal histories or container logs. An unconfirmed outcome requires checking persisted results/audit before any redispatch; it is not proof that the previous attempt had no effects.

**Still ENGINEERING:** private isolated-worker dispatch, durable idempotency and recovery scheduling, remaining agent isolation/trust chains, W4.4 live grants/approval and full W3 wizard/graph. See [review 33](audits/33-temporal-orchestration-review-2026-09-22.md). This checkpoint does not authorize cloud provisioning or client mutations.

## Revision 43 — confirmation and recovery acceptance

**ENGINEERING delivered:** service-only confirmation of an already committed assessment using independently checked task/run/packet and ledger receipts. It records terminal success and a finalization receipt atomically, once. A missing worker response is recoverable. Cancellation/conflicting terminal states are preserved; mandatory audit failure does not report success. The BFF adapter is private to the controller, and no worker or browser confirmation route is exposed.

**Evidence:** migration 0043, 624 BFF and 187 Python tests, 44 migrations/13 concurrency suites/9 populated upgrades. Reuse the Revision 42 commands below; expect **14** worker outcomes now. The actual worker acceptance discards a terminal response, then confirms the stored result and proves the task cannot write again. Verify the successor merge's seven sanitized artifacts and exact revision before calling the follow-up green.

**Recovery:** use the trusted expected tenant/run/engagement/correlation/input context. Confirmation can record a result that committed before a later halt, revocation or demotion; it grants no new permission. Missing result means unconfirmed; an existing cancellation or contradictory terminal state means conflict. Preserve the recorded state for review, and never blindly rerun the worker. A succeeded result is durable application/audit state, not WORM-sealed evidence.

**Still ENGINEERING:** idempotent dispatch, bounded production worker launch/private payload delivery, automatic recovery scheduling, trust/registration, remaining workers/actor chains, W4.4 and full W3. Default tool activation stays disabled and UI dispatch remains legacy. Table count stays 53; W2 named targets 19/40. See [review 32](audits/32-assessment-confirmation-review-2026-09-22.md).

## Revision 42 — isolated assessment worker acceptance

**ENGINEERING delivered:** separate credential-less Parikshan image, private exact-input task envelope, worker-acquired JWT-SVIDs, fixed BFF tool scopes and migration 0042. The full pinned library is read from the owned engagement. Findings, scores, review status and audit receipt commit atomically; audit failure/expiry rolls back; retries cannot duplicate results. Existing assessments are preserved. Database inventory is now 53 public tables and 43 migrations; W2's named set remains 19/40.

**Evidence to verify:** run `./scripts/test-database.sh`, workspace tests/typecheck/lint, `pnpm exec tsc -p scripts/tsconfig.acceptance.json`, Python tests, then `./scripts/start-parity-supabase.sh` and `python3 scripts/test-workload-identity.py --assessment`. Expected worker artifact: 11 passing outcomes, plus the existing 61 identity outcomes. The new CI step runs in the real Auth/PostgREST parity lane. Confirm the exact merge revision, `dirty: false`, and all seven sanitized acceptance artifacts before calling this milestone green. Never upload private status files, SVIDs or stdio frames.

**Recovery and boundary:** the persistence receipt establishes a committed result, not a completed orchestration or sealed WORM object. The task run remains `running` until the future controller independently confirms/finalizes it. If a worker stops or a response is lost, inspect the owned packet/receipt before retrying or creating another engagement. Never change a historical library or overwrite existing findings to make a retry pass. Disable tool activation on uncertainty; do not grant the worker service credentials. The short halt-table SHARE lock must be load-tested before broad deployment.

**Still ENGINEERING:** production controller, idempotent dispatch and restart reconciliation; remaining scoped workers; production trust/registration renewal; actor chains; W4.4 grants; full W3 wizard/readiness/graph. The ordinary app keeps the new routes unavailable and the UI uses the legacy runtime until those gates are implemented. Local Unix UID attestation does not prove Cloud Run attestation. No new operator permission or cloud resource change is needed for this local milestone. See [review 31](audits/31-isolated-assessment-worker-review-2026-09-22.md).

## Revision 41 — saved assessment acceptance

Initial merge `fadf0d0` / CI 35683997539 failed acceptance-script type checking and the control-count prose gate. Corrections use a real cross-tenant assessment ID with an explicit 404 assertion and annotate the query-bound count. Verify the successor merge; do not use the failed run as closure evidence.

**ENGINEERING delivered:** BFF-owned read projection for one tenant/assessment/library, published library count validation, real owned evidence references, measured zeros, explicit missing/unavailable states and all saved controls. SSR calls the BFF. No fallback scores, exposure, evidence IDs or domain outcomes remain on Assessment. Parikshan invocation is disabled without readable saved context; successful invocation does not imply persisted findings.

**Evidence:** 26 projection regressions (598 BFF tests), 76 web tests and five focused browser journeys. A unique immutable synthetic 20-control library proves real database reads, empty history, zero values, missing findings, stale evidence and foreign/historical selection. Corrected test fixtures to the actual SQL domain/status enums and uniform PostgREST bulk columns; did not relax schema rules. The full exact-merge gate should contain 67 browser/89 API outcomes per configuration. Record its revision and six sanitized artifacts in the saved session before calling the checkpoint green.

**Operational meaning:** unavailable results require restoring the BFF/data source or a complete published baseline, not substituting demonstration data. Sets at the 1,000-row bound deliberately refuse until pagination is implemented. A citation link proves an owned metadata reference, not object-lock verification. This is a current persisted read, not an atomic sealed report. The existing score presentation bands remain 80/40; this work does not approve or change statutory scoring.

**Still ENGINEERING:** q7/q11/q12 and benchmark semantics, portal fallbacks/static health labels, real Parikshan persistence and requested-library execution through scoped W4.3 tools, W4.4 execution gates and full W3 wizard/graph. No operator action, cloud deploy or client-side mutation is required for this read-projection milestone.

## Revision 40 — tenant routing acceptance

**ENGINEERING delivered:** arbitrary tenant slugs and UUIDs resolve through authenticated, RLS-scoped memberships. There is no demo-tenant fallback. Unknown/revoked cookie selections refuse before forwarding; query failure returns 503. Missing cookies use the same stable actual-membership default as the page context/app shell. Explicit headers still require BFF membership/MFA. Exact onboarding and discovery endpoints receive no tenant scope.

**Evidence:** 17 route regressions (76 total web tests), plus real browser/Auth/BFF/PostgREST custom-tenant read/write, SSR slug/UUID agreement, foreign-header denial, invalid-cookie mutation refusal and revocation checks. Full exact-merge CI must verify 66 browser journeys and 89 API outcomes per configuration before this checkpoint is called green. Saved session records the final run and artifact revision. No operator action or deployment is required for this local engineering milestone.

**Recovery:** choose a valid tenant in the app switcher after `tenant_selection_required`; retry a lookup outage once restored. Do not restore a hardcoded fallback or bypass the BFF gate. SSR's permitted fallback display is not permission to mutate through an invalid cookie. Assessment/portal provenance and W3/W4 execution gates below remain open.

## How to read this

Every item names one owner:

- **OPERATOR** — you. Anything that provisions, bills, deploys, or is
  irreversible. Anything needing a credential I must never see. Anything that
  is a business or posture decision rather than an engineering one.
- **ENGINEERING** — the implementing model/team. Code, migrations, tests, gates, docs.

Each operator step ends with **Evidence to return**. Each workstream ends with
**How I mark it Closed** — the checks I run against your evidence before I
change a status. I do not flip a status on a report alone; where a claim is
checkable from the repository or from a URL you give me, I check it.

---

## 0. The standing constraint, restated so it is not a surprise

I do not create, modify or bill any cloud resource. `terraform validate` and
read-only checks are my ceiling. No `terraform apply`, no Supabase project
creation, no Secret Manager writes, no Cloud Run deploy.

Two of these are not caution, they are one-way doors:

- **The first real deploy is reserved to you.** That was your instruction and I
  have kept to it.
- **Evidence-bucket Object Lock is COMPLIANCE mode.** Once set, nobody —
  including the project owner, including Google — can shorten or delete it. A
  test bucket locked for the statutory 2555 days is gone for seven years. Do
  not set retention on a bucket you are experimenting with. W8 depends on this
  and it is deliberately the last thing anyone should turn on.

**Never send me:** a service-role key, a JWT secret, an `APPROVAL_SIGNING_KEY`,
the contents of any `.env*`, or `.axiom-runtime/personas/state.json`. Everything
below is written so you never have to. Where I need to know a secret _exists_, I
ask for the Secret Manager resource name or a SHA-256 of the value, never the
value.

---

# W0 · Security remediation & environment parity

**Current status: Partial** — deployed-target harness delivered and locally rehearsed; higher-environment deployment acceptance remains open.

## What is already done, so you do not redo it

W0.0 and W0.2 are closed and held by a CI gate on every push. Re-verified at
this head:

| Exit criterion                                     | State                                                                                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Zero environment-conditional security branches     | **Met.** The only two matches are a marketing URL resolver the plan explicitly classes as topology, and a comment recording the removed defect |
| `axiom_e2e_bypass` has no effect anywhere          | **Met.** No reader exists in any package                                                                                                       |
| Service-role client banned from `apps/web` (SEC-3) | **Met.** Zero calls across 22 files; the baseline file is empty and now acts as a ratchet                                                      |
| SEC-4/5/6/10/11/12/13 closed with regression tests | **Met**                                                                                                                                        |
| Mock Supabase substitution removed                 | **Met.** Reachable only under `e2e-bypass`, which is refused at boot outside `local`/`test`                                                    |
| Idempotency auto-key generation removed (FR-8.3)   | **Met.** No environment relaxes it, including `e2e-bypass`                                                                                     |

**W0 is not wholly operator-owned.** Provisioning is reserved to the operator. The deployed parity and persona-seeding harness are delivered in Revision 28; their final verification still needs isolated higher-environment targets. Local Docker evidence is not remote acceptance.

## OPERATOR steps, in order

The detail for each lives in
[Doc 08](08_DEPLOYMENT_GUIDE.md), the
[GCP preprod guide](GCP_PREPROD_DEPLOYMENT_GUIDE.md) and the
[env config checklist](GCP_PREPROD_ENV_CONFIG_CHECKLIST.md). This is the
ordered spine and the evidence, not a replacement for those.

### W0-1 · Decide and record the target

Project, region, billing account, and the intended placement of the self-hosted Supabase services. The accepted direction is local Docker Supabase and dynamically deployed self-hosted Supabase in higher environments; Cloud SQL may provide PostgreSQL underneath that stack. Do not substitute a managed Supabase project or reopen this accepted choice.

**Evidence to return:** project id, region, and which topology. No credentials.

### W0-2 · Scaffold and mint configuration

```bash
./scripts/sync-env.sh scaffold
```

Appends only missing keys to `.env.preprod`; values you already set are kept.

```bash
./scripts/sync-env.sh mint
```

This one matters more than it looks. It generates the Supabase JWT secret and
the anon/service keys **from one minting**. Those two keys are JWTs signed with
that secret, so mixing values from separate runs leaves GoTrue issuing tokens
PostgREST rejects — a failure that presents as "login works, every API call
401s" and wastes an afternoon.

**Evidence to return:** `./scripts/sync-env.sh verify` output. It reports
presence and shape, not values.

### W0-3 · Pre-flight

```bash
./scripts/deploy-preprod-gcp.sh --dry-run
```

Review the script before using this flag: the default phase selection also includes preparation/verification. It is not a blanket guarantee that no GCP API enablement or other setup runs. Use an already-initialized Terraform configuration with `terraform plan` for a plan-only review. Read the plan before the next step —
this is the last point at which nothing has been created.

**Evidence to return:** the plan summary line (`Plan: N to add, …`) and any
resource in it you did not expect.

### W0-4 · Provision base and database

```bash
./scripts/deploy-preprod-gcp.sh --phase base
./scripts/deploy-preprod-gcp.sh --phase db
```

Phase 2 is VPC, subnet, peering, connector, GCS vault, Artifact Registry, IAM.
Phase 3 is Cloud SQL and Secret Manager. **Billing starts here.**

**Evidence to return:** the Cloud SQL instance name and the Secret Manager
_resource names_ created. Never the secret values.

### W0-5 · Run the migration series against the real database

```bash
./scripts/deploy-preprod-gcp.sh --phase migrate
```

or directly, if you are driving it yourself:

```bash
./scripts/migrate-cloudsql.sh <DATABASE_URL>
```

The runner enforces TLS, records checksums, refuses edited history, and exits
non-zero on a failing migration. Expect **42 migrations, 0000 → 0041**.

**Evidence to return:** the runner's final summary — the count applied, and the
last migration name. If it refuses on a checksum, send that line verbatim and
stop; a checksum refusal means applied history differs from the repository and
is not something to force past.

### W0-6 · Seed representative identities

```bash
./scripts/deploy-preprod-gcp.sh --phase migrate --seed-identities
```

W0.1 asks for _representative_ data, not fixtures: multiple tenants and users
across every persona, so RLS and RBAC are genuinely exercised rather than
asserted. **Never client production data.**

**Evidence to return:** tenant count, and the persona roles seeded. No emails,
no passwords.

### W0-7 · Deploy services and verify

```bash
./scripts/deploy-preprod-gcp.sh --phase services
./scripts/deploy-preprod-gcp.sh --phase verify
```

**Evidence to return:** the health matrix from `--phase verify`, and the public
URL of the web app and the BFF.

### W0-8 · Prove strictness against the deployed environment

This is the step that actually closes W0.1, and the one most likely to be
skipped because the previous step printed green.

Use the [deployed acceptance guide](17_Deployed_Acceptance.md) and its private target JSON. `PLAYWRIGHT_BASE_URL` alone is refused: it cannot safely select the correct Auth stack, persona credentials or marketing origin.

Run the same API/browser suites against isolated preprod and production-configured acceptance deployments at one exact revision. `run-deployed-acceptance.sh` checks BFF/SSR identity, seeds synthetic multi-tenant personas, enrols MFA through the BFF and drives the browser journeys. External contact-form email must be disabled. The manual CI workflow compares both environments and fails on behavioral divergence.

**Evidence to return:** the exact revision, CI run URL and sanitized `api-results.json`/`browser-results.json` for each target. Do not share persona state, target JSON, private logs or browser reports. A local Docker rehearsal does not close this step. The workflow needs promotion to the default branch before GitHub manual dispatch is available.

### W0-9 · The prod EKS decision

`infra/terraform/envs/prod` carries
`cluster_endpoint_public_access_cidrs = ["0.0.0.0/0"]` with a "restrict via WAF
/ OIDC in production" comment above it that has never been actioned. The
Terraform gate validates that this configuration _loads_; it has never claimed
the value is one you want. Prod validating is what made this exposure visible
rather than hidden behind a configuration that could not load.

This is your decision, not a defect I can fix by guessing a CIDR.

**Evidence to return:** the CIDR list you want, or a decision to defer with a
date. I make the change and the gate re-validates.

## ENGINEERING steps for W0

| #      | Work                                        | Current status                                                                                                                                                                          |
| ------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-W0-1 | Deployed API parity lane and comparison     | Delivered: real HTTP targets, exact identity/revision checks, separate automatic Docker and manual remote CI lanes. Remote acceptance still pending.                                    |
| C-W0-2 | Target-aware browser and persona harness    | Delivered: deployment-bound private state, real MFA enrollment, scoped SSR credentials and sanitized reports. Same browser suite; local Docker rehearsal is distinct from remote proof. |
| C-W0-3 | Apply the EKS CIDR decision and re-validate | Awaits W0-9 operator policy.                                                                                                                                                            |

### Additional engineering findings from Revision 28

- **C-W0-4 delivered in Revision 30:** BFF-owned durable gap-scan snapshots, opaque hashed ownership for reads/resends, no memory fallback, explicit email delivery configuration. Migration 0037 preserves legacy cookies/snapshots. Browser and real process-restart acceptance cover persistence and foreign denial; exact committed evidence is in the session checkpoint.
- **C-W0-5 engineering delivered in Revision 36:** nine service identities, explicit secret-level allowlists and rollout ordering. See the deployment/effective-policy acceptance steps below; offline tests do not prove permissions in an existing cloud project.

The managed Supabase credentials now reach the correct Cloud Run processes; `check-cloudrun-auth-wiring.py` refuses placeholder/missing/cross-role bindings. No infrastructure was applied. Remote acceptance remains pending. C-W0-5 deployed acceptance remains open; the following findings remain engineering responsibilities:

- **C-W0-6:** contact inquiries still use process memory and SSR-owned mail; disabled delivery can claim success. Move this separate workflow behind BFF and test durable persistence/accurate dispatch outcomes.
- **C-W0-7:** reconcile q7/q11/q12 question/control scoring semantics and benchmark provenance. The current readiness benchmarks/percentiles are heuristics, not measured peer evidence. Stored historic reports remain immutable snapshots.

For report rollout, apply 0037 and deploy BFF/marketing together; seed the published control library through the normal seed workflow. Keep `AXIOM_REPORT_EMAIL_MODE=disabled` during acceptance. Production mail requires an explicit BFF mode of `delivery` and its managed `RESEND_API_KEY`; marketing does not own the report mail credential. Contact mail still has a separate legacy credential path until C-W0-6. Real provider delivery was not exercised. Follow Doc 17 for the restart probe; emailed links do not carry bearer proof and work only in the owning browser. There is no cross-device recovery/share flow yet.

## How I mark W0 Closed

I flip **W0 → Closed** when the remaining C-W0-5/6/7 findings are resolved with tests and all of these hold, and not before:

1. Your W0-5 evidence shows **all 42 migration files through 0041 applied** against a real deployed
   database, with the runner's own checksum summary.
2. Your W0-8 curl shows **401** from the deployed BFF for an unauthenticated
   request.
3. The deployed parity lane (C-W0-1) exists, is in CI, and is **green on a
   commit I can name**, comparing both remote API and browser suites — not green once by hand or only against local containers.
4. `pnpm gate:security` and the W0.0 CI job are still green on that same
   commit, so nothing regressed while the environment was being built.

If 1 and 2 hold but 3 does not, I move W0 to **Partial — deployment proven,
parity lane outstanding** and say so plainly. I will not call W0 Closed on a
successful deploy alone: a deploy proves the thing runs, and W0 is about it
running under identical rules everywhere, which only the divergence lane tests.

---

# W1 · Tenancy, RBAC, MFA, personas

**Current status: Partial.** The suite now has 63 browser journeys (including W3 inventory/proposal and W4.1 registration coverage) under `AXIOM_AUTH_MODE=strict`. C-W1-1 and C-W1-2 are delivered locally; deployment and invitation delivery remain open; C-W1-4 is implemented by 0036. Atomic recovery-code refresh is delivered by 0032 (review 13). Deploy that migration with the new BFF; the old activation RPC is intentionally no longer available to the service role.

## OPERATOR steps

### W1-1 · Deploy the accepted session-attestation posture

Accepted policy, recorded as
[Doc 11 E.2 item 3](11_Phase0-5_Gap_Closure_Plan.md#e2-still-open--not-blocking-needed-before-the-workstream-that-uses-it).

**Resolved by the user, 21 Sep 2026:** replacement authorized by a recovery code must invalidate MFA attestations issued against the retired authenticator, requiring those sessions to verify MFA again. Replacement authorized by the current authenticator preserves existing attestations. The GoTrue login itself need not end.

**C-W1-4 implemented in Revision 29 / 0036.** The consumed challenge records its verified method; pending replacements retain factor/challenge provenance. Recovery activation atomically ends all existing MFA attestations for that account, including assurance retained from earlier TOTP replacements. Current-factor replacement preserves assurance. The UI explains the effect before confirmation. SQL rollback/concurrency and two-session browser coverage accompany this change; exact merge CI is in the checkpoint. Do not ask for this policy decision again.

Apply through 0036 and deploy BFF/web together. Existing active credentials are unchanged during upgrade. Pending replacements without recorded provenance return `replacement_authorization_changed` (409): restart enrollment and prove the current factor again. Do not populate method fields by guessing how a historic challenge was verified. Verify that both existing sessions lose protected access on recovery activation, then regain it independently after fresh MFA. No password-session logout is required.

### W1-2 · Provide an email provider for invitations

The invitation/email flow is listed under W0 acceptance and is genuinely W1
work. It cannot be built against nothing: it needs a transactional email
provider, a sending domain, and SPF/DKIM on that domain.

Note that **email OTP remains deferred by accepted scope** — this is invitations
only, not a second authentication factor. Do not let a provider's "magic link"
feature quietly become an auth path.

**Evidence to return:** provider name, sending domain, and confirmation that
SPF/DKIM verify. Put the API key in Secret Manager and send me the resource
name, never the key.

### W1-3 · Enrol a real second factor on the deployed environment

Once W0-7 lands, enrol MFA as a real user on preprod: a real authenticator app,
a real TOTP code, and then a replacement using a recovery code. This exercises
the key ring against a deployed instance — a mis-set `AXIOM_MFA_ENCRYPTION_KEY`
presents as `secret_unreadable` (503), which is a deliberately distinct signal
and not a user error.

**Evidence to return:** whether enrolment, approval step-up, and replacement
each succeeded, and the exact error code if any did not.

## ENGINEERING steps for W1

| #      | What                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-W1-1 | **Delivered, Rev 23.** Purpose-bound revocation UI, atomic credential/session retirement (0031), negative/API/browser/SQL/concurrency tests                   |
| C-W1-2 | **Delivered, Rev 23.** Quarantined founder enrollment, recovery-code save and explicit verification continuation; API remains denied until login MFA succeeds |
| C-W1-3 | Invitation flow. Provider/domain evidence gates real delivery, not implementation of the internal workflow and adapter contract                               |
| C-W1-4 | **Delivered, Rev 29.** Atomic recovery session policy (0036), provenance guards, UI notice, SQL fault/race tests and two-session browser journey              |

## How I mark W1 Closed

1. C-W1-1 … C-W1-4 delivered, each mutation-tested.
2. Browser journeys cover revocation and quarantined enrolment, and I have
   confirmed they fail when the fix is reverted.
3. Your W1-3 evidence shows enrolment, step-up and replacement working against
   a **deployed** environment — the local parity stack has never been proof of
   the deployed key ring.
4. The W1 exit criterion still holds: a `viewer` in tenant A cannot see tenant
   B, cannot reach an approve button, and cannot call the approve endpoint,
   proven by test rather than inspection.

---

# W2 · Data model completion

**Current status: Partial.** This one is almost entirely mine, and I want to be
precise about the size so it is not mistaken for a small gap.

**21 of the 40 named target tables do not exist.** Delivered: estate (4), regulatory baseline (6), auth (2), and connector foundation (7, via 0033): 19 delivered. Absent: 5 execution-detail, 4 monitoring/policy, 4 multi-regulator, 4 Phase 1/2 parity and 4 rights/consent tables. The seven connector tables are metadata; W4 runtime and live authorization remain pending.

## OPERATOR steps

### W2-1 · Legacy assignment policy

0029 deliberately left existing engagements **unassigned** rather than inventing
an estate for them. Backfilling a guess would put fabricated scope into a
compliance record, which is worse than a null.

Decide: assign existing engagements to an estate by hand, or leave them
unassigned until someone reviews each one?

**Evidence to return:** the policy. If "assign by hand", I build the UI for a
human to do it; I will not write an inference.

### W2-2 · Re-run migrations after each batch I land

Each new migration batch needs applying to your deployed environment. Same
command as W0-5. The runner refuses edited history, so the order is: I commit,
you apply, never the reverse.

**Evidence to return:** the applied count and last migration name, per batch.

## ENGINEERING steps for W2

Connector schema batch **delivered in Revision 25**, with composite FKs, RLS without BYPASSRLS, private credential envelopes, constrained agent grants, SQL and real-Auth tests, and a populated upgrade test. Remaining 21 tables follow their dependent workstreams; execution normalization must wait for the W4 grant model/runtime, avoiding a second source of truth alongside existing execution fields. W3 inventory management and initial proposal review are delivered through 0035; the dependent wizard remains open. Every subsequent batch keeps the same security and upgrade evidence contract.

### Applying the connector schema batch (0033)

Apply the migration runner as W0-5 describes. It creates seven empty tables; it does not infer connectors, import credentials or grant agents access. Return the migration summary through 0033. Do not insert real credentials or mark a connector production to make a demo look live: the W4 broker and transports are not implemented. Descriptor manifests/tool descriptions must contain only non-secret metadata; encrypted envelopes are broker-private and never browser-readable.

## How I mark W2 Closed

1. All 40 named tables exist, verified **against a migrated database**, not by
   grep — a pattern search already gave me a false negative on
   `regulatory_instruments` once.
2. Every new table has RLS proven positively and negatively with
   `service_role nobypassrls`, in the disposable-container suite.
3. A populated upgrade test proves no existing row is altered or invented.
4. Your W2-2 evidence shows the same count applied on the deployed database.

---

# W3 · Client estate & onboarding

**Current status: Partial.** Migration 0034 delivers C-W3-1 and C-W3-2: audited, idempotent estate/system lifecycle APIs and `/estate`, with explicit assignment of unstarted legacy intakes. 0035 delivers C-W3-3 and proposal browser coverage under C-W3-4. The full connector/grant/readiness wizard and sustenance remain pending.

## OPERATOR steps

### W3-1 · Estate taxonomy

What is an "estate" for your actual clients — a legal entity, a business unit,
an environment (prod/staging), or a geography? The schema does not care; the UI,
the defaults and every report do. Getting this wrong is expensive to undo once
clients have data in it.

**Evidence to return:** the definition, and two or three real examples from a
client you have.

### W3-2 · System kinds

0029 ships `database`, `application`, `storage`, `identity`, `saas`, `other`.
Tell me if your real engagements need kinds that list does not cover.

**Evidence to return:** any missing kinds, or confirmation the list is enough.

### W3-3 · Onboarding proposal review

**Decision recorded from the user:** client `owner` **and tenant `admin`** may approve proposals prepared by Axiom staff. `axiom_analyst` prepares; it must not acquire direct estate mutation authority. No further role confirmation is needed for this implementation. The normalization/review workflow is delivered in 0035 and `/estate/onboarding`.

### W3-4 · Verify the inventory milestone

Apply through 0034 and deploy its BFF/web together. With an owner/admin seat, open `/estate`, create an estate with an explicit slug, add a system and declared category keys, edit it, and archive/restore it. Check that each successful mutation has one ledger event. A viewer/analyst can read but cannot manage. Do not put credentials or raw personal data into inventory descriptions/references.

To assign a legacy assessment, choose its intended estate and confirm the scope. The server accepts only an unassigned intake with no recorded findings, plans, runs, evidence or reports. Started history stays unassigned until a separate reviewed migration policy exists. Do not bypass the guard with direct SQL.

If a response is lost, keep the form open and use **Retry same request**. It retains the same body/path/key. For a persisted unknown or expired claim, inspect the request claim and ledger before reconciliation; do not generate a fresh key to force a duplicate. Archival preserves history and refuses active connectors. Future W4 activation must also serialize with estate/system lifecycle checks.

### W3-5 · Review an onboarding proposal

Apply through 0035 and deploy its BFF/web together. An assigned analyst opens `/estate/onboarding`, chooses an active estate, reviews every original intake entry, and submits its normalized name, kind, description and category keys. Submitting creates a pending proposal, not live systems. It remains available after navigation or a new session; unsent form drafts do not autosave.

A different client owner or **admin** opens the proposal, compares original and proposed fields, chooses approve/reject and records a reason. Approval adds all systems atomically and records source-index links. Rejection preserves the proposal and allows staff to submit a revision. If the estate changed since preparation, reject/reprepare rather than bypassing the content guard. An approved initial intake cannot be imported again. This is inventory review, not authority to connect to or mutate client systems.

The initial intake is a single complete batch. Per-item exclusion and later onboarding batches are future work. Region and personal-data declarations remain visible in the original snapshot, without asserting they were discovered or verified. For a client with no submitted systems, owners/admins can declare inventory directly in `/estate`.

## ENGINEERING steps for W3

| #      | What                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| C-W3-1 | Estate management API — create, update, archive — capability-gated, audited, idempotent, tenant-consistent |
| C-W3-2 | Estate management UI, plus explicit human assignment of legacy engagements per W2-1                        |
| C-W3-3 | Onboarding proposal normalization with the W3-3 review role                                                |
| C-W3-4 | Browser journeys for inventory and proposal review — delivered under strict auth                           |
| C-W3-5 | Complete resumable company → estate → inventory → connector/grant → readiness wizard — pending             |
| C-W3-6 | Re-onboarding/sustenance and access re-attestation — pending with W4/W6 dependencies                       |

## How I mark W3 Closed

1. C-W3-1 … C-W3-6 delivered and mutation-tested. C-W3-1 through C-W3-4 alone close the inventory/proposal milestone, not the full W3 roadmap.
2. Every mutation requires a capability, appends to the ledger, and is
   idempotent — proven by test, including a cross-tenant refusal.
3. No estate or scope is ever inferred. A legacy engagement becomes assigned
   only through a recorded human action.
4. Browser journeys cover a full estate lifecycle under strict auth.

---

# W4 · Connector registry and execution

## W4-1 · Register and manage a connector (engineering delivered by 0038)

Apply through **0038**, then deploy BFF/web together. Open `/connectors` as a tenant owner/admin (or assigned founder). Choose an active estate system and a reviewed descriptor; enter a name and a non-secret endpoint identifier such as `primary_crm`. Do not paste connection URLs, tokens or passwords. The registration starts in draft and is durably audited. Catalogue entries are published immutably on first registration; a conflicting published version is refused rather than overwritten.

“Enable registration” changes lifecycle only. It does not obtain credentials, probe a system, grant access or run discovery. A descriptor's assurance value is its authentication policy, not verified connectivity. Health shows a dated recorded check or “Not checked.” Reference/sandbox bindings remain explicitly non-production and cannot declare writes.

Disable before editing an enabled registration or archiving its estate/system. Disable revokes all existing grants; re-enable does not restore them. Archive additionally revokes stored credential envelopes and is terminal. A legacy descriptor missing from the reviewed catalogue may still be disabled/archived, but enabling it requires a reviewed new registration. If a form reports an unknown outcome, keep it open and use “Retry same request”; do not invent a second intent.

**Evidence:** sanitized registration/lifecycle audit IDs, exact commit and green container/CI results. Do not supply target credentials at this stage. Both archive/enable race orderings and populated migration upgrade are tested locally. No client target was contacted.

## Remaining W4 / W3 dependency gates

W4.2 vault/OAuth core is implemented but disabled; W4.3 workload identity → W4.4 live grants must be enforced before execution or graph access edges can be called live. Then complete the resumable onboarding wizard/readiness and graph; proceed to W4.5 internal tool registry, W4.6 first real SQL binding and W4.7 REST/GraphQL. Existing tables and registration status do not satisfy these gates. Readiness must remain unverified until an implemented transport and real health checks prove connectivity. Phase 2's three-live-connector-type exit remains separate from a first SQL binding.

---

# Sending evidence back

One markdown block or a file, per batch of steps. For each step: the step id
(`W0-5`), what you ran, and the output — trimmed to the summary lines, not the
whole log.

**Redact before sending.** Never include:

- any service-role key, `SUPABASE_SERVICE_KEY`, JWT secret, or
  `APPROVAL_SIGNING_KEY`
- the contents of any `.env*`
- `.axiom-runtime/personas/state.json` — it holds working test credentials
- client data of any kind

Secret Manager **resource names** are fine and are what I actually need. If I
ever need to confirm a value matches across two places, I will ask you for a
SHA-256 of it, never the value.

If a step fails, send the failure rather than working around it. A checksum
refusal from the migration runner, or a `401` that is a `302`, is more useful
to me than a green run that took a detour.

# What changes when evidence arrives

| Workstream | Now                           | Flips to                       | On                                                                                                           |
| ---------- | ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **W0**     | Partial (harness delivered)   | **Closed**                     | 39 migrations on a deployed DB + `401` from the deployed BFF + the parity lane green in CI on a named commit |
| **W0**     | —                             | **Partial, deployment proven** | The first two above, if the parity lane is still outstanding                                                 |
| **W1**     | Partial                       | **Closed**                     | C-W1-1…4 delivered + deployed MFA evidence (W1-3) + the E.2.3 decision implemented                           |
| **W2**     | Partial                       | **Closed**                     | 34/34 tables verified against a migrated database + RLS and upgrade tests + your applied-count evidence      |
| **W3**     | Inventory/proposals delivered | **Partial**                    | Verified APIs/UI, atomic audit, idempotency and client owner/admin review                                    |
| **W3**     | —                             | **Closed**                     | Full wizard and sustenance, browser journeys, reviewed proposals and recorded human legacy assignment        |

I update [Doc 11's register](11_Phase0-5_Gap_Closure_Plan.md#workstream-status-register--as-at-revision-22-21-sep-2026),
[Doc 14](14_Implementation_Progress.md) with the evidence and what it does
_not_ prove, and [Doc 15](15_Session_Handoff.md) so the next session resumes
from the new baseline — the same chain every checkpoint uses.

**W4 onward:** continue in the existing plan order after available W1–W3 work; no new permission conversation is required for authorized engineering. The W2 connector schema batch precedes W5 execution details, and live execution still depends on W4.4 grants and controlled target validation.

## W4-2 · Credential vault foundation (engineering delivered by 0039; W4.2 partial)

**ENGINEERING:** Apply through 0039 before using the administrative vault adapter. Existing format-0 envelopes are preserved but refused by the new reader; re-provision deliberately after revoking the legacy row. Owner/admin/founder authority is rechecked in SQL. A connector edit invalidates credentials bound to the former endpoint. Rotation uses connector-version and credential-revision checks; on conflict, reload and review current state. A revoked credential cannot be resurrected. Every successful create/rotation/revocation revokes existing grants, so grant approval must be repeated. Retain old KMS resources while any unrevoked envelope references them; remove a retiring key only after verifying the reference count and a successful decryption under its replacement. A failed persistence/audit transaction leaves the old envelope usable.

**OPERATOR, when deployment wiring is ready:** provision distinct per-tenant wrapping keys in Mumbai (`ap-south-1` AWS or `asia-south1` GCP), and grant the broker workload only the required encrypt/decrypt permissions. Configure explicit primary and retiring key references through the eventual broker deployment configuration. The adapters currently accept constructor configuration; there is no new environment variable or automatic shared-key fallback. No cloud provisioning is required to run fixture-based local tests.

**Evidence to return:** sanitized key resource IDs/region, tenant-to-key uniqueness and IAM policy review, successful real KMS seal/open/rotation for synthetic data, atomic SQL rollback and concurrent-change tests, exact source/migration and deployment acceptance. Never provide clear secrets, DEKs, credential payloads or bearer tokens.

### W4-2 continuation · OAuth core delivered, activation pending (0040)

**ENGINEERING:** Apply 0040. The broker factory takes strict server-owned configuration (version/provider, tenant UUID, primary/retiring KMS resources, and connector UUID → descriptor SHA/endpoint reference/target binding/HTTPS URL/IPv4 pin/deadline/optional CA). No environment variable or deployment loader is wired yet. Do not put client secrets into this configuration: provision the typed encrypted OAuth profile through the vault adapter. No administration UI/route is enabled. Changing a secret requires deliberate revoke/re-provision; key rotation reseals the same profile. Canonical HTTPS URLs exclude userinfo/query/fragment; DNS/IPv6 fallback is unavailable. Loopback is accepted only for reference-mock bindings. Address/certificate changes require reviewed configuration. Key rings retain the existing Mumbai/tenant isolation checks.

**ENGINEERING gate before activation:** Replace deny-all only with real SVID validation/current registration, current grant/target-scope mapping, kill-switch checks, and Karya action approval backed by dry-run/rollback. Recheck each controlled invocation; external bearer tokens cannot be revoked simply by changing local grant rows. Keep the broker and credentials outside agent/SSR/browser processes. Add deployment/key-ring configuration and isolated provider acceptance; then expose the authenticated internal acquisition endpoint. Do not use shared runtime bearer tokens or human admin roles as workload authority.

**Token lifetime configuration:** `maxTokenLifetimeSeconds` is an acceptance limit, not an instruction that forces the target issuer to shorten tokens. The issuer must return a lifetime that fits inside the remaining workload/grant/approval window, including exchange latency. For example, a fresh five-minute SVID cannot safely authorize a new five-minute target token after time has elapsed. Configure a shorter issuer lifetime or an approved compatible policy; do not truncate reported expiry or weaken verification to make an incompatible issuer appear healthy.

**Evidence:** 471 BFF tests, including 107 broker tests with local HTTP/TLS authorization servers, provider fixtures, SQL snapshot refusals and audit-failure cases. These do not prove deployed SPIRE, real KMS or client execution. Existing 63-browser/89-API parity checks remain regression evidence only. See review 22. W4.3/4 remain mandatory before any agent acquisition endpoint is enabled; W4.2 production activation and connector execution are still pending.

## W4-3 · Identity verification and isolated attestation foundation

**ENGINEERING delivered:** JWT-SVID verifier and current tenant-scoped registration/declared-permission adapter; no route activation. The trusted bundle source must supply authenticated public JWT keys, an explicit revision and a bounded freshness deadline. Do not obtain a bundle from a URL/issuer in a token. The initial policy accepts the nine SPIFFE RSA/EC algorithms, requires `iat`, caps lifetime at the configured value (maximum 900 seconds), requires one exact service audience, and accepts canonical unencoded SPIFFE paths only. These are explicit Axiom restrictions beyond the base standard. Custom role/scope/tenant claims grant no authority.

**Local acceptance:** from the repo root, run `python3 scripts/test-workload-identity.py` with Docker, pnpm dependencies, curl and Python 3.12+. It verifies a checksum-pinned SPIRE release, creates a fresh network-disabled container and ten distinct UID registrations, then passes private SVIDs to the BFF verifier through stdin. It requires no client/provider secrets and creates no cloud resources. Only `.axiom-runtime/workload-identity/results.json` is publishable; `dirty: true` evidence is development verification, not a release checkpoint. The CI workload-identity lane runs the same 61 outcomes on a clean revision. The runner uses container-local SQLite and Unix sockets because Docker Desktop host-bind SQLite stalled during preflight. Download cache entries become permanent only after checksum verification. A missing/download-failed archive is not a passing test.

**Remaining ENGINEERING:** isolate agent processes/credentials, provision production SPIRE selectors and trust delivery, add live registration lifecycle/revocation, bind runtime calls to tenant/task delegation and verify scope on every tool/data access. Implement RFC 8693 exchange and verify actor-chain provenance before recording it as evidence. The current shared runtime and service credentials remain open work; the isolated test is not a production isolation claim. Prativedan's new read declarations still need tenant/estate access enforcement. Keep broker acquisition disabled until W4.3 and W4.4 authority/approval checks are wired. Human/admin roles and a shared internal token are not substitutes.

**Runtime transport correction:** use `AGENT_RUNTIME_INTERNAL_TOKEN` as deployed by Helm/compose; Python now recognizes it. `INTERNAL_TOKEN` remains a legacy fallback, with the canonical name taking precedence. An unset/empty key refuses every generic invocation rather than disabling authentication. The existing `/internal/execute` stub remains 501 after valid authentication. This correction does not authorize any client action.

**Runtime audit corrections delivered in Revision 35:** staging/preprod/production use the actual append RPC; invalid configuration or missing/malformed receipts fail closed. Memory is limited to explicit local development/test. The base agent records safe phase/receipt/failure-code metadata and input/output digests, revalidates models, and refuses success after completion-audit failure. Returned errors/logs omit raw validation and exception payloads. Existing audit history is preserved; no migration rewrites prior records.

Run `./scripts/start-parity-supabase.sh`, then from `services/agent-runtime` run `uv run python ../../scripts/verify-runtime-audit.py`. The probe accepts only the isolated loopback parity API on port 56321, creates synthetic tenant/audit rows and leaves append-only evidence intact. No real cloud resources or client actions are used. Only `.axiom-runtime/runtime-audit/results.json` is publishable; require `passed: true`, `dirty: false` and the expected revision for release evidence. CI runs it after strict Auth/PostgREST parity. The ledger's actual receipt is a positive bigint, not a UUID. A completion-audit failure means intervention/reconciliation is needed if a future mutating tool already acted; it does not mean a rollback occurred. Every-tool/physical isolation still remains W4.3 work.

### W4-3 continuation · task delegation core (0041)

**ENGINEERING delivered:** `WorkloadTaskIssuer`, `WorkloadTaskAuthority`, the private PostgREST adapter and atomic delegation/revocation RPCs. Apply 0041 before deploying a controller that consumes them. Historical runs remain unchanged and cannot acquire task authority. The additive migration may remain during an application rollback; never edit prior migration history or manufacture delegations for old runs.

The controller must derive the actor from the authenticated session, hash the exact assigned input, resolve the current workload registration and select scopes from the agent contract. Apply request idempotency at the controller. Deliver the random proof only to the assigned isolated worker over the private authenticated channel; never put it in browser data, environment dumps, process arguments, logs, audit detail or Temporal history. A lost proof cannot be recovered from SQL: revoke that task and deliberately issue a new one. Generic issuance rejects Karya; do not bypass that rejection to test execution.

For every tool call, verify the SVID and proof through `WorkloadTaskAuthority` with the **server-selected** required scope. Use the resulting tenant/estate/engagement/input context rather than worker-supplied filters. Reads repeat membership, registration, task lifecycle/context, expiry, revocation and global/tenant halt checks. A removed internal-user flag invalidates internal-agent tasks. This lookup is a snapshot: domain mutations must recheck authority inside the write transaction, and external invocation requires the W4.4 controlled transport/grant/approval boundary. Existing issued external credentials need target-specific revocation; this component does not provide it.

Run `pnpm --filter @axiom/bff test` and `./scripts/test-database.sh`. The latter includes SQL role refusals, audit fault injection, real concurrent issuance/demotion/revocation and populated 0040→0041 upgrade tests. These establish the component contracts, not physical worker isolation or end-to-end tool authorization. No application route is enabled here. Before closing W4.3, demonstrate isolated workers without backend/approval/storage credentials, authenticated trust delivery and registration lifecycle, the private task handoff, actual tenant/estate-aware tool calls and verified actor chains. Keep broker acquisition disabled until W4.4 also passes.

### W4-3 continuation · confirmed invocation outcomes

**ENGINEERING delivered in Revision 38:** the existing generic agent route validates the current Python runtime's response and confirms the exact terminal run update before returning output. Missing/foreign status, agent or correlation and contradictory success are refused; accounting is bounded to the existing SQL columns. Runtime-reported failure is HTTP 502. A completion write without a matching receipt is HTTP 503 `agent_completion_unconfirmed`, including run/correlation IDs, and emits no completion event. A confirmed cancellation or previous terminal outcome cannot be overwritten.

Deploy BFF with the current runtime response contract (`agent`, `correlation_id`, `status`, accounting, `error`, `output`, `ledger_entry_ids`). Internal-token requests refuse redirects and have a 120-second deadline; long-running durable orchestration remains a separate integration task. Receipt identifiers in the response are protocol metadata, not independently verified delegation evidence.

If a request returns `agent_completion_unconfirmed`, inspect the identified run and its ledger correlation before retrying. The worker may already have acted, or the database may have committed without returning a receipt. No automatic retry, rollback or reconciliation is claimed by this change. Keep any relevant delegated task revoked until its outcome is reconciled. The generic route still uses legacy shared runtime transport, and does not create a 0041 task delegation. Do not treat it as isolated connector execution.

### Invocation UI acceptance and remaining assessment provenance

**ENGINEERING delivered in Revision 39:** Workbench, sidebar, generic modules and Assessment display success only for a matching confirmed BFF result. Assessment runs Parikshan only; its other displayed stages are not claimed as executed. It no longer changes scores, pass/fail counts or exposure through an animation. Server props supply the saved values after refresh. An ordinary ledger receipt is not sealed evidence.

Run `pnpm --filter @axiom/web test` and `pnpm --filter @axiom/e2e exec playwright test agent-ui-communication.spec.ts --workers=1` after local Auth/persona setup. The new browser cases use real login/MFA followed by explicit response injection to verify pending/failure/success presentation. These are UI contract tests. The full committed container lane should now contain 65 journeys and 89 API outcomes per configuration; require exact source revision and no retries as before.

**C-W0-7 Assessment display correction is delivered in Revision 41:** the BFF projection removes invented values and binds persisted results to the owned engagement/library with explicit empty/error states. Its exact merge CI is the closure gate. Other C-W0-7 scoring/benchmark and presentation surfaces remain open. Current Workbench fleet/prompt/environment cards are static presentation, not operational health evidence. Do not use the old demonstration scripts' default-success output as acceptance.

## C-W0-5 · Deploy and verify service IAM isolation

Engineering validation is offline: `python3 scripts/check-cloudrun-iam.py`, `python3 -m unittest discover -s tests/deployment -p 'test_*.py'`, and `terraform -chdir=infra/terraform/envs/preprod test`. All providers in the Terraform test are mocked; its four evaluated runs make no cloud changes. The approved secret matrix and limitations are in [review 25](audits/25-service-iam-review-2026-09-22.md).

For an authorized cloud rollout, use the normal deployment script and review the **full services-phase plan**, not only the base/database targets. It must create nine distinct identities, bind each service to its own identity, add 29 secret-level grants (plus the BFF retiring-key grant only during rotation), and remove the old shared account and its project-level secret/SQL/artifact grants. No manual state removal is needed. Base/database-only targeting cannot prove the retired permissions were removed. Existing project/folder/organization grants must also be reviewed; this module cannot remove grants it does not manage.

Verify active revisions use the intended identities and that web/marketing cannot access approval, MFA, service-role or evidence keys, nor impersonate a privileged identity. Verify the positive paths for each service's allowed secrets and the conditional BFF retiring-key path. Record only identities, resource names and allowed/denied outcomes, never secret values or tokens. Repeat strict API/browser acceptance against the deployed revision. For rollback, redeploy the prior reviewed image using the new service identity and approved bindings; do not route traffic to a retired revision that depends on the old shared identity.

This closes the shared Cloud Run IAM finding only after effective-policy evidence passes. It does not attest isolated agents, GCP WORM equivalence, private internal ingress, database-role isolation or a restricted SQL network allowlist. W4.3 worker isolation and W0's other gates remain mandatory. No cloud apply was performed by the implementing session.

Cross-script follow-up: `sync-env.sh secrets` no longer creates IAM bindings, so it cannot restore access for the retired shared account. Secret creation/version failures now stop the command; Cloud Run sync merges environment changes instead of replacing managed bindings, preserves the Terraform-selected identity and stops on update failure. Seven executable tests use an isolated fake `gcloud` with synthetic inputs; they make no cloud requests and assert no secret output or IAM mutation. The deployment suite now has **17 tests**. Secret sync does not remove retiring-key resources/grants: finish rotation with the reviewed full Terraform plan/apply.
