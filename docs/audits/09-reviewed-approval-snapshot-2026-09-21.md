# Review follow-up — MFA-bound approval snapshot

Reviewed staging `369bcf7` on 21 September 2026. Atomic issuance (0026), its schema-portability correction and claim-time enforcement (0027) were integrated and preserved. Applied migration files were not edited.

## Finding and correction

**High: the signed snapshot could differ from the MFA-bound snapshot.** `POST /v1/plans/approve` read actions, verified and consumed a challenge bound to those actions, then fetched `action_set_content_digest` from live rows. An edit between consumption and that second read was signed as the new expected digest. The issuing transaction checked the new content against itself, so neither the MFA binding nor the locked comparison refused it. Existing tests simulated edits after digest acquisition and missed this earlier window.

Regression evidence: injecting a parameter replacement or a dry-run-result replacement immediately after successful consumption returned HTTP 201 on staging code. Both now return 409, with zero approval tokens and zero approval ledger entries. A plan-revision edit at that boundary also refuses.

0028 adds `reviewed_action_content_digest`, a pure helper over the exact server-read rows used by the MFA binding. The live-row digest delegates to that same helper, with byte compatibility against the previous SQL implementation verified on nested JSON, Unicode and unordered finding IDs. The new `issue_reviewed_plan_approval` locks the plan, checks the reviewed version and eligibility, confirms the signed digest matches the expected digest, and delegates to the existing atomic transaction. The old issuance RPC loses service-role execute permission. Client roles cannot call the new functions.

Actual PostgreSQL concurrency tests hold a content/revision writer transaction open, observe issuance blocked on its lock, commit the writer, and assert refusal with no authority persisted. Existing ledger-failure and claim-snapshot tests still pass. The helper stays inside the existing database; no action content is sent to an external provider.

## Acceptance and limits

258 BFF tests, typecheck/lint; migrations through 0028, ten SQL suites, four concurrency suites, DSN migration/deploy refusal suite, and all four real Auth/MFA parity labels pass locally. Final staging CI is checked after push. The API's approved scopes and MFA policy are unchanged; challenge consumption remains outside issuance deliberately.

Migrate before deploying the BFF; the old entrypoint fails closed during a mixed-version rollout. No live deployment, irreversible evidence lock or connector execution was performed. W0/W1/W2 remain partial. Browser personas and MFA key rotation are the next independent W1 work; executor-side snapshot verification must accompany the real W4/W5 executor, not an additional check around its refusal stub.
