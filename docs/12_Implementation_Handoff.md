# Axiom Proof — implementation handoff

> **Current status lives elsewhere.** Read [Doc 11](11_Phase0-5_Gap_Closure_Plan.md), whose newest revision section is the current checkpoint, then [Doc 14 implementation progress](14_Implementation_Progress.md) and [Doc 15 session handoff](15_Session_Handoff.md), which names the staging head this rests on. The most recent review is [audit 60](audits/60-controller-supervision-review-2026-09-23.md).
>
> The **Historical review snapshot** section below is the original 20 September snapshot, kept for its design reasoning. Its commit tables, workspace paths and in-progress notes are historical and several are now wrong — the analyst work is committed, R-01 through R-11 have mixed closure, and staging has moved many times since. Do not resume from them.

## Revision 71 — reviewed controller supervision

**Implemented and reviewed:** protected hash-bound runtime profiles and disabled per-tenant systemd units now deliver a fixed controller lifetime. Start repeats tenant/VM/file/volume admission, checks the immutable image's production entrypoint and environment, records intent before creation, verifies exact private-IP/8443 confinement, and persists the exact container ID before start. Only the trusted UID 20000 controller receives the daemon socket; workers retain their separate boundary. Restart is disabled in Docker and systemd. Docker running is not application readiness.

**Failure handling:** a per-tenant lock prevents competing lifetimes. Uncertain creation or failed ID persistence leaves an unstarted unresolved intent for review, without name adoption or deletion. A durable start intent also blocks a premature stopped receipt when a timed-out activation still appears created. Shutdown verifies ID/name/image/labels against the protected journal and needs no metadata, issuer, DNS, KMS or backend availability. SIGTERM, unexpected exit and wrapper-death recovery preserve records. Docker gets 90 seconds for the application's 85-second grace, namespace probes are bounded to three seconds, and systemd has a 180-second stop budget. A hung/unavailable daemon still requires explicit recovery; no job reset or automatic restart is introduced.

**Review corrections and evidence:** the saved local Docker Desktop probe reproducibly reports loopback/random-port configuration for a requested private-IP/fixed-port create. The production guard continues to refuse that observation. Added direct confinement mutation tests, stricter host-option checks, stop-timeout configuration, profile/name receipt consistency and interrupted-create/persistence/stop regressions. All **165 deployment tests** and **16 Docker host-delivery outcomes**, workspace tests/lint/typecheck, formatting and security/control gates pass locally. Native Ubuntu and full source CI are pending at this documentation checkpoint; final exact-merge evidence belongs in Doc 15 and the session record. See [review 60](audits/60-controller-supervision-review-2026-09-23.md).

**Acceptance limits and next:** the native lifecycle fixture uses a deliberately synthetic process at the expected command path and a fixture-only local-node placement substitution. Production GCP placement must reject that node. Actual production-entrypoint, SPIRE identity and real assessment acceptance remain separate required gates. Effective tenant-scoped backend/secret/IAM/KMS permissions, private TLS/DNS, opaque scheduler deployment, real GCP/caller/KMS and Mumbai recovery are pending. No cloud provisioning or activation occurred. W0/W1/W2/W3/W4 remain partial; W2 stays **19/40** named targets, schema **0048 / 49 migrations / 55 public tables**. Finish this milestone, report status and stop for the user.

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

## Current handoff — Revision 63 (23 September 2026)

Revision 62 is green at `00dc35d` / CI [35842199663](https://github.com/vikashkaruna/Proof/actions/runs/35842199663): 18 jobs and 12 verified artifacts. Revision 63 adds explicit issuer initialization and separate receipt-hash review before publishing its state marker. Normal startup remains initialized-state-only. Local validation passes 96 deployment tests and 16 Docker outcomes; expanded native/combined exact-merge evidence is saved in the session.

Resume automatically in plan order in `codex/w0-w3-closure`, preserving the original checkout. Next implement reviewed runner enrollment and full node/observer lifecycle, then socket-volume mapping, full controller admission, IAM/KMS, private TLS and the opaque scheduler. Failed initialization requires explicit recovery; never delete state or overwrite review records to make a retry succeed. No cloud resources were provisioned. Remaining workers, live grants, full W3 wizard/readiness/graph, W0/W1/W2 and backup-aware key retirement remain open.

## Historical review snapshot

**As of 20 September 2026 · reviewed source: `2c54fcd` plus three uncommitted analyst files.**

W1 has substantial committed implementation but is **not complete**. Resolve the P0 review findings before declaring multi-client readiness. This document is a handoff for another implementing model; no further product implementation was performed during this review.

## Read first

1. [Doc 11, Revision 9](11_Phase0-5_Gap_Closure_Plan.md): the plan, corrections and sequence **as they stood on 20 September**. That document's newest revision section is current; read it instead.
2. [Independent review](audits/04-roadmap-review-2026-09-20.md): R-01–R-11, file evidence and actual test results.
3. [Roadmap traceability](13_Roadmap_Traceability.md): every phase module and BR/FR/NFR owner.
4. Docs [02](02_Phase_Wise_Implementation_Plan.md), [03](03_BRD_PRD.md), [04](04_Solution_Architecture.md): requirements, phase gates and architecture.

The HTML handoff map is a design reference with mock examples, not completion evidence. Text in earlier documents is historical planning context, not an instruction to deploy or implement beyond the current user's authorisation.

## Workspace and branch handoff

| Item                           | Location/state                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Review documentation           | Repository root checkout `/Users/vikash/Axiom Proof`, branch `docs/phase0-5-gap-closure-plan`, based on `12bd02e`                               |
| Claude implementation          | `/Users/vikash/Axiom Proof/.claude/worktrees/phase-0-5-gap-closure-5fd349`, branch `claude/phase-0-5-gap-closure-5fd349`, HEAD `2c54fcd`        |
| Unfinished role work           | Modified `packages/types/src/enums.ts` and `packages/types/src/rbac.ts`; untracked `infra/supabase/migrations/0015_user_role_axiom_analyst.sql` |
| Other pre-existing dirty files | Root checkout's `apps/marketing/next-env.d.ts` and `apps/web/next-env.d.ts`; untouched by review                                                |
| Remote-tracking state observed | `origin/staging` at `2c54fcd`; `origin/main` at `9575205`; this is not a cloud deployment or fresh remote verification                          |

> [!WARNING]
> **The table above is a 20 September snapshot and is no longer accurate.** `origin/staging` has advanced well past `2c54fcd`, the analyst files are committed, and migration allocation is through 0026. For the live workspace state, branch and resume sequence, use [Doc 15](15_Session_Handoff.md).

Resume in the implementation worktree, not the old root source. Recheck status and migration numbers against `origin/staging` on resumption; do not overwrite work in progress.

## Completed source changes

“Completed source” means the change exists in a commit. It does not assert migration application, release readiness or live acceptance.

| Commit    | Delivered source                                                                                               | Remaining boundary                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `25e3bc5` | W0.0 strict auth mode and removal of topology-based bypasses; BFF test foundation                              | Real strict environment and complete RLS policy verification          |
| `7b4db2c` | CI/lint/format groundwork                                                                                      | Not every package lints; parity/RLS/E2E release gates still missing   |
| `1c244e0` | Strict staging credential validation; Temporal configuration instead of placeholder                            | Boot/migrate from documented configuration and prove secret injection |
| `3b47fbc` | Shared kill state, tenant quota, execute-time dry-run expiry, awaited ledger, bounded nonce cache, batch fetch | In-flight halt, atomic durable execution and database constraints     |
| `9d6e2a5` | TS 0.1.1 citation mapping and count consistency work                                                           | Runtime bundle/publication/provenance parity; R-06                    |
| `cc3fcee` | W7.0 schema/metadata; Nazar loses control-library write declaration                                            | Hashed baseline publication and runtime scope enforcement             |
| `443a06a` | Central capability matrix, approval scope checking and selected route gates                                    | Agent/execute/read route enforcement and RLS alignment; R-01–R-03     |
| `5018188` | UI persisted-state hydration fix                                                                               | Not evidence of a roadmap module completing                           |
| `8fe16ce` | User-scoped pages/tenant helper; removal of auto-owner fallback                                                | SQL authority paths remain vulnerable                                 |
| `898ede6` | TOTP/recovery primitives and schema; per-tenant demo flag                                                      | Email OTP pending decision, secret wiring and abuse controls          |
| `c814f7b` | MFA service/endpoints and approval step-up                                                                     | Full content binding, direct-access enforcement and live acceptance   |
| `9be5ffd` | Login MFA attestations and enforcement                                                                         | Role policy/rotation/revocation/strict persona acceptance             |
| `2c54fcd` | Real membership-based switcher and capability-based navigation/rendering                                       | Analyst WIP and backend/database matrix parity                        |

## In progress — resume without duplicating

> [!NOTE]
> **This section is closed.** The analyst persona shipped in `dc901e9` — migration 0015, the capability matrix and render gating — and the acceptance points below were met, including the negative tests. It is kept because the reasoning about enum naming, membership resolution and the nine resulting role values remains correct. Nothing here is outstanding work.

The analyst role patch adds `AXIOM_ANALYST`, its capabilities and a separate enum migration. This is the “persona/user_role schema plus matrix” work described by the user. The SQL enum is named **`user_role`**; the membership table is **`tenant_users`**. There is no need to invent a `person` or `user_roles` table merely from that shorthand.

Before accepting the patch:

- Keep the enum addition in an append-only migration; apply it before consuming the new value in later migrations.
- Update exhaustive role tests (`rbac.test.ts:118,122` currently fail), navigation, seed identities and acceptance coverage together. Do not simply broaden expected arrays without negative tests.
- Prove analyst can run/review within assigned tenants, cannot approve/execute client mutations, cannot gain global kill/release or user-management authority, and cannot access unassigned tenants via direct database/REST paths.
- Reconcile retained `admin` and all declared roles across SQL, TypeScript, membership resolution, API guards and UI. The plan's eight-row proposal plus retained admin yields nine distinct role values once analyst is added.
- Do not accept migration 0015's comment that internal RLS already makes this safe; R-01/R-02 contradict it.

## Pending — concrete next work

| Priority      | Work                            | Definition of the next acceptable result                                                                                                                           |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0            | R-01/R-02 SQL authority closure | No self-promotion, target-row tenant binding, safe privileged role assignment; direct Postgres/PostgREST tests including analyst/owner/viewer and multiple tenants |
| P0            | R-03 generic invocation         | Typed payload, role gate, trusted tenant binding, engagement ownership, internal agent policy; Karya cannot bypass execute gate                                    |
| P1            | R-07/R-08 MFA closure           | Key provisioned without leakage, clean strict boot, policy clarified, shared abuse budget, revocation and reviewed-content step-up tests                           |
| P1            | R-06 regulatory publication     | TS/Python parity, immutable old/new library versions, official source hashes, real reviewer provenance; corrected reports remain traceable                         |
| P1            | W2 model slices                 | Existing schema normalised intentionally; request/batch/action keys fixed; fresh and upgrade migrations pass; table ownership classification documented            |
| P1            | W3/W4                           | Estate onboarding then real connector/grant/identity contracts and binding proofs; three live connector types required for Phase 2 exit                            |
| P1            | W5                              | Durable approved-subset execution, contract-compatible dispatch, actual dry-run/rollback, in-flight caps/kill, verification and reconciliation                     |
| P1            | W8.1–W8.3 / W3.1                | Rights/consent, breaches, founder output release, persistent review/generator/playbook journeys                                                                    |
| Continuous    | W9 / W9.1                       | Release-path CI, strict persona E2E, real SQL and operational evidence rather than mock-only assertions                                                            |
| Later / gated | W6, W7 overlays, W10            | Use Doc 11 packages and roadmap commercial gates; retain intentional scope additions                                                                               |

## W2 migration design constraints

- Numbers 0009–0014 are already occupied by kill switch, ledger vocabulary, regulatory metadata and MFA. 0015 is WIP. Allocate new numbers only after checking the worktree.
- Reuse existing `remediation_actions` dry-run/rollback/execution fields through a deliberate migration/backfill; do not introduce divergent duplicate state.
- Use composite tenant-consistent relationships for estate → system → connector → engagement → finding/plan/action. Test that a valid tenant A FK cannot point to tenant B data.
- Global reference data (controls, instruments, baselines, descriptors where global) differs from tenant-owned state and user-scoped MFA. Set publication authority and RLS accordingly.
- Protect safety transitions from broad authenticated updates. Only narrow trusted paths may set dry-run/rollback/approval/execution status; preserve the signed human-approval gate.
- Plan transaction/outbox boundaries now: consuming a token, claiming actions and recording intent cannot leave an unrecoverable half-state. A retries cache written after side effects is not a concurrency guarantee.

## Verification and reporting contract

Use the [review's result table](audits/04-roadmap-review-2026-09-20.md#verification-performed) as the latest local baseline. It includes two expected-to-fix failures, not a wholly green repository. Full build, real database, deployed state and strict E2E remain unverified. Local Python testing used 3.14.6; additionally validate the deployed 3.11 image.

For each completed slice, record commit, applied migration versions, exact command/result, environment/auth mode, tested roles/tenants and any remaining external evidence. Do not label W1 “done” before direct-access isolation, role denial and strict persona flows pass. Do not label Phase 3 “done” before all eight PRD B.10 criteria, a controlled rollback and the original production-client acceptance gate are satisfied.

## Decisions awaiting confirmation

> Resolved since this snapshot: email OTP **is** intentionally deferred; analyst access **is** assigned tenants only, without aggregate `MULTI_TENANT_READ`; higher environments self-host Supabase; every outbox redelivery needs a fresh approval; proxy trust is configured per environment and disabled by default. The still-open decisions are in [Doc 15](15_Session_Handoff.md).

- ~~Whether email OTP is intentionally deferred~~ — deferred, confirmed by the founder.
- ~~Whether analyst access is assigned tenants only~~ — assigned tenants only, confirmed.
- Sectoral pack #1 selection before pack delivery.
- Authoritative provider/retention equivalence record and marketing/API boundary reconciliation.
- BR-4 founder review versus automatic public gap-scan delivery: either introduce the review gate or record an explicit exception with precise scope.

No waiting decision blocks fixing the confirmed P0 defects or continuing independent schema design.
