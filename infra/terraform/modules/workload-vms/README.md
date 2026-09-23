# Private Mumbai workload hosts

Infrastructure foundation for the user-approved separate SPIRE issuer and a dedicated assessment-runner VM per tenant. The GCP preprod root composes this module only when `workload_vms` is explicitly configured. Its default is `null`, including the example tfvars. No cloud apply was performed for this implementation.

The module prepares separate service accounts, private reserved IPv4 addresses, shielded VMs and state disks in `asia-south1`. Instances use a reviewed named boot image, OS Login/2FA, blocked project SSH keys, disabled serial access and deletion protection. Attached state disks have Terraform `prevent_destroy`. No SSH ingress, startup script, private key or credential value is added. Controller resource IAM is a separate explicit per-tenant option described below. An attached service account's OAuth scope is only a ceiling; it does not grant access to database secrets or KMS keys.

Ingress is denied except runner-to-issuer TCP 8081 and, when explicitly configured, private scheduler ranges to runner TCP 8443. Generic host egress is TCP 443; runner-to-issuer 8081 has a separate exact-address rule. HTTPS egress is **not** a destination allowlist or proof of egress filtering inside a host. The module adds no public IP, NAT, proxy or administrative access path. Private Google API access/routes and any narrowly reviewed external egress need deployment verification. Existing higher-priority/hierarchical firewall rules must also be reviewed. Isolated assessment workers retain their separate networkless containers; the host's metadata/daemon permissions must never be inherited by those workers.

The state disk must be initialized once, mounted and validated before SPIRE starts. Do not reformat it on restart or place issuer/node key state on an ephemeral root path. These lifecycle guards are not backups, WORM retention or protection against an authorized operator changing/removing configuration. Prepare Mumbai-only backup/restore, enrollment/recovery and image-update procedures before activation. A named image reference prevents accidental family drift but does not verify provenance or prevent a privileged publisher replacing that name.

The `tenants` input maps canonical nonzero UUIDs to independently reviewed controller source ranges and optional permissions. Each tenant has its own runner VM, service account, private address and protected state disk; the issuer remains separate and shared. The 1–100 tenant input is a deployment-batch limit, not product entitlement or an HA/capacity guarantee. `hosts.issuer` and `hosts.runners[TENANT_UUID]` are infrastructure references, not readiness assertions. Legacy populated state needs an explicit migration review; no generic runner is automatically reassigned or retired.

## Optional controller permissions

`tenants[TENANT].controller_permissions.dispatch_keys` requires a primary CryptoKey and permits up to nine retiring references. All must be canonical `projects/PROJECT/locations/asia-south1/keyRings/RING/cryptoKeys/KEY` resources in this project, with no duplication within or across tenants. The optional object's omission leaves the host with no grants from this module. The GCP root also keeps `workload_vms = null` by default; Cloud KMS API enablement is conditional on permissions being configured.

For an opted-in tenant the module creates two **empty** Mumbai-only Secret Manager containers, labelled for the tenant and backend/TLS purposes. It grants only that runner's service account secret access on those resources and decryption on its explicitly declared dispatch keys. There are no secret versions, plaintext values, signing keys, producer encryption grants, key creation/destruction or issuer grants. Secret `prevent_destroy` requires deliberate retirement; it is not WORM protection. Removing a key from the input can revoke its binding, so retained jobs and backup recovery must be reviewed first.

`controller_permissions[TENANT]` exports the non-secret review inventory: tenant/project, runner identity, secret resource names, primary/retiring keys and a fingerprint matching the persisted backend policy contract. Compare all of them to the protected controller generation. Primary promotion retains the existing readable-key bindings. This output describes desired policy; effective inherited/external IAM and actual access/denial require deployed evidence.

The standalone module expects the required Compute, IAM, Secret Manager and Cloud KMS APIs to be available; the preprod root supplies its normal API dependencies and conditional KMS enablement. Host preparation, placement, supervision and database-scoped credentials are implemented separately. Credential publication/renewal, private TLS/DNS, scheduler and actual cloud acceptance remain required before activation. See [audit 62](../../../../docs/audits/62-controller-resource-iam-review-2026-09-23.md) and [Doc 16](../../../../docs/16_Operator_Completion_Runbook.md) for the evidence required.

Offline validation (provider mocks; no cloud state, credentials or resources):

```sh
python3 scripts/check-workload-iam.py
terraform -chdir=infra/terraform/modules/workload-vms init -backend=false -input=false
terraform -chdir=infra/terraform/modules/workload-vms validate
terraform -chdir=infra/terraform/modules/workload-vms test -no-color
terraform -chdir=infra/terraform/envs/preprod test -no-color
```

The module has 26 evaluated tests; the preprod root has nine, including three composition/default-off checks. Ten mutation tests cover the independent workload IAM source gate. CI runs both. See [Doc 16](../../../../docs/16_Operator_Completion_Runbook.md) for the current milestone and operational gates.

References used for the next bootstrap design: [SPIRE 1.15.3 GCP node attestation](https://github.com/spiffe/spire/blob/v1.15.3/doc/plugin_server_nodeattestor_gcp_iit.md), [SPIRE agent configuration](https://github.com/spiffe/spire/blob/v1.15.3/doc/spire_agent.md), [GCP VPC firewall semantics](https://docs.cloud.google.com/firewall/docs/firewalls), and [GCP VM deletion protection](https://docs.cloud.google.com/compute/docs/instances/preventing-accidental-vm-deletion). GCP attestation, persistent node keys, exact node binding and image selectors are prerequisites for bootstrap; this infrastructure module does not implement or prove them.

Revision 59 adds [offline SPIRE configuration and admission preparation](../../../workload/README.md), including real local separate-host restart/image-selector acceptance. Revision 60 implements the controller issuer-sync health gate and node observer. At that revision host installation, persistent mount guards and supervised health delivery were pending; later revisions supply them, while this module remains default-off.

Revision 61 adds the separate read-only persistent-state guard and offline binding preparation. It validates the device aliases emitted here, UUID/mount and existing private recovery state; it never formats or initializes a disk. Later host revisions supply installer/supervisor integration and native mount-loss fixtures; actual cloud recovery remains open.
