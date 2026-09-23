# Review 46 — separate private Mumbai workload hosts

The user explicitly selected a separate private SPIRE issuer VM alongside the previously selected runner. Public APIs remain on Cloud Run. This milestone prepares the infrastructure boundary in the existing GCP deployment configuration; it does not silently replace the legacy AWS production topology or provision resources.

Revision 56 controller composition is verified green at merge `df409cb`, CI [35821680808](https://github.com/vikashkaruna/Proof/actions/runs/35821680808), with 17 applicable jobs and nine exact-revision artifacts. Fresh upstream review found no intervening other-model commits.

## Implementation and review

The new module creates separate identities, private addresses, shielded instances and state disks in Mumbai only. Root composition is opt-in (`workload_vms = null` by default). No startup script, secret, IAM resource grant, public interface, SSH or IAP access is introduced. Named image references reject family drift but still require provenance review and protection against publisher replacement. The controller image's immutable Docker ID policy remains separate.

Instance creation explicitly depends on the dedicated firewall rules so a guest cannot boot before its network boundary exists. Network rules target dedicated service accounts, restrict issuer ingress to the runner on 8081 and controller ingress to explicit private scheduler ranges on 8443. Deny rules cover other ingress/egress; HTTPS egress is allowed for trusted host dependencies. It is not destination filtering. Existing higher-priority/hierarchical rules and network routing require effective deployment review. Workers must retain the proven networkless container boundary; VPC firewall rules do not replace it.

State disks and VM deletion protection reduce accidental loss in ordinary managed changes. They do not provide backups or prevent an authorized operator changing configuration. Bootstrap must validate/mount preserved state before starting the issuer or agent and must not format disks or automatically re-enroll on restart. A separate management and recovery path is still needed before activation.

## Verification and remaining work

Nine module boundary/refusal tests and eight root composition/IAM tests pass with mocked providers, including default-off behavior, explicit composition, other-region refusal, mutable-family refusal, private-prefix validation and production account names. Both configurations validate; CI now runs both suites. No provider was applied against real cloud infrastructure or credentials. Existing application/schema acceptance is unchanged; the final exact merge must retain all 17 applicable CI jobs and nine sanitized artifacts.

Remaining deployment work includes issuer/node bootstrap, persistent key state, exact node/image admission, protected trust/configuration mounts, secret/KMS IAM, TLS/DNS, health, supervision, backups and the separate opaque scheduler. The single host pair is not an HA or live execution claim. Continue the unclosed W3/W4 and W0/W1/W2 roadmap. No client mutation, cloud apply or WORM change occurred.
