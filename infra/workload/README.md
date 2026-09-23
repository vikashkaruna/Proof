# SPIRE node and workload admission preparation

This offline bundle prepares the approved separate private Mumbai issuer and runner. It does **not** install services, initialize disks, enroll nodes, modify registrations, fetch secrets or apply cloud resources. Keep the Terraform host module disabled until its operational gates are complete. The controller health gate is now implemented; supervised host activation remains pending.

Copy `spire-policy.example.json` outside the repository and replace **every** example value. Use the reviewed GCP project and runner's immutable numeric `instance_id` from the host output, the issuer's reserved private IPv4, the application's canonical trust domain, and the actual local Docker **image configuration digests** for the controller and assessment images. Obtain each digest with `docker image inspect <reviewed-image> --format '{{.Id}}'` on the target architecture after verifying the approved build provenance. A tag, registry manifest digest, VM name, service-account name or IP address cannot substitute for these identity bindings. Image provenance/signature verification and protection of runtime mounts remain separate requirements.

```sh
python3 scripts/prepare-workload-spire.py /protected/spire-policy.json /protected/new-review-bundle
python3 -m unittest discover -s tests/deployment -p test_spire_policy.py
python3 scripts/test-spire-deployment.py
```

The output directory must not already exist; rendering never overwrites a reviewed bundle. Inputs are bounded and reject unknown/duplicate fields, noncanonical identities, public/link-local issuer addresses and tag-based image selection. All generated files are owner-only. No new environment variables or credentials are introduced.

## Review bundle

- `server.conf`: GCP project allowlist, private listener on 8081, separate local admin socket, persistent SQLite registry and disk signing keys under `/var/lib/spire/server`. This is a single issuer, not HA.
- `agent.conf`: GCP IIT node attestation, persistent agent state/key under `/var/lib/spire/agent`, protected initial CA at `/etc/axiom/spire/bootstrap.pem`, rebootstrap disabled, authenticated bundle access, Unix and Docker workload attestors, a separate admin socket, and no selector logging.
- `registration-argv.json`: two **proposed** argument arrays for issuer-local review, for the implemented controller (UID 20000) and Parikshan assessment worker (UID 20003). Each requires the exact GCP node parent and both UID and immutable image configuration digest. No UID-only fallback, project-wide node alias, wildcard, delegate, downstream or administrative workload entry is generated. The tool never executes these arrays. Other named agents do not gain workload authority merely because their names exist in the roadmap.
- `release.json`: SPIRE 1.15.3 archive checksum pins for amd64/arm64 and the expected node SPIFFE ID. This is release metadata, not an installer or proof that the host is running the pinned binary.

The GCP project allowlist permits node attestation within that project; **workload admission** is narrowed by the exact parent. It is not a node attestation allowlist for one VM. A replacement VM has a new instance ID, even if its name/IP/service account is reused, and needs a newly reviewed binding. SPIRE's GCP attestor uses first-attestation trust; an unexpected enrollment conflict must be investigated, never fixed by deleting registration/key state or enabling automatic rebootstrap.

Use a validated mounted state disk and protected root-owned configuration/CA delivery before starting either host. Do not format, silently recreate or restore over existing state on startup. The renderer does not implement those guards; Revision 61 below supplies a separate read-only check, with installation still pending. Protect the issuer admin socket and node admin socket from controller/workers. Only the trusted node attestor and controller may access the Docker daemon; a read-only bind of its socket does **not** make Docker API operations read-only. Workers keep their separate PID/network namespaces and cannot receive daemon, node key, issuer key or metadata access.

Docker attestation can emit container environment values as selectors. Use Revision 58's protected credential files and strict controller environment, never `--env-file`, argv or labels carrying raw secrets. Do not enable debug/selector logging. Image identity covers the image content, not arbitrary executable bind mounts; mount integrity is part of the trusted deployment.

## Evidence and remaining gates

The real local test validates both production configurations with checksum-pinned SPIRE, then substitutes local join-token attestation and a local parent alias **only in the fixture**. It runs issuer and node in separate containers with separate persistent volumes. It checks image/UID/parent refusals, issuer and node recreation without losing registration/trust, recovery without a join token, refusal after node state loss, and separated host mounts. There are no public listeners, application credentials or client mutations. The fixture's Alpine probe images test admission policy; they do not prove the complete production controller/worker deployment with Docker attestation.

Revision 60 adds `spire_health.py`, a root-only observer of the fixed SPIRE admin `Debug.GetInfo` method. Its explicit `--once <expected-node-spiffe-id>` and `--watch <expected-node-spiffe-id>` modes publish only minimal root-owned metadata at `/run/spire-health/status.json`; watch observes every two seconds after each bounded query. Mount the directory read-only into the controller, preserving atomic replacements, and never expose the node admin socket. The metadata file is root-owned `0644` under a root-owned non-writable `0755` directory; backend credentials remain owner-only. Revision 62 installs and supervises this observer; Revision 64 adds the native runner lifecycle gate described below.

The dedicated controller requires `issuerNodeId` in its protected configuration and rejects observations older than ten seconds, upstream sync older than thirty seconds, expired node certificates, foreign nodes, invalid timestamps and unsafe files. Fresh metadata cannot refresh stale upstream state. Startup, claim, post-claim launch and scoped identity verification use the gate; historical confirmation remains available. The real test now has 21 outcomes, including issuer/publisher/node outages and recovery, while preserving the earlier demonstration that the raw Workload API can remain cached. An outage leaves uncertain jobs in their existing conservative review/reconciliation flow; it does not permit claim resets or automatic relaunches. See [Doc 16](../../docs/16_Operator_Completion_Runbook.md) for the operating contract.

Current remainder after Revisions 61–64: host socket/container delivery, scoped IAM/KMS, controller TLS/DNS and production entrypoint startup, effective GCP attestation/firewall acceptance, controlled enrollment/image replacement/revocation, Mumbai-only backup/restore, and a dedicated opaque scheduler. Existing application workload registration/task authorization remains independently required. No cloud resources were provisioned for this milestone.

Primary references: [SPIRE GCP IIT](https://github.com/spiffe/spire/blob/v1.15.3/doc/plugin_server_nodeattestor_gcp_iit.md), [Docker selectors](https://github.com/spiffe/spire/blob/v1.15.3/doc/plugin_agent_workloadattestor_docker.md), [agent configuration](https://github.com/spiffe/spire/blob/v1.15.3/doc/spire_agent.md), [server configuration](https://github.com/spiffe/spire/blob/v1.15.3/doc/spire_server.md).

## Persistent state check (Revision 61)

`spire_state.py` adds a root/Linux read-only guard. Prepare its binding with `python3 scripts/prepare-workload-state.py /protected/spire-policy.json issuer <filesystem-uuid> /protected/state.json` (or `runner`). The preparer validates the existing SPIRE policy and derives the expected node; it writes only a fresh owner-only review file. The deployed binding belongs at `/etc/axiom/spire/state.json`. The matching disk marker is `/var/lib/spire/.axiom-state.json`, installed only after approved initialization. Neither script installs that marker on a live disk.

`--empty <role>` verifies a blank bound disk and changes nothing. `--ready <role>` requires initialized private keys and issuer registry or node recovery data. Both bind the fixed GCP device alias, actual superblock UUID and dedicated whole ext4 mount (`rw,nosuid,nodev,noexec`), with canonical/root-protected ancestry. Ready refuses fresh/missing state instead of reenrolling. The marker binds reviewed configuration; it does not authenticate cloud instance identity, prove backup freshness or validate cryptographic keys. SPIRE and the issuer-sync gate still do their independent checks.

See [Doc 16](../../docs/16_Operator_Completion_Runbook.md) for modes, paths, permissions and refusal handling. This historical Revision 61 checkpoint is extended by protected installation and explicit enrollment below. Real GCP block-device acceptance remains pending. Local acceptance now has 24 outcomes; its new file checks use actual SPIRE state read-only, while mount/superblock cases are controlled unit fixtures. No host disk was formatted or cloud resource applied.

## Protected host delivery (Revision 62)

`scripts/prepare-workload-host.py` prepares a fresh private bundle from
`host-policy.example.json`, the pinned SPIRE musl archive and (for runners) an
independently fingerprinted issuer CA PEM. Replace every example value. Supported
host profile: Ubuntu 24.04, Python 3.12, systemd 255, amd64/arm64; runners also
require Docker. No new environment parameters are introduced.

`spire_host.py --check-bundle /root/reviewed SHA256` validates protected delivery;
`--install` writes only fixed paths, checks all conflicts before writing and
publishes the manifest last. Trust the installer independently and review the
manifest digest out of band. Existing identical files retain their inodes;
foreign/partial files are refused without repair. This is first installation,
not an upgrade mechanism. No service command, disk change or enrollment occurs.

The prepared systemd units check installed integrity and `spire_state.py --ready`
before launch, bind SPIRE to the UUID mount, and keep the health observer tied to
the runner. Missing keys or markers cannot trigger initialization. First
enrollment and marker installation are separate reviewed commands implemented below.
See Doc 16 for delivery steps and outstanding activation gates. Docker verifies
both roles; the dedicated native Ubuntu CI fixture exercises actual issuer
startup/mount-loss/recovery. It is restricted to fresh GitHub-hosted runners and
formats only a newly allocated loop device whose backing file it verifies.
Actual GCP identity and full runner/controller activation remain pending.

## Explicit issuer initialization (Revision 63)

The issuer bundle now includes `spire_enrollment.py` and a separate static
`axiom-spire-enroll-issuer.service`. Normal units still use only `--ready`.
The initial unit requires an explicit live permit and empty state, never
restarts automatically, and has a 60-second runtime limit. It is not enabled.

After protected installation, reviewed unit loading and separately prepared
empty-disk mounting, `--initialize issuer MANIFEST_SHA256` records the request,
initializes under service hardening, observes public X.509/JWT trust and stops.
Review the protected receipt, then invoke `--seal issuer RECEIPT_SHA256` to
record that separate decision and publish the marker. Both use the installed
helper through `/usr/bin/python3 -I -B`; root/Linux, installed-file integrity,
loaded-unit identity, disabled/inactive normal services and exact mount binding
are required. No command formats, mounts, repairs, enables or overwrites.

An interrupted attempt stays unmarked for explicit recovery. Request, receipt
and approval files live under `/etc/axiom/spire`; the runtime permit and lock
stay under `/run`. No environment parameters are added. These are root
administrative records, not application mutation-approval tokens or a signed
human identity assertion. Runner enrollment is implemented below; full controller
activation remains pending. See Doc 16 for exact operator steps and boundaries.

Initialization also exports root-protected public `initialization-bundle.json` and `initialization-ca.pem` under `/etc/axiom/spire`. Review these while the issuer remains stopped. Their hashes are bound to the receipt and rechecked before sealing; no private key material is exported.

## Reviewed runner first enrollment

The same protected CLI accepts `--initialize runner MANIFEST_SHA256` and, after separate receipt review, `--seal runner RECEIPT_SHA256`. The manifest binds the approved bootstrap CA, GCP node and disk. Initialization requires a stopped observer and disabled/stopped normal runner, checks the exact live node and recent issuer sync, then stops and fingerprints its key/recovery state. Publication refuses expired node evidence and changed state/trust. The bounded static initial unit omits observer startup; ordinary restart remains ready-only and never reenrolls.

`scripts/test-workload-runner-systemd.py --isolated-ci` is restricted to a fresh GitHub-hosted Ubuntu VM. It formats only its new backing-file-verified loop device. Its separately hashed test bundle replaces GCP attestation and the exact generated join-token node-format predicate solely for this fixture; production has no such switch. The gate covers native runner/observer lifecycle, not GCP identity or cloud activation.

## Protected runtime volumes (Revision 65)

The runner bundle includes `spire_volumes.py`. After reviewed normal node/observer startup, root can invoke `--prepare MANIFEST_SHA256` to record and create deterministic workload/health local Docker mappings, or `--check MANIFEST_SHA256` to inspect them without mutation. Fixed sources are `/run/workload` and `/run/spire-health`; fixed options are `bind,ro,nosuid,nodev,noexec`. The standard root-owned local Docker daemon and `/var/lib/docker` root are required. The daemon and root preflight must share a mount namespace so active bind mounts cannot be hidden from inspection. Conflicting drivers/options/labels/sources, stale node health or changed active mount inodes are refused without repair. Both commands are serialized with enrollment; neither launches containers or changes service state.

Use the reported workload volume read-only with `volume-nocopy` in the controller and isolated workers; mount the health directory only in the controller. Preserve the runtime directory inode across socket/metadata replacement. Repeat the read-only check before controller activation after restart; the durable mapping record does not attest to current readiness. See Doc 16 for exact steps. Full controller delivery/admission and cloud acceptance remain pending.

## Actual controller entrypoint acceptance (Revision 66)

The isolated assessment gate now invokes the dedicated image’s inherited `--check` and `--serve` entrypoint with protected file credentials, a private HTTPS proxy to real local Supabase, and live SPIRE/health volumes. It checks TLS/node/permission refusal, invalid caller identity, graceful shutdown and unchanged pending claims, with no forbidden backend-operation attempts. Fixture secrets are passed only through private stdin and owner-only files. This is local acceptance of existing production code, not cloud activation or real KMS/Google identity success. Protected controller host delivery and supervision remain next.

## Protected controller files

`controller-review.example.json` is metadata only; replace all placeholders. `scripts/prepare-controller-files.py` prepares a fresh private review bundle from a private review file and the fixed service/backend/TLS file inventory. The root-only `controller_files.py --install SOURCE SHA` binds delivery to the installed SPIRE runner; `--check TENANT SHA` checks the completed generation without the source. Files remain under root-only host ancestry, owned by controller UID/GID 20000 with mode0400, ready for a read-only mount. These commands neither launch nor enable anything. Partial or altered generations are refused without repair. See [Doc 16](../../docs/16_Operator_Completion_Runbook.md#revision-68-procedure--protected-controller-files-without-activation) before use; full runtime/TLS/KMS checks and supervised activation remain pending.
