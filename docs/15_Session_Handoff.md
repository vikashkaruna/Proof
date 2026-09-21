# Saved implementation session — 21 September 2026

Fetch staging first; the merge containing this file is the checkpoint. Plan **Revision 28**, migration tip **0035** (36 files, 51 public tables). Reviewed upstream **d386fad**, green CI [35628480541](https://github.com/vikashkaruna/Proof/actions/runs/35628480541); no newer other-model work appeared. Read Docs 11, 16, [17](17_Deployed_Acceptance.md) and [review 17](audits/17-deployed-acceptance-review-2026-09-21.md).

## Completed and verified

- Earlier W3 inventory (0034) and reviewed onboarding (0035) remain delivered. Staff prepare immutable proposals; different client owners **or tenant admins** approve. Full wizard/sustenance are still open.
- W0 harness engineering: target-aware HTTP and browser runners; real MFA enrollment without backend keys; exact BFF/web/marketing revision preflight; private target-bound state; sanitized successful reports and comparison. Automatic CI uses two local production-container configurations; manual CI compares two isolated remote deployments.
- Cloud Run binding fix: BFF uses managed anon/service secrets; SSR gets managed anon fields only. Terraform validate and three negative wiring mutations pass. A CI gate checks the actual env bindings.
- Additional review fix: explicit scoped SSR configuration excludes backend secrets, while ambient frontend hints can no longer weaken backend validation. Missing Docker workspace manifests and private build-context exclusions fixed.

Local validation: 59/59 browser journeys in **each** preprod/production container configuration, identical API outcomes; original 59 dev-server journeys; 309 BFF and 54 config tests; 24 harness checks; all 14 workspace test tasks; lint/typecheck/security gate. Initial Docker registry errors resolved on retry. Pre-commit rehearsal is implementation evidence; exact committed merge/CI is saved in ignored `.axiom-runtime/session-checkpoint.json`. Remote deployment is not claimed.

## Next work, in order

1. W0 remote acceptance needs isolated targets provisioned by the operator, current migrations and trusted images at one exact revision. Use Doc 17, not PLAYWRIGHT_BASE_URL alone. CI manual dispatch also needs workflow promotion to the default branch. EKS CIDR policy remains an operator decision. Harness engineering no longer waits on provisioning.
2. **New W0 follow-ups:** marketing `gap-scan-store.ts` still uses an admin client/process-memory fallback; move storage to BFF and add durable cross-process submission/report tests. Current 59 journeys do not cover that full funnel. Cloud Run uses a shared service account; per-service IAM isolation is also pending. Neither is fixed by environment-field separation alone.
3. **W1 invitation lifecycle/delivery** remains independent engineering work; do not send real third-party mail during development. E.2.3 recovery-replacement session policy remains unanswered and separate from the accepted onboarding-admin decision.
4. **W4.1 registry/contracts/lifecycle**, then W4.2 broker, W4.3 workload identity and W4.4 live grants. Reuse seven tables from 0033. Activation must serialize with estate/system lifecycle checks. No connector execution exists merely because metadata tables exist.
5. Complete W3 resumable company→estate→inventory→connector/grant→readiness wizard and W3.5 live graph against enforced W4 permissions. Initial proposal review imports the retained intake as one batch; exclusions, later batches and unsent draft autosave remain pending. W2 named targets remain **19/40**, with 21 absent; execution-detail groups depend on stable W4 permissions.

## Workspace and operation

Worktree `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`, branch `codex/w0-w3-closure`. Preserve root and Claude worktrees. Implementation, tests, docs and staging merge pushes are authorized. No new billable/irreversible cloud deployment authorization. No client-system writes or evidence retention changes.

Local Docker Supabase project `axiom-w0-parity`, API 56321, DB 56322, through 0035. Acceptance application containers are removed after each rehearsal; private fixture state remains under ignored `.axiom-runtime`. Never publish private target/persona files, raw reports or traces. `scripts/test-deployed-http.sh --browser` requires a clean committed tree. Chrome override: `AXIOM_E2E_BROWSER_CHANNEL=chrome`; CI uses Chromium.

Next migration **0036 only after fresh fetch**; published migrations append-only. Higher environments dynamically deploy self-hosted Supabase. TOTP/recovery only; email OTP deferred. Fresh human approval for execution redelivery, no automatic retry. Sudhaar holds no client-system credentials. Ledger writes use append_ledger. Restore generated next-env.d.ts before commits; do not pop the superseded browser-prototype stash. Verify ancestry before diagnosing cancelled CI runs.
