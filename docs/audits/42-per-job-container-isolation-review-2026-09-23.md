# Review 42 — per-job container isolation

Reviewed staging `a01604b`, Revision 52, with green CI [35813509615](https://github.com/vikashkaruna/Proof/actions/runs/35813509615), all 17 applicable jobs and eight verified artifacts. Fresh upstream review found no intervening changes. Enqueue/claim policy fences, private dispatch and retention were preserved.

## Findings and implementation

- **UID separation inside a shared container was insufficient job isolation.** The trusted factory now creates an immutable-image container per launch with private process, network and cgroup namespaces. Simultaneous jobs cannot address each other's host processes. Root filesystem and the sole API socket volume are read-only.
- **A separate process still needs explicit network, metadata and credential boundaries.** The fixed profile has no IP route, disabled IPC, no host mounts/daemon socket or backend env. Actual probes deny public/controller/metadata connections. The root supervisor keeps only identity-drop and descendant-cleanup capabilities; the worker has no effective capabilities and cannot select another agent's identity.
- **Default container logging could persist private tool frames.** The factory forces Docker's `none` log driver and attached private pipes. It accepts no caller command, arbitrary mount, environment or logging override, and uses an explicit local daemon with an allowlisted CLI environment. Runtime image pulls are disabled.
- **Independent worker identity needed a provisioned client and node visibility.** The image includes a checksum-verified SPIRE client. The trusted acceptance node sees host PIDs and owns issuer state separately; jobs receive only its API socket. Real SPIRE → scoped tools → Postgres execution is exercised in the new containers, preserving prior outcomes.
- **Transport exit is not task cleanup.** Tests inspect daemon-side removal after normal execution, aborted input and SIGKILL of the attached CLI. The fixed supervisor deadline bounds an orphaned job. Daemon/host failures still require reconciliation; no claim is reset.
- **Over-specific network tests can misdiagnose Docker Desktop.** Its inert tunnel interfaces are allowed only while down, with no route and no network administration capability. Actual denied endpoint connections remain required. Unit test matching was corrected to distinguish forbidden `--pid` from the required `--pids-limit` resource bound.

## Validation and limits

862 BFF tests; workspace tests/lint/typecheck and separate acceptance TypeScript. Local Auth/PostgREST/SPIRE acceptance passes 61 identity and 51 worker outcomes, including all prior 43. Actual inspect/kernel probes cover readonly mounts, separate processes, no effective worker capabilities, CPU/memory/process limits and disabled logs. Final exact merge CI and eight sanitized artifacts are recorded in the saved session. No migration changed: 0047, 55 public tables, 48 migration/17 concurrency/13 upgrade suites.

The daemon, controller, node agent and reviewed image are trusted; containers share a kernel. UID selectors and a controlled socket are local evidence, not production image admission, node bootstrap or live registration/revocation. Cloud Run cannot be given this local daemon arrangement as an implicit rollout. Dedicated runner/service composition and production trust remain engineering work, followed by remaining workers/actor chains, W4.4, full W3 and W4.5–7. No cloud deployment, client mutation, key destruction or WORM change occurred.

Implementation references: [SPIRE 1.15.3 Unix attestor](https://github.com/spiffe/spire/blob/v1.15.3/doc/plugin_agent_workloadattestor_unix.md) documents kernel-based selectors; [Docker container runtime options](https://docs.docker.com/engine/containers/run/) documents namespaces and resource/privilege controls. Acceptance verifies the chosen configuration rather than treating those options alone as runtime evidence.
