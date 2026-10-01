# Axiom Proof — Progress log (append-only)

### Axiom Minds Private Limited · https://axiomminds.ai

**This is the single progress and handoff record.** It replaces
`12_Implementation_Handoff.md`, `14_Implementation_Progress.md`,
`15_Session_Handoff.md` and `17_Fresh_Session_Brief.md` (now stubs). Companions:
[20_Plan.md](20_Plan.md), [22_Architecture_and_Flow.md](22_Architecture_and_Flow.md),
[23_Operator_Runbook.md](23_Operator_Runbook.md).

**Rules.** (1) Never create another handoff, progress or session file; append
here. (2) Append a dated entry at the **end** of section 3; never rewrite older
entries (correct by a new entry that says what it corrects). (3) Update the
status table in section 1 and the status table in `20_Plan.md` in the same
commit. (4) Record only verified results: command or CI run, exact SHA, what it
does **not** prove. Never invent SHAs, counts or results. (5) Source tags in
brackets name the pre-consolidation file; full text of each is in git
(`git show 41b70b6:docs/<file>`). `[brief]` = the maintainer-verified state
supplied with the 2026-10-01 consolidation request; no older doc states it.

---

## 1. Status table (as of 2026-10-01)

Mirror of `20_Plan.md` section 3; keep both in sync.

| ID         | Status                     | Latest evidence                                                                                                                                                                                                  | Open                                                                                     |
| ---------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| W0         | Partial                    | Harness delivered, local rehearsal only `[16]`                                                                                                                                                                   | Remote acceptance (two targets), deployed IAM, EKS CIDR, secret rotation confirmation    |
| W1         | Partial                    | C-W1-1…4 delivered `[16]`                                                                                                                                                                                        | Mail provider/domain; deployed MFA evidence                                              |
| W2         | Partial                    | 36/40 tables at Rev 101 `[17B]`                                                                                                                                                                                  | `ropa_records`, `policy_drafts`, `playbook_entries`, `classification_reviews`            |
| W3 / W3.5  | Partial                    | Wizard, sustenance, graph (Rev 79–81, 88) `[14]`                                                                                                                                                                 | Derivation edges, live updates, branded export                                           |
| W4         | Mostly done                | 4.1–4.5 code complete; 4.6 PG + MySQL; 4.7 REST/GraphQL `[14]`                                                                                                                                                   | Production broker/SPIRE composition; RDS staging run; `saml2_bearer`; vendor descriptors |
| W5         | Backend delivered locally  | 0060–0064, manual rollback route `[14]`                                                                                                                                                                          | Production write path; deployed §B.10 acceptance                                         |
| W6         | Partial                    | 0065–0068 + executors `[14]`                                                                                                                                                                                     | Alerts, UI, composition, W6.3–6.6                                                        |
| W7         | Partial                    | BFSI pack #1 `[14]`                                                                                                                                                                                              | Healthcare, Tech, completeness                                                           |
| W8         | **Open**                   | Board/auditor source-bound (PRs #115–#118) `[16]`                                                                                                                                                                | Statutory (DPB/technical), dispatch, approval proof, journeys                            |
| W8.4 (W11) | **On staging**             | DPB, technical and auditor Pramaan dossiers (migrations 0091-0097) merged by PR #124 as staging `a8ce820`; full CI success on that exact SHA; 16/16 real-provider journeys locally on `859dfaa`                  | Dispatch of dossiers; remote and production acceptance; local fixture results only       |
| W8.5 (W12) | **On staging**             | PR #121 merged as `6dab9ac`; 14/14 real-provider journeys on `d617c2a`; `6dab9ac` CI was red once on the W8 job (renderer 503, below); later staging commits `711a319`, `2a8b191`, `a8ce820` all full CI success | Production acceptance; the 503 root cause is still unconfirmed                           |
| W9         | **Integrated, in PR #125** | Web fail-closed fixes, Cloud SQL private-only Terraform, coverage floors met locally (web 82.35% by the gate script, bff 80.13%)                                                                                 | Live throughput, report-time, backup and full-restore measurements; PR #125 CI           |
| W10        | **Open**                   | Code exists, not isolated `[A91]`                                                                                                                                                                                | Live air-gapped acceptance not done `[brief]`                                            |
| Release    | **Open**                   | none                                                                                                                                                                                                             | No remote preprod, no production deployment                                              |

## 2. Verified current state (2026-10-01) `[brief]`

Maintainer-verified; cite this section, and git for the SHAs.

| Fact                                                    | Value                                                                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staging`                                               | PR #120 (`codex/revision121-staging-acceptance-hotfix`) merged at `41b70b6`, **full CI green**                                                                                                                    |
| `main`                                                  | Still at `3492ffa` (promotion paused by operator)                                                                                                                                                                 |
| W8.5 approval-archive branch                            | `codex/revision124-approval-proof-archive` at `d617c2a`, **local only**; its **14-journey real-provider browser run is NOT yet green**                                                                            |
| Migration **0099** (ledger source + execution gate)     | **Untested draft; production blocker.** `service_role` can call `append_ledger` directly; has DML grants on `remediation_plans`/`remediation_actions`; `start_execution_batch` can bypass the cancelled-plan path |
| Statutory dossier migrations **0091–0097** and **0098** | Local only, not on staging                                                                                                                                                                                        |
| W9 web coverage gate                                    | 80% **not met** in last integrated measurement (Audit 91 recorded web at 15.90% on 2026-09-30 and a 7-of-14 module coverage failure `[A91]`; the later figure is not recorded in any doc)                         |
| W10                                                     | Live air-gapped acceptance **not done**                                                                                                                                                                           |
| Deployment                                              | **No production deployment**; no remote preprod acceptance run                                                                                                                                                    |
| Git-verifiable in this repo at `41b70b6`                | migrations 0000–0089 (90 files); merge `38762c4` (PR #119) is an ancestor of `41b70b6`                                                                                                                            |

## 3. Dated log (newest last)

Entry format: **date — revision/PR — what was verified — what it does not prove.**
Counts, SHAs and CI run IDs below are copied from the named source.

### 2026-09-20 — baseline and plan `[11][12]`

- Independent review `audits/04` (R-01…R-11) and the plan's first revisions; decisions 1–12 recorded (see `20_Plan.md` §6). Handoff snapshot at `2c54fcd` (analyst role work uncommitted then; later shipped in `dc901e9`).
- Not proven: any deployed behaviour.

### 2026-09-21 — W0/W1/W2 foundations `[14][16]`

- Milestones recorded under these headings in `[14]`: direct-client and invocation authority; durable idempotency; atomic entitled onboarding; credential wiring and expiry gates; real local Auth/PostgREST parity with migration runner; self-managed MFA, login enforcement and persona gating; `axiom_analyst`; executor reads the kill-switch stop; atomic approval issuance (single transaction) and snapshot-bound claims; W8/W9 provenance gaps (R-10/R-11); durable dispatch outbox.
- W0.0/W0.2 closed and CI-held; deployed-target harness delivered (Revision 28, 21 Sep) `[16]`. Estate schema (0029), connector schema (0033, seven tables) `[16]`.
- Not proven: deployed acceptance; W2 was 19/40 at this time.

### 2026-09-22 — Revisions 29–49 `[14][15][16]`

- 0036 atomic recovery-code session policy (Rev 29); 0037 durable BFF-owned gap-scan snapshots and mail (Rev 30; merge `c79c303`, CI 35647963475, 61 browser and 75 API outcomes) `[15]`; 0038 connector registry lifecycle (Rev 31); 0039 credential vault; 0040 OAuth broker core; workload identity (JWT-SVID verifier, ten-UID SPIRE harness, 61 outcomes); runtime audit hardening; nine service identities and secret allowlists (Rev 36); 0041 task delegation; confirmed dispatch outcomes (Rev 38) and UI outcomes (Rev 39); tenant routing (Rev 40); saved assessment provenance (Rev 41); isolated assessment worker 0042; confirmation 0043; truthful Temporal v2; encrypted dispatch 0044; bounded controller; opaque scheduling; durable pickup 0045; remote transport.
- Not proven: any of this against a deployed SPIRE, real KMS, Cloud Run IAM or client execution (stated in each revision's limits).

### 2026-09-23 — Revisions 50–73 (workload host and controller chain) `[16]`

- Dispatch KMS adapters; retention worker (0046); dispatch policy fencing (0047); per-job container isolation; workload registration lifecycle (0048); protected trust bundle; VM controller composition; private Mumbai issuer + runner VM foundation (default-off Terraform `workload_vms = null`); credential delivery; SPIRE admission/persistence/health; issuer initial enrollment; runner enrollment; runtime volumes; controller entrypoint acceptance; role admission; protected files; one runner VM per tenant (user decision); placement preflight; supervision; tenant-scoped backend (0049); resource IAM config.
- Revision 73 baseline: staging `5efb40d8d6b6e0a0788b961d028d0203fa608e97`, CI 35890118690 (19 jobs, 13 reports). Revision 74 source CI 35896023384 at `5577b78`; Revision 74 registry-recovery source CI 35898949282 (PR 41).
- Not proven: effective cloud IAM, private TLS/DNS, real GCP IIT/KMS, Mumbai recovery; no cloud apply performed.

### 2026-09-24 — Revisions 74–83 `[16][14]`

- Rev 74 reviewed controller credential issuance (0051 corrects a clean-database extension schema failure; 0050 untouched). Rev 75 controller generation transition: staging `6617e3283092462f40a13168d1f016da69048f14`, source CI 35906474455 (19 jobs, 13 reports; 214 deployment tests; 16 Docker host-delivery outcomes).
- Rev 76 C-W0-6 durable contact inquiries (0052; BFF 1,016 tests; 67/67 Playwright). Rev 77 C-W0-7 scoring/display provenance (68/68 Playwright). Rev 78 C-W1-3 tenant invitations (0053; PR vikashkaruna/Proof#43 baseline `b68fa2c`; BFF 1,038; 70/70 Playwright). Rev 79 resumable wizard (0054). Rev 80 sustenance/re-attestation (0055). Rev 81 estate graph. Rev 82 grant issuance and enforcement (0056). Rev 83 tool registry (0057).
- Branch audit (operator request): every remote branch contained in staging; `main` accepts only staging promotions via merge commit (#45). Always unshallow before comparing branches.
- Not proven: real mail delivery; deployed acceptance.

### 2026-09-25 — Revisions 84–88 and close-out `[14][16]`

- Rev 84 first real SQL read binding (0058; live PostgreSQL 16 CI job). Rev 85 REST read transport + five-system reference pack. Rev 86 GraphQL read transport. Rev 87 discovery route and persisted runs (0059). Rev 88 tool registry UI and PNG graph export.
- Close-out state: staging merge `cfe985d` (PR #56, 21/21 CI checks); 0000–0059, 60 migrations, 61 tables; BFF 1,089 tests; web 89; MFA 180; control library 83; config 68; types 45. Dependabot #32–36 closed out, landed via PR #57; `tailwindcss` 4 and ESLint 10 held back.
- Operator decisions in force (2026-09-25): three historical secrets held (not ignored) until rotation confirmed (two JWT secrets in `infra/docker/docker-compose.supabase.yml`, commit `7719f0c`; `APPROVAL_SIGNING_KEY` in `infra/docker/environments/.env.preprod.example`, commit `7631b1f`); `main` branch protection done; stale branches deleted after plan completion; `saml2_bearer` a TODO; sector pack #1 chosen at W7; promotion to `main` paused.
- Not proven: any deployed acceptance for Revisions 75–88 (explicitly "No deployed acceptance has been run" `[17B]`).

### 2026-09-26 — Revisions 89–97 (W5, W6) `[14]`

- 0060 dry-run engine + five execution tables; 0061 durable executor; 0062 rollback engine; 0063 verification + maker-checker reconciler; 0064 execution telemetry; 0065 continuous-compliance tables; 0066 scheduler; 0067 drift acknowledgement + monitoring health; 0068 standing-policy engine. Schema tip 0068, 69 migrations, 70 public tables.
- Limit stated: executor ships only a bounded reference write transport; with no origin configured the route refuses `execution_unconfigured`; no production connector write path.

### 2026-09-27 — Revisions 98–101 `[14][17B]`

- Rev 98: PRs #80–#85 (W5 manual rollback route; 0069 consent tables; 0070 frameworks/mappings + BFSI pack #1; 0071 DSAR/breach/report-release RPCs; MySQL binding). Schema 0071, 72 migrations, 78 tables.
- Rev 99: PR #88 merged `2ecbcc005fe24dd692b09550fe443c2002509055`; source CI 36275413848, staging CI 36276479197 (21 checks; 89 API, 80 browser).
- Rev 100: PR #89 `ac5a072613cd8cad79867900d529e9abf27684f7`; CI 36286566063 / 36287342406 (22 checks; 89 API, 83 browser; 14 provider checks); 0073; 74 migrations / 81 tables; W2 35/40.
- Rev 101: PR #90 `1b5cba8f043d46e46b5a0229a96ad195b361d2d9`; CI 36290981117 / 36291935022 (22 jobs; 89 API, 85 browser; 14 provider; eight evidence browser journeys); 0074; 75 files / 86 tables; W2 36/40.
- Rev 102 (board reports from finalized sources) was in progress at that snapshot; migration 0075 reserved.

### 2026-09-28 — Revision 108 completion claim (later withdrawn) `[11][14]`

- Claim: all W0–W10 "fully implemented, tested, and verified". PR #92 merged to staging as `755f669`, 22 of 22 CI workflows passed. Contents: onprem Compose overlay, Ed25519 offline license, `GET /v1/system/license`, Helm onprem values, `scripts/bootstrap-onprem.sh`.
- **Withdrawn by Audit 91** (2026-09-30). Do not cite Revision 108 as completion.

### 2026-09-30 — Audit 91 and Revisions 109–119 `[16][A91]`

- Audit 91 at `3492ffa3ea5a19882c27c43efb31fdca069aa327` (staging = main; CI/Bandit/Trivy/Semgrep passed): no deployments or `deployed-acceptance.yml` runs recorded; W8, W9, W10 and release gates open; TS coverage check failed 7 of 14 modules (types 53.57%, ledger 32.69%, evidence 54.70%, Supabase 7.50%, UI 55.69%, web 15.90%, marketing 21.29%).
- Rev 109 PR #108 `c8bc9f9199e3778e0916c96cae15590649c59c0e`; Rev 110 PR #109 `11030d5bcfe7cb0acb46ca1052bc591222fbc1f0`; Rev 111 PR #110 `2689327c95e95511fb08631f22ac922bcb2632a3`; Rev 112 PR #111 `dfd27e96a0d48f489bf3f50acd982e4b71224a76` (28 PR checks; exact-staging CI/Bandit/Trivy/Semgrep green; local 88/88 browser journeys); Rev 113 PR #112 `40e06833707b065c9edd8a637821ef20dcffa655` (approval export honesty; 0085; 89/89 local journeys); Rev 114 PR #113 `5f87871` (board source snapshot, 0086); Rev 115 PR #114 `b29142e6ce491438b0df5d30e2a83e8fbb76aa67` (retained source/PDF versions); Rev 116 PR #115 `7ffaae9e6956d5c9267a522c72eef4fcb1a6255a` (board workflow; exact-merge security failed on `urllib3 2.7.0`); Rev 117 PR #116 `0b1f57adff20a13e7f08245b9cd4505e210720ff` (security failed on `PyJWT 2.14.0`, CVE-2026-101918); Rev 118 PR #117 `0a47343edcf921900e342917f691aed3a2d84cc5` (CI 36747100538, Bandit 36747100498, Trivy 36747100591, Semgrep 36747100556 all passed); Rev 119 PR #118 `56dfba9178fc96ddf69f9e38c072ca921937d5c9` (CI 36781339878 passed; auditor source-bound pack).
- Safety closures (109–112, 113) refuse unsourced board/statutory/Pramaan publication, caller-authored report output and report email dispatch. They are **not** W8 feature closure.
- Not proven: any deployment; W8 statutory/DPB/technical sources; approval-proof archive.

### 2026-10-01 — Revisions 120–121 and current state `[A98][brief]`

- Rev 120 (audit 98): `board_executive` Pramaan dossier source-bound; other types return `source_bound_dossier_required`; dispatch closed. Security finding: shared `service_role` could call founder-review/release/proof RPCs with caller-supplied actors; amended migration 0089 adds the `statutory_proof_writer` role (NOLOGIN, NOINHERIT, NOBYPASSRLS, assumable only by PostgREST `authenticator`), BFF-only. Local: 0000–0089 full DB suite pass; 16/16 test tasks incl. 1,474 BFF tests; focused provider journey 1/1; full owned-provider Chromium suite 12/12 with zero retries. Audit 98 notes older direct-`service_role` human/provider assertion paths (0076, 0069/0072, 0073, 0078, 0035/0055) still need a separate restricted-writer remediation. Git: PR #119 merge `38762c4` is in staging history.
- Rev 121: PR #120 (`codex/revision121-staging-acceptance-hotfix`) merged to staging at `41b70b6`, full CI green `[brief]`. Commit subjects in git include "fix: revoke founder-derived manager report access" and "test: replace forged report fixture with source-bound journeys".
- Consolidation: plan, progress, architecture and operator runbook merged into docs 20-23; old files 11-19 and `LIVE_FUNCTIONAL_FLOW_GUIDE.md` are stubs.
- State and blockers: see section 2. Not proven: everything in the "Open" column of section 1.

<!-- append new dated entries below this line, newest last -->

### 2026-10-01 — W8.5 provider gate, PR #121/#122, 0099 and integration findings (Claude session)

- **W8.5 browser gate.** The first 14-journey run on `d617c2a` died at journey 9 (a 300 s test timeout and a login redirect timeout) while many other Docker stacks ran; it was not counted. Re-run after clearing orphaned dev servers on the shared ports: `scripts/test-evidence-storage.py --directory .axiom-runtime/evidence-w85 --browser` with `AXIOM_PARITY_STATE_DIR=.axiom-runtime/parity-w85` passed 14/14, 0 unexpected/flaky/skipped, `--retries=0`, 5.3 min; summary recorded `gitRevision` `d617c2a`, `dirty: false`. Local fixture only. The harness defaults to `.axiom-runtime/parity`; without the env var it fails with FileNotFoundError.
- **PR #121** (`codex/revision124-approval-proof-archive` into staging). First CI run on `25dc2a3` had three red jobs: (1) Self-hosted Supabase topology: the CI job never ran `pnpm install`, so the new supabase-js probe could not resolve the package; fixed in `0b1fd0c`. (2) Container API/browser (W0): Playwright config requires `SUPABASE_ARCHIVE_WRITER_KEY` in its own process env when an acceptance target is set and `test-deployed-http.sh` never passed it; fixed in `346a3e9` (reproduced as a config-load throw; the full container run was not repeated locally). (3) W8 board build returned 503 once in CI; **cause not found**, it passed on the next run (`bfeaea1`: W8, W0, W1, topology green). `bfeaea1` also made the board assertion print the response body. The gitleaks step then failed on seven synthetic `*signing_key` fixtures in test files; suppressed by exact fingerprint in `.gitleaksignore` (`fee4d41`). Do not treat the W8 503 as explained.
- **PR #122** merged to staging as `711a319`: `dev-docker.sh --down` now stops (not removes) local containers; `--remove` keeps `temporal-db`/`supabase-db`; `--remove-all --yes`; `--volumes` also needs `--confirm-data-loss`; `--pause`/`--unpause` added. Stub-docker test `tests/scripts/test-dev-docker-lifecycle.sh` was mutation-checked and runs in CI. This resolves D12 for the local environment. Full CI on the exact merge SHA is recorded only once seen green.
- **0099 (local only, commit `45408b4` on `codex/revision124-ledger-proof-boundary`, with plumbing `5268267`, `b024407`, `43988fc`, test repair `4e9947b`).** Scoped ledger boundary: `service_role` loses `append_ledger`, `start_execution_batch` and DML on plans/actions; new `append_human_ledger` (human writer, tenant-member check), `append_agent_ledger` (agent writer; refuses human-authority action types by denylist, decision 2026-10-01), `start_claimed_execution_batch` (requires outbox claim, consumed token, approved or executing plan). 22 legacy proof RPCs are writer-only. Verified on a disposable DB: whole `tests/database` suite passes; new `ledger-source-boundary.test.sql` mutation-checked (4 grant mutations, 4 function-body mutations, 3 RPC re-grants). TS 1520 BFF tests, supabase 18, ledger 13, config 74; Python 376 before the last edit (partial re-run after). **Not verified:** real PostgREST gateway with the new role, e2e specs, helm render, parity scripts. Still a production blocker until integrated and re-gated.
- **Integration finding.** The 0099 stack and the statutory branch (`codex/revision125-pramaan-statutory-dossiers`, `798f317`) both descend from `df6af38`, not from `41b70b6`, and each carries a diverged older copy of the approval-archive work (its own `0090`). Merge must go in order: W8.5 (#121), statutory 0091-0097, 0098, 0099, always taking W8.5's `0090` byte-identical (migrations are checksummed). A merge-tree against the W8.5 branch showed about 37 conflicting files.
- **Agent incident.** A delegated agent ran `git stash pop` and applied the preserved "DPB 0091-0092 before W8.4 integration" stash (`f63c8ed`) into the approval-reconciliation worktree. The stash was re-stored on the stack under the same SHA; the worktree still holds the popped files until the operator removes them (P0-10). No agent may run `git stash`.
- **Design system.** The claude.ai design file requires a login; not reviewed. Operator item P0-9.
- **PR #121 merged to staging as `6dab9ac`** after all 28 checks passed on source `fee4d41` (staging `711a319`, the PR #122 merge, had full CI success first). CI on the exact merge SHA `6dab9ac` is not yet recorded here; do not call W8.5 closed until it is.

### 2026-10-01 — Staging merges #122-#124, integrated 16-journey gate, 0099 stack in PR #125 (Claude session)

- **Staging order and CI.** PR #122 (`dev-docker.sh --down` only stops local containers) merged as `711a319`; PR #123 (these docs) as `2a8b191`; PR #124 (statutory dossiers on W8.5, migrations 0091-0097) as `a8ce820`. `711a319`, `2a8b191` and `a8ce820` each have full CI success on the exact SHA. `6dab9ac` (PR #121's merge) had one red job: the W8 real-provider browser job returned `report_renderer_unavailable` (503) on the first board PDF build. Its re-run was cancelled by the next push, so it stays recorded as red.
- **Renderer 503, unexplained.** The same journey also returned 503 once on PR #121's first CI run and passed on the next. The Chromium renderer tries `--headless=new` then `--headless`, each with a 30 s timeout, and every cause was discarded. `f34fef6` now carries a short log-safe reason through the renderer and the four artifact services (unit-tested, mutation-checked), so the next occurrence reports timeout, signal, exit code or stderr tail. The cause is not known; do not treat it as fixed.
- **Integrated gate.** The first integrated run of W8.5 + statutory passed 13/16 and exposed three real defects, fixed in `859dfaa` with mutation-checked tests: the web schema rejected the BFF's identifier-only settled build answer; the source dropdown requested `limit=100` against a BFF cap of 50 (400 `validation_failed`); a settled card with no PDF receipt never re-read. The run on `859dfaa` passed 16/16, `--retries=0`, `dirty: false`.
- **PR #125 (open): 0098/0099 ledger boundary + W9.** Local gates: full `scripts/test-database.sh`, workspace typecheck/lint/test/format, security scan, agent-runtime pytest 377, real-gateway probe in `tests/deployment/selfhosted-supabase.sh`. The first local 16-journey run on this stack passed 14/16: two journeys, the persona seeder and strict parity forged plan rows through the service key, which 0099 rightly refuses (no product code writes plans through it). They now write through a loopback-only database-owner helper (`scripts/lib/local-fixture-db.ts`, table allow-list, identifier-checked columns); the run on `d8bf462` passed 16/16, `dirty: false`. PR #125's first CI run also failed five jobs: the same fixtures (W1, W8, strict parity), `sync-env.sh` unable to write the map-typed `cloud_sql_authorized_networks` variable W9 added (W0.1), and the container job passing no human/evidence writer key to strict parity (401). All three causes are fixed and pushed (`bc0e9e3`); CI on that commit is not yet recorded here.
- **Not proven for PR #125.** Helm render (helm not installed locally), any deployed environment, and remote-target plan fixtures: a remote acceptance target now refuses to seed plans with a clear error because it has no owner connection; it needs an operator database path. `release_approval_proof_archive` still appends a human-labelled event through the archive writer.
- **W10.** The offline/air-gapped branch was merged locally onto the 0098/0099+W9 stack as `integrate/w10` (`951a957`, plus test repairs `042aace`). Workspace typecheck, lint, test (web 579, bff 1562) and format passed; two agent-runtime onprem config tests and a compose-scoping unit test failed because W10 predates 0099 and were repaired. It is not pushed and its live acceptance (pinned images, licence, signed backup, S3 policy, isolated target) has not been run.

### 2026-10-01 — Staging merges #125-#128, main promotion #129, branch cleanup (Claude session)

- **#125 (0098/0099 + W9) merged to staging as `3ce13d9`** after exact-SHA CI on `2e289ae` was fully green. Four defects surfaced on the way and were fixed: the isolated worker acceptance registered workload identities through `service_role` (0098 made `manage_workload_identity` human-writer-only; now uses the human writer, `42bef72`); `check-coverage-floors.sh` called `rg`, which runners lack, then died silently because CI's vitest prints either an `All files` table row or only a `Lines :` summary (it now reads either, `335f8e8`); gitleaks flagged one synthetic object-key fixture in `packages/evidence/src/storage-acceptance.test.ts` (ignored by exact fingerprint, `2e289ae`); and the branch conflicted with the #126/#127 merges in `ci.yml` (kept both steps).
- **#126 (docs) `19636cf` and #127 (renderer warm-up, `tests/scripts` unit tests in CI) `0003f00` merged**; staging `0003f00` had full exact-SHA CI success.
- **#128 (W10) merged as `8700264`.** Two repairs: two Terraform test files were not `terraform fmt` clean, and the on-prem licence gate (verifies against the fixed Axiom root key) refused every route of the in-process strict-parity BFF. The harness now signs a short-lived licence with a throwaway authority and injects that trust root through `createApp({ licensePublicKeyPem })`; it is not an environment setting, so a deployment cannot use it. A unit test proves the key is forwarded and fails if the forwarding is removed. The W8 browser job failed once with the known first-PDF `ECONNRESET` through the Next proxy and passed on re-run; its warm-up took 121 s on that runner, which points at a slow cold Chromium start. The root cause remains unconfirmed (P1-W8c).
- **Main promotion.** Staging `8700264` (CI, Bandit, Semgrep, Trivy green on the exact SHA) was promoted by PR #129 with a merge commit to main `06bd190`; exact-SHA CI on main is green. No deploy ran.
- **Branch cleanup.** Backup first: `~/axiom-proof-branch-backup-20261001.bundle` (verified) plus a ref list. Classification found 141 branches fully contained in staging; the 20 with unique commits were the #125/W10 lineage or older `codex/*` checkpoints already superseded by integrated work (for example `plan-reject.test.ts` was deliberately replaced by `plan-reject-scoped.test.ts`). Removed 17 clean worktrees, 119 local branches and 41 remote branches. Kept: `main`, `staging`, the working branch, five open Dependabot PR branches, and the two branches whose worktrees hold uncommitted changes. Leftovers are operator item P2-15.
- **Not proven.** Any deployed environment, W9 live NFR measurements, W10 live acceptance, the renderer flake root cause, and the Claude design-system pass (login required).

### 2026-10-01 — Dependabot merges, renderer investigation (Claude session)

- **Dependabot #130-#134 merged to staging.** The three CI-action majors (`setup-helm` 5, `setup-cli` 3, `download-artifact` 8) were merged by the operator and staging `b463ce7` had full exact-SHA CI success. #133 (hono 4.13.10) failed W0, SPIRE and workload-identity parity: hono changed an inferred type so `boundedJsonBody`, `evidenceBodyLimit` and `reportBodyLimit` could not be named under declaration emit (TS2883, acceptance `tsc`); explicit `MiddlewareHandler` return types fixed all three (`feca7a3`). #133 merged as `bb3e5a4`, #134 (turbo) as `91eb5cb`.
- **Renderer investigation (#136, merged `388ae65`).** CI showed every PDF render's first browser attempt killed on timeout and the second succeeding (warm-up about 121 s; seven renders in one journey run). Two hypotheses were tested and refuted: the headless mode order (the first-run attempt hangs in either mode) and helper processes holding stderr (the failure persisted after the runner waited on `exit` and killed the process group). What merged is hardening and diagnostics, not a fix: classic `--headless` first, the fallback reason logged, an exit-based runner in its own process group, and fake-browser tests (restoring `close`-based waiting fails one, restoring the old order fails two). The remaining signal is Chrome's Google-services registration errors on a fresh profile. Open as P1-W8c with next experiments.
- **State.** Staging and main are otherwise level except these merges; promotion of the final staging head follows once its exact-SHA CI is green.

### 2026-10-01 — Branch analysis and the design-system pass (Claude session)

- **Protected branches analysed.** Both branch tips are in main with no unmerged commits. `claude/axiom-proof-phase-gap-closure-b88105` (tip 2026-09-21) was not the last active branch; its 8 uncommitted files are Prettier-only (quote style, wrapping, table alignment). `codex/revision124-approval-proof-archive`: all 19 uncommitted files exist on staging in evolved form (9 identical); the differing lines are the pre-0098/0099 versions (direct `service_role` plan update, `service_role` grants in the DPB migration, the strict artifact schema that caused a fixed defect), so adopting them would regress the security boundary. Nothing was deleted; both are safe to discard.
- **Design project read** through Claude in Chrome ("Axiom Proof Design System": App 21 screens, Site, Design System, Handoff Map). Its `navDef` and `genericMeta` define each module's title, Hindi name, phase, module id and owning agents.
- **Design-system pass, first slice.** `@axiom/ui` gains `ModuleContext`, `RelatedAgents` and `DataPlaceholder`, and `PageHeader` takes an optional `module`; `apps/web/src/lib/module-meta.ts` is generated from the design's metadata for all 21 routes (module ids for approval M3.3 and assessment M0.3 come from docs/02, the dashboard has none). The strip names agents only and never claims a status, and the placeholder never shows sample values (the app's no-fabricated-data rule). Applied to dashboard, approval, evidence, ledger, assessment and workbench by three parallel agents, each mutation-checked; independent verification: typecheck 16/16, UI tests 54, web tests 591. Hindi names sit outside headings so Playwright heading assertions are unchanged. The first Playwright run on these pages is the CI job. Remaining routes and `/design-sync` are P1-DS1 and P1-DS2.
- **Runbook.** New section 2a is the ordered action list for the operator. Duplicate ids fixed: the design-system item is now P0-15 (done), the stash item P0-16, and the renderer item P1-W8d (earlier entries above still say P0-9, P0-10 and P1-W8c for those).
