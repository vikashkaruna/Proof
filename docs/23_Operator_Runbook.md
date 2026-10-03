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

## 1a. Command line: CI, build, deploy, soft stop and start

One entry point, `scripts/axiom-ops.sh`, drives all of it. Every value comes from `.env.<env>` (root symlink or `infra/docker/environments/.env.<env>`; root wins, and a warning is printed if both exist and differ); nothing is hard-coded. The environments are `local`, `staging` and `preprod`; `onprem` is accepted for `stop`, `start`, `status` and `env-check` only; `--env all` (stop, start, status) walks every non-production environment that has an env file (preprod, staging, local, onprem, in that order, skipping the rest). `production` is refused for every command and cannot be added by a flag.

**One-time setup per environment**

```bash
cp infra/docker/environments/.env.preprod.example infra/docker/environments/.env.preprod
ln -s infra/docker/environments/.env.preprod .env.preprod   # only if the root link is missing
# an existing file from before: scripts/sync-env.sh preprod scaffold  (appends only missing keys)
scripts/axiom-ops.sh env-check --env preprod
```

`.env.local`, `.env.staging`, `.env.preprod`, `.env.production` and `infra/docker/environments/.env.*` are all gitignored; only the `.env*.example` templates are tracked (the root ones are symlinks into `infra/docker/environments/`), and a test fails if that ever changes. The tool parses the file (it never sources it), so a `$(...)` in a value cannot run. A value already set in your shell wins for that run (`GCP_REGION=... scripts/axiom-ops.sh ...`). A file whose `ENVIRONMENT=` disagrees with its name is refused. Placeholders such as `<your-project>` count as missing.

| Command                                   | What it does                                                                                                                                                                                                                         | Cost / risk                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `axiom-ops.sh env-check --env E`          | Finds the file, reports required keys present or missing (names only), runs the config audit for preprod.                                                                                                                            | none                                                                 |
| `axiom-ops.sh ci [--env E]`               | The CI gates locally: config audit, frozen install, format, lint, typecheck, unit tests, script tests, control-count and tfvars gates, Python service tests, the security scan. Flags `--skip-security --skip-python --skip-config`. | none (local)                                                         |
| `axiom-ops.sh build --env preprod --yes`  | Builds the nine images from the exact HEAD SHA and **pushes** them to Artifact Registry. Needs a clean tree.                                                                                                                         | registry storage; asks first                                         |
| `axiom-ops.sh deploy --env preprod --yes` | Runs `deploy-preprod-gcp.sh` at the exact HEAD SHA with your env file. `--dry-run` is a Terraform plan only. Pass phases through: `-- --from-phase services`, `-- --phase db`.                                                       | **billing starts** (Cloud SQL, Cloud Run, VPC connector); asks first |
| `axiom-ops.sh stop --env preprod --yes`   | Soft stop, see below.                                                                                                                                                                                                                | cuts idle cost; deletes nothing                                      |
| `axiom-ops.sh start --env preprod --yes`  | Puts everything back exactly as it was.                                                                                                                                                                                              | restores the cost                                                    |
| `axiom-ops.sh status --env preprod`       | What is running and what still costs money.                                                                                                                                                                                          | none                                                                 |

Every mutating command takes `--dry-run` (shows the exact `gcloud` calls) and asks for confirmation unless `--yes` is given; without a terminal it refuses rather than guess. For `local` and `staging`, `build`/`deploy` run `dev-docker.sh` (`--build` for build), `stop` is `dev-docker.sh --down` and `status` is `--status`; local stop keeps containers and data (see section 1).

**Soft stop covers every non-production environment.** `preprod` is the only GCP environment, handled by `scripts/softstop-gcp.py`; `local`, `staging` and `onprem` are Docker stacks, handled by `dev-docker.sh --down` (containers and data stay in place; `start` brings them back). `stop --env all --yes` does all of them; production is never included.

**Cloud detail (`scripts/softstop-gcp.py`).** Nothing is deleted, so no object ID changes and no wiring has to be redone. It acts only on objects belonging to the environment (Cloud Run `axiom-*-<env>`, VMs `axiom-<env>-*`, Cloud SQL `axiom-proof-<env>-pg-*`):

1. **Cloud Run:** minimum instances set to 0; the old value is kept in the service label `axiom-softstop-min` and put back by `start`.
2. **Compute VMs:** running ones are stopped and labelled `axiom-softstopped`; `start` starts exactly those. A VM you stopped yourself is never started for you.
3. **Cloud SQL:** activation policy `NEVER` (stopped; disk and backups kept). `start` sets `ALWAYS` and waits until `RUNNABLE` before touching Cloud Run. A database stopped by someone else is left alone.

State is on the objects (labels), so another laptop can run `start`; a record of each run is written to `.axiom-runtime/softstop/<env>.json`. Running `stop` twice is safe. If you run `deploy` while stopped, Terraform restores the original sizing and `start` becomes a no-op for Cloud Run. While stopped the app is down: the first request after `start` is slow because instances are cold.

**Cost that continues while soft-stopped:** Cloud SQL storage and backups, disks of stopped VMs, Artifact Registry images, Secret Manager secrets, the S3 evidence bucket (Object Lock), and the Temporal Cloud and Upstash subscriptions. There is no network object left to bill: Cloud Run uses Direct VPC egress (section 1b), so the Serverless VPC Access connector no longer exists. `status` prints this list.

**Not exercised against real cloud.** The soft-stop logic is tested against a fake `gcloud` that applies each change (round trip restores the original sizing exactly, other environments untouched, nothing deleted, five mutants killed), and `--dry-run` prints the real calls. It has not been run against a live project because none exists yet. Run `stop --dry-run` first on your first real deployment, then `stop`, `status`, `start`.

**Nightly stop (opt-in).** See D1-D4 in section 2a: `.github/workflows/preprod-nightly-stop.yml`, off until `NIGHTLY_STOP_ENABLED=true`.

**Manual cloud operations from GitHub (no laptop needed).** The workflow `Preprod operations (manual)` (`.github/workflows/ops-preprod.yml`) runs `axiom-ops.sh` for you: pick `status`, `deploy`, `stop` or `start`, an exact `revision` for deploy (must be on `main`), and `dry_run` (defaults to true). It has **no push, schedule or pull-request trigger**, so merging to main never deploys anything; it runs only when you start it, only from `main`, and waits for the required reviewer of the `preprod-ops` environment. One-time setup: create the GitHub environment `preprod-ops` with required reviewers; add the secret `AXIOM_ENV_PREPROD` (the whole `.env.preprod`); add the variables `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT` (keyless; never store a JSON key). **Not run yet:** it has been syntax-checked and its triggers and guards are tested, but a first dry-run `status` must prove the federation and the runner's Docker and Terraform steps before you trust a real deploy.

## 1b. Network design change: Direct VPC egress (decided 2026-10-03)

Cloud Run reaches Cloud SQL (and, when enabled, the private workload hosts) through **Direct VPC egress** on a dedicated `10.10.16.0/24` subnet, replacing the Serverless VPC Access connector. Reasons beyond cost: lower latency and higher throughput on a direct path, no connector instances to size, patch or monitor, no connector throughput ceiling, and nothing left that cannot be soft-stopped. Full design, component map, flows and ranked opportunities: `docs/22_Architecture_and_Flow.md` section 3.

What you must know before the first deploy:

1. `controller_source_ranges` for any runner firewall must be `10.10.16.0/24` (the example tfvars already say so).
2. The egress subnet cannot be deleted for up to 20 minutes after its services are gone (Cloud Run holds the addresses); teardown handles it in the last network phase.
3. Services use the second-generation execution environment (required); expect a slightly slower cold start.
4. **Not proven on a real project.** Only `terraform validate`, `fmt` and the mocked tests ran. Your first `deploy --dry-run` is the real check; read the plan for the services with a network interface (bff, agent-runtime, temporal-worker, supabase auth, supabase rest), the new `run-egress` subnet, the private `run.app` DNS zone and the per-caller invoker bindings.

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

## 2a. Your action list, in order

Work top to bottom. Tier A costs nothing and unblocks engineering. Tier C is the first thing that bills, so it starts only on your explicit go-ahead (nothing billable or irreversible is done without it). Items already done are in the changelog at the end of this section.

**Tier A — decisions and housekeeping (now, no cost)**

1. **P0-1** Decide the target: project, region, billing account, topology. Everything deployed waits on this.
2. Answer the small policy questions engineering is waiting on: **P1-W2a** (legacy assignment), **P1-W3a/b** (estate taxonomy, system kinds), **P2-10** (BR-4 gap-scan exception), **P2-11** (mock-data line), **P0-14** (prod EKS CIDR), **P2-8** (sector pack order), **P2-5** (`saml2_bearer`).
3. **P2-17** decided 2026-10-03: keep the expiring allowlist until a fixed `braces` release ships, then delete the entry (no migration to Tailwind 4, no package swap). Put a reminder for **2026-11-02**; the exception expires then and the security scan fails again by design.
4. **P2-15 (b)** only 4 branches remain on purpose: `main`, `staging`, `chore/housekeeping-2026-10-03` (this session) and local-only `claude/axiom-proof-phase-gap-closure-b88105` (the earlier session's branch, fully merged, kept until that session is reinvoked; delete it then). Three extra detached worktrees (`dazzling-torvalds-37bc2e`, `phase-0-5-gap-closure-5fd349`, `.kilo/.../attractive-sandwich`) hold uncommitted regenerated files and a few real edits; their diffs are backed up in `~/axiom-proof-housekeeping-backup-20261003/extra-worktrees/`. Remove them when you are sure nothing in them is wanted.

**Decisions taken 2026-10-03 (all implemented in code, none applied to a real project yet)**

- **D1 Non-production does not keep instances warm.** Preprod services scale to zero (`AXIOM_RUN_MIN_INSTANCES=0`, range 0-2; startup CPU boost on). Expect the first request after idle to take seconds; set `1` if a demo needs it.
- **D2 Nightly soft stop: on offer, opt-in.** `.github/workflows/preprod-nightly-stop.yml` stops preprod at 22:00 IST (cron `30 16 * * *` UTC) only if the repository variable `NIGHTLY_STOP_ENABLED` is `true`. It can only stop (never deploy, build or start) and deletes nothing. It needs the `preprod-nightly` environment (same secret and variables as `preprod-ops`, no required reviewer). Change the time by editing the cron; skip a night by setting the variable to `false`. Restart with the manual workflow or `axiom-ops.sh start --env preprod`.
- **D3 Internal services are internal by design.** agent-runtime and model-gateway use internal ingress, per-caller IAM invokers, Google ID tokens (`X-Serverless-Authorization`) and a private `run.app` DNS route; the shared token header stays as a second check (`AXIOM_INTERNAL_SERVICES_PRIVATE=true`). **First-deploy check:** one BFF to agent-runtime call and one agent-runtime to model-gateway call must succeed. If routing misbehaves set it to `false` and redeploy to restore the earlier public-plus-token endpoints.
- **D4 No edge protection in non-production; optional in production.** `AXIOM_ENABLE_EDGE_PROTECTION` (production env file, default `false`) creates an AWS WAF web ACL only when `true`. It protects nothing until the edge is an ALB or CloudFront (production ingress is nginx behind an NLB today): that production design choice is still open.

**Tier B — prepare the target (still no billing)**

5. Create the GitHub environment `preprod-ops`, its secret and variables (section 1a, manual workflow) if you want to run operations from GitHub. Use the commands in section 1a for everything below: `scripts/axiom-ops.sh env-check --env preprod`, then `ci --env preprod`. **P0-2** scaffold and mint config, **P0-3** dry-run review, **P0-12** backup and rollback plan, **P0-10** fresh secrets (this is also where the secret-rotation practice in **P0-9** applies), **P1-R3** configure the acceptance workflow and GitHub environments.

**Tier C — provision and prove (billing starts; explicit go-ahead)**

6. First `scripts/axiom-ops.sh deploy --env preprod --dry-run`, then `build --env preprod --yes` and `deploy --env preprod --yes` (section 1a). **P0-4 → P0-5 → P0-6 → P0-7 → P0-8**, then **P0-11** (residency, IAM, Object Lock) and **P0-13** (service IAM isolation), then **P1-R1/R2** (clearance matrix, deploy at an exact SHA).

**Tier D — verify each workstream on the deployed environment**

7. W1 (**P1-W1a-d**), W2 (**P1-W2b**), W3 (**P1-W3c/d**), W4 (**P1-W4a-m**), **P1-W5**, **P1-W6**, W8 (**P1-W8b** opt-ins, the gap-scan durability probe, **P1-W8a** Object Lock last), **P1-W9** (live NFRs), **P1-W10** (air-gapped acceptance), then **P1-R4/R5/R6** (W8 journeys on preprod, production release, failure handling).

**Tier E — founder and commercial (run in parallel, any time)**

8. **P2-12** incorporation and commercial setup, **P2-13** phase-exit evidence, **P2-14** gated Phase 5 items, **P2-6/P2-7/P2-9** (vendor descriptors, lineage model, provider equivalence).

**Engineering-owned, you only watch:** **P1-DS1** (15 remaining routes get the module bar), **P1-W8d** (renderer flake, root cause open), **P1-W9b**, **P1-0099b**, **P2-3/P2-4**.

**Open and unproven (do not claim otherwise):** nothing is deployed or measured live (W9 numbers, W10 acceptance); the W8 first-PDF flake has no confirmed root cause (two theories refuted, the failing step's Chrome output points at first-launch work, it passes on re-run); the animated agent states (`thinking`, `working`) cannot be verified in still screenshots.

**Cost saving between sessions (non-production):** `scripts/axiom-ops.sh stop --env preprod --yes` when you finish, `start` when you resume (section 1a). Nothing is deleted, so IDs and wiring survive.

**Changelog of operator items closed on 2026-10-03:** P0-9 reclassified informative (rotation is a provisioning practice, not a blocker), P0-16 (stash and worktree cleanup, no loss), P1-DS2 (design library uploaded), P1-DS3 (status colours accepted), P1-DS4 (agents mirrored into claude.ai), P2-15 (a, c, d), P2-16 (turbo opt-out).

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
- [x] **P0-9 Held historical secrets: rotation practice (informative, not blocking)** (`[14]` decision 1; `[16]` secret-scan audit) · Operator · Decision 2026-10-03: nothing has been published or deployed with these values, and every secret is minted fresh at P0-10 and rotated as a routine when a target is provisioned, so this does not gate anything. Practice for operators: never reuse a historical value on a target; if any held value is ever found in use, rotate it first, then fingerprint-ignore in `.gitleaksignore`. Held, **not** fingerprint-ignored: two 64-hex `GOTRUE_JWT_SECRET`/`PGRST_JWT_SECRET` values in `infra/docker/docker-compose.supabase.yml` (commit `7719f0c`) and `APPROVAL_SIGNING_KEY` in `infra/docker/environments/.env.preprod.example` (commit `7631b1f`) · Closure: none required; revisit at P0-10.
- [ ] **P0-10 Fresh secrets for the target** (`[18 §2]`) · Operator · target secret manager · Use fresh secrets; rotate values known exposed in historical commits; confirm effective strict auth mode · Closure: secret resource names; strict-mode readback.
- [ ] **P0-11 Verify residency, IAM boundaries and Object Lock on the real target** (`[18 §2]`) · Operator · target access · All client personal data, backups, storage, logs and model processing in `ap-south-1`; model egress receives only redacted values; identity/IAM and network paths; S3 Object Lock **Compliance** retention read back against a **real object/version** · Closure: provider readbacks archived with the acceptance artifacts.
- [ ] **P0-12 Recoverable backup and rollback plan before migration or cutover** (`[18 §2][18 §4]`) · Operator · none · Take/verify backup; document rollback route (database rollback is **not** an automatic reverse of an applied migration) · Closure: backup id/time and the recorded rollback route.
- [ ] **P0-13 Deploy and verify service IAM isolation (C-W0-5)** (`[16]`) · Operator · authorised cloud rollout · Offline first: `python3 scripts/check-cloudrun-iam.py`, `python3 -m unittest discover -s tests/deployment -p 'test_*.py'`, `terraform -chdir=infra/terraform/envs/preprod test` (mocked). Then review the full services-phase plan: nine distinct identities, each service bound to its own, 29 secret-level grants (plus BFF retiring-key grant only during rotation), old shared account and its project-level secret/SQL/artifact grants removed. Review existing project/folder/org grants separately · Verify: active revisions use intended identities; web/marketing cannot read approval, MFA, service-role or evidence keys; positive path per service; repeat strict API/browser acceptance · Closure: identities, resource names, allowed/denied outcomes (no secret values). Rollback: redeploy the prior reviewed image on the new identity; never route to a retired revision depending on the old shared identity. Note: `sync-env.sh secrets` no longer creates IAM bindings (it cannot restore the retired shared account's access) and Cloud Run sync merges rather than replaces bindings; finish a key rotation with the reviewed full Terraform plan/apply, since secret sync does not remove retiring-key resources/grants.
- [ ] **P0-14 Decide the prod EKS public-access CIDR** (W0-9; `[16]`) · Operator · `infra/terraform/envs/prod` has `cluster_endpoint_public_access_cidrs = ["0.0.0.0/0"]` with a never-actioned "restrict via WAF / OIDC" comment · Verify: engineering applies the change and the Terraform gate re-validates · Closure: the CIDR list or a dated deferral. Required before any prod apply.

---

- [x] **P0-15 Provide the design system** · Operator · the claude.ai design file (`Axiom Proof App.dc.html`) needs a login; sign in in the in-app browser or export the file into the repo · Closure: file path or confirmation; Done 2026-10-01: the project link was shared and read through Claude in Chrome (project "Axiom Proof Design System": App, Site, Design System, Handoff Map); the repo already holds exported copies. Unblocked the header, related-agents strip and placeholder-state pass (P1-DS1).
- [x] **P0-16 Clean the popped stash from the approval-reconciliation worktree** · Done 2026-10-03 with no loss: the worktree's 5 modified and 15 untracked files (the pre-0098/0099 DPB remnants, verified superseded by what is on main) were backed up with a full ref bundle in `~/axiom-proof-housekeeping-backup-20261003/` (diff patch, untracked tar, the four stash patches), then the worktree was removed and its branch `codex/revision124-approval-proof-archive` deleted locally and on origin (its tip was already in main). The four stash entries were deliberately **kept**: two are Codex's own unfinished work (`codex/w0-w3-closure` harness and MFA parity) and the other two are the DPB and Pramaan pre-integration snapshots; `git stash list` still shows them and each has a patch in the backup. Drop them only when a human has confirmed they are not wanted.

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
- [ ] **P1-W8d Confirm the PDF renderer 503 / ECONNRESET** · Engineering · the first board PDF build in the W8 browser job fails intermittently (`report_renderer_unavailable` twice, `ECONNRESET` through the Next proxy at `board-reports-provider.spec.ts:537` four times); it passes on re-run. **Evidence from CI (2026-10-01, PR #136):** every render's first browser attempt is killed on timeout and the second succeeds, so each PDF costs a full timeout (the warm-up takes ~121 s). It happens whichever headless mode runs first (`--headless=new` originally, `--headless` after the order swap) and also after the renderer started waiting on the browser's `exit` event instead of its pipes, so neither the mode nor lingering helper processes explains it. The killed attempt's stderr is Chrome's Google-services registration noise (`Registration Failed: wrong_secret`, `DEPRECATED_ENDPOINT`), which points to first-launch work on a fresh `--user-data-dir`. Not reproducible on macOS. **Next experiments (need a Linux runner):** reuse one primed, serialised profile per process; add first-run-suppressing flags; run the same command by hand in the CI image and time it. Merged hardening: `388ae65` (classic `--headless` first, fallback reason logged, exit-based runner). · Closure: a render completes in seconds on CI (warm-up well under 30 s, no "classic --headless failed" warnings) and the journey stops flaking.
- [ ] **P1-DS1 Design-system pass on the remaining screens** · Engineering · the shared `ModuleBar` line (breadcrumb, Hindi name, phase, module id), `RelatedAgents` strip and `DataPlaceholder` ("Data yet to be populated", never sample values) exist in `@axiom/ui`; the registry `apps/web/src/lib/module-meta.ts` mirrors the design's `navDef`/`genericMeta` for all 21 routes. Applied so far to dashboard, approval, evidence, ledger, assessment and workbench. Remaining: the other 15 module routes (use `<ModuleBarFor module="…" />` or `PageHeader`'s `module` prop) and swap bare "no data" messages for `DataPlaceholder` where the visible sentence is not asserted by a test. Workbench and ledger heroes already print the Hindi name, so it shows twice there; remove the older instance when those heroes are next touched · Closure: every route in `MODULES` renders the context line; web tests green.
- [x] **P1-DS2 Run /design-sync** · Done 2026-10-03: the `@axiom/ui` library was converted (28 components, render check 28/28 clean, 28 previews graded good, conventions header validated) and uploaded to the new design-system project **Axiom Proof UI Library**, `https://claude.ai/design/p/9551f704-acf3-4897-bcf9-958d3668ff1b` (`projectId` is pinned in `.design-sync/config.json`). **Re-sync after any change to `packages/ui` or the preview files:** `pnpm --filter @axiom/ui build`, stage the converter per `.design-sync/NOTES.md`, run the `/design-sync` skill (needs `/design-login` once in an interactive terminal), regrade changed cells, upload. Read `.design-sync/NOTES.md` first (gotchas and re-sync risks).
- [x] **P1-DS3 Visual review of the restored status colours** · Accepted by the operator 2026-10-03 on the earlier review of the finalised surfaces. The brand preset had no red, green, amber, emerald, yellow, orange, blue or rose, so error alerts, warning boxes and success badges rendered with no colour; the families were added (Tailwind defaults) and warnings moved from gold to amber. Any brand-specific shade can still be tuned in `packages/design-tokens/src/tailwind.ts`; `palette-coverage.test.ts` guards the families.
- [x] **P1-DS4 Mirror Samadhan and Pramaan into the claude.ai design page** · Done 2026-10-03 through Claude Design's chat on the "Axiom Proof Design System" project (page `Axiom Proof Design System.dc.html`, section 05): both cards were added in the existing format, the placeholder count set to 12, nothing else changed, and the result was checked on screen. The repo copy `design-system/Axiom Proof Design System.dc.html` matches.
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
- [ ] **P2-15 Cleanup leftovers** · Operator · Done 2026-10-03: (a) Dependabot PRs #130-#134 merged; (c) the three leftover codex worktree directories (`750f`, `human-proof-writers`, `statutory-source-bound`, 15 GB) were deleted after archiving their small non-regenerable evidence files (about 8,000 JSON/log files) to `~/axiom-proof-housekeeping-backup-20261003/`; (d) the main checkout was fast-forwarded. **Still open on purpose:** (b) the worktree `.claude/worktrees/axiom-proof-phase-gap-closure-b88105` and its local-only branch `claude/axiom-proof-phase-gap-closure-b88105` were kept until that session is reinvoked; its tip is already in main and its 8 uncommitted files are Prettier-only (backed up). Delete the branch and worktree when that session is finished · Closure: `git worktree list` shows no `axiom-proof-phase-gap-closure` entry.
- [x] **P2-16 `turbo` writes to `AGENTS.md`** · Done 2026-10-03: `"agentGuidance": false` in the root `turbo.json`; verified that `turbo run lint` no longer touches `AGENTS.md`. If a block is ever present in the working tree it is the old managed block and should not be committed.
- [ ] **P2-17 Review the expiring audit allowlist** · Operator/Engineering · a new advisory (`GHSA-vfj7-8cjw-p6xm`, `braces <=3.0.3`, denial of service through deeply nested brace patterns, high) appeared on 2026-10-03 with **no patched release** (3.0.3 is the latest). It is reached only through `tailwindcss`'s build-time glob handling with our own patterns. pnpm 9.12 has no audit ignore option, so `scripts/audit_prod.py` runs the same `pnpm audit --prod --audit-level=high` and allows only the entries in `security/audit-allowlist.json` (each needs a reason and an expiry; an expired entry fails again), plus `.trivyignore` with the same expiry. **Decision 2026-10-03: option A** (keep the allowlist until a fix ships; rejected: Tailwind 4 migration, about 1-2 days of design-system work for a build-time-only advisory, and swapping `micromatch`/`braces` for an unvetted package). The exception expires **2026-11-02**: check `npm view braces version`; when a fixed release exists, upgrade and delete both entries; if none exists, re-review and renew with a new reason. Never allowlist an advisory that has a patched version · Closure: both entries removed, or renewed with a recorded reason.

## 7. Engineering blockers that gate operator steps (not operator tasks)

Listed so the operator knows why a gate stays shut (`21_Progress.md` section 2):

- Migration **0099** (ledger source + execution gate) is an untested draft and a production blocker; deployment must not apply it until tested.
- Statutory dossier migrations **0091-0097** and **0098** are local only.
- W8.5 archive branch `codex/revision124-approval-proof-archive` (`d617c2a`) is local only; its 14-journey real-provider run is not green.
- Local teardown script vs section 1 rule 1 (`20_Plan.md` D12).
