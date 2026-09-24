# Onboarding proposal review — 21 September 2026

Reviewed staging `b62f87b`, with all applicable CI checks green ([35626658366](https://github.com/vikashkaruna/Proof/actions/runs/35626658366)). No newer upstream changes. This chunk implements the user's decision that tenant admins, as well as owners, can approve staff-prepared onboarding proposals.

## Result and safeguards

Migration 0035 retains immutable original-intake, estate and normalized-system snapshots. Assigned analysts/founders can prepare; client owners/admins review, with a distinct preparer and reviewer even after a role change. Hash and estate-version checks bind approval to what was reviewed. The intake is one batch and can only be applied once. Review status, new systems/categories, source-index links and ledger writes commit together.

Browser and ordinary service roles cannot update proposal snapshots or fabricate source links. SQL repeats live membership authority. The private intake is read through a service-only projection RPC that returns proposed inventory, omitting DPO contacts; it also works without BYPASSRLS. The UI renders original and normalized fields together and preserves the same mutation key after a lost response.

## Evidence

309 BFF tests; 59 real-login browser journeys; 36 migrations; seven database concurrency suites; three populated upgrades; DSN/deploy fail-closed tests; four local real-Auth topology labels; workspace lint/typecheck/format. Tests cover staff refusal at approval, owner/admin approval, cross-tenant access, changed digest/estate, self-review after promotion, final-ledger failure rollback, concurrent review and replay without duplicate source links or audit entries. The analyst-to-admin browser journey proves no live inventory appears before review.

## Remaining boundaries

This completes proposal review of the initial intake, not the full W3 wizard. Every initial item is mapped as a batch; item exclusion, later batches and unsent draft autosave remain future work. Original region/personal-data declarations remain in the source snapshot; they are not asserted as verified attributes. Existing estate management remains available for direct human declarations.

W4 registry/contracts/lifecycle is next; broker/SVID/grants and live transports remain unimplemented. Complete connector/grant/readiness wizard stages and live permission graph require those runtime boundaries. No cloud deployment or external execution was performed. W0 deployed acceptance, W1 invitations and E.2.3 remain open.

Runbook review also corrected a closure ambiguity: C-W3-1–4 cover this milestone, but do not close the full roadmap's wizard and sustenance. C-W3-5/6 now carry those remaining obligations explicitly. W0's headline no longer incorrectly describes all engineering as closed.
