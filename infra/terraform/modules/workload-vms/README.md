# Private Mumbai workload hosts

Infrastructure foundation for the user-approved separate SPIRE issuer and a dedicated assessment-runner VM per tenant. The GCP preprod root composes this module only when `workload_vms` is explicitly configured. Its default is `null`, including the example tfvars. No cloud apply was performed for this implementation.

The module prepares separate service accounts, private reserved IPv4 addresses, shielded VMs and state disks in `asia-south1`. Instances use a reviewed named boot image, OS Login/2FA, blocked project SSH keys, disabled serial access and deletion protection. Attached state disks have Terraform `prevent_destroy`. No resource IAM permissions, SSH ingress, startup script, private key or credential value is added. An attached service account's OAuth scope is only a ceiling; it does not grant access to database secrets or KMS keys.

Ingress is denied except runner-to-issuer TCP 8081 and, when explicitly configured, private scheduler ranges to runner TCP 8443. Generic host egress is TCP 443; runner-to-issuer 8081 has a separate exact-address rule. HTTPS egress is **not** a destination allowlist or proof of egress filtering inside a host. The module adds no public IP, NAT, proxy or administrative access path. Private Google API access/routes and any narrowly reviewed external egress need deployment verification. Existing higher-priority/hierarchical firewall rules must also be reviewed. Isolated assessment workers retain their separate networkless containers; the host's metadata/daemon permissions must never be inherited by those workers.

The state disk must be initialized once, mounted and validated before SPIRE starts. Do not reformat it on restart or place issuer/node key state on an ephemeral root path. These lifecycle guards are not backups, WORM retention or protection against an authorized operator changing/removing configuration. Prepare Mumbai-only backup/restore, enrollment/recovery and image-update procedures before activation. A named image reference prevents accidental family drift but does not verify provenance or prevent a privileged publisher replacing that name.

The `tenants` input maps canonical UUIDs to independently reviewed controller source ranges. Each tenant has its own runner VM, service account, private address and protected state disk; the issuer remains separate and shared. The bounded 1–100 tenant input is a deployment-batch limit, not product entitlement. This is not an HA design or capacity guarantee. Application bootstrap, reviewed container admission, issuer/node registration, trust-bundle delivery, protected controller configuration, least-privilege secret/KMS bindings, TLS/DNS, supervision, independent health and opaque scheduler deployment are still pending. No listener is started merely by creating these resources. The output `hosts.issuer` and `hosts.runners[TENANT_UUID]` contains private infrastructure references and tenant labels, not readiness or authorization assertions. Supervised startup must enforce the configured tenant against the reviewed assigned host/node; database/secret/KMS/scheduler scope remains separate. Legacy populated state must have an explicit migration review: no generic runner is automatically reassigned, moved or retired. Do not enable this module in an operational environment until these gates are implemented and reviewed.

Offline validation (provider mocks; no cloud state, credentials or resources):

```sh
terraform -chdir=infra/terraform/modules/workload-vms init -backend=false -input=false
terraform -chdir=infra/terraform/modules/workload-vms validate
terraform -chdir=infra/terraform/modules/workload-vms test -no-color
terraform -chdir=infra/terraform/envs/preprod test -no-color
```

The module has 13 boundary tests; the preprod root has eight tests, including two composition/default-off checks. CI runs both. See [Doc 16](../../../../docs/16_Operator_Completion_Runbook.md) for the current milestone and operational gates.

References used for the next bootstrap design: [SPIRE 1.15.3 GCP node attestation](https://github.com/spiffe/spire/blob/v1.15.3/doc/plugin_server_nodeattestor_gcp_iit.md), [SPIRE agent configuration](https://github.com/spiffe/spire/blob/v1.15.3/doc/spire_agent.md), [GCP VPC firewall semantics](https://docs.cloud.google.com/firewall/docs/firewalls), and [GCP VM deletion protection](https://docs.cloud.google.com/compute/docs/instances/preventing-accidental-vm-deletion). GCP attestation, persistent node keys, exact node binding and image selectors are prerequisites for bootstrap; this infrastructure module does not implement or prove them.

Revision 59 adds [offline SPIRE configuration and admission preparation](../../../workload/README.md), including real local separate-host restart/image-selector acceptance. Revision 60 implements the controller issuer-sync health gate and node observer. Host installation, persistent mount guards and supervised health delivery are still pending; this module remains default-off.

Revision 61 adds the separate read-only persistent-state guard and offline binding preparation. It validates the device aliases emitted here, UUID/mount and existing private recovery state; it never formats or initializes a disk. Installer/supervisor integration and real mount-loss acceptance remain open.
