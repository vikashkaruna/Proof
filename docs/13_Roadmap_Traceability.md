# Axiom Proof — roadmap traceability and delivery status

## Revision 75 — reviewed controller generation transition

**Verified baseline:** Revision 74 is complete at staging `fb4bcdf8aa5d24d813772ae5da1fbb3fc242572f`; [CI 35900630429](https://github.com/vikashkaruna/Proof/actions/runs/35900630429) passed all **19 applicable jobs and 13 exact-revision reports**. [PR 40](https://github.com/vikashkaruna/Proof/pull/40) and [registry recovery PR 41](https://github.com/vikashkaruna/Proof/pull/41) are merged. The initial staging run's two image-acquisition failures are diagnostic evidence, not closure evidence. The later exact staging run retains assessment86, native runner45, deployment197 and matching API89/browser67 results across both configurations.

**Implemented; hosted acceptance pending:** a protected external review binds the tenant, previous/new immutable profiles and file generations, and predecessor transition. After the operator separately stops the old lifetime, the helper locks the tenant, verifies the exact disabled/inactive unit and reinspects every journal-owned container ID before atomic publication. It preserves an immutable transition chain, explicitly resumes interrupted complete preparation, and requires a separate loaded-unit confirmation before runtime admission. Old profiles and incomplete/branched histories are refused. A return to an earlier generation requires its own linked review and still-valid credentials. Publication never starts, stops, enables or reloads a service and never renews or revokes backend authority. External change-record UUIDs and hashes are not human signatures or application action approval.

**Local evidence:** all **214 deployment tests** and **16 Docker host-delivery outcomes** pass. The 17 new state-machine tests cover private files, conflicting/uncertain history, live exact-ID inspection, publication/confirmation interruptions, input changes, locks and reverse transitions. Eight added native checks are pending hosted Ubuntu execution; source CI and exact staging CI must each verify all required jobs and exact-revision reports before closure. See [audit 64](audits/64-controller-generation-transition-review-2026-09-24.md) and the [operator procedure](../infra/workload/CONTROLLER_TRANSITIONS.md).

**Next and limits:** actual cloud secret publication/replication and effective inherited IAM, private TLS/DNS, opaque scheduler and real GCP IIT/caller/KMS/Mumbai recovery remain open. This engineering workflow does not establish live application readiness or production credential cutover. Existing helper-bundle replacement also remains an explicit deployment gate; installation refuses different bytes. No cloud provisioning/apply is authorized or performed. W0/W1/W2/W3/W4 stay partial; W2 **19/40**, schema **0051 / 52 migrations / 55 public tables and three private credential tables**. Continue in plan order after every green milestone. Verification lives in `.axiom-runtime/revision75`.

## Revision 74 — reviewed controller credential issuance

**Verified baseline:** Revision 73 is complete on staging `5efb40d8d6b6e0a0788b961d028d0203fa608e97`; [CI 35890118690](https://github.com/vikashkaruna/Proof/actions/runs/35890118690) passed all **19 applicable jobs and 13 exact-revision reports**. [PR 39](https://github.com/vikashkaruna/Proof/pull/39) is merged. The full roadmap remains active and incomplete; continue in plan order after each green milestone.

**Implemented, source acceptance passed:** an isolated manual operator CLI now creates protected tenant-scoped controller credentials, records immutable reviewed issuance/retirement, permits one successor per predecessor, recovers an uncertain result only through explicit identical-request resume, and permanently revokes retired authority. Signing and operator database credentials stay outside runners. The private issuer role has no application/table write grants or provisioned login/membership. Its change-record UUID is not proof of human signature and never replaces application approval/dry-run/rollback rules. No public issuance route or automatic renewal was added.

Actual CLI and BFF-consumer acceptance against the existing isolated Docker backend passes **eight new checks**, bringing assessment to **86 outcomes** with all prior 78 retained; identity remains 61 and protected trust five. A clean-database extension-schema failure is corrected by append-only migration 0051, preserving already-applied 0050. All 197 deployment tests, the full database concurrency/upgrade suite, workspace checks and control/security gates pass. Source [CI 35896023384](https://github.com/vikashkaruna/Proof/actions/runs/35896023384) passes all **19 applicable jobs and 13 exact-revision reports** for source `5577b78` (tested PR integration `8a4ef5e`). All 86 assessment outcomes retain the previous 78; native runner remains 45, and both topology labels retain identical 89 API/67 browser outcomes. Hosted deployment passes 197 tests, 26 module Terraform cases, nine root cases and the IAM inventory gate; enforced dependency and secret scans pass. The final exact staging-merge gate is recorded after verification in `.axiom-runtime/revision74/completion.json`. See [audit 63](audits/63-controller-credential-issuance-review-2026-09-23.md) and the [issuer operator contract](../infra/credential-issuer/README.md).

**Next and limits:** renewal creates a reviewed fresh credential; it does not switch a running host. Protected generation transition and actual secret publication remain next, followed by effective inherited/cloud IAM, private TLS/DNS, opaque scheduler and real GCP IIT/caller/KMS/Mumbai recovery. No cloud provisioning/apply is authorized or performed. W0/W1/W2/W3/W4 stay partial, W2 **19/40**, schema **0051 / 52 migrations / 55 public tables and three private credential tables**. Source/staging results are recorded only after verification in this task's `.axiom-runtime/revision74` checkpoint.

**Registry recovery source gate passed:** initial staging `88b2f31` (PR 40) failed before tests in CI 35897974592 attempts 1 and 2 on image registry/auth/rate-limit startup errors. PR 41 clears the setup action's GHCR-only override at three CI steps, restoring the pinned CLI registry fallback without changing image versions or checks. Renewed [source CI 35898949282](https://github.com/vikashkaruna/Proof/actions/runs/35898949282) passes **19 applicable jobs and all 13 exact-revision reports** for source `0b37017` (PR integration `b8e1168`). It retains all 86 assessment and 45 native runner outcomes, 197 deployment tests and identical API89/browser67 across both configurations; enforced security scans pass. Only renewed exact staging acceptance can close the milestone; its result is saved in `.axiom-runtime/revision74/completion.json`. See audit 63 for the failed-attempt evidence and limits.

## Revision 73 — tenant controller secret/KMS permission configuration

**Verified baseline:** Revision 72 is complete on staging `3c2ff1e53452ac3d2762da9652322050624ee486`, [CI 35879582618, attempt 2](https://github.com/vikashkaruna/Proof/actions/runs/35879582618/attempts/2): all 19 applicable jobs and 13 exact-revision reports passed. The 78 assessment outcomes retain every earlier 71; all 45 native runner outcomes and both configurations' 89 API/67 browser outcomes are preserved. [PR 38](https://github.com/vikashkaruna/Proof/pull/38) is merged. The first staging attempt and redundant documentation PR run were cancelled before closure; only successful attempt 2 is evidence.

**Implemented, source acceptance passed:** the default-off workload module now accepts a reviewed per-tenant primary/retiring dispatch-key inventory. Opted-in runners receive two empty, tenant-labelled, Mumbai-only secret containers and fixed resource-level secret-access/decryption grants. The issuer and unconfigured tenants receive none. Shared/duplicate keys, foreign projects/regions, key-version references and zero tenant IDs are refused. No secret versions, signing keys, producer encryption grants or key retirement are managed. The root conditionally enables the KMS API only for this explicit configuration and never disables that shared API on removal.

A non-secret output binds the tenant, host identity, secret resources and exact key-policy fingerprint to the backend's existing contract. Promotion retains old readable-key grants. The independent source inventory gate rejects broader roles, additional authority resources and indirect secret reads. Local module tests pass **26 evaluated cases**, the root passes **nine composition cases**, and the deployment suite passes **178 tests**. Formatting, control/drift and security gates pass. Source [CI 35888025773](https://github.com/vikashkaruna/Proof/actions/runs/35888025773) passes all **19 applicable jobs and 13 exact-revision reports** for code `ac981df` (tested PR integration `fc74c41`). Hosted deployment verification confirms 26 module cases, nine root cases, 178 deployment tests and the IAM source inventory gate. All 78 assessment and 45 native runner outcomes remain; both topology labels retain identical 89 API/67 browser outcomes. Exact staging-merge CI remains the final closure gate, recorded in this task’s `.axiom-runtime/revision73/completion.json` after verification. See [audit 62](audits/62-controller-resource-iam-review-2026-09-23.md) for the configuration contract and concrete effective-policy acceptance requirements.

**Source gate correction:** the first CI run failed on two public synthetic fingerprint false positives. Narrow exceptions preserve secret scanning. The same review exposed ineffective dependency auditing: high/critical Trivy findings and all three locked Python runtime audits now fail the gate. Removing unused `presidio-anonymizer` unblocks cryptography 50.0.1 in agent runtime and removes that dependency from the gateway; the Presidio analyzer and redaction implementation remain. Agent-runtime 187 and gateway 14 tests pass. All three locked dependency audits pass locally; renewed source CI is green, with exact staging acceptance still required.

**Next and limits:** resource configuration is not proof of effective inherited/cloud IAM. Actual per-principal allow/deny checks, secret replication/payload validation, real KMS and global key-purpose review remain external gates. Continue credential issuance/renewal and protected generation rollout, private TLS/DNS, opaque scheduler and authorized cloud identity/recovery acceptance. No cloud provisioning/apply is authorized or performed. W0/W1/W2/W3/W4 remain partial; W2 is **19/40**, schema **0049 / 50 migrations / 55 public tables**, plus the private credential registry. Continue in plan order after each green milestone and report it.

## Revision 72 — tenant-scoped controller backend

**Current checkpoint:** Revision 71 is complete on staging `fd747ad3125895fc49534db5229b72e7ea7e0f60`; [CI 35872098864](https://github.com/vikashkaruna/Proof/actions/runs/35872098864) passed all 19 applicable jobs and all 13 exact-revision acceptance reports, including 45 native runner outcomes. The user's 23 September continuation instruction supersedes the earlier one-milestone stop: proceed in plan order after each green milestone, updating implementation, tests, documentation and staging integration, and report each milestone.

**Implemented, source gate passed:** migration 0049 supplies a non-login, non-inheriting controller role, a private credential registry and tenant checks around the seven existing controller RPCs. RLS and column grants permit only registration, key-policy and opaque dispatch reads. Existing assessment logic, task/approval checks and ledger writes remain authoritative. No delegation, enqueue, policy publication, retention, direct table-write or general administration authority is granted. The existing public `has_tenant_role` read helper remains callable; it adds no write authority.

The production entrypoint requires an owner-only JSON credential file containing an anonymous gateway key and a signed controller token, rejects broad/foreign/expired credentials, and obtains the effective registered tenant through a bounded read-only PostgREST check before listening. The backend verifies the signature; SQL rechecks registration, expiry and revocation per statement. Tokens last at most one hour and registry leases at most 24 hours. A running statement can still settle after revocation; preserve existing uncertain-result recovery and never reset a claim. Signing keys remain outside the runner.

**Local acceptance:** clean source `b547b03` passes 78 real Docker assessment outcomes, preserving every earlier 71 outcome, plus 61 SPIRE identity and five protected-trust checks. Both the actual controller composition and production entrypoint use the scoped credential. All 1,004 BFF tests, 168 deployment tests, the full database migration/security/concurrency/upgrade suite, workspace checks and control/security gates pass. A failed release download was resolved using the prior session's checksum-verified archive; the first full run also required installing this checkout's missing locked Temporal dependencies. Neither failed attempt is closure evidence. Exact source/staging CI remains the final gate.

**Source gate passed:** [CI 35877565279](https://github.com/vikashkaruna/Proof/actions/runs/35877565279) passes all **19 applicable jobs and 13 exact-revision reports** for source `b547b03` (PR integration `6654a47`). This includes 78 assessment outcomes with all earlier 71 retained, 45 native runner outcomes, 61 identity checks, five protected-trust checks and 146 Temporal outcomes. Both container configurations preserve the baseline 89 API and 67 browser outcomes exactly. The documentation-only integration checkpoint records these results; exact staging merge evidence is saved in `.axiom-runtime/revision72/merge-final` and `.axiom-runtime/session-checkpoint.json` after that independent gate.

**Next:** finish exact staging acceptance for this backend boundary, then resource-level secret/KMS/IAM configuration and effective-policy acceptance, private TLS/DNS and opaque scheduler deployment. Credential issuance, renewal and reviewed host-generation replacement are deployment work, not automatic startup behavior. Real GCP IIT/caller/KMS and Mumbai recovery remain external gates. No cloud apply is authorized. W0/W1/W2/W3/W4 remain partial; W2 remains **19/40** named targets. Schema is **0049 / 50 migrations / 55 public tables**, plus the private credential registry. See [audit 61](audits/61-controller-backend-scope-review-2026-09-23.md).

> **This matrix is a 20 September snapshot and is not the current status.** It
> maps every phase-table module in Doc 02 to a closure owner, which nothing else
> does, so it is kept for that mapping. For what is actually delivered now, read
> the [workstream status register in Doc 11](11_Phase0-5_Gap_Closure_Plan.md#workstream-status-register--as-at-revision-22-21-sep-2026),
> which is re-derived from the repository each checkpoint. Where the two
> disagree, the register is right.

**Review snapshot: 20 September 2026, implementation `2c54fcd` + analyst WIP.** This matrix restores coverage of every phase-table module in Doc 02 and maps it to a closure owner. It is not a production acceptance report.

**Status:** `Partial` = source foundation exists, required journey/evidence incomplete; `Pending` = intended capability not delivered (a stub or prototype does not qualify); `Gated` = roadmap demand/funding/safety condition precedes delivery; `External` = not provable from repository. `Source complete` is used only for individual committed changes in [Doc 12](12_Implementation_Handoff.md), not whole phases.

## Revision 71 — reviewed controller supervision

**Implemented and reviewed:** protected hash-bound runtime profiles and disabled per-tenant systemd units now deliver a fixed controller lifetime. Start repeats tenant/VM/file/volume admission, checks the immutable image's production entrypoint and environment, records intent before creation, verifies exact private-IP/8443 confinement, and persists the exact container ID before start. Only the trusted UID 20000 controller receives the daemon socket; workers retain their separate boundary. Restart is disabled in Docker and systemd. Docker running is not application readiness.

**Failure handling:** a per-tenant lock prevents competing lifetimes. Uncertain creation or failed ID persistence leaves an unstarted unresolved intent for review, without name adoption or deletion. A durable start intent also blocks a premature stopped receipt when a timed-out activation still appears created. Shutdown verifies ID/name/image/labels against the protected journal and needs no metadata, issuer, DNS, KMS or backend availability. SIGTERM, unexpected exit and wrapper-death recovery preserve records. Docker gets 90 seconds for the application's 85-second grace, namespace probes are bounded to three seconds, and systemd has a 180-second stop budget. A hung/unavailable daemon still requires explicit recovery; no job reset or automatic restart is introduced.

**Review corrections and evidence:** the saved local Docker Desktop probe reproducibly reports loopback/random-port configuration for a requested private-IP/fixed-port create. The production guard continues to refuse that observation. Added direct confinement mutation tests, stricter host-option checks, stop-timeout configuration, profile/name receipt consistency and interrupted-create/persistence/stop regressions. All **168 deployment tests** and **16 Docker host-delivery outcomes**, workspace tests/lint/typecheck, formatting and security/control gates pass locally. Source [CI 35868902682](https://github.com/vikashkaruna/Proof/actions/runs/35868902682) verifies **all 19 applicable jobs and 13 exact-revision result artifacts** for source `b25729d` (PR integration `748bdea`). Native runner acceptance passes **45 outcomes**, retaining all earlier 33; issuer 17, host delivery 16, assessment 71, identity 61 and protected trust five also pass. Browser/API results agree across both local topology labels. The final staging merge remains a separate exact-revision gate; its run, commit and artifact verification are saved in this task's `.axiom-runtime/session-checkpoint.json` and reported at the milestone stop. See [review 60](audits/60-controller-supervision-review-2026-09-23.md).

**Acceptance limits and next:** the native lifecycle fixture uses a deliberately synthetic process at the expected command path and a fixture-only local-node placement substitution. Production GCP placement must reject that node. Actual production-entrypoint, SPIRE identity and real assessment acceptance remain separate required gates. Effective tenant-scoped backend/secret/IAM/KMS permissions, private TLS/DNS, opaque scheduler deployment, real GCP/caller/KMS and Mumbai recovery are pending. No cloud provisioning or activation occurred. W0/W1/W2/W3/W4 remain partial; W2 stays **19/40** named targets, schema **0048 / 49 migrations / 55 public tables**. The later Revision 72 continuation instruction supersedes this historical milestone stop.

## Revision 70 — reviewed tenant-to-VM placement check

Revision 69 is **complete and green** at `55282ea`, CI [35859815075](https://github.com/vikashkaruna/Proof/actions/runs/35859815075): all 19 applicable jobs and 13 exact-revision artifacts verified. This includes 33 native runner, 17 native issuer, 16 host-delivery, 71 assessment and five protected-trust outcomes. This revision continues the accepted dedicated runner VM per tenant decision.

**Implemented:** a protected, hash-reviewed placement profile binds a tenant and controller file generation to a Mumbai zone and private IPv4 address. A read-only root helper compares fixed GCP instance metadata with the installed SPIRE GCP node identity, checks the address belongs to exactly one active non-loopback host interface, verifies protected controller files and live runtime-volume mappings, then reobserves placement and file bindings before returning. The helper and file installer are now included in the checksum-reviewed runner bundle. Metadata reads use only five fixed nonsensitive paths, no proxy/redirect/alternate endpoint, bounded responses and an enforced total child-process deadline. No access or identity token is requested.

**Validation:** 14 new tests include actual local HTTP responses, proxy bypass, redirects, response bounds, a real trickling-child timeout, tenant/node/address mismatch and composition refusal. All 141 deployment tests and 16 disposable Ubuntu file-delivery outcomes pass locally. Native/system-wide evidence still requires exact-merge CI. See [review 59](audits/59-controller-placement-review-2026-09-23.md).

**Boundary and next:** this supplies the preflight for supervised activation; it does not start a controller or yet integrate a host supervisor. Metadata is an observation of the trusted host placement, not cryptographic GCP attestation, continuous authorization, effective IAM or backend credential scoping. Next integrate this check into the supervised container lifetime, preserving exact container ownership, private binding and graceful shutdown. Then complete private TLS/DNS/secret delivery, scoped IAM/KMS and opaque scheduler deployment. Actual GCP identity and Mumbai recovery remain external; other W3/W4 and W0/W1/W2 obligations remain open. No cloud provisioning or schema/application-approval changes.

## Revision 69 — dedicated runner VM per tenant

Revisions 67–68 are **complete and green** together at `a7df79f`, CI [35857993698](https://github.com/vikashkaruna/Proof/actions/runs/35857993698): all 19 applicable jobs and 13 exact-revision artifacts verified. Evidence includes 33 native runner outcomes (all prior 24 retained), 71 assessment outcomes and five protected-trust outcomes. The initial native fixture hash-format mismatch was corrected without weakening production checks.

**Accepted user decision:** use a dedicated runner VM for each tenant, rather than multiple tenant controllers sharing one runner VM. The separate private Mumbai issuer remains the existing shared trust service; public APIs remain on Cloud Run. This intentionally refines the earlier generic dedicated-runner placement and preserves one configured tenant per controller.

**Implemented deployment foundation:** the opt-in workload module now takes a map keyed by canonical tenant UUID. Each entry has its own runner instance, service account, private address, protected state disk and independent controller source ranges. The issuer is separate. Host firewall rules target individual identities; a tenant's controller allowlist cannot open another tenant's runner. Tenant identifiers are carried in runner metadata, labels and output references. Resource keys are tenant-stable, generated names fit provider limits and potential derived-name collisions are refused. `workload_vms = null` still creates no workload hosts; the module supports bounded batches of 1–100 tenants, not a product entitlement limit.

**Validation:** 13 module boundary tests and eight preprod-root tests pass using provider mocks, including multi-tenant resource separation, per-tenant ingress/default deny, metadata/output bindings, invalid ranges/tenant IDs, name limits and default-off composition. Both configurations validate. No cloud apply, IAM grant, controller activation or schema change occurred. See [review 58](audits/58-dedicated-tenant-runner-review-2026-09-23.md).

**Next:** supervised controller lifecycle must match the configured tenant to its reviewed assigned VM/node and private address before activation. Dedicated VMs do not by themselves establish tenant-scoped backend credentials, effective IAM/KMS permissions or scheduler authorization; those gates remain explicit. Continue private TLS/DNS/secret delivery, scoped cloud permissions and opaque scheduler deployment, then remaining W4/W3 and W0/W1/W2 obligations. Existing populated Terraform state needs a reviewed migration/retirement plan; no automatic move or reassignment of an old unbound runner is supplied.

## Revision 68 — protected controller file delivery

**Implemented:** a fresh-output review-bundle preparer and a root-only file installer/checker for the controller's fixed `service.json`, `backend.key`, `tls.key` and `tls.crt` inventory. The manifest binds tenant, reviewed SPIRE installation, intended immutable controller image and exact file hashes. Installation checks the actual installed runner binding and fixes the container paths, Docker endpoint, runtime volume and private listener contract. A root-owned generation manifest precedes file writes; a completion receipt follows them. Existing complete identical generations retain their inodes; incomplete or altered generations are preserved and refused, without repair or overwrite.

**Protection and evidence boundary:** root-only host ancestry encloses a mountable root-owned `0755` directory whose files are owned by UID/GID 20000 with mode `0400`. The checker verifies ownership, permissions, hashes, hard-link count, canonical ancestry and receipt. It can run without the original source bundle. This delivers files; it neither starts/enables a service nor proves TLS/KMS/backend readiness, image admission or effective cloud permissions. The actual controller `--check` remains authoritative for full runtime validation. No secrets are placed in environment variables, command arguments or logs.

**Validation:** ten new delivery tests bring the deployment suite to 127; the protected local preparer and overwrite refusal pass. The native runner gate adds nine checks using actual root filesystem ownership and a read-only container consumer, including worker-UID denial, foreign-node refusal, tamper preservation and incomplete-generation refusal. Native results require the exact-merge artifact before being called green. See [review 57](audits/57-controller-protected-files-review-2026-09-23.md).

**Next:** supervised controller container lifecycle with reviewed immutable-image admission, private listener binding, host-namespace volume preflight, explicit ownership before stop/remove and bounded graceful shutdown. Then private DNS/TLS/secret and scoped IAM/KMS deployment, opaque scheduler delivery, and external GCP/Mumbai backup acceptance. Other W3/W4 and W0/W1/W2 obligations remain open. No cloud provisioning or schema changes; W2 remains 19/40 named targets.

## Revision 67 — exact controller workload admission

Revision 66 is **complete and green** at `1d7aa92`, CI [35854335396](https://github.com/vikashkaruna/Proof/actions/runs/35854335396): all 19 applicable jobs and 13 exact-revision artifacts verified, including 71 assessment outcomes. The initial persona job failed during Supabase startup; its isolated retry passed without code changes.

**Review finding and fix:** a successful Workload API bundle read establishes access to trust material, but does not establish the controller role. Startup now requests the exact `spiffe://<domain>/controller/assessment` JWT-SVID for the fixed `axiom-controller-startup` audience. It requires one matching response, then verifies signature, subject, audience, lifetime and independently current trust under the existing exact-node health gate **before reading backend dispatch policy**. Transport is the configured protected Unix socket with bounded messages/deadline and no retries or alternate transport. The bearer is never returned, persisted or logged. This startup proof adds no tenant/task/action authority and does not replace job approvals or per-tool identity checks.

**Validation:** real Unix gRPC tests cover the exact wire request/metadata, wrong role/audience/signature, expired/future/overlong tokens, malformed/ambiguous responses, denial, timeout, unavailable socket and changed trust. Composition checks prove denied admission cannot query the backend. Real SPIRE acceptance additionally requires controller admission and demonstrates that a registered worker can read bundles yet cannot pass controller admission. The existing actual entrypoint and assessment checks remain required. See [review 56](audits/56-controller-role-admission-review-2026-09-23.md). Exact-merge CI remains the closure gate; do not infer whole-roadmap completion from these checks.

**Next:** protected controller host delivery and supervised container lifecycle; then private TLS/DNS/secret and scoped IAM/KMS deployment plus opaque scheduler delivery. Actual GCP attestation, valid Google caller identity, real cloud KMS and Mumbai backup/restore remain external gates. No cloud provisioning, schema changes or altered application approvals. Other workers/actor chains, live grants, full W3 wizard/readiness/graph and W0/W1/W2 remainder remain open; W2 remains 19/40 named targets.

## Revision 66 — actual controller entrypoint acceptance

Revision 65 is **complete and green** at `66e6147`, CI [35852588998](https://github.com/vikashkaruna/Proof/actions/runs/35852588998): all 19 applicable jobs and 13 exact-revision artifacts verified. Native runner/container acceptance passes 24 outcomes, including exact returned SPIFFE identity; native issuer remains 17 and Docker delivery remains 16.

**Review and implementation:** the existing controller integration exercised composition with explicit fixture database/KMS/OIDC ports. It did not execute the deployed `--check`/`--serve` entrypoint. A new disposable Docker fixture now invokes that inherited entrypoint unchanged with owner-only files, a real HTTPS backend connection to isolated Supabase and real protected SPIRE/health volumes. The private TLS proxy permits only the existing key-policy read and counts refused operations; it does not add a production plaintext or development-credential fallback. Synthetic keys enter private stdin and protected volume files, never Docker environment or command arguments.

**Acceptance:** eight new checks cover actual startup, TLS-host mismatch, foreign node, unsafe backend-file permissions, the private TLS listener rejecting invalid identity, absence of backend/TLS secrets in container environment, graceful SIGTERM, and no job claims. The fixture leaves an explicit pending job available, checks database claims before/after and requires no forbidden backend operation attempts. It cleans up its own named containers, volume and network. The local assessment suite now has 71 outcomes, preserving all prior 63; strengthened final checks and exact-merge CI evidence are saved separately. See [review 55](audits/55-controller-entrypoint-acceptance-review-2026-09-23.md).

**Next in order:** protected controller host delivery and supervised container lifecycle, then private TLS/DNS/secret and scoped IAM/KMS deployment plus opaque scheduler delivery. Valid Google caller identity, real cloud KMS, GCP node attestation and Mumbai backup/restore remain external gates. This local entrypoint test uses the acceptance image inheriting the production entrypoint, not an attestation of a deployed production image. Other workers/actor chains, live grants, full W3 wizard/readiness/graph and W0/W1/W2 remainder remain open. No cloud provisioning or schema/application-authorization changes; schema 0048 / 49 migrations / 55 tables, W2 targets 19/40.

## Revision 65 — protected host socket and health volumes

Revision 64 is **complete and green** at `24e6a87`, CI [35850300471](https://github.com/vikashkaruna/Proof/actions/runs/35850300471): all 19 applicable jobs and 13 exact-revision artifacts verified, including 16 native runner, 17 native issuer and 16 Docker delivery outcomes. No intervening staging implementation was found. The initial fixture run correctly hit the production observer start limit; only the independent test sequence was corrected.

**Implemented:** a root-only, installed-manifest-bound helper prepares or checks two fixed Docker local-driver mappings: `/run/workload` and `/run/spire-health`. Names derive from the reviewed filesystem UUID; labels bind the manifest, UUID and purpose. The helper requires initialized bound state, the reviewed live runner/observer, exact current node health and protected stable source directories. All existing conflicts are checked before writes. A protected review record precedes volume creation; identical explicit retries preserve matching mappings. Options require read-only, nosuid, nodev and noexec binds. Existing active mounts must still reference the original source device/inode and carry those flags. No arbitrary source, driver, Docker endpoint, deletion, repair or container launch is accepted.

**Validation:** 117 deployment tests and local Docker bundle delivery; the expanded native runner gate adds a real container consumer, wrong mapping/UID/image refusal, exact image/UID admission, socket replacement and atomic health refresh, retaining all earlier lifecycle outcomes. Native results remain pending until the exact-merge artifact verifies them. The consumer receives read-only workload/health directories and no admin or daemon socket. The fixture uses local join-token identity, not GCP attestation. See [review 54](audits/54-runtime-volume-delivery-review-2026-09-23.md).

**Next in order:** complete controller container admission/startup and supervision with protected configuration, backend credentials, private TLS and scoped IAM/KMS; then opaque scheduler delivery and external GCP/backup acceptance. Other workers/actor chains, live grants, full W3 wizard/readiness/graph and W0/W1/W2 remainder remain open. No cloud deployment, schema or application-approval changes. Schema 0048 / 49 migrations / 55 public tables; W2 targets 19/40.

## Revision 64 — reviewed runner enrollment and native lifecycle gate

Revision 63 is **complete and green** at `ddf3954`, CI [35848499207](https://github.com/vikashkaruna/Proof/actions/runs/35848499207): all 18 applicable jobs and 12 exact-revision artifacts verified, including 16 Docker and 17 native issuer outcomes. No intervening staging changes were found.

**Implemented:** the protected initializer now supports runners using the reviewed GCP-bound manifest, exact filesystem and separately reviewed bootstrap CA. It requires disabled/stopped normal services and a stopped observer. The bounded static initialization unit keeps the normal runner hardening and Docker/mount dependencies, but does not launch the observer. Before stopping, the helper queries the protected node admin socket twice, requiring the exact expected node, an unexpired certificate and recent non-regressing issuer synchronization. Its receipt binds those observations, the bootstrap CA and stopped key/recovery-state bytes. Separate receipt review refuses changed state or bootstrap trust and an expired node certificate. It publishes the marker without starting normal services. Normal boot remains ready-only with `rebootstrap_mode=never`; interrupted initialization requires explicit recovery.

**Validation:** 105 deployment tests and 16 local Docker delivery outcomes pass. A separate native Ubuntu runner CI gate exercises actual installed commands and service lifetimes, including observer restart/expiry, issuer outage/recovery, mount loss, missing keys and Docker loss. The new native gate remains unverified until its exact-merge artifact passes. Its disposable fixture substitutes local join-token attestation and one exact generated node identity into a separately hashed test bundle; production GCP configuration has no fallback. It cannot prove GCP IIT, cloud IAM or client execution. See [review 53](audits/53-runner-enrollment-lifecycle-review-2026-09-23.md).

**Next in order:** host workload socket/metadata delivery to containers, controller admission and lifecycle, then scoped IAM/KMS, private TLS/DNS and opaque scheduler delivery. Actual GCP attestation, Mumbai backup/restore, other workers/actor chains, live grants, full W3 wizard/readiness/graph and W0/W1/W2 remainder remain open. No cloud provisioning or schema changes; schema remains 0048 / 49 migrations / 55 public tables, W2 targets 19/40.

## Current delivery addendum — Revision 63 (23 September 2026)

| Roadmap scope                   | Implemented                                                                                                                                      | Remaining                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| W4.3 first issuer enrollment    | Explicit manifest-bound initialization, bounded separate unit, durable request and stopped-state receipt, separately reviewed marker publication | Native exact-merge acceptance is recorded in the session; actual cloud activation and operational recovery remain external |
| W4.3 node/controller activation | Previous protected delivery and initialized-state restart preserved                                                                              | Reviewed runner enrollment, full node/observer lifetime, socket mapping, controller/TLS/IAM/scheduler                      |
| W3/W4 product journeys          | Existing estate/proposal/connector/assessment milestones retained                                                                                | Full wizard/readiness/graph, other workers, live grants and remaining W0/W1/W2                                             |

Revision 62 base `00dc35d` / CI 35842199663 is green (18 jobs,12 artifacts). Revision 63 is a component increment, not whole-workstream closure. No schema or application approval change.

## Current delivery addendum — Revision 62 (23 September 2026)

| Roadmap scope                            | Implemented in this revision                                                                                                  | Remaining acceptance                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| W4.3 separate issuer/runner hosts        | Pinned, bounded host bundle; protected first installation; initialized-state-only systemd units; protected CA digest delivery | Explicit first enrollment, marker workflow, runner/observer runtime acceptance and real GCP identity |
| Persistent trust and fail-closed restart | Integrity preflight; UUID mount/service dependency; native disposable Linux mount-loss and recovery test gate                 | Deployed disk replacement, Mumbai backup/restore, operational recovery approval                      |
| W3/W4 end-to-end execution               | Existing estate/proposal, registry, assessment/controller milestones retained                                                 | Full wizard/readiness/graph, other workers, live grants, controller/scheduler deployment             |

Revision 61's verified base is `13ce160` / CI 35833267173. Revision 62 protected-host artifacts at `c493fc7` / CI 35841077123 verify 16 Docker and 11 native issuer outcomes; combined final-merge results are recorded in the session. Prepared host files do not constitute cloud deployment or complete W4.3. Schema remains 0048 / 49 migrations / 55 tables; W2 targets remain 19/40.

## Current delivery addendum — Revision 61 (23 September 2026)

This addendum updates current implementation traceability without treating the historical phase tables below as current completion claims. Verified baseline: staging `3e505c5`, CI [35831554373](https://github.com/vikashkaruna/Proof/actions/runs/35831554373). Final Revision 61 merge evidence is recorded in the saved session.

| Roadmap / boundary                             | Current evidence                                                                                                                                                            | Still required                                                                                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W4.3 workload identity and execution perimeter | Exact node/UID/image preparation, persistence and issuer-sync gate; read-only UUID/mount/state guard and explicit fresh-disk checks                                         | Supervised/pinned host install, first enrollment, mount-loss stop, CA delivery, effective cloud IAM/firewalls, deployed composition and other workers/actor chains |
| M0.3 / W3 assessment execution                 | Isolated Parikshan path, durable one-time claims and independently confirmed persistence; stale health refuses new authority while historical confirmation remains possible | Complete live onboarding/readiness journey, production acceptance and other agent workflows                                                                        |
| W4.1 / W4.2 / W4.4 connectors                  | Registry/contracts/lifecycle and vault/broker core retained; health does not create connector grants                                                                        | Live grants/UI, real connector operations and later accepted W4.5–7 scope                                                                                          |
| W3 estate and onboarding                       | Estate/inventory APIs/UI and owner/admin-reviewed proposals retained                                                                                                        | Full resumable wizard, readiness and live estate graph                                                                                                             |
| W0 / W1 / W2 and later phases                  | Existing work preserved; schema tip 0048, 49 migrations, W2 named targets 19/40                                                                                             | Earlier contact/provenance, invitation/deployed acceptance and remaining 21 W2 targets; later intentional work remains separately scoped                           |

Neither passing local SPIRE tests nor health freshness proves a cloud deployment, instant global revocation or complete W3/W4 delivery. Read [Doc 16](16_Operator_Completion_Runbook.md) before operational activation.

## Phase 0

| Module                              | Status             | Evidence / remaining delivery                                                                                              | Owner         |
| ----------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------- |
| M0.1 Corporate & Digital Foundation | Partial / External | Marketing exists; incorporation, tax/banking, domain/trademark and commercial setup require founder evidence               | Founder; W8   |
| M0.2 Control Library v0             | Partial            | 46-control TS source corrected to 0.1.1; Python still 0.1.0, provenance publication pending                                | W7, R-06      |
| M0.3 Parikshan Assessment v0        | Partial            | Agent and tests exist; pinned-version runtime parity and reviewed live journey required                                    | W7/W3.1       |
| M0.4 Prativedan Report v0           | Partial            | JSON/HTML generator; branded PDF and released-output evidence pending                                                      | W8/W8.3       |
| M0.5 Free Gap-Scan                  | Partial            | Working source route/scoring/report/email; API-boundary, version parity, release policy and deployed acceptance unresolved | W0/W7/W8.3    |
| M0.6 Agent Workbench                | Partial            | UI and prompt tables; invocation authority and prompt/version governance incomplete                                        | W1/W3.1, R-03 |

## Phase 1

| Module                         | Status  | Evidence / remaining delivery                                                       | Owner          |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------- | -------------- |
| M1.1 Drishti Discovery v0      | Partial | Interview-driven agent; persisted resumable intake and delivery journey             | W3.1           |
| M1.2 Vibhaag Classification v0 | Partial | Classification core; human correction/review queue and feedback persistence         | W3.1           |
| M1.3 RoPA Generator            | Partial | `ropa_generator.py`; persisted processing records, review/export                    | W2/W3.1/W8     |
| M1.4 Sudhaar Planner v0        | Partial | Typed planner and rollback definitions; persisted reviewed plan lifecycle           | W3.1/W5        |
| M1.5 Saakshi Evidence v0       | Partial | Evidence client/agent; actual retention and provenance proof                        | W8, R-10       |
| M1.6 Policy & Notice Generator | Partial | Generator core; drafts/versioned notices, localisation and release                  | W3.1/W8.1/W8.3 |
| M1.7 Human Review Console v0   | Partial | Remediation approval UI; general output review/reasons/founder release missing      | W8.3           |
| M1.8 Delivery Playbook Capture | Partial | `playbook.py`; persistence, time-spent capture, ranked backlog, delivery benchmarks | W3.1/W9.1      |

M1.8 exists in the phase table but is omitted from Doc 02's master index. This matrix uses phase-table IDs and includes it.

## Phase 2

| Module                        | Status  | Evidence / remaining delivery                                                                                    | Owner      |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- | ---------- |
| M2.1 Connector Framework v1   | Pending | Contracts, credentials, grants, health and three live families: DB, Workspace/M365, object store                 | W4         |
| M2.2 Drishti Live Discovery   | Pending | Batch/targeted real scans, scheduling, incremental/delta and load controls                                       | W3/W4/W6.1 |
| M2.3 Automated Classification | Partial | Agent/LLM path; review queue and recorded corrections                                                            | W3.1/W4    |
| M2.4 Evidence Vault v1        | Partial | Store/client and schema; WORM verification, pack assembly and exports                                            | W8         |
| M2.5 Lekha Audit Ledger v1    | Partial | Append-only/hash-chain primitives; all-path audit coverage, correlation, checkpoint/restore proof                | W5/W8/W9.1 |
| M2.6 Approval Workflow v1     | Partial | Token engine, approval route and step-up; RLS/safety transitions, bound conditions and sealed approval artifacts | W1/W5/W8.3 |
| M2.7 Multi-Format Reporting   | Partial | HTML/JSON; four report formats, PDF and artifact-level citations                                                 | W8         |
| M2.8 DSAR/Rights Tracker      | Partial | Table and UI; verified identity, server clock, fulfilment and response delivery                                  | W8.1       |
| M2.9 Nazar Regulatory Watch   | Partial | Agent and UI; source ingestion, scheduling, impact mapping, reviewed baseline delta                              | W7/W6.1    |

One initial live SQL binding is an intentional intermediate milestone. It does not satisfy the original three-connector-type Phase 2 exit.

## Phase 3 — core product

| Module                              | Status  | Evidence / remaining delivery                                                                      | Owner            |
| ----------------------------------- | ------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| M3.1 Structured Remediation Planner | Partial | Typed output/rollback definitions; version/hash/dependency/cycle and connector-bound persistence   | W5               |
| M3.2 Dry-Run/Simulation             | Pending | Real simulator, readable structured diff, hash/expiry and failure refusal                          | W5               |
| M3.3 Customer Approval Console      | Partial | UI/partial selection/step-up exist; real dry-run, complete authority and sealed approval proof     | W1/W5/W8.3       |
| M3.4 Karya Execution v1             | Pending | Karya remains skipped stub; dispatch contract, batch key, durable work and approved-only execution | W2/W5, R-04/R-05 |
| M3.5 Rollback Engine                | Pending | Execute and simulate rollback, failure threshold, immediate failure escalation                     | W5               |
| M3.6 Blast-Radius Guardrails        | Partial | Planner cap and shared BFF halt state; live pre/in-flight governor and worker halt absent          | W5, R-09         |
| M3.7 Post-Execution Verification    | Pending | Re-run targeted checks and seal closure evidence; independent reconciliation                       | W5               |
| M3.8 Consent Management             | Partial | UI; purpose/notice capture, immutable history, withdrawal, seven-year product retention and EN/HI  | W8.1             |
| M3.9 Breach & Incident Ops          | Partial | Table/UI; clocks, reviewed notifications and warm forensic instrumentation                         | W8.2             |
| M3.10 Continuous Monitoring         | Pending | Restart-safe schedules, drift, alerts and monitor health                                           | W6.1             |
| M3.11 Client Portal                 | Partial | Tenant context/navigation improved; complete persona journeys, evidence/report/approval wiring     | W1/W8/W9         |

The eight PRD B.10 scenarios remain the core acceptance suite. Code-only tests and a staging rollback are necessary but do not replace the roadmap's production-client acceptance requirement.

## Phase 4

| Module                          | Status           | Evidence / remaining delivery                                                                            | Owner   |
| ------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------- | ------- |
| M4.1 Standing Approval Policies | Pending          | Human-authored, versioned, revocable boundaries and exception escalation through the existing token gate | W6.2    |
| M4.2 Multi-Regulator Reuse      | Pending          | RBI/SEBI/IRDAI/CERT-In overlays, mapping strength and reusable evidence                                  | W7      |
| M4.3 Connector Framework v2     | Pending          | CRM/HRMS/warehouse/ticketing/repository descriptor + live protocol/permission coverage                   | W4.7    |
| M4.4 Self-Serve SMB             | Pending          | Self-onboarding, entitlements, guided journey and operating support                                      | W6.3    |
| M4.5 TPRM                       | Pending          | Vendor/DPA/questionnaire/sub-processor lifecycle                                                         | W6.4    |
| M4.6 DPIA Automation            | Pending          | Guided generation, risk justification, review and export; control prose is not automation                | W6.4    |
| M4.7 Partner/White-Label        | Partial          | Shell and tenant relation; assigned-client security, management and brand workflow                       | W6.5/W8 |
| M4.8 Sectoral Pack #1           | Pending decision | Select Healthcare or BFSI before building overlay/evidence/remediation pack                              | W7      |
| M4.9 Sanket Market Signals      | Pending          | `_run()` explicitly returns empty stub output; actual sourced signals and internal delivery needed       | W6.6    |

## Phase 5

| Module                            | Status                                | Gate and remaining delivery                                                                                         | Owner         |
| --------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------- |
| M5.1 Split-Plane                  | Gated                                 | Enterprise demand + funding; actual control/data-plane separation, connectivity and failure tests                   | W10.1/W4      |
| M5.2 On-Prem/VPC                  | Pending, intentionally pulled forward | W10 accepted addition; complete appliance, air-gap operation, self-hosted model, upgrades, backup and install tests | W10           |
| M5.3 Enterprise Tier              | Partial / Gated                       | RBAC foundations only; customer login SSO/SAML, custom SLA/support; original certification gate retained            | W1/W10.1      |
| M5.4 SOC 2 Type 2 / ISO 27001     | Gated / External                      | Revenue-triggered certification programme and audit evidence; not established by CI                                 | Founder/W10.1 |
| M5.5 Sectoral Pack #2             | Gated                                 | Cash-funded second vertical; select after pack #1 evidence                                                          | W7/W10.1      |
| M5.6 Consent Manager Registration | Gated / External                      | Original capital/reserves and regulatory registration gate; distinct from building a CMP or coverage controls       | Founder/W10.1 |
| M5.7 Policy-Governed L4           | Gated                                 | Proven L3 track record and explicit policy-bound approval design; never unrestricted autonomous mutation            | W6.2/W10.1    |

## BR/FR coverage ownership

Ranges below cover **all IDs in each PRD family**, including the specific easy-to-miss clauses shown. This is an acceptance ownership map, not a claim every subclause passes.

| Requirements | Closure owner   | Required evidence                                                                                                       |
| ------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| BR-1, BR-2   | W1/W5/W6.2      | No unapproved mutation; real dry-run and executable rollback; standing policy has recorded human authority              |
| BR-3, BR-5   | W5/W8           | Every read/write agent action audited; immutable evidence and append-only corrections                                   |
| BR-4         | W8.3            | Founder output release gate in Phases 0–2; resolve public gap-scan exception explicitly                                 |
| BR-6         | W0/W4/W9.1/W10  | India residency across all stores and egress; redacted provider input                                                   |
| BR-7         | W8              | Output language avoids legal opinion or compliance guarantee                                                            |
| BR-8         | Founder/W9.1    | New recurring spend covered by realised revenue; preserve phase gates                                                   |
| FR-1 (all)   | W3/W3.1/W4/W6.1 | Read-only-first, batch/targeted/incremental discovery and complete inventory metadata                                   |
| FR-2.1–2.4   | W3.1/W4         | Classification confidence/category flags, low-confidence review and human correction feedback                           |
| FR-3.1–3.5   | W7/W3.1/W6.1    | Versioned scoring, SDF, exposure, scheduled/on-demand/post-remediation assessment                                       |
| FR-4.1–4.5   | W8/W8.1         | WORM, provenance, multi-control evidence, packs and configurable retention                                              |
| FR-5.1–5.5   | W5              | Vetted typed action, owner/effort/dependencies, rollback, cycle detection and plan versioning                           |
| FR-6.1–6.4   | W5              | Diff before approval; valid expiry; failed simulation blocks approval                                                   |
| FR-7.1–7.7   | W1/W5/W8.3/W6.2 | Explicit/partial approval, conditions/identity/expiry, sealed artifact, rejection reason, standing policy               |
| FR-8.1–8.7   | W5              | Exact approved scope, concurrency/order, durable idempotency, snapshots, caps, immediate halt and environment awareness |
| FR-9.1–9.4   | W5              | On-demand/automatic rollback, dry-run/logging and immediate diagnostic escalation                                       |
| FR-10.1–10.5 | W5/W8/W9.1      | Hash-chain, complete model/prompt/input/output/approver provenance, shared correlation and independent verification     |
| FR-11.1–11.4 | W8              | Four formats, branded PDF/structured export, claim-to-artifact trace and agent/approver identity                        |
| FR-12.1–12.3 | W8.1            | DSAR fulfilment, purpose/cookie consent/withdrawal, English/Hindi                                                       |
| FR-13.1–13.4 | W8.2            | Intake/triage, notification clock, affected-principal notices and forensic evidence                                     |

## NFR acceptance register

| NFR                       | Owner         | Measurement / closure evidence                                                                     |
| ------------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| 1 Residency               | W0/W9.1/W10   | Data-flow and provider inventory incl. logs/backups/telemetry; actual region and egress assertions |
| 2 Isolation + tenant keys | W1/W2/W4/W9.1 | Direct RLS/cross-tenant FK attacks denied; per-tenant key ID, isolation, rotation/recovery proof   |
| 3 Encryption              | W0/W9.1       | TLS 1.3 and AES-256 deployment verification, not just config intent                                |
| 4 Least privilege         | W4            | Default read-only; explicit timed/revocable write scopes enforced at target and broker             |
| 5 Auditability            | W5/W8         | Failure injection cannot produce unaudited action; durable intent/completion reconciliation        |
| 6 Availability            | W9.1          | Monitoring and error-budget evidence for 99.5% Phase 3 / 99.9% Phase 5                             |
| 7 Throughput              | W4/W9.1       | 1M records/hour/connector measured with safe source load and resource/cost conditions recorded     |
| 8 Reports                 | W8/W9.1       | Standard assessment report generated in <5 minutes on representative data                          |
| 9 Recovery                | W9.1/W10      | Timed restore: RPO ≤1h, RTO ≤4h; restored ledger/evidence verify                                   |
| 10 Model portability      | W10           | Provider adapter tests and fully self-hosted model path by Phase 5                                 |
| 11 Cost                   | W9.1          | Tenant token + infrastructure attribution; alert if cost reaches 15% of ACV                        |
| 12 Explainability         | W7/W8         | Each conclusion reconstructs inputs, prompt/model/config and exact versioned clause                |

## Prototype route reconciliation

The original HTML route map remains a design artifact. These mappings avoid building duplicates when resuming:

| Prototype reference             | Current route / action                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/remediation`                  | `/plans` and `/plans/[id]`                                                                        |
| `/dsar`                         | `/dsars`                                                                                          |
| `/breach`                       | `/breaches`                                                                                       |
| `/policies` standing policies   | Distinguish W6 standing policies from W3.1 policy-document drafts; current shell is not an engine |
| `/estate/graph`                 | New planned W3.5 surface, not in the original 21-route prototype                                  |
| Account MFA                     | `/settings/security` and `/verify` added by W1                                                    |
| Demo tenants in wiring examples | Illustrative only; runtime switcher derives memberships                                           |

Phase exits also require commercial and operating evidence: client counts, delivery-time reductions, funded recurring costs and production-client remediation outcomes. Those remain founder-owned, not presumed missing code and not silently waived by this plan.
