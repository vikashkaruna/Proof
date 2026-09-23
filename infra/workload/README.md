# SPIRE node and workload admission preparation

This offline bundle prepares the approved separate private Mumbai issuer and runner. It does **not** install services, initialize disks, enroll nodes, modify registrations, fetch secrets or apply cloud resources. Keep the Terraform host module disabled until its operational gates are complete.

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

Use a validated mounted state disk and protected root-owned configuration/CA delivery before starting either host. Do not format, silently recreate or restore over existing state on startup. The current renderer does not implement those guards. Protect the issuer admin socket and node admin socket from controller/workers. Only the trusted node attestor and controller may access the Docker daemon; a read-only bind of its socket does **not** make Docker API operations read-only. Workers keep their separate PID/network namespaces and cannot receive daemon, node key, issuer key or metadata access.

Docker attestation can emit container environment values as selectors. Use Revision 58's protected credential files and strict controller environment, never `--env-file`, argv or labels carrying raw secrets. Do not enable debug/selector logging. Image identity covers the image content, not arbitrary executable bind mounts; mount integrity is part of the trusted deployment.

## Evidence and remaining gates

The real local test validates both production configurations with checksum-pinned SPIRE, then substitutes local join-token attestation and a local parent alias **only in the fixture**. It runs issuer and node in separate containers with separate persistent volumes. It checks image/UID/parent refusals, issuer and node recreation without losing registration/trust, recovery without a join token, refusal after node state loss, and separated host mounts. There are no public listeners, application credentials or client mutations. The fixture's Alpine probe images test admission policy; they do not prove the complete production controller/worker deployment with Docker attestation.

A further check demonstrates that an alive node can still issue a cached identity while its issuer is offline. This is a known **health gap**, not passing readiness. Protected Workload API reads alone do not bound issuer replication or global revocation. Implement a bounded, authenticated issuer-sync health gate and test outage/recovery before operational activation. Do not grant the controller node-admin access as a shortcut.

Still required: persistent mount/initialization guards, supervised host installation, verified CA delivery, scoped IAM/KMS, controller TLS/DNS and production entrypoint startup, effective GCP attestation/firewall acceptance, controlled enrollment/image replacement/revocation, Mumbai-only backup/restore, and a dedicated opaque scheduler. Existing application workload registration/task authorization remains independently required. No cloud resources were provisioned for this milestone.

Primary references: [SPIRE GCP IIT](https://github.com/spiffe/spire/blob/v1.15.3/doc/plugin_server_nodeattestor_gcp_iit.md), [Docker selectors](https://github.com/spiffe/spire/blob/v1.15.3/doc/plugin_agent_workloadattestor_docker.md), [agent configuration](https://github.com/spiffe/spire/blob/v1.15.3/doc/spire_agent.md), [server configuration](https://github.com/spiffe/spire/blob/v1.15.3/doc/spire_server.md).
