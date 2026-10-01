# Axiom Proof — Operator runbook (deploy, acceptance, to-do)

### Axiom Minds Private Limited · https://axiomminds.ai

Replaces `16_Operator_Completion_Runbook.md`, `17_Deployed_Acceptance.md`,
`18_Operator_Deploy_And_Acceptance.md` and the operator items of
`13_Roadmap_Traceability.md` (all now stubs). Plan and status:
[20_Plan.md](20_Plan.md). Log: [21_Progress.md](21_Progress.md). Companion
references that stay: [08_DEPLOYMENT_GUIDE.md](08_DEPLOYMENT_GUIDE.md),
[09_RUNBOOK.md](09_RUNBOOK.md),
[GCP_PREPROD_DEPLOYMENT_GUIDE.md](GCP_PREPROD_DEPLOYMENT_GUIDE.md),
[GCP_PREPROD_ENV_CONFIG_CHECKLIST.md](GCP_PREPROD_ENV_CONFIG_CHECKLIST.md),
[ACCEPTANCE_TARGET.example.json](ACCEPTANCE_TARGET.example.json).

**How to use and keep this file.** Tick a box only when its _closure evidence_
exists and is recorded in `21_Progress.md` (link or ID). Never add a second
runbook. Long procedures from revisions 40-75 are summarised below with
their exact original text preserved in git:
`git show 41b70b6:docs/16_Operator_Completion_Runbook.md` (search the
"Revision NN" heading named in each item as `[16 RevNN]`). Other tags:
`[17A]` = 17_Deployed_Acceptance, `[18]`, `[13]`, `[14]`, `[15]`, `[brief]`.

**Priority meaning (assigned in this consolidation; older docs gave P-levels
only to workstreams).** **P0** = blocks any remote acceptance, or is an
exposed-secret/security decision. **P1** = needed to close a workstream or run
its acceptance. **P2** = decisions, housekeeping, gated/founder items.
Owner: **Operator** = provisions, bills, deploys, is irreversible, needs a
credential the agent must never see, or is a business/posture decision.
**Engineering** = code, migrations, tests, docs.

---

## 0. Standing constraints `[16 §0][18]`

- Implementing agents do not create, modify or bill cloud resources:
  `terraform validate`/`test` and read-only checks are the ceiling. No
  `terraform apply`, no Supabase project creation, no Secret Manager writes,
  no Cloud Run deploy. **The first real deploy is reserved to the operator.**
  The user has requested production deployment after full engineering
  clearance; that permits an agent to deploy an authorised release only once a
  verified target and completed gates exist `[18]`.
- **Object Lock Compliance is a one-way door.** Nobody (including the cloud
  owner) can shorten or delete it; a test bucket locked for 2555 days is gone
  for seven years. Never set retention on a bucket you experiment with. W8
  depends on it; it is deliberately the last thing turned on.
- **Never send an agent:** a service-role key, JWT secret,
  `APPROVAL_SIGNING_KEY`, the contents of any `.env*`, or
  `.axiom-runtime/personas/state.json`. Supply Secret Manager _resource names_
  or a SHA-256 of a value instead.
- Do not assume the AWS/EKS/Supabase examples in doc 08 describe the live
  target; verify from provider state `[18]`. Never print credentials into
  logs/artifacts.
- Local Docker parity is engineering evidence only; it never closes a remote
  gate `[16][17A][18]`.

### Sending evidence back `[16]`

One markdown block or file per batch: for each item its ID, what was run, and
the output trimmed to summary lines. Redact: service-role/JWT/approval keys,
`.env*` contents, `.axiom-runtime/personas/state.json`, any client data. On a
failure send the failure (a migration checksum refusal, a `401` that is a
`302`) rather than working around it.

## 1. Local Docker rules

1. **Teardown must not destroy local data by default.** The local teardown
   script (`down.sh` in the maintainer's brief) must stop services without
   removing local database containers or volumes. Full removal (database
   containers and volumes) happens **only** via an explicit flag (for example
   `--purge`/`--volumes`) and should name what it will delete. Never pass
   `docker compose down -v` or `docker volume rm` implicitly.
   _Current state:_ resolved for the local environment by PR #122 (merged to
   staging `711a319`): `scripts/dev-docker.sh --down` only stops containers;
   `--remove` keeps `temporal-db` and `supabase-db`; `--remove-all --yes`
   removes containers; deleting volumes additionally needs `--volumes
--confirm-data-loss`. Non-local environments keep the old `down`.
2. Keep the isolated parity Supabase project (`axiom-w0-parity`, API 56321,
   DB 56322) between runs; `scripts/test-deployed-http.sh --browser` removes
   only its own application containers and leaves the Supabase project for
   inspection `[15][17A]`.
3. Never delete append-only ledger/audit rows to clean up a shared or
   acceptance deployment; dispose of the isolated database through its normal
   lifecycle `[17A]`.
4. Run browser/container rehearsals from a clean committed checkout (it
   refuses to stamp dirty source with a release SHA) `[17A]`.
5. Private runtime data stays under ignored `.axiom-runtime` (mode `0600` for
   target files); never publish browser traces, cookies, secrets or target
   JSON `[15]`. Restore generated `next-env.d.ts` before commits `[15]`.
6. Cloud-session constraint: `registry.terraform.io` can be blocked, so
   Terraform validate/test and Helm render run only in CI there `[15]`.

## 2. Checklist index by workstream

| Workstream                     | P0         | P1           | P2          |
| ------------------------------ | ---------- | ------------ | ----------- |
| W0 / Release                   | P0-1…P0-14 | P1-R1…P1-R6  | P2-1        |
| W1                             |            | P1-W1a…W1d   |             |
| W2                             |            | P1-W2a, W2b  |             |
| W3 / W3.5                      |            | P1-W3a…W3d   |             |
| W4 (connectors, workload host) |            | P1-W4a…W4m   | P2-5…P2-7   |
| W5 / W6                        |            | P1-W5, P1-W6 |             |
| W7                             |            |              | P2-8, P2-9  |
| W8 / W8.4 / W8.5               |            | P1-W8a…W8c   | P2-10       |
| W9                             |            | P1-W9        |             |
| W10                            |            | P1-W10       |             |
| Founder / commercial           |            |              | P2-11…P2-14 |

Item format: **ID title** (source) · Owner · Input needed · How to verify ·
Closure evidence.

---

## 3. P0 — blockers

### W0 and release path

- [ ] **P0-1 Decide and record the target** (W0-1; `[16]`, `[18 §2]`) · Operator · project, region, billing account, topology; accepted direction is local Docker Supabase and self-hosted Supabase in higher environments (Cloud SQL may sit underneath; do not substitute managed Supabase); also existing deployment SHA, migration ledger, secrets source, DNS, rollback route · Verify: provider state and deployment records, not the doc-08 AWS examples · Closure: project id, region, topology (no credentials).
- [ ] **P0-2 Scaffold and mint configuration** (W0-2) · Operator · none · `./scripts/sync-env.sh scaffold` (appends only missing keys to `.env.preprod`), then `./scripts/sync-env.sh mint` (anon and service keys must come from **one** minting, else "login works, every API call 401s") · Verify: `./scripts/sync-env.sh verify` · Closure: `verify` output (presence/shape only).
- [ ] **P0-3 Pre-flight plan** (W0-3) · Operator · none · `./scripts/deploy-preprod-gcp.sh --dry-run` (review the script first: default phases may still enable APIs; use an initialised Terraform config with `terraform plan` for a plan-only review) · Closure: plan summary line (`Plan: N to add, ...`) and any unexpected resource.
- [ ] **P0-4 Provision base and database** (W0-4; **billing starts**) · Operator · approved plan · `./scripts/deploy-preprod-gcp.sh --phase base` (VPC, subnet, peering, connector, GCS vault, Artifact Registry, IAM) then `--phase db` (Cloud SQL, Secret Manager) · Closure: Cloud SQL instance name and Secret Manager _resource names_ (never values).
- [ ] **P0-5 Run the migration series on the real database** (W0-5) · Operator · DB URL via secret store · `./scripts/deploy-preprod-gcp.sh --phase migrate` or `./scripts/migrate-cloudsql.sh <DATABASE_URL>` (enforces TLS, records checksums, refuses edited history, non-zero on failure). The old runbook's "42 migrations 0000-0041" is stale: the repository at `41b70b6` has **90 files, 0000-0089** (`20_Plan.md` D4) · Verify: runner summary count and last migration name · Closure: summary; on a checksum refusal send the line verbatim and stop (never force).
- [ ] **P0-6 Seed representative identities** (W0-6) · Operator · none · `./scripts/deploy-preprod-gcp.sh --phase migrate --seed-identities`; multiple tenants and personas, **never client production data** · Closure: tenant count and persona roles (no emails/passwords).
- [ ] **P0-7 Deploy services and verify** (W0-7) · Operator · none · `--phase services` then `--phase verify`. Review the **full services-phase plan**, not just base/db · Closure: health matrix and public URLs of web app and BFF.
- [ ] **P0-8 Prove strictness against the deployed environment** (W0-8; closes W0.1) · Operator · private target JSON per `ACCEPTANCE_TARGET.example.json` · see section 5 (deployed acceptance procedure) · Verify: BFF returns **401** to an unauthenticated request; parity lane green on a named commit comparing remote API and browser suites · Closure: exact revision, CI run URL, sanitised `api-results.json` and `browser-results.json` per target. A local Docker rehearsal does not close it.
- [ ] **P0-9 Confirm rotation of the three held historical secrets** (`[14]` decision 1; `[16]` secret-scan audit) · Operator · confirmation they were/weren't used by a deployed stack · Held, **not** fingerprint-ignored: two 64-hex `GOTRUE_JWT_SECRET`/`PGRST_JWT_SECRET` values in `infra/docker/docker-compose.supabase.yml` (commit `7719f0c`) and `APPROVAL_SIGNING_KEY` in `infra/docker/environments/.env.preprod.example` (commit `7631b1f`). If used anywhere, rotate, then fingerprint-ignore in `.gitleaksignore` · Closure: rotation confirmation recorded; gitleaks run clean.
- [ ] **P0-10 Fresh secrets for the target** (`[18 §2]`) · Operator · target secret manager · Use fresh secrets; rotate values known exposed in historical commits; confirm effective strict auth mode · Closure: secret resource names; strict-mode readback.
- [ ] **P0-11 Verify residency, IAM boundaries and Object Lock on the real target** (`[18 §2]`) · Operator · target access · All client personal data, backups, storage, logs and model processing in `ap-south-1`; model egress receives only redacted values; identity/IAM and network paths; S3 Object Lock **Compliance** retention read back against a **real object/version** · Closure: provider readbacks archived with the acceptance artifacts.
- [ ] **P0-12 Recoverable backup and rollback plan before migration or cutover** (`[18 §2][18 §4]`) · Operator · none · Take/verify backup; document rollback route (database rollback is **not** an automatic reverse of an applied migration) · Closure: backup id/time and the recorded rollback route.
- [ ] **P0-13 Deploy and verify service IAM isolation (C-W0-5)** (`[16]`) · Operator · authorised cloud rollout · Offline first: `python3 scripts/check-cloudrun-iam.py`, `python3 -m unittest discover -s tests/deployment -p 'test_*.py'`, `terraform -chdir=infra/terraform/envs/preprod test` (mocked). Then review the full services-phase plan: nine distinct identities, each service bound to its own, 29 secret-level grants (plus BFF retiring-key grant only during rotation), old shared account and its project-level secret/SQL/artifact grants removed. Review existing project/folder/org grants separately · Verify: active revisions use intended identities; web/marketing cannot read approval, MFA, service-role or evidence keys; positive path per service; repeat strict API/browser acceptance · Closure: identities, resource names, allowed/denied outcomes (no secret values). Rollback: redeploy the prior reviewed image on the new identity; never route to a retired revision depending on the old shared identity. Note: `sync-env.sh secrets` no longer creates IAM bindings (it cannot restore the retired shared account's access) and Cloud Run sync merges rather than replaces bindings; finish a key rotation with the reviewed full Terraform plan/apply, since secret sync does not remove retiring-key resources/grants.
- [ ] **P0-14 Decide the prod EKS public-access CIDR** (W0-9; `[16]`) · Operator · `infra/terraform/envs/prod` has `cluster_endpoint_public_access_cidrs = ["0.0.0.0/0"]` with a never-actioned "restrict via WAF / OIDC" comment · Verify: engineering applies the change and the Terraform gate re-validates · Closure: the CIDR list or a dated deferral. Required before any prod apply.

---

- [ ] **P0-9 Provide the design system** · Operator · the claude.ai design file (`Axiom Proof App.dc.html`) needs a login; sign in in the in-app browser or export the file into the repo · Closure: file path or confirmation; unblocks the header, related-agents strip and placeholder-state pass.
- [ ] **P0-10 Clean the popped stash from the approval-reconciliation worktree** · Operator · `/Users/vikash/.codex/worktrees/approval-reconciliation/Axiom Proof` holds the 5 modified and 15 untracked files from an accidental `git stash pop`; the stash itself is safe on the stack as `f63c8ed`. Run `git checkout --` on the five tracked files and `git clean -nd` then `-fd` on the listed untracked paths · Closure: `git status` shows only `.axiom-runtime`.

## 4. P1 — close each workstream

### Release path and acceptance orchestration (`[18]`)

- [ ] **P1-R1 Engineering clearance matrix** · Operator (reviewer) + Engineering · one evidence row per W0-W10 requirement: implementing commit, test or measured result, reviewer, unresolved limitation · Verify: re-run the complete quality and security gate at the exact proposed release SHA; merge each increment into `staging` only after its PR gate, then verify CI and security on the exact staging merge SHA · Closure: matrix recorded in `21_Progress.md`. A green PR or local Docker suite alone is not clearance.
- [ ] **P1-R2 Preprod deployment at an exact recorded SHA** · Operator · release candidate SHA · Apply only checksum-verified append-only migrations; verify startup, revisions, migration ledger, health, auth, tenant isolation, MFA, BFF approval gates, ledger append path, provider credentials, scheduler and connector composition, with synthetic tenants; any live write-path test needs a human approval with completed dry-run, validated rollback and signed scope token · Closure: SHA, ledger and verification outputs.
- [ ] **P1-R3 Configure the deployed-acceptance workflow** (`[17A]`) · Operator · GitHub environments `preprod-acceptance` and the comparison environment, each with secret `AXIOM_ACCEPTANCE_TARGET_JSON`; `.github/workflows/deployed-acceptance.yml` must exist on the **default branch** for manual dispatch (pushing to staging alone does not enable it); workflow takes an exact 40-character SHA; two matrices compare preprod with a separately configured production-profile or on-prem target; a `production-configured-acceptance` label is **not** proof of production · Closure: workflow run URL.
- [ ] **P1-R4 Run W8 positive/refusal journeys on actual preprod** (`[18 §3]`) · Operator + Engineering · founder vs manager/viewer, report provenance, retained object/version, release/dispatch checks · Closure: archived results; failures fixed, not marked green.
- [ ] **P1-R5 Production release and acceptance** (`[18 §4]`) · Operator · select the exact tested release SHA; reconcile branch-promotion policy with the target deployment mechanism; verify backup/rollback; apply validated migrations; deploy the same artifact; verify reported SHA and ledger before shifting traffic; check health, residency/IAM/Object Lock, persona/API/browser journeys with synthetic accounts, approval/ledger behaviour, exact-version evidence retrieval, release/dispatch refusals; run remote acceptance against the **actual production URL and topology** · Closure: workflow run, sanitised results, target revision, timing, operator decision; update docs 20/21 with links, not percentages.
- [ ] **P1-R6 Failure handling** (`[18 §4]`) · Operator · stop promotion on any gate failure; isolate or roll back by the target-specific route; preserve append-only data; investigate per `09_RUNBOOK.md`; re-run the exact failed gate plus affected regression suite · Closure: failure record and passing rerun.

### W1 Tenancy, MFA, invitations

- [ ] **P1-W1a Deploy the session-attestation posture** (W1-1) · Operator · apply through 0036, deploy BFF and web together · Verify: existing sessions lose protected access when a recovery code activates a replacement authenticator, then regain independently after fresh MFA; replacement via the current factor keeps assurance; pending replacements without provenance return `replacement_authorization_changed` (409): restart enrolment, never guess provenance · Closure: observed behaviour per case.
- [ ] **P1-W1b Email provider for invitations** (W1-2) · Operator · transactional provider, sending domain, SPF/DKIM; API key in Secret Manager. Email OTP stays deferred; do not let a magic-link feature become an auth path · Closure: provider name, domain, SPF/DKIM verified, secret resource name.
- [ ] **P1-W1c Enrol a real second factor on the deployed environment** (W1-3) · Operator · real authenticator app · Verify: enrolment, approval step-up, and replacement via a recovery code each succeed; `secret_unreadable` (503) means a mis-set `AXIOM_MFA_ENCRYPTION_KEY` · Closure: success/failure per step with exact error code.
- [ ] **P1-W1d Invitation rollout** (`[16 Rev78]`) · Operator · apply 0053; `AXIOM_INVITATION_EMAIL_MODE` stays disabled until W1b evidence (then inviter shares a one-time link) · Closure: invite/accept observed.

### W2 Data model

- [ ] **P1-W2a Legacy assignment policy** (W2-1) · Operator · decide: assign existing unassigned engagements to an estate by hand, or leave unassigned until reviewed (never infer scope) · Closure: the policy.
- [ ] **P1-W2b Apply each migration batch to the deployed DB** (W2-2) · Operator · order is commit, then apply, never the reverse · Verify: same command as P0-5; also apply 0033 (creates seven empty connector tables; do not insert real credentials) · Closure: applied count and last migration name per batch.

### W3 Estate

- [ ] **P1-W3a Estate taxonomy** (W3-1) · Operator · what an "estate" is for clients (legal entity, business unit, environment, geography) · Closure: definition plus two or three real examples.
- [ ] **P1-W3b System kinds** (W3-2) · Operator · confirm `database, application, storage, identity, saas, other` suffices · Closure: missing kinds or confirmation.
- [ ] **P1-W3c Verify the inventory milestone** (W3-4) · Operator · apply through 0034, deploy BFF/web together; as owner/admin on `/estate` create an estate (explicit slug), add a system and category keys, edit, archive/restore; viewer/analyst can read but not manage; legacy intake assignment only for unassigned intakes with no findings/plans/runs/evidence/reports (never bypass with SQL); lost response: use "Retry same request", never a fresh key · Verify: one ledger event per successful mutation · Closure: ledger event ids.
- [ ] **P1-W3d Review an onboarding proposal** (W3-5; decision: owner **and** tenant admin may approve, analyst prepares) · Operator · apply through 0035; analyst prepares at `/estate/onboarding`, a different owner/admin approves/rejects with reason; stale-estate proposals are rejected and re-prepared · Closure: proposal and approval record.

### W4 Connectors, vault, workload host

- [ ] **P1-W4a Register a connector** (W4-1) · Operator · apply through 0038, deploy BFF/web; `/connectors` as owner/admin; non-secret endpoint identifier only (never URLs, tokens, passwords); "Enable registration" changes lifecycle only; disable before editing an enabled registration (revokes grants; re-enable does not restore them); archive revokes credential envelopes and is terminal · Closure: sanitised registration/lifecycle audit IDs.
- [ ] **P1-W4b Per-tenant KMS wrapping keys** (W4-2; apply through 0039/0040) · Operator · distinct per-tenant keys in Mumbai (`ap-south-1` AWS or `asia-south1` GCP); grant the broker only encrypt/decrypt; explicit primary and retiring key refs through broker deployment config (no env var, no shared-key fallback); retain old KMS resources while any envelope references them · Verify: real KMS seal/open/rotation for synthetic data, atomic SQL rollback, concurrent-change tests · Closure: sanitised key resource IDs/region, tenant-to-key uniqueness, IAM review (never clear secrets, DEKs, tokens). Issuer token lifetime must fit the remaining workload/grant/approval window; configure a shorter issuer lifetime rather than weakening verification.
- [ ] **P1-W4c Runtime transport token** (`[16]`) · Operator · deploy with `AGENT_RUNTIME_INTERNAL_TOKEN` (legacy `INTERNAL_TOKEN` fallback); unset/empty refuses every generic invocation · Closure: deployed config readback.
- [ ] **P1-W4d Workload-identity and runtime-audit probes** (`[16]`) · Operator/Engineering · `python3 scripts/test-workload-identity.py` (needs Docker, pnpm, curl, Python 3.12+; checksum-pinned SPIRE; publish only `.axiom-runtime/workload-identity/results.json`, `dirty: true` is not release evidence); `./scripts/start-parity-supabase.sh` then from `services/agent-runtime` `uv run python ../../scripts/verify-runtime-audit.py` (publish only `.axiom-runtime/runtime-audit/results.json`, require `passed: true`, `dirty: false`, expected revision) · Closure: those result files.
- [ ] **P1-W4e Task delegation controller rules** (W4-3 cont., 0041) · Engineering/Operator · apply 0041 before deploying a consumer; deliver the random proof only over the private channel; lost proof means revoke and reissue; never bypass the rejection of generic Karya issuance · Verify: `pnpm --filter @axiom/bff test` and `./scripts/test-database.sh` · Closure: both green.
- [ ] **P1-W4f W4.6 RDS staging acceptance** (`[16 Rev84]`) · Operator · in `ap-south-1`: (1) provision staging PostgreSQL with IAM authentication; (2) create a role with `rds_iam` and SELECT only (no INSERT/UPDATE/DELETE/TRUNCATE/CREATEROLE/CREATEDB/BYPASSRLS); (3) allow the Drishti workload role `rds-db:connect` for that user only; (4) record host, port, database, user and pinned RDS CA bundle under the connector's `endpointRef`; (5) run discovery through `SqlDiscoveryGate` and attach the result to audit 73. Enabling `/internal/discovery/run` also needs SPIRE trust and broker KMS configuration · Closure: discovery result attached to audit 73.
- [ ] **P1-W4g Controller placement and per-tenant VMs** (`[16 Rev57, Rev69]`) · Operator · keep `workload_vms = null` until bootstrap gates complete; configure `workload_vms.tenants` (map of tenant UUID to optional `controller_source_ranges`, 1-100 tenants, max eight private IPv4 /24-/32 ranges); pick a Mumbai zone and a named Secure-Boot image (families refused); outputs `workload_vm_hosts.runners[TENANT_UUID]` and `.issuer`; never relabel/import an old runner under a new key (reviewed Terraform migration plan, keep deletion protection) · Closure: reviewed plan; no apply without authorisation.
- [ ] **P1-W4h SPIRE bundle, state, host files** (`[16 Rev59, Rev61, Rev62]`) · Operator · render a fresh owner-only review directory with `scripts/prepare-workload-spire.py` from an operator policy file (real project, immutable runner instance ID, issuer address, trust domain, image config digests from `docker image inspect` `.Id`); prepare state bindings with `scripts/prepare-workload-state.py`; prepare host bundle with `python3 scripts/prepare-workload-host.py policy.json archive.tar.gz NEW_DIRECTORY [bootstrap.pem]`, review, deliver to a root-owned directory, run `spire_host.py --check-bundle` then `--install` with the reviewed SHA-256 (Ubuntu 24.04, Python 3.12, systemd 255, `blkid`, Docker on runner; separate issuer and runner hosts) · Closure: manifest SHA-256 recorded out of band; never delete state, enable rebootstrap, or format on refusal.
- [ ] **P1-W4i Issuer initialisation and runner enrolment** (`[16 Rev63, Rev64, Rev60]`) · Operator · mount the empty intended disk separately; as root `spire_enrollment.py --initialize issuer REVIEWED_MANIFEST_SHA256`, review receipt/CA/bundle, then `--seal issuer REVIEWED_RECEIPT_SHA256`; same for `runner` (before the node certificate expires); install the observer `spire_health.py` (`--once` or `--watch <expected-node-spiffe-id>`) and mount `/run/spire-health` read-only into the controller only · Verify: normal startup requires sealed state; health freshness under 10 s, issuer sync under 30 s · Closure: reviewed receipts; never erase keys or replay a marker.
- [ ] **P1-W4j Socket/health volumes and controller registration** (`[16 Rev65, Rev67]`) · Operator · `spire_volumes.py --prepare REVIEWED_MANIFEST_SHA256` as root then `--check` before activation and after any restart; review a registration for exactly `spiffe://<domain>/controller/assessment` (UID 20000, exact node, immutable image digest, JWT-SVID TTL <= 300 s); keep worker UID 20003 separate; never mount admin socket or Docker socket into workers · Closure: reviewed registration; no SVID dumps.
- [ ] **P1-W4k Protected controller files, placement, runtime lifetime** (`[16 Rev56, Rev58, Rev68, Rev70, Rev71]`) · Operator · copy `infra/workload/controller-review.example.json` to a private review file; `python3 scripts/prepare-controller-files.py PRIVATE_REVIEW_JSON PRIVATE_INPUT_DIR FRESH_OUTPUT_DIR`; as root `controller_files.py --install ROOT_OWNED_SOURCE_DIR REVIEWED_MANIFEST_SHA` then `--check TENANT_UUID REVIEWED_MANIFEST_SHA` (files under `/etc/axiom/controllers/<tenant>/<manifestSHA>/files`); placement preflight `controller_placement.py --check PRIVATE_PROFILE_PATH REVIEWED_PROFILE_SHA256`; runtime profile from `infra/workload/controller-runtime.example.json` installed with `controller_runtime.py --install PRIVATE_PROFILE_PATH REVIEWED_SHA256` (no daemon-reload/start); activation only after tenant-scoped backend/secret/KMS, private TLS/DNS and scheduler acceptance; stop via systemd, uncertain stops recovered with `--stop TENANT_UUID REVIEWED_SHA256`; never delete journals or adopt containers by name; controller entrypoint run `--check` then `--serve` with owner-only config (the raw `SUPABASE_SERVICE_KEY` env is refused) · Closure: reviewed hashes; activation only on separately authorised target.
- [ ] **P1-W4l Controller credential issuance, transitions, per-tenant secret/KMS config** (`[16 Rev73, Rev74, Rev75]`) · Operator · see `infra/credential-issuer/README.md` and `infra/workload/CONTROLLER_TRANSITIONS.md`; supply the reviewed per-tenant primary/retiring dispatch-key inventory to the workload module (empty tenant-labelled Mumbai secret containers, resource-level grants); renewal creates a reviewed fresh credential and does not switch a running host; a transition requires the old lifetime stopped separately and a loaded-unit confirmation before runtime admission · Closure: effective per-principal allow/deny checks, secret replication/payload validation, real KMS review (config alone is not effective IAM).
- [ ] **P1-W4m Dispatch KMS policy, retention, scheduler, Temporal** (`[16 Rev44-Rev53]`) · Operator · publish `DispatchKeyPolicy` through `DispatchPolicyStore.publish(policy, tenantId, authenticatedActorId, correlationId, expectedRevision)` (rotation: stage reader first, then promote primary; quiesce old producers and legacy callers during first rollout; keep all historical key refs readable; max ten readable refs per tenant; never trim). Retention: set `AXIOM_ASSESSMENT_DISPATCH_RETENTION_DAYS=90` (1-36500, separate from evidence/consent retention) and run `pnpm --filter @axiom/bff exec tsx --env-file=/absolute/protected/backend.env src/assessment-retention-worker.ts --once` (or `--watch`, max 1440 candidates/day) as a separately supervised job (never give its credential to the scheduler/worker); inspect `review` outputs before restarting. Scheduler: dedicated opaque identity with only its Temporal credential and narrow controller-invoke permission; command `python -m temporal_workers.worker --assessment-controller-origin https://CONTROLLER_SERVICE.run.app --assessment-outbox-pump`; provision Temporal namespace producer ACLs; local socket mode needs a controller-owned 0700 dir and trusted scheduler group (workers never join); drain/reconcile old `ComplianceEngagementWorkflow` histories on `axiom-compliance` before using the v2 queue; preload the reviewed assessment worker image (Dockerfile `infra/docker/Dockerfile.assessment-worker`, image ID `sha256:<64 hex>`, runtime pulls refused); old Cloud Run invoker policy cannot be the scheduler boundary · Closure: durable policy receipt and ledger event; scheduler and ACL evidence; never reset claims, edit attempt counters or switch namespaces to force a retry.

### W5 / W6

- [ ] **P1-W5 Production write path and deployed B.10 acceptance** · Operator + Engineering · operator-gated broker/SPIRE composition so a real write adapter can be bound; without a configured origin the executor refuses `execution_unconfigured` `[14]` · Verify: all eight PRD §B.10 criteria as passing tests plus a live rollback in a controlled staging estate `[11]` · Closure: recorded run.
- [ ] **P1-W6 Enable and observe the continuous scheduler** · Operator · `feature_continuous_scheduler` is off unless set per environment `[14]`; schedules, drift events, policy evaluations and health surfaces need deployed observation · Closure: schedule firing and health readback on a deployed target.

### W8 Reporting, evidence, mail

- [ ] **P1-W8a Object Lock Compliance bucket evidence** (`[16 §0]`, `[17B]`) · Operator · **last thing to turn on**; real bucket per P0-11 · Verify: provider readback of mode and retention against a real object/version; exact-version retrieval · Closure: readback archived. W8 WORM retention is not provable in CI.
- [ ] **P1-W8b Mail opt-ins** (`[16 C-W0-4/6, W1]`) · Operator · keep `AXIOM_REPORT_EMAIL_MODE=disabled` and `AXIOM_CONTACT_EMAIL_MODE=disabled` during acceptance; production mail needs explicit `delivery` mode and the BFF-held managed `RESEND_API_KEY` (marketing holds none); apply 0037 and 0052 and deploy BFF and marketing together; remove the unused marketing `resend_api_key` accessor binding by applying the updated IAM (no secret value change) · Closure: acceptance preflight passes with delivery disabled; real provider delivery not yet exercised `[16]`.
- [ ] **P1-W8c Gap-scan durability probe on remote targets** (`[17A]`) · Operator · after ordinary acceptance: `export AXIOM_ACCEPTANCE_TARGET="$PWD/.axiom-runtime/preprod-target.json"`; `pnpm exec tsx scripts/verify-gap-scan-durability.ts prepare`; operator restarts all BFF/marketing replicas **without replacing the database**; `... verify`; repeat for the comparison target · Closure: restart evidence retained (the probe cannot prove a restart); private `gap-scan-private.json` never uploaded.

### W9 / W10

- [ ] **P1-W9 Measured load, coverage and recovery on the target** · Operator + Engineering · real 1M-row discovery throughput and report timing at stated thresholds; CI-enforced per-module coverage floors (web gate 80% not met `[brief]`); scheduled-backup RPO and complete DB **and evidence-object** restore integrity with bounded RTO (synthetic benchmark and disposable restore are insufficient) `[A91]` · Closure: datasets, thresholds, versions, artifacts recorded.
- [ ] **P1-W10 Offline install acceptance** · Operator + Engineering · isolated offline target with egress **blocked**: strict secrets, functional in-perimeter Auth/PostgREST/DB, verified WORM configuration, local model dispatch or explicit unavailable result; install, upgrade, restore and persona journey `[A91][18]` · Closure: live air-gapped acceptance run (not done as of 2026-10-01 `[brief]`).
- [ ] **P1-W9b Remote acceptance plan fixtures** · Engineering + Operator · migration 0099 removed plan/action DML from the service credential; local and local-docker harnesses seed through a loopback owner connection, but a **remote** acceptance target now refuses to seed plans (`seed-personas.ts`, `verify-strict-parity.ts`) because it has no owner connection · Closure: a documented operator database path (or a sanctioned seeding RPC) and a remote persona/parity run that uses it.
- [ ] **P1-W8c Confirm the PDF renderer 503** · Engineering · `report_renderer_unavailable` appeared twice in CI on the first board PDF build and passed on other runs; `f34fef6` now logs timeout/signal/exit code/stderr tail · Closure: the next occurrence's BFF log line identifies the cause and a fix or a documented limit is recorded; until then it is unexplained.
- [ ] **P1-0099b Move the archive release label** · Engineering · `release_approval_proof_archive` still appends a human-labelled `approval.archive.released` event through the archive writer, not the human writer · Closure: routed through the human writer with a boundary test.

---

## 5. Deployed acceptance procedure (`[17A]`; used by P0-8, P1-R2/R3/R5)

**Prepare the target.**

1. Deploy BFF, web and marketing from the same clean Git revision with `--build-arg AXIOM_RELEASE_SHA=<40-character SHA>` on each Docker build (a dirty build has no trustworthy identity).
2. Use `ENVIRONMENT=preprod|production|onprem` with `AXIOM_AUTH_MODE=strict`; apply all migrations; keep external contact email disabled and `AXIOM_REPORT_EMAIL_MODE=disabled`; fixture setup seeds the published control library if absent and refuses a conflicting count.
3. Create a private JSON file from `ACCEPTANCE_TARGET.example.json` with credentials from the secret store (never chat or shell history): `anonKey` (JWT anon key), `publishableKey` (API gateway key), `serviceKey` (service-role JWT, fixture setup only). MFA encryption/signing keys are never supplied to the runner; SSR needs only the scoped public connection.
4. Store under ignored `.axiom-runtime` at mode `0600`; `topology=remote` for HTTPS (loopback HTTP only with `topology=local-docker`); `syntheticFixtures=true`; unique `deploymentId` per deployment; `expectedRevision` = deployed source SHA.

**Run and compare.**

```bash
chmod 600 .axiom-runtime/preprod-target.json
./scripts/run-deployed-acceptance.sh .axiom-runtime/preprod-target.json
./scripts/run-deployed-acceptance.sh .axiom-runtime/production-target.json
pnpm exec tsx scripts/compare-deployed-parity.ts \
  .axiom-runtime/acceptance/<preprod-id>/api-results.json \
  .axiom-runtime/acceptance/<production-id>/api-results.json
pnpm exec tsx scripts/compare-deployed-parity.ts \
  .axiom-runtime/acceptance/<preprod-id>/browser-results.json \
  .axiom-runtime/acceptance/<production-id>/browser-results.json
```

The runner verifies strict BFF identity and unauthenticated refusal before
seeding, checks web/marketing revision, enrols fixture MFA through the BFF and
drives the same Playwright journeys as local CI. `PLAYWRIGHT_BASE_URL` alone is
refused. Only `api-results.json` and `browser-results.json` are CI artifacts
(allowlisted names/outcomes, no credentials); raw browser JSON, logs and persona
state stay private; deployed traces/screenshots/video are disabled. Failed,
flaky or skipped browser runs cannot yield comparison evidence. Compare
artifacts from the same CI run and revision.

**Local rehearsal (engineering evidence, not remote proof).**
`./scripts/test-deployed-http.sh --browser` (install Playwright Chromium or set
`AXIOM_E2E_BROWSER_CHANNEL=chrome`; clean committed checkout). Fixture rows and
ledger events remain; dispose through the isolated DB's normal lifecycle.

## 6. P2 — decisions, housekeeping, founder and gated items

- [x] **P2-1 Main promotion** (`[14][16]`; `20_Plan.md` D7) · Done 2026-10-01 on the user's instruction: staging `8700264` (exact-SHA CI green) promoted by PR #129 merge commit to main `06bd190`, exact-SHA CI green. No deploy ran (main triggers CI and security only). Later promotions follow the same rule: merge commit, never squash, no direct pushes, no promotion while any gate is red.
- [x] **P2-2 Delete stale branches** (`[14]`) · Done 2026-10-01 (see P2-15 for what remains) · 41 remote and 119 local branches deleted after each tip was shown to be in main or captured in the backup bundle `~/axiom-proof-branch-backup-20261001.bundle` (ref list `~/axiom-proof-refs-20261001.txt`; restore any branch with `git fetch <bundle> <ref>:<ref>`).
- [ ] **P2-3 Dependabot holds** (`[14]`) · Operator/Engineering · `tailwindcss` 4 (major migration) and ESLint 10 (`scopeManager.addGlobals` breakage) held back; revisit deliberately (project memory also pins ESLint 9 + TS 6 in the lint shim; do not touch).
- [ ] **P2-4 Follow-up hardening** (`[14]`) · Engineering · five web screens still fabricate values with `Math.random`; Bandit medium findings in test-harness SQL; CodeQL flags on world-readable SPIRE health files (deliberate) and a URL built in `verify-controller-issuance.py`.
- [ ] **P2-5 `saml2_bearer` decision** (W4.7) · Operator · TODO, not a blocker; needs an XML-DSig dependency and a review decision.
- [ ] **P2-6 Vendor-verified descriptors** (W4.7) · Operator · need real client tenants.
- [ ] **P2-7 W3.5 lineage model** · Operator + Engineering · derivation edges need a data-lineage model; live updates and branded export open.
- [ ] **P2-8 Sector pack order** (W7) · Operator · BFSI pack #1 delivered; Healthcare then Tech next `[17B]`; pack #2 is gated `[13]`.
- [ ] **P2-9 Authoritative provider/retention equivalence record and marketing/API boundary reconciliation** (`[12]`) · Operator.
- [ ] **P2-10 BR-4 gap-scan exception** (`[12]`) · Operator · introduce the founder review gate or record an explicit, precisely scoped exception.
- [ ] **P2-11 Mock-data line** (`[11 E.2]`) · Operator · mock allowed only behind an explicit `demo` tenant flag with `provenance: 'simulated'`; proceeding on that basis unless told otherwise.
- [ ] **P2-12 Corporate and commercial** (`[13]` M0.1, BR-8) · Founder · incorporation, tax/banking, domain/trademark (Classes 42 and 45), commercial setup; new recurring spend only when covered by realised revenue.
- [ ] **P2-13 Phase-exit commercial evidence** (`[13]`) · Founder · client counts, delivery-time reductions, funded costs, production-client remediation outcomes (not waived).
- [ ] **P2-14 Gated Phase 5 items** (`[13]`) · Founder · SOC 2 Type 2 / ISO 27001 programme, Consent Manager registration, enterprise tier, split-plane, pack #2, policy-governed L4: each has its original external/revenue gate.
- [ ] **P2-15 Cleanup leftovers** · Operator · (a) Dependabot PRs #130-#134 against staging were left open: `actions/download-artifact` 4→8, `supabase/setup-cli` 1→3 and `azure/setup-helm` 4→5 are major bumps, `turbo` and `hono` are patch bumps; review and merge or close deliberately. (b) The worktrees `approval-reconciliation` (18 uncommitted files, the polluted stash, P0-10) and `axiom-proof-phase-gap-closure` (8 uncommitted files) were not touched, so their branches `codex/revision124-approval-proof-archive` and `claude/axiom-proof-phase-gap-closure-b88105` remain. (c) Three codex worktree directories were unregistered from git but macOS refused to delete their files (`~/.codex/worktrees/750f`, `human-proof-writers`, `statutory-source-bound`); remove them by hand. (d) The main checkout `/Users/vikash/Axiom Proof` still has local `staging` at `3492ffa`; run `git pull --ff-only` there. · Closure: `git branch -a` shows only the intended branches.

## 7. Engineering blockers that gate operator steps (not operator tasks)

Listed so the operator knows why a gate stays shut (`21_Progress.md` section 2):

- Migration **0099** (ledger source + execution gate) is an untested draft and a production blocker; deployment must not apply it until tested.
- Statutory dossier migrations **0091-0097** and **0098** are local only.
- W8.5 archive branch `codex/revision124-approval-proof-archive` (`d617c2a`) is local only; its 14-journey real-provider run is not green.
- Local teardown script vs section 1 rule 1 (`20_Plan.md` D12).
