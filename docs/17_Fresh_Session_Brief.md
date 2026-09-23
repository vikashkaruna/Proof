# Fresh task brief — 23 September 2026

The user requested a fresh task and explicit status stops at logical milestones. Continue from this brief, Doc 11's current workstream register and Docs 14–16. Do not reload the entire old conversation. Do not launch another long unattended sequence: finish one bounded milestone, report completed/pending work, and stop for the user.

## Verified and shipped

- Revision 69: dedicated private Mumbai runner **VM per tenant**, each with a separate service account, address and state disk; shared separate private issuer; public APIs on Cloud Run. Staging `55282ea9239cd7df867367855b1d1b06b0cbb55c`, CI 35859815075, all 19 applicable jobs and 13 exact-revision artifacts verified green.
- Earlier completed components retained: estate inventory and owner/admin proposal review; connector registry/contracts/lifecycle and credential/OAuth core; MFA recovery replacement assurance revocation; isolated assessment worker and durable encrypted dispatch, independent confirmation, key-policy rotation and configurable retention (default 90 days); pinned SPIRE host/enrollment/health/volume delivery, exact controller-role admission and protected controller files.
- Revision 70: tenant/VM placement preflight shipped to staging `616ed0239ef27fce4f483a951baccd02132a65d0`. It binds reviewed tenant/file generation/node to fixed nonsensitive GCP metadata, Mumbai zone and active private interface. All 141 deployment tests and 16 Docker host-delivery checks pass locally. CI [35861740826](https://github.com/vikashkaruna/Proof/actions/runs/35861740826) is verified **green**, with all 19 applicable jobs and 13 exact-revision artifacts checked. This preflight alone does not activate a controller or complete W4.

## Saved implementation in progress — Revision 71

Branch `codex/controller-supervision` contains a **WIP checkpoint, not a staging-ready milestone**. No supervisor code has been merged to staging. Review it before expanding it.

Files: `infra/workload/controller_runtime.py`, runtime example profile, host bundle/layout changes, `tests/deployment/test_controller_runtime.py`, `scripts/lib/controller_runtime_acceptance.py`, and its call from the native runner fixture.

The draft provides protected runtime-profile/unit delivery, private Docker configuration, durable intent before create, exact container ID before start, per-tenant locking, repeated placement checks, signal handling, 90-second Docker stop grace, and recovery using recorded identity without live metadata/issuer health. No automatic Docker/systemd restart, name-based adoption, container deletion, job reset or cloud provisioning. Root controller/daemon access remains part of the trusted host boundary.

Validation so far: 13 new unit tests passed (154 deployment tests total), 16 disposable Ubuntu host-delivery checks passed, Python compilation passed. **The new native lifecycle fixture has not run.** It adds seven intended outcomes (expected runner total 40, preserving all previous 33); it uses a deliberately synthetic process and a fixture-only local-node placement substitution. Existing real production-entrypoint, identity and assessment acceptance must stay required.

A local Docker creation probe was **refused**, not green: its observation reported `127.0.0.1` and an empty/random host port instead of the requested `10.0.0.11:8443`. The production confinement check correctly rejected the mismatch. Cause remains undiagnosed. Do not weaken the private-IP/port guard to accommodate this local observation. Inspect native Linux Docker behavior and independently review the remaining confinement fields, ownership/failure paths, unit timeout/namespace behavior, file installation and fixture cleanup. Add meaningful missing tests before calling the draft complete.

## Next order and remaining scope

1. Revision 70 exact-merge CI is verified green. Review/fix/finish Revision 71 and run real native systemd/Docker acceptance plus existing regression gates. Keep the old 33 runner outcomes and separate actual production-entrypoint checks. Document exactly what is synthetic versus real.
2. After green source/CI, update Docs 11–16, the map, audit and session; merge with `--no-ff` and push staging. Report a logical-milestone status and stop for the user.
3. Subsequent work: effective tenant-scoped backend/secret/IAM/KMS permissions, private TLS/DNS, opaque scheduler deployment; real GCP IIT/caller/KMS and Mumbai backup/restore remain external acceptance gates. No cloud provisioning/apply is authorized in this session.
4. Broader roadmap remains incomplete: W0 remote deployments/parity; W1 invitations/email/deployed acceptance; W2 **19/40 named target tables delivered** (schema tip 0048, 49 migrations, 55 public tables); W3 full resumable wizard/sustenance/live graph; W4 remaining worker/actor chains, live connector grants and later execution lifecycle; later W5–W10 phase gates. Do not equate completed infrastructure components with whole W0–W4 or goal completion.

## Decisions and operating constraints

- Local real Docker Supabase/Auth/Postgres. Higher-environment Supabase generated by deploy scripts.
- Dedicated private Mumbai runner VM per tenant; separate private Mumbai issuer VM. No shared tenant runner path.
- Owners **or tenant admins** approve staff onboarding proposals.
- Recovery-code authenticator replacement requires MFA again; implemented revocation remains mandatory.
- Completed private dispatch retention configurable by environment, default 90 days; unresolved jobs/evidence retain separate rules.
- Preserve recorded application approvals, dry-run/rollback, Sudhaar's no-write role, append-only ledger, WORM evidence and Mumbai data locality.
- Do not touch the original Claude checkout `/Users/vikash/Axiom Proof`. Prior isolated checkout: `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`. It will be clean at handoff and no longer executing work.
- Use the new task's managed worktree. Fetch and inspect `origin/codex/controller-supervision`, then advance the new worktree to that saved branch without overwriting unrelated work. The old remote `codex/w0-w3-closure` ends at the completed Revision 70 staging merge.
- `/Users/vikash/bin/gh` and `/opt/homebrew/bin/terraform` are available. Tests: `python3 -m unittest discover -s tests/deployment -p 'test_*.py'`, `python3 scripts/test-workload-host.py`, normal workspace/security/format gates. Native runner fixture is **fresh GitHub-hosted Ubuntu only**, never a user machine.
- The old goal tracker is `usageLimited`, not complete. Do not reset/resume it through goal tools or claim full completion. Continue only within user authorization and report honest scope.

Private local diagnostic material remains in the old isolated checkout's `.axiom-runtime`: `session-checkpoint.json`, `rev69-ci-verification.json`, CI artifacts, Revision 70/71 logs, `revision71-design.md`, `rev71-created.json`, and the local Docker probe scripts. These are useful evidence, not deployable configuration; do not commit private runtime artifacts or secrets.
