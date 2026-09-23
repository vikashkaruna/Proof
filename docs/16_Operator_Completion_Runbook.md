# Axiom Proof — Operator completion runbook: W0 → W4

## Revision 74 — reviewed controller credential issuance

**Verified baseline:** Revision 73 is complete on staging `5efb40d8d6b6e0a0788b961d028d0203fa608e97`; [CI 35890118690](https://github.com/vikashkaruna/Proof/actions/runs/35890118690) passed all **19 applicable jobs and 13 exact-revision reports**. [PR 39](https://github.com/vikashkaruna/Proof/pull/39) is merged. The full roadmap remains active and incomplete; continue in plan order after each green milestone.

**Implemented, source acceptance passed:** an isolated manual operator CLI now creates protected tenant-scoped controller credentials, records immutable reviewed issuance/retirement, permits one successor per predecessor, recovers an uncertain result only through explicit identical-request resume, and permanently revokes retired authority. Signing and operator database credentials stay outside runners. The private issuer role has no application/table write grants or provisioned login/membership. Its change-record UUID is not proof of human signature and never replaces application approval/dry-run/rollback rules. No public issuance route or automatic renewal was added.

Actual CLI and BFF-consumer acceptance against the existing isolated Docker backend passes **eight new checks**, bringing assessment to **86 outcomes** with all prior 78 retained; identity remains 61 and protected trust five. A clean-database extension-schema failure is corrected by append-only migration 0051, preserving already-applied 0050. All 197 deployment tests, the full database concurrency/upgrade suite, workspace checks and control/security gates pass. Source [CI 35896023384](https://github.com/vikashkaruna/Proof/actions/runs/35896023384) passes all **19 applicable jobs and 13 exact-revision reports** for source `5577b78` (tested PR integration `8a4ef5e`). All 86 assessment outcomes retain the previous 78; native runner remains 45, and both topology labels retain identical 89 API/67 browser outcomes. Hosted deployment passes 197 tests, 26 module Terraform cases, nine root cases and the IAM inventory gate; enforced dependency and secret scans pass. The final exact staging-merge gate is recorded after verification in `.axiom-runtime/revision74/completion.json`. See [audit 63](audits/63-controller-credential-issuance-review-2026-09-23.md) and the [issuer operator contract](../infra/credential-issuer/README.md).

**Next and limits:** renewal creates a reviewed fresh credential; it does not switch a running host. Protected generation transition and actual secret publication remain next, followed by effective inherited/cloud IAM, private TLS/DNS, opaque scheduler and real GCP IIT/caller/KMS/Mumbai recovery. No cloud provisioning/apply is authorized or performed. W0/W1/W2/W3/W4 stay partial, W2 **19/40**, schema **0051 / 52 migrations / 55 public tables and three private credential tables**. Source/staging results are recorded only after verification in this task's `.axiom-runtime/revision74` checkpoint.

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

Revision 71 is complete and verified on staging; Revision 72 backend scoping is in acceptance. Activation remains gated on the outstanding deployment checks above.

### Axiom Minds Private Limited · https://axiomminds.ai

**Document:** 16 · Companion to the [workstream status register](11_Phase0-5_Gap_Closure_Plan.md#workstream-status-register--as-at-revision-22-21-sep-2026) · **As at** Revision 74, 23 Sep 2026

The register says what is delivered. This says **who does what next**, for W0
through W4, and — the part that is usually missing — **exactly what
evidence flips a status**, so that "done" is something you can hand over rather
than something either of us asserts.

## Revision 71 — reviewed controller supervision

**Implemented and reviewed:** protected hash-bound runtime profiles and disabled per-tenant systemd units now deliver a fixed controller lifetime. Start repeats tenant/VM/file/volume admission, checks the immutable image's production entrypoint and environment, records intent before creation, verifies exact private-IP/8443 confinement, and persists the exact container ID before start. Only the trusted UID 20000 controller receives the daemon socket; workers retain their separate boundary. Restart is disabled in Docker and systemd. Docker running is not application readiness.

**Failure handling:** a per-tenant lock prevents competing lifetimes. Uncertain creation or failed ID persistence leaves an unstarted unresolved intent for review, without name adoption or deletion. A durable start intent also blocks a premature stopped receipt when a timed-out activation still appears created. Shutdown verifies ID/name/image/labels against the protected journal and needs no metadata, issuer, DNS, KMS or backend availability. SIGTERM, unexpected exit and wrapper-death recovery preserve records. Docker gets 90 seconds for the application's 85-second grace, namespace probes are bounded to three seconds, and systemd has a 180-second stop budget. A hung/unavailable daemon still requires explicit recovery; no job reset or automatic restart is introduced.

**Review corrections and evidence:** the saved local Docker Desktop probe reproducibly reports loopback/random-port configuration for a requested private-IP/fixed-port create. The production guard continues to refuse that observation. Added direct confinement mutation tests, stricter host-option checks, stop-timeout configuration, profile/name receipt consistency and interrupted-create/persistence/stop regressions. All **168 deployment tests** and **16 Docker host-delivery outcomes**, workspace tests/lint/typecheck, formatting and security/control gates pass locally. Source [CI 35868902682](https://github.com/vikashkaruna/Proof/actions/runs/35868902682) verifies **all 19 applicable jobs and 13 exact-revision result artifacts** for source `b25729d` (PR integration `748bdea`). Native runner acceptance passes **45 outcomes**, retaining all earlier 33; issuer 17, host delivery 16, assessment 71, identity 61 and protected trust five also pass. Browser/API results agree across both local topology labels. The final staging merge remains a separate exact-revision gate; its run, commit and artifact verification are saved in this task's `.axiom-runtime/session-checkpoint.json` and reported at the milestone stop. See [review 60](audits/60-controller-supervision-review-2026-09-23.md).

**Acceptance limits and next:** the native lifecycle fixture uses a deliberately synthetic process at the expected command path and a fixture-only local-node placement substitution. Production GCP placement must reject that node. Actual production-entrypoint, SPIRE identity and real assessment acceptance remain separate required gates. Effective tenant-scoped backend/secret/IAM/KMS permissions, private TLS/DNS, opaque scheduler deployment, real GCP/caller/KMS and Mumbai recovery are pending. No cloud provisioning or activation occurred. W0/W1/W2/W3/W4 remain partial; W2 stays **19/40** named targets, schema **0048 / 49 migrations / 55 public tables**. The later Revision 72 continuation instruction supersedes this historical milestone stop.

## Revision 71 operator procedure — explicit reviewed lifetime

1. Use a freshly reviewed host bundle containing `controller_runtime.py`. Existing differing installed helpers are refused; no in-place host upgrade or cloud apply is supplied. Finish the earlier protected file/placement procedure and independently review their hashes.
2. Prepare a canonical root-owned `0600` runtime profile using `infra/workload/controller-runtime.example.json`. Bind tenant UUID, protected placement path/hash and the HTTPS backend origin; no credentials or arbitrary Docker flags belong in this profile. Review its SHA separately.
3. Run `/usr/bin/python3 -I -B /opt/axiom/spire/1.15.3/controller_runtime.py --install PRIVATE_PROFILE_PATH REVIEWED_SHA256`. Installation writes only protected static files, idempotently for identical content. It neither reloads systemd, pulls images, enables nor starts services. Conflicting existing content is retained and refused.
4. Keep activation closed until effective tenant-specific backend/secret/KMS, private TLS/DNS and scheduler acceptance are complete. On a separately authorized target, review the unit and absence of drop-ins/overrides, daemon configuration, exact production image, journal and placement before daemon-reload and explicit start. Run in the daemon's host mount namespace; do not add namespace isolation that hides source mounts. Root and daemon administrators remain trusted. No service-manager active state is application readiness.
5. Stop the running unit via systemd. After a wrapper failure, `ExecStopPost` attempts exact-ID shutdown. If the daemon was unavailable, preserve state and explicitly invoke `--stop TENANT_UUID REVIEWED_SHA256` after restoring the reviewed daemon. Recovery checks protected ownership only; live metadata/issuer health are not prerequisites. No unconfirmed stop gets a completion receipt.
6. An intent without a durable container receipt is unresolved even if a matching name exists. Never delete its journal to retry, adopt by name, reset client jobs or treat an uncertain create as successful. This revision provides no automatic repair or retirement mechanism. Stopped containers and journals remain for reviewed retention; completed dispatch retention remains separately configurable with its 90-day default. Host/disk loss, forced daemon termination and retained-container growth remain operator concerns, not transparent resumable execution.

## Revision 70 procedure — read-only tenant placement preflight

1. Prepare a fresh reviewed runner bundle containing `controller_files.py` and `controller_placement.py`. The existing installer refuses replacement of differing installed helpers; this is not an in-place host upgrade mechanism. Follow the protected host-delivery procedure and review an upgrade separately if the host is already populated.
2. Deliver the controller generation using the now-bundled file helper. Create a root-owned `0600` regular placement file with protected canonical ancestry, using `infra/workload/controller-placement.example.json`. Set the tenant UUID, exact controller-manifest SHA, and the zone/private address from **that same tenant's** Terraform runner output. The installed SPIRE node must bind that runner's project and immutable instance ID. Independently review the profile SHA; do not merely calculate and accept an unreviewed file on the target.
3. In the Docker daemon's host mount namespace run `/usr/bin/python3 -I -B /opt/axiom/spire/1.15.3/controller_placement.py --check PRIVATE_PROFILE_PATH REVIEWED_PROFILE_SHA256`. This rechecks protected files, actual VM metadata, the assigned private interface and live volumes. It neither publishes a readiness receipt nor starts/enables a service. Success is point-in-time preflight; the pending supervisor must run it again immediately before activation.
4. Metadata is read directly from the fixed IPv4 link-local GCP endpoint with the Google request/response header, using only tenant attribute, instance ID, project ID, zone and primary-interface private IP. No token endpoints, configurable metadata URL, ambient proxy or redirect are accepted. Missing metadata, wrong placement, stale/unready SPIRE volumes and changed files fail closed. Never replace this with a local-mode fallback on a real runner.
5. Keep the activation gate closed until supervised lifecycle, effective tenant-scoped backend/secret/KMS permissions and private TLS/scheduler acceptance are complete. Stop/recovery must be able to use durable ownership even when metadata or issuer health is unavailable. The local HTTP tests are transport fixtures, not real GCP attestation. The native SPIRE fixture remains explicitly local join-token identity and cannot satisfy this production GCP check.

See [review 59](audits/59-controller-placement-review-2026-09-23.md). No cloud resources were created or changed.

## Revision 69 placement decision — one runner VM per tenant

The user selected **dedicated runner VM per tenant**. Keep the separate private issuer and public Cloud Run APIs. Configure `workload_vms.tenants` as a map of canonical tenant UUIDs to optional `controller_source_ranges`; the previous top-level range setting and single `hosts.runner` output are superseded. Use `workload_vm_hosts.runners[TENANT_UUID]` and `workload_vm_hosts.issuer` for reviewed private references. The example stays disabled with `workload_vms = null`.

Each tenant receives a separate runner identity, address, instance and state disk. Controller ingress is evaluated independently for each tenant; an empty range set leaves that runner closed. The module accepts 1–100 tenants per reviewed batch, at most eight private IPv4 /24–/32 scheduler ranges per tenant. Batches and provider quotas are deployment constraints, not tenant entitlement settings. No cloud apply has occurred.

Before activation, bind the service configuration's tenant UUID, SPIRE node/instance identity, file-generation manifest and private endpoint to the **same** tenant's reviewed host output. The new VM metadata/labels document placement; the pending host supervisor must enforce this correspondence. Complete tenant-scoped backend/secret/KMS permissions and signed scheduler identity separately. A dedicated VM or service-account attachment alone is not proof of those permissions.

Do not reassign an old runner by changing labels or blindly importing it under a tenant key. The resource/output shape has changed. If an earlier module was applied elsewhere, stop at a reviewed Terraform migration/retirement plan: preserve issuer identity, node state and existing disks; retain deletion protection and `prevent_destroy`. There are no automatic state moves, resource deletions or tenant retirement actions in this change. Offline provider-mock tests are not a real cloud plan or GCP attestation.

## Revision 68 procedure — protected controller files, without activation

1. Prepare a private, canonical input directory containing only `service.json`, `backend.key`, `tls.key` and `tls.crt`, all owner-only `0600` regular files. Input ancestry must be controlled by the current owner/root and not writable by group/world. Do not use `/tmp`, symlinks or hard links. Retrieve real credentials through the environment's protected secret-delivery process; never paste them into shell arguments or this repository.
2. Copy `infra/workload/controller-review.example.json` into a private review file and replace every placeholder with the intended tenant UUID, installed runner manifest SHA and reviewed immutable controller image ID. The service configuration must bind that tenant and installed node/domain, `/run/workload/api.sock`, `/usr/bin/docker`, `unix:///run/docker.sock`, and the installed `axiom-workload-api-<filesystemUuid>` volume. Use `listen: {host: "0.0.0.0", port: 8443}` inside the future container. Its backend/TLS paths must be `/run/controller-secrets/backend.key`, `/run/controller-secrets/tls.key` and `/run/controller-secrets/tls.crt`. Keep the remaining configuration compatible with the existing controller service schema.
3. Run `python3 scripts/prepare-controller-files.py PRIVATE_REVIEW_JSON PRIVATE_INPUT_DIR FRESH_OUTPUT_DIR`. Review the manifest and intended bindings; record its SHA. The command creates a fresh private bundle and refuses overwrite. Transfer it using protected delivery to a root-owned canonical `0700` source directory with root-owned `0600` files on the approved runner. Review the installer code too; execute only a trusted root-controlled copy of `infra/workload/controller_files.py`, with the already reviewed SPIRE helpers installed under `/opt/axiom/spire/1.15.3`.
4. As root, invoke `/usr/bin/python3 -I -B REVIEWED_CONTROLLER_FILES_PY --install ROOT_OWNED_SOURCE_DIR REVIEWED_MANIFEST_SHA`. Files are placed at `/etc/axiom/controllers/<tenant>/<manifestSHA>/files`. Root-only host ancestry prevents unrelated host UID 20000 processes reaching them. The intended container receives this directory read-only at `/run/controller-secrets`; it sees UID/GID 20000 files with mode `0400`. No container, volume mapping, registration or unit is created by this command.
5. Before future activation, run the same reviewed helper with `--check TENANT_UUID REVIEWED_MANIFEST_SHA`. This verifies the delivered generation against the current installed runner binding without needing the source bundle. Full controller `--check`, live volume/health checks, image admission and private host-IP publishing remain separate supervised-start gates. A file receipt is not runtime readiness or application approval.
6. Preserve a partial or altered generation for operator review. There is no automatic repair, overwrite, switch of active generation, credential rotation or deletion. Completed identical delivery is idempotent. A later credential change requires a fresh reviewed generation and the still-pending controlled activation/retirement procedure.

Nine native checks are added to the runner gate; treat them as pending until the exact merge passes. Cloud credentials, actual certificate validity and backend/KMS reachability are not proven by copying files. The local preparer validation and ten new deployment tests cover the source and generation contract.

## Revision 67 operator boundary — exact controller registration

Before starting the controller, review a registration for exactly `spiffe://<reviewed-domain>/controller/assessment`, under the exact approved node, UID 20000 and immutable controller image digest. Set JWT-SVID TTL to at most 300 seconds. Another registered workload's access to JWT bundles is insufficient. The startup request uses the fixed `axiom-controller-startup` audience and rejects a missing, different, ambiguous, expired or unverifiable identity before reading backend policy. Keep worker UID 20003 separate and retain protected socket/health mappings.

Do not diagnose this refusal by dumping SVIDs, loosening selectors, sharing the node admin socket, extending the accepted lifetime or bypassing issuer health. Verify the reviewed registration and current node/issuer state. This is process startup admission, not continuous controller-role reattestation or an application approval; existing per-tool task/identity checks still apply. Host delivery/supervision and deployment acceptance remain the next pending work.

## Revision 66 acceptance boundary — actual controller entrypoint

The local Docker gate now calls the inherited production `--check` and `--serve` entrypoint using owner-only files, HTTPS to the real isolated Supabase stack and actual SPIRE/health volumes. It verifies credential permissions, TLS audience hostname, exact node health, invalid caller refusal, no startup claim or forbidden backend-operation attempts, and graceful shutdown. The synthetic backend proxy exists only inside the disposable fixture network; it is not a deployable plaintext fallback. Secrets are absent from Docker environment and argv.

This verifies the entrypoint contract, not completed host delivery or operational activation. Next prepare protected controller configuration/credential/TLS delivery, immutable image admission and supervised container lifetime. Host preflight must run in the Docker daemon’s mount namespace; then the controller itself remains in its constrained container namespace. Preserve UID 20000, read-only runtime volumes and the separate worker UID 20003. Only the trusted controller receives daemon access.

Deployment still needs valid Google caller identity, real scoped KMS/secret permissions, private DNS/TLS, actual GCP IIT and Mumbai backup/restore. The local fixture neither decrypts via a real cloud KMS nor submits an authorized scheduler job through this entrypoint. Existing composition tests separately exercise worker persistence with fixture provider ports. Do not activate the cloud module from these local results alone.

## Revision 65 operator gate — host socket/health delivery

1. Complete separate issuer and runner enrollment/marker review, approved node/image registrations and the reviewed normal node/observer startup. The socket preparation check needs a live node with current exact-node health; this does not activate the controller or client jobs. Node bootstrap and controller activation are separate gates.
2. Review the new installed manifest and bundled `spire_volumes.py`. Supported Docker configuration is the local `/run/docker.sock` daemon with `/var/lib/docker` data root and the same mount namespace as the root preflight. Run the helper in the host namespace; private daemon/caller mount namespaces are refused. Arbitrary daemons, remote drivers, source paths and extra volume options are refused.
3. Run `/usr/bin/python3 -I -B /opt/axiom/spire/1.15.3/spire_volumes.py --prepare REVIEWED_MANIFEST_SHA256` as root. It records the fixed mapping in `/etc/axiom/spire/runtime-volumes.json` before creating missing volumes, validates existing mappings without replacement, and reports `workloadApiVolume` and `healthVolume`. A conflict is never deleted or repaired. After uncertainty, inspect the record and actual mappings; only an explicit identical reviewed retry is supported.
4. Run the same helper with `--check REVIEWED_MANIFEST_SHA256` before controller activation, including after a host/Docker restart. This path makes no changes. It checks current health and runtime directory identity; an already mounted volume with a stale source inode is refused. The record is configuration evidence, not perpetual readiness or workload authorization.
5. Use the reported workload volume at `/run/workload` with `readonly,volume-nocopy` for the controller and isolated workers. Only the controller needs the health volume at `/run/spire-health`, also read-only. Workers must receive neither the admin socket nor Docker socket. The controller remains gated on its separate admission, protected configuration/credentials, private TLS and scoped cloud permissions.

Native CI covers a real unprivileged container consumer and local SPIRE image/UID admission. It does not prove full controller activation, GCP identity or effective IAM. Expanded exact-merge native results are pending at this source checkpoint; save confirmed results in the session before claiming closure.

## Revision 64 operator gate — runner enrollment

After issuer trust review, prepare the runner bundle with the approved CA fingerprint, exact GCP project/instance node and runner filesystem UUID. Confirm the static installation and loaded units. Normal runner services must be disabled/stopped; the observer and initialization units must be static/stopped. Prepare/mount the empty intended disk separately.

1. Run `/usr/bin/python3 -I -B /opt/axiom/spire/1.15.3/spire_enrollment.py --initialize runner REVIEWED_MANIFEST_SHA256` as root. No join-token or alternate-attestation argument exists in the production command. It records the request, checks actual node identity/recent sync and leaves stopped, unmarked state with a receipt.
2. Review `/etc/axiom/spire/initialization-receipt.json` against the intended node/disk, independently delivered CA and installed manifest. This is historical enrollment evidence, not current workload readiness. The public issuer exports from Revision 63 remain the CA-delivery source; runner receipts expose only bounded node/sync metadata and hashes.
3. Before the observed node certificate expires, run `/usr/bin/python3 -I -B /opt/axiom/spire/1.15.3/spire_enrollment.py --seal runner REVIEWED_RECEIPT_SHA256`. It records review and publishes the marker, without enabling/starting normal services. Expired evidence, changed state or interrupted requests require explicit recovery; do not clear files to retry.
4. Keep controller/client-job activation gated on reviewed workload registrations, protected host-to-container socket delivery, controller policy/credentials and the remaining runtime prerequisites. Separately reviewed normal node/observer startup supplies the live prerequisites for socket preparation. Normal startup requires the sealed state and starts the separately supervised observer. Consumers must still enforce current health age and exact node binding.

Native CI uses an explicitly substituted local join-token fixture on a fresh hosted VM. It is not a GCP deployment or evidence of effective cloud permissions. At this source checkpoint its expanded gate is pending; final exact-merge results belong in the saved session.

## Revision 63 operator gate — explicit issuer initialization

This is deployment code for a reviewed host, not authorization to provision or initialize a higher environment in this development session. Application mutation approval tokens remain a separate mechanism.

1. Finish protected first-file delivery from Revision 62, with the new initialization helper/unit included in the reviewed manifest. This remains a fresh installation contract: the installer refuses differing existing files. An upgrade path for already installed hosts is not implemented.
2. Review and load the installed units with the service manager. Before initialization the normal issuer unit must be disabled and inactive, and the initialization unit must be inactive/static. Drop-ins, transient units, unexpected fragment paths, pending reloads, queued jobs and live processes are refused.
3. Separately prepare and mount the intended empty disk. The CLI will verify its fixed device alias, real UUID, whole ext4 mount, private directory and required mount flags. It never formats or mounts a disk. Existing keys, marker or request/receipt/approval files require recovery review rather than a fresh attempt.
4. As root, invoke `/usr/bin/python3 -I -B /opt/axiom/spire/1.15.3/spire_enrollment.py --initialize issuer REVIEWED_MANIFEST_SHA256`. It records the request before starting a bounded initialization unit, observes both signing authority types, stops the issuer and writes `/etc/axiom/spire/initialization-receipt.json`. The state remains unmarked; normal startup must still fail.
5. Review the request and receipt against the intended host/disk, trust domain and independently approved trust delivery. Review `/etc/axiom/spire/initialization-bundle.json` and `/etc/axiom/spire/initialization-ca.pem` while the issuer remains stopped. Their SHA-256 fingerprints are bound to the receipt and rechecked at sealing. The receipt contains fingerprints, not private keys. The trusted pinned SPIRE process supplies the live bundle; the helper does not replace SPIRE cryptographic validation. Verify that shutdown completed and investigate any interruption. These root-owned records document administrative review, not a signed application approval or proof of who typed the command.
6. Supply the separately reviewed receipt hash to `/usr/bin/python3 -I -B /opt/axiom/spire/1.15.3/spire_enrollment.py --seal issuer REVIEWED_RECEIPT_SHA256`. It refuses changed bytes/configuration/state or active/enabled services, records the approval first and creates the identical bound marker without overwrite. It does not enable/start normal services. Proceed with separately reviewed registrations, CA delivery and operational activation only after remaining prerequisites are satisfied.
7. Failed or interrupted operations retain their records/state for review. Never erase keys, remove a request, rewrite a receipt/marker, disable the checks or rerun with an empty-disk fallback to recover automatically. Marker publication cannot be replayed. Explicit failure recovery and runner enrollment remain subsequent implementation/acceptance work.

The native fixture now exercises the same installed CLI and checks refusal without a permit, wrong receipt, changed stopped state and replay, plus all prior mount-loss/recovery outcomes. Full exact-merge results are saved in the session. See [review 52](audits/52-issuer-initial-enrollment-review-2026-09-23.md).

## Revision 62 operator gate — protected host files

1. Select a reviewed Ubuntu 24.04 image with Python 3.12, systemd 255, `blkid` and (runner only) Docker. Review image provenance separately from the SPIRE release checksum. Keep issuer and runner roles on separate hosts. This revision does not select a cloud image or create either VM.
2. Copy `infra/workload/host-policy.example.json` to private working storage, replace every example identity/address/UUID/image digest and select the actual architecture/role. The state UUID must come from the intended disk's superblock. For runners, independently review the issuer CA fingerprint and set `bootstrapCaSha256` to the exact delivered PEM bytes. A matching digest proves reviewed byte delivery, not issuer identity by itself.
3. Obtain the SPIRE 1.15.3 musl archive for that architecture. Run `python3 scripts/prepare-workload-host.py policy.json archive.tar.gz NEW_DIRECTORY [bootstrap.pem]`. The offline preparer refuses existing output and checks the archive pins. Review all generated files and preserve the printed manifest SHA256 out of band.
4. Deliver the reviewed bundle through a trusted channel to an absolute, root-owned directory with protected ancestors and owner-only files on the target. Use a separately trusted copy of `infra/workload/spire_host.py`: `/usr/bin/python3 -I -B spire_host.py --check-bundle /root/reviewed-bundle REVIEWED_SHA256`, then `--install` with the same arguments. Installation checks the host profile and all existing destinations before delivery; manifest publication is last. It never repairs or overwrites a conflict. Partial files require review; identical complete files can be reused. It never invokes service activation.
5. **Stop at file delivery until enrollment/recovery is reviewed.** Normal units require an already initialized state disk and identical protected marker. They cannot initialize an empty disk, create that marker, reenroll a replacement node or enable rebootstrap. Do not use test fixture initialization on a real host. A reviewed first-enrollment workflow and full runner/controller activation acceptance remain next work.
6. Preserve `/run/workload` and `/run/spire-health` as root-owned 0755 directories; only their intended sockets/metadata reach containers. Admin sockets remain private. Review Docker service and image provenance, exact node/UID/image registrations, socket-volume mapping, TLS, IAM and backup policy before deployment. This revision's installer is not an upgrade or uninstall tool.

**Verified component evidence:** protected-host CI at `c493fc7` / run 35841077123 has 16 Docker and 11 native issuer outcomes with matching clean-source artifacts. Full combined final-merge evidence is saved in the session.

**Required evidence:** deployment unit tests; both-role real Docker delivery results; native Ubuntu systemd results showing blank/missing/changed state refusal, actual mount disappearance stopping SPIRE, and remount/restart retaining the original CA and registration. CI publishes only sanitized booleans and source revision. Native tests format only their own verified loop-backed fixture on a disposable GitHub runner; they refuse ordinary/local invocation. Runner units currently have syntax/delivery coverage; complete runner/observer supervision and GCP metadata attestation remain unproven. `systemd-analyze verify` alone is not lifecycle evidence. See [review 51](audits/51-spire-host-delivery-review-2026-09-23.md).

## Revision 61 — persistent state guard before supervised startup

1. Prepare a reviewed state binding outside the repository with `python3 scripts/prepare-workload-state.py /protected/spire-policy.json issuer <actual-filesystem-uuid> /protected/issuer-state.json` (use `runner` and its own UUID for the runner). The existing policy supplies the domain and exact runner node. Output is owner-only and never overwritten. Do not use an example UUID as operational configuration.
2. On the intended host, install the reviewed guard and host binding as root-owned protected files; the fixed binding path is `/etc/axiom/spire/state.json`. The host must provide Python 3.11+ and `/usr/sbin/blkid`. The root-controlled device alias is `/dev/disk/by-id/google-axiom-issuer-state` or `google-axiom-runner-state`. Only a reviewed whole ext4 filesystem mounted at `/var/lib/spire` with `rw,nosuid,nodev,noexec` passes. The mounted root and role directory must be owner-only; every ancestor must be canonical, root-owned and non-writable by group/others.
3. **First enrollment remains separate:** `python3 /protected/spire_state.py --empty issuer` (or `runner`) only checks a blank disk. It changes nothing and must never be substituted for a ready check in service startup. Do not automatically format, repair or reenroll on refusal. Approved formatting/mounting, pinned binary installation, initial issuer/node enrollment, CA delivery and stopped-state verification still need the supervised installation workflow.
4. After that approved initialization, the operator must install an identical reviewed binding at `/var/lib/spire/.axiom-state.json`, root-owned `0600`. It must describe the disk actually initialized. Preserve issuer `server/keys.json` plus `server/db.sqlite3`, or runner `agent/keys.json` plus `agent/agent-data.json`, as private regular files. The guard checks structural recovery state; SPIRE and the issuer-sync gate still validate usable credentials and expected node identity. A marker cannot establish cloud identity or freshness of a restored backup.
5. `python3 /protected/spire_state.py --ready issuer` (or `runner`) must pass before ordinary SPIRE startup. The future supervisor must require the approved mount and stop the service when it disappears. This revision supplies the read-only gate, **not that installed supervisor or live mount-loss proof**. Never remediate missing state by deleting keys, changing UUID/marker to match an unexpected disk, enabling rebootstrap or resetting uncertain dispatch claims. Use the approved recovery process and verify fresh sync before execution resumes.

58 deployment tests and 24 local SPIRE outcomes cover controlled mount/superblock refusal and actual issuer/node recovery-file compatibility. Real GCP disk attachment, mount loss, systemd ordering and first enrollment remain external acceptance gates. Terraform remains default-off and no cloud apply occurred. See [review 50](audits/50-spire-state-admission-review-2026-09-23.md).

## Revision 60 — require bounded issuer synchronization health

**Node observer:** install the reviewed `infra/workload/spire_health.py` with Python 3.11+ and the checksum-pinned SPIRE 1.15.3 agent CLI. Run as root with explicit `--once <expected-node-spiffe-id>` or supervised `--watch <expected-node-spiffe-id>`. The CLI reads only `/run/spire-admin/api.sock` via the fixed `debug getinfo` operation; output is bounded to 64 KiB with a two-second deadline. Watch observes every two seconds after each query. It never formats disks, enrolls nodes, reads backend/KMS credentials or applies registrations. Service installation/supervision and mount guards are still the next deployment milestone; this code is not yet installed on a cloud host.

**Separate metadata mount:** `/run/spire-health` must be root-owned, canonical, non-symlink and non-writable by group/world. The observer creates it as `0755` and atomically publishes root-owned `0644` `status.json`. This file contains only health metadata; backend key/TLS/config files remain owner-only. Mount the health directory read-only into the controller at the same path so atomic replacements are visible. Do not bind-mount just one file inode. Never mount the node admin socket or issuer/node key directories into the controller or workers. Protect ancestor paths and mounts through deployment too. The controller also checks parent/file ownership, write permissions, regular-file status, size and canonical paths; no fallback is permitted.

**Binding/freshness:** add mandatory `issuerNodeId` to protected controller configuration, matching the exact reviewed node and trust domain. Production GCP binding comes from the prepared bundle's `expectedNodeId`, never a caller request; local join-token acceptance uses its actual attestor node ID. The consumer permits strictly less than ten seconds since observation and thirty seconds since successful issuer sync, capped by node certificate expiry. These are fixed safety bounds, not new environment settings. A fresh observation cannot renew old issuer state. SPIRE's debug response itself can be cached for five seconds; checks use the reported last sync, not HTTP/process/socket liveness. Maintain a trusted host clock; detected clock rollback/future timestamps fail closed.

**Failure and recovery:** failed observations publish explicit unhealthy metadata. Publisher or node loss expires prior data; an alive node with an unreachable issuer loses authorization after the sync bound. Startup, claim, launch and scoped identity verification refuse stale health. A known stale snapshot before claim leaves the one-time claim untouched; expiry after claim remains unconfirmed and must be reconciled. Do not reset/reissue a claim or blindly resubmit an uncertain job when health recovers. No safely-retryable outage response was added: the existing unconfirmed/review contract remains. Independent confirmation of already persisted results still works during outage. Recover the issuer and observer, then verify a new successful sync and inspect durable job/receipt state before operator recovery actions.

**Evidence:** 38 deployment tests and the BFF health/controller tests exercise malformed/future/stale/foreign observations, permissions, deadlines and no-claim/no-launch behavior. Separate real SPIRE acceptance now has 21 outcomes, including stale publisher/node and issuer-outage refusal despite cached local trust, followed by recovery. The real composed-controller acceptance now consumes the live root-owned snapshot. The retained earlier cached-identity observation is a baseline demonstration of raw Workload API behavior; the new gated composition is the enforcement path. Complete supervised state/CA bootstrap, scoped IAM/KMS, TLS/deployed startup, backup/restore and dedicated scheduler before activation. The Terraform module remains default-off.

## Revision 59 — prepare and verify exact node/image admission

**Completed code / in-progress deployment:** use the [SPIRE bundle contract](../infra/workload/README.md) and `scripts/prepare-workload-spire.py` to render a fresh, owner-only review directory from an operator-controlled policy file. Replace every example value with reviewed project, immutable runner instance ID, private issuer address, trust domain and both target-architecture Docker image configuration digests. The renderer prepares configuration and proposed argument arrays only. Do not automatically execute them or treat file generation as enrollment/readiness. No new environment variable is introduced.

**Review authority:** only controller UID 20000 and Parikshan UID 20003 are proposed, each bound to its image configuration digest and the exact runner node parent. A digest comes from the approved image's local `docker image inspect` `.Id`, not a tag or registry manifest. Verify build provenance and runtime mount integrity separately. VM replacement, image changes and revocation require an explicit reviewed lifecycle; retain the independent application registration/task checks. The issuer project allowlist is broader than one node, while the workload entries are exact-parent bound. Preserve GCP IIT first-use state; investigate unexpected enrollment conflicts rather than deleting node records or enabling rebootstrap.

**Pending host guards:** validate and mount the intended persistent disk before starting SPIRE. Preserve issuer keys/registry and node keys; never format/reinitialize on restart. Deliver and verify the initial CA independently at the protected configured path. Protect both admin sockets and keep them out of controller/worker mounts. The renderer does not implement disk initialization, installation, service supervision, backup/restore or these permission guards. The real test uses separate local containers/volumes, not deployed GCP VMs. Keep Terraform `workload_vms = null` until these gates are complete.

**Health gate still open:** the new real outage check confirms cached identity can remain available while the issuer is down. A successful node healthcheck or fresh Workload API read must not be used as production issuer-sync readiness. Implement bounded authenticated synchronization evidence and outage/recovery refusal before activation; avoid granting node-admin access to a controller merely for health. Existing ten-second local trust snapshots do not bound upstream replication.

**Acceptance:** `python3 -m unittest discover -s tests/deployment -p 'test_*.py'` covers 28 tests; `python3 scripts/test-spire-deployment.py` passes 14 outcomes with checksum-pinned SPIRE and real Docker selectors, distinct issuer/node state, positive and refusal cases, restart recovery and the outage limitation. Local attestation substitutes a join token and local parent for GCP IIT; no cloud identity claim follows. The Linux fixture exposes only its non-secret configuration and public CA through readable, read-only mounts so capability-less root can read host-user-owned files; production bundles remain owner-only. CI adds `spire-deployment-acceptance` with exact revision, dirty flag, version and sanitized outcomes, bringing expected acceptance JSON artifacts to ten. Continue supervised bootstrap/health, scoped IAM/KMS, TLS/production startup, opaque scheduler, then remaining workers, W4.4 grants and W3 wizard/graph work. Final merge evidence is saved in the session and handoff.

## Revision 58 — keep controller credentials out of container metadata

**Current contract:** Revision 72 replaced the raw key with protected JSON containing `schemaVersion`, anonymous `apiKey` and tenant-scoped `accessToken`. Revision 74 supplies reviewed issuance/revocation; use the [issuer procedure](../infra/credential-issuer/README.md). The old raw-key format below is historical and must not be deployed.

**Required before Docker workload attestation:** the private controller no longer accepts `SUPABASE_SERVICE_KEY` in its environment. Add `backendServiceKeyFile` to the protected service JSON; the [updated template](../infra/runner/controller.example.json) uses `/run/axiom-controller/backend.key`. Deliver the key separately as a read-only, protected regular file owned by UID 20000 (or root if actually readable), mode `0600`, under operator-controlled directories. Symlinks, group/world-readable files and unsafe paths are refused. Preserve the existing regional/HTTPS backend bindings. No new environment variable is introduced; the ordinary BFF still uses its existing configuration.

**Minimal environment:** the dedicated entrypoint accepts only its documented source allowlist: ordinary Node/container path/version/locale settings, `AXIOM_REGION=ap-south-1`, HTTPS `SUPABASE_URL`, provider region/project/role settings, and canonical absolute provider/trust-file paths. See `controllerEnvironment` in `services/bff/src/workloads/controller-files.ts`. It rejects shared BFF/Temporal/agent environments and static raw credential variables, including `SUPABASE_SERVICE_KEY`, AWS access/session keys and `NODE_OPTIONS`. Run its explicit image target with a deliberately assembled environment; invoking it from a broad interactive shell will fail closed. Attached cloud identity or protected mounted provider files are separate from backend key delivery. The path check does not independently validate provider-file ownership or contents; protect those through deployment configuration too.

**Historical file content, superseded by Revision 72:** the former backend key had to be 32–8192 printable non-whitespace ASCII characters, optionally followed by one LF or CRLF. No multi-line/inline JSON credential, extra whitespace or fallback environment key is accepted. Errors remain fixed text; do not diagnose by printing the key or complete configuration. The temporary read buffer is cleared, but the database client necessarily retains the credential in process memory. Keep dumps and controller process access protected.

**Container metadata:** do not use `docker --env-file` for this credential—it still populates Docker `Config.Env`. Do not pass raw credentials through argv, labels, Terraform state, instance metadata, image build arguments or logs. The future SPIRE Docker attestor emits environment selectors, so protected runtime file delivery must precede enabling that attestor. Worker containers remain without backend/KMS credentials; only the trusted controller receives the protected backend key mount. TLS keys likewise remain protected files. No Docker attestor has been activated in this milestone.

**Verification:** rerun workspace tests/lint/types and real workload acceptance. The composed container probe now reads a protected temporary backend file and checks that backend, wrapping and TLS private-key fixture values are absent from its recorded container environment. Private fixture bytes enter on stdin; a private tmpfs holds the key briefly, and it is removed before the real worker runs. This does not substitute for deployed image/node attestation, metadata inspection and effective IAM acceptance. Final counts and exact staging CI are saved in Doc 15's checkpoint. Continue issuer/node bootstrap and dedicated scheduler deployment; the host foundation stays default-off.

## Revision 57 — private issuer and runner VM foundation

**Accepted placement:** a separate private Mumbai SPIRE issuer VM alongside the dedicated runner; public APIs remain on Cloud Run. `infra/terraform/modules/workload-vms` implements the host/resource boundary. The GCP preprod root (including its supported environment naming) composes it only when `workload_vms` is non-null. The legacy AWS production topology is not silently replaced.

**Default and configuration:** keep `workload_vms = null` until bootstrap and operating gates are complete. The tfvars example includes the disabled setting and a commented shape with `zone`, `boot_image` and per-tenant `tenants[TENANT_UUID].controller_source_ranges`. Select one of the Mumbai zones and a reviewed named, Secure Boot-compatible GCP image; image families are refused. Optional scheduler ranges must be private IPv4 /24–/32 ranges, at most eight. Empty ranges create no controller ingress. No new environment variable, static credential or cloud API call is introduced by this code change.

**Prepared boundary:** issuer and runner have separate service accounts, private reserved addresses and persistent disks; no public network interface. Initial sizes are e2-small with 20 GB state for the issuer and e2-standard-2 with 50 GB state for the runner, plus separate boot disks. These are initial sizing choices, not capacity or availability guarantees. OS Login/2FA, disabled serial access, blocked project SSH keys and shielded-VM options are explicit. There is no SSH/IAP ingress or implicit administration grant. Both service accounts currently have no resource IAM grants from this module; do not reuse the broad BFF identity when adding reviewed secret/KMS access.

**Network acceptance:** rules target the dedicated service accounts. Runner-to-issuer TCP 8081 is the sole issuer ingress. Optional configured scheduler ranges reach only runner TCP 8443, whose application must independently verify signed scheduler identity. Other ingress is denied. Generic host egress is TCP 443, with an exact issuer-address TCP 8081 runner exception. Review effective organization/folder/VPC priorities: module rules cannot prove that another higher-priority policy grants access. No NAT is added. Verify private Google API routing, signing-key and backend/TLS reachability before activation. Do not mistake HTTPS-only host egress for destination filtering or worker isolation.

**State/recovery:** attached state disks have `prevent_destroy` while the resource configuration is retained; VMs have API deletion protection. Neither is a backup or an irreversible retention control. Bootstrap must mount and validate existing disks before starting SPIRE and refuse to reformat or silently re-enroll on restart. Keep issuer and node keys/registration state separate, with reviewed Mumbai-only backup/restore and recovery procedures. VM recreation changes the instance identity even if its name/IP/service account is reused; registration and enrollment must be reviewed accordingly. No key material, node token, workload proof or secret value belongs in Terraform inputs, state, instance metadata or startup logs.

**Validation:** run the module's `init -backend=false`, `validate` and nine mocked-provider tests, followed by the preprod root's validation/eight mocked tests. CI executes both suites; tests create no cloud resources. The default-off test proves existing deployments do not create hosts, while the explicit test verifies root composition. See [the module guide](../infra/terraform/modules/workload-vms/README.md) and [review 46](audits/46-private-mumbai-hosts-review-2026-09-23.md). Exact merge evidence is saved with Doc 15's checkpoint.

**Still ENGINEERING:** the module starts no SPIRE/controller service. Complete persistent issuer/node bootstrap, application/node admission, image review, protected trust and configuration mounts, secret/KMS IAM, internal TLS/DNS, supervision, health, backups and dedicated opaque scheduler composition before enabling deployment. Actual cloud IAM/KMS, attestation, effective firewall rules and recovery require deployed acceptance. No cloud resources were provisioned. Full W3/W4 and W0/W1/W2 remain open.

## Revision 56 — explicit private VM controller

**ENGINEERING delivered:** `services/bff/src/assessment-controller-service.ts` and Docker target `assessment-controller` in `infra/docker/Dockerfile.bff`. Ordinary BFF startup is unchanged. The accepted target is a dedicated Mumbai VM; public APIs stay on Cloud Run. This milestone supplies executable composition, not provisioned infrastructure. Review [the configuration template](../infra/runner/controller.example.json) and [review 45](audits/45-vm-controller-composition-review-2026-09-23.md). Every example value is a placeholder; do not deploy it unchanged.

**Prerequisites:** prepare the protected node Workload API socket and its reviewed application registration, tenant-specific persisted dispatch key policy and regional KMS permissions. Preload and review the immutable assessment worker image on the exact local daemon. Bind the same existing Workload API volume into the controller and its launched workers. The controller must be attested as its dedicated identity; it cannot borrow a worker registration. Startup checks image/volume availability, matching policy and a fresh trust snapshot, without writing any of them. This does not prove image provenance, issuer replication health, live KMS permissions or readiness of other replicas.

**Protected configuration:** copy the template outside the repository into an operator-controlled directory; replace tenant, namespace, trust domain, worker image ID, volume, key ring, scheduler numeric subject/email/audience and TLS paths. One controller serves one tenant and namespace. Mount configuration and TLS files read-only at their canonical absolute paths. Each file must be regular, non-symlink, 1–131072 bytes, mode `0600`, owned by the controller UID (20000) or root and actually readable by UID 20000. Protect parent directories and mounts too. Group/world-readable files are refused. As of Revision 58, supply `AXIOM_REGION=ap-south-1` and HTTPS `SUPABASE_URL`, with `backendServiceKeyFile` in the protected JSON; raw `SUPABASE_SERVICE_KEY` environment delivery is refused. Use only the reviewed provider identity/file-path settings described above. Never forward a full BFF environment to workers. No new environment variable was introduced.

**Service operation:** build the explicit image target, pin its resulting image identity, and invoke its entrypoint with `--check /run/axiom-controller/controller.json` before `--serve /run/axiom-controller/controller.json`. `--check` performs read-only preflights and exits without listening. The service requires direct TLS with a valid key/certificate pair, current validity dates and a hostname matching the pinned scheduler audience. There is no plaintext development fallback in this entrypoint. Use the appropriate trusted internal route/DNS and verify the scheduler can reach the configured listener; the example loopback listener is deliberately not remotely exposed. Scheduler authentication remains mandatory on every operation, independent of network controls.

**Container boundary:** run as UID 20000 with the local daemon socket's actual group, a read-only root, dropped capabilities, no-new-privileges, bounded resources and disabled loader cache. Only the trusted controller receives the local Docker daemon socket and backend/KMS credentials. The daemon socket is privileged host authority; restrict who can run or configure this controller. Docker bind sources are resolved on the daemon host, including Docker Desktop's Linux VM. Each worker still receives only its read-only Workload API volume and private job pipes, with no network, database/cloud credential or daemon socket. Production VM, socket permissions, service supervision, firewall and scheduler provisioning remain to be implemented and accepted.

**Shutdown/recovery:** SIGINT/SIGTERM stops new connections and drains in-flight requests for at most 85 seconds. Configure the external supervisor to allow that window. A forced process exit or lost reply does not prove a database operation failed or a worker stopped. The existing independent worker supervisor/cleanup checks and durable result receipts remain authoritative. Restart only after verifying those conditions; reconcile the original tenant/job, without resetting a claim or automatically authorizing another launch. Startup failures and service errors emit fixed text without provider or private request details. <!-- axiom-count-ok: operational shutdown and file-size bounds, not statutory controls -->

**Acceptance and limits:** run workspace tests/lint/typecheck, acceptance TypeScript and `python3 scripts/test-workload-identity.py --assessment`. The new composed controller path uses real Docker isolation, SPIRE trust and PostgREST persistence; its KMS and scheduler signing are cryptographic fixtures. Existing edge cases retain their captured fixture trust. Verify nine exact-revision CI artifacts before calling this merge green. No production VM, real cloud KMS readiness, live connector execution or whole-roadmap completion is claimed. Schema and W2 named coverage are unchanged. Final counts and exact merge evidence are in Doc 15 and the saved session.

## Revision 55 — protected signing-bundle delivery

Compose `WorkloadApiJwtTrust` only inside the trusted VM controller, with a reviewed absolute `socketPath` and explicit `trustDomains`. `timeoutMs` defaults to 2500 and is bounded to 100–5000 ms. No environment variable or default public-service startup is introduced in this component. The socket's parent directory and mount must be controlled by the trusted SPIRE node; workloads must not replace the socket, read node state, access Docker or inherit controller/database/cloud credentials. Production node enrollment and the dedicated Mumbai VM deployment are still pending.

Each validation reads the complete local JWT bundle snapshot and independently reloads it after signature verification. Any unavailable/changed/missing/malformed bundle refuses the identity; do not substitute captured acceptance keys or a last-known-good cache. Ten-second snapshot validity bounds local use, not SPIRE server-to-node replication. Investigate issuer/node health before restarting validation after an outage. Tenant registration, task proof and live grants remain separate per-action checks; this adapter grants no authority by itself.

**Verification:** workspace tests/lint/typecheck, acceptance TypeScript and `python3 scripts/test-workload-identity.py --assessment`. Expect **908 BFF tests**, **61 identity / 54 worker / three protected-trust outcomes**. The trust probe uses real SPIRE through a separate controller container; unregistered UID and paused-node checks must fail closed. The test-only Docker target disables the TypeScript loader cache so the filesystem stays read-only. The normal BFF image does not include its probe script. CI adds `workload-trust-acceptance`; collect **nine** exact-merge JSON artifacts before closure. The earlier registration correction is verified green in CI 35817381642. See [review 44](audits/44-protected-workload-trust-review-2026-09-23.md).

## Revision 54 — reviewed tenant workload registration

**CI follow-up:** initial Revision 54 merge `1e1207d` failed CI [35816732842](https://github.com/vikashkaruna/Proof/actions/runs/35816732842) because the shared strict-parity/container fixture still attempted a direct service-role registration insert. Both failing lanes hit the same correctly enforced permission boundary. The fixture now uses disabled registration followed by audited activation, verifies bound receipts and explicitly proves direct service writes return 403. A separate tenant-A owner preserves the viewer isolation persona. The corrective merge `0081948` is verified green in CI 35817381642.

**ENGINEERING delivered:** migration `0048` adds `version`, `lifecycle_receipt` and `updated_at` to `workload_identities`, preserving existing bindings and statuses. Direct service-role INSERT/UPDATE/DELETE is revoked; owner/admin or internal-founder administration uses the service-only `manage_workload_identity` transaction through `WorkloadRegistrationLifecycle.manage`. Supply the authenticated, human-reviewed tenant/actor/correlation/workload IDs, exact agent/SPIFFE binding, expected version and desired status. Never derive the actor or review decision from an untrusted worker or request body without authentication. This administration does not grant client mutation or waive approval/dry-run/rollback.

**Register, then activate:** use expected version zero and status `disabled` to create a reviewed binding, then activate against the returned version only after validating the separate node identity/trust setup. New/activated subjects must follow `spiffe://<trusted-domain>/agent/<agent-name>`; the independent verifier still controls which domains/bundles are actually trusted. Existing tenant/agent/subject bindings cannot be edited. A legacy noncanonical binding may be disabled without changing its historical identity; create a separate canonical registration instead of rewriting it. The migration does not fabricate approval receipts or automatically revoke existing tasks.

**Disable and recover:** disable under the current version. The transaction serializes against task issuance and tool writes, revokes every still-unrevoked delegation/grant for that identity, advances the version and appends a mandatory human audit receipt. Previously committed findings remain. Re-enabling allows new reviewed tasks/grants only; old proofs and grants stay revoked. Immediate matching retries return the existing receipt without duplicate audit; stale conflicting revisions refuse. A ten-second caller timeout is uncertain: inspect the registration version/status/receipt before retrying. No external provider bearer token or SPIRE SVID is physically invalidated by this app-state change; every consuming tool must recheck live registration/task/grant authority. <!-- axiom-count-ok: caller timeout, not statutory controls -->

**Verification:** run the database suite, workspace checks, acceptance TypeScript and `python3 scripts/test-workload-identity.py --assessment`. Expect **49 migrations / 18 concurrency suites / 14 upgrades**, **882 BFF tests**, **61 identity and 54 worker outcomes**. Test coverage includes service/client write refusal, owner/admin/internal-founder versus viewer/analyst/external-founder checks, binding immutability, audit rollback of status and task/grant revocations, receipt replay, no resurrection after re-enable, and both race orderings for disable versus tool completion/issuance. Populated upgrades preserve old state until explicit reviewed administration. Tip 0048, 55 public tables, named W2 targets 19/40. See [review 43](audits/43-workload-registration-lifecycle-review-2026-09-23.md); save exact merge CI and all eight artifacts before marking this component green.

**Accepted next deployment target:** the user chose a **dedicated Mumbai VM runner** for higher environments, while public APIs stay on Cloud Run. Implement its controlled runner/controller/node-agent composition and protected node bootstrap/bundle delivery; keep opaque scheduler credentials separate. Only the trusted runner may control Docker, and jobs must retain Revision 53's profile. Do not expose Docker or issuer APIs publicly or give the public BFF a daemon socket. This decision is not a completed cloud deployment. Remaining scoped workers, verified actor chains, W4.4 grants, full W3 wizard/readiness/graph and W4.5/6/7 remain engineering work, with W0/W1/W2 and backup-aware retirement preserved.

## Revision 53 — trusted per-job container launcher

**ENGINEERING delivered locally:** `assessmentContainerFactory` in the backend returns the fixed private process factory consumed by `AssessmentChannel`. Its trusted configuration accepts only an absolute Docker executable path, explicit local `unix:///...` daemon endpoint, preloaded `sha256:<64 hex>` image ID and a dedicated `axiom-workload-api-...` volume. Build `infra/docker/Dockerfile.assessment-worker`, record the reviewed image ID, and provision only the node agent's Workload API socket in that volume. The SPIRE client release is pinned to 1.15.3 with architecture-specific checksums. Never mount issuer state, backend env, host directories or the Docker socket into a job. No new environment variable or public route is introduced.

**Privilege separation:** compose this only in a dedicated trusted Docker runner/controller. It can control its local daemon; ordinary public BFF, frontend, opaque scheduler and worker processes must not inherit that access. The daemon/image/node agent are part of the trusted computing base. The fixed root supervisor receives only SETUID, SETGID and KILL, then launches the worker as UID 20003 with no effective capabilities and no-new-privileges. Jobs have private PID/network/cgroup namespaces, IPC disabled, read-only root/API mount, one CPU, 256 MiB memory with no additional swap, 64 processes, and log driver `none`. They cannot reach cloud metadata or a controller over IP; all tools remain on private framed pipes. Keep the reviewed Docker default seccomp profile. The image must be preloaded: runtime pulls are refused. <!-- axiom-count-ok: runtime resource limits, not statutory controls -->

**Identity:** the local acceptance node alone uses host PID visibility for the Unix workload attestor. Workers get only the read-only Workload API socket. Two concurrent jobs are separately attested, and wrong/unknown UIDs are denied. This assumes a trusted daemon/controller controls who can mount the socket and which UID/image executes. UID-only registration is not production image admission or revocation. Rootful Linux Docker/Docker Desktop is the verified local topology; user-namespace remapping and alternative runtimes need their own attestation acceptance. Do not copy the fixture's synthetic join-token trust into higher environments. Production node attestation, protected bundle delivery, admission/registration lifecycle and revocation remain open.

**Lifecycle:** use the factory with the existing bounded channel and independent database confirmation. Normal exit and interrupted input remove the container. Killing the Docker transport is not proof the job stopped; EOF may stop it promptly, otherwise the independent 65-second supervisor deadline bounds it. Acceptance waits for actual daemon-side removal. On daemon/host failure, keep the result unconfirmed and reconcile persisted receipts and owned container inventory before any recovery action. Do not reset a consumed claim or blindly relaunch. Containers share the host kernel; this is not VM isolation or physical memory erasure. <!-- axiom-count-ok: supervisor deadline, not statutory controls -->

**Acceptance:** `python3 scripts/test-workload-identity.py --assessment` builds the pinned worker image and runs the actual factory against local Auth/PostgREST. Expect **61 identity and 51 worker outcomes**, including all previous 43 worker outcomes, concurrent namespace/file/metadata denials, real SVID tools, resource/log settings, graceful cleanup and abrupt transport death. Docker Desktop may expose inactive tunnel devices: tests require no active non-loopback interface and no route, then attempt actual denied connections. Run workspace tests/lint/typecheck and acceptance TypeScript; 862 BFF tests pass. Schema remains 0047/55 public tables. Verify all eight exact-merge artifacts before calling the milestone green; see [review 42](audits/42-per-job-container-isolation-review-2026-09-23.md).

**Next ENGINEERING:** dedicated controller/scheduler/runner deployment composition and trust lifecycle, without adding daemon access to Cloud Run services; remaining scoped workers and verified actor chains; W4.4 grants; full W3 wizard/readiness/graph; W4.5/6/7. Local container isolation does not complete W4.3, authorize cloud apply or change the W0/W1/W2 remainder and backup-aware key retirement gates.

## Revision 52 — reviewed dispatch policy rollout

**ENGINEERING delivered:** migration `0047`, `DispatchPolicyStore`, provider configuration fingerprints and transactional enqueue/claim fences. The new service-only table stores tenant, provider, primary, every readable key reference, revision, fingerprint and publication receipt. Service-role callers cannot directly mutate it or invoke the former unfenced functions. No browser, worker or scheduler policy-management route exists. The backend publisher must receive an authenticated, reviewed human owner/admin or internal-founder identity; SQL independently checks current membership before appending `workload.dispatch_policy_published`. This configuration operation does not authorize a client mutation or substitute for execution approval/dry-run/rollback.

**Initial rollout:** prepare the trusted `DispatchKeyPolicy`, dedicated regional resources and effective controller KMS permissions. Include all historical outbox references, including purged-row references, and separately inventory backups. Quiesce production dispatch while applying the migration and composing upgraded controllers: legacy calls using AWS/GCP resource references are refused until an explicit matching policy exists. Existing non-cloud legacy fixtures are preserved; once a tenant has a policy, omitted revision/fingerprint cannot bypass it. No existing ciphertext, claim or run is rewritten by migration. A historical synthetic reference cannot be silently imported into a production provider policy; reconcile that fixture in its original environment.

**Publication and reconstruction:** use `DispatchPolicyStore.publish(policy, tenantId, authenticatedActorId, correlationId, expectedRevision)`, with expected revision zero only for bootstrap. Persist the approved full configuration through protected deployment configuration. The returned receipt binds its revision to the exact local provider/primary/reader set. On restart, `currentRevision(policy, tenantId)` returns the current revision only if the trusted local configuration fingerprint matches; missing/foreign/different configuration is refused. Construct `AssessmentDispatch(db, wrapper, new Map([[tenantId, revision]]))`. Production wrappers require this binding; the revision map is copied, and their fingerprint comes from their actual immutable policy. No new environment variable or secret is introduced. Never source revision assertions from an HTTP body, worker, scheduler or untrusted envelope.

**Rotation sequence:** first publish `policy.withReadable(tenant, newReference)` while retaining the old primary and all old readers. Reconstruct controllers using the new persisted revision. Verify actual controller readiness, regional encrypt/decrypt permissions and private error handling before publishing `withPrimary(tenant, newReference)` against that exact staged revision. Reconstruct controllers again with the promoted configuration. Publication refuses a primary not present in the preceding reader set, removal of any readable key, provider changes and cross-tenant resource reuse. A global publication lock serializes cross-tenant resource reservations; each tenant's exclusive publication lock serializes against shared enqueue/claim locks. One operation per transaction is the supported path. A controller already holding the shared lock finishes before publication; one arriving after publication must match the new revision and fingerprint.

**Availability and uncertainty:** this is a safety fence, not automated deployment or an all-replicas-ready attestation. Old controllers fail closed during rollout; drain/quiesce and verify readiness to avoid expiry of pending tasks. Already-issued claims/tasks are not revoked by a policy update; independent task revocation and kill-switch controls remain authoritative. Lost publication replies can be recovered with the same intended policy and immediate prior expected revision; older/conflicting requests are refused. The adapter has a ten-second caller budget. Timeout or disconnect is uncertain: inspect the durable policy and its ledger receipt before retrying. Do not automatically adopt arbitrary current revisions, remove reader references, reset claims or extend task expiry to suppress errors. Existing opaque receipt confirmation remains available and grants no new authority. <!-- axiom-count-ok: publication timeout, not statutory control count -->

**Acceptance:** 846 BFF tests; 48 migrations, 17 concurrency suites and 13 populated upgrades; real local Auth/PostgREST + SPIRE with 61 identity and 43 worker outcomes. Run the established database, workspace and acceptance TypeScript checks plus `python3 scripts/test-workload-identity.py --assessment`. The local KMS remains a cryptographic fixture using the production AWS adapter. Verify exact merge CI and all eight sanitized artifacts in the saved session. See [review 41](audits/41-dispatch-policy-fencing-review-2026-09-23.md).

**Still ENGINEERING:** actual deployment composition, per-job process/network/metadata isolation, trust registration, remaining scoped workers/actor chains and W4.4 grants. A matching fingerprint cannot prove cloud KMS/IAM availability. Readable keys are never removed by this component; database backups/WAL and external retained artifacts still need inventory and a reviewed retirement procedure. No cloud key administration or cloud deployment was performed. Continue the full W3 wizard/graph and W4.5/6/7 while preserving the W0/W1/W2 remainder.

## Revision 51 — completed-dispatch retention maintenance

**ENGINEERING delivered:** migration `0046`, `AssessmentRetention` and the explicit `services/bff/src/assessment-retention-worker.ts` entrypoint. Set `AXIOM_ASSESSMENT_DISPATCH_RETENTION_DAYS=90` in the protected backend environment, or another integer from 1 to 36500. This setting is separate from `AXIOM_EVIDENCE_RETENTION_DAYS` and consent retention. The timer starts at `workload_assessment_packets.finalized_at`, the independent confirmation, not earlier computation or enqueue time. Docker examples/overlays, Cloud Run's `assessment_dispatch_retention_days` variable and env sync carry the default/override. Helm uses `config.assessmentDispatchRetentionDays`. Application validation rejects malformed values. None of these settings starts cleanup automatically.

**Explicit operation:** after migrating the intended environment, run from the repository root with a protected absolute env-file path:

```bash
pnpm --filter @axiom/bff exec tsx --env-file=/absolute/protected/backend.env src/assessment-retention-worker.ts --once
```

Use `--watch` instead for one candidate every minute; this limits a single process to at most 1440 candidates per day. No maintenance process is currently provisioned in higher environments. Compose/Cloud Run/Helm BFF services continue ordinary startup. A separately supervised maintenance job must receive its intended backend environment and database credential. Do not grant that credential to the scheduler or isolated worker. The scoped maintenance loader requires strict auth and database configuration; it does not require approval, MFA, model, runtime or KMS secrets. No cloud operation was performed in this milestone.

**Output and recovery:** output is one strict JSON receipt: `idle`, `purged` with tenant/job/receipt/time/effective days, or `review` with tenant/job. Review stops the process without purging the conflicting job. Investigate bindings, result/library digests and the three execution receipts; do not force-delete data or reset claims to bypass review. Errors also stop watch mode. The RPC has a ten-second caller budget and a two-second database lock timeout. A timeout/disconnect may occur after commit: inspect `assessment_dispatch_jobs.payload_purged_at`, `payload_purge_receipt`, `payload_retention_days` and the referenced `workload.dispatch_payload_purged` ledger event before restarting. Never log ciphertext, task proofs, private status files or raw backend errors. SIGINT/SIGTERM stop the poller; an in-flight operation may still commit. <!-- axiom-count-ok: maintenance capacity and timeout bounds, not statutory controls -->

**Data boundary:** only delivered, confirmed successful, sufficiently old and consistently bound jobs qualify. The transaction nulls `nonce`, `ciphertext` and `wrapped_key`; keeps `key_ref`, identity, claims and scheduling metadata; and appends mandatory audit. Audit failure rolls back removal. Findings, confirmation packets, original enqueue receipts and sealed evidence remain intact. A retry cannot re-enqueue a new run or deliver the old payload again. Concurrent pollers skip a busy task and cannot emit duplicate purge receipts. Unresolved/failed/cancelled/undelivered payloads remain for separate recovery policy.

**Acceptance:** 820 BFF / 68 config tests, 47 migrations, 16 concurrency suites and 12 populated upgrades; local real Auth/PostgREST + SPIRE pass 61 identity and 39 worker outcomes. Use `./scripts/test-database.sh`, workspace checks, `pnpm exec tsc -p scripts/tsconfig.acceptance.json` and `python3 scripts/test-workload-identity.py --assessment`. Only synthetic test fixtures advance confirmation age. Exact merge CI and sanitized artifacts are saved in the session. See [review 40](audits/40-dispatch-retention-review-2026-09-23.md).

**Still ENGINEERING:** logical live-row removal does not erase WAL, backups, replicas or copied ciphertext. Preserve old KMS keys/versions until all retained artifacts and recovery obligations are accounted for. Both enqueue and claim need persisted key-policy rollout fences before distributed promotion/retirement. No key destruction or physical-erasure guarantee is delivered. Continue per-job isolation/trust and dedicated service composition, remaining workers, grants and full W3 wizard/graph. The overall goal remains incomplete.

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
