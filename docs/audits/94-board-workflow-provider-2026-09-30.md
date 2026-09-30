# Revision 116 — board workflow and provider acceptance (2026-09-30)

## Scope and result

Revision 115 retained exact reviewed board source and PDF versions but exposed no complete manager/founder workflow. Revision 116 adds bounded assessment and request lists, plus a board artifact status projection. Reads check current tenant membership. A requesting owner or admin sees only their own requests and no private draft content or retained version metadata before publication. A current Axiom-internal founder can see the tenant queue, pending operation key, provider outcome and exact retained digests and versions. Object keys, buckets and provider receipts do not cross the read API.

The reports page now lets an owner or admin request a board draft from a finalized assessment. The internal founder generates and reviews its source-bound content, builds or reconciles the retained source/PDF versions, explicitly retries only a provider-confirmed missing object, previews the exact PDF and releases against both reviewed-content and PDF hashes. The manager sees the published PDF after release. The existing custom-report release control remains available. A non-internal founder is not offered the board request control; the BFF checks authority independently on every action.

## Local verification

- The full retained-provider browser gate passed **11/11 with zero retries**, unexpected, flaky and skipped outcomes all zero. Its three new board journeys cover the sanctioned finalized-assessment chain, request idempotency, draft privacy, founder review, exact Compliance-locked source/PDF version readback and independent SHA-256 checks, wrong-hash release refusal, published read, provider outage refusal, pending-build reconciliation, explicit missing-object retry and replay, current founder-authority revocation, and the manager/founder browser path. The eight earlier evidence journeys also passed after their engagement picker test was made pagination-aware. A preliminary full run exposed that old first-page fixture assumption; the corrected case passed alone and in the final full run. An earlier aborted run had orphan local dev servers and never reached board assertions. The retained synthetic Docker database and provider were not reset or removed.
- The final provider record is `.axiom-runtime/evidence-storage/browser-results.json`: expected 11, unexpected 0, flaky 0, skipped 0, and 14 outcome labels. This is local parity evidence on a dirty worktree, not deployed target acceptance.
- Integrated monorepo tests passed 16/16 tasks, including 1,461 BFF tests and 188 web tests; typecheck and lint passed 16/16 tasks each. Lint retains two pre-existing invite-navigation warnings. Local dependency/security scan found no known vulnerabilities. Build passed 4/4 tasks. The general strict-auth browser regression passed **89/89 with zero retries**. PR and exact-staging gates remain to be recorded.

## Remaining release gate

This increment covers the board workflow only. W8 still requires source-bound statutory reports and Pramaan dossiers, permitted delivery, independently retained approval proof and complete positive/refusal coverage. W9 measured coverage, load and restore, W10 offline installation and remote preprod/production acceptance remain open. No production deployment is claimed.
