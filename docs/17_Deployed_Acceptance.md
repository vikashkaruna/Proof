# Deployed acceptance: API and browser parity

## Session close-out and handoff — Revision 88 (2026-09-25)

**Where to continue:**

- Work from branch **`codex/revision75-controller-generation-transition`**, cut fresh from `origin/staging` (currently at Revision 88, merge commit `cfe985d` of PR #56).
- Open every PR into **`staging`** with a merge commit, and merge only when all checks are green.
- **Promotion to `main` is paused by the operator.** Main was last promoted at Revision 84 (PR #55, 52 checks green). Staging is ahead with Revisions 85–88 and the dependency updates (PR #57). Promote only when the operator asks, using a staging → main PR merged with a merge commit.
- To start: `git fetch origin staging && git checkout -B codex/revision75-controller-generation-transition origin/staging`.

**State at close:**

- Schema is **0000–0059: 60 migrations, 61 public tables**. The next migration is **0060**; never edit an applied migration.
- Latest audit is **76**.
- No PRs are open and no check-ins are scheduled.

**Build and test status** (staging, PR #56 head `bc176d5`, 21 of 21 CI checks green):

| Suite                                 | Result                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| BFF (vitest)                          | 1089 passed, plus 5 live PostgreSQL tests that run in the "Live SQL binding (W4.6)" job |
| Web                                   | 89                                                                                      |
| MFA                                   | 180                                                                                     |
| Control library                       | 83                                                                                      |
| Config                                | 68                                                                                      |
| Types                                 | 45                                                                                      |
| Evidence                              | 19                                                                                      |
| UI                                    | 17                                                                                      |
| Approval engine                       | 13                                                                                      |
| Supabase                              | 11                                                                                      |
| Ledger                                | 8                                                                                       |
| Marketing                             | 6                                                                                       |
| Database suite                        | Fresh migrations with `service_role nobypassrls`, every `tests/database/*.test.sql`     |
| Browser persona journeys (W1)         | Green, including the tool-registry, PNG/SVG export and grant journeys                   |
| SPIRE (W4.3)                          | Isolated, protected-host and native-runner jobs green                                   |
| Strict Auth/PostgREST parity          | Green                                                                                   |
| Container API/browser acceptance (W0) | Green                                                                                   |
| Python                                | Agent runtime, temporal workers and model gateway suites green                          |
| Security                              | CodeQL, Bandit, Trivy, semgrep and gitleaks green                                       |

The local gate `scripts/security-scan.sh` runs on the husky pre-push hook.

**Operator decisions in force (2026-09-25):**

1. The three held historical secrets stay held, not ignored, until the operator confirms rotation. They are two JWT secrets in `infra/docker/docker-compose.supabase.yml` (commit `7719f0c`) and `APPROVAL_SIGNING_KEY` in `infra/docker/environments/.env.preprod.example` (commit `7631b1f`).
2. `main` branch protection is done.
3. Stale branches are deleted together after plan completion.
4. Dependabot #32–36 are closed out and their updates landed via PR #57. `tailwindcss` 4 and ESLint 10 are held back: the major-version migration and `scopeManager.addGlobals` breakage respectively.
5. `saml2_bearer` is a TODO, not a blocker.
6. Sector pack #1 will be chosen when W7 is reached.
7. Promotion to `main` is paused.

When operator input is missing, take the recommended option and record the assumptions in the revision's audit.

**Standing constraints:**

- Never provision or apply cloud resources.
- Keep all of the following:
  - tenant-bound approval with dry-run and validated rollback (BR-2);
  - Sudhaar holds no write credentials;
  - the append-only ledger, written only via `append_ledger`;
  - WORM Compliance mode;
  - `ap-south-1` data locality.
- Never print credentials.
- Every new ledger action must also be added to `LedgerActionType` in `packages/types/src/enums.ts`, or the compatibility test fails.
- E2E workload fixtures use `registerWorkload()`. The `manage_workload_identity` RPC is the only registration path.

**Recommended next order:**

1. **W5 execution loop (XL):** an executor that consumes the dispatch outbox under a signed token, a dry-run simulator, rollback, and post-verification. It adds the 5 execution-detail tables, with PRD B.10 as the acceptance criteria. Its write path needs a W4.6/W4.7 write adapter bound to the approved plan.
2. **W6 continuous compliance (XL):** scheduler and scheduled drift and discovery, reusing `onboarding_estate_drift` and `/internal/discovery/run`; standing policies; monitor health; 4 tables.
3. **W8 rights, consent, breach, and review/release (XL).**
4. **W7 multi-regulator tables and packs (L)**, which needs the sector pack #1 decision.
5. **W9 performance and restore drills, and W10 on-prem (L each)**, which need a deployment.

Smaller leftovers:

- MySQL SQL binding;
- an RDS staging acceptance run (operator);
- vendor-verified descriptors (need client tenants);
- `saml2_bearer`;
- W3.5 derivation edges (need a lineage model), live updates and branded export;
- a web view of discovery runs;
- five web screens that still fabricate values (queued task);
- the unused `SUPABASE_SERVICE_KEY` in the Helm web and marketing charts;
- Bandit medium findings in the test-harness SQL.

## Revisions 75–88 — deployed acceptance status (2026-09-25)

**No deployed acceptance has been run for Revisions 75–88.** Every result below comes from CI or local runs against disposable containers. None was run against a provisioned environment, because cloud provisioning is not authorized in-session.

| Item                                     | CI or source evidence                                         | Deployed acceptance still owed                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0.1 API and browser parity              | Container API/browser acceptance and strict parity jobs green | Two remote deployments compared by the manual lane                                                                                                                    |
| W1 invitations (Rev 78)                  | Persona journeys green                                        | Real mail provider and domain delivery                                                                                                                                |
| W3 onboarding and sustenance (Rev 79–80) | Database suite and persona journeys                           | None beyond W0.1                                                                                                                                                      |
| W4.3 SPIRE workload identity             | Isolated, protected-host and native-runner jobs green         | SPIRE on the target cluster                                                                                                                                           |
| W4.6 SQL discovery (Rev 84, 87)          | Live PostgreSQL 16 job green                                  | RDS in `ap-south-1` with an `rds_iam` SELECT-only role and pinned CA; enable `/internal/discovery/run` with SPIRE trust and broker KMS configuration (runbook doc 16) |
| W4.7 REST and GraphQL (Rev 85–86)        | Loopback reference servers                                    | Vendor tenants for vendor-verified descriptors                                                                                                                        |
| W8 WORM retention                        | Not provable in CI                                            | Object Lock Compliance bucket evidence                                                                                                                                |

Promotion to `main` is paused by the operator; staging holds Revisions 85–88.

## Revision 74 — reviewed controller credential issuance

**Verified baseline:** Revision 73 is complete on staging `5efb40d8d6b6e0a0788b961d028d0203fa608e97`; [CI 35890118690](https://github.com/vikashkaruna/Proof/actions/runs/35890118690) passed all **19 applicable jobs and 13 exact-revision reports**. [PR 39](https://github.com/vikashkaruna/Proof/pull/39) is merged. The full roadmap remains active and incomplete; continue in plan order after each green milestone.

**Implemented, source acceptance passed:** an isolated manual operator CLI now creates protected tenant-scoped controller credentials, records immutable reviewed issuance/retirement, permits one successor per predecessor, recovers an uncertain result only through explicit identical-request resume, and permanently revokes retired authority. Signing and operator database credentials stay outside runners. The private issuer role has no application/table write grants or provisioned login/membership. Its change-record UUID is not proof of human signature and never replaces application approval/dry-run/rollback rules. No public issuance route or automatic renewal was added.

Actual CLI and BFF-consumer acceptance against the existing isolated Docker backend passes **eight new checks**, bringing assessment to **86 outcomes** with all prior 78 retained; identity remains 61 and protected trust five. A clean-database extension-schema failure is corrected by append-only migration 0051, preserving already-applied 0050. All 197 deployment tests, the full database concurrency/upgrade suite, workspace checks and control/security gates pass. Source [CI 35896023384](https://github.com/vikashkaruna/Proof/actions/runs/35896023384) passes all **19 applicable jobs and 13 exact-revision reports** for source `5577b78` (tested PR integration `8a4ef5e`). All 86 assessment outcomes retain the previous 78; native runner remains 45, and both topology labels retain identical 89 API/67 browser outcomes. Hosted deployment passes 197 tests, 26 module Terraform cases, nine root cases and the IAM inventory gate; enforced dependency and secret scans pass. The final exact staging-merge gate is recorded after verification in `.axiom-runtime/revision74/completion.json`. See [audit 63](audits/63-controller-credential-issuance-review-2026-09-23.md) and the [issuer operator contract](../infra/credential-issuer/README.md).

**Next and limits:** renewal creates a reviewed fresh credential; it does not switch a running host. Protected generation transition and actual secret publication remain next, followed by effective inherited/cloud IAM, private TLS/DNS, opaque scheduler and real GCP IIT/caller/KMS/Mumbai recovery. No cloud provisioning/apply is authorized or performed. W0/W1/W2/W3/W4 stay partial, W2 **19/40**, schema **0051 / 52 migrations / 55 public tables and three private credential tables**. Source/staging results are recorded only after verification in this task's `.axiom-runtime/revision74` checkpoint.

This runner creates synthetic tenants, accounts, MFA factors, assessments, estate inventory, connector registrations, proposals and approval fixtures. Use an **isolated acceptance deployment**, never a client production database. A production-configured acceptance stack uses production security rules with synthetic data. It does not execute connector actions. Fixture rows and append-only ledger events remain after the run; reset/dispose of the isolated database through its normal operator lifecycle. Do not delete audit history to clean up a shared deployment.

**Registry recovery source gate passed:** initial staging `88b2f31` (PR 40) failed before tests in CI 35897974592 attempts 1 and 2 on image registry/auth/rate-limit startup errors. PR 41 clears the setup action's GHCR-only override at three CI steps, restoring the pinned CLI registry fallback without changing image versions or checks. Renewed [source CI 35898949282](https://github.com/vikashkaruna/Proof/actions/runs/35898949282) passes **19 applicable jobs and all 13 exact-revision reports** for source `0b37017` (PR integration `b8e1168`). It retains all 86 assessment and 45 native runner outcomes, 197 deployment tests and identical API89/browser67 across both configurations; enforced security scans pass. Only renewed exact staging acceptance can close the milestone; its result is saved in `.axiom-runtime/revision74/completion.json`. See audit 63 for the failed-attempt evidence and limits.

## Prepare the target

1. Deploy BFF, web and marketing from the same clean Git revision. Supply `--build-arg AXIOM_RELEASE_SHA=<40-character SHA>` to each Docker build. The image retains that revision; do not override it with an unrelated runtime value. The preprod image builder supplies it for clean checkouts. A dirty build has no trustworthy release identity.
2. Use `ENVIRONMENT=preprod`, `production` or `onprem` and `AXIOM_AUTH_MODE=strict`. Apply all migrations (currently 0000–0040). Keep external contact email disabled and BFF `AXIOM_REPORT_EMAIL_MODE=disabled`; preflight refuses enabled report delivery or a contact delivery key. The fixture setup seeds the published control library if absent and refuses a conflicting count; it never overwrites existing control rows. Ensure all endpoints are reachable from the runner.
3. Populate a private JSON file using [ACCEPTANCE_TARGET.example.json](ACCEPTANCE_TARGET.example.json). Obtain credentials through the environment's secret store, not chat or shell history. `anonKey` is the JWT anon key; `publishableKey` is the API gateway key (or the same anon key for legacy self-hosted deployments); `serviceKey` is the service-role JWT used only by fixture setup. The BFF's MFA encryption/signing keys are never supplied to the runner. SSR requires only the scoped public Supabase connection, not the service-role, signing or MFA encryption keys.
4. Store the file under ignored `.axiom-runtime`, with mode `0600`. Set `topology=remote` for HTTPS deployments; loopback HTTP is permitted only with `topology=local-docker`. `syntheticFixtures=true` explicitly confirms the target's fixture purpose. Use a different `deploymentId` per deployment. Set `expectedRevision` to the deployed source SHA.

## Run and compare

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

The runner verifies strict BFF identity and unauthenticated refusal before seeding. Browser setup also checks web/marketing revision and security configuration. It enrols fixture MFA through the actual BFF, then drives the same Playwright journeys as local CI. Target-bound persona state prevents accidentally mixing local credentials and deployed URLs. `PLAYWRIGHT_BASE_URL` alone is refused.

Only `api-results.json` and `browser-results.json` are suitable for CI artifacts. They contain allowlisted scenario names/outcomes and deployment metadata, no credentials or response bodies. Raw browser JSON/logs and persona state are private; deployed traces, screenshots and video are disabled. Failed/flaky/skipped browser runs cannot produce successful comparison evidence. Compare artifacts from the same CI run and revision; timestamps are recorded for traceability, not an assertion of indefinite validity.

## CI and Docker rehearsal

`.github/workflows/deployed-acceptance.yml` manually runs preprod against either production-configured or on-prem acceptance. Configure GitHub environments `preprod-acceptance` and the selected comparison environment, each with the secret `AXIOM_ACCEPTANCE_TARGET_JSON`. Both deployments must run the requested revision. The final job compares both successful API and browser suites and refuses divergence, repeated endpoints, mismatched revisions or local/remote substitution. Use trusted reviewed revisions only: the workflow receives fixture-administration credentials. GitHub manual dispatch requires this workflow to be present on the default branch; pushing it to staging alone does not run or provision it.

Automatic staging CI runs `scripts/test-deployed-http.sh --browser`: two separate sets of production-mode BFF/web/marketing containers, configured preprod/production, sharing the isolated local Docker Auth/Postgres stack. It verifies the HTTP runner without claiming cloud deployment. For the full local production-container rehearsal:

```bash
# Install Playwright Chromium first, or use AXIOM_E2E_BROWSER_CHANNEL=chrome locally.
./scripts/test-deployed-http.sh --browser
```

Run it from a clean committed checkout; it refuses to stamp uncommitted source with a release SHA. This adds web and marketing containers on separate ports for each configuration, without backend credentials in SSR. SSR→BFF uses private Docker DNS; browser/test ports stay bound to host loopback on both Linux and Docker Desktop. It compares the API results and the complete browser journeys. Only its own application containers are removed afterward; the isolated Supabase project remains for inspection. Local Docker evidence cannot close remote W0 acceptance. No cloud resources are created by either test runner.

## Durable gap-scan restart probe

The local container runner automatically submits a synthetic report, restarts both BFF and marketing processes, waits for health, and checks that the owning browser capability still reads the report while anonymous retrieval and resend fail. Successful checks add three boolean outcomes to the same sanitized API result file. The private capability remains in `gap-scan-private.json` and must never be uploaded.

For an isolated remote deployment, run the ordinary API/browser acceptance first, then:

```bash
export AXIOM_ACCEPTANCE_TARGET="$PWD/.axiom-runtime/preprod-target.json"
pnpm exec tsx scripts/verify-gap-scan-durability.ts prepare
# Operator: restart all BFF/marketing replicas without replacing the database.
# Retain deployment restart evidence; the probe cannot prove an operator restarted them.
pnpm exec tsx scripts/verify-gap-scan-durability.ts verify
```

Repeat for the comparison target before comparing API artifacts. The manual workflow runs API/browser checks but does not restart remote services; remote durability closure needs this separate operator evidence. The capability is bound to the target URL and source revision. No real email is sent; disabled dispatch returns unavailable, not simulated success. This checks persistence/ownership, not questionnaire scoring accuracy or contact inquiry durability.

Vault and OAuth broker core acceptance is covered by SQL/crypto/adapter tests and isolated HTTP/TLS authorization-server fixtures. The existing browser/API parity suite does not acquire client tokens or exercise cloud KMS/SPIRE. Deployed workload/grant authority, real KMS and client execution require separate evidence (Doc 16 W4-2); the broker defaults to deny-all.

## Isolated workload identity acceptance (W4.3)

`python3 scripts/test-workload-identity.py` runs real SPIRE issuance and the BFF identity verifier in a fresh local Docker fixture. CI publishes only `workload-identity-acceptance/results.json` (61 allowlisted outcomes, source revision and dirty status). It is separate from the 63-browser/89-API application parity suite. A passing identity fixture does not prove deployed workload isolation, live task/grant authority or connector execution. See Doc 16 W4-3 before enabling any acquisition route.

## Runtime audit acceptance (W4.3)

After local parity-stack startup, run `uv run python ../../scripts/verify-runtime-audit.py` from `services/agent-runtime`. Five real-Postgres outcomes check durable strict-mode appends, numeric receipts, redacted metadata, digests and the actual ledger chain. CI includes this in the strict Auth/PostgREST lane and publishes only `runtime-audit-acceptance/results.json`. Synthetic tenant/audit records remain; never delete audit rows as cleanup. This probe does not replace workload/task/grant enforcement or demonstrate client execution. Unit fault injection separately covers start/completion failures and secret-bearing exceptions.
