# Saved implementation session — 21 September 2026

Fetch staging first; the merge containing this file is the checkpoint. Reviewed upstream **47685ab**; CI caught a missing `rg` dependency in the concurrency script, fixed with portable `grep` in this checkpoint. Current plan: **Revision 24**, migration tip **0032**. Read [Doc 11](11_Phase0-5_Gap_Closure_Plan.md), [Doc 16 operator runbook](16_Operator_Completion_Runbook.md), and [review 13](audits/13-atomic-mfa-recovery-review-2026-09-21.md).

## Delivered and verified

- Preserved upstream atomic authenticator replacement and its real browser tests.
- C-W1-1: purpose-bound revocation UI; SQL transaction revokes credentials and MFA session assurance together. Late login attestations cannot survive revocation; both race orderings tested with real PostgreSQL sessions.
- C-W1-2: quarantined first enrollment, save recovery codes, explicit continuation to login verification. Activation alone never opens protected API access.
- 0032 makes activation/recovery rotation atomic, reports persistence errors as 503, and retires old recovery rows without deleting their history.
- Recovery-code reads/claims and TOTP counter claims reject revoked rows.
- 286 BFF tests, 55 browser journeys, 33 migrations, five concurrency suites, DSN/fault/upgrade checks, real Auth parity. Prior UI and removed status filters fail the added regressions. Final staging CI checked after push; exact merge/run recorded in ignored session checkpoint.
- Corrected target count: W2 lists 40 names, 12 delivered, 28 absent. Updated operator runbook ownership and deployment command caveats.

## Next, in order

1. W2 connector schema batch: seven tables in dependency order. MFA activation/recovery rotation is now atomic via 0032; SQL fault injection and a populated 0031 upgrade are green. Next migration allocation is 0033 after a fresh fetch.
2. Implement E.2.3 once the user answers the pending question: whether recovery-based replacement ends existing MFA attestations. Do not infer an answer. Explicit revocation already ends assurance; replacement has a different policy.
3. W2 connector schema batch in the runbook's dependency order; W3 estate API/UI and explicit human scope assignment, proposal normalization. Do not invent assignments or execute scans.
4. W1 invitation workflow/adapter can be built before provider provisioning; deployed delivery and MFA acceptance need operator evidence. W0 deployed harness still needs engineering; local four-label parity is not deployed evidence.
5. W4 grants/connectors before W5 executor. W5 still intentionally refuses live mutation; no Phase 3 completion claim.

## Workspace and constraints

Active worktree: `/Users/vikash/.codex/worktrees/w0-w3-closure/Axiom Proof`, branch `codex/w0-w3-closure`. Preserve root/Claude worktrees and their changes. User authorizes implementation, tests, documentation and merge pushes to staging at each logical completion. No cloud apply, real immutable retention or other billable/irreversible deployment was performed or newly authorized.

Local Docker project `axiom-w0-parity`, API 56321, database 56322. Credentials remain ignored under `.axiom-runtime`; never print them. Higher environments self-host Supabase. TOTP/recovery only; email OTP deferred. Fresh human approval for each execution redelivery; challenge consumption deliberately outside issuance. Planning agent holds no write credentials. Ledger uses append_ledger.

Browser tests use synthetic per-journey accounts for credential mutations and can use installed Chrome via `AXIOM_E2E_BROWSER_CHANNEL=chrome`; CI uses pinned Chromium. Restore dev-generated `apps/web/next-env.d.ts` and marketing equivalent before commit. Do not pop the superseded strict-browser prototype stash. CI cancels prior staging runs on newer pushes; inspect head/ancestry before diagnosing cancellation.
