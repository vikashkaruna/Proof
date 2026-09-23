# Review 51 — SPIRE host delivery and normal restart

Date: 23 September 2026. Base reviewed: `13ce160`, Revision 61, green CI 35833267173. No intervening staging work was found. This follows the accepted separate private Mumbai issuer/runner architecture; public APIs remain on Cloud Run.

## Findings addressed

- A pinned download alone is insufficient: archive inventory, sizes, member types and ELF architecture now constrain what can be delivered. No archive paths are extracted.
- Root installation must not become arbitrary command execution or silent upgrades. Fixed destinations/modes, separately reviewed manifest SHA, protected ancestry, exact retry and conflict refusal enforce first-file delivery. The trusted root/image remains part of the host boundary.
- Startup must distinguish enrollment from restart. Generated normal units invoke only ready-state admission; initialization, marker delivery and enrollment are absent.
- A passing startup guard cannot cover later mount loss. Units use device-to-mount and mount-to-service `BindsTo`/`After` relationships. A new native Ubuntu CI test covers service namespace compatibility and mount disappearance; syntax validation is reported separately.
- New runtime directory modes must survive a private umask without repairing existing unsafe paths. Fresh creation sets explicit 0755; existing nonconforming directories are refused. The workload directory is not deleted by SPIRE restart.

## Validation and boundaries

77 deployment unit tests pass, including 19 host cases. Local Docker acceptance passes all 16 outcomes with real pinned binaries and delivery for issuer/runner in capability-less, read-only, networkless containers. A separate disposable GitHub-hosted Ubuntu 24.04 job verifies actual issuer startup, missing marker/key refusal, mount disappearance, preserved CA/registry and recovery. Exact merge results and artifact outcomes are saved in the session; new CI coverage must pass before this milestone is called green.

Fixture review corrected writable temporary storage for systemd verification, executable permissions on the binary tmpfs, and SPIRE version output on stderr. Product state permissions and guards were not weakened.

No product migrations, business permission changes or cloud apply. The installer does not mount, format, initialize, enroll, reload, enable or start anything. No in-place upgrade is implemented. CA checksum delivery is byte binding, not independent identity verification. State markers are structural configuration bindings. Native test enrollment is only fixture setup and must never be used as production automation. Full runner/observer lifecycle, GCP metadata attestation, socket-volume mapping, production controller/scheduler composition, effective IAM/TLS and Mumbai backup/restore remain open.

Next: explicit first-enrollment/marker workflow and full runner supervision acceptance, then controller delivery and scoped cloud integration. Whole W3/W4 and W0/W1/W2 closure is not claimed.
