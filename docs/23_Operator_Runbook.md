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

**Start here, 2026-10-05:** the recorded overall goal is paused; the goal record
does not contain a reason. It is **not an operator-testing-only wait**.
Unfinished engineering remains in section 7. Existing local RC.3 can be reviewed
now; the newer staging workflow and human-review candidate must first complete
their engineering/release gates. Use [section 2b](#2b-step-by-step-operator-configuration-validation-and-confirmation) for the ordered procedures,
expected results and confirmations. Documentation work does not constitute
permission to deploy, enable cloud APIs, rotate credentials or stop a service.

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
  owner) can shorten or delete it; a test object locked for 2555 days cannot be deleted early. Never set
  retention on a bucket you experiment with. Local experiments must finish
  before selecting permanent retention; the current preprod deploy script
  requires a real Compliance probe before every phase (section 2b step 5).
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
7. Local release candidate `v0.1.0-rc.3` is pinned to exact-green main `71323456a952953bae010619d545116ec11df112` (2026-10-05); RC.1/RC.2 remain unchanged. App is `http://localhost:3001`, marketing `http://localhost:3000`, BFF health `http://localhost:4000/health`; selected Auth is 60321 with all 105 checksums through 0104. Six exact-source images, 12 actual owner/viewer browser checks and 44 responsive checks passed, preserving identities and memberships. Protected backup and artifacts remain ignored. Generic lifecycle, safe public form details and layout fixes are included; 0105/0106 source-agent execution is staged separately and is not yet deployed here. Named-admin browser login, remote clearance and private execution remain unproven.

## 1a. Command line: CI, build, deploy, soft stop and start

One entry point, `scripts/axiom-ops.sh`, drives all of it. Every value comes from `.env.<env>` (root symlink or `infra/docker/environments/.env.<env>`; root wins, and a warning is printed if both exist and differ); nothing is hard-coded. The environments are `local`, `staging` and `preprod` (all commands); `onprem` and `production` accept `stop`, `start`, `status` and `env-check` only (this tool never builds or deploys them); `--env all` (stop, start, status) walks the non-production environments that have an env file (preprod, staging, local, onprem, in that order, skipping the rest) and **never includes production**.

**One-time setup per environment**

```bash
cp -n infra/docker/environments/.env.preprod.example infra/docker/environments/.env.preprod
ln -s infra/docker/environments/.env.preprod .env.preprod   # only if the root link is missing
# an existing file from before: scripts/sync-env.sh preprod scaffold  (appends only missing keys)
scripts/axiom-ops.sh env-check --env preprod
```

`.env.local`, `.env.staging`, `.env.preprod`, `.env.production` and `infra/docker/environments/.env.*` are all gitignored; only the `.env*.example` templates are tracked (the root ones are symlinks into `infra/docker/environments/`), and a test fails if that ever changes. The tool parses the file (it never sources it), so a `$(...)` in a value cannot run. A value already set in your shell wins for that run (`GCP_REGION=... scripts/axiom-ops.sh ...`). A file whose `ENVIRONMENT=` disagrees with its name is refused. Placeholders such as `<your-project>` count as missing.

| Command                                   | What it does                                                                                                                                                                                                                               | Cost / risk                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `axiom-ops.sh env-check --env E`          | Finds the file, reports required keys present or missing (names only), runs the config audit for preprod.                                                                                                                                  | none                                                                                           |
| `axiom-ops.sh ci [--env E]`               | The CI gates locally: config audit, frozen install, format, lint, typecheck, unit tests, script tests, control-count and tfvars gates, Python service tests, the security scan. Flags `--skip-security --skip-python --skip-config`.       | none (local)                                                                                   |
| `axiom-ops.sh build --env preprod --yes`  | Builds the nine images from the exact HEAD SHA and **pushes** them to Artifact Registry. Needs a clean tree.                                                                                                                               | registry storage; asks first                                                                   |
| `axiom-ops.sh deploy --env preprod --yes` | Runs `deploy-preprod-gcp.sh` at the exact HEAD SHA with your env file. For plan-only review select a phase explicitly; default prep can enable APIs (section 2b step 6). Pass phases through: `-- --from-phase services`, `-- --phase db`. | **billing starts** (Cloud SQL, Cloud Run, storage and other provisioned resources); asks first |
| `axiom-ops.sh stop --env preprod --yes`   | Soft stop, see below.                                                                                                                                                                                                                      | cuts idle cost; deletes nothing                                                                |
| `axiom-ops.sh start --env preprod --yes`  | Puts everything back exactly as it was.                                                                                                                                                                                                    | restores the cost                                                                              |
| `axiom-ops.sh status --env preprod`       | What is running and what still costs money.                                                                                                                                                                                                | none                                                                                           |

Mutating commands accept `--dry-run`; cloud stop/start preview their calls, while deploy requires the phase-specific precautions in section 2b step 6 and asks for confirmation unless `--yes` is given; without a terminal it refuses rather than guess. For `local` and `staging`, `build`/`deploy` run `dev-docker.sh` (`--build` for build), `stop` is `dev-docker.sh --down` and `status` is `--status`; local stop keeps containers and data (see section 1).

**Soft stop covers every environment, production deliberately last and most guarded.**

| Environment                  | Mechanism                                                                                                                           | Notes                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `local`, `staging`, `onprem` | `dev-docker.sh --down`: containers and data stay in place; `start` brings them back                                                 | on-prem is Docker here; it is treated like production for warmth (nothing scales to zero) but stopping it is allowed |
| `preprod` (GCP)              | `scripts/softstop-gcp.py`: Cloud Run minimum instances, labelled VMs, Cloud SQL                                                     | scales to zero by default (D1); `--env all` includes it                                                              |
| `production` (AWS EKS)       | `scripts/softstop-aws.py`: deployments to 0 replicas (previous count in an annotation), node groups to 0 (previous sizing in a tag) | needs `--confirm-production <cluster>` to stop; never in `--env all`; never run by any workflow                      |

`stop --env all --yes` does the non-production set. Production is only ever addressed by name: preview with `scripts/axiom-ops.sh stop --env production --dry-run`, stop with `--yes --confirm-production <cluster name>` (typed exactly, every time, a bare `--yes` is refused), restore with `start --env production --yes`. **A production stop is a customer outage**; it saves cost only for planned windows. It cannot pause the EKS control plane, NAT gateways, ElastiCache, EBS volumes, the S3 evidence bucket and its KMS keys, or the managed Supabase project and Temporal Cloud (pause those in their own consoles if wanted). Stop order is deployments then node groups; start restores node groups, waits until ACTIVE, then deployments. The `production` env file needs `AXIOM_CLUSTER_NAME` and `AWS_REGION` (optionally `AXIOM_K8S_NAMESPACE`, default `axiom-proof`).

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
4. **Not proven on a real project.** Only `terraform validate`, `fmt` and the mocked tests ran. The phase-specific services plan in section 2b step 6 is the live plan check; read the plan for the services with a network interface (bff, agent-runtime, temporal-worker, supabase auth, supabase rest), the new `run-egress` subnet, the private `run.app` DNS zone and the per-caller invoker bindings.

## 2. Checklist index by workstream

| Workstream                     | P0         | P1           | P2          |
| ------------------------------ | ---------- | ------------ | ----------- |
| W0 / Release                   | P0-1…P0-14 | P1-R1…P1-R6  | P2-1        |
| W1                             |            | P1-W1a…W1d   | P2-18       |
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

Work top to bottom. Tier A costs nothing and unblocks engineering. Tier C contains billable provisioning and publication; the permanent evidence prerequisite may require separately approved earlier spend (section 2b step 5), so it starts only on your explicit go-ahead (nothing billable or irreversible is done without it). Items already done are in the changelog at the end of this section.

**Tier A — decisions and housekeeping (now, no cost)**

1. **P0-1** Decide the target: project, region, billing account, topology. Everything deployed waits on this.
2. Answer the small policy questions engineering is waiting on: **P1-W2a** (legacy assignment), **P1-W3a/b** (estate taxonomy, system kinds), **P2-10** (BR-4 gap-scan exception), **P2-11** (mock-data line), **P0-14** (prod EKS CIDR), **P2-8** (sector pack order), **P2-5** (`saml2_bearer`).
3. **P2-17** decided 2026-10-03: keep the expiring allowlist until a fixed `braces` release ships, then delete the entry (no migration to Tailwind 4, no package swap). Put a reminder for **2026-11-02**; the exception expires then and the security scan fails again by design.
4. **P2-15 (b)** only 4 branches remain on purpose: `main`, `staging`, `chore/housekeeping-2026-10-03` (this session) and local-only `claude/axiom-proof-phase-gap-closure-b88105` (the earlier session's branch, fully merged, kept until that session is reinvoked; delete it then). Three extra detached worktrees (`dazzling-torvalds-37bc2e`, `phase-0-5-gap-closure-5fd349`, `.kilo/.../attractive-sandwich`) hold uncommitted regenerated files and a few real edits; their diffs are backed up in `~/axiom-proof-housekeeping-backup-20261003/extra-worktrees/`. Remove them when you are sure nothing in them is wanted.

**Decisions taken 2026-10-03 (all implemented in code, none applied to a real project yet)**

- **D1 Warm only where it matters.** Production and on-prem keep always-on services warm (Helm `replicaCount` and `minReplicas` are at least 1 for web, BFF, agent runtime and gateway; a test enforces this; production uses a managed Supabase project, so GoTrue and PostgREST there are the vendor's). Non-production does not: preprod services scale to zero (`AXIOM_RUN_MIN_INSTANCES=0`, range 0-2; startup CPU boost on). Expect the first request after idle to take seconds; set `1` if a demo needs it.
- **D2 Nightly soft stop: on offer, opt-in.** `.github/workflows/preprod-nightly-stop.yml` stops preprod at 22:00 IST (cron `30 16 * * *` UTC) only if the repository variable `NIGHTLY_STOP_ENABLED` is `true`. It can only stop (never deploy, build or start) and deletes nothing. It needs the `preprod-nightly` environment (same secret and variables as `preprod-ops`, no required reviewer). Change the time by editing the cron; skip a night by setting the variable to `false`. Restart with the manual workflow or `axiom-ops.sh start --env preprod`.
- **D3 Internal services are internal by design.** agent-runtime and model-gateway use internal ingress, per-caller IAM invokers, Google ID tokens (`X-Serverless-Authorization`) and a private `run.app` DNS route; the shared token header stays as a second check (`AXIOM_INTERNAL_SERVICES_PRIVATE=true`). **First-deploy check:** one BFF to agent-runtime call and one agent-runtime to model-gateway call must succeed. If routing misbehaves set it to `false` and redeploy to restore the earlier public-plus-token endpoints.
- **D4 No edge protection in non-production; optional in production.** `AXIOM_ENABLE_EDGE_PROTECTION` (production env file, default `false`) creates an AWS WAF web ACL only when `true`. It protects nothing until the edge is an ALB or CloudFront (production ingress is nginx behind an NLB today): that production design choice is still open.

**Tier B — prepare the target (still no billing)**

5. Create the GitHub environment `preprod-ops`, its secret and variables (section 1a, manual workflow) if you want to run operations from GitHub. Use the commands in section 1a for everything below: `scripts/axiom-ops.sh env-check --env preprod`, then `ci --env preprod`. **P0-2** scaffold and mint config, **P0-3** dry-run review, **P0-12** backup and rollback plan, **P0-10** fresh secrets (this is also where the secret-rotation practice in **P0-9** applies), **P1-R3** configure the acceptance workflow and GitHub environments.

**Tier C — provision and prove (billing starts; explicit go-ahead)**

6. Follow section 2b steps 5–7: approved evidence/backup prerequisites, phase-specific plans that omit prep, separately approved exact-SHA image publication, full services-plan review, then explicitly approved deployment. Do not use a default dry-run as a cloud read-only check. **P0-4 → P0-5 → P0-6 → P0-7 → P0-8**, then **P0-11** (residency, IAM, Object Lock) and **P0-13** (service IAM isolation), then **P1-R1/R2** (clearance matrix, deploy at an exact SHA).

**Tier D — verify each workstream on the deployed environment**

7. W1 (**P1-W1a-d**), W2 (**P1-W2b**), W3 (**P1-W3c/d**), W4 (**P1-W4a-m**), **P1-W5**, **P1-W6**, W8 (**P1-W8b** opt-ins, the gap-scan durability probe, **P1-W8a** retained-object readback; its permanent probe is a preprod prerequisite), **P1-W9** (live NFRs), **P1-W10** (air-gapped acceptance), then **P1-R4/R5/R6** (W8 journeys on preprod, production release, failure handling).

**Tier E — founder and commercial (run in parallel, any time)**

8. **P2-12** incorporation and commercial setup, **P2-13** phase-exit evidence, **P2-14** gated Phase 5 items, **P2-6/P2-7/P2-9** (vendor descriptors, lineage model, provider equivalence).

**Engineering-owned:** combined human-review integration/real acceptance, RoPA/policy/delivery workflows and broader agent composition; P1-DS1 final release-wide design acceptance, P1-W8d repeated first-PDF validation, P1-W9b/P1-0099b fixture/writer readiness, and P2-3/P2-4. Operator configuration or manual feedback does not replace this work. See section 7.

**Open and unproven:** remote cloud/production acceptance, live W9 numbers and W10 offline acceptance. Local RC.3 is deployed and healthy. The renderer path correction has passing CI warm-ups, but P1-W8d stays open until repeated exact-revision first-PDF runs are verified. Animated agent states require an interactive journey, not still screenshots.

**Cost saving between sessions (non-production):** preview the named target, then stop/start only after explicit authorization (section 2b step 12). Nothing is deleted by soft stop; storage and other listed costs continue.

**Changelog of operator items closed on 2026-10-03:** P0-9 reclassified informative (rotation is a provisioning practice, not a blocker), P0-16 (stash and worktree cleanup, no loss), P1-DS2 (design library uploaded), P1-DS3 (status colours accepted), P1-DS4 (agents mirrored into claude.ai), P2-15 (a, c, d), P2-16 (turbo opt-out).

## 2b. Step-by-step operator configuration, validation and confirmation

Follow the readiness column before running a procedure. An unchecked item is
an open acceptance obligation, not necessarily something the operator can fix.
Engineering must supply a tested release and evidence before requesting its
review. All commands below run from the **selected release checkout**, not an
unfinished feature branch. Placeholders identify inputs to supply; they are
not executable defaults.

| Step | Activity                                                              | Owner                                         | When to act                                                            |
| ---- | --------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| 1    | Review current local RC.3                                             | Operator                                      | Now; optional feedback, not a prerequisite for independent engineering |
| 2    | Record target, scope and business decisions                           | Operator                                      | Now, if remote preparation is wanted                                   |
| 3    | Prepare and audit private configuration                               | Operator                                      | After the target is identified; no live key rotation                   |
| 4    | Confirm exact release and engineering clearance                       | Engineering prepares; Operator reviews        | Before deploying or testing a new candidate                            |
| 5    | Confirm evidence-storage prerequisite and recoverable backup          | Operator                                      | Before any preprod deployment phase or database change                 |
| 6    | Review infrastructure plans                                           | Operator                                      | After configuration, backend and evidence prerequisites; no apply      |
| 7    | Authorize and execute the deployment                                  | Operator                                      | Explicit target/SHA/plan/spend approval required                       |
| 8    | Check deployed identity, health and private routing                   | Engineering + Operator                        | After deployment; before feature acceptance                            |
| 9    | Perform persona and public-source journeys                            | Engineering proves first; Operator reviews    | Only when the selected release contains each feature                   |
| 10   | Configure isolated remote acceptance and compare results              | Operator configures; Engineering runs/repairs | Approved synthetic target and fixture tunnel required                  |
| 11   | Verify retained proof, recovery, performance and offline requirements | Engineering + Operator                        | Approved target-specific acceptance windows required                   |
| 12   | Record sign-off and operate between sessions                          | Operator                                      | After applicable acceptance evidence; no implicit production stop      |

### Step 1 — review the working local application

**Purpose and reason:** review the user-visible behavior of the release actually
running. A staging merge or worker test result does not mean port 3001 contains
that code. Current verified local release is `v0.1.0-rc.3`, main
`71323456a952953bae010619d545116ec11df112`; the newer operator workflow is on
green staging `a3c845f512ec2b56278abf27cc2a31bbced39cbe`. Human structural review
is still a candidate awaiting combined validation.

1. Open `http://localhost:3001/api/health`. Confirm `status=ok`,
   `authMode=strict` and the exact RC.3 revision above. If the revision differs,
   ask Engineering to identify the deployed release before reviewing it.
2. Use your own known account at `/login`; sign in through the normal form,
   select the intended tenant and use that account's authenticator when asked.
   Do not use another persona's TOTP. Named-admin role records exist, but
   current-image sign-in using those credentials has not been proved. If you
   cannot access the account, report the step/error; do not reset an existing
   factor or password to unblock a test.
3. Visit Dashboard, Estate/Setup, Assessment, Connectors, Discovery,
   Classification, Plans, Approval, Execution, Evidence, DSARs, Consent,
   Breaches, Monitoring, Regulatory Watch, Reports/Pramaan, Portal, Policies,
   Settings/Members and Settings/Security as permitted for that role. Check
   consistent headers, content width/margins, readable notices below the
   header, usable actions and keyboard focus. Repeat a representative journey
   at desktop and a narrow mobile width; use a separate browser profile for
   each persona.
4. In Connectors use the public website check for `https://axiomminds.ai`.
   Review saved page/form details and reload the saved result. This release's
   public check does not establish private-system access, storage location,
   consent processing, a completed assessment or every agent's execution.
5. Optionally submit a synthetic contact inquiry at
   `http://localhost:3000/contact`. Local email delivery being disabled is
   accepted; verify the saved-inquiry result rather than expecting an inbox
   message. Mailpit remains a wishlist item.

**Expected output:** a populated page after sign-in without a manual refresh,
role-appropriate actions, persistent saved results and explicit unknown/private
facts. A private connector can correctly report execution unavailable while the
public website check works. Any missing action, blank page or lost result is a
defect to report, not a reason to waive acceptance.

**Confirmation to return:** release SHA, role, tenant alias, route, viewport,
steps and pass/fail; include a saved result ID or sanitized error code. Do not
send passwords, TOTP secrets, recovery codes, cookies or invitation URLs.

### Step 2 — record target, scope and pending decisions

**Purpose and reason:** establish where and on whose authority a test will run.
Saving a connector descriptor cannot provide missing network access or a grant.
Business decisions must not be inferred from public HTML or telemetry.

1. For P0-1 record environment, project/account identifier, provider, region,
   topology, public URLs, secret-store resource names, billing owner and
   rollback owner. Confirm self-hosted Supabase and the intended database;
   do not substitute a managed service by assumption.
2. For P1-W2a state whether unassigned legacy engagements stay unassigned or
   receive individually reviewed estate assignments. Keep existing null
   historical scope intact until an explicit assignment is recorded.
3. For private connector acceptance name one synthetic target, authorized
   read scope, network route, credential broker, workload identity and expiry.
   Do not transmit credentials or use a production write grant for discovery.
4. For production record the EKS public-access CIDRs (P0-14), edge/ingress
   design and any WAF decision. A WAF flag alone does not protect an NLB.
   Resolve provider/retention equivalence under P2-9: the preprod scripts use
   GCP `asia-south1`, while evidence requires AWS `ap-south-1`. This does not
   waive AGENTS.md residency rules or authorize client-data movement.

**Expected output:** an identified target and explicit decisions, with no
secret values or invented processing facts. Unresolved production decisions
leave that deployment gate open; independent local engineering can continue.

**Confirmation to return:** item IDs, decision, scope, decision-maker and date.
Mark an unanswered decision pending; do not treat silence as approval.

### Step 3 — prepare private environment configuration

**Purpose and reason:** use one consistent configuration for auth, database,
service identities and evidence. Mixed JWT mintings or changed MFA encryption
keys can make sign-in succeed while protected API calls fail.

1. Select the correct ignored `.env.<environment>` file. If it does not exist,
   copy that environment's tracked example without overwriting an existing
   file. Keep it private and edit locally. Resolve differing root and
   `infra/docker/environments/` copies; `axiom-ops.sh` prefers the root file.
2. For an existing preprod file append missing template keys with
   `./scripts/sync-env.sh preprod scaffold`. Fill placeholders locally. Verify
   `ENVIRONMENT=preprod`, project, GCP region, Terraform backend bucket,
   pinned Auth/REST upstream images, strict auth, service-specific secret
   references, evidence probe and internal-routing settings.
3. For a **new, unused target only**, use
   `./scripts/sync-env.sh preprod mint` to mint matching auth secrets and keys.
   For an existing target retain deployed keys and follow the reviewed
   rotation procedure; do not remint to repair a configuration audit. Never
   reset existing persona factors or replace their key ring ad hoc.
4. Run `./scripts/axiom-ops.sh env-check --env preprod`, then
   `./scripts/sync-env.sh preprod verify`. Select an explicit
   `AXIOM_ENV_FILE` when needed to make both commands read the same file.
   Keep invitation/report/contact email delivery disabled for acceptance.

**Expected output:** exit zero, required key names reported present, no
placeholders/configuration refusals and `environment 'preprod' is ready` from
env-check. These are configuration checks, not proof of reachability or IAM.

**Confirmation to return:** environment, config audit outcome and missing key
names only. Keep the actual file, minted output and secret values private.

### Step 4 — verify the exact candidate's engineering clearance

**Purpose and reason:** ensure the reviewed code, deployed images and evidence
refer to the same immutable revision. Operator testing must not replace unit,
security, mutation, database or automated end-to-end work.

1. Engineering supplies a clean committed candidate, requirement-to-evidence
   matrix, exact source/staging/main CI links, security outcomes, module
   coverage, full database results and known limitations (P1-R1).
2. Inspect `git status --short` and `git rev-parse HEAD` in the selected
   checkout. Verify CI on that exact SHA with
   `gh run list --repo vikashkaruna/Proof --commit <exact-sha>`; check each
   required job, rather than trusting an earlier branch run or aggregate PR
   badge. Source goes to staging and then main with merge commits.
3. Engineering runs `./scripts/axiom-ops.sh ci --env preprod` without skip
   flags, plus the database, per-module coverage, Temporal-worker and actual
   end-to-end gates required for the change. The CLI's `all gates passed`
   message covers its own commands only; it does not include every release
   requirement or remote acceptance.
4. Confirm which features the proposed deployment includes. Human-review API
   commit `ba394e78822d90210158a231b22add2aa80d7922` and Web commit
   `be809eb2713c6dfbf9f0bc05f494c393fb240d7e` are worker candidates, not a
   cleared combined release. Do not ask the operator to test them on RC.3.

**Expected output:** one exact release SHA, green applicable checks, evidence
for all changed requirements and explicit remaining blockers. Any failed,
flaky, unexecuted or unexplained skipped required check leaves clearance open.

**Confirmation to return:** the SHA and acceptance scope you have reviewed.
Release review alone does not authorize a cloud build or deployment.

### Step 5 — validate storage prerequisite and backup before changes

**Purpose and reason:** preserve existing identities, ledger and evidence.
Database migrations are append-only; an application rollback is not a reverse
migration, and Compliance retention cannot be shortened.

1. Inventory the selected database, applied migration names/checksums,
   identities/memberships, ledger chain, evidence bucket/version and unrelated
   local containers/volumes. At this checkpoint selected RC.3 has 105 applied
   migrations through 0104; the isolated 59621 fixture has 109 through 0108.
   Candidate 0109/0110 were tested on disposable databases, not applied here.
2. Take a fresh uniquely named protected backup. Verify its hash, size and
   readable archive inventory, then check the live state still matches the
   pre-backup snapshot. Record successful verification **before** running a
   migration; do not queue migration behind an unchecked backup command.

   For the identified selected local database only, a protected PostgreSQL
   backup can be taken as follows. Verify the container name first; execute
   each command separately and stop if it exits nonzero. A successful dump
   must precede the inventory/hash commands; none of these applies migrations.

   ```bash
   umask 077
   mkdir -p .axiom-runtime/operator-backups
   chmod 700 .axiom-runtime/operator-backups
   LOCAL_REVIEW_BACKUP="$PWD/.axiom-runtime/operator-backups/selected-$(date -u +%Y%m%dT%H%M%SZ).dump"
   (set -o noclobber; docker exec supabase_db_axiom-final-review pg_dump -U postgres -d postgres -Fc > "$LOCAL_REVIEW_BACKUP")
   docker exec -i supabase_db_axiom-final-review pg_restore --list < "$LOCAL_REVIEW_BACKUP"
   shasum -a 256 "$LOCAL_REVIEW_BACKUP"
   wc -c < "$LOCAL_REVIEW_BACKUP"
   ```

   Keep the inventory private. Compare retained migration checksums,
   identities/memberships and ledger/source snapshot before and after the
   backup; the dump's readable inventory alone does not prove preservation.
   For a remote target use its approved protected backup job rather than
   copying local container commands or exposing a database URL.

3. Confirm the approved database/application rollback route and restoration
   owner. A restore exercise uses an approved disposable target, never
   overwrites the retained local or production database to test recovery.
4. Before invoking **any preprod deployment phase, including dry-run**, an
   operator-approved AWS S3 `ap-south-1` Compliance bucket and retained
   synthetic probe version must already exist. The script unconditionally
   runs `verify-preprod-s3.py` before phase selection. Configure bucket,
   `axiom-compliance-probe/` key, exact version and scoped application access
   privately; expected readback verifies location, bucket default and that
   exact object's Compliance retention. Creating/locking this resource needs
   explicit approval of its cost and seven-year retention. Never lock an
   experimental bucket. Do not bypass this gate.

**Expected output:** verified backup identity and preservation snapshot,
documented rollback route, and successful live evidence readback for preprod.
An absent probe, checksum mismatch or backup failure stops the affected step.

**Confirmation to return:** backup ID/time/hash, verification summary,
rollback owner and approved bucket/probe version references. Never send the
backup contents, credentials or client data. The old instruction to enable
Object Lock last applies to disposable local experiments; it cannot describe
the current preprod script's prerequisite order.

### Step 6 — review plans without entering cloud setup

**Purpose and reason:** understand resource, IAM, network and cost changes
before approval. The default deployment's `prep` phase calls
`gcloud services enable` even with `--dry-run`; a bare default dry-run is not a
pure read-only cloud operation. This is an engineering follow-up, not an
operator mistake.

1. Use the approved pre-initialized Terraform backend and pre-enabled APIs.
   Meet steps 3–5 first. Do not run the default pipeline as a first plan-only
   check or bypass storage prerequisites to obtain a plan.
2. Plan individual phases with the verified CLI syntax:

   ```bash
   ./scripts/axiom-ops.sh deploy --env preprod --dry-run -- --phase base
   ./scripts/axiom-ops.sh deploy --env preprod --dry-run -- --phase db
   ```

3. Review the full services plan after the exact nine-image release manifest
   exists and registry readback is authorized:
   `./scripts/axiom-ops.sh deploy --env preprod --dry-run -- --phase services`.
   The manifest validator checks actual registry digests even in dry-run.
   First-time image publication is separately approved in step 7; a missing
   manifest is a prerequisite failure, not permission to silently build.
4. Check each plan summary and the full changes: Direct VPC egress subnet,
   service interfaces, private `run.app` DNS, caller-specific invokers,
   separate service identities/secret grants, database sizing and removals.
   Confirm no unexpected deletion, public ingress, shared credential grant or
   evidence-retention change. Keep saved plans private; they can contain
   secrets. Backend initialization/tfvars generation can write local files.

**Expected output:** reviewed plan summaries with expected resources and no
cloud apply/API enablement. If digest lookup fails, stop and resolve narrowly
scoped Artifact Registry/Container Analysis read permissions; do not drop
digest verification. A phase plan alone does not clear the full rollout.

**Confirmation to return:** exact SHA, phase, plan reference, add/change/delete
summary, unexpected changes and your approve/reject decision. Approval of a
plan is distinct from approval of billable execution.

### Step 7 — authorize the build and deployment explicitly

**Purpose and reason:** billable provisioning and service interruption require
a concrete reviewed target and release. The production topology is not built
or deployed by `axiom-ops.sh`.

1. Record approval of environment, project, exact main SHA, plan references,
   spend, migrations, evidence retention, rollback route and deployment
   window. Review any newly resolved first-deploy prerequisite separately.
2. From that clean checkout, publish preprod images only after approval:
   `./scripts/axiom-ops.sh build --env preprod --yes`. Require a valid manifest
   covering nine immutable image digests for the exact SHA.
3. Review the services plan from step 6. Deploy only after its clearance and
   explicit approval: `./scripts/axiom-ops.sh deploy --env preprod --yes`.
   Its default pipeline includes API setup, image work, services, migration
   and hosting phases; approved phase-specific execution can use
   `-- --phase <name>`. Do not seed identities on a production/client target.
4. Verify migration runner count, last name and **all prior checksums** against
   the candidate; never assume the historical 90-file baseline is current.
   Stop on any migration failure or changed-history refusal; never force it.

**Expected output:** validated release manifest, successful approved phases,
unchanged prior migration history and recorded provider revisions. The final
message `PREPROD INFRASTRUCTURE DEPLOYED; ACCEPTANCE STILL REQUIRED` is not
production sign-off.

**Confirmation to return:** approval reference, release SHA, image manifest
reference, migration summary, health endpoints and deployment time. For
production use P1-R5's verified target-specific mechanism; no preprod command
is a substitute for production topology review.

### Step 8 — validate deployed identity and service paths

**Purpose and reason:** healthy public endpoints do not establish tenant
isolation, least privilege or private service connectivity.

1. Verify the manifest and all nine Cloud Run service image digests using
   `scripts/preprod-release-manifest.py validate` and
   `scripts/verify-preprod-cloudrun.py` with their manifest/SHA/project inputs
   from the approved deployment; compare application health revisions.
2. Confirm BFF unauthenticated protected requests return 401, strict mode is
   active and normal sign-in reaches the named tenant. A login redirect or
   public health 200 cannot substitute for protected-API refusal.
3. Exercise one approved BFF → agent-runtime call and one agent-runtime →
   model-gateway call; capture successful application result and correlated
   logs/IDs. Confirm private DNS, per-caller ID-token acceptance and cold start
   at the configured minimum instances. Also prove an unauthorized caller
   cannot invoke the internal service.
4. Read back service identities and effective secret/IAM grants. Web and
   marketing must not access approval, MFA, service-role or evidence secrets.
   Record residency and routing evidence without secret values.

**Expected output:** exact revision/digest matrix, allowed and denied outcomes
for each path, worker connectivity and isolated service identities. A failure
leaves acceptance red. Any temporary public-plus-token fallback requires an
explicit recorded operator decision and is not private-routing acceptance.

**Confirmation to return:** endpoints, revisions, caller/target identities,
status/error codes and correlation IDs; no JWTs or raw provider log dump.

### Step 9 — execute role and operator journeys on the cleared release

**Purpose and reason:** prove that users can complete work and review its
retained output, rather than merely see a screen or a mocked agent response.
Engineering runs automated real-transport journeys before requesting manual
review. Rows marked pending below are not executable acceptance on RC.3.

| Area / purpose                                                | Steps on a release containing the feature                                                                                                                                                                                                                                                                                                                                                    | Expected validation and confirmation                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in, organization and MFA (W1/W3)                         | In separate sessions sign in as owner/reviewer/viewer; open Settings → Security; use that account's enrollment flow only when it has no active factor; complete a fresh step-up. Open Estate/Setup under an explicitly entitled account. Test replacement/recovery only with an approved disposable persona.                                                                                 | Populated dashboard without refresh; factor tied to the correct identity; permitted organization setup; existing-factor controls refuse invalid codes. Return role, revision, step outcomes/error codes. A prerequisites refusal requires entitlement/configuration investigation, not a bypass.                                                      |
| Invitation (W1)                                               | As authorized inviter create a synthetic invite in Settings → Members; privately copy its one-time link; in another browser profile sign up/sign in as the exact invited address; accept and reload. Test wrong-account and repeat acceptance separately.                                                                                                                                    | Correct membership and persistent accepted state; other identity refused; no duplicate membership. Return invitation record ID and outcomes, never its token URL. Remote email delivery is a separate provider/domain test; local disabled delivery is accepted.                                                                                      |
| Remote email delivery (W1/W8; separately enabled)             | After provider/domain approval, verify sending-domain SPF/DKIM in the provider console; provision RESEND_API_KEY to BFF only; enable the required invitation/contact/report delivery mode on the approved remote target. Submit a synthetic request to an operator-controlled inbox and accept an invitation under its exact identity. Keep local and ordinary acceptance delivery disabled. | Provider delivery ID, actual inbox arrival and correct application result; rejection/provider failure reported truthfully. Return sanitized delivery/acceptance outcomes and secret resource name, never key or token. No Mailpit requirement or local delivery promise is introduced.                                                                |
| Public observation (W2/W4; staged workflow)                   | Run the public check for axiomminds.ai; select the intended engagement and saved check; bind that exact source; run Drishti; select its retained observation as Vibhaag's input; inspect saved history, source digests and run/completion/settlement receipts; reload. Engineering injects response loss and reconciles the original key.                                                    | Both actual outputs retained, Vibhaag tied to the precise Drishti observation, private facts unknown, once-only execution after recovery, viewer readable and unable to invoke. Return check/binding/run/observation IDs and receipt references. The simpler RC.3 public check alone does not satisfy this row.                                       |
| Human structural review (W2; candidate)                       | After combined clearance, an authorized reviewer acknowledges/disputes a whole observation or an exact stored indicator with a reason; reload; append a correction to its current predecessor. Read as viewer. Engineering covers stale/digest/foreign/revoked refusals and lost-response recovery.                                                                                          | Exact raw reason retained; separate historical/current judgments; one human receipt per accepted decision; no fabricated private facts or automatic assessment completion. Unknown outcomes stay locked for original-key reconciliation; discard of a known refused request requires confirmed not_found. Return review/predecessor IDs and receipts. |
| RoPA, policy and delivery workflows (W2; engineering pending) | Do not request operator sign-off until capture/readback, source provenance, document review/reasons and task/time records are implemented and tested. Then exercise the complete scoped save/reload/review journey.                                                                                                                                                                          | Unknown processing facts remain explicit; immutable review history and real ranked delivery output. A placeholder Data Map, standing execution-policy list or incident playbook is not closure of these requirements.                                                                                                                                 |
| Private connector (W4/W5; transport pending)                  | Provision an approved synthetic endpoint, broker identity and read grant; run tenant-scoped connection/discovery checks and prove revocation. Use a write target only after dry-run, validated rollback and signed human approval exist.                                                                                                                                                     | Actual authorized target result plus health/receipt evidence; ungranted/expired access refused. Saved connection options or a public HTML fetch do not prove private transport or production execution.                                                                                                                                               |
| Every-agent real work                                         | Engineering supplies a requirement/agent input-output map and executes each supported agent through its actual composed path. Review outputs in the workspace: discovery/classification, findings/plan, approved execution/verification, regulatory/report/evidence and Pramaan/Samadhan proof as applicable.                                                                                | Stored input/output/provenance, relevant refusal evidence and reviewed artifacts per named agent. Sudhaar remains read-only; Karya cannot mutate without approved dry-run/rollback. Two successful public agents or Python-library tests do not establish all-agent completion.                                                                       |

**Confirmation to return:** accept/reject each tested row with release, role,
scope, retained IDs and a short reason. A screenshot alone does not prove
persistence, server authority or ledger provenance. Operator feedback does
not close pending engineering rows.

### Step 10 — configure and run isolated remote acceptance

**Purpose and reason:** compare the same strict-auth journeys on identified
deployments. The runner creates synthetic fixtures; it is not a read-only
health check and is not authorized against a customer dataset by this guide.

1. Choose an approved isolated non-production database and create protected
   `.axiom-runtime/preprod-target.json` from
   `docs/ACCEPTANCE_TARGET.example.json`. Fill deploymentId, environment,
   topology, expected exact revision, actual BFF/Web/marketing/Auth URLs and
   scoped keys privately. Use HTTPS for remote topology; set
   `syntheticFixtures=true`; protect the file with mode 0600.
2. For plan/action fixture tests open the operator-owned PostgreSQL tunnel
   bound to loopback. Create a separate private file containing exactly
   `schemaVersion`, `deploymentId`, `environment`, `expectedRevision` and
   `databaseUrl`; identities must match the target file. The database URL must
   use the tunnel, no query/fragment or public host. Set
   `AXIOM_ACCEPTANCE_FIXTURE_DB` to that file path. Keep credentials out of
   shell history and command arguments.
3. Run `./scripts/run-deployed-acceptance.sh .axiom-runtime/preprod-target.json`
   only after fixture-writing approval. Validate the reported deployment ID,
   revision, API and browser outcomes. Run the comparison target independently
   under its own authorization, then use section 5's parity comparisons.
4. Optionally configure `preprod-acceptance` and the comparison GitHub
   environment with private `AXIOM_ACCEPTANCE_TARGET_JSON`. For manual cloud
   operations configure `preprod-ops`, reviewer, `AXIOM_ENV_PREPROD` and the
   two GCP federation variables from section 1a. Keep nightly stop disabled
   unless explicitly opted in. Prove sign-in/status before actual mutation.

**Expected output:** terminal successful API/browser summaries for the exact
revision, with no failed/flaky/skipped required journeys and passing parity.
Use only allowlisted sanitized `api-results.json`/`browser-results.json` for
sharing; raw traces/logs/fixture state remain private. A production-profile
label or isolated comparison topology is not actual production acceptance.

**Confirmation to return:** target identity, exact revision, workflow/run URL,
sanitized summaries and comparison result. Keep tunnel credentials, private
target JSON and browser recordings out of chat and commits.

### Step 11 — verify proof, recovery, performance and offline behavior

**Purpose and reason:** these requirements need live provider/target evidence
that local tests cannot manufacture. Schedule the relevant windows once
Engineering provides the ready paths and synthetic datasets.

| Gate                               | How to validate                                                                                                                                                                                                                                                                                        | Expected output / confirmation                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W8 / Pramaan (W8.4/W11)            | Generate each supported source-bound dossier through the composed flow; review source authority, exact retained archive version, founder release and permitted dispatch. Retrieve that exact provider object version; exercise viewer/unreleased/stale-source refusals.                                | Real artifact, source/content hashes, version ID, retention readback, human release and dispatch receipts. Unsupported dossier types remain refused; a downloaded unretained PDF is insufficient. |
| Samadhan approval proof (W8.5/W12) | Compare the signed approval with database-derived maker/checker, approved action subset and dry-run/rollback/execution/verification chain; independently retrieve the access-controlled retained archive and test release/refusal paths.                                                               | Matching reconciliation statement and ledger chain, exact archive version/hash and authorization outcomes. Founder review alone does not replace reconciliation or provider retention evidence.   |
| Phase 3 execution (W5)             | On an approved synthetic write target execute all eight PRD §B.10 scenarios: rollback-complete plan, accurate dry-run diff, approval impossible before successful dry-run, partial subset only, successful rollback, independently reconstructable chain, blast-radius halt and in-flight kill switch. | Separate observed pass/fail for every scenario, scoped signed approval, actual target changes/rollback and receipt chain. No production write path is currently claimed cleared.                  |
| W9 throughput/reporting            | Measure the approved representative dataset and target: discovery target 1M records/hour/connector; standard report under 5 minutes. Record dataset size, cold/warm behavior, repetitions, versions and resources.                                                                                     | Actual measurements at the stated thresholds; mock responses and a successful CI PDF are insufficient. Keep first-PDF timing/failures, not just warm reruns.                                      |
| W9 recovery                        | Use a genuinely scheduled backup, restore DB and exact evidence bytes/versions into an approved isolated target; verify hashes, migrations, memberships and ledger chain. Measure backup age and full recovery duration.                                                                               | RPO ≤1 hour and RTO ≤4 hours with scheduler timestamps, restored-object integrity and retained proof. A fresh manual dump proves neither scheduled RPO nor full evidence recovery.                |
| W10 offline                        | On an identified in-perimeter target block external egress; verify normal Auth/PostgREST/DB, licence, local model path or explicit unavailability, WORM, install/upgrade/restore and persona journeys.                                                                                                 | Firewall/egress evidence and actual offline outcomes. Mock Terraform tests or an online local stack do not close this gate.                                                                       |

**Confirmation to return:** gate ID, tested target/revision, thresholds,
measurements, retained artifact/version references, reviewer and limitations.
Never mark a gate green from an unavailable production connector or provider.

### Step 12 — record sign-off, release and session operations

**Purpose and reason:** make acceptance auditable and prevent deployment or
service interruption from being inferred from a general review.

1. For each applicable requirement record pass/fail, release, target, role,
   artifact/result/receipt references, reviewer, timestamp and remaining gap
   in docs/21. Engineering updates matching docs/20 and checklist closures
   here. Keep rejected and superseded results; do not erase failures.
2. Approve or reject production separately under P1-R5 after its prerequisites
   and exact-target acceptance plan exist. Deploy the tested artifacts,
   verify revision/ledger before shifting traffic and run actual production
   acceptance with approved synthetic accounts. Preserve RC tags; reserve a
   stable release declaration for recorded clearance.
3. For session operations select a single named environment and preview
   `./scripts/axiom-ops.sh stop --env preprod --dry-run`. An actual stop/start
   needs explicit authorization. Production stop additionally requires the
   exact typed cluster via `--confirm-production`; it is a customer outage.
   Avoid `--env all` when unrelated local stacks must remain running.
4. Local teardown preserves database containers/volumes by default. Never
   use `docker compose down -v`, purge flags or volume deletion for this
   review. Do not reset personas or delete append-only evidence to clean up.

**Expected output:** an explicit release/target acceptance decision and
traceable checklist, or a documented rejection with Engineering's next repair.
App availability is checked independently of the goal's paused status.

**Confirmation format** (one row per activity; no secrets):

| Item / step | Target + release SHA                | Role / scope              | Action + result              | Expected result matched? | Evidence / receipt reference                  | Decision + reviewer + date                |
| ----------- | ----------------------------------- | ------------------------- | ---------------------------- | ------------------------ | --------------------------------------------- | ----------------------------------------- |
| `<item-id>` | `<environment, deployment-id, sha>` | `<role, synthetic scope>` | `<steps, status/error code>` | `<yes/no, reason>`       | `<sanitized artifact/run/object-version IDs>` | `<accepted/rejected/pending, name, date>` |

## 3. P0 — blockers

### W0 and release path

- [ ] **P0-1 Decide and record the target** (W0-1; `[16]`, `[18 §2]`) · Operator · project, region, billing account, topology; accepted direction is local Docker Supabase and self-hosted Supabase in higher environments (Cloud SQL may sit underneath; do not substitute managed Supabase); also existing deployment SHA, migration ledger, secrets source, DNS, rollback route · Verify: provider state and deployment records, not the doc-08 AWS examples · Closure: project id, region, topology (no credentials).
- [ ] **P0-2 Scaffold and mint configuration** (W0-2) · Operator · none · `./scripts/sync-env.sh preprod scaffold` (appends only missing keys); for a new unused target only, `./scripts/sync-env.sh preprod mint` creates a matching key set. Existing targets retain deployed keys and follow reviewed rotation · Verify: `./scripts/sync-env.sh preprod verify`; see section 2b step 3 · Closure: `verify` output (presence/shape only).
- [ ] **P0-3 Pre-flight plan** (W0-3) · Operator · none · section 2b steps 5–6: verify evidence/backend prerequisites, then `./scripts/axiom-ops.sh deploy --env preprod --dry-run -- --phase base` and db/services plans as applicable. Default prep can enable APIs even with dry-run; never use it as read-only approval evidence · Closure: plan summary line (`Plan: N to add, ...`) and any unexpected resource.
- [ ] **P0-4 Provision base and database** (W0-4; **billing starts**) · Operator · approved plan · `./scripts/axiom-ops.sh deploy --env preprod --yes -- --phase base` (VPC, Direct VPC egress subnet, peering, Artifact Registry, IAM; permanent evidence remains the separately approved S3 prerequisite) then the same approved entrypoint with `-- --phase db` (Cloud SQL, Secret Manager) · Closure: Cloud SQL instance name and Secret Manager _resource names_ (never values).
- [ ] **P0-5 Run the migration series on the real database** (W0-5) · Operator · DB URL via secret store · `./scripts/axiom-ops.sh deploy --env preprod --yes -- --phase migrate` or `./scripts/migrate-cloudsql.sh --skip-seeds` with SUPABASE_DB_URL privately injected from the approved secret store (enforces TLS, records checksums, refuses edited history, non-zero on failure). Historical 42/90-file counts are not the expected current deployment count; derive the manifest from the exact approved release and compare every prior checksum (section 2b steps 5 and 7) · Verify: runner summary count and last migration name · Closure: summary; on a checksum refusal send the line verbatim and stop (never force).
- [ ] **P0-6 Seed representative identities** (W0-6) · Operator · none · `./scripts/axiom-ops.sh deploy --env preprod --yes -- --phase migrate --seed-identities` on an approved isolated synthetic target only; multiple tenants and personas, **never client production data** · Closure: tenant count and persona roles (no emails/passwords).
- [ ] **P0-7 Deploy services and verify** (W0-7) · Operator · none · use the approved axiom-ops deploy entrypoint with `-- --phase services`, then `-- --phase verify`. Review the **full services-phase plan**, not just base/db · Closure: health matrix and public URLs of web app and BFF.
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
- [ ] **P1-W1d Invitation rollout** (`[16 Rev78]`) · Operator · apply 0053; `AXIOM_INVITATION_EMAIL_MODE` stays disabled until W1b evidence (then inviter shares a one-time link). Local email-free check: create the invitation in Settings → Members, use Copy link, open a separate private browser session, sign up or sign in with the exact invited address, then accept. Candidate `5f52d5c` passed that path in Chromium; `fe6a238` retains an accepted state across same-tab remounts and falls back to full dashboard navigation if the client transition stalls, with four focused local invitation/MFA browser journeys green. The operator’s original failure step and remote rollout remain open. · Closure: deployed invite/accept observed.
- [ ] **P1-W1e Fresh signup session** · Engineering/Operator · candidate `cc75f05` restricts the server's session-cookie selection to `sb-…-auth-token` and its numbered chunks; signup flow verifier cookies must never be selected as a session. Verify a fresh account stays signed in on `/onboarding`, its own profile is present without tenant authority, and an explicitly entitled test account reaches a new organization dashboard. Local production-build browser acceptance passed on port 3002; close after exact source/staging/main CI and deployed browser acceptance.
- [ ] **P1-W1f Recovery-session browser gate** · Engineering/Operator · PR #155 source CI 37128305098 passed W1, but exact staging `c88b1ff` CI 37129527005 failed the same journey after MFA verification returned HTTP 200 and the client remained on `/verify`; one retry also hit `net::ERR_ABORTED` opening security after sign-in. Candidate `03ea2c5` navigates with a fresh document after verification and retries that aborted security load. Local two-worker MFA browser passes 18/18. Close only after exact hotfix source/staging/main CI and deployed two-session recovery acceptance.
- [ ] **P1-W1g Owner authenticator discovery and cold sign-in** · Engineering/Operator · candidate `03ea2c5` retries only the specific future-issued-JWT membership refusal in the tenant resolver and fails closed on other Auth/membership errors; `8758822` exposes personal authenticator management from Settings and the verification prompt. Local owner on port 3002 opened security, used its seeded active factor, reached a populated dashboard after TOTP verification, and stayed there after refresh. Close after exact source/staging/main gates and a rebuilt main-image owner sign-in; a real authenticator on a deployed environment remains P1-W1c.

### W2 Data model

- [ ] **P1-W2a Legacy assignment policy** (W2-1) · Operator · decide: assign existing unassigned engagements to an estate by hand, or leave unassigned until reviewed (never infer scope) · Closure: the policy.
- [ ] **P1-W2b Apply each migration batch to the deployed DB** (W2-2) · Operator · order is commit, then apply, never the reverse · Verify: same command as P0-5; also apply 0033 (creates seven empty connector tables; do not insert real credentials) · Closure: applied count and last migration name per batch.
- [ ] **P1-W2c Operator workflow integration** · Engineering · Migration 0076 already delivers the four previously named schema gaps and BFF routes. Exact-green main already exposes bounded human-recorded classification review history and 0103 membership guards; it does not verify agent observations or perform source corrections. Next persist immutable observations bound to tenant, engagement, source digest and agent run, then wire human review/correction, RoPA, policy-draft review and playbooks. Do not infer scope from telemetry or invent processing facts. Selected local 60321 now has checksum-verified 0104; immutable 0105 source snapshots, strict runtime contracts and BFF preview/create foundation passed complete parent tests and 21 actual Auth/PostgREST checks on isolated 59621, with one source-bound human receipt and zero chain violations. Dedicated dispatch and persisted observations are on exact-green staging through #177; source-bound human reviews remain candidate engineering. Generic public mode intentionally refuses. · Closure: authorized operator actions, persistence/reload, viewer/foreign-tenant refusal, ledger provenance and end-to-end evidence.

- [ ] **P1-W2d Generic agent run lifecycle authority** · Engineering · The migrated database refuses direct service-role writes to `agent_runs`, while generic BFF dispatch still attempts INSERT/UPDATE. Candidate 1a578c0 implements restricted, tenant/actor/context/correlation-bound start and terminal RPCs with recorded provenance; parent real Auth/runtime/PostgREST acceptance passed on the isolated fixture, including configured development writer mode and uppercase UUIDs. Preserve Karya/report workflow refusals, current internal-user authority and existing dedicated flows; full combined database passed; PR #172 hosted portability and approval-region harness failures were corrected; exact source and staging gates passed and #172 merged. Main 71323456 exact CI/security and selected local 0104 acceptance passed in RC.3; remote target acceptance remains pending. Never restore broad service-role DML. · Verify: actual migrated database and runtime transport, initial-write refusal prevents dispatch, terminal ambiguity never produces a success event, viewer/foreign-context/revoked-actor refusal and mutation regressions. · Closure: real invocation/run/ledger evidence and exact source/staging/main gates.

- [x] **P1-W2e Deterministic database concurrency validation** · Engineering · Replace remaining fixed-duration transaction holds with bounded synchronization against the actual holder backend PID. Preserve nonblocking visibility/SKIP LOCKED probes, expected refusal outcomes, and authority expiry while blocked; retain roles and all database outcome assertions. · Verify: focused race suites and meaningful synchronization mutations, then the complete combined migration/SQL/concurrency/populated-upgrade/TCP/DSN runner. · Closure: parent b224bad full run passed 105 migrations, 73 SQL suites, 25 concurrency suites, 18 populated upgrades and TCP/DSN with 233 paths unchanged and zero owned containers remaining (2026-10-05 progress checkpoint); prior red runs retained. Exact release gates remain separate (plan D14).

### W3 Estate

- [ ] **P1-W3a Estate taxonomy** (W3-1) · Operator · what an "estate" is for clients (legal entity, business unit, environment, geography) · Closure: definition plus two or three real examples.
- [ ] **P1-W3b System kinds** (W3-2) · Operator · confirm `database, application, storage, identity, saas, other` suffices · Closure: missing kinds or confirmation.
- [ ] **P1-W3c Verify the inventory milestone** (W3-4) · Operator · apply through 0034, deploy BFF/web together; as owner/admin on `/estate` create an estate (explicit slug), add a system and category keys, edit, archive/restore; viewer/analyst can read but not manage; legacy intake assignment only for unassigned intakes with no findings/plans/runs/evidence/reports (never bypass with SQL); lost response: use "Retry same request", never a fresh key · Verify: one ledger event per successful mutation · Closure: ledger event ids.
- [ ] **P1-W3d Review an onboarding proposal** (W3-5; decision: owner **and** tenant admin may approve, analyst prepares) · Operator · apply through 0035; analyst prepares at `/estate/onboarding`, a different owner/admin approves/rejects with reason; stale-estate proposals are rejected and re-prepared · Closure: proposal and approval record.
- [ ] **P1-W3e Verify organization creation readiness** (W3-0) · Operator/Engineering · apply through 0101, seed the pinned control library, and verify its complete version is current before accepting onboarding. Grant organization-creation entitlements only to approved accounts with a recorded tier, quota, expiry and approval reference (procedure in `docs/audits/05-w0-operations.md`); signup itself does not confer a grant. Verify a fresh entitled account can create an organization and reaches its dashboard, while an unentitled account is refused without partial tenant records. The isolated local stack on port 60321 passed the entitled path on 2026-10-03; source, staging, main and deployed acceptance remain open. · Closure: exact release/CI SHAs, deployed request and ledger evidence, and the operator grant record.

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

- [ ] **P1-W4n Public website check release acceptance** (W4.7, migration 0102) · Engineering/Operator · promote the reviewed source and apply the checksum-verified migration to the selected target; as an owner/admin, check a permitted public HTML page through `/connectors`, reload and confirm the tenant-scoped observation plus `connector.website.checked` ledger entry; as a viewer, confirm read-only history; reject loopback, private, mixed-DNS and redirect-to-private targets. Verify the 30/hour per-actor-per-tenant limit and that no raw HTML or URL query secrets are saved. This is a bounded starting-page audit of up to three same-site notice pages, not a whole-site crawler or compliance certification. · Closure: exact source/staging/main CI SHAs, deployed target ID, request/ledger IDs and refusal evidence. PR #162 passed isolated migration, four-label strict parity, a real public-page smoke and the fresh-socket transport regression. Revision `70106f0` passed a complete local-Docker wrapper run (89 API checks and 99 browser journeys per label, restart durability and parity), and the live axiomminds.ai dev-browser audit retrieved privacy/contact/terms. Exact source CI 37160600330 and Bandit/Semgrep/Trivy passed; PR #162 merged to staging `5adc4fc`. Exact staging CI 37161869020 and security passed. Follow-up PR #164 source `281b844` passed CI 37167552248 and security and a full local-Docker gate (89 API and 100 browser journeys per label), then merged to staging `4b1b22f`; exact staging/main checks, port 3001 migration and remote deployed closure remain open. Separate form-facts viewer preview passed actual company-site owner/viewer, source/ledger and desktop/mobile acceptance. PR #173 exact d0e269f source passed CI/security and merged to staging 708e076; exact staging CI 37238520547 and security passed; main promotion #175 merged at 71323456 after fresh CI/security passed; exact main CI/security and selected local RC.3 owner/viewer form-detail acceptance passed. Remote target acceptance remains open.
- [ ] **P1-W2-public Durable public-source operator workflow** · Engineering · source foundation #174 and execution #176 are on exact-green staging 2305ae4c; source e20caa3e passed exact CI/security and candidate bd62b391 passed actual owner/viewer BFF-to-runtime-to-database Drishti/Vibhaag acceptance (21 checks, receipts 400-407, two retained observations, zero chain violations). Add posture-readable engagement choices, bound observation history and actor-scoped interrupted-request reconciliation before a durable UI. Integrate Discovery/Classification and saved-check navigation, retain the same operation key/body after uncertainty, preserve null historical estates and show private facts unknown/human review pending. Verify owner, internal analyst and viewer, reload, tenant switching, lost-response recovery, keyboard and mobile behavior. · Closure: exact source/staging/main gates, backed-up selected-target migration, actual browser/result/receipt evidence and retained source-bound review history; two-agent API success alone does not close all-agent or review requirements. Integrated 6ef987ec passed 31 actual read/recovery API checks (including normal internal-analyst TOTP), 18 actual owner/viewer browser checks, desktop/mobile keyboard review, exact source hashes and eight additional agent receipts. The read-only viewer continuation corrected test selectors without rerunning either agent. Both producer attempts to forge classification.reviewed returned 403 with no ledger row/sequence use. This operator UI merged through exact-source-green PR #177 to staging a3c845f5 and is not yet in selected local RC.3; the first CI form-fixture count-gate issue was corrected and replacement source gates passed. Exact staging CI/security passed; main promotion and selected local deployment remain pending; P1-W2-source-review remains separate.
- [ ] **P1-W2-source-review Source-bound human structural review** · Engineering · add append-only human acknowledgements/disputes tied to the exact retained observation, source digests, run/completion/settlement receipts and optional exact Vibhaag indicator. Review authority uses ASSESSMENT_RUN, separate from AGENT_INVOKE; current membership is required even for internal users. Preserve stable request recovery, predecessor checks, historical judgments and private facts unknown; do not synthesize legacy sensitivity/categories/confidence. · Closure: source-linked UI/history and authorized reviewer acceptance, viewer/foreign/revoked refusal, one human receipt per decision, concurrency/mutation/security gates and exact release/deployed evidence. SQL0109 plus human policy-event fence0110 passed parent111-migration/79-SQL/29-concurrency/18-upgrade gates with18 caught SQL mutants; sharedtypes0d4dcd3 passed286 tests, strict TypeScript and98.14% lines. All prior source and personas remain preserved. API/UI, backed-up fixture application, real reviewer acceptance and release gates remain open.
- [ ] **P1-W4o Private connector execution path** (W4.6/4.7) · Operator/Engineering · for production PostgreSQL/MySQL descriptors, provision the private endpoint, broker credential, workload identity and read grant independently of the registration; then run a tenant-scoped live discovery/health check. The `/connectors` setup-status view reports saved records only and cannot prove current reachability. Reference CRM/HRMS/warehouse/repository/ticketing descriptors need vendor-verified mappings and tenant-specific acceptance before being called functional. · Closure: effective IAM/SPIRE/broker checks, target-specific read result and recorded health observation on the selected environment.

### W5 / W6

- [ ] **P1-W5 Production write path and deployed B.10 acceptance** · Operator + Engineering · operator-gated broker/SPIRE composition so a real write adapter can be bound; without a configured origin the executor refuses `execution_unconfigured` `[14]` · Verify: all eight PRD §B.10 criteria as passing tests plus a live rollback in a controlled staging estate `[11]` · Closure: recorded run.
- [ ] **P1-W6 Enable and observe the continuous scheduler** · Operator · `feature_continuous_scheduler` is off unless set per environment `[14]`; schedules, drift events, policy evaluations and health surfaces need deployed observation · Closure: schedule firing and health readback on a deployed target.

### W8 Reporting, evidence, mail

- [ ] **P1-W8a Object Lock Compliance bucket evidence** (`[16 §0]`, `[17B]`) · Operator · permanent real bucket per P0-11, with explicit retention approval after disposable experiments and before any preprod phase; see section 2b step 5 · Verify: provider readback of mode and retention against a real object/version; exact-version retrieval · Closure: readback archived. W8 WORM retention is not provable in CI.
- [ ] **P1-W8b Mail opt-ins** (`[16 C-W0-4/6, W1]`) · Operator · keep `AXIOM_REPORT_EMAIL_MODE=disabled` and `AXIOM_CONTACT_EMAIL_MODE=disabled` during acceptance; production mail needs explicit `delivery` mode and the BFF-held managed `RESEND_API_KEY` (marketing holds none); apply 0037 and 0052 and deploy BFF and marketing together; remove the unused marketing `resend_api_key` accessor binding by applying the updated IAM (no secret value change) · Closure: acceptance preflight passes with delivery disabled; real provider delivery not yet exercised `[16]`.
- [ ] **P1-W8c Gap-scan durability probe on remote targets** (`[17A]`) · Operator · after ordinary acceptance: `export AXIOM_ACCEPTANCE_TARGET="$PWD/.axiom-runtime/preprod-target.json"`; `pnpm exec tsx scripts/verify-gap-scan-durability.ts prepare`; operator restarts all BFF/marketing replicas **without replacing the database**; `... verify`; repeat for the comparison target · Closure: restart evidence retained (the probe cannot prove a restart); private `gap-scan-private.json` never uploaded.

### W9 / W10

- [ ] **P1-W9 Measured load, coverage and recovery on the target** · Operator + Engineering · real 1M-row discovery throughput and report timing at stated thresholds; CI-enforced per-module coverage floors; current candidate module checks passed locally, while target-specific measurements remain open; scheduled-backup RPO and complete DB **and evidence-object** restore integrity with bounded RTO (synthetic benchmark and disposable restore are insufficient) `[A91]` · Closure: datasets, thresholds, versions, artifacts recorded.
- [ ] **P1-W10 Offline install acceptance** · Operator + Engineering · isolated offline target with egress **blocked**: strict secrets, functional in-perimeter Auth/PostgREST/DB, verified WORM configuration, local model dispatch or explicit unavailable result; install, upgrade, restore and persona journey `[A91][18]` · Closure: live air-gapped acceptance run (not done as of 2026-10-01 `[brief]`).
- [ ] **P1-W9b Remote acceptance plan fixtures** · Engineering + Operator · migration 0099 removed plan/action DML from the service credential. The candidate remote path requires an operator-owned PostgreSQL tunnel bound to loopback and a private `AXIOM_ACCEPTANCE_FIXTURE_DB` JSON file (mode `0600`) containing exactly `schemaVersion: 1`, `deploymentId`, `environment`, `expectedRevision` and `databaseUrl`. The first four values must match `AXIOM_ACCEPTANCE_TARGET`; `databaseUrl` must point to the tunnel's local port, never a public database host, and must have no query parameters or fragment (node-postgres permits `?host=` to override the URL hostname). The operator opens the tunnel to the selected **non-production synthetic** database, then runs `scripts/run-deployed-acceptance.sh PRIVATE_TARGET_JSON`. Before every plan/action write, the harness checks that this database contains the random engagement created through that target's API. No service-key plan DML or public seeding RPC is restored. Close only after source/staging/main gates and a remote persona/parity run using the operator tunnel, with the target identity, revision and result IDs recorded; no remote run has been made.
- [ ] **P1-W1c Fresh-login token clock boundary** · Engineering · The isolated local main build intermittently returned PostgREST 401 on the first `/dashboard` membership read immediately after sign-in; a matching `PGRST303` future-issued-JWT response was reproduced with a signed future-`iat` token. PR #155 retries only that refusal once after the clock boundary and otherwise fails closed. Close after the PR, exact staging/main gates, a rebuilt local browser sign-in repetition including a cold start, and no membership error; unit tests alone do not close this.
- [ ] **P1-W8d Confirm the PDF renderer 503 / ECONNRESET** · Engineering · The stale Linux `chrome-headless-shell-linux` lookup was corrected to Playwright 1.63.0's installed `chrome-headless-shell-linux64` path. The source W8 job selected the shell and warmed in 257 ms; the promoted main job was green with a 417 ms warm-up and 16/16 browser journeys, without the earlier classic-headless fallback warning. Earlier CI attempts had 121,296 ms warm-up and intermittent `report_renderer_unavailable` / `ECONNRESET`. Keep this open until repeated exact-revision W8 runs confirm the first PDF no longer flakes; record their render timing and any fallback warnings before closure.
- [ ] **P1-DS1 Design-system pass on the remaining screens** · Engineering · All 21 top-level module routes showed their shared context in signed-in local browser checks with the correct personas. The visual pass covered dashboard, data map, monitoring, ledger and partner; bare loaded-empty messages on the primary module surfaces now use `DataPlaceholder` with their domain explanation. The generic module card no longer links external tenants to internal-only workspaces. Web tests, typecheck, lint and build passed before the final auth adjustment. Candidate `5f52d5c` brought the requested headers into the shared indigo hero and passed the 14-route Chromium sweep, report tab switching, four mobile-width checks, 613 web tests, 59 UI tests, lint, typechecks, and production web build. Responsive frame candidate `90f3115` removes page-level width caps, including `/regwatch`, and places assessment status beneath the hero. Follow-up `8e95717` reduces the shared shell margins to 24px at desktop and 12px at mobile widths, matching the top bar. Local web 646/646, full browser 99/99 before expanded layout assertions, then a 20-route desktop and five-route mobile Chromium check passed; restored old caps and margins each failed their regression check. On the margin follow-up, two full local browser runs ended 97/99 and 98/99 because the isolated Auth container exhausted outbound database sockets; the failed invitation and layout journeys subsequently passed 4/4 after Auth restart. Keep the full-run gate red until exact source CI passes. Close after candidate source, exact staging and exact main CI/security gates, the rebuilt port 3001 browser rerun, and design-system re-sync for the shared UI change.
- [x] **P1-DS2 Run /design-sync** · Done 2026-10-03: the `@axiom/ui` library was converted (28 components, render check 28/28 clean, 28 previews graded good, conventions header validated) and uploaded to the new design-system project **Axiom Proof UI Library**, `https://claude.ai/design/p/9551f704-acf3-4897-bcf9-958d3668ff1b` (`projectId` is pinned in `.design-sync/config.json`). **Re-sync after any change to `packages/ui` or the preview files:** `pnpm --filter @axiom/ui build`, stage the converter per `.design-sync/NOTES.md`, run the `/design-sync` skill (needs `/design-login` once in an interactive terminal), regrade changed cells, upload. Read `.design-sync/NOTES.md` first (gotchas and re-sync risks).
- [x] **P1-DS3 Visual review of the restored status colours** · Accepted by the operator 2026-10-03 on the earlier review of the finalised surfaces. The brand preset had no red, green, amber, emerald, yellow, orange, blue or rose, so error alerts, warning boxes and success badges rendered with no colour; the families were added (Tailwind defaults) and warnings moved from gold to amber. Any brand-specific shade can still be tuned in `packages/design-tokens/src/tailwind.ts`; `palette-coverage.test.ts` guards the families.
- [x] **P1-DS4 Mirror Samadhan and Pramaan into the claude.ai design page** · Done 2026-10-03 through Claude Design's chat on the "Axiom Proof Design System" project (page `Axiom Proof Design System.dc.html`, section 05): both cards were added in the existing format, the placeholder count set to 12, nothing else changed, and the result was checked on screen. The repo copy `design-system/Axiom Proof Design System.dc.html` matches.
- [x] **P1-0099b Move the archive release label** · Closed 2026-10-03: migration 0100 removed `release_approval_proof_archive` from the archive writer and granted it to the human writer; the BFF and provider probes use that route. Local database/BFF tests, PR #153 source CI, exact staging `0eb4089` CI 37117599956, and exact main `a831bfc` CI 37118718821 plus security scans passed. Real preprod acceptance remains a separate W8.5 operator gate.

**Local migration baseline safety:** `scripts/adopt-migration-baseline.py` is report-only until every unrecorded migration has matching Supabase history with recorded statements and its tables exist. The existing `supabase_db_axiom-proof` has an unverified gap beginning at 0077; `--apply` now refuses it. Audit that schema separately before adopting a baseline or running the normal migration runner. A table's existence is not proof that later functions, policies and grants were applied.

---

## 5. Deployed acceptance procedure (`[17A]`; used by P0-8, P1-R2/R3/R5)

**Prepare the target.**

1. Deploy BFF, web and marketing from the same clean Git revision with `--build-arg AXIOM_RELEASE_SHA=<40-character SHA>` on each Docker build (a dirty build has no trustworthy identity).
2. Use `ENVIRONMENT=preprod|production|onprem` with `AXIOM_AUTH_MODE=strict`; apply all migrations; keep external contact email disabled and `AXIOM_REPORT_EMAIL_MODE=disabled`; fixture setup seeds the published control library if absent and refuses a conflicting count.
3. Create a private JSON file from `ACCEPTANCE_TARGET.example.json` with credentials from the secret store (never chat or shell history): `anonKey` (JWT anon key), `publishableKey` (API gateway key), `serviceKey` (service-role JWT, fixture setup only). MFA encryption/signing keys are never supplied to the runner; SSR needs only the scoped public connection.
4. Store under ignored `.axiom-runtime` at mode `0600`; `topology=remote` for HTTPS (loopback HTTP only with `topology=local-docker`); `syntheticFixtures=true`; unique `deploymentId` per deployment; `expectedRevision` = deployed source SHA.

**Run and compare.** These fixture-writing commands require an approved isolated synthetic target. The comparison file identifies its real topology; a production-profile name is not permission to seed a customer production dataset. Actual production acceptance follows P1-R5 with its specifically approved synthetic scope.

```bash
chmod 600 .axiom-runtime/preprod-target.json
./scripts/run-deployed-acceptance.sh .axiom-runtime/preprod-target.json
./scripts/run-deployed-acceptance.sh .axiom-runtime/comparison-target.json
pnpm exec tsx scripts/compare-deployed-parity.ts \
  .axiom-runtime/acceptance/<preprod-id>/api-results.json \
  .axiom-runtime/acceptance/<comparison-id>/api-results.json
pnpm exec tsx scripts/compare-deployed-parity.ts \
  .axiom-runtime/acceptance/<preprod-id>/browser-results.json \
  .axiom-runtime/acceptance/<comparison-id>/browser-results.json
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

- [x] **P2-1 Main promotion** (`[14][16]`; `20_Plan.md` D7) · Done 2026-10-01 on the user's instruction: staging `8700264` (exact-SHA CI green) promoted by PR #129 merge commit to main `06bd190`, exact-SHA CI green. No deploy ran (main triggers CI and security only). Later promotions follow the same rule: merge commit, never squash, no direct pushes, no promotion while any gate is red. After source, staging and main CI/security gates and local acceptance are green, annotate the exact promoted main SHA as the source candidate `v0.1.0-rc.1` (matching package version `0.1.0`) and verify the remote tag target. Reserve the stable `v0.1.0` tag and GitHub release for recorded remote preprod/deployment acceptance; do not tag staging or a known failing local build.
- [x] **P2-2 Delete stale branches** (`[14]`) · Done 2026-10-01 (see P2-15 for what remains) · 41 remote and 119 local branches deleted after each tip was shown to be in main or captured in the backup bundle `~/axiom-proof-branch-backup-20261001.bundle` (ref list `~/axiom-proof-refs-20261001.txt`; restore any branch with `git fetch <bundle> <ref>:<ref>`).
- [ ] **P2-3 Dependabot holds** (`[14]`) · Operator/Engineering · `tailwindcss` 4 (major migration) and ESLint 10 (`scopeManager.addGlobals` breakage) held back; revisit deliberately (project memory also pins ESLint 9 + TS 6 in the lint shim; do not touch).
- [ ] **P2-4 Follow-up hardening** (`[14]`) · Engineering · five web screens still fabricate values with `Math.random`; Bandit medium findings in test-harness SQL; CodeQL flags on world-readable SPIRE health files (deliberate) and a URL built in `verify-controller-issuance.py`.
- [ ] **P2-5 `saml2_bearer` decision** (W4.7) · Operator · TODO, not a blocker; needs an XML-DSig dependency and a review decision.
- [ ] **P2-6 Vendor-verified descriptors** (W4.7) · Operator · need real client tenants.
- [ ] **P2-7 W3.5 lineage model** · Operator + Engineering · derivation edges need a reviewed data-lineage model. Graph refresh, grant expiry and branded SVG/PNG export have local regression and browser evidence on the operator gap-closure candidate; release gates remain pending. Closure: approved lineage model, implemented derivation edges and source-bound browser evidence.
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

- [ ] **P2-18 Optional local Mailpit journey** (W1 wishlist; deferred, non-gating) · Engineering · If local invitation-email capture becomes useful, compare Mailpit with the existing local Auth mail-capture service, then add a local-only Compose profile and explicit email transport selection for BFF invitations and Auth. Verify a synthetic invitation reaches the capture UI, its link accepts under the invited identity, and non-local environments cannot route to the local sink. Do not weaken invitation expiry or enable email OTP. This does not replace **P1-W1b**, the deployed transactional-email provider and domain. · Closure: local end-to-end run and environment-isolation check; no release date or blocking dependency assigned.

## 7. Engineering blockers that gate operator steps (not operator tasks)

The recorded overall goal is paused; no cause is stored in that goal record.
Neither completed operator decisions nor manual testing automatically close
these items. Documentation can be maintained while implementation is paused;
resuming implementation is distinct from authorizing a cloud mutation.

| Engineering item                              | Evidence already present                                                                                                                                                             | Required next work                                                                                                                                                                                                                  | Operator dependency                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator workflow release                     | PR #177 source and exact staging a3c845f5 CI/security passed; actual isolated source/read/recovery/browser proof retained.                                                           | Exact-green main promotion, backup/preservation checks, selected local image refresh and actual deployed acceptance.                                                                                                                | Manual review can follow the refreshed release; independent promotion/local validation already has session authorization. Cloud deployment is separate.  |
| Human structural review                       | Parent SQL 0109/0110 and type gates passed. Separate API ba394e78 and Web be809eb2 worker commits are ready; their reported tests are not parent combined clearance.                 | Independently review/integrate, complete quality/security gates, verify a fresh backup before fixture migrations, then actual owner/reviewer/viewer HTTP/browser recovery and receipts. Complete source/staging/main release gates. | None for independent local engineering. Manual acceptance requested only after a ready release is identified.                                            |
| RoPA, policy documents and delivery workflows | Requirement audit found concrete UI/composition/persistence gaps; policy human-event producer fence 0110 is tested.                                                                  | In plan order implement explicit-unknown RoPA capture/readback, source provenance, document reasons/history/review and task/time capture/ranking.                                                                                   | Processing facts and business judgments must come from authorized humans; no public-source inference. Implementation can proceed without inventing them. |
| All-agent and private execution               | Drishti/Vibhaag public-source flow has real retained proof. Other modules have varying source/test evidence; production write path is not cleared.                                   | Complete agent input/output composition and real-work journeys; wire broker/SPIRE/transport/approved execution before claiming a functional private connector.                                                                      | Only the live target/network/grant and write-test approval are operator-owned; missing wiring remains engineering work.                                  |
| W6/W7 and UI completeness                     | Local RC.3 passed responsive checks; existing backend/sector-pack evidence is recorded in docs/20–21.                                                                                | Remaining scheduler/alerts/UI/composition, SMB/vendor/partner/Sanket and Healthcare/Tech/library work; validate functional actions and design consistency throughout.                                                               | Do not defer implementation to operator screen testing. Obtain business/source decisions only where needed.                                              |
| Remote acceptance and proof                   | 0099 restricted writers, 0091–0098 dossiers and W8.5 archive correction are on main. Selected local has 105 verified migrations through 0104; isolated fixture has 109 through 0108. | Maintain fixture/writer compatibility and exact-source suites; repeated first-PDF checks, live retained-object/RPO/RTO/performance/offline acceptance remain open.                                                                  | Identified approved target, private tunnel, provider identities/retention and target-specific windows (steps 2, 5, 10–11).                               |
| Deployment dry-run behavior                   | Source inspection confirms prep calls gcloud services enable regardless of DRY_RUN; current deploy always checks the S3 probe before phase selection.                                | Correct and regression/mutation-test prep's read-only semantics before advertising a default dry-run as non-mutating. Keep the existing probe requirement explicit.                                                                 | Phase-specific planning is documented in step 6; no operator action can replace this code fix.                                                           |

**What is safe to review now:** RC.3's existing local UI/public check, plus
sanitized decisions and configuration readiness. **What is not being requested
now:** approval of the unfinished human-review release, customer-data fixtures,
private production writes, billable deployment or service interruption. Local
Docker teardown remains data-preserving by default; there is no outstanding
request to delete databases, volumes, persona factors or ledger history.
