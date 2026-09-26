# Audit 87 — W8 rights, consent, breach and review/release (Revision 98)

**Date:** 2026-09-27 · **Scope:** PRs #83 + #84 (migrations 0069 + 0071, BFF routes, web surfaces) · **Reviewer:** coordinator

## Scope and assumptions

1. W8 spans FR-12.1–12.3 (DSAR, consent capture/ledger/withdrawal, EN/HI), FR-13.1–13.4 (breach intake, 72-hour DPB workflow, principal notification generation, forensic instrumentation), FR-4.5 (7-year consent retention with legal hold), FR-7.5/7.6 and BR-4 (reviewed release with captured rejection reasons).
2. The `dsars`/`breaches`/`reports` tables existed since migration 0006 with no sanctioned write paths; W8 hardens them rather than replacing them. The three named consent tables were new (0069).
3. "Notify" is recorded dispatch, not transmission: the platform never sends — the human records their own-channel outcome as evidence, and the statutory timestamp is written only by a delivered send.
4. The founder gate is verified against `public.users.is_axiom_internal` because the BFF calls without a user JWT.
5. No deadline push channel was built (the compliance_events rows and the `?overdue=true` filter answer the question; push is drift-alerting scope).
6. Consent purpose-management RPCs are a later slice (fixtures seed `consent_purposes` directly in tests).

## Change

- **0069 (consent):** `consent_purposes` (bounded `purpose_key`, EN/HI notices, DPDPA §6/§7 lawful basis), `consent_records` (per-principal state, notice version pinned at capture, `granted`/`withdrawn`, `legal_hold`), `consent_withdrawals` (append-only artifacts, once-only `downstream_completed_at`); `record_consent`, `withdraw_consent` (atomic conditional update + artifact insert; deferred circular FK is DEFERRABLE INITIALLY DEFERRED with RESTRICT), `set_consent_legal_hold`, `complete_withdrawal_downstream`; no delete path anywhere; four `consent.*` ledger values.
- **0071 (DSAR/breach/release):** `record_dsar` (server-owned clock + compliance_events deadline), `verify_dsar_identity`, `advance_dsar` (closed map; fulfilment needs verified identity, completion needs tenant-owned evidence, rejection needs a reason); `record_breach` (server-owned 72-hour clock + deadline event), `advance_breach` (strictly linear, no skips, closed stays closed), `draft_breach_notification` (one live draft per kind, supersession keeps the chain), `review_breach_notification` (second human, never the drafter — CHECK-enforced), `send_breach_notification` (sender ≠ drafter; 5-attempt cap refuses as a decision; only delivered sends write statutory timestamps); `review_report`/`release_report` (founder authority, `rejected` state with captured reason, server-computed `released_content_hash`). Direct writes revoked from every connecting role.
- **BFF:** 13 routes over the RPCs (ESTATE_MANAGE writes / POSTURE_READ reads, refusals verbatim 409, closed sets validated pre-RPC).
- **Web:** `/breaches` honest rewrite (the fabrication-debt demo is gone); `/reports` review queue with the published hash as its only gold.

## Evidence

- Full `scripts/test-database.sh` green through five real debug cycles — each failure was a real defect (parameter-default rule, supersede-vs-review CHECK semantics, chain-order fixtures, missing SELECT grant, auth.users fixture FK) and each fix is in the final migration.
- `tests/database/w8-breach-dsar-release.test.sql` (~50 assertions) + `consent-foundation.test.sql` (lane) + `w7-regulator-packs.test.sql` (PR #82).
- BFF vitest 1171 → 1186; web 108; types 45; control-library 83 → 91 (BFSI pack); agent-runtime 280. All CI checks green on PRs #83, #84, #85.
- The enums conflict between the two W8 lanes was resolved by merging staging with both blocks kept in migration order — the consent PR re-verified after the merge.

## Not delivered (deliberate)

- Consent BFF routes and the `/consent` page honest rewrite (the page is still a fabricated demo).
- `/dsars` workflow actions (intake/verify/advance UI).
- Deadline notifications (push) for DSAR/breach compliance events.
- The Revision 98 promotion to `main` (staging is 15 commits ahead; open a staging → main PR with a merge commit when the operator asks).
